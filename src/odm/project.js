import { t } from '../i18n.js';
// Nuotraukų rinkinio analizė, aukščių perskaičiavimas ir geo.txt failo kūrimas OpenDroneMap'ui.
import { LKS94 } from '../geo/tm.js';

export const HEIGHT_MODES = {
  ellipsoid: 'Elipsoidiniai (ETRS89 / WGS84) – RTK numatytasis',
  egm96: 'EGM96 jūros lygis (DJI „ASL“ nustatymas)',
  normal: 'Jau normaliniai (LAS07)',
};

export const PRESETS = {
  fast: {
    label: 'Greitas',
    desc: 'Peržiūrai lauke. Mažesnis taškų tankis, ~2× greičiau.',
    options: { 'feature-quality': 'medium', 'pc-quality': 'low', 'mesh-size': 150000, 'orthophoto-resolution': 5, 'dem-resolution': 10 },
  },
  standard: {
    label: 'Standartinis',
    desc: 'Rekomenduojama tūriams ir plotams.',
    options: { 'feature-quality': 'high', 'pc-quality': 'medium', 'mesh-size': 300000, 'orthophoto-resolution': 2, 'dem-resolution': 5 },
  },
  high: {
    label: 'Aukšta kokybė',
    desc: 'Didžiausias detalumas. Ilgai, reikia daug RAM.',
    options: { 'feature-quality': 'high', 'pc-quality': 'high', 'mesh-size': 600000, 'mesh-octree-depth': 12, 'orthophoto-resolution': 1, 'dem-resolution': 2 },
  },
};

/** Ką dėti į all.zip (rezultatų archyvą). */
export const ODM_OUTPUTS = [
  'odm_georeferencing/coords.txt',
  'odm_georeferencing/odm_georeferenced_model.laz',
  'odm_texturing',
  'odm_orthophoto/odm_orthophoto.tif',
  'odm_dem/dsm.tif',
  'odm_dem/dtm.tif',
  'odm_report',
  'images.json',
  'task_output.txt',
];

