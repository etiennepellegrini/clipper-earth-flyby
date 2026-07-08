#!/usr/bin/env python3
"""Fetch Earth-centered vectors from JPL Horizons for a flyby visibility dataset.

The web app is static, so it never calls Horizons at runtime.  This script is
how you pre-save one or more datasets under data/*.json and list them in
 data/datasets.json.

Examples
--------
Most users should use scripts/add_target.py, which wraps this low-level fetcher,
updates the dataset manifest, and stores app brightness defaults.

Fetch Europa Clipper around a known Earth gravity assist epoch:

  python scripts/fetch_horizons.py \
    --target -159 --name "Europa Clipper" --ca-utc "2026-12-03 21:15" \
    --hours 12 --step-sec 10 --out data/clipper_ega.json

For a generic target, provide either --ca-utc or a bounded closest-approach
search window.  The script searches that window first, then fetches the final
high-cadence dataset around the closest sample.

  python scripts/fetch_horizons.py \
    --target "99942;" --name "99942 Apophis" \
    --search-start "2029-03-29" --search-stop "2029-04-29" \
    --hours 24 --step-sec 30 --out data/apophis_2029.json
"""

from __future__ import annotations

import argparse
import json
import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

HORIZONS_URL = 'https://ssd.jpl.nasa.gov/api/horizons.api'
EARTH_RADIUS_KM = 6378.137
DEFAULT_CLIPPER_CA_UTC = datetime(2026, 12, 3, 21, 15, tzinfo=timezone.utc)


def parse_dt(s: str) -> datetime:
    s = s.strip().replace('Z', '+00:00')
    for fmt in (
        '%Y-%b-%d %H:%M:%S', '%Y-%b-%d %H:%M',
        '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d',
    ):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    try:
        dt = datetime.fromisoformat(s)
        return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f'could not parse datetime: {s!r}') from exc


