#!/usr/bin/env python3
"""Fetch Europa Clipper Earth-flyby vectors from JPL Horizons and save app data.

This script deliberately pre-saves ephemerides so the web app never calls
Horizons at runtime. It fetches two geocentric vector tables from Horizons:
  * Europa Clipper, COMMAND='-159', CENTER='500@399'
  * Sun, COMMAND='10', CENTER='500@399'

Default window: +/- 24 hours around the public Earth gravity assist epoch
2026-12-03 21:15 UTC, with 60 second samples.

Usage:
  python scripts/fetch_horizons.py
  python scripts/fetch_horizons.py --hours 12 --step-sec 10
  python scripts/fetch_horizons.py --start "2026-Dec-03 15:00" --stop "2026-Dec-04 03:00" --step-sec 15
"""
from __future__ import annotations
import argparse
from datetime import datetime, timedelta, timezone
import json
import re
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen, Request

HORIZONS_URL = 'https://ssd.jpl.nasa.gov/api/horizons.api'
CA_UTC = datetime(2026, 12, 3, 21, 15, tzinfo=timezone.utc)


def parse_dt(s: str) -> datetime:
    # Accept ISO-ish or Horizons-ish strings.
    s = s.strip().replace('Z', '+00:00')
    for fmt in ('%Y-%b-%d %H:%M:%S', '%Y-%b-%d %H:%M', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M'):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    try:
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f'could not parse datetime: {s}') from exc


