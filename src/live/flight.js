// Skrydis AI ataskaitoje (iš diab telemetrijos įrašo metu): maršrutas palydoviniame žemėlapyje su įvykių vietomis,
// skrydžio santrauka ir grafikai (aukštis, greitis, baterija). Be telemetrijos – nieko neįtraukiama.
import { t, locale } from '../i18n.js';
import { distM } from './telemetry.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = (v, d = 0) => new Intl.NumberFormat(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const MAP_W = 1000, MAP_H = 560, PAD = 46;

const vals = (rows, k) => rows.map((r) => r[k]).filter((v) => v != null && Number.isFinite(v));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/**
 * Skrydžio santrauka; null – telemetrijos nėra.
 * @param {{tele:object[], route:{t:number,lat:number,lon:number,alt:number|null}[], dock:[number,number]|null, started:number, ended?:number}} comp
 */
export function flightSummary(comp) {
  const S = comp.tele || [];
  if (!S.length) return null;
  const route = comp.route || [];
  let dist = 0;
  for (let i = 1; i < route.length; i++) dist += distM([route[i - 1].lat, route[i - 1].lon], [route[i].lat, route[i].lon]);
  const alt = vals(S, 'alt'), speed = vals(S, 'speed'), bat = vals(S, 'battery'), wind = vals(S, 'wind'), rc = vals(S, 'rc');
  const dock = comp.dock;
  const fromDock = dock ? Math.max(0, ...route.map((p) => distM(dock, [p.lat, p.lon]))) : null;
  return {
    S,
    route,
    dock,
    moved: route.length > 1 && dist > 5,
    dist,
    alt: alt.length ? { min: Math.min(...alt), max: Math.max(...alt), avg: avg(alt) } : null,
    speed: speed.length ? { max: Math.max(...speed), avg: avg(speed.filter((v) => v > 0.5)) ?? 0 } : null,
    battery: bat.length > 1 ? { start: bat[0], end: bat[bat.length - 1] } : bat.length ? { start: bat[0], end: bat[0] } : null,
    wind: wind.length ? { max: Math.max(...wind), avg: avg(wind) } : null,
    rc: rc.length ? { min: Math.min(...rc) } : null,
    fromDock,
    dur: (comp.ended || Date.now()) - comp.started,
  };
}

// ---------------------------------------------------------------- žemėlapis (Web Mercator)
const lon2x = (lon, z) => ((lon + 180) / 360) * 256 * 2 ** z;
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** z;
};

/**
 * Pagrindo paveikslas (palydovinė nuotrauka) maršrutui; jei plytelių gauti nepavyksta (be interneto) – neutralus fonas.
 * @returns {Promise<{blob:Blob, toXY:(lat:number,lon:number)=>[number,number], mPerPx:number, tiles:boolean}>}
 */
export async function routeMap(points) {
  const lats = points.map((p) => p[0]), lons = points.map((p) => p[1]);
  const box = [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
  let z = 19;
  for (; z > 3; z--) {
    const w = lon2x(box[3], z) - lon2x(box[1], z), h = lat2y(box[0], z) - lat2y(box[2], z);
    if (w <= MAP_W - 2 * PAD && h <= MAP_H - 2 * PAD) break;
  }
  const cx = (lon2x(box[1], z) + lon2x(box[3], z)) / 2, cy = (lat2y(box[0], z) + lat2y(box[2], z)) / 2;
  const x0 = cx - MAP_W / 2, y0 = cy - MAP_H / 2;
  const toXY = (lat, lon) => [lon2x(lon, z) - x0, lat2y(lat, z) - y0];
  const cv = document.createElement('canvas');
  cv.width = MAP_W;
  cv.height = MAP_H;
  const g = cv.getContext('2d');
  g.fillStyle = '#2b3236';
  g.fillRect(0, 0, MAP_W, MAP_H);
  const n = 2 ** z;
  const jobs = [];
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + MAP_H) / 256); ty++) {
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + MAP_W) / 256); tx++) {
      if (ty < 0 || ty >= n) continue;
      const url = TILE_URL.replace('{z}', z).replace('{x}', ((tx % n) + n) % n).replace('{y}', ty);
      jobs.push(
        new Promise((res) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.referrerPolicy = 'strict-origin-when-cross-origin';
          const timer = setTimeout(() => res(false), 8000);
          img.onload = () => {
            clearTimeout(timer);
            g.drawImage(img, tx * 256 - x0, ty * 256 - y0);
            res(true);
          };
          img.onerror = () => (clearTimeout(timer), res(false));
          img.src = url;
        }),
      );
    }
  }
  const ok = (await Promise.all(jobs)).filter(Boolean).length;
  let blob = null;
  try {
    blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.85));
  } catch {
    blob = null; // plytelės be CORS – „užterštos“ drobės išsaugoti negalima
  }
  if (!blob) {
    g.fillStyle = '#2b3236';
    g.fillRect(0, 0, MAP_W, MAP_H);
    blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.85));
  }
  const lat0 = (box[0] + box[2]) / 2;
  return { blob, toXY, mPerPx: (40075016.686 * Math.cos((lat0 * Math.PI) / 180)) / (256 * n), tiles: ok > 0 };
}

