import { t } from '../i18n.js';
// Nuotraukų rinkinio analizė, aukščių perskaičiavimas ir geo.txt failo kūrimas OpenDroneMap'ui.
import { LKS94 } from '../geo/tm.js';

export const HEIGHT_MODES = {
  ellipsoid: 'Elipsoidiniai (ETRS89 / WGS84) – RTK numatytasis',
  egm96: 'EGM96 jūros lygis (DJI „ASL“ nustatymas)',
  normal: 'Jau normaliniai (LAS07)',
};

export const PRESETS = {
  orthoOnly: {
    label: 'Tik ortofoto',
    desc: 'Greitas 2D žemėlapis be 3D modelio: kelis kartus greičiau ir mažai RAM. DSM / DTM – apytiksliai. Geriausia statmenoms (−90°) nuotraukoms.',
    options: { 'fast-orthophoto': true, 'skip-3dmodel': true, 'feature-quality': 'high', 'orthophoto-resolution': 2, 'dem-resolution': 10 },
  },
  fast: {
    label: 'Greitas',
    desc: 'Peržiūrai lauke. Mažesnis taškų tankis, ~2× greičiau.',
    // Be geometrinio gylio žemėlapių tikslinimo (OpenMVS) ir be PDF ataskaitos – tankinimas ~2× greitesnis
    options: { 'feature-quality': 'medium', 'pc-quality': 'low', 'pc-skip-geometric': true, 'skip-report': true, 'mesh-size': 150000, 'orthophoto-resolution': 5, 'dem-resolution': 10 },
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
  objects3d: {
    label: '3D objektai',
    desc: 'Įstrižoms (pvz. 5 krypčių) nuotraukoms: aštresni pastatai, mašinos, sienos. Ilgiausiai, reikia daugiausia RAM.',
    // Daugiau požymių – patikimiau susiejamos statmenos ir įstrižos nuotraukos; griežtesnis taškų filtras (σ 3 vietoj 5) –
    // mažiau „plaukiojančių“ taškų debesėlių, iš kurių tinkle atsiranda gumbai ant pastatų ir mašinų
    // ignore-gsd: ODM tekstūroms ir tankinimui naudoja nuotraukas, sumažintas pagal ortofoto raišką – įstrižose
    // nuotraukose fasadai nufotografuoti smulkiau, todėl be šios parinkties jų tekstūros neryškios
    options: { 'feature-quality': 'high', 'min-num-features': 15000, 'pc-quality': 'high', 'pc-filter': 3, 'mesh-size': 2000000, 'mesh-octree-depth': 13, 'ignore-gsd': true, 'orthophoto-resolution': 2, 'dem-resolution': 5 },
  },
  max: {
    label: 'Maksimali',
    desc: 'Geriausia, ką gali ODM: pilnos raiškos požymiai ir tekstūros, tankiausias taškų debesis (ultra), tikslus 3D tinklas. Labai ilgai ir daug RAM – galingam kompiuteriui su GPU.',
    // ultra: gylio žemėlapiai ½ nuotraukos raiškos (high – ¼, medium – ⅛); požymiai pilna raiška; 3 mln. viršūnių
    options: { 'feature-quality': 'ultra', 'min-num-features': 20000, 'pc-quality': 'ultra', 'pc-filter': 3, 'mesh-size': 3000000, 'mesh-octree-depth': 13, 'ignore-gsd': true, 'orthophoto-resolution': 1, 'dem-resolution': 2 },
  },
};

/** Įstriža nuotrauka – kamera pakreipta 15° ir daugiau nuo statmeno žemyn. */
export const isOblique = (m) => m.gimbalPitch != null && m.gimbalPitch >= -75;

// Apytikslis ODM RAM poreikis (GB) vienai 20 MP nuotraukai pagal taškų debesies kokybę (OpenMVS tankinimas)
// ir tinklo (Poisson) poreikis pagal octree gylį; sukalibruota pagal WebODM rekomendacijas ir praktiką.
const RAM_PER_IMAGE = { lowest: 0.005, low: 0.01, medium: 0.022, high: 0.05, ultra: 0.14 };
const RAM_MESH = { 9: 0.5, 10: 1, 11: 2, 12: 4, 13: 9, 14: 20 };

/**
 * @param {{name:string,value:any}[]} options ODM parinktys
 * @param {number} n nuotraukų skaičius
 * @param {number} [mp] nuotraukos megapikseliai
 * @returns {number} GB
 */
export function estimateRamGB(options, n, mp = 20) {
  const o = Object.fromEntries((options || []).map((x) => [x.name, x.value]));
  const imgs = o.split ? Math.min(n, Number(o.split) + 150) : n; // dalys apdorojamos po vieną
  // Greitas ortofoto: be tankaus taškų debesies ir 3D tinklo – daugiausia požymių paieška ir ortofoto sudūrimas
  if (o['fast-orthophoto']) return 2 + imgs * (mp / 20) * 0.004;
  const dense = 1.5 + imgs * (mp / 20) * (RAM_PER_IMAGE[o['pc-quality'] || 'medium'] ?? 0.022);
  const mesh = RAM_MESH[Number(o['mesh-octree-depth'] || 11)] ?? 2;
  // OpenMVS tinklas (Delaunay iš viso tankaus debesies + tikslinimas pagal nuotraukas) – daugiau nei tankinimas
  if (o['mesh-method'] === 'openmvs') return Math.max(dense * 1.4, mesh) + 1;
  return Math.max(dense, mesh) + 1;
}

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
  const oblique = used.filter(isOblique).length;
  if (used.length && oblique / used.length >= 0.2) warnings.push({ level: 'info', text: t('Rasta {n} įstrižų nuotraukų ({p} %) – 3D modeliui parinkta kokybė „3D objektai“ (aštresni pastatai ir mašinos).', { n: oblique, p: Math.round((100 * oblique) / used.length) }) });
  else if (used.length && nadirShare > 0.95) warnings.push({ level: 'info', text: t('Visos nuotraukos statmenos žemyn – vertikalios sienos (pastatai, krūvų šlaitai) gali būti mažiau detalūs. Įstrižos nuotraukos pagerintų 3D.') });

  const mps = used.filter((m) => m.width && m.height).map((m) => (m.width * m.height) / 1e6).sort((a, b) => a - b);
  return {
    used, excluded, rtk, stdH, stdV, lks, agl, gsd, takeoff, models, versions, totalBytes, oblique,
    megapixels: mps.length ? mps[mps.length >> 1] : null,
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

/** NodeODM duomenų aplankas Docker atvaizde (opendronemap/nodeodm, deploy/docker-compose.yml). */
export const NODEODM_DATA = '/var/www/data';
export const boundaryPath = (uuid) => `${NODEODM_DATA}/${uuid}/images/boundary.geojson`;

/** Ar parinkčių sąraše yra sena (sugadinta) JSON riba – tokios užduotys ODM nepavyksta iškart. */
export const hasInlineBoundary = (opts) => (opts || []).some((o) => o.name === 'boundary' && /^\s*[[{]/.test(String(o.value)));

export function buildOdmOptions(presetKey, { dsm = true, dtm = true, ortho = true, split = false, boundary = null, photos = 0, mvsMesh = false } = {}) {
  const o = { ...PRESETS[presetKey].options };
  // Tikslus 3D tinklas (Atea ODM atvaizdas, deploy/odm): OpenMVS ReconstructMesh + RefineMesh vietoj Poisson –
  // aštrios briaunos, be „pakilusio“ asfalto. Sename / kitame NodeODM parinktis praleidžiama (lieka Poisson).
  if (mvsMesh && !o['skip-3dmodel']) o['mesh-method'] = 'openmvs';
  // Pasirinkta sritis – kelias iki kartu įkeliamo GeoJSON failo (WGS84). ODM apkarpo taškų debesį, DEM ir
  // ortofoto; kitaip – automatinė riba. GeoJSON teksto tiesiogiai perduoti negalima: NodeODM, paleisdamas
  // ODM, iš parinkčių reikšmių pašalina visas kabutes (shQuote), ir JSON sugenda. Kelias perduodamas kaip
  // JSON eilutė ("/kelias") – ją priima NodeODM tikrinimas (tipas „json“), o pašalinus kabutes ODM gauna kelią.
  if (boundary) o.boundary = JSON.stringify(boundary);
  else o['auto-boundary'] = true;
  // Debesiui pritaikyti GeoTIFF (su peržiūros lygiais) – ortofoto programoje ir portale skaitomas dalimis
  o.cog = true;
  // NodeODM pagal nutylėjimą kuria ir Entwine taškų plyteles (WebODM peržiūrai) – programa jų nenaudoja, o jos ilgina
  // apdorojimą ir padidina all.zip. GLB (gltf) palieka – juo atidaromas 3D modelis.
  o['pc-ept'] = false;
  // Dideliems rinkiniams – vietinis + periodinis visuminis optimizavimas: nuotraukų sujungimas (OpenSfM) gerokai greitesnis
  if (photos >= 500) o['use-hybrid-bundle-adjustment'] = true;
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

// ---------------------------------------------------------------------------
// Nepavykusios užduoties priežastis ir pakartojimas su mažesniu atminties poreikiu
// ---------------------------------------------------------------------------
/** ODM etapai eilės tvarka (--rerun-from reikšmės). */
export const ODM_STAGES = ['dataset', 'split', 'merge', 'opensfm', 'openmvs', 'odm_filterpoints', 'odm_meshing', 'mvs_texturing', 'odm_georeferencing', 'odm_dem', 'odm_orthophoto', 'odm_report', 'odm_postprocess'];
const STAGE_LABELS = {
  dataset: 'nuotraukų nuskaitymas',
  opensfm: 'nuotraukų sujungimas (OpenSfM)',
  openmvs: 'taškų debesies tankinimas (OpenMVS)',
  odm_filterpoints: 'taškų debesies filtravimas',
  odm_meshing: '3D tinklo kūrimas',
  mvs_texturing: 'tekstūravimas',
  odm_georeferencing: 'georeferencija',
  odm_dem: 'DSM / DTM',
  odm_orthophoto: 'ortofoto',
  odm_report: 'ataskaita',
};

/**
 * Pagal ODM žurnalą nustato, kodėl užduotis nepavyko.
 * @param {string[]} lines – žurnalo eilutės (užtenka paskutinių ~200)
 * @returns {{kind:'memory'|'boundary'|'disk'|'reconstruction'|'other', stage:string|null, stageLabel:string, text:string, line:string}}
 */
export function diagnoseFailure(lines, options = []) {
  const log = (lines || []).join('\n');
  let stage = null;
  for (const m of log.matchAll(/Running (\w+) stage/g)) stage = m[1];
  // Konkretiausia klaidos eilutė (bendras „strange error code“ / „report it“ – tik jei nieko kito nėra)
  const rev = [...(lines || [])].reverse().filter((l) => !/please report it|human-readable information/i.test(l));
  const errLine =
    rev.find((l) => /out of memory|bad_alloc|MemoryError|terminated by signal|no PLY|No OpenMVS scenes|empty point cloud|No space left|ExitException|Not enough|Reconstruction/i.test(l)) ||
    rev.find((l) => /error|exception|killed|failed|uh oh|cannot|could not/i.test(l)) ||
    '';
  const hasBoundary = (options || []).some((o) => o.name === 'boundary');
  const stageLabel = t(STAGE_LABELS[stage] || stage || '');
  const r = (kind, text) => ({ kind, stage, stageLabel, text, line: errLine.trim().slice(0, 300) });
  if (/no space left on device|disk quota/i.test(log)) return r('disk', t('Serveryje baigėsi vieta diske. Atlaisvinkite vietos (pašalinkite senus projektus) ir kartokite.'));
  if (/ran out of memory|out of memory|std::bad_alloc|MemoryError|Killed|exit code:? ?(137|-9|3221226505)|returned non-zero exit status -?9\b|no PLY files available|No OpenMVS scenes found|Cannot allocate memory|terminated by signal 9\b|Processing failed \(9\)/i.test(log))
    return r('memory', t('Pritrūko operatyviosios atminties (RAM) etape „{s}“. Kartokite su mažesniu atminties poreikiu arba skirkite Docker daugiau RAM.', { s: stageLabel || '—' }));
  if (/empty point cloud/i.test(log) && hasBoundary) return r('boundary', t('Po apkarpymo pagal pasirinktą sritį neliko taškų. Patikrinkite, ar sritis patenka į nufotografuotą teritoriją, arba kartokite be ribos.'));
  if (/empty point cloud|Dense reconstruction failed|not enough|Reconstruction (could not|failed)|No reconstructions|has no images|Not enough images/i.test(log))
    return r('reconstruction', t('Nepavyko sujungti nuotraukų į modelį – per mažas persidengimas, nėra GPS arba nuotraukos per tamsios / neryškios.'));
  return r('other', stage ? t('Klaida etape „{s}“.', { s: stageLabel }) : t('ODM apdorojimas nutrūko.'));
}

const QUALITY_DOWN = { ultra: 'high', high: 'medium', medium: 'low', low: 'lowest', lowest: 'lowest' };
const QUALITY_LABELS = { ultra: 'itin aukšta', high: 'aukšta', medium: 'vidutinė', low: 'žema', lowest: 'žemiausia' };

/**
 * Parinktys pakartojimui su mažesniu RAM poreikiu: taškų debesies (ir, jei reikia, požymių) kokybė viena pakopa
 * žemiau, mažesnis tinklas; tęsiama nuo nutrūkusio etapo, jau atlikti etapai (pvz. 2 val. sujungimas) nekartojami.
 * @returns {{options:{name:string,value:any}[], changes:string[]}}
 */
export function lowerMemoryOptions(options, stage) {
  const map = new Map((options || []).filter((o) => o.name !== 'rerun-from' && o.name !== 'rerun-all' && o.name !== 'rerun').map((o) => [o.name, o.value]));
  const changes = [];
  const down = (name, def, label) => {
    const cur = String(map.get(name) ?? def);
    const next = QUALITY_DOWN[cur] || cur;
    if (next !== cur) {
      map.set(name, next);
      changes.push(t('{l}: {a} → {b}', { l: label, a: t(QUALITY_LABELS[cur] || cur), b: t(QUALITY_LABELS[next] || next) }));
    }
  };
  const si = ODM_STAGES.indexOf(stage);
  // Požymiai (OpenSfM) mažinami tik jei nutrūko pats sujungimas – kitaip jo rezultatai panaudojami
  if (stage === 'opensfm' || stage === 'dataset') down('feature-quality', 'high', t('Požymių kokybė'));
  if (si < 0 || si <= ODM_STAGES.indexOf('odm_filterpoints')) down('pc-quality', 'medium', t('Taškų debesies kokybė'));
  const depth = Number(map.get('mesh-octree-depth') || 11);
  if (depth > 10) {
    map.set('mesh-octree-depth', depth - 1);
    changes.push(t('Tinklo detalumas (octree): {a} → {b}', { a: depth, b: depth - 1 }));
  }
  const size = Number(map.get('mesh-size') || 200000);
  if (size > 200000) {
    map.set('mesh-size', Math.round(size / 2));
    changes.push(t('Tinklo trikampių: {a} → {b}', { a: size, b: Math.round(size / 2) }));
  }
  if (si > 0 && stage !== 'dataset') map.set('rerun-from', stage);
  return { options: [...map].map(([name, value]) => ({ name, value })), changes };
}