def horizons_time(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime('%Y-%b-%d %H:%M:%S')


def horizons_step_size(start: datetime, stop: datetime, step_sec: int) -> tuple[str, float]:
    """Return Horizons STEP_SIZE and actual cadence in seconds.

    Horizons does not accept seconds as a fixed-time unit.  When the requested
    interval divides the window exactly, use Horizons' unitless number of equal
    intervals, which gives N+1 rows including both endpoints.
    """
    if step_sec <= 0:
        raise ValueError('step seconds must be positive')
    total_sec = (stop - start).total_seconds()
    if total_sec <= 0:
        raise ValueError('stop must be after start')
    intervals = total_sec / step_sec
    nearest = round(intervals)
    if nearest >= 1 and abs(intervals - nearest) < 1e-9:
        return str(int(nearest)), total_sec / nearest
    if step_sec % 86400 == 0:
        return f'{step_sec // 86400}d', float(step_sec)
    if step_sec % 3600 == 0:
        return f'{step_sec // 3600}h', float(step_sec)
    if step_sec % 60 == 0:
        return f'{step_sec // 60}m', float(step_sec)
    raise ValueError('Sub-minute cadence needs a start/stop span exactly divisible by --step-sec.')


def call_horizons(command: str, start: datetime, stop: datetime, step_size: str, *,
                  center: str = '500@399', obj_data: str = 'YES', ref_plane: str = 'FRAME') -> str:
    params = {
        'format': 'json',
        'COMMAND': f"'{command}'",
        'CENTER': f"'{center}'",
        'MAKE_EPHEM': "'YES'",
        'EPHEM_TYPE': "'VECTORS'",
        'START_TIME': f"'{horizons_time(start)}'",
        'STOP_TIME': f"'{horizons_time(stop)}'",
        'STEP_SIZE': f"'{step_size}'",
        'OUT_UNITS': "'KM-S'",
        'REF_PLANE': f"'{ref_plane}'",
        'VEC_CORR': "'NONE'",
        'VEC_TABLE': "'2'",
        'TIME_TYPE': "'UT'",
        'TIME_DIGITS': "'SECONDS'",
        'CSV_FORMAT': "'NO'",
        'OBJ_DATA': f"'{obj_data}'",
    }
    url = HORIZONS_URL + '?' + urlencode(params)
    req = Request(url, headers={'User-Agent': 'earth-flyby-visibility/2.0'})
    with urlopen(req, timeout=180) as r:
        payload = json.loads(r.read().decode('utf-8'))
    if 'error' in payload:
        raise RuntimeError(payload['error'])
    result = payload.get('result', '')
    if '$$SOE' not in result:
        raise RuntimeError('Horizons response did not contain an ephemeris table. Response begins:\n' + result[:1200])
    return result


def parse_vectors(result: str) -> list[dict]:
    table = result.split('$$SOE', 1)[1].split('$$EOE', 1)[0]
    rows: list[dict] = []
    cur: dict | None = None
    date_re = re.compile(r'^\s*([0-9]+\.[0-9]+)\s*=\s*A\.D\.\s+([0-9]{4}-[A-Za-z]{3}-[0-9]{2})\s+([0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?)')
    xyz_re = re.compile(r'X\s*=\s*([-+0-9.Ee]+)\s+Y\s*=\s*([-+0-9.Ee]+)\s+Z\s*=\s*([-+0-9.Ee]+)')
    v_re = re.compile(r'VX\s*=\s*([-+0-9.Ee]+)\s+VY\s*=\s*([-+0-9.Ee]+)\s+VZ\s*=\s*([-+0-9.Ee]+)')
    for line in table.splitlines():
        m = date_re.search(line)
        if m:
            if cur and 'r' in cur:
                rows.append(cur)
            dt = datetime.strptime(m.group(2) + ' ' + m.group(3).split('.')[0], '%Y-%b-%d %H:%M:%S').replace(tzinfo=timezone.utc)
            cur = {'iso': dt.isoformat().replace('+00:00', 'Z')}
            continue
        if cur is None:
            continue
        m = xyz_re.search(line)
        if m:
            cur['r'] = [float(m.group(i)) for i in range(1, 4)]
            continue
        m = v_re.search(line)
        if m:
            cur['v'] = [float(m.group(i)) for i in range(1, 4)]
            continue
    if cur and 'r' in cur:
        rows.append(cur)
    if not rows:
        raise RuntimeError('Could not parse any Horizons vectors. Table begins:\n' + table[:1200])
    return rows


def extract_target_name(result: str, fallback: str) -> str:
    m = re.search(r'Target body name:\s*([^\n{]+)', result)
    if m:
        return re.sub(r'\s+', ' ', m.group(1)).strip()
    return fallback


def vec_norm(v: list[float]) -> float:
    return math.sqrt(sum(x * x for x in v))


def closest_row(rows: list[dict]) -> tuple[int, float]:
    dists = [vec_norm(row['r']) for row in rows]
    i = min(range(len(dists)), key=dists.__getitem__)
    return i, dists[i]


def slugify(text: str) -> str:
    text = re.sub(r'[^A-Za-z0-9]+', '-', text.strip().lower()).strip('-')
    return text or 'flyby-dataset'


def load_manifest(path: Path) -> dict:
    if path.exists():
        try:
            data = json.loads(path.read_text())
            if isinstance(data, list):
                return {'datasets': data}
            if isinstance(data, dict) and isinstance(data.get('datasets'), list):
                return data
        except json.JSONDecodeError:
            pass
    return {'datasets': []}


def update_manifest(path: Path, entry: dict) -> None:
    manifest = load_manifest(path)
    datasets = manifest.setdefault('datasets', [])
    datasets[:] = [d for d in datasets if d.get('id') != entry['id'] and d.get('path') != entry['path']]
    datasets.append(entry)
    datasets.sort(key=lambda d: d.get('label', d.get('id', '')))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2) + '\n')