/** Aukščio spalva: žemai – mėlyna, vidutiniškai – geltona, aukštai – raudona. */
function altColor(v, a, b) {
  const k = b > a ? Math.min(1, Math.max(0, (v - a) / (b - a))) : 0.5;
  const hue = 220 - 220 * k;
  return `hsl(${hue.toFixed(0)},90%,55%)`;
}

/** Maršruto taškų mažinimas (≤ max) – kad SVG nebūtų per didelis. */
function thin(route, max = 1500) {
  if (route.length <= max) return route;
  const step = route.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(route[Math.floor(i * step)]);
  out.push(route[route.length - 1]);
  return out;
}

/**
 * Skrydžio skiltis ataskaitai (HTML) ir failai ZIP'ui.
 * @param {ReturnType<typeof flightSummary>} fs
 * @param {{t:number, pos?:number[], group?:string, n:number, color?:string, label:string}[]} events – įvykiai su vieta (numeracija – kaip lentelėje)
 * @returns {Promise<{html:string, files:Record<string,Blob>}>}
 */
export async function flightSection(fs, events, started) {
  if (!fs) return { html: '', files: {} };
  const files = {};
  const parts = [];
  // --- žemėlapis
  const evPts = events.filter((e) => e.pos);
  const pts = [...fs.route.map((p) => [p.lat, p.lon]), ...evPts.map((e) => [e.pos[0], e.pos[1]]), ...(fs.dock ? [fs.dock] : [])];
  if (pts.length) {
    const m = await routeMap(pts);
    files['skrydis/zemelapis.jpg'] = m.blob;
    const R = thin(fs.route);
    const A = R.map((p) => p.alt).filter((v) => v != null);
    const aMin = A.length ? Math.min(...A) : 0, aMax = A.length ? Math.max(...A) : 0;
    const xy = R.map((p) => m.toXY(p.lat, p.lon).map((v) => +v.toFixed(1)));
    const segs = xy.slice(1).map(([x, y], i) => `<line x1="${xy[i][0]}" y1="${xy[i][1]}" x2="${x}" y2="${y}" stroke="${R[i + 1].alt != null ? altColor(R[i + 1].alt, aMin, aMax) : '#ffd23f'}"/>`).join('');
    const poly = xy.map((p) => p.join(',')).join(' ');
    // Laiko → vietos sąrašas judančiam žymekliui (sekundės nuo įrašo pradžios)
    const timeline = R.map((p, i) => `${((p.t - started) / 1000).toFixed(1)},${xy[i][0]},${xy[i][1]}`).join(';');
    const marker = (x, y, label, color, title) => `<g transform="translate(${x},${y})"><title>${esc(title)}</title><circle r="11" fill="${color}" stroke="#fff" stroke-width="2"/><text y="4.5" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">${esc(label)}</text></g>`;
    const evMarks = evPts
      .map((e) => {
        const [x, y] = m.toXY(e.pos[0], e.pos[1]);
        return `<a class="t" data-t="${Math.max(0, e.t - 1000) / 1000}">${marker(x.toFixed(1), y.toFixed(1), e.n, e.color || '#ff5ec4', `${e.n}. ${e.label}`)}</a>`;
      })
      .join('');
    const start = xy[0], end = xy[xy.length - 1];
    const dockXY = fs.dock ? m.toXY(fs.dock[0], fs.dock[1]) : null;
    // Mastelio juosta
    const target = 160 * m.mPerPx;
    const p10 = 10 ** Math.floor(Math.log10(target));
    const len = [1, 2, 5, 10].map((k) => k * p10).filter((v) => v <= target).pop() || p10;
    const px = len / m.mPerPx;
    const svg = `<svg id="route" class="route" viewBox="0 0 ${MAP_W} ${MAP_H}" data-timeline="${timeline}">
      <image href="skrydis/zemelapis.jpg" x="0" y="0" width="${MAP_W}" height="${MAP_H}"/>
      ${xy.length > 1 ? `<polyline points="${poly}" fill="none" stroke="rgba(0,0,0,.55)" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/><g stroke-width="3.5" stroke-linecap="round">${segs}</g>` : ''}
      ${dockXY ? `<g transform="translate(${dockXY[0].toFixed(1)},${dockXY[1].toFixed(1)})"><title>${esc(t('Dokas'))}</title><rect x="-11" y="-11" width="22" height="22" rx="4" fill="#1f2326" stroke="#fff" stroke-width="2"/><text y="4.5" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">D</text></g>` : ''}
      ${xy.length > 1 ? marker(start[0], start[1], 'S', '#3cc443', t('Įrašo pradžia')) + marker(end[0], end[1], 'F', '#ff5e57', t('Įrašo pabaiga')) : ''}
      ${evMarks}
      <circle id="route-now" r="8" fill="#fff" stroke="#008b01" stroke-width="4" ${xy.length ? `cx="${start[0]}" cy="${start[1]}"` : 'visibility="hidden"'}/>
      <g transform="translate(14,${MAP_H - 30})"><rect x="-6" y="-14" width="${px + 12}" height="30" rx="4" fill="rgba(16,19,21,.75)"/><rect width="${px}" height="4" y="6" fill="#fff"/><text y="0" fill="#fff" font-size="12">${len >= 1000 ? `${nf(len / 1000)} km` : `${nf(len)} m`}</text></g>
      ${m.tiles ? `<text x="${MAP_W - 8}" y="${MAP_H - 8}" text-anchor="end" fill="#fff" font-size="10" opacity=".8">© Esri, Maxar, Earthstar Geographics</text>` : ''}
    </svg>`;
    const legend = A.length
      ? `<div class="legend"><span>${esc(t('Aukštis'))}:</span><span class="grad"></span><span>${nf(aMin)}–${nf(aMax)} m</span><span>· <b style="color:#3cc443">S</b> ${esc(t('pradžia'))} · <b style="color:#ff5e57">F</b> ${esc(t('pabaiga'))}${dockXY ? ` · <b>D</b> ${esc(t('dokas'))}` : ''}${evPts.length ? ` · ${esc(t('skaičiai – įvykiai (spustelėjus – vaizde)'))}` : ''}</span></div>`
      : '';
    parts.push(`<section><h2>${esc(t('Skrydžio maršrutas'))}</h2>${svg}${legend}</section>`);
  }
  // --- santrauka
  const card = (label, value, sub = '') => `<div class="card"><span>${esc(label)}</span><b>${value}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  const cards = [];
  if (fs.moved) cards.push(card(t('Nuskrista'), fs.dist >= 1000 ? `${nf(fs.dist / 1000, 2)} km` : `${nf(fs.dist)} m`, esc(t('per įrašą'))));
  if (fs.alt) cards.push(card(t('Aukštis'), `${nf(fs.alt.max)} m`, esc(t('didžiausias · vidutiniškai {a} m', { a: nf(fs.alt.avg) }))));
  if (fs.speed) cards.push(card(t('Greitis'), `${nf(fs.speed.max, 1)} m/s`, esc(t('didžiausias · skrendant vid. {a} m/s', { a: nf(fs.speed.avg, 1) }))));
  if (fs.battery) cards.push(card(t('Baterija'), `${nf(fs.battery.start)} → ${nf(fs.battery.end)} %`, esc(t('sunaudota {p} %', { p: nf(Math.max(0, fs.battery.start - fs.battery.end)) }))));
  if (fs.fromDock != null && fs.moved) cards.push(card(t('Toliausiai nuo doko'), `${nf(fs.fromDock)} m`));
  if (fs.wind) cards.push(card(t('Vėjas (doke)'), `${nf(fs.wind.max, 1)} m/s`, esc(t('didžiausias · vid. {a} m/s', { a: nf(fs.wind.avg, 1) }))));
  if (fs.rc) cards.push(card(t('Valdymo signalas'), `${nf(fs.rc.min)} %`, esc(t('silpniausias'))));
  if (cards.length) parts.push(`<section><h2>${esc(t('Skrydžio santrauka'))}</h2><div class="cards">${cards.join('')}</div></section>`);
  // --- grafikai
  const charts = [
    ['alt', t('Aukštis, m'), '#4fa8ff'],
    ['speed', t('Greitis, m/s'), '#ffb627'],
    ['battery', t('Baterija, %'), '#3cc443'],
  ]
    .map(([k, label, color]) => telemetryChart(fs, k, label, color))
    .filter(Boolean);
  if (charts.length) parts.push(`<section><h2>${esc(t('Telemetrija laike'))}</h2>${charts.join('')}</section>`);
  return { html: parts.join('\n'), files };
}

/** Vieno dydžio grafikas laike (spustelėjus – peršokama į vaizdo vietą). */
function telemetryChart(fs, key, label, color) {
  const rows = fs.S.filter((r) => r[key] != null && Number.isFinite(r[key]));
  if (rows.length < 2) return '';
  const W = 900, H = 150, P = 40;
  const T = Math.max(1, fs.dur);
  const v = rows.map((r) => r[key]);
  let lo = Math.min(...v), hi = Math.max(...v);
  if (hi - lo < 1) (hi += 0.5), (lo -= 0.5);
  const top = 24, bottom = H - 26;
  const x = (tt) => P + ((W - P - 10) * tt) / T;
  const y = (val) => bottom - ((bottom - top) * (val - lo)) / (hi - lo);
  const pts = rows.map((r) => `${x(r.t).toFixed(1)},${y(r[key]).toFixed(1)}`).join(' ');
  const yt = [lo, (lo + hi) / 2, hi].map((val) => `<text x="${P - 6}" y="${(y(val) + 4).toFixed(1)}" text-anchor="end">${nf(val, hi - lo < 10 ? 1 : 0)}</text><line x1="${P}" x2="${W - 10}" y1="${y(val).toFixed(1)}" y2="${y(val).toFixed(1)}" stroke="#ccd" stroke-dasharray="3 3"/>`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((k) => `<text x="${x(T * k).toFixed(1)}" y="${H - 6}" text-anchor="middle">${fmtT(T * k)}</text>`).join('');
  return `<svg class="tchart" viewBox="0 0 ${W} ${H}" data-dur="${T}" data-p="${P}" data-w="${W}"><text x="${P}" y="14" font-weight="600" fill="${color}">${esc(label)}</text>${yt}<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/>${ticks}</svg>`;
}
const fmtT = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Telemetrijos CSV (kas sekundę). */
export function telemetryCsv(fs, started) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const clock = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const head = [t('laikas_s'), t('data_laikas'), t('platuma'), t('ilguma'), t('aukstis_m'), t('greitis_ms'), t('vertikalus_greitis_ms'), t('kryptis_laipsn'), t('baterija_proc'), t('signalas_proc'), t('vejas_ms'), t('busena')];
  const f = (v, d) => (v == null || !Number.isFinite(v) ? '' : v.toFixed(d));
  const rows = fs.S.map((r) => [(r.t / 1000).toFixed(1), clock(new Date(started + r.t)), r.pos ? r.pos[0].toFixed(7) : '', r.pos ? r.pos[1].toFixed(7) : '', f(r.alt, 1), f(r.speed, 1), f(r.vspeed, 1), f(r.heading, 0), f(r.battery, 0), f(r.rc, 0), f(r.wind, 1), r.state || ''].join(';'));
  return `﻿${head.join(';')}\n${rows.join('\n')}\n`;
}
