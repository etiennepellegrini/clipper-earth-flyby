'use strict';

const RE_KM = 6378.137;
const RSUN_KM = 695700;
const AU_KM = 149597870.7;
const PLACES = {
  santaMonica: { lat: 34.0195, lon: -118.4912, height: 30, label: 'Santa Monica, CA' },
  strasbourg: { lat: 48.5734, lon: 7.7521, height: 142, label: 'Strasbourg, France' },
};

const els = {
  dataStatus: document.getElementById('dataStatus'), missionEyebrow: document.getElementById('missionEyebrow'),
  datasetSelect: document.getElementById('datasetSelect'), datasetHint: document.getElementById('datasetHint'),
  lat: document.getElementById('lat'), lon: document.getElementById('lon'), height: document.getElementById('height'),
  darkLimit: document.getElementById('darkLimit'), timeSlider: document.getElementById('timeSlider'), timeReadout: document.getElementById('timeReadout'),
  stepBack: document.getElementById('stepBack'), stepForward: document.getElementById('stepForward'), playPause: document.getElementById('playPause'), jumpClosest: document.getElementById('jumpClosest'),
  speed: document.getElementById('speed'), speedLabel: document.getElementById('speedLabel'),
  area: document.getElementById('area'), albedo: document.getElementById('albedo'), magLimit: document.getElementById('magLimit'), minAlt: document.getElementById('minAlt'),
  sky: document.getElementById('skyCanvas'), geo: document.getElementById('geoCanvas'), readout: document.getElementById('readout'), visibilityBadge: document.getElementById('visibilityBadge'),
  geoPresetEyes: document.getElementById('geoPresetEyes'), geoPresetSun: document.getElementById('geoPresetSun'), geoPresetNorth: document.getElementById('geoPresetNorth'),
  provenance: document.getElementById('provenance'), scanBest: document.getElementById('scanBest'), applyBest: document.getElementById('applyBest'), bestResults: document.getElementById('bestResults'), useGps: document.getElementById('useGps'),
};

let eph = null;
let datasets = [];
let idx = 0;
let playTimer = null;
let bestCache = [];
let geoRot = { yaw: -0.9, pitch: 0.45 };
let geoViewPreset = 'perspective';
let dragging = false, lastDrag = null;
let geoRangeZoom = 0; // 0 = true near-Earth scale; 1 = strongly compressed full-pass scale.
const geoPointers = new Map();
let geoPinch = null;

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
  // From target, does Earth block the Sun?
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
  // Sun-target-observer angle; observer approximated at Earth center for brightness.
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