def build_arg_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description='Create a static Earth-flyby visibility dataset from JPL Horizons vectors.')
    ap.add_argument('--target', default='-159', help="Horizons COMMAND for target, e.g. -159 or '99942;' for Apophis")
    ap.add_argument('--name', help='Human-readable target name. If omitted, the script tries to parse Horizons output.')
    ap.add_argument('--center', default='500@399', help='Horizons CENTER. Default is Earth geocenter 500@399.')
    ap.add_argument('--center-name', default='Earth geocenter')
    ap.add_argument('--ca-utc', type=parse_dt, help='Known/approximate closest-approach UTC. Skips broad search.')
    ap.add_argument('--search-start', type=parse_dt, help='UTC start for broad closest-approach search')
    ap.add_argument('--search-stop', type=parse_dt, help='UTC stop for broad closest-approach search')
    ap.add_argument('--search-step-min', type=float, default=30.0, help='Broad-search cadence in minutes')
    ap.add_argument('--hours', type=float, default=24.0, help='hours before/after closest approach for final dataset')
    ap.add_argument('--step-sec', type=int, default=60, help='final sample spacing in seconds')
    ap.add_argument('--out', help='output JSON path. Default: data/<slug>.json')
    ap.add_argument('--raw-dir', default='data/raw_horizons', help='directory for raw Horizons text responses')
    ap.add_argument('--no-raw', action='store_true', help='do not save raw Horizons text responses')
    return ap