def horizons_time(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime('%Y-%b-%d %H:%M:%S')


def horizons_step_size(start: datetime, stop: datetime, step_sec: int) -> tuple[str, float]:
    """Return a Horizons STEP_SIZE string and the actual step in seconds.

    Horizons accepts days/hours/minutes as fixed time units, but not seconds.
    For sub-minute output, the documented method is a unitless integer: the
    number of equal intervals into which START_TIME..STOP_TIME is divided.
    This also works well for minute/hour cadences when the requested window is
    exactly divisible by the cadence.
    """
    if step_sec <= 0:
        raise ValueError('--step-sec must be positive')
    total_sec = (stop - start).total_seconds()
    if total_sec <= 0:
        raise ValueError('--stop must be after --start')

    intervals = total_sec / step_sec
    nearest = round(intervals)
    if nearest >= 1 and abs(intervals - nearest) < 1e-9:
        # Unitless STEP_SIZE=N means Horizons returns N equal intervals over
        # the requested span, producing N+1 samples including both endpoints.
        return str(int(nearest)), total_sec / nearest

    # Fallback for windows that are not an exact multiple of the cadence.
    # The Horizons API docs list d/h/m as fixed-time abbreviations.
    if step_sec % 86400 == 0:
        return f'{step_sec // 86400}d', float(step_sec)
    if step_sec % 3600 == 0:
        return f'{step_sec // 3600}h', float(step_sec)
    if step_sec % 60 == 0:
        return f'{step_sec // 60}m', float(step_sec)

    raise ValueError(
        'For sub-minute cadences, Horizons requires unitless interval stepping. '
        'Choose a start/stop window whose duration is an exact multiple of --step-sec.'
    )


def call_horizons(command: str, start: datetime, stop: datetime, step_size: str, obj_data: str = 'YES') -> str:
    params = {
        'format': 'json',
        'COMMAND': f"'{command}'",
        'CENTER': "'500@399'",
        'MAKE_EPHEM': "'YES'",
        'EPHEM_TYPE': "'VECTORS'",
        'START_TIME': f"'{horizons_time(start)}'",
        'STOP_TIME': f"'{horizons_time(stop)}'",
        'STEP_SIZE': f"'{step_size}'",
        'OUT_UNITS': "'KM-S'",
        'REF_PLANE': "'FRAME'",        # ICRF/J2000 equator frame for spacecraft target
        'VEC_CORR': "'NONE'",          # geometric vectors, not apparent/light-time corrected
        'VEC_TABLE': "'2'",            # x,y,z,vx,vy,vz style table
        'TIME_TYPE': "'UT'",            # vector tables can output UT as documented by Horizons
        'TIME_DIGITS': "'SECONDS'",
        'CSV_FORMAT': "'NO'",
        'OBJ_DATA': f"'{obj_data}'",
    }
    url = HORIZONS_URL + '?' + urlencode(params)
    req = Request(url, headers={'User-Agent': 'clipper-flyby-visibility/1.0'})
    with urlopen(req, timeout=120) as r:
        payload = json.loads(r.read().decode('utf-8'))
    if 'error' in payload:
        raise RuntimeError(payload['error'])
    result = payload.get('result', '')
    if '$$SOE' not in result:
        raise RuntimeError('Horizons response did not contain an ephemeris table. Response begins:\n' + result[:1000])
    return result


def parse_vectors(result: str):
    """Return list of {iso, r, v}. Handles standard Horizons vector output."""
    table = result.split('$$SOE', 1)[1].split('$$EOE', 1)[0]
    rows = []
    cur = None
    # Examples:
    # 2461378.385416667 = A.D. 2026-Dec-03 21:15:00.0000 TDB
    # X = ... Y = ... Z = ...
    # VX= ... VY= ... VZ= ...
    date_re = re.compile(r'^\s*([0-9]+\.[0-9]+)\s*=\s*A\.D\.\s+([0-9]{4}-[A-Za-z]{3}-[0-9]{2})\s+([0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?)')
    xyz_re = re.compile(r'X\s*=\s*([-+0-9.Ee]+)\s+Y\s*=\s*([-+0-9.Ee]+)\s+Z\s*=\s*([-+0-9.Ee]+)')
    v_re = re.compile(r'VX\s*=\s*([-+0-9.Ee]+)\s+VY\s*=\s*([-+0-9.Ee]+)\s+VZ\s*=\s*([-+0-9.Ee]+)')
    for line in table.splitlines():
        m = date_re.search(line)
        if m:
            if cur and 'r' in cur:
                rows.append(cur)
            # Horizons vector epochs are usually TDB in the print label. For this visualization
            # at second/minute resolution, we map the requested cadence labels to UTC-like ISO.
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
        raise RuntimeError('Could not parse any Horizons vectors. Table begins:\n' + table[:1000])
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='data/clipper_ega.json', help='output JSON path used by the app')
    ap.add_argument('--hours', type=float, default=24.0, help='hours before/after closest approach if --start/--stop omitted')
    ap.add_argument('--step-sec', type=int, default=60, help='sample spacing in seconds')
    ap.add_argument('--start', type=parse_dt, help='UTC start time')
    ap.add_argument('--stop', type=parse_dt, help='UTC stop time')
    ap.add_argument('--raw-dir', default='data/raw_horizons', help='directory for raw Horizons text responses')
    args = ap.parse_args()

    start = args.start or (CA_UTC - timedelta(hours=args.hours))
    stop = args.stop or (CA_UTC + timedelta(hours=args.hours))
    if stop <= start:
        raise SystemExit('--stop must be after --start')

    step_size, actual_step_sec = horizons_step_size(start, stop, args.step_sec)
    if abs(actual_step_sec - args.step_sec) > 1e-6:
        print(f'Note: Horizons step size {step_size!r} gives actual cadence {actual_step_sec:.6g} s.')
    else:
        print(f'Using Horizons STEP_SIZE={step_size!r} for {args.step_sec:g} s cadence.')

    print('Fetching Europa Clipper vectors from Horizons...')
    clipper_text = call_horizons('-159', start, stop, step_size, obj_data='YES')
    print('Fetching Sun vectors from Horizons...')
    sun_text = call_horizons('10', start, stop, step_size, obj_data='NO')

    raw_dir = Path(args.raw_dir)
    raw_dir.mkdir(parents=True, exist_ok=True)
    (raw_dir / 'clipper_-159_vectors.txt').write_text(clipper_text)
    (raw_dir / 'sun_10_vectors.txt').write_text(sun_text)

    clipper = parse_vectors(clipper_text)
    sun = parse_vectors(sun_text)
    if len(clipper) != len(sun):
        raise RuntimeError(f'sample count mismatch: {len(clipper)} Clipper vs {len(sun)} Sun')
    for i, (a, b) in enumerate(zip(clipper, sun)):
        if a['iso'] != b['iso']:
            raise RuntimeError(f'time mismatch at row {i}: {a["iso"]} vs {b["iso"]}')

    def mag(v): return sum(x*x for x in v) ** 0.5
    dists = [mag(row['r']) for row in clipper]
    imin = min(range(len(dists)), key=dists.__getitem__)

    meta = {
        'schema': 'europa-clipper-earth-flyby-v1',
        'generatedUtc': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'source': 'JPL_HORIZONS_VECTORS',
        'horizonsApi': HORIZONS_URL,
        'target': {'name': 'Europa Clipper', 'horizonsId': '-159'},
        'center': {'name': 'Earth geocenter', 'horizonsCenter': '500@399'},
        'sunTarget': {'name': 'Sun', 'horizonsId': '10'},
        'frame': 'ICRF/J2000 equator, geometric vectors, km, km/s',
        'query': {
            'startUtc': start.isoformat().replace('+00:00', 'Z'),
            'stopUtc': stop.isoformat().replace('+00:00', 'Z'),
            'requestedStepSec': args.step_sec,
            'actualStepSec': actual_step_sec,
            'horizonsStepSize': step_size,
            'clipperCommand': '-159',
            'sunCommand': '10',
            'center': '500@399',
            'vecCorr': 'NONE',
            'timeType': 'UT',
        },
        'closestSampleUtc': clipper[imin]['iso'],
        'closestSampleGeocentricRangeKm': dists[imin],
        'closestSampleAltitudeKm': dists[imin] - 6378.137,
        'notes': [
            'This file is pre-saved for static hosting; the web app performs no network ephemeris calls.',
            'Visibility uses browser-side topocentric geometry, local Sun altitude, and Earth-shadow eclipse tests.',
            'Optical magnitude remains approximate because spacecraft attitude, BRDF, and solar-array glints are not modeled.'
        ],
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    data = {
        'metadata': meta,
        'times': [row['iso'] for row in clipper],
        'clipper_eci_km': [[round(x, 6) for x in row['r']] for row in clipper],
        'sun_eci_km': [[round(x, 3) for x in row['r']] for row in sun],
        'clipper_eci_km_s': [[round(x, 9) for x in row.get('v', [0, 0, 0])] for row in clipper],
    }
    out.write_text(json.dumps(data, separators=(',', ':')))
    print(f'Wrote {out} with {len(clipper)} samples.')
    print(f'Closest sampled geocentric range: {dists[imin]:.1f} km at {clipper[imin]["iso"]}.')
    print(f'Closest sampled altitude: {dists[imin] - 6378.137:.1f} km.')

if __name__ == '__main__':
    main()
