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

/**
 * Visas skrydžio planas.
 * @param {[number,number][]} polyLL – sritis [lon, lat]
 * @param {{camera:object, alt:number, front:number, side:number, heading:number|null, crosshatch:boolean,
 *   speed:number|null, maxSpeed:number, interval:number, battery:number, home?:[number,number]|null}} s
 */
export function computePlan(polyLL, s) {
  const cLat = polyLL.reduce((t, p) => t + p[1], 0) / polyLL.length;
  const cLon = polyLL.reduce((t, p) => t + p[0], 0) / polyLL.length;
  const proj = localProjection(cLat, cLon);
  const P = polyLL.map(([lon, lat]) => proj.toEN(lon, lat));
  const fpm = footPerMeter(s.camera);
  const footW = fpm.w * s.alt, footH = fpm.h * s.alt; // kadro ilgoji kraštinė – skersai skrydžio
  const spacing = footW * (1 - s.side / 100);
  const photoStep = footH * (1 - s.front / 100);
  const heading = s.heading == null ? bestHeading(P) : ((s.heading % 180) + 180) % 180;
  // Pratęsimas už srities: pusė kadro – kad kraštas būtų nufotografuotas su tuo pačiu persidengimu
  const overshoot = footH / 2;
  const passes = [serpentine(P, heading, spacing, overshoot)];
  if (s.crosshatch) passes.push(serpentine(P, (heading + 90) % 180, spacing, overshoot));

  // Maršrutas (taškai iš eilės) ir nuotraukų vietos
  const route = [];
  const photos = [];
  let length = 0, turns = 0;
  for (const lines of passes) {
    for (const [a, b] of lines) {
      if (route.length) {
        length += Math.hypot(a[0] - route[route.length - 1][0], a[1] - route[route.length - 1][1]);
        turns++;
      }
      route.push(a, b);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      length += L;
      const k = Math.max(1, Math.round(L / photoStep));
      for (let i = 0; i <= k; i++) photos.push([a[0] + ((b[0] - a[0]) * i) / k, a[1] + ((b[1] - a[1]) * i) / k]);
    }
  }
  // Greitis: kad spėtų fotografuoti kas photoStep (kameros intervalas), bet ne daugiau maksimalaus
  const speedByCam = photoStep / Math.max(s.interval, 0.3);
  const speed = Math.min(s.speed || speedByCam, s.maxSpeed, speedByCam);
  let transit = 0;
  const home = s.home ? proj.toEN(s.home[0], s.home[1]) : null;
  if (home && route.length) {
    transit = Math.hypot(route[0][0] - home[0], route[0][1] - home[1]) + Math.hypot(route[route.length - 1][0] - home[0], route[route.length - 1][1] - home[1]);
  }
  const climb = (s.alt / 5) * 2; // kilimas ~5 m/s ir nusileidimas
  const time = length / speed + turns * 6 + transit / Math.max(speed, 10) + climb + 30;
  const toLL = (p) => proj.toLonLat(p[0], p[1]);
  return {
    heading,
    gsd: fpm.gsd * s.alt,
    footW,
    footH,
    spacing,
    photoStep,
    speed,
    speedLimitedByCamera: speedByCam < (s.speed || s.maxSpeed),
    lines: passes.reduce((t, l) => t + l.length, 0),
    photos: photos.length,
    length,
    transit,
    time,
    batteries: Math.ceil(time / 60 / Math.max(s.battery, 5)),
    area: polygonArea(P),
    routeLL: route.map(toLL),
    photosLL: photos.map(toLL),
    passesLL: passes.map((lines) => lines.map(([a, b]) => [toLL(a), toLL(b)])),
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
    <name>${esc(name)} – maršrutas (${alt} m, GSD ${(plan.gsd * 100).toFixed(2)} cm)</name>
    <styleUrl>#route</styleUrl>
    <LineString><altitudeMode>relativeToGround</altitudeMode><coordinates>${plan.routeLL.map((p) => ll(p, alt)).join(' ')}</coordinates></LineString>
  </Placemark>
</Document>
</kml>
`;
}

/** GeoJSON: sritis, maršrutas ir nuotraukų vietos. */
export function toGeoJSON(name, polyLL, plan, settings) {
  const props = { name, altitude: settings.alt, gsd_cm: +(plan.gsd * 100).toFixed(2), front: settings.front, side: settings.side, heading: plan.heading, speed: +plan.speed.toFixed(1) };
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
 * DJI WPML (KMZ: wpmz/template.kml + wpmz/waylines.wpml) – maršruto taškų misija su fotografavimu kas N m.
 * Formatas – DJI Pilot 2 / FlightHub 2 (WPML 1.0.2). Aukštis – nuo pakilimo vietos.
 */
export function toWPML(name, plan, s) {
  const now = Date.now();
  const cam = s.camera;
  const [droneEnum, droneSub] = cam.drone || [77, 1];
  const payloadEnum = cam.payload ?? 67;
  const speed = +plan.speed.toFixed(1);
  const head = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.2">
  <Document>`;
  const missionConfig = `
    <wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
      <wpml:takeOffSecurityHeight>${Math.min(30, s.alt)}</wpml:takeOffSecurityHeight>
      <wpml:globalTransitionalSpeed>${Math.max(speed, 8)}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo><wpml:droneEnumValue>${droneEnum}</wpml:droneEnumValue><wpml:droneSubEnumValue>${droneSub}</wpml:droneSubEnumValue></wpml:droneInfo>
      <wpml:payloadInfo><wpml:payloadEnumValue>${payloadEnum}</wpml:payloadEnumValue><wpml:payloadSubEnumValue>0</wpml:payloadSubEnumValue><wpml:payloadPositionIndex>0</wpml:payloadPositionIndex></wpml:payloadInfo>
    </wpml:missionConfig>`;
  // Kiekvienos linijos pradžioje: kamera žemyn ir fotografavimas kas photoStep m iki linijos pabaigos
  let actionId = 0;
  const lineStartActions = (i, groupId) => `
        <wpml:actionGroup>
          <wpml:actionGroupId>${groupId}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>${i}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${i}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
          <wpml:actionTrigger><wpml:actionTriggerType>reachPoint</wpml:actionTriggerType></wpml:actionTrigger>
          <wpml:action>
            <wpml:actionId>${actionId++}</wpml:actionId>
            <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:gimbalHeadingYawBase>north</wpml:gimbalHeadingYawBase>
              <wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>
              <wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable>
              <wpml:gimbalPitchRotateAngle>-90</wpml:gimbalPitchRotateAngle>
              <wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable>
              <wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>
              <wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable>
              <wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>
              <wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable>
              <wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>
        </wpml:actionGroup>
        <wpml:actionGroup>
          <wpml:actionGroupId>${groupId + 1}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>${i}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${i + 1}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
          <wpml:actionTrigger>
            <wpml:actionTriggerType>multipleDistance</wpml:actionTriggerType>
            <wpml:actionTriggerParam>${plan.photoStep.toFixed(2)}</wpml:actionTriggerParam>
          </wpml:actionTrigger>
          <wpml:action>
            <wpml:actionId>${actionId++}</wpml:actionId>
            <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:fileSuffix>${esc(name.replace(/[^\w-]+/g, '_').slice(0, 20))}</wpml:fileSuffix>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>
        </wpml:actionGroup>`;
  const placemarks = (forExecute) => {
    actionId = 0;
    let groupId = 0;
    return plan.routeLL
      .map((p, i) => {
        const startOfLine = i % 2 === 0; // taškai poromis: linijos pradžia, pabaiga
        const actions = startOfLine ? lineStartActions(i, groupId) : '';
        if (startOfLine) groupId += 2;
        const height = forExecute ? `<wpml:executeHeight>${s.alt}</wpml:executeHeight><wpml:waypointSpeed>${speed}</wpml:waypointSpeed>` : `<wpml:height>${s.alt}</wpml:height><wpml:ellipsoidHeight>${s.alt}</wpml:ellipsoidHeight><wpml:useGlobalHeight>1</wpml:useGlobalHeight><wpml:useGlobalSpeed>1</wpml:useGlobalSpeed><wpml:useGlobalHeadingParam>1</wpml:useGlobalHeadingParam><wpml:useGlobalTurnParam>1</wpml:useGlobalTurnParam><wpml:useStraightLine>1</wpml:useStraightLine>`;
        const turn = forExecute
          ? `<wpml:waypointHeadingParam><wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode></wpml:waypointHeadingParam><wpml:waypointTurnParam><wpml:waypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:waypointTurnMode><wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist></wpml:waypointTurnParam><wpml:useStraightLine>1</wpml:useStraightLine>`
          : '';
        return `
      <Placemark>
        <Point><coordinates>${ll(p)}</coordinates></Point>
        <wpml:index>${i}</wpml:index>
        ${height}
        ${turn}${actions}
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
      <wpml:globalHeight>${s.alt}</wpml:globalHeight>
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