function targetName() {
  return eph?.meta?.target?.name || eph?.dataset?.label || 'target';
}
function shortTargetName() {
  const name = targetName();
  return name.replace(/^(Europa\s+)?/i, '').replace(/\s+Earth flyby.*$/i, '');
}
function prepareCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(280, Math.round(rect.width || canvas.clientWidth || 700));
  const h = Math.max(220, Math.round(rect.height || canvas.clientHeight || w * 0.75));
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}
function clearPrepared(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
}
function safeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
function drawSky() {
  const { ctx, w, h } = prepareCanvas(els.sky);
  clearPrepared(ctx, w, h);
  const mobile = w < 520;
  const cx = w / 2, cy = h / 2 + (mobile ? 8 : 16), R = Math.min(w * 0.46, h * 0.42);
  const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  grd.addColorStop(0, 'rgba(129,212,255,.10)');
  grd.addColorStop(1, 'rgba(4,10,20,.62)');
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = 'rgba(190,215,240,.35)'; ctx.lineWidth = 2; ctx.stroke();
  ctx.font = `${mobile ? 13 : 22}px system-ui, sans-serif`; ctx.fillStyle = 'rgba(235,246,255,.78)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const alt of [30, 60]) {
    const rr = (90 - alt)/90 * R;
    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI*2); ctx.strokeStyle = 'rgba(190,215,240,.14)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillText(`${alt}°`, cx + rr + 24, cy);
  }
  [['N',0],['E',90],['S',180],['W',270]].forEach(([lab, az]) => {
    const p = skyXY(0, az, cx, cy, R);
    ctx.fillStyle = 'rgba(235,246,255,.84)'; ctx.font = `${mobile ? 12 : 18}px system-ui, sans-serif`; ctx.fillText(lab, p.x, p.y);
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
  ctx.fillStyle = 'rgba(235,246,255,.90)'; ctx.font = `${mobile ? 11 : 16}px system-ui, sans-serif`; ctx.textAlign = 'left';
  ctx.fillText(currentInside ? shortTargetName() : `${shortTargetName()} below horizon`, p.x + 14, p.y - 14);
  // Sun marker if above/near horizon
  const sunAlt = clamp(now.sunTopo.alt, -10, 90);
  if (now.sunTopo.alt > -12) {
    const sp = skyXY(Math.max(0, sunAlt), now.sunTopo.az, cx, cy, R);
    ctx.beginPath(); ctx.arc(sp.x, sp.y, 8, 0, Math.PI*2); ctx.fillStyle = 'rgba(255,211,110,.95)'; ctx.fill();
    ctx.fillText('Sun', sp.x + 12, sp.y + 12);
  }
  ctx.fillStyle = 'rgba(150,168,189,.90)'; ctx.font = `${mobile ? 10 : 14}px system-ui, sans-serif`; ctx.textAlign = 'center';
  ctx.fillText('Horizon', cx, Math.min(h - 12, cy + R + (mobile ? 18 : 28)));
}
function skyXY(alt, az, cx, cy, R) {
  const rr = (90 - alt) / 90 * R;
  const a = rad(az);
  return { x: cx + rr * Math.sin(a), y: cy - rr * Math.cos(a) };
}
function cameraBasis() {
  // Turntable/orbit camera: yaw is azimuth around Earth's north axis and pitch is
  // elevation above the equatorial plane. Keeping a stable "up" direction makes
  // dragging behave like orbit controls rather than rotating a flat drawing.
  const az = geoRot.yaw;
  const el = geoRot.pitch;
  const forward = [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
  let referenceUp = [0, 0, 1];
  if (Math.abs(dot(forward, referenceUp)) > 0.995) referenceUp = [0, 1, 0];
  const right = unit(cross(referenceUp, forward));
  const up = unit(cross(forward, right));
  return { right, up, forward };
}
function project3(v) {
  const basis = cameraBasis();
  return [dot(v, basis.right), dot(v, basis.up), dot(v, basis.forward)];
}
function rangeCompressionStrength() {
  // Keep the near-Earth neighborhood nearly metric while smoothly compressing
  // distant trajectory legs.  The exponential range gives useful control at both
  // ends: small wheel changes near zero remain gentle; the far end can fit an
  // entire multi-hour/day pass without shrinking Earth.
  if (geoRangeZoom <= 1e-4) return 0;
  return 0.02 * Math.pow(250, geoRangeZoom);
}
function mappedRangeER(rER) {
  // Preserve the actual close-pass geometry through 2.5 Earth radii. Range zoom
  // only bends the distant legs inward, so Earth and the encounter neighborhood
  // do not appear to breathe as the user scrolls.
  const pivotER = 2.5;
  if (rER <= pivotER || geoRangeZoom <= 1e-4) return rER;
  const k = rangeCompressionStrength();
  return pivotER + Math.asinh(k * (rER - pivotER)) / k;
}
function rangeMapVec(v) {
  const r = norm(v);
  if (r === 0) return [0,0,0];
  return mul(unit(v), mappedRangeER(r / RE_KM));
}
function drawGeometry() {
  const { ctx, w, h } = prepareCanvas(els.geo);
  clearPrepared(ctx, w, h);
  const obs = getObserver();
  const now = sampleAt(idx, obs);

  // Presets remain camera constraints. The Sun view tracks the current epoch;
  // dragging switches to a custom orbit camera.
  if (geoViewPreset === 'sun') geoRot = yawPitchForDirection(unit(now.sun));
  else if (geoViewPreset === 'north') geoRot = { yaw: 0, pitch: Math.PI / 2 };

  const maxRER = Math.max(...eph.rangeSamples) / RE_KM;
  const minDim = Math.min(w, h);
  const earthR = clamp(minDim * 0.115, 34, 68);
  const scale = earthR; // Scene units are Earth radii; Earth stays fixed while range zoom changes.
  const cx = w * 0.55;
  const cy = h * 0.53;
  const earthSceneR = 1;
  const cameraDistance = 16.25;
  const sunDir = unit(now.sun);
  const sunView = unit(project3(sunDir));
  const sunProjection = projectedScreenDirection(sunView);

  // Star speckles: deterministic from canvas size, no runtime assets.
  ctx.save();
  ctx.globalAlpha = 0.45;
  for (let n=0; n<130; n++) {
    const x = ((n * 97) % w), y = ((n * 53 + 31) % h), r = ((n * 17) % 4) / 8 + 0.3;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fillStyle = n % 9 === 0 ? 'rgba(255,231,168,.9)' : 'rgba(220,240,255,.8)'; ctx.fill();
  }
  ctx.restore();

  function projectScene(scene) {
    const view = project3(scene);
    const denominator = cameraDistance - view[2];
    const inFrontOfCamera = denominator > 0.08;
    const perspective = inFrontOfCamera ? cameraDistance / denominator : 0;
    return {
      x: cx + view[0] * scale * perspective,
      y: cy - view[1] * scale * perspective,
      z: view[2],
      perspective,
      inFrontOfCamera,
      view,
      scene,
    };
  }
  function mapRaw(v) { return projectScene(rangeMapVec(v)); }

  if (sunProjection.visible) drawProjectedSun(ctx, cx, cy, earthR, w, h, sunProjection);

  // Earth shadow is a spatial volume behind Earth. It is painted before Earth so
  // the planet naturally occludes its near end.
  if (sunProjection.visible) {
    const shEdge = frameEdgePoint(cx, cy, -sunProjection.x, -sunProjection.y, w, h, 18);
    drawEarthShadow(ctx, cx, cy, shEdge.x, shEdge.y, earthR, sunProjection.opacity);
  }

  // A real perspective ecliptic sheet, split by camera depth.  It is an annulus,
  // not a floating 2-D ellipse, and is clipped away from Earth's solid disk.
  const eps = rad(23.439291111);
  const eclipticX = [1, 0, 0];
  const eclipticY = [0, Math.cos(eps), Math.sin(eps)];
  const planeOuterR = clamp(mappedRangeER(Math.min(maxRER, 12)), 2.8, 5.2);
  const eclipticTiles = buildPlaneTiles(projectScene, eclipticX, eclipticY, 1.12, planeOuterR);
  drawPlaneTiles(ctx, eclipticTiles.back, cx, cy, earthR, w, h, false);

  // Build the path once, then use painter-style depth ordering.
  const backSegments = [];
  const frontSegments = [];
  let last = null;
  const stride = Math.max(1, Math.floor(eph.times.length / 900));
  for (let i=0; i<eph.times.length; i+=stride) {
    const p = mapRaw(eph.sc[i]);
    if (!p.inFrontOfCamera) { last = null; continue; }
    const current = { ...p, cls: pathClass(sampleAt(i, obs)) };
    if (last) {
      const segment = { a: last, b: current, cls: last.cls };
      ((last.z + current.z) * 0.5 < 0 ? backSegments : frontSegments).push(segment);
    }
    last = current;
  }

  function drawSegments(segments, behind) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const segment of segments) {
      const avgPerspective = clamp((segment.a.perspective + segment.b.perspective) * 0.5, 0.65, 1.65);
      const alpha = segment.cls === 'visible' ? (behind ? 0.48 : 0.92) : (behind ? 0.28 : 0.56);
      ctx.beginPath();
      ctx.moveTo(segment.a.x, segment.a.y);
      ctx.lineTo(segment.b.x, segment.b.y);
      ctx.strokeStyle = colorFor(segment.cls, alpha);
      ctx.lineWidth = (segment.cls === 'visible' ? 2.5 : 1.7) * avgPerspective;
      ctx.stroke();
    }
    ctx.restore();
  }

  const sp = mapRaw(now.sc);
  const targetBehind = sp.inFrontOfCamera && sp.z < 0;
  const targetOverEarth = sp.inFrontOfCamera && Math.hypot(sp.x - cx, sp.y - cy) < earthR * 1.02;

  function drawTargetMarker(p, behindEarth) {
    if (!p.inFrontOfCamera) return;
    const occulted = behindEarth && targetOverEarth;
    ctx.save();
    ctx.globalAlpha = behindEarth ? 0.58 : 1;
    ctx.beginPath(); ctx.arc(p.x, p.y, 8.5 * clamp(p.perspective, .8, 1.35), 0, Math.PI*2);
    ctx.fillStyle = now.visible ? '#74f0a8' : '#ffd36e'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.stroke();
    if (!occulted) {
      ctx.fillStyle = 'rgba(235,246,255,.88)'; ctx.font = '14px system-ui, sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(shortTargetName(), p.x + 12, p.y + 4);
    }
    ctx.restore();
  }

  drawSegments(backSegments, true);
  if (targetBehind) drawTargetMarker(sp, true);

  // Real Sun/Earth geometry for the lit and dark side of Earth.
  drawShadedEarth(ctx, cx, cy, earthR, sunView);

  // Equator painted directly on the visible surface of Earth.
  drawSurfaceGreatCircle(ctx, cx, cy, earthSceneR, scale, cameraDistance,
    [1,0,0], [0,1,0], 'rgba(206,231,255,.58)', [3,5]);

  // Keep a subtle subsolar dot, but no explanatory label.
  if (sunView[2] > earthSceneR / cameraDistance) {
    const pointScene = mul(sunView, earthSceneR * 0.995);
    const denominator = cameraDistance - pointScene[2];
    const perspective = cameraDistance / denominator;
    ctx.beginPath();
    ctx.arc(cx + pointScene[0] * scale * perspective, cy - pointScene[1] * scale * perspective, 3.6, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,226,132,.96)'; ctx.fill();
    ctx.strokeStyle = 'rgba(40,25,5,.55)'; ctx.lineWidth = 1; ctx.stroke();
  }

  // Foreground half of the ecliptic sheet is drawn after Earth, but clipped out of
  // the globe itself. Foreground trajectory remains on top of the reference plane.
  drawPlaneTiles(ctx, eclipticTiles.front, cx, cy, earthR, w, h, true);
  drawSegments(frontSegments, false);

  // Observer marker and local zenith. A far-side station remains visible as a dim,
  // shaded x-ray marker, while its zenith line is suppressed.
  const obsVec = observerEci(obs.lat, obs.lon, obs.height, now.date);
  const obsView = project3(unit(obsVec));
  const obsFront = obsView[2] > earthSceneR / cameraDistance;
  const op = mapRaw(obsVec);
  if (op.inFrontOfCamera) {
    if (obsFront) {
      const zen = mapRaw(mul(unit(obsVec), RE_KM * 1.85));
      if (zen.inFrontOfCamera) {
        ctx.beginPath(); ctx.moveTo(op.x, op.y); ctx.lineTo(zen.x, zen.y);
        ctx.strokeStyle = 'rgba(255,255,255,.36)'; ctx.lineWidth = 1.2; ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(op.x, op.y, 5.5, 0, Math.PI*2); ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 1; ctx.stroke();
    } else {
      ctx.save();
      ctx.beginPath(); ctx.arc(op.x, op.y, 5.2, 0, Math.PI*2);
      ctx.fillStyle = 'rgba(174,190,211,.28)'; ctx.fill();
      ctx.setLineDash([2.5,2.5]);
      ctx.strokeStyle = 'rgba(225,238,255,.48)'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.restore();
    }
  }

  if (!targetBehind) drawTargetMarker(sp, false);
}


function buildPlaneTiles(projectScene, basis1, basis2, innerR, outerR) {
  const tiles = { back: [], front: [] };
  const angularSteps = 48;
  const radialSteps = 3;
  for (let ir=0; ir<radialSteps; ir++) {
    const r0 = innerR + (outerR - innerR) * ir / radialSteps;
    const r1 = innerR + (outerR - innerR) * (ir + 1) / radialSteps;
    for (let ia=0; ia<angularSteps; ia++) {
      const a0 = 2 * Math.PI * ia / angularSteps;
      const a1 = 2 * Math.PI * (ia + 1) / angularSteps;
      const scenePoints = [
        add(mul(basis1, r0*Math.cos(a0)), mul(basis2, r0*Math.sin(a0))),
        add(mul(basis1, r1*Math.cos(a0)), mul(basis2, r1*Math.sin(a0))),
        add(mul(basis1, r1*Math.cos(a1)), mul(basis2, r1*Math.sin(a1))),
        add(mul(basis1, r0*Math.cos(a1)), mul(basis2, r0*Math.sin(a1))),
      ];
      const points = scenePoints.map(projectScene);
      if (points.some(p => !p.inFrontOfCamera)) continue;
      const z = points.reduce((sum, p) => sum + p.z, 0) / points.length;
      (z < 0 ? tiles.back : tiles.front).push({ points, z, radial: ir, angular: ia });
    }
  }
  tiles.back.sort((a,b) => a.z - b.z);
  tiles.front.sort((a,b) => a.z - b.z);
  return tiles;
}

function drawPlaneTiles(ctx, tiles, cx, cy, earthR, w, h, foreground) {
  if (!tiles.length) return;
  ctx.save();
  // Keep the reference sheet outside the opaque globe. The even-odd clip makes the
  // plane read as a 3-D annulus passing behind/in front of Earth rather than paint.
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.moveTo(cx + earthR * 1.035, cy);
  ctx.arc(cx, cy, earthR * 1.035, 0, Math.PI * 2);
  try { ctx.clip('evenodd'); } catch (_) { ctx.clip(); }

  for (const tile of tiles) {
    const pts = tile.points;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i=1; i<pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = foreground ? 'rgba(255,211,110,.030)' : 'rgba(255,211,110,.016)';
    ctx.fill();
    // Sparse mesh lines imply a plane without recreating the old floating dotted ellipse.
    if (tile.angular % 4 === 0 || tile.radial === 2) {
      ctx.strokeStyle = foreground ? 'rgba(255,211,110,.18)' : 'rgba(255,211,110,.09)';
      ctx.lineWidth = foreground ? 0.9 : 0.7;
      ctx.setLineDash(tile.radial === 2 ? [5,6] : [2,7]);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function projectedScreenDirection(viewDir) {
  const sx = viewDir[0];
  const sy = -viewDir[1];
  const planeMagnitude = Math.hypot(sx, sy);
  if (planeMagnitude < 1e-12) return { x: 0, y: 0, planeMagnitude, opacity: 0, visible: false };
  const opacity = clamp((planeMagnitude - 0.08) / 0.24, 0, 1);
  return { x: sx / planeMagnitude, y: sy / planeMagnitude, planeMagnitude, opacity, visible: opacity > 0.02 };
}

function frameEdgePoint(cx, cy, vx, vy, w, h, margin=20) {
  const xlim = vx > 0 ? (w - margin - cx) / vx : vx < 0 ? (margin - cx) / vx : Infinity;
  const ylim = vy > 0 ? (h - margin - cy) / vy : vy < 0 ? (margin - cy) / vy : Infinity;
  const t = Math.max(0, Math.min(xlim, ylim));
  return { x: cx + vx*t, y: cy + vy*t };
}

function drawProjectedSun(ctx, cx, cy, earthR, w, h, projection) {
  const edge = frameEdgePoint(cx, cy, projection.x, projection.y, w, h, 13);
  const dx = edge.x - cx, dy = edge.y - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const sunRadius = 4.2;

  ctx.save();
  ctx.globalAlpha = projection.opacity;
  ctx.beginPath();
  ctx.moveTo(cx + ux * earthR * 0.97, cy + uy * earthR * 0.97);
  ctx.lineTo(edge.x - ux * (sunRadius + 3), edge.y - uy * (sunRadius + 3));
  ctx.strokeStyle = 'rgba(255,211,110,.48)';
  ctx.lineWidth = 1.35;
  ctx.setLineDash([5,6]);
  ctx.stroke();
  ctx.setLineDash([]);

  const glow = ctx.createRadialGradient(edge.x, edge.y, 1, edge.x, edge.y, 16);
  glow.addColorStop(0, 'rgba(255,244,184,.92)');
  glow.addColorStop(.28, 'rgba(255,211,110,.42)');
  glow.addColorStop(1, 'rgba(255,211,110,0)');
  ctx.beginPath(); ctx.arc(edge.x, edge.y, 16, 0, Math.PI*2); ctx.fillStyle = glow; ctx.fill();
  ctx.beginPath(); ctx.arc(edge.x, edge.y, sunRadius, 0, Math.PI*2); ctx.fillStyle = '#ffd36e'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,244,184,.9)'; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.restore();
}

function drawSurfaceGreatCircle(ctx, cx, cy, earthSceneR, scale, cameraDistance, basis1, basis2, color, dash) {
  let drawing = false;
  const visibilityThreshold = earthSceneR / cameraDistance;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.15;
  ctx.setLineDash(dash || []);
  for (let k=0; k<=360; k++) {
    const t = 2*Math.PI*k/360;
    const world = add(mul(basis1, Math.cos(t)), mul(basis2, Math.sin(t)));
    const viewUnit = project3(world);
    if (viewUnit[2] <= visibilityThreshold) {
      if (drawing) ctx.stroke();
      drawing = false;
      continue;
    }
    const view = mul(viewUnit, earthSceneR * 0.992);
    const denominator = cameraDistance - view[2];
    const perspective = cameraDistance / denominator;
    const x = cx + view[0] * scale * perspective;
    const y = cy - view[1] * scale * perspective;
    if (!drawing) { ctx.beginPath(); ctx.moveTo(x, y); drawing = true; }
    else ctx.lineTo(x, y);
  }
  if (drawing) ctx.stroke();
  ctx.restore();
}

function drawEarthShadow(ctx, cx, cy, x2, y2, earthR, projectionOpacity=1) {
  const dx = x2 - cx, dy = y2 - cy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const px = -uy, py = ux;
  const nearW = earthR * 1.92, farW = earthR * 1.25;
  ctx.save();
  ctx.globalAlpha = projectionOpacity;
  ctx.beginPath();
  ctx.moveTo(cx + px*nearW/2, cy + py*nearW/2);
  ctx.lineTo(x2 + px*farW/2, y2 + py*farW/2);
  ctx.lineTo(x2 - px*farW/2, y2 - py*farW/2);
  ctx.lineTo(cx - px*nearW/2, cy - py*nearW/2);
  ctx.closePath();
  const g = ctx.createLinearGradient(cx, cy, x2, y2);
  g.addColorStop(0, 'rgba(20,12,48,.44)');
  g.addColorStop(1, 'rgba(20,12,48,0)');
  ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x2, y2);
  ctx.strokeStyle = 'rgba(182,144,255,.30)'; ctx.lineWidth = 1.2; ctx.setLineDash([8,6]); ctx.stroke();
  ctx.restore();
}
function drawShadedEarth(ctx, cx, cy, R, sunView) {
  const l = unit(sunView);
  const minX = Math.floor(cx - R - 2), minY = Math.floor(cy - R - 2);
  const size = Math.ceil(2 * R + 4);
  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let j=0; j<size; j++) {
    for (let i=0; i<size; i++) {
      const sx = minX + i + 0.5, sy = minY + j + 0.5;
      const nx = (sx - cx) / R, ny = -(sy - cy) / R;
      const rr = nx*nx + ny*ny;
      const p = 4 * (j*size + i);
      if (rr > 1) { data[p+3] = 0; continue; }
      const nz = Math.sqrt(Math.max(0, 1 - rr));
      const illum = nx*l[0] + ny*l[1] + nz*l[2];
      const limb = Math.pow(Math.max(0, nz), 0.55);
      const pseudoCloud = 0.08 * Math.sin(19*nx + 9*ny) + 0.05 * Math.sin(31*(nx*nx - ny));
      let r,g,b,a=255;
      if (illum > 0) {
        const day = Math.pow(Math.min(1, illum), 0.45);
        r = 18 + 110*day + 18*pseudoCloud;
        g = 55 + 150*day + 22*pseudoCloud;
        b = 92 + 145*day + 30*pseudoCloud;
      } else {
        const night = Math.pow(Math.min(1, -illum), 0.5);
        r = 3 + 9*(1-night);
        g = 8 + 18*(1-night);
        b = 20 + 34*(1-night);
      }
      const atm = Math.pow(1 - Math.max(0, nz), 2.2) * 55;
      data[p] = clamp(Math.round((r + atm*0.35) * limb), 0, 255);
      data[p+1] = clamp(Math.round((g + atm*0.65) * limb), 0, 255);
      data[p+2] = clamp(Math.round((b + atm) * limb), 0, 255);
      data[p+3] = a;
    }
  }
  ctx.putImageData(img, minX, minY);
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI*2);
  ctx.strokeStyle = 'rgba(220,240,255,.48)'; ctx.lineWidth = 1.5; ctx.stroke();
}
function updateReadout() {
  const s = sampleAt(idx);
  els.timeReadout.textContent = fmt.format(s.date).replace(' UTC', '') + ' UTC';
  const reasons = [];
  if (s.topo.alt < getObserver().minAlt) reasons.push('below/min altitude');
  if (!s.dark) reasons.push('sky too bright');
  if (!s.ecl.sunlit) reasons.push('target in Earth shadow');
  if (!s.brightEnough) reasons.push('too faint by rough model');
  let text, cls;
  if (s.visible) { text = 'Potentially visible'; cls = 'good'; }
  else if (s.topo.alt > 0 && s.dark && s.ecl.sunlit) { text = 'Geometrically visible, probably faint'; cls = 'warn'; }
  else { text = 'Not visible: ' + (reasons.join(', ') || 'constraints not met'); cls = 'bad'; }
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
    ['Target lighting', `${s.ecl.state}${s.ecl.state==='penumbra' ? ` (${Math.round(s.ecl.fraction*100)}%)` : ''}`],
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
  const datasetPath = eph?.dataset?.path || 'data/clipper_ega.json';
  const target = meta.target || {};
  const center = meta.center || {};
  const id = target.horizonsId || target.command || 'unknown';
  const warning = isDemo ? `<div class="warning-box"><strong>Demo ephemeris loaded.</strong> The bundled dataset is a synthetic UI demo. Run <code>python scripts/fetch_horizons.py</code> from the repo root to replace it with real JPL Horizons vectors before making visibility conclusions.</div>` : '';
  return `${warning}
    <p><strong>Dataset file:</strong> <code>${safeHtml(datasetPath)}</code></p>
    <p><strong>Source:</strong> <code>${safeHtml(meta.source || 'unknown')}</code></p>
    <p><strong>Target:</strong> ${safeHtml(target.name || targetName())} <code>${safeHtml(id)}</code>; <strong>center:</strong> ${safeHtml(center.name || 'Earth geocenter')} <code>${safeHtml(center.horizonsCenter || center.command || '500@399')}</code>.</p>
    <p><strong>Generated:</strong> ${safeHtml(meta.generatedUtc || '—')}</p>
    <p><strong>Frame:</strong> ${safeHtml(meta.frame || 'ICRF/J2000 equator, geometric geocentric vectors for browser-side topocentric calculations.')}</p>
    ${meta.closestSampleUtc ? `<p><strong>Closest sampled:</strong> ${safeHtml(meta.closestSampleUtc)}, altitude ${Number(meta.closestSampleAltitudeKm).toFixed(1)} km.</p>` : ''}
    ${(meta.notes || []).map(n => `<p>• ${safeHtml(n)}</p>`).join('')}`;
}

