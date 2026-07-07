'use strict';

const RE_KM = 6378.137;
const RSUN_KM = 695700;
const AU_KM = 149597870.7;
const PLACES = {
  santaMonica: { lat: 34.0195, lon: -118.4912, height: 30, label: 'Santa Monica, CA' },
  strasbourg: { lat: 48.5734, lon: 7.7521, height: 142, label: 'Strasbourg, France' },
};

const els = {
  dataStatus: document.getElementById('dataStatus'),
  lat: document.getElementById('lat'), lon: document.getElementById('lon'), height: document.getElementById('height'),
  darkLimit: document.getElementById('darkLimit'), timeSlider: document.getElementById('timeSlider'), timeReadout: document.getElementById('timeReadout'),
  stepBack: document.getElementById('stepBack'), stepForward: document.getElementById('stepForward'), playPause: document.getElementById('playPause'), jumpClosest: document.getElementById('jumpClosest'),
  speed: document.getElementById('speed'), speedLabel: document.getElementById('speedLabel'),
  area: document.getElementById('area'), albedo: document.getElementById('albedo'), magLimit: document.getElementById('magLimit'), minAlt: document.getElementById('minAlt'),
  sky: document.getElementById('skyCanvas'), geo: document.getElementById('geoCanvas'), readout: document.getElementById('readout'), visibilityBadge: document.getElementById('visibilityBadge'),
  geoScale: document.getElementById('geoScale'), geoPresetEyes: document.getElementById('geoPresetEyes'), geoPresetSun: document.getElementById('geoPresetSun'), geoPresetNorth: document.getElementById('geoPresetNorth'),
  provenance: document.getElementById('provenance'), scanBest: document.getElementById('scanBest'), applyBest: document.getElementById('applyBest'), bestResults: document.getElementById('bestResults'), useGps: document.getElementById('useGps'),
};

let eph = null;
let idx = 0;
let playTimer = null;
let bestCache = [];
let geoRot = { yaw: -0.9, pitch: 0.45 };
let dragging = false, lastDrag = null;

