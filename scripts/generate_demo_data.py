#!/usr/bin/env python3
"""Generate an approximate/demo data file for the web app.

This is NOT a replacement for the Horizons fetcher. It exists only so the UI
runs immediately in offline/sandboxed environments where JPL Horizons cannot be
queried. Run scripts/fetch_horizons.py to replace data/clipper_ega.json with
actual Horizons vectors.
"""
from __future__ import annotations
import argparse, json, math
from datetime import datetime, timedelta, timezone
from pathlib import Path

RE_KM = 6378.137
AU_KM = 149_597_870.7

def jd(dt: datetime) -> float:
    # Meeus-style JD from Unix timestamp.
    return dt.timestamp() / 86400.0 + 2440587.5

def gmst_rad(dt: datetime) -> float:
    d = jd(dt) - 2451545.0
    # degrees, adequate for visualization
    deg = 280.46061837 + 360.98564736629 * d
    return math.radians(deg % 360.0)

def sun_eci_approx(dt: datetime):
    # Low precision Sun apparent geocentric position in J2000-ish equatorial frame.
    # Good enough for demo lighting; fetch_horizons.py replaces this with Horizons Sun vectors.
    n = jd(dt) - 2451545.0
    L = math.radians((280.460 + 0.9856474*n) % 360)
    g = math.radians((357.528 + 0.9856003*n) % 360)
    lam = L + math.radians(1.915)*math.sin(g) + math.radians(0.020)*math.sin(2*g)
    eps = math.radians(23.439 - 0.0000004*n)
    r = 1.00014 - 0.01671*math.cos(g) - 0.00014*math.cos(2*g)
    x = r * math.cos(lam)
    y = r * math.cos(eps) * math.sin(lam)
    z = r * math.sin(eps) * math.sin(lam)
    return [x*AU_KM, y*AU_KM, z*AU_KM]

def ecef_to_eci(x, y, z, dt):
    th = gmst_rad(dt)
    c, s = math.cos(th), math.sin(th)
    return [c*x - s*y, s*x + c*y, z]

def subpoint_vec(lat_deg, lon_deg_east, alt_km, dt):
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg_east)
    r = RE_KM + alt_km
    x = r * math.cos(lat) * math.cos(lon)
    y = r * math.cos(lat) * math.sin(lon)
    z = r * math.sin(lat)
    return ecef_to_eci(x, y, z, dt)

def norm(v):
    return math.sqrt(sum(t*t for t in v))

def unit(v):
    n = norm(v)
    return [t/n for t in v]

def cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]

def dot(a, b):
    return sum(x*y for x, y in zip(a, b))

def add(a,b):
    return [x+y for x,y in zip(a,b)]

def mul(a,k):
    return [x*k for x in a]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='data/clipper_ega.json')
    ap.add_argument('--hours', type=float, default=24)
    ap.add_argument('--step-sec', type=int, default=60)
    args = ap.parse_args()

    ca = datetime(2026, 12, 3, 21, 15, tzinfo=timezone.utc)
    start = ca - timedelta(hours=args.hours)
    stop = ca + timedelta(hours=args.hours)

    # Synthetic flyby: 3,200 km altitude at CA, close to the public mission timeline.
    # This is intentionally marked as demo in metadata. It is a plausible, not authoritative,
    # geocentric path with a relative speed close to terrestrial gravity-assist scale.
    r_ca = subpoint_vec(lat_deg=34.0, lon_deg_east=-118.0, alt_km=3200.0, dt=ca)
    rhat = unit(r_ca)
    sunhat = unit(sun_eci_approx(ca))
    # Choose a perpendicular velocity direction with a visible twilight-ish pass.
    vdir = unit(cross(rhat, sunhat))
    if norm(vdir) < 0.1:
        vdir = unit(cross(rhat, [0,0,1]))
    v_inf = 14.2  # km/s, illustrative geocentric relative speed
    # Add a mild curvature term toward Earth to avoid a completely straight-looking line.
    # Not physically integrated; only a demo until Horizons data is fetched.
    times, sc, sun = [], [], []
    total = int((stop - start).total_seconds())
    for i in range(0, total + 1, args.step_sec):
        t = start + timedelta(seconds=i)
        tau = (t - ca).total_seconds()
        # straight-line dominant component plus tiny transverse bend near CA
        bend = 0.000003 * tau*tau / (1 + abs(tau)/18000)
        pos = add(add(r_ca, mul(vdir, v_inf*tau)), mul(rhat, bend))
        times.append(t.isoformat().replace('+00:00','Z'))
        sc.append([round(x, 6) for x in pos])
        sun.append([round(x, 3) for x in sun_eci_approx(t)])

    meta = {
        'schema': 'europa-clipper-earth-flyby-v1',
        'generatedUtc': datetime.now(timezone.utc).isoformat().replace('+00:00','Z'),
        'source': 'DEMO_SYNTHETIC_APPROXIMATION_NOT_HORIZONS',
        'sourceWarning': 'This bundled file is only a UI/demo ephemeris because the build sandbox could not reach Horizons. Run scripts/fetch_horizons.py to overwrite it with actual JPL Horizons vectors.',
        'target': {'name': 'Europa Clipper', 'horizonsId': '-159'},
        'center': {'name': 'Earth geocenter', 'horizonsCenter': '500@399'},
        'sunSource': 'Low-precision analytic Sun for demo only; Horizons fetcher stores Sun vectors too.',
        'timeScale': 'UTC ISO strings; Horizons fetcher uses requested UTC epochs with VEC_CORR=NONE.',
        'closestApproachApproxUtc': ca.isoformat().replace('+00:00','Z'),
        'closestApproachAltitudeKmUsedInDemo': 3200,
        'notes': [
            'Replace this file with real Horizons data before drawing conclusions about where Europa Clipper will actually be visible.',
            'The app computes topocentric alt/az, ground darkness, spacecraft Earth-shadow eclipse state, and an adjustable rough optical magnitude in the browser.'
        ]
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({'metadata': meta, 'times': times, 'clipper_eci_km': sc, 'sun_eci_km': sun}, separators=(',', ':')))
    print(f'wrote {out} with {len(times)} samples')

if __name__ == '__main__':
    main()