function median(arr) {
  if (!arr.length) return undefined;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Iškiliojo apvalkalo plotas (m²) LKS-94 plokštumoje. */
function hullArea(pts) {
  if (pts.length < 3) return 0;
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  const h = lower.slice(0, -1).concat(upper.slice(0, -1));
  let a = 0;
  for (let i = 0; i < h.length; i++) {
    const [x1, y1] = h[i], [x2, y2] = h[(i + 1) % h.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/**
 * Analizuoja nuotraukų metaduomenis.
 * @param {import('./exif.js').PhotoMeta[]} metas
 * @param {{includeThermal?: boolean, includeZoom?: boolean, onlyFix?: boolean}} opts
 */
export function analyzePhotos(metas, opts = {}) {
  const used = [], excluded = [];
  for (const m of metas) {
    let reason = null;
    if (m.error) reason = `klaida: ${m.error}`;
    else if (m.channel === 'thermal' && !opts.includeThermal) reason = 'terminė kamera';
    else if (m.channel === 'zoom' && !opts.includeZoom) reason = 'priartinimo kamera';
    else if (m.lat == null || m.lon == null) reason = 'nėra GPS koordinačių';
    else if (opts.onlyFix && m.rtkFlag !== 50) reason = 'ne RTK FIX';
    if (reason) excluded.push({ meta: m, reason });
    else used.push(m);
  }

  // Pasikartojantys pavadinimai (keli skrydžiai) – pervadinsime įkeliant
  const seen = new Map();
  for (const m of used) {
    const k = m.name.toLowerCase();
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const duplicates = [...seen.values()].filter((v) => v > 1).length;

  const rtk = { fix: 0, float: 0, single: 0, none: 0, unknown: 0 };
  for (const m of used) {
    if (m.rtkFlag === 50) rtk.fix++;
    else if (m.rtkFlag === 34) rtk.float++;
    else if (m.rtkFlag === 16) rtk.single++;
    else if (m.rtkFlag === 0) rtk.none++;
    else rtk.unknown++;
  }
  const fixed = used.filter((m) => m.rtkFlag === 50);
  const stdH = median(fixed.map((m) => Math.max(m.stdLat ?? 0, m.stdLon ?? 0)).filter((v) => v > 0));
  const stdV = median(fixed.map((m) => m.stdHgt).filter((v) => v > 0));

  const lks = used.map((m) => LKS94.forward(m.lon, m.lat));
  const relAlts = used.map((m) => m.relAlt).filter((v) => v != null);
  const agl = median(relAlts);
  const sample = used.find((m) => m.f35 && m.width) || used[0];
  let gsd = null;
  if (sample?.f35 && sample.width && agl) {
    const diagPx = Math.hypot(sample.width, sample.height || sample.width * 0.75);
    gsd = (agl * (43.27 / sample.f35)) / diagPx; // m/px
  }
  const takeoff = median(used.filter((m) => m.absAlt != null && m.relAlt != null).map((m) => m.absAlt - m.relAlt));
  const dates = used.map((m) => m.date?.getTime()).filter(Boolean);
  const models = [...new Set(used.map((m) => m.model).filter(Boolean))];
  const versions = [...new Set(used.map((m) => m.xmpVersion).filter(Boolean))];
  const totalBytes = used.reduce((s, m) => s + m.size, 0);
  const centerLat = used.reduce((s, m) => s + m.lat, 0) / Math.max(1, used.length);
  const centerLon = used.reduce((s, m) => s + m.lon, 0) / Math.max(1, used.length);

  const warnings = [];
  if (used.length < 30) warnings.push({ level: 'error', text: t('Per mažai nuotraukų ({n}). Patikimam modeliui reikia bent 30–50.', { n: used.length }) });
  const nonFix = used.length - rtk.fix;
  if (rtk.unknown === used.length) warnings.push({ level: 'warn', text: t('Nuotraukose nerasta RTK informacijos – bus naudojamas paprastas GPS (tikslumas ~1–5 m).') });
  else if (nonFix > 0) warnings.push({ level: nonFix / used.length > 0.1 ? 'error' : 'warn', text: t('{n} nuotr. be RTK FIX (FLOAT/SINGLE/be RTK). Joms bus priskirtas mažesnis svoris.', { n: nonFix }) });
  if (stdV && stdV > 0.05) warnings.push({ level: 'warn', text: t('Aukščio RTK nuokrypis didesnis nei įprasta ({v} m).', { v: stdV.toFixed(3) }) });
  if (models.length > 1) warnings.push({ level: 'warn', text: t('Kelios kameros: {m}.', { m: models.join(', ') }) });
  if (duplicates) warnings.push({ level: 'info', text: t('{n} pasikartojantys failų pavadinimai – bus automatiškai pervadinti.', { n: duplicates }) });
  const thermal = excluded.filter((e) => e.reason === 'terminė kamera').length;
  if (thermal) warnings.push({ level: 'info', text: t('{n} terminės kameros (_T) nuotraukos nenaudojamos 3D modeliui.', { n: thermal }) });
  const zoom = excluded.filter((e) => e.reason === 'priartinimo kamera').length;
  if (zoom) warnings.push({ level: 'info', text: t('{n} priartinimo kameros (_Z) nuotraukos nenaudojamos.', { n: zoom }) });
  const noGps = excluded.filter((e) => e.reason === 'nėra GPS koordinačių').length;
  if (noGps) warnings.push({ level: 'warn', text: t('{n} nuotr. be GPS koordinačių – praleidžiamos.', { n: noGps }) });
  const nadirShare = used.filter((m) => m.gimbalPitch != null && m.gimbalPitch < -80).length / Math.max(1, used.length);
  if (used.length && nadirShare > 0.95) warnings.push({ level: 'info', text: t('Visos nuotraukos statmenos žemyn – vertikalios sienos (pastatai, krūvų šlaitai) gali būti mažiau detalūs. Įstrižos nuotraukos pagerintų 3D.') });

  return {
    used, excluded, rtk, stdH, stdV, lks, agl, gsd, takeoff, models, versions, totalBytes,
    areaM2: hullArea(lks), center: { lat: centerLat, lon: centerLon },
    timeFrom: dates.length ? new Date(Math.min(...dates)) : null,
    timeTo: dates.length ? new Date(Math.max(...dates)) : null,
    warnings,
  };
}

/** Pervadina pasikartojančius failus, kad ODM juos atskirtų. */
export function uniqueUploadNames(metas) {
  const count = new Map();
  return metas.map((m) => {
    const k = m.name.toLowerCase();
    const n = (count.get(k) || 0) + 1;
    count.set(k, n);
    const name = n === 1 ? m.name : m.name.replace(/(\.[^.]+)$/, `_${n}$1`);
    return { meta: m, name, file: name === m.name ? m.file : new File([m.file], name, { type: m.file.type }) };
  });
}

/**
 * Nuotraukos aukštis pasirinktoje sistemoje -> normalinis (LAS07), jei žinomas N.
 * @param {'ellipsoid'|'egm96'|'normal'} mode
 * @param {(lat:number, lon:number)=>number|null} geoidN – kvazigeoido aukštis N (m) arba null
 */
export function photoHeight(m, mode, geoidN) {
  const h = m.absAlt ?? m.alt;
  if (h == null) return null;
  if (mode === 'ellipsoid') {
    const N = geoidN?.(m.lat, m.lon);
    return N != null && isFinite(N) ? h - N : h;
  }
  return h; // EGM96 ir LAS07 skiriasi nedaug – likutis pataisomas kontroliniais taškais
}

/**
 * geo.txt (ODM formatas): EPSG:4326, „failas ilguma platuma aukštis yaw pitch roll horiz_tikslumas vert_tikslumas“.
 * Tikslumai – iš DJI RtkStd* (×2, kaip ir ODM), FLOAT/be RTK – mažesnis svoris.
 */
export function buildGeoTxt(entries, mode, geoidN) {
  const lines = ['EPSG:4326'];
  for (const { meta: m, name } of entries) {
    const H = photoHeight(m, mode, geoidN);
    let hAcc, vAcc;
    if (m.rtkFlag === 50) {
      hAcc = Math.max(0.01, 2 * Math.max(m.stdLat ?? 0.01, m.stdLon ?? 0.01));
      vAcc = Math.max(0.02, 2 * (m.stdHgt ?? 0.02));
    } else if (m.rtkFlag === 34) {
      hAcc = Math.max(0.3, 2 * Math.max(m.stdLat ?? 0.3, m.stdLon ?? 0.3));
      vAcc = Math.max(0.5, 2 * (m.stdHgt ?? 0.5));
    } else {
      hAcc = 3;
      vAcc = 5;
    }
    lines.push(`${name} ${m.lon.toFixed(9)} ${m.lat.toFixed(9)} ${H != null ? H.toFixed(4) : 'nan'} nan nan nan ${hAcc.toFixed(3)} ${vAcc.toFixed(3)}`);
  }
  return lines.join('\n') + '\n';
}

export function buildOdmOptions(presetKey, { dsm = true, dtm = true, ortho = true, split = false } = {}) {
  const o = { ...PRESETS[presetKey].options };
  o['auto-boundary'] = true;
  if (dsm) o.dsm = true;
  if (dtm) o.dtm = true;
  if (!ortho) o['skip-orthophoto'] = true;
  // Dideli projektai – skaidymas į dalis taupo RAM, bet ODM nesujungia tekstūruotų 3D modelių
  if (split) {
    o.split = 400;
    o['split-overlap'] = 150;
  }
  return Object.entries(o).map(([name, value]) => ({ name, value }));
}