const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' });

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function rad(d) { return d * Math.PI / 180; }
function deg(r) { return r * 180 / Math.PI; }
function norm(v) { return Math.hypot(v[0], v[1], v[2]); }
function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function add(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function mul(a, k) { return [a[0]*k, a[1]*k, a[2]*k]; }
function unit(v) { const n = norm(v) || 1; return [v[0]/n, v[1]/n, v[2]/n]; }
function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function angle(a, b) { return Math.acos(clamp(dot(unit(a), unit(b)), -1, 1)); }

function jdFromDate(date) { return date.getTime() / 86400000 + 2440587.5; }
function gmst(date) {
  const d = jdFromDate(date) - 2451545.0;
  return rad(((280.46061837 + 360.98564736629 * d) % 360 + 360) % 360);
}
function eciToEcef(v, date) {
  const th = gmst(date), c = Math.cos(th), s = Math.sin(th);
  return [c*v[0] + s*v[1], -s*v[0] + c*v[1], v[2]];
}
function ecefToEci(v, date) {
  const th = gmst(date), c = Math.cos(th), s = Math.sin(th);
  return [c*v[0] - s*v[1], s*v[0] + c*v[1], v[2]];
}
function geodeticToEcef(latDeg, lonDeg, hKm) {
  const a = RE_KM, f = 1 / 298.257223563, e2 = f * (2 - f);
  const lat = rad(latDeg), lon = rad(lonDeg);
  const sinp = Math.sin(lat), cosp = Math.cos(lat);
  const N = a / Math.sqrt(1 - e2 * sinp * sinp);
  return [(N + hKm) * cosp * Math.cos(lon), (N + hKm) * cosp * Math.sin(lon), (N * (1 - e2) + hKm) * sinp];
}
function observerEci(lat, lon, heightM, date) { return ecefToEci(geodeticToEcef(lat, lon, heightM / 1000), date); }
function topocentric(targetEci, lat, lon, heightM, date) {
  const obs = observerEci(lat, lon, heightM, date);
  const rhoEci = sub(targetEci, obs);
  const rho = eciToEcef(rhoEci, date);
  const latR = rad(lat), lonR = rad(lon);
  const east = -Math.sin(lonR)*rho[0] + Math.cos(lonR)*rho[1];
  const north = -Math.sin(latR)*Math.cos(lonR)*rho[0] - Math.sin(latR)*Math.sin(lonR)*rho[1] + Math.cos(latR)*rho[2];
  const up = Math.cos(latR)*Math.cos(lonR)*rho[0] + Math.cos(latR)*Math.sin(lonR)*rho[1] + Math.sin(latR)*rho[2];
  const range = Math.hypot(east, north, up);
  const alt = deg(Math.asin(clamp(up / range, -1, 1)));
  const az = (deg(Math.atan2(east, north)) + 360) % 360;
  return { alt, az, rangeKm: range, enu: [east, north, up], rhoEci, rhoKm: range };
}

function equatorialRaDec(v) {
  const r = norm(v) || 1;
  const ra = (deg(Math.atan2(v[1], v[0])) + 360) % 360;
  const dec = deg(Math.asin(clamp(v[2] / r, -1, 1)));
  return { ra, dec };
}
function equatorialToEcliptic(v) {
  // Mean obliquity of J2000, enough for this visualization scale.
  const eps = rad(23.439291111);
  const ce = Math.cos(eps), se = Math.sin(eps);
  return [v[0], ce * v[1] + se * v[2], -se * v[1] + ce * v[2]];
}
function eclipticLonLat(v) {
  const e = equatorialToEcliptic(v);
  const r = norm(e) || 1;
  return { lon: (deg(Math.atan2(e[1], e[0])) + 360) % 360, lat: deg(Math.asin(clamp(e[2] / r, -1, 1))) };
}

function eclipseState(sc, sun) {
  // From spacecraft, does Earth block the Sun?
  const toEarth = mul(sc, -1);
  const toSun = sub(sun, sc);
  const dEarth = norm(toEarth), dSun = norm(toSun);
  if (dEarth <= RE_KM) return { state: 'inside Earth', sunlit: false, fraction: 0 };
  const sep = angle(toEarth, toSun);
  const earthAng = Math.asin(clamp(RE_KM / dEarth, -1, 1));
  const sunAng = Math.asin(clamp(RSUN_KM / dSun, -1, 1));
  if (sep < Math.max(0, earthAng - sunAng)) return { state: 'umbra', sunlit: false, fraction: 0 };
  if (sep < earthAng + sunAng) {
    const f = clamp((sep - Math.max(0, earthAng - sunAng)) / (2 * sunAng), 0, 1);
    return { state: 'penumbra', sunlit: true, fraction: f };
  }
  return { state: 'sunlit', sunlit: true, fraction: 1 };
}
function phaseAngle(sc, sun) {
  // Sun-spacecraft-observer angle; observer approximated at Earth center for brightness.
  const toSun = sub(sun, sc);
  const toObs = mul(sc, -1);
  return angle(toSun, toObs);
}
function lambertPhase(alpha) {
  return Math.max(0, (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI);
}
function roughMagnitude(sc, sun, rangeKm, areaM2, albedo, eclipseFraction = 1) {
  const alpha = phaseAngle(sc, sun);
  const phase = Math.max(1e-6, lambertPhase(alpha));
  const areaKm2 = areaM2 / 1e6;
  const ratio = Math.max(1e-30, eclipseFraction * albedo * areaKm2 * phase / (Math.PI * rangeKm * rangeKm));
  return -26.74 - 2.5 * Math.log10(ratio);
}
function getObserver() {
  return {
    lat: parseFloat(els.lat.value),
    lon: parseFloat(els.lon.value),
    height: parseFloat(els.height.value || '0'),
    darkLimit: parseFloat(els.darkLimit.value),
    minAlt: parseFloat(els.minAlt.value),
    magLimit: parseFloat(els.magLimit.value),
    area: parseFloat(els.area.value),
    albedo: parseFloat(els.albedo.value),
  };
}
function sampleAt(i, obs = getObserver()) {
  const date = eph.dates[i];
  const sc = eph.sc[i];
  const sun = eph.sun[i];
  const topo = topocentric(sc, obs.lat, obs.lon, obs.height, date);
  const sunTopo = topocentric(sun, obs.lat, obs.lon, obs.height, date);
  const ecl = eclipseState(sc, sun);
  const mag = roughMagnitude(sc, sun, topo.rangeKm, obs.area, obs.albedo, ecl.fraction);
  const alpha = deg(phaseAngle(sc, sun));
  const altitudeKm = norm(sc) - RE_KM;
  const above = topo.alt >= obs.minAlt;
  const dark = sunTopo.alt <= obs.darkLimit;
  const brightEnough = mag <= obs.magLimit;
  const visible = above && dark && ecl.sunlit && brightEnough;
  return { date, sc, sun, topo, sunTopo, ecl, mag, alpha, altitudeKm, above, dark, brightEnough, visible };
}
function pathClass(s) {
  if (s.topo.alt < 0) return 'below';
  if (!s.ecl.sunlit) return 'shadow';
  if (!s.dark) return 'twilight';
  if (s.visible) return 'visible';
  return 'faint';
}
function colorFor(cls, alpha = 1) {
  const colors = {
    visible: `rgba(116,240,168,${alpha})`,
    twilight: `rgba(255,211,110,${alpha})`,
    shadow: `rgba(182,144,255,${alpha})`,
    below: `rgba(102,117,139,${alpha*.55})`,
    faint: `rgba(129,212,255,${alpha*.75})`,
  };
  return colors[cls] || colors.faint;
}
function drawSky() {
  const canvas = els.sky, ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);
  const cx = w / 2, cy = h / 2 + 16, R = Math.min(w, h) * 0.42;
  const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  grd.addColorStop(0, 'rgba(129,212,255,.10)');
  grd.addColorStop(1, 'rgba(4,10,20,.62)');
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = 'rgba(190,215,240,.35)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.font = '22px system-ui, sans-serif'; ctx.fillStyle = 'rgba(235,246,255,.78)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const alt of [30, 60]) {
    const rr = (90 - alt)/90 * R;
    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI*2); ctx.strokeStyle = 'rgba(190,215,240,.14)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillText(`${alt}°`, cx + rr + 24, cy);
  }
  [['N',0],['E',90],['S',180],['W',270]].forEach(([lab, az]) => {
    const p = skyXY(0, az, cx, cy, R);
    ctx.fillStyle = 'rgba(235,246,255,.84)'; ctx.font = '18px system-ui, sans-serif'; ctx.fillText(lab, p.x, p.y);
  });
  const obs = getObserver();
  let lastAbove = null;
  const stride = Math.max(1, Math.floor(eph.times.length / 1400));
  for (let i=0; i<eph.times.length; i+=stride) {
    const s = sampleAt(i, obs);
    if (s.topo.alt < 0) { lastAbove = null; continue; }
    const p = skyXY(s.topo.alt, s.topo.az, cx, cy, R);
    const cls = pathClass(s);
    if (lastAbove) {
      ctx.beginPath(); ctx.moveTo(lastAbove.x, lastAbove.y); ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = colorFor(lastAbove.cls, lastAbove.cls === 'below' ? .75 : .95);
      ctx.lineWidth = lastAbove.cls === 'visible' ? 4 : 2.5;
      ctx.stroke();
    }
    lastAbove = { ...p, cls };
  }

  const now = sampleAt(idx, obs);
  const currentInside = now.topo.alt >= 0;
  const p = currentInside ? skyXY(now.topo.alt, now.topo.az, cx, cy, R) : skyXY(-5, now.topo.az, cx, cy, R + 16);
  if (!currentInside) {
    // A below-horizon target has an azimuth but no position in the visible sky. Show the bearing just outside the horizon rim.
    ctx.beginPath(); ctx.setLineDash([7, 7]);
    const rim = skyXY(0, now.topo.az, cx, cy, R);
    ctx.moveTo(rim.x, rim.y); ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = 'rgba(102,117,139,.75)'; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, Math.PI*2); ctx.fillStyle = now.visible ? 'white' : colorFor(pathClass(now), 1); ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = now.visible ? 'rgba(116,240,168,1)' : 'rgba(255,255,255,.8)'; ctx.stroke();
  ctx.fillStyle = 'rgba(235,246,255,.90)'; ctx.font = '16px system-ui, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(currentInside ? 'Clipper' : 'Clipper below horizon', p.x + 14, p.y - 14);
  // Sun marker if above/near horizon
  const sunAlt = clamp(now.sunTopo.alt, -10, 90);
  if (now.sunTopo.alt > -12) {
    const sp = skyXY(Math.max(0, sunAlt), now.sunTopo.az, cx, cy, R);
    ctx.beginPath(); ctx.arc(sp.x, sp.y, 8, 0, Math.PI*2); ctx.fillStyle = 'rgba(255,211,110,.95)'; ctx.fill();
    ctx.fillText('Sun', sp.x + 12, sp.y + 12);
  }
  ctx.fillStyle = 'rgba(150,168,189,.90)'; ctx.font = '14px system-ui, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('Horizon', cx, cy + R + 28);
}
function skyXY(alt, az, cx, cy, R) {
  const rr = (90 - alt) / 90 * R;
  const a = rad(az);
  return { x: cx + rr * Math.sin(a), y: cy - rr * Math.cos(a) };
}
function project3(v) {
  const y = geoRot.yaw, p = geoRot.pitch;
  const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p);
  let x = cy*v[0] + sy*v[1];
  let yy = -sy*v[0] + cy*v[1];
  let z = v[2];
  let y2 = cp*yy - sp*z;
  let z2 = sp*yy + cp*z;
  return [x, y2, z2];
}
function compressVec(v, maxR) {
  const r = norm(v);
  if (r === 0) return [0,0,0];
  const m = Math.log1p(r / RE_KM) / Math.log1p(maxR / RE_KM);
  return mul(unit(v), m);
}
function drawGeometry() {
  const canvas = els.geo, ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0,0,w,h);
  const obs = getObserver();
  const now = sampleAt(idx, obs);
  const mode = els.geoScale?.value || 'near';
  const maxR = Math.max(...eph.rangeSamples);
  const nearViewER = 5.0;
  const scale = Math.min(w,h) * (mode === 'near' ? 0.52 : 0.40);
  const cx = mode === 'near' ? w * 0.58 : w / 2;
  const cy = h * 0.53;
  const earthR = mode === 'near' ? scale / nearViewER : 46;
  const sunDir = unit(now.sun);

  // Star speckles: deterministic from canvas size, no runtime assets.
  ctx.save();
  ctx.globalAlpha = 0.45;
  for (let n=0; n<120; n++) {
    const x = ((n * 97) % w), y = ((n * 53 + 31) % h), r = ((n * 17) % 4) / 8 + 0.3;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fillStyle = n % 9 === 0 ? 'rgba(255,231,168,.9)' : 'rgba(220,240,255,.8)'; ctx.fill();
  }
  ctx.restore();

  function mapRaw(v) {
    const scene = mode === 'near' ? mul(v, 1 / (RE_KM * nearViewER)) : compressVec(v, maxR);
    const c = project3(scene);
    return { x: cx + c[0]*scale, y: cy - c[1]*scale, z: c[2], scene };
  }
  function mapNorm(v) {
    const c = project3(v);
    return { x: cx + c[0]*scale, y: cy - c[1]*scale, z: c[2] };
  }
  function drawPolyline(points, color, width=1.5, dash=null) {
    ctx.beginPath();
    points.forEach((p, n) => n ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    if (dash) ctx.setLineDash(dash);
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
    if (dash) ctx.setLineDash([]);
  }
  function greatCirclePoints(b1, b2, radiusN) {
    const pts = [];
    for (let k=0; k<=160; k++) {
      const t = 2 * Math.PI * k / 160;
      pts.push(mapNorm(add(mul(b1, radiusN * Math.cos(t)), mul(b2, radiusN * Math.sin(t)))));
    }
    return pts;
  }

  // Reference planes: ecliptic and equator, to separate Solar-System geometry from the local horizon view.
  const eps = rad(23.439291111);
  const eclB1 = [1,0,0], eclB2 = [0,Math.cos(eps),Math.sin(eps)];
  drawPolyline(greatCirclePoints(eclB1, eclB2, mode === 'near' ? 0.92 : 0.78), 'rgba(255,211,110,.42)', 1.4, [6,5]);
  drawPolyline(greatCirclePoints([1,0,0], [0,1,0], mode === 'near' ? 0.74 : 0.62), 'rgba(129,212,255,.18)', 1.1, [3,7]);

  // Earth shadow cylinder/cone approximation, drawn behind Earth and along the anti-solar direction.
  const sh = mapNorm(mul(sunDir, -0.92));
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(sh.x, sh.y);
  ctx.strokeStyle = 'rgba(70,45,120,.18)'; ctx.lineWidth = earthR * 2.05; ctx.lineCap = 'butt'; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(sh.x, sh.y);
  ctx.strokeStyle = 'rgba(182,144,255,.34)'; ctx.lineWidth = 1.5; ctx.setLineDash([8,6]); ctx.stroke(); ctx.setLineDash([]);

  // Spacecraft path. Near mode intentionally lets distant samples leave the frame; compressed mode fits all samples.
  let last = null;
  const stride = Math.max(1, Math.floor(eph.times.length / 900));
  for (let i=0; i<eph.times.length; i+=stride) {
    const p = mapRaw(eph.sc[i]);
    const s = sampleAt(i, obs);
    if (last) {
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = colorFor(last.cls, last.cls === 'visible' ? .9 : .50);
      ctx.lineWidth = last.cls === 'visible' ? 2.6 : 1.8;
      ctx.stroke();
    }
    last = { ...p, cls: pathClass(s) };
  }

  // Earth with simple sun-side lighting.
  const sunProj = project3(sunDir);
  const gx = cx + sunProj[0]*earthR*.58, gy = cy - sunProj[1]*earthR*.58;
  const earthGrad = ctx.createRadialGradient(gx, gy, Math.max(2, earthR*.06), cx, cy, earthR*1.1);
  earthGrad.addColorStop(0, '#99dbff'); earthGrad.addColorStop(.35, '#2d7fbd'); earthGrad.addColorStop(.70, '#0c2a4e'); earthGrad.addColorStop(1, '#020713');
  ctx.beginPath(); ctx.arc(cx, cy, earthR, 0, Math.PI*2); ctx.fillStyle = earthGrad; ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(220,240,255,.48)'; ctx.stroke();
  // Subsolar point.
  ctx.beginPath(); ctx.arc(cx + sunProj[0]*earthR*.96, cy - sunProj[1]*earthR*.96, 4.5, 0, Math.PI*2); ctx.fillStyle = 'rgba(255,211,110,.95)'; ctx.fill();

  // Observer on Earth and zenith direction.
  const obsVec = observerEci(obs.lat, obs.lon, obs.height, now.date);
  const op = mapRaw(obsVec);
  const zen = mapRaw(mul(unit(obsVec), RE_KM * 1.85));
  ctx.beginPath(); ctx.moveTo(op.x, op.y); ctx.lineTo(zen.x, zen.y); ctx.strokeStyle = 'rgba(255,255,255,.32)'; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.beginPath(); ctx.arc(op.x, op.y, 5.5, 0, Math.PI*2); ctx.fillStyle = '#ffffff'; ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.stroke();

  // Current spacecraft marker.
  const sp = mapRaw(now.sc);
  ctx.beginPath(); ctx.arc(sp.x, sp.y, 8.5, 0, Math.PI*2); ctx.fillStyle = now.visible ? '#74f0a8' : '#ffd36e'; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.stroke();
  ctx.fillStyle = 'rgba(235,246,255,.88)'; ctx.font = '14px system-ui, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('Europa Clipper', sp.x + 12, sp.y + 4);

  // Sun arrow and labels.
  const sd = project3(sunDir);
  arrow(ctx, 60, 56, 60 + sd[0]*58, 56 - sd[1]*58, '#ffd36e');
  ctx.fillStyle = '#fff1c6'; ctx.font = '13px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.fillText('Sun direction', 84, 58);
  const labelE = mapNorm(add(mul(eclB1, mode === 'near' ? 0.70 : 0.60), mul(eclB2, mode === 'near' ? 0.52 : 0.42)));
  ctx.fillStyle = 'rgba(255,231,168,.75)'; ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('ecliptic plane', labelE.x, labelE.y);
  ctx.fillStyle = 'rgba(220,235,250,.68)'; ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(mode === 'near' ? 'near-Earth scale; distant path may extend offscreen' : 'log-compressed full ±window geometry', cx, h - 16);
}
function arrow(ctx, x1,y1,x2,y2,color) {
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
  const a = Math.atan2(y2-y1,x2-x1);
  ctx.beginPath(); ctx.moveTo(x2,y2); ctx.lineTo(x2-10*Math.cos(a-.45), y2-10*Math.sin(a-.45)); ctx.lineTo(x2-10*Math.cos(a+.45), y2-10*Math.sin(a+.45)); ctx.closePath(); ctx.fill();
}
function updateReadout() {
  const s = sampleAt(idx);
  els.timeReadout.textContent = fmt.format(s.date).replace(' UTC', '') + ' UTC';
  const reasons = [];
  if (s.topo.alt < getObserver().minAlt) reasons.push('below/min altitude');
  if (!s.dark) reasons.push('sky too bright');
  if (!s.ecl.sunlit) reasons.push('spacecraft in Earth shadow');
  if (!s.brightEnough) reasons.push('too faint by rough model');
  let text, cls;
  if (s.visible) { text = 'Potentially visible'; cls = 'good'; }
  else if (s.topo.alt > 0 && s.dark && s.ecl.sunlit) { text = 'Geometrically visible, probably faint'; cls = 'warn'; }
  else { text = 'Not visible: ' + reasons.join(', '); cls = 'bad'; }
  els.visibilityBadge.textContent = text;
  els.visibilityBadge.className = 'visibility-badge ' + cls;
  const topoEq = equatorialRaDec(s.topo.rhoEci);
  const topoEcl = eclipticLonLat(s.topo.rhoEci);
  const geoEcl = eclipticLonLat(s.sc);
  const rows = [
    ['Alt / Az', `${s.topo.alt.toFixed(1)}° / ${s.topo.az.toFixed(1)}°`],
    ['Topocentric RA / Dec', `${(topoEq.ra/15).toFixed(2)}h / ${topoEq.dec.toFixed(1)}°`],
    ['Topocentric ecl. lat', `${topoEcl.lat.toFixed(1)}°`],
    ['Geocentric ecl. lat', `${geoEcl.lat.toFixed(1)}°`],
    ['Range', `${s.topo.rangeKm.toLocaleString(undefined,{maximumFractionDigits:0})} km`],
    ['Geocentric altitude', `${s.altitudeKm.toLocaleString(undefined,{maximumFractionDigits:0})} km`],
    ['Sun altitude', `${s.sunTopo.alt.toFixed(1)}°`],
    ['Spacecraft lighting', `${s.ecl.state}${s.ecl.state==='penumbra' ? ` (${Math.round(s.ecl.fraction*100)}%)` : ''}`],
    ['Phase angle', `${s.alpha.toFixed(1)}°`],
    ['Rough magnitude', `${s.mag.toFixed(1)}`],
  ];
  els.readout.innerHTML = rows.map(([k,v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}
function render() {
  if (!eph) return;
  idx = clamp(idx, 0, eph.times.length - 1);
  els.timeSlider.value = idx;
  updateReadout(); drawSky(); drawGeometry();
}
function setPlace(p) {
  els.lat.value = p.lat; els.lon.value = p.lon; els.height.value = p.height;
  render();
}
function findClosestSample() {
  let best = 0, bestR = Infinity;
  for (let i=0; i<eph.sc.length; i++) {
    const r = norm(eph.sc[i]);
    if (r < bestR) { bestR = r; best = i; }
  }
  return best;
}
function provenanceHtml(meta) {
  const isDemo = meta.source && meta.source.includes('DEMO');
  const warning = isDemo ? `<div class="warning-box"><strong>Demo ephemeris loaded.</strong> This package could not fetch Horizons from the sandbox, so the bundled <code>data/clipper_ega.json</code> is a synthetic UI demo. Run <code>python scripts/fetch_horizons.py</code> from the repo root to replace it with actual JPL Horizons vectors before making visibility conclusions.</div>` : '';
  return `${warning}
    <p><strong>Source:</strong> <code>${meta.source || 'unknown'}</code></p>
    <p><strong>Target:</strong> ${meta.target?.name || 'Europa Clipper'} <code>${meta.target?.horizonsId || '-159'}</code>; <strong>center:</strong> ${meta.center?.name || 'Earth geocenter'} <code>${meta.center?.horizonsCenter || '500@399'}</code>.</p>
    <p><strong>Generated:</strong> ${meta.generatedUtc || '—'}</p>
    <p><strong>Frame:</strong> ${meta.frame || 'ECI-like geocentric vectors for browser-side topocentric calculations.'}</p>
    ${meta.closestSampleUtc ? `<p><strong>Closest sampled:</strong> ${meta.closestSampleUtc}, altitude ${Number(meta.closestSampleAltitudeKm).toFixed(1)} km.</p>` : ''}
    ${(meta.notes || []).map(n => `<p>• ${n}</p>`).join('')}`;
}
async function loadData() {
  const res = await fetch('./data/clipper_ega.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load data/clipper_ega.json (${res.status})`);
  const data = await res.json();
  eph = {
    meta: data.metadata || {},
    times: data.times,
    dates: data.times.map(t => new Date(t)),
    sc: data.clipper_eci_km,
    sun: data.sun_eci_km,
  };
  eph.rangeSamples = eph.sc.map(norm);
  els.timeSlider.max = eph.times.length - 1;
  idx = findClosestSample();
  els.timeSlider.value = idx;
  const isDemo = (eph.meta.source || '').includes('DEMO');
  els.dataStatus.textContent = isDemo ? 'Demo ephemeris · replace with Horizons' : `Horizons data · ${eph.times.length} samples`;
  els.dataStatus.className = 'status-pill ' + (isDemo ? 'warn' : 'good');
  els.provenance.innerHTML = provenanceHtml(eph.meta);
  render();
}
function scanBestLocations() {
  if (!eph) return;
  els.bestResults.textContent = 'Scanning…';
  setTimeout(() => {
    const obsBase = getObserver();
    const results = [];
    const timeStride = Math.max(1, Math.round((5*60) / ((eph.dates[1] - eph.dates[0]) / 1000 || 60)));
    for (let i=0; i<eph.times.length; i += timeStride) {
      for (let lat=-70; lat<=70; lat+=5) {
        for (let lon=-180; lon<180; lon+=5) {
          const obs = { ...obsBase, lat, lon, height: 0 };
          const s = sampleAt(i, obs);
          if (s.topo.alt < obs.minAlt || !s.dark || !s.ecl.sunlit) continue;
          const magPenalty = Math.max(0, s.mag - obs.magLimit) * 4;
          const score = s.topo.alt + (obs.dark ? 8 : 0) + (s.ecl.state === 'sunlit' ? 6 : 0) - magPenalty - Math.log10(Math.max(1, s.topo.rangeKm)) * 2;
          if (score > 0) results.push({ score, idx: i, lat, lon, alt: s.topo.alt, az: s.topo.az, mag: s.mag, range: s.topo.rangeKm, sunAlt: s.sunTopo.alt, lit: s.ecl.state, visible: s.visible });
        }
      }
    }
    results.sort((a,b) => b.score - a.score);
    // de-duplicate roughly by time/region
    const picked = [];
    for (const r of results) {
      if (picked.length >= 8) break;
      if (!picked.some(p => Math.abs(p.lat-r.lat)<10 && Math.abs((((p.lon-r.lon+540)%360)-180))<15 && Math.abs(p.idx-r.idx)<6*timeStride)) picked.push(r);
    }
    bestCache = picked;
    if (!picked.length) {
      els.bestResults.innerHTML = 'No coarse-grid candidates met the current darkness/altitude/lighting thresholds. Try lowering the limiting magnitude or minimum altitude, or load real Horizons data first.';
      return;
    }
    els.bestResults.innerHTML = picked.map((r, n) => {
      const date = fmt.format(eph.dates[r.idx]).replace(' UTC','');
      return `<div class="best-row"><div class="best-rank">${n+1}</div><div><strong>${date} UTC</strong><br>lat ${r.lat.toFixed(1)}°, lon ${r.lon.toFixed(1)}°E · alt ${r.alt.toFixed(1)}°, az ${r.az.toFixed(0)}° · Sun ${r.sunAlt.toFixed(1)}° · ${r.lit}</div><div>mag ${r.mag.toFixed(1)}<br>${Math.round(r.range).toLocaleString()} km</div></div>`;
    }).join('');
  }, 25);
}

function yawPitchForDirection(dir) {
  // Rotate a requested inertial direction close to the screen normal, useful for a Sun-line preset.
  const x = dir[0], y = dir[1], z = dir[2];
  return { yaw: Math.atan2(x, y), pitch: Math.asin(clamp(z, -1, 1)) };
}

function wireEvents() {
  document.querySelectorAll('[data-place]').forEach(b => b.addEventListener('click', () => setPlace(PLACES[b.dataset.place])));
  ['input','change'].forEach(evt => {
    [els.lat, els.lon, els.height, els.darkLimit, els.area, els.albedo, els.magLimit, els.minAlt].forEach(el => el.addEventListener(evt, render));
  });
  els.timeSlider.addEventListener('input', () => { idx = parseInt(els.timeSlider.value, 10); render(); });
  els.stepBack.addEventListener('click', () => { idx--; render(); });
  els.stepForward.addEventListener('click', () => { idx++; render(); });
  els.jumpClosest.addEventListener('click', () => { idx = findClosestSample(); render(); });
  els.speed.addEventListener('input', () => { els.speedLabel.textContent = `${els.speed.value} samples/s`; if (playTimer) { stopPlay(); startPlay(); } });
  els.playPause.addEventListener('click', () => { playTimer ? stopPlay() : startPlay(); });
  els.scanBest.addEventListener('click', scanBestLocations);
  els.applyBest.addEventListener('click', () => { if (!bestCache.length) return; const b = bestCache[0]; els.lat.value = b.lat; els.lon.value = b.lon; els.height.value = 0; idx = b.idx; render(); });
  els.useGps.addEventListener('click', () => {
    if (!navigator.geolocation) { alert('Geolocation is not available in this browser.'); return; }
    navigator.geolocation.getCurrentPosition(pos => {
      els.lat.value = pos.coords.latitude.toFixed(6); els.lon.value = pos.coords.longitude.toFixed(6); els.height.value = Math.round(pos.coords.altitude || 0); render();
    }, err => alert(err.message));
  });
  els.geoScale?.addEventListener('change', drawGeometry);
  els.geoPresetEyes?.addEventListener('click', () => { geoRot = { yaw: -0.9, pitch: 0.45 }; drawGeometry(); });
  els.geoPresetSun?.addEventListener('click', () => { geoRot = yawPitchForDirection(unit(sampleAt(idx).sun)); drawGeometry(); });
  els.geoPresetNorth?.addEventListener('click', () => { geoRot = { yaw: 0, pitch: Math.PI / 2 }; drawGeometry(); });
  els.geo.addEventListener('pointerdown', e => { dragging = true; lastDrag = [e.clientX, e.clientY]; els.geo.setPointerCapture(e.pointerId); });
  els.geo.addEventListener('pointermove', e => {
    if (!dragging || !lastDrag) return;
    const dx = e.clientX - lastDrag[0], dy = e.clientY - lastDrag[1]; lastDrag = [e.clientX, e.clientY];
    geoRot.yaw += dx * 0.008; geoRot.pitch = clamp(geoRot.pitch + dy * 0.008, -1.35, 1.35); drawGeometry();
  });
  els.geo.addEventListener('pointerup', () => { dragging = false; lastDrag = null; });
  window.addEventListener('resize', render);
}
function startPlay() {
  const rate = parseInt(els.speed.value, 10);
  els.playPause.textContent = 'Pause';
  playTimer = setInterval(() => { idx = (idx + 1) % eph.times.length; render(); }, 1000 / rate);
}
function stopPlay() { clearInterval(playTimer); playTimer = null; els.playPause.textContent = 'Play'; }

wireEvents();
loadData().catch(err => {
  console.error(err);
  els.dataStatus.textContent = 'Could not load ephemeris';
  els.dataStatus.className = 'status-pill warn';
  els.provenance.innerHTML = `<div class="warning-box">${err.message}</div>`;
});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js').catch(() => {}));
}
