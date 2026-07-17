#!/usr/bin/env python3
"""CLI refined best-spot visibility scan for an Earth-flyby dataset.

The browser app runs the same idea interactively: first scan a coarse global
lat/lon/time grid, then refine around the best rough-magnitude candidate.
"""
from __future__ import annotations
import argparse, json, math
from datetime import datetime, timezone
from pathlib import Path

RE_KM = 6378.137
RSUN_KM = 695700

COARSE_LAT_STEP = 5  # degrees
COARSE_LON_STEP = 5  # degrees
COARSE_TIME_STEP = 5  # minutes

def rad(d): return d * math.pi / 180

def deg(r): return r * 180 / math.pi

def norm(v): return math.sqrt(sum(x*x for x in v))
def dot(a,b): return sum(x*y for x,y in zip(a,b))
def sub(a,b): return [x-y for x,y in zip(a,b)]
def mul(a,k): return [x*k for x in a]
def unit(v):
    n = norm(v) or 1
    return [x/n for x in v]
def angle(a,b): return math.acos(max(-1, min(1, dot(unit(a), unit(b)))))
def jd(dt): return dt.timestamp()/86400 + 2440587.5
def gmst(dt): return rad((280.46061837 + 360.98564736629*(jd(dt)-2451545.0)) % 360)
def eci_to_ecef(v,dt):
    th=gmst(dt); c=math.cos(th); s=math.sin(th)
    return [c*v[0]+s*v[1], -s*v[0]+c*v[1], v[2]]
def ecef_to_eci(v,dt):
    th=gmst(dt); c=math.cos(th); s=math.sin(th)
    return [c*v[0]-s*v[1], s*v[0]+c*v[1], v[2]]
def geodetic_to_ecef(lat,lon,hkm):
    a=RE_KM; f=1/298.257223563; e2=f*(2-f); p=rad(lat); l=rad(lon)
    sp=math.sin(p); cp=math.cos(p); N=a/math.sqrt(1-e2*sp*sp)
    return [(N+hkm)*cp*math.cos(l),(N+hkm)*cp*math.sin(l),(N*(1-e2)+hkm)*sp]
def observer_eci(lat,lon,h_m,dt): return ecef_to_eci(geodetic_to_ecef(lat,lon,h_m/1000),dt)
def topo(target, lat, lon, h_m, dt):
    obs=observer_eci(lat,lon,h_m,dt); rho=eci_to_ecef(sub(target,obs),dt)
    p=rad(lat); l=rad(lon)
    east=-math.sin(l)*rho[0]+math.cos(l)*rho[1]
    north=-math.sin(p)*math.cos(l)*rho[0]-math.sin(p)*math.sin(l)*rho[1]+math.cos(p)*rho[2]
    up=math.cos(p)*math.cos(l)*rho[0]+math.cos(p)*math.sin(l)*rho[1]+math.sin(p)*rho[2]
    rg=math.sqrt(east*east+north*north+up*up)
    return deg(math.asin(max(-1,min(1,up/rg)))), (deg(math.atan2(east,north))+360)%360, rg
def eclipse(sc,sun):
    toEarth=mul(sc,-1); toSun=sub(sun,sc); de=norm(toEarth); ds=norm(toSun)
    sep=angle(toEarth,toSun); ea=math.asin(min(1,RE_KM/de)); sa=math.asin(min(1,RSUN_KM/ds))
    if sep < max(0,ea-sa): return 'umbra',0
    if sep < ea+sa: return 'penumbra', max(0,min(1,(sep-max(0,ea-sa))/(2*sa)))
    return 'sunlit',1
def lambert(a): return max(0,(math.sin(a)+(math.pi-a)*math.cos(a))/math.pi)
def magnitude(sc,sun,range_km,area_m2,albedo,frac):
    alpha=angle(sub(sun,sc),mul(sc,-1))
    ratio=max(1e-30,frac*albedo*(area_m2/1e6)*lambert(alpha)/(math.pi*range_km*range_km))
    return -26.74-2.5*math.log10(ratio)
def parse_time(s): return datetime.fromisoformat(s.replace('Z','+00:00')).astimezone(timezone.utc)
def normalize_lon(lon): return ((lon + 540) % 360) - 180


def make_record(i, lat, lon, dates, sc, sun, args):
    i=max(0, min(len(dates)-1, int(round(i))))
    lat=max(-89.5, min(89.5, lat))
    lon=normalize_lon(lon)
    alt,az,rg=topo(sc[i],lat,lon,0,dates[i])
    sun_alt,_,_=topo(sun[i],lat,lon,0,dates[i])
    state,frac=eclipse(sc[i],sun[i])
    if alt < args.min_alt or sun_alt > args.dark_limit or frac <= 0:
        return None
    mag=magnitude(sc[i],sun[i],rg,args.area,args.albedo,frac)
    return dict(i=i, t=dates[i], lat=lat, lon=lon, alt=alt, az=az, sun_alt=sun_alt, state=state, mag=mag, rg=rg, visible=mag <= args.mag_limit)


