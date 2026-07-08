#!/usr/bin/env python3
"""User-facing helper for adding an Earth-flyby dataset to the static app.

This script keeps the common workflow short:

  python scripts/add_target.py \
    --target "99942;" \
    --name "99942 Apophis" \
    --approx-ca "2029-04-13 21:46"

It does three things:
  1. Search a sensible window around the approximate closest-approach time.
  2. Call scripts/fetch_horizons.py to write the static ephemeris JSON.
  3. Add display/brightness defaults and update data/datasets.json.

Brightness defaults are app/display metadata, not Horizons ephemeris data.  If
Horizons exposes physical parameters such as RAD/DIAMETER/ALBEDO in OBJ_DATA,
this wrapper will use them as a best-effort default unless explicit values are
provided.  Spacecraft effective reflective area generally cannot be fetched
from Horizons, so provide --area-m2 and --albedo when you have a better guess.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# Make sibling imports work when launched as `python scripts/add_target.py`.
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from fetch_horizons import parse_dt, slugify, update_manifest  # noqa: E402


def rel_to_repo(path: Path, repo_root: Path) -> str:
    try:
        return path.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def parse_physical_defaults(raw_text: str) -> dict[str, float]:
    """Best-effort parser for Horizons OBJ_DATA physical parameters.

    Horizons object-data blocks vary by target type.  For small bodies, they may
    contain fields such as RAD, DIAMETER, ALBEDO, H, and G.  We only parse values
    that map cleanly to the app's simple diffuse-area model.
    """
    defaults: dict[str, float] = {}

    def find_number(patterns: list[str]) -> float | None:
        for pat in patterns:
            m = re.search(pat, raw_text, flags=re.IGNORECASE | re.MULTILINE)
            if m:
                try:
                    return float(m.group(1))
                except ValueError:
                    continue
        return None

    albedo = find_number([
        r'\bALBEDO\s*[=:]\s*([-+0-9.]+(?:[Ee][-+0-9]+)?)',
        r'\bgeometric\s+albedo\b[^0-9+-]*([-+0-9.]+(?:[Ee][-+0-9]+)?)',
    ])
    if albedo is not None and 0 < albedo <= 1.5:
        defaults['albedo'] = albedo

    # Horizons often reports small-body radius in km as RAD.  Diameter may be
    # in km as DIAMETER or Dia.; keep this intentionally conservative.
    radius_km = find_number([
        r'\bRAD\s*[=:]\s*([-+0-9.]+(?:[Ee][-+0-9]+)?)',
        r'\bradius\b[^0-9+-]*([-+0-9.]+(?:[Ee][-+0-9]+)?)\s*km\b',
    ])
    diameter_km = find_number([
        r'\bDIAMETER\s*[=:]\s*([-+0-9.]+(?:[Ee][-+0-9]+)?)',
        r'\bDia\.\s*[=:]\s*([-+0-9.]+(?:[Ee][-+0-9]+)?)',
        r'\bdiameter\b[^0-9+-]*([-+0-9.]+(?:[Ee][-+0-9]+)?)\s*km\b',
    ])

    if radius_km is None and diameter_km is not None:
        radius_km = diameter_km / 2
    if radius_km is not None and radius_km > 0:
        radius_m = radius_km * 1000
        defaults['areaM2'] = math.pi * radius_m * radius_m

    return defaults


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def write_dataset(path: Path, data: dict[str, Any]) -> None:
    # Keep the ephemeris compact; it can be tens of thousands of samples.
    path.write_text(json.dumps(data, separators=(',', ':')))


def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description='Add an Earth-flyby dataset to the static visibility app using sensible defaults.'
    )
    ap.add_argument('--target', required=True, help="Horizons COMMAND, e.g. -159 or '99942;' for Apophis")
    ap.add_argument('--name', required=True, help='Human-readable label, e.g. "Europa Clipper" or "99942 Apophis"')
    ap.add_argument('--approx-ca', required=True, type=parse_dt, help='Approximate closest approach UTC. A broad window around this is searched.')

    ap.add_argument('--search-days', type=float, default=31.0, help='Days to search around --approx-ca. Default: 31.')
    ap.add_argument('--search-step-min', type=float, default=60.0, help='Coarse closest-approach search cadence. Default: 60 min.')
    ap.add_argument('--hours', type=float, default=24.0, help='Hours before/after found closest approach for final dataset. Default: 24.')
    ap.add_argument('--step-sec', type=int, default=30, help='Final ephemeris cadence. Default: 30 s.')

    ap.add_argument('--out', help='Output JSON path. Default: data/<slug>_<approx-year>.json')
    ap.add_argument('--manifest', default='data/datasets.json', help='Dataset manifest to update. Default: data/datasets.json')
    ap.add_argument('--id', help='Dataset id. Default is derived from name and approximate CA year.')
    ap.add_argument('--label', help='Dropdown label. Default is derived from name and actual closest sample date.')
    ap.add_argument('--description', help='Manifest description. Default summarizes Horizons target and closest sample.')

    ap.add_argument('--center', default='500@399', help='Horizons CENTER. Default: Earth geocenter 500@399.')
    ap.add_argument('--center-name', default='Earth geocenter')
    ap.add_argument('--raw-dir', default='data/raw_horizons', help='Where fetch_horizons.py saves raw Horizons text.')
    ap.add_argument('--no-raw', action='store_true', help='Do not save raw Horizons responses. Disables physical-parameter parsing.')

    brightness = ap.add_argument_group('brightness/display defaults')
    brightness.add_argument('--area-m2', type=float, help='Effective reflective/cross-sectional area for the app brightness proxy.')
    brightness.add_argument('--diameter-m', type=float, help='Object diameter; converted to projected area π(D/2)^2 if --area-m2 is omitted.')
    brightness.add_argument('--albedo', type=float, help='Diffuse/geometric reflectance default for the app brightness proxy.')
    brightness.add_argument('--mag-limit', type=float, help='Default limiting magnitude in the app UI.')
    brightness.add_argument('--min-alt-deg', type=float, help='Default minimum altitude constraint in the app UI.')
    brightness.add_argument('--dark-limit-deg', type=float, help='Default Sun-altitude darkness threshold in the app UI.')
    brightness.add_argument('--no-parse-physical', action='store_true', help='Do not try to parse RAD/DIAMETER/ALBEDO from Horizons OBJ_DATA.')

    return ap


def main() -> None:
    args = build_arg_parser().parse_args()

    repo_root = SCRIPT_DIR.parent
    approx_year = args.approx_ca.astimezone(timezone.utc).year
    dataset_id = args.id or slugify(f'{args.name}-{approx_year}-earth-flyby')
    out = Path(args.out or f'data/{dataset_id}.json')
    manifest_path = Path(args.manifest)

    if not out.is_absolute():
        out = repo_root / out
    if not manifest_path.is_absolute():
        manifest_path = repo_root / manifest_path

    search_half = timedelta(days=args.search_days / 2)
    search_start = args.approx_ca - search_half
    search_stop = args.approx_ca + search_half

    fetch_script = SCRIPT_DIR / 'fetch_horizons.py'
    cmd = [
        sys.executable,
        str(fetch_script),
        '--target', args.target,
        '--name', args.name,
        '--center', args.center,
        '--center-name', args.center_name,
        '--search-start', search_start.isoformat().replace('+00:00', 'Z'),
        '--search-stop', search_stop.isoformat().replace('+00:00', 'Z'),
        '--search-step-min', str(args.search_step_min),
        '--hours', str(args.hours),
        '--step-sec', str(args.step_sec),
        '--out', str(out),
        '--raw-dir', str((repo_root / args.raw_dir) if not Path(args.raw_dir).is_absolute() else Path(args.raw_dir)),
    ]
    if args.no_raw:
        cmd.append('--no-raw')

    print('Running low-level Horizons fetch:')
    print('  ' + ' '.join(cmd))
    subprocess.run(cmd, check=True, cwd=repo_root)

    data = load_json(out)
    metadata = data.setdefault('metadata', {})
    query = metadata.get('query', {})
    closest_utc = metadata.get('closestSampleUtc') or query.get('closestApproachCenterUtc')
    target_meta = metadata.get('target', {})

    ui_defaults: dict[str, float] = {}

    # Best-effort physical defaults from Horizons object data.  User-provided
    # values below override these.
    if not args.no_raw and not args.no_parse_physical:
        raw_dir = Path(args.raw_dir)
        if not raw_dir.is_absolute():
            raw_dir = repo_root / raw_dir
        safe_target = slugify(args.target.replace(';', ''))
        raw_file = raw_dir / f'{safe_target}_vectors.txt'
        if raw_file.exists():
            ui_defaults.update(parse_physical_defaults(raw_file.read_text(errors='replace')))

    if args.diameter_m is not None and args.area_m2 is None:
        ui_defaults['areaM2'] = math.pi * (args.diameter_m / 2) ** 2
    if args.area_m2 is not None:
        ui_defaults['areaM2'] = args.area_m2
    if args.albedo is not None:
        ui_defaults['albedo'] = args.albedo
    if args.mag_limit is not None:
        ui_defaults['magLimit'] = args.mag_limit
    if args.min_alt_deg is not None:
        ui_defaults['minAltDeg'] = args.min_alt_deg
    if args.dark_limit_deg is not None:
        ui_defaults['darkLimitDeg'] = args.dark_limit_deg

    if ui_defaults:
        metadata['uiDefaults'] = {k: round(v, 6) for k, v in ui_defaults.items()}
        metadata['brightnessDefaultsSource'] = (
            'User-provided add_target.py options override any best-effort Horizons OBJ_DATA physical parameters. '
            'These defaults are only for the app brightness proxy; they are not ephemeris data.'
        )
    else:
        metadata.pop('uiDefaults', None)
        metadata['brightnessDefaultsSource'] = (
            'No object-specific brightness defaults were provided or parsed. The app will use its generic UI defaults.'
        )

    metadata['addedBy'] = {
        'script': 'scripts/add_target.py',
        'approxClosestApproachUtc': args.approx_ca.isoformat().replace('+00:00', 'Z'),
        'searchDays': args.search_days,
        'searchStepMin': args.search_step_min,
    }
    write_dataset(out, data)

    rel_path = rel_to_repo(out, repo_root)
    label = args.label or f'{args.name} · Earth flyby · {closest_utc[:10] if closest_utc else approx_year}'
    closest_alt = metadata.get('closestSampleAltitudeKm')
    if args.description:
        description = args.description
    elif closest_alt is not None and closest_utc:
        description = f'Horizons target {args.target}, closest sampled altitude {closest_alt:.0f} km at {closest_utc}.'
    else:
        description = f'Horizons target {args.target}, searched around {args.approx_ca.isoformat()}.'

    update_manifest(manifest_path, {
        'id': dataset_id,
        'label': label,
        'path': rel_path,
        'description': description,
    })

    print('\nAdded dataset:')
    print(f'  id:    {dataset_id}')
    print(f'  label: {label}')
    print(f'  path:  {rel_path}')
    print(f'  manifest: {rel_to_repo(manifest_path, repo_root)}')
    if ui_defaults:
        print('  brightness defaults: ' + ', '.join(f'{k}={v:.6g}' for k, v in ui_defaults.items()))
    else:
        print('  brightness defaults: none object-specific; app generic defaults will be used')
    if target_meta:
        print(f'  target: {target_meta.get("name", args.name)} ({target_meta.get("horizonsId", args.target)})')


if __name__ == '__main__':
    main()
