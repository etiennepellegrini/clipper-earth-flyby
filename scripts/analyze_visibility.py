#!/usr/bin/env python3
"""CLI coarse visibility scan for data/clipper_ega.json.

The browser app has the same idea interactively; this script is useful after
fetching real Horizons vectors when you want a quick terminal-ranked list.
"""
from __future__ import annotations
import argparse, json, math
from datetime import datetime, timezone
from pathlib import Path

RE_KM=6378.137; RSUN_KM=695700

def rad(d): return d*math.pi/180

def deg(r): return r*180/math.pi

def norm(v): return math.sqrt(sum(x*x for x in v))
def dot(a,b): return sum(x*y for x,y in zip(a,b))
def sub(a,b): return [x-y for x,y in zip(a,b)]
def mul(a,k): return [x*k for x in a]
def unit(v):
    n=norm(v) or 1
    return [x/n for x in v]
def angle(a,b): return math.acos(max(-1,min(1,dot(unit(a),unit(b)))))
def jd(dt): return dt.timestamp()/86400+2440587.5
def gmst(dt): return rad((280.46061837+360.98564736629*(jd(dt)-2451545.0))%360)
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
    alpha=angle(sub(sun,sc),mul(sc,-1)); ratio=max(1e-30,frac*albedo*(area_m2/1e6)*lambert(alpha)/(math.pi*range_km*range_km))
    return -26.74-2.5*math.log10(ratio)
def parse_time(s): return datetime.fromisoformat(s.replace('Z','+00:00')).astimezone(timezone.utc)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--data',default='data/clipper_ega.json')
    ap.add_argument('--lat-step',type=float,default=5)
    ap.add_argument('--lon-step',type=float,default=5)
    ap.add_argument('--time-step-min',type=float,default=5)
    ap.add_argument('--dark-limit',type=float,default=-6)
    ap.add_argument('--min-alt',type=float,default=10)
    ap.add_argument('--mag-limit',type=float,default=6.5)
    ap.add_argument('--area',type=float,default=140)
    ap.add_argument('--albedo',type=float,default=.22)
    ap.add_argument('-n',type=int,default=12)
    args=ap.parse_args()
    data=json.loads(Path(args.data).read_text())
    dates=[parse_time(t) for t in data['times']]
    sc=data['clipper_eci_km']; sun=data['sun_eci_km']
    if len(dates)>1: native=(dates[1]-dates[0]).total_seconds()/60
    else: native=args.time_step_min
    stride=max(1,round(args.time_step_min/native))
    results=[]
    lat=-70
    while lat<=70+1e-9:
        lon=-180
        while lon<180-1e-9:
            for i in range(0,len(dates),stride):
                alt,az,rg=topo(sc[i],lat,lon,0,dates[i]); sun_alt,_,_=topo(sun[i],lat,lon,0,dates[i]); state,frac=eclipse(sc[i],sun[i]); mag=magnitude(sc[i],sun[i],rg,args.area,args.albedo,frac)
                if alt>=args.min_alt and sun_alt<=args.dark_limit and frac>0:
                    score=alt+8+6-max(0,mag-args.mag_limit)*4-math.log10(max(1,rg))*2
                    if score>0: results.append((score,dates[i],lat,lon,alt,az,sun_alt,state,mag,rg))
            lon+=args.lon_step
        lat+=args.lat_step
    results.sort(reverse=True,key=lambda x:x[0])
    picked=[]
    for r in results:
        if len(picked)>=args.n: break
        if not any(abs(p[2]-r[2])<10 and abs(((p[3]-r[3]+540)%360)-180)<15 and abs((p[1]-r[1]).total_seconds())<1800 for p in picked): picked.append(r)
    print('source:',data.get('metadata',{}).get('source'))
    for k,r in enumerate(picked,1):
        _,t,lat,lon,alt,az,sun_alt,state,mag,rg=r
        print(f'{k:2d}. {t.isoformat().replace("+00:00","Z")}  lat={lat:6.1f} lonE={lon:7.1f}  alt={alt:5.1f} az={az:6.1f}  Sun={sun_alt:5.1f}  {state:8s}  mag~{mag:4.1f} range={rg:,.0f} km')
if __name__=='__main__': main()