def better(a, b):
    if a is None: return False
    if b is None: return True
    # Lower astronomical magnitude is brighter.  Altitude, darkness, and sunlit
    # state are hard filters; these only break near-ties.
    if abs(a['mag'] - b['mag']) > 0.02: return a['mag'] < b['mag']
    if abs(a['alt'] - b['alt']) > 0.5: return a['alt'] > b['alt']
    if abs(a['sun_alt'] - b['sun_alt']) > 0.5: return a['sun_alt'] < b['sun_alt']
    return a['rg'] < b['rg']


def scan_window(best, dates, sc, sun, args, *, i0, i1, i_step, lat0, lat1, lat_step, lon0, lon1, lon_step):
    i0=max(0, int(round(i0))); i1=min(len(dates)-1, int(round(i1))); i_step=max(1, int(round(i_step)))
    i=i0
    while i <= i1:
        lat=lat0
        while lat <= lat1 + 1e-9:
            lon=lon0
            while lon <= lon1 + 1e-9:
                rec=make_record(i, lat, lon, dates, sc, sun, args)
                if better(rec, best): best=rec
                lon += lon_step
            lat += lat_step
        i += i_step
    return best


def refine(best, dates, sc, sun, args, sample_sec, coarse_stride):
    if best is None: return None
    one_min=max(1, round(60/sample_sec))
    passes=[
        dict(lat_span=6, lon_span=6, lat_step=1, lon_step=1, idx_span=coarse_stride, idx_step=one_min),
        dict(lat_span=1.2, lon_span=1.2, lat_step=.2, lon_step=.2, idx_span=5*one_min, idx_step=1),
        dict(lat_span=.3, lon_span=.3, lat_step=.05, lon_step=.05, idx_span=one_min, idx_step=1),
    ]
    for p in passes:
        best=scan_window(best, dates, sc, sun, args,
            i0=best['i']-p['idx_span'], i1=best['i']+p['idx_span'], i_step=p['idx_step'],
            lat0=best['lat']-p['lat_span'], lat1=best['lat']+p['lat_span'], lat_step=p['lat_step'],
            lon0=best['lon']-p['lon_span'], lon1=best['lon']+p['lon_span'], lon_step=p['lon_step'])
    return best


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--data',default='data/clipper_ega.json')
    ap.add_argument('--dark-limit',type=float,default=-6)
    ap.add_argument('--min-alt',type=float,default=10)
    ap.add_argument('--mag-limit',type=float,default=6.5)
    ap.add_argument('--area',type=float,default=140)
    ap.add_argument('--albedo',type=float,default=.22)
    args=ap.parse_args()
    data=json.loads(Path(args.data).read_text())
    dates=[parse_time(t) for t in data['times']]
    sc=data.get('object_eci_km') or data.get('target_eci_km') or data['clipper_eci_km']; sun=data['sun_eci_km']
    sample_sec=(dates[1]-dates[0]).total_seconds() if len(dates)>1 else 60
    coarse_stride=max(1, round(COARSE_TIME_STEP*60/sample_sec))
    best=scan_window(None, dates, sc, sun, args,
        i0=0, i1=len(dates)-1, i_step=coarse_stride,
        lat0=-85, lat1=85, lat_step=COARSE_LAT_STEP,
        lon0=-180, lon1=175, lon_step=COARSE_LON_STEP)
    best=refine(best, dates, sc, sun, args, sample_sec, coarse_stride)
    print('source:', data.get('metadata',{}).get('source'))
    if best is None:
        print('No candidate met the altitude, darkness, and target-illumination constraints.')
        return
    visibility='brighter than' if best['visible'] else 'fainter than'
    print(f"Best refined candidate ({visibility} limiting mag {args.mag_limit:.1f}):")
    print(f"  time: {best['t'].isoformat().replace('+00:00','Z')}")
    print(f"  lat/lon: {best['lat']:.2f}, {best['lon']:.2f}°E")
    print(f"  alt/az: {best['alt']:.1f}°, {best['az']:.1f}°")
    print(f"  Sun alt: {best['sun_alt']:.1f}°; target: {best['state']}")
    print(f"  rough mag: {best['mag']:.2f}; range: {best['rg']:,.0f} km")

if __name__=='__main__': main()