function normalizeDatasetEntry(entry, idx = 0) {
  if (typeof entry === 'string') return { id: `dataset-${idx}`, label: entry.split('/').pop(), path: entry };
  return {
    id: entry.id || entry.slug || `dataset-${idx}`,
    label: entry.label || entry.name || entry.path || `Dataset ${idx + 1}`,
    path: entry.path || entry.url || 'data/clipper_ega.json',
    description: entry.description || '',
    target: entry.target || null,
  };
}

async function loadDatasetManifest() {
  try {
    const res = await fetch('./data/datasets.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('no manifest');
    const manifest = await res.json();
    const list = Array.isArray(manifest) ? manifest : (manifest.datasets || []);
    datasets = list.map(normalizeDatasetEntry);
  } catch {
    datasets = [{ id: 'clipper-ega-2026', label: 'Europa Clipper · Earth gravity assist · Dec 2026', path: 'data/clipper_ega.json', description: 'Fallback built-in dataset.' }];
  }
  if (!datasets.length) datasets = [{ id: 'clipper-ega-2026', label: 'Europa Clipper · Earth gravity assist · Dec 2026', path: 'data/clipper_ega.json' }];
  els.datasetSelect.innerHTML = datasets.map((d, i) => `<option value="${i}">${safeHtml(d.label)}</option>`).join('');
}

function applyDatasetDefaults(data) {
  const defaults = data.metadata?.uiDefaults || data.uiDefaults || {};
  if (defaults.areaM2 != null) els.area.value = defaults.areaM2;
  if (defaults.albedo != null) els.albedo.value = defaults.albedo;
  if (defaults.magLimit != null) els.magLimit.value = defaults.magLimit;
  if (defaults.minAltDeg != null) els.minAlt.value = defaults.minAltDeg;
  if (defaults.darkLimitDeg != null) els.darkLimit.value = defaults.darkLimitDeg;
}

async function loadDataset(datasetIndex = 0) {
  const dataset = datasets[datasetIndex] || datasets[0];
  els.dataStatus.textContent = 'Loading ephemeris…';
  els.dataStatus.className = 'status-pill';
  els.bestResults.textContent = 'Run the scan after loading a Horizons dataset.';
  bestCache = [];
  geoRangeZoom = 0;
  const path = dataset.path.replace(/^\.\//, '');
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  const data = await res.json();
  const objectVectors = data.object_eci_km || data.target_eci_km || data.clipper_eci_km;
  if (!Array.isArray(data.times) || !Array.isArray(objectVectors) || !Array.isArray(data.sun_eci_km)) {
    throw new Error(`${path} does not look like a supported flyby dataset.`);
  }
  eph = {
    dataset,
    meta: data.metadata || {},
    times: data.times,
    dates: data.times.map(t => new Date(t)),
    sc: objectVectors,
    sun: data.sun_eci_km,
  };
  eph.rangeSamples = eph.sc.map(norm);
  applyDatasetDefaults(data);
  els.timeSlider.max = eph.times.length - 1;
  idx = findClosestSample();
  els.timeSlider.value = idx;
  const isDemo = (eph.meta.source || '').includes('DEMO');
  els.dataStatus.textContent = isDemo ? 'Demo ephemeris · replace with Horizons' : `${targetName()} · ${eph.times.length} samples`;
  els.dataStatus.className = 'status-pill ' + (isDemo ? 'warn' : 'good');
  const ca = eph.meta.closestSampleUtc ? ` · closest sample ${eph.meta.closestSampleUtc.replace('T',' ').replace('Z',' UTC')}` : '';
  els.missionEyebrow.textContent = `${targetName()}${ca}`;
  els.datasetHint.textContent = dataset.description || `Loaded ${path}`;
  document.title = `${targetName()} Visibility Explorer`;
  els.provenance.innerHTML = provenanceHtml(eph.meta);
  render();
}

async function initData() {
  await loadDatasetManifest();
  const selectedId = new URLSearchParams(location.search).get('dataset');
  const initial = Math.max(0, datasets.findIndex(d => d.id === selectedId || d.path === selectedId));
  els.datasetSelect.value = String(initial);
  await loadDataset(initial);
}
function normalizeLon(lon) {
  return ((lon + 540) % 360) - 180;
}

function scanCandidateRecord(i, lat, lon, obsBase) {
  const ii = clamp(Math.round(i), 0, eph.times.length - 1);
  const clippedLat = clamp(lat, -89.5, 89.5);
  const wrappedLon = normalizeLon(lon);
  const obs = { ...obsBase, lat: clippedLat, lon: wrappedLon, height: 0 };
  const s = sampleAt(ii, obs);
  if (s.topo.alt < obs.minAlt || !s.dark || !s.ecl.sunlit) return null;
  return {
    idx: ii, lat: clippedLat, lon: wrappedLon,
    alt: s.topo.alt, az: s.topo.az, mag: s.mag, range: s.topo.rangeKm,
    sunAlt: s.sunTopo.alt, lit: s.ecl.state, visible: s.visible,
  };
}

function betterScanCandidate(a, b) {
  if (!a) return false;
  if (!b) return true;
  // Lower astronomical magnitude is brighter.  Treat magnitude as the actual
  // objective; min altitude, darkness, and illumination are hard filters.
  // Tie-breakers only decide essentially equivalent brightness cases.
  const dMag = a.mag - b.mag;
  if (Math.abs(dMag) > 0.02) return dMag < 0;
  const dAlt = a.alt - b.alt;
  if (Math.abs(dAlt) > 0.5) return dAlt > 0;
  const dSun = a.sunAlt - b.sunAlt;
  if (Math.abs(dSun) > 0.5) return dSun < 0;
  return a.range < b.range;
}

function scanWindowForBest(currentBest, obsBase, opts) {
  let best = currentBest;
  const i0 = opts.i0 ?? 0, i1 = opts.i1 ?? (eph.times.length - 1), iStep = Math.max(1, Math.round(opts.iStep ?? 1));
  const lat0 = opts.lat0 ?? -85, lat1 = opts.lat1 ?? 85, latStep = opts.latStep ?? 5;
  const lon0 = opts.lon0 ?? -180, lon1 = opts.lon1 ?? 180, lonStep = opts.lonStep ?? 5;
  for (let i = Math.max(0, Math.round(i0)); i <= Math.min(eph.times.length - 1, Math.round(i1)); i += iStep) {
    for (let lat = lat0; lat <= lat1 + 1e-9; lat += latStep) {
      for (let lon = lon0; lon <= lon1 + 1e-9; lon += lonStep) {
        const rec = scanCandidateRecord(i, lat, lon, obsBase);
        if (betterScanCandidate(rec, best)) best = rec;
      }
    }
  }
  return best;
}

function refineBestCandidate(coarseBest, obsBase, sampleSec, coarseStride) {
  let best = coarseBest;
  if (!best) return null;
  const oneMinute = Math.max(1, Math.round(60 / sampleSec));
  const passes = [
    { latSpan: 6, lonSpan: 6, latStep: 1, lonStep: 1, idxSpan: coarseStride, idxStep: oneMinute },
    { latSpan: 1.2, lonSpan: 1.2, latStep: 0.2, lonStep: 0.2, idxSpan: 5 * oneMinute, idxStep: 1 },
    { latSpan: 0.3, lonSpan: 0.3, latStep: 0.05, lonStep: 0.05, idxSpan: oneMinute, idxStep: 1 },
  ];
  for (const pass of passes) {
    best = scanWindowForBest(best, obsBase, {
      i0: best.idx - pass.idxSpan,
      i1: best.idx + pass.idxSpan,
      iStep: pass.idxStep,
      lat0: best.lat - pass.latSpan,
      lat1: best.lat + pass.latSpan,
      latStep: pass.latStep,
      lon0: best.lon - pass.lonSpan,
      lon1: best.lon + pass.lonSpan,
      lonStep: pass.lonStep,
    });
  }
  return best;
}

function scanBestLocations() {
  if (!eph) return;
  els.bestResults.textContent = 'Scanning coarse grid…';
  setTimeout(() => {
    const obsBase = getObserver();
    const sampleSec = Math.max(1, (eph.dates[1] - eph.dates[0]) / 1000 || 60);
    const coarseStride = Math.max(1, Math.round((5*60) / sampleSec));

    let best = scanWindowForBest(null, obsBase, {
      i0: 0, i1: eph.times.length - 1, iStep: coarseStride,
      lat0: -85, lat1: 85, latStep: 5,
      lon0: -180, lon1: 175, lonStep: 5,
    });

    if (!best) {
      bestCache = [];
      els.bestResults.innerHTML = 'No global candidates met the current minimum altitude, darkness, and target-illumination thresholds. Try lowering the minimum altitude or using a less strict dark limit.';
      return;
    }

    els.bestResults.textContent = 'Refining around the best coarse-grid point…';
    best = refineBestCandidate(best, obsBase, sampleSec, coarseStride);
    bestCache = best ? [best] : [];

    if (!best) {
      els.bestResults.innerHTML = 'No refined candidate survived the current thresholds.';
      return;
    }

    const date = fmt.format(eph.dates[best.idx]).replace(' UTC','');
    const lonText = `${best.lon.toFixed(2)}°E`;
    const limitNote = best.visible
      ? `brighter than current limiting mag ${obsBase.magLimit.toFixed(1)}`
      : `fainter than current limiting mag ${obsBase.magLimit.toFixed(1)}`;
    const stepText = sampleSec < 60 ? `${sampleSec.toFixed(0)} s` : `${(sampleSec/60).toFixed(1)} min`;
    els.bestResults.innerHTML = `
      <div class="muted small">Single global optimum from a 5° / 5-minute coarse scan, then local refinement to about 0.05° and the native ${stepText} ephemeris cadence. Constraints: altitude ≥ ${obsBase.minAlt.toFixed(0)}°, Sun altitude ≤ ${obsBase.darkLimit.toFixed(1)}°, target sunlit.</div>
      <div class="best-row">
        <div class="best-rank">★</div>
        <div><strong>${date} UTC</strong><br>lat ${best.lat.toFixed(2)}°, lon ${lonText} · alt ${best.alt.toFixed(1)}°, az ${best.az.toFixed(0)}° · Sun ${best.sunAlt.toFixed(1)}° · ${best.lit}<br><span class="muted small">${limitNote}</span></div>
        <div>mag ${best.mag.toFixed(2)}<br>${Math.round(best.range).toLocaleString()} km</div>
      </div>`;
  }, 25);
}

function yawPitchForDirection(dir) {
  // Camera position direction in inertial coordinates. The orbit camera then builds
  // a stable right/up/forward basis around this direction.
  const d = unit(dir);
  return {
    yaw: Math.atan2(d[1], d[0]),
    pitch: Math.asin(clamp(d[2], -1, 1)),
  };
}

function wireEvents() {
  document.querySelectorAll('[data-place]').forEach(b => b.addEventListener('click', () => setPlace(PLACES[b.dataset.place])));
  els.datasetSelect.addEventListener('change', () => loadDataset(parseInt(els.datasetSelect.value, 10)).catch(err => {
    console.error(err);
    els.dataStatus.textContent = 'Could not load ephemeris';
    els.dataStatus.className = 'status-pill warn';
    els.provenance.innerHTML = `<div class="warning-box">${safeHtml(err.message)}</div>`;
  }));
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
  if (els.geoPresetEyes) { els.geoPresetEyes.textContent = 'Perspective'; els.geoPresetEyes.title = 'Oblique perspective view'; }
  if (els.geoPresetSun) { els.geoPresetSun.textContent = 'From Sun'; els.geoPresetSun.title = 'Look from the Sun toward Earth'; }
  if (els.geoPresetNorth) { els.geoPresetNorth.textContent = 'North Pole'; els.geoPresetNorth.title = "Look down Earth's north-pole axis"; }
  els.geoPresetEyes?.addEventListener('click', () => { geoViewPreset = 'perspective'; geoRot = { yaw: -0.9, pitch: 0.45 }; drawGeometry(); });
  els.geoPresetSun?.addEventListener('click', () => { geoViewPreset = 'sun'; drawGeometry(); });
  els.geoPresetNorth?.addEventListener('click', () => { geoViewPreset = 'north'; drawGeometry(); });
  els.geo.style.touchAction = 'none';
  els.geo.style.cursor = 'grab';

  function pointerDistance() {
    const pts = [...geoPointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }
  function finishGeoPointer(e) {
    geoPointers.delete(e.pointerId);
    if (geoPointers.size >= 2) {
      geoPinch = { distance: pointerDistance(), zoom: geoRangeZoom };
      dragging = false;
      lastDrag = null;
    } else if (geoPointers.size === 1) {
      const remaining = [...geoPointers.values()][0];
      geoPinch = null;
      dragging = true;
      lastDrag = [remaining.x, remaining.y];
    } else {
      geoPinch = null;
      dragging = false;
      lastDrag = null;
      els.geo.style.cursor = 'grab';
    }
  }
  els.geo.addEventListener('pointerdown', e => {
    geoPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    els.geo.setPointerCapture(e.pointerId);
    if (geoPointers.size >= 2) {
      geoPinch = { distance: pointerDistance(), zoom: geoRangeZoom };
      dragging = false;
      lastDrag = null;
      els.geo.style.cursor = 'grabbing';
    } else {
      geoViewPreset = 'custom';
      dragging = true;
      lastDrag = [e.clientX, e.clientY];
      els.geo.style.cursor = 'grabbing';
    }
  });
  els.geo.addEventListener('pointermove', e => {
    if (!geoPointers.has(e.pointerId)) return;
    geoPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (geoPointers.size >= 2 && geoPinch) {
      const d = pointerDistance();
      if (d > 0 && geoPinch.distance > 0) {
        // Pinching inward reveals more of the pass; spreading returns toward true scale.
        geoRangeZoom = clamp(geoPinch.zoom - Math.log(d / geoPinch.distance) * 0.72, 0, 1);
        drawGeometry();
      }
      return;
    }
    if (!dragging || !lastDrag) return;
    const dx = e.clientX - lastDrag[0], dy = e.clientY - lastDrag[1];
    lastDrag = [e.clientX, e.clientY];
    geoViewPreset = 'custom';
    geoRot.yaw += dx * 0.007;
    geoRot.pitch = clamp(geoRot.pitch - dy * 0.007, -Math.PI/2 + 0.01, Math.PI/2 - 0.01);
    drawGeometry();
  });
  els.geo.addEventListener('pointerup', finishGeoPointer);
  els.geo.addEventListener('pointercancel', finishGeoPointer);
  els.geo.addEventListener('lostpointercapture', finishGeoPointer);
  els.geo.addEventListener('wheel', e => {
    e.preventDefault();
    // Scroll down = show more distant trajectory; scroll up = return toward metric scale.
    const delta = clamp(e.deltaY, -120, 120);
    geoRangeZoom = clamp(geoRangeZoom + delta * 0.0016, 0, 1);
    drawGeometry();
  }, { passive: false });
  els.geo.addEventListener('dblclick', () => {
    geoViewPreset = 'perspective';
    geoRot = { yaw: -0.9, pitch: 0.45 };
    geoRangeZoom = 0;
    drawGeometry();
  });
  window.addEventListener('resize', render);
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => render());
    ro.observe(els.sky);
    ro.observe(els.geo);
  }
}
function startPlay() {
  const rate = parseInt(els.speed.value, 10);
  els.playPause.textContent = 'Pause';
  playTimer = setInterval(() => { idx = (idx + 1) % eph.times.length; render(); }, 1000 / rate);
}
function stopPlay() { clearInterval(playTimer); playTimer = null; els.playPause.textContent = 'Play'; }

wireEvents();
initData().catch(err => {
  console.error(err);
  els.dataStatus.textContent = 'Could not load ephemeris';
  els.dataStatus.className = 'status-pill warn';
  els.provenance.innerHTML = `<div class="warning-box">${err.message}</div>`;
});
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js').catch(() => {}));
}
