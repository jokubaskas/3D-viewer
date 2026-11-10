// Skrydžio planavimas fotogrametrijai: kameros modelis, GSD ↔ aukštis, „gyvatėlės“ maršrutas virš srities,
// statistika (nuotraukos, trukmė, akumuliatoriai) ir eksportas (KML, DJI WPML KMZ, GeoJSON).
// Visi skaičiavimai – vietinėje plokščioje projekcijoje (metrais) aplink srities centrą.
import { localProjection } from '../odm/preview.js';

const D2R = Math.PI / 180;

/**
 * Kameros: 35 mm ekvivalentinis židinys ir kadro dydis (px). GSD skaičiuojamas taip pat, kaip nuotraukų peržiūroje:
 * įstrižainės matymo laukas pagal 35 mm (43,27 mm įstrižainė), 16:9 kadras laikomas apkirptu 4:3.
 */
export const CAMERAS = {
  raptorT48: { label: 'Anzu Raptor T / DJI Mavic 3T – plati kamera 48 MP', f35: 24, width: 8000, height: 6000, interval: 2, drone: [77, 1], payload: 67 },
  raptorT12: { label: 'Anzu Raptor T / DJI Mavic 3T – plati kamera 12 MP', f35: 24, width: 4000, height: 3000, interval: 1, drone: [77, 1], payload: 67 },
  m3e: { label: 'DJI Mavic 3E (20 MP, 4/3")', f35: 24, width: 5280, height: 3956, interval: 0.7, drone: [77, 0], payload: 66 },
  m4e: { label: 'DJI Matrice 4E (20 MP, 4/3")', f35: 24, width: 5280, height: 3956, interval: 0.5 },
  p4r: { label: 'DJI Phantom 4 RTK (20 MP, 1")', f35: 24, width: 5472, height: 3648, interval: 2 },
  m30t: { label: 'DJI M30T – plati kamera 48 MP', f35: 24, width: 8000, height: 6000, interval: 2, drone: [67, 1], payload: 53 },
  custom: { label: 'Kita (nurodyti)', f35: 24, width: 4000, height: 3000, interval: 2 },
};

/** Žemės pėdsakas metrais vienam aukščio metrui: plotis (kadro ilgoji kraštinė) ir aukštis. */
function footPerMeter(cam) {
  const w = cam.width, h = cam.height;
  const hEff = Math.max(h, (w * 3) / 4);
  const diag = 43.27 / cam.f35; // žemės įstrižainė / aukštis
  const k = diag / Math.hypot(w, hEff);
  return { gsd: k, w: k * w, h: k * h }; // gsd – m/px vienam aukščio metrui
}

export const gsdAt = (cam, alt) => footPerMeter(cam).gsd * alt; // m/px
export const altForGsd = (cam, gsd) => gsd / footPerMeter(cam).gsd; // m

// ------------------------------------------------------------------ geometrija
const rot = ([x, y], a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];