def main() -> None:
    args = build_arg_parser().parse_args()

    target_for_slug = args.name or args.target.replace(';', '')
    dataset_id = slugify(target_for_slug + '-earth-flyby')
    out = Path(args.out or f'data/{dataset_id}.json')

    ca = args.ca_utc
    coarse_rows = None
    coarse_text = None
    target_name = args.name or args.target

    if ca is None:
        if args.search_start is None or args.search_stop is None:
            if args.target == '-159':
                ca = DEFAULT_CLIPPER_CA_UTC
                print(f'No search window supplied; using built-in Europa Clipper approximate CA {ca.isoformat()}.')
            else:
                raise SystemExit('For mission-agnostic targets, provide either --ca-utc or --search-start/--search-stop so the script can find closest approach.')
        else:
            if args.search_stop <= args.search_start:
                raise SystemExit('--search-stop must be after --search-start')
            search_step_sec = max(1, int(round(args.search_step_min * 60)))
            search_step, actual_search_step = horizons_step_size(args.search_start, args.search_stop, search_step_sec)
            print(f'Searching closest approach for target {args.target!r} from {horizons_time(args.search_start)} to {horizons_time(args.search_stop)} with STEP_SIZE={search_step!r} (~{actual_search_step:.1f} s)...')
            coarse_text = call_horizons(args.target, args.search_start, args.search_stop, search_step, center=args.center, obj_data='YES')
            coarse_rows = parse_vectors(coarse_text)
            target_name = args.name or extract_target_name(coarse_text, args.target)
            imin, rmin = closest_row(coarse_rows)
            ca = parse_dt(coarse_rows[imin]['iso'])
            print(f'Coarse closest sample: {coarse_rows[imin]["iso"]}, geocentric range {rmin:.1f} km, altitude {rmin - EARTH_RADIUS_KM:.1f} km.')

    start = ca - timedelta(hours=args.hours)
    stop = ca + timedelta(hours=args.hours)
    step_size, actual_step_sec = horizons_step_size(start, stop, args.step_sec)
    print(f'Fetching final target vectors with STEP_SIZE={step_size!r} around {ca.isoformat()}...')
    target_text = call_horizons(args.target, start, stop, step_size, center=args.center, obj_data='YES')
    target_name = args.name or extract_target_name(target_text, target_name)
    print('Fetching matching Sun vectors...')
    sun_text = call_horizons('10', start, stop, step_size, center=args.center, obj_data='NO')

    if not args.no_raw:
        raw_dir = Path(args.raw_dir)
        raw_dir.mkdir(parents=True, exist_ok=True)
        safe_target = slugify(args.target.replace(';', ''))
        if coarse_text:
            (raw_dir / f'{safe_target}_coarse_vectors.txt').write_text(coarse_text)
        (raw_dir / f'{safe_target}_vectors.txt').write_text(target_text)
        (raw_dir / 'sun_10_vectors.txt').write_text(sun_text)

    target_rows = parse_vectors(target_text)
    sun_rows = parse_vectors(sun_text)
    if len(target_rows) != len(sun_rows):
        raise RuntimeError(f'sample count mismatch: {len(target_rows)} target vs {len(sun_rows)} Sun')
    for i, (a, b) in enumerate(zip(target_rows, sun_rows)):
        if a['iso'] != b['iso']:
            raise RuntimeError(f'time mismatch at row {i}: {a["iso"]} vs {b["iso"]}')

    imin, rmin = closest_row(target_rows)

    meta = {
        'schema': 'earth-flyby-visibility-v2',
        'generatedUtc': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'source': 'JPL_HORIZONS_VECTORS',
        'horizonsApi': HORIZONS_URL,
        'target': {'name': target_name, 'horizonsId': args.target, 'command': args.target},
        'center': {'name': args.center_name, 'horizonsCenter': args.center, 'command': args.center},
        'sunTarget': {'name': 'Sun', 'horizonsId': '10', 'command': '10'},
        'frame': 'ICRF/J2000 equator, geometric vectors, km, km/s',
        'query': {
            'searchStartUtc': args.search_start.isoformat().replace('+00:00', 'Z') if args.search_start else None,
            'searchStopUtc': args.search_stop.isoformat().replace('+00:00', 'Z') if args.search_stop else None,
            'closestApproachCenterUtc': ca.isoformat().replace('+00:00', 'Z'),
            'startUtc': start.isoformat().replace('+00:00', 'Z'),
            'stopUtc': stop.isoformat().replace('+00:00', 'Z'),
            'requestedStepSec': args.step_sec,
            'actualStepSec': actual_step_sec,
            'horizonsStepSize': step_size,
            'targetCommand': args.target,
            'sunCommand': '10',
            'center': args.center,
            'vecCorr': 'NONE',
            'timeType': 'UT',
        },
        'closestSampleUtc': target_rows[imin]['iso'],
        'closestSampleGeocentricRangeKm': rmin,
        'closestSampleAltitudeKm': rmin - EARTH_RADIUS_KM,
        'notes': [
            'This file is pre-saved for static hosting; the web app performs no network ephemeris calls.',
            'Visibility uses browser-side topocentric geometry, local Sun altitude, and Earth-shadow eclipse tests.',
            'Optical magnitude remains approximate because spacecraft attitude, asteroid phase law, BRDF, and glints are not modeled.'
        ],
    }
    data = {
        'metadata': meta,
        'times': [row['iso'] for row in target_rows],
        'object_eci_km': [[round(x, 6) for x in row['r']] for row in target_rows],
        'target_eci_km': [[round(x, 6) for x in row['r']] for row in target_rows],
        'sun_eci_km': [[round(x, 3) for x in row['r']] for row in sun_rows],
        'object_eci_km_s': [[round(x, 9) for x in row.get('v', [0, 0, 0])] for row in target_rows],
    }
    if args.target == '-159':
        data['clipper_eci_km'] = data['object_eci_km']
        data['clipper_eci_km_s'] = data['object_eci_km_s']

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, separators=(',', ':')))
    print(f'Wrote {out} with {len(target_rows)} samples.')
    print(f'Closest sampled geocentric range: {rmin:.1f} km at {target_rows[imin]["iso"]}.')
    print(f'Closest sampled altitude: {rmin - EARTH_RADIUS_KM:.1f} km.')



if __name__ == '__main__':
    main()