export function polygonArea(P) {
  let s = 0;
  for (let i = 0; i < P.length; i++) {
    const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % P.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function convexHull(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p[i]) <= 0) up.pop();
    up.push(p[i]);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/**
 * Kryptis (laipsniais nuo šiaurės pagal laikrodžio rodyklę), kuria skrendant reikia mažiausiai linijų –
 * linijos lygiagrečios ilgiausiai srities „pusei“ (mažiausias plotis statmenai skrydžiui).
 */
export function bestHeading(P) {
  const hull = convexHull(P);
  let best = 0, bestW = Infinity;
  for (let deg = 0; deg < 180; deg += 1) {
    // skrydžio kryptis deg (nuo šiaurės) → linijos išilgai šios krypties; plotis – statmenai
    const a = deg * D2R;
    const nx = Math.cos(a), ny = -Math.sin(a); // statmuo krypčiai (sin a, cos a)
    let lo = Infinity, hi = -Infinity;
    for (const [x, y] of hull) {
      const d = x * nx + y * ny;
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    if (hi - lo < bestW - 1e-6) {
      bestW = hi - lo;
      best = deg;
    }
  }
  return best;
}

/** Horizontali linija y kerta daugiakampį: grąžina x susikirtimus. */
function scan(P, y) {
  const xs = [];
  for (let i = 0; i < P.length; i++) {
    const [x1, y1] = P[i], [x2, y2] = P[(i + 1) % P.length];
    if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
  }
  return xs;
}

/**
 * „Gyvatėlės“ maršrutas: linijos kas `spacing` m kryptimi `heading`, pratęstos `overshoot` m už srities.
 * @returns {[number,number][][]} linijos (kiekviena – [pradžia, pabaiga]) vietinėmis koordinatėmis (E, N)
 */
export function serpentine(P, heading, spacing, overshoot = 0) {
  // Pasukame taip, kad skrydžio kryptis taptų x ašimi: kryptis nuo šiaurės → kampas nuo x ašies = 90° − heading
  const a = (90 - heading) * D2R;
  const R = P.map((p) => rot(p, -a));
  let ymin = Infinity, ymax = -Infinity;
  for (const [, y] of R) {
    ymin = Math.min(ymin, y);
    ymax = Math.max(ymax, y);
  }
  const span = ymax - ymin;
  const n = Math.max(1, Math.ceil(span / spacing - 1e-9) + 1);
  const y0 = ymin + (span - (n - 1) * spacing) / 2; // centruota: kraštinės linijos ties sritimi ar šiek tiek už jos
  const lines = [];
  for (let i = 0; i < n; i++) {
    const y = y0 + i * spacing;
    // Linija kerta daugiakampį – imame ir kaimyninių (±spacing/2) susikirtimų ribas, kad kraštai būtų padengti
    const xs = [...scan(R, Math.min(Math.max(y, ymin + 1e-6), ymax - 1e-6)), ...scan(R, Math.max(y - spacing / 2, ymin + 1e-6)), ...scan(R, Math.min(y + spacing / 2, ymax - 1e-6))];
    if (!xs.length) continue;
    let x1 = Math.min(...xs) - overshoot, x2 = Math.max(...xs) + overshoot;
    if (lines.length % 2) [x1, x2] = [x2, x1];
    lines.push([rot([x1, y], a), rot([x2, y], a)]);
  }
  return lines;
}

/** Kryptis (° nuo šiaurės, −180…180) iš taško a į b (vietinės E, N koordinatės). */
const bearing = (a, b) => {
  const d = Math.atan2(b[0] - a[0], b[1] - a[1]) / D2R;
  return d > 180 ? d - 360 : d <= -180 ? d + 360 : d;
};
const norm180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

export const MISSIONS = {
  grid: 'Tinklelis (kamera žemyn)',
  oblique: '5 krypčių: žemyn + 4 įstrižai',
  orbit: 'Orbita aplink pastatą',
};

/**
 * Visas skrydžio planas.
 * @param {[number,number][]} polyLL – sritis [lon, lat] (orbitai – pastato kontūras)
 * @param {{camera:object, alt:number, front:number, side:number, heading:number|null, crosshatch:boolean,
 *   speed:number|null, maxSpeed:number, interval:number, battery:number, home?:[number,number]|null,
 *   mission?:'grid'|'oblique'|'orbit', pitch?:number, buildingHeight?:number, rings?:number, radius?:number|null}} s
 * @returns plano skaičiai ir `waypoints` – taškai su aukščiu, kryptimi, kameros kampu ir fotografavimu (DJI KMZ)
 */
export function computePlan(polyLL, s) {
  const cLat = polyLL.reduce((t, p) => t + p[1], 0) / polyLL.length;
  const cLon = polyLL.reduce((t, p) => t + p[0], 0) / polyLL.length;
  const proj = localProjection(cLat, cLon);
  const P = polyLL.map(([lon, lat]) => proj.toEN(lon, lat));
  const toLL = (p) => proj.toLonLat(p[0], p[1]);
  const home = s.home ? proj.toEN(s.home[0], s.home[1]) : null;
  const mission = s.mission || 'grid';
  if (mission === 'orbit') return orbitPlan(P, s, toLL, home);

  const fpm = footPerMeter(s.camera);
  const footW = fpm.w * s.alt, footH = fpm.h * s.alt; // kadro ilgoji kraštinė – skersai skrydžio
  const spacing = footW * (1 - s.side / 100);
  const photoStep = footH * (1 - s.front / 100);
  const heading = s.heading == null ? bestHeading(P) : ((s.heading % 180) + 180) % 180;
  const interval = Math.max(s.interval, 0.3);
  const passSpeed = (step) => Math.min(s.speed || step / interval, s.maxSpeed, step / interval);
  // Pratęsimas už srities: pusė kadro – kad kraštas būtų nufotografuotas su tuo pačiu persidengimu
  /** @type {{lines:[number,number][][], step:number, speed:number, pitch:number, yaw:number|null, label:string}[]} */
  const passes = [{ lines: serpentine(P, heading, spacing, footH / 2), step: photoStep, speed: passSpeed(photoStep), pitch: -90, yaw: null, label: 'žemyn' }];
  if (mission === 'grid' && s.crosshatch) passes.push({ ...passes[0], lines: serpentine(P, (heading + 90) % 180, spacing, footH / 2) });
  let oblique = null;
  if (mission === 'oblique') {
    // Įstrižai praskridimai: kamera pakreipta `pitch` ° nuo horizonto ir nukreipta į š., r., p., v. Dronas skrenda
    // statmenai žiūrėjimo krypčiai (kadro ilgoji kraštinė – išilgai skrydžio) ir yra atitrauktas per alt / tan(pitch),
    // kad kadro centras būtų virš srities. Drono kryptis fiksuota – kamera visą praskridimą žiūri į tą pačią pusę.
    const p = Math.min(Math.max(s.pitch || 45, 20), 70) * D2R;
    const slant = s.alt / Math.sin(p);
    const offset = s.alt / Math.tan(p);
    const wO = fpm.w * slant; // kadro plotis ties vaizdo centru
    const dO = (fpm.h * slant) / Math.sin(p); // kadro gylis žemėje (apytiksliai)
    const stepO = wO * (1 - s.front / 100);
    const spacingO = dO * (1 - s.side / 100);
    oblique = { pitch: -p / D2R, offset, gsd: fpm.gsd * slant, step: stepO, spacing: spacingO };
    for (const [az, label] of [[0, 'į šiaurę'], [90, 'į rytus'], [180, 'į pietus'], [270, 'į vakarus']]) {
      const dir = [Math.sin(az * D2R), Math.cos(az * D2R)];
      const lines = serpentine(P, (az + 90) % 180, spacingO, wO / 2).map((ln) => ln.map(([x, y]) => [x - dir[0] * offset, y - dir[1] * offset]));
      passes.push({ lines, step: stepO, speed: passSpeed(stepO), pitch: -p / D2R, yaw: norm180(az), label });
    }
  }

  // Taškai, nuotraukos, ilgis ir trukmė
  const waypoints = [];
  const photos = [];
  let length = 0, time = 0, prev = null;
  for (const ps of passes) {
    for (const [a, b] of ps.lines) {
      if (prev) {
        const d = Math.hypot(a[0] - prev[0], a[1] - prev[1]);
        length += d;
        time += d / Math.max(ps.speed, 5) + 6; // posūkis / perėjimas
      }
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      length += L;
      time += L / ps.speed;
      waypoints.push({ p: a, alt: s.alt, yaw: ps.yaw, pitch: ps.pitch, speed: ps.speed, photo: 'distance', step: ps.step });
      waypoints.push({ p: b, alt: s.alt, yaw: ps.yaw, pitch: ps.pitch, speed: ps.speed, photo: null });
      const k = Math.max(1, Math.round(L / ps.step));
      for (let i = 0; i <= k; i++) photos.push([a[0] + ((b[0] - a[0]) * i) / k, a[1] + ((b[1] - a[1]) * i) / k]);
      prev = b;
    }
  }
  const route = waypoints.map((w) => w.p);
  let transit = 0;
  if (home && route.length) transit = Math.hypot(route[0][0] - home[0], route[0][1] - home[1]) + Math.hypot(route[route.length - 1][0] - home[0], route[route.length - 1][1] - home[1]);
  const speed = passes[0].speed;
  time += transit / Math.max(speed, 10) + (s.alt / 5) * 2 + 30; // kilimas ~5 m/s ir nusileidimas
  return {
    mission,
    heading,
    gsd: fpm.gsd * s.alt,
    footW,
    footH,
    spacing,
    photoStep,
    speed,
    speedLimitedByCamera: photoStep / interval < (s.speed || s.maxSpeed),
    lines: passes.reduce((t, ps) => t + ps.lines.length, 0),
    passes: passes.length,
    oblique,
    photos: photos.length,
    length,
    transit,
    time,
    batteries: Math.ceil(time / 60 / Math.max(s.battery, 5)),
    area: polygonArea(P),
    routeLL: route.map(toLL),
    routeAlt: waypoints.map((w) => w.alt),
    photosLL: photos.map(toLL),
    passesLL: passes.map((ps) => ps.lines.map(([a, b]) => [toLL(a), toLL(b)])),
    passLabels: passes.map((ps) => ps.label),
    waypoints: waypoints.map((w) => ({ ...w, ll: toLL(w.p) })),
  };
}

/**
 * Orbita: ratai aplink pastatą (pažymėtą kontūrą) skirtinguose aukščiuose. Kamera kiekviename taške nukreipta į pastato
 * vidurį (aukštyje H/2), nuotrauka kiekviename taške (dronas sustoja – ryškios nuotraukos). Nuotraukų skaičius rate – pagal
 * persidengimą artimiausioje pastato sienoje.
 */
function orbitPlan(P, s, toLL, home) {
  const fpm = footPerMeter(s.camera);
  const c = [P.reduce((t, p) => t + p[0], 0) / P.length, P.reduce((t, p) => t + p[1], 0) / P.length];
  const rb = Math.max(...P.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
  const H = Math.max(3, s.buildingHeight || 30);
  const standoff = Math.max(15, 0.8 * H);
  const R = Math.max(rb + 8, s.radius || rb + standoff);
  const n = Math.min(Math.max(Math.round(s.rings || 2), 1), 3);
  const hi = Math.round(H + Math.max(10, 0.25 * H));
  const lo = Math.round(Math.max(H * 0.5, 15));
  const alts = n === 1 ? [Math.round((hi + H) / 2)] : Array.from({ length: n }, (_, i) => Math.round(hi - ((hi - lo) * i) / (n - 1)));
  const target = H / 2;
  const speed = Math.min(s.maxSpeed, 5);
  const rings = [];
  const waypoints = [];
  let time = 0, photos = 0;
  for (const alt of alts) {
    const pitch = -Math.atan2(alt - target, R) / D2R;
    const near = Math.hypot(R - rb, alt - target); // atstumas iki artimiausios sienos
    const step = fpm.w * near * (1 - s.front / 100);
    const count = Math.min(72, Math.max(12, Math.ceil((2 * Math.PI * R) / Math.max(step, 0.5))));
    for (let k = 0; k < count; k++) {
      const a = (2 * Math.PI * k) / count; // nuo šiaurės pagal laikrodžio rodyklę
      const p = [c[0] + R * Math.sin(a), c[1] + R * Math.cos(a)];
      waypoints.push({ p, alt, yaw: bearing(p, c), pitch, speed, photo: 'point' });
    }
    rings.push({ alt, pitch, count, gsd: fpm.gsd * near });
    photos += count;
    time += (2 * Math.PI * R) / speed + count * 2.5; // sustojimas nuotraukai
  }
  let transit = 0;
  if (home && waypoints.length) transit = Math.hypot(waypoints[0].p[0] - home[0], waypoints[0].p[1] - home[1]) * 2;
  time += transit / 8 + (alts[0] / 5) * 2 + 30 + (alts.length - 1) * 15;
  // Ratai + perėjimai tarp jų (aukščio keitimas)
  const length = alts.length * 2 * Math.PI * R + alts.slice(1).reduce((t, a, i) => t + Math.abs(a - alts[i]), 0);
  const ringSegs = rings.map((r) => {
    const pts = waypoints.filter((w) => w.alt === r.alt).map((w) => w.p);
    return pts.map((p, k) => [toLL(p), toLL(pts[(k + 1) % pts.length])]);
  });
  return {
    mission: 'orbit',
    heading: 0,
    gsd: Math.min(...rings.map((r) => r.gsd)),
    footW: 0,
    footH: 0,
    spacing: 0,
    photoStep: (2 * Math.PI * R) / rings[0].count,
    speed,
    speedLimitedByCamera: false,
    lines: rings.length,
    passes: rings.length,
    orbit: { center: toLL(c), radius: R, buildingRadius: rb, buildingHeight: H, rings },
    photos,
    length,
    transit,
    time,
    batteries: Math.ceil(time / 60 / Math.max(s.battery, 5)),
    area: polygonArea(P),
    routeLL: waypoints.map((w) => toLL(w.p)),
    routeAlt: waypoints.map((w) => w.alt),
    photosLL: waypoints.map((w) => toLL(w.p)),
    passesLL: ringSegs,
    passLabels: rings.map((r) => `${r.alt} m`),
    waypoints: waypoints.map((w) => ({ ...w, ll: toLL(w.p) })),
  };
}

// ------------------------------------------------------------------ eksportas
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ll = ([lon, lat], h) => `${lon.toFixed(8)},${lat.toFixed(8)}${h != null ? `,${h}` : ''}`;

/** KML: sritis ir maršrutas (aukštis – santykinis nuo žemės / pakilimo vietos). Tinka importuoti į daugumą pultų programų. */
export function toKML(name, polyLL, plan, alt) {
  const ring = [...polyLL, polyLL[0]].map((p) => ll(p, 0)).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${esc(name)}</name>
  <Style id="area"><LineStyle><color>ff00e5ff</color><width>2</width></LineStyle><PolyStyle><color>2200e5ff</color></PolyStyle></Style>
  <Style id="route"><LineStyle><color>ff43c43c</color><width>2</width></LineStyle></Style>
  <Placemark>
    <name>${esc(name)} – sritis</name>
    <styleUrl>#area</styleUrl>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
  <Placemark>
    <name>${esc(name)} – maršrutas (${plan.mission === 'orbit' ? plan.orbit.rings.map((x) => x.alt).join(' / ') : alt} m, GSD ${(plan.gsd * 100).toFixed(2)} cm)</name>
    <styleUrl>#route</styleUrl>
    <LineString><altitudeMode>relativeToGround</altitudeMode><coordinates>${plan.routeLL.map((p, i) => ll(p, plan.routeAlt?.[i] ?? alt)).join(' ')}</coordinates></LineString>
  </Placemark>
</Document>
</kml>
`;
}

/** GeoJSON: sritis, maršrutas ir nuotraukų vietos. */
export function toGeoJSON(name, polyLL, plan, settings) {
  const props = { name, mission: plan.mission || 'grid', altitude: settings.alt, gsd_cm: +(plan.gsd * 100).toFixed(2), front: settings.front, side: settings.side, heading: plan.heading, speed: +plan.speed.toFixed(1) };
  if (plan.oblique) props.oblique_pitch = +plan.oblique.pitch.toFixed(1);
  if (plan.orbit) Object.assign(props, { orbit_radius: +plan.orbit.radius.toFixed(1), building_height: plan.orbit.buildingHeight, rings: plan.orbit.rings.map((x) => ({ altitude: x.alt, pitch: +x.pitch.toFixed(1), photos: x.count })) });
  return JSON.stringify(
    {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { ...props, kind: 'area' }, geometry: { type: 'Polygon', coordinates: [[...polyLL, polyLL[0]]] } },
        { type: 'Feature', properties: { ...props, kind: 'route' }, geometry: { type: 'LineString', coordinates: plan.routeLL } },
        { type: 'Feature', properties: { kind: 'photos' }, geometry: { type: 'MultiPoint', coordinates: plan.photosLL } },
      ],
    },
    null,
    1,
  );
}

/**
 * DJI WPML (KMZ: wpmz/template.kml + wpmz/waylines.wpml) – maršruto taškų misija. Kiekviename taške: aukštis, greitis,
 * drono kryptis (fiksuota – įstrižiems praskridimams ir orbitai; kitaip – pagal maršrutą), kameros kampas ir
 * fotografavimas: kas N m iki kito taško (linijos) arba ties tašku (orbita, dronas sustoja).
 * Formatas – DJI Pilot 2 / FlightHub 2 (WPML 1.0.2). Aukštis – nuo pakilimo vietos.
 */
export function toWPML(name, plan, s) {
  const now = Date.now();
  const cam = s.camera;
  const [droneEnum, droneSub] = cam.drone || [77, 1];
  const payloadEnum = cam.payload ?? 67;
  const speed = +plan.speed.toFixed(1);
  const wps = plan.waypoints;
  const maxAlt = Math.max(...wps.map((w) => w.alt));
  const suffix = esc(name.replace(/[^\w-]+/g, '_').slice(0, 20));
  const head = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.2">
  <Document>`;
  const missionConfig = `
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
      <wpml:takeOffSecurityHeight>${Math.min(30, maxAlt)}</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>${Math.max(speed, 8)}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo><wpml:droneEnumValue>${droneEnum}</wpml:droneEnumValue><wpml:droneSubEnumValue>${droneSub}</wpml:droneSubEnumValue></wpml:droneInfo>
      <wpml:payloadInfo><wpml:payloadEnumValue>${payloadEnum}</wpml:payloadEnumValue><wpml:payloadSubEnumValue>0</wpml:payloadSubEnumValue><wpml:payloadPositionIndex>0</wpml:payloadPositionIndex></wpml:payloadInfo>
    </wpml:missionConfig>`;
  let actionId = 0;
  const gimbal = (pitch) => `
          <wpml:action>
            <wpml:actionId>${actionId++}</wpml:actionId>
            <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:gimbalHeadingYawBase>north</wpml:gimbalHeadingYawBase>
              <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>
              <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>
              <wpml:gimbalPitchRotateAngle>${Math.round(pitch * 10) / 10}</wpml:gimbalPitchRotateAngle>
              <wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable>
              <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
              <wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable>
              <wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>
              <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>
              <wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
  const photo = () => `
          <wpml:action>
            <wpml:actionId>${actionId++}</wpml:actionId>
            <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:fileSuffix>${suffix}</wpml:fileSuffix>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>`;
  const group = (id, from, to, trigger, body) => `
        <wpml:actionGroup>
          <wpml:actionGroupId>${id}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>${from}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${to}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
          <wpml:actionTrigger>${trigger}</wpml:actionTrigger>${body}
        </wpml:actionGroup>`;
  const headingParam = (w) =>
    w.yaw == null
      ? '<wpml:waypointHeadingParam><wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode></wpml:waypointHeadingParam>'
      : `<wpml:waypointHeadingParam><wpml:waypointHeadingMode>smoothTransition</wpml:waypointHeadingMode><wpml:waypointHeadingAngle>${Math.round(w.yaw * 10) / 10}</wpml:waypointHeadingAngle><wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint><wpml:waypointHeadingAngleEnable>1</wpml:waypointHeadingAngleEnable><wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode></wpml:waypointHeadingParam>`;
  const placemarks = (forExecute) => {
    actionId = 0;
    let groupId = 0;
    return wps
      .map((w, i) => {
        let actions = '';
        if (w.photo === 'distance') {
          // Linijos pradžia: kamera į kampą, tada nuotrauka kas `step` m iki kito taško
          actions = group(groupId++, i, i, '<wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>', gimbal(w.pitch)) +
            group(groupId++, i, i + 1, `
            <wpml:actionTriggerType>multipleDistance</wpml:actionTriggerType>
            <wpml:actionTriggerParam>${w.step.toFixed(2)}</wpml:actionTriggerParam>
          `, photo());
        } else if (w.photo === 'point') {
          actions = group(groupId++, i, i, '<wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>', gimbal(w.pitch) + photo());
        }
        const v = +w.speed.toFixed(1);
        const body = forExecute
          ? `<wpml:executeHeight>${w.alt}</wpml:executeHeight><wpml:waypointSpeed>${v}</wpml:waypointSpeed>${headingParam(w)}<wpml:waypointTurnParam><wpml:waypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:waypointTurnMode><wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist></wpml:waypointTurnParam><wpml:useStraightLine>1</wpml:useStraightLine>`
          : `<wpml:height>${w.alt}</wpml:height><wpml:ellipsoidHeight>${w.alt}</wpml:ellipsoidHeight><wpml:useGlobalHeight>0</wpml:useGlobalHeight><wpml:waypointSpeed>${v}</wpml:waypointSpeed><wpml:useGlobalSpeed>0</wpml:useGlobalSpeed>${w.yaw == null ? '<wpml:useGlobalHeadingParam>1</wpml:useGlobalHeadingParam>' : `<wpml:useGlobalHeadingParam>0</wpml:useGlobalHeadingParam>${headingParam(w)}`}<wpml:useGlobalTurnParam>1</wpml:useGlobalTurnParam><wpml:useStraightLine>1</wpml:useStraightLine>`;
        return `
      <Placemark>
        <Point><coordinates>${ll(w.ll)}</coordinates></Point>
        <wpml:index>${i}</wpml:index>
        ${body}${actions}
      </Placemark>`;
      })
      .join('');
  };
  const template = `${head}
    <wpml:author>Atea 3D Matuoklis</wpml:author>
    <wpml:createTime>${now}</wpml:createTime>
    <wpml:updateTime>${now}</wpml:updateTime>${missionConfig}
    <Folder>
      <wpml:templateType>waypoint</wpml:templateType>
      <wpml:templateId>0</wpml:templateId>
      <wpml:waylineCoordinateSysParam><wpml:coordinateMode>WGS84</wpml:coordinateMode><wpml:heightMode>relativeToStartPoint</wpml:heightMode></wpml:waylineCoordinateSysParam>
      <wpml:autoFlightSpeed>${speed}</wpml:autoFlightSpeed>
      <wpml:globalHeight>${wps[0]?.alt ?? s.alt}</wpml:globalHeight>
      <wpml:caliFlightEnable>0</wpml:caliFlightEnable>
      <wpml:gimbalPitchMode>usePointSetting</wpml:gimbalPitchMode>
      <wpml:globalWaypointHeadingParam><wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode><wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle><wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint><wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode></wpml:globalWaypointHeadingParam>
      <wpml:globalWaypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:globalWaypointTurnMode>
      <wpml:globalUseStraightLine>1</wpml:globalUseStraightLine>${placemarks(false)}
    </Folder>
  </Document>
</kml>
`;
  const waylines = `${head}${missionConfig}
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:distance>${plan.length.toFixed(1)}</wpml:distance>
      <wpml:duration>${Math.round(plan.time)}</wpml:duration>
      <wpml:autoFlightSpeed>${speed}</wpml:autoFlightSpeed>${placemarks(true)}
    </Folder>
  </Document>
</kml>
`;
  return { 'wpmz/template.kml': template, 'wpmz/waylines.wpml': waylines };
}

/** Sritis iš KML ar GeoJSON failo teksto: pirmas rastas daugiakampis → [[lon, lat], …]. */
export function parseArea(text) {
  const s = String(text).trim();
  if (s.startsWith('{')) {
    const j = JSON.parse(s);
    const geoms = [];
    const walk = (o) => {
      if (!o) return;
      if (o.type === 'FeatureCollection') o.features.forEach(walk);
      else if (o.type === 'Feature') walk(o.geometry);
      else if (o.type === 'GeometryCollection') o.geometries.forEach(walk);
      else geoms.push(o);
    };
    walk(j);
    for (const g of geoms) {
      if (g.type === 'Polygon') return g.coordinates[0].slice(0, -1).map(([x, y]) => [x, y]);
      if (g.type === 'MultiPolygon') return g.coordinates[0][0].slice(0, -1).map(([x, y]) => [x, y]);
    }
    throw new Error('GeoJSON faile nerasta daugiakampio');
  }
  const m = s.match(/<Polygon[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i) || s.match(/<LinearRing[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i);
  if (!m) throw new Error('KML faile nerasta daugiakampio');
  const pts = m[1].trim().split(/\s+/).map((t) => t.split(',').map(Number)).filter((p) => isFinite(p[0]) && isFinite(p[1])).map(([x, y]) => [x, y]);
  if (pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 3) throw new Error('Per mažai taškų srityje');
  return pts;
}
