// Nuotraukų peržiūra prieš apdorojimą: iš EXIF/XMP (GPS, aukštis, kameros posūkis, objektyvas)
// kiekviena nuotrauka padedama žemėlapyje – gaunamas apytikslis ortofoto per kelias sekundes.
// Ant jo nubrėžiama sritis: ODM gauna ją kaip „boundary“, o nuotraukos, kurios srities nedengia,
// neįkeliamos (mažiau duomenų ir greitesnis apdorojimas).
import { BASEMAPS } from '../geo/basemap.js';
import { t, locale } from '../i18n.js';

const D2R = Math.PI / 180;
const A = 6378137, E2 = 0.00669437999014;

/** Vietinė plokščia projekcija aplink centrą (tikslu keliems km). */
export function localProjection(lat0, lon0) {
  const s = Math.sin(lat0 * D2R);
  const w = 1 - E2 * s * s;
  const RN = A / Math.sqrt(w), RM = (A * (1 - E2)) / (w * Math.sqrt(w));
  const kx = D2R * RN * Math.cos(lat0 * D2R), ky = D2R * RM;
  return {
    toEN: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLonLat: (e, n) => [lon0 + e / kx, lat0 + n / ky],
  };
}

/**
 * Kaip suprasti kameros kryptį (visam rinkiniui): DJI „GimbalYawDegree“ – nuo šiaurės (absoliuti), bet kai kurie
 * gamintojai rašo ją drono atžvilgiu. Jei gimbalo kryptis beveik pastovi ~0°, o drono kryptis kaitaliojasi
 * (skrendant pirmyn–atgal) – ji santykinė: kryptis = drono + gimbalo.
 */
export function yawMode(photos) {
  const circ = (a) => {
    const x = a.reduce((s, v) => s + Math.cos(v * D2R), 0) / a.length, y = a.reduce((s, v) => s + Math.sin(v * D2R), 0) / a.length;
    return { r: Math.hypot(x, y), mean: Math.atan2(y, x) / D2R };
  };
  const both = photos.filter((m) => m.gimbalYaw != null && m.yaw != null && (m.gimbalPitch == null || m.gimbalPitch < -75));
  if (both.length < 6) return 'abs';
  const g = circ(both.map((m) => m.gimbalYaw)), f = circ(both.map((m) => m.yaw));
  return g.r > 0.97 && Math.abs(g.mean) < 15 && f.r < 0.7 ? 'rel' : 'abs';
}

/** Ar statmena (žemyn) nuotrauka. Jei kampas nežinomas, o kitų nuotraukų – žinomas, laikoma nežinoma (nepiešiama). */
export const isNadir = (m, anyPitch = false) => (m.gimbalPitch == null ? !anyPitch : m.gimbalPitch < -75);

/** Nuotraukos pėdsakas žemėje (statmena nuotrauka): centras, kryptys ir dydis metrais. */
export function footprint(m, toEN, fallbackAgl, { yaw = 'abs', anyPitch = false } = {}) {
  const [e, n] = toEN(m.lon, m.lat);
  const agl = m.relAlt > 2 ? m.relAlt : fallbackAgl;
  const w = m.width || 4000, h = m.height || 3000;
  // 35 mm ekvivalentas skaičiuojamas pagal 4:3 jutiklio įstrižainę (16:9 kadras – apkirptas 4:3)
  const hEff = Math.max(h, (w * 3) / 4);
  const gsd = agl && m.f35 ? (agl * (43.27 / m.f35)) / Math.hypot(w, hEff) : null;
  const heading = (yaw === 'rel' ? (m.yaw ?? 0) + (m.gimbalYaw ?? 0) : m.gimbalYaw ?? m.yaw ?? 0) * D2R;
  const nadir = isNadir(m, anyPitch);
  const up = [Math.sin(heading), Math.cos(heading)], right = [Math.cos(heading), -Math.sin(heading)];
  const W = gsd ? gsd * w : 0, H = gsd ? gsd * h : 0;
  const corners = gsd
    ? [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([a, b]) => [e + (right[0] * a * W) / 2 + (up[0] * b * H) / 2, n + (right[1] * a * W) / 2 + (up[1] * b * H) / 2])
    : null;
  return { e, n, gsd, W, H, up, right, nadir, corners, imgW: w, imgH: h };
}

// --- Geometrija ---
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function segX(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
export function polysIntersect(P, Q) {
  if (P.some(([x, y]) => pointInPoly(x, y, Q)) || Q.some(([x, y]) => pointInPoly(x, y, P))) return true;
  for (let i = 0; i < P.length; i++) for (let j = 0; j < Q.length; j++) if (segX(P[i], P[(i + 1) % P.length], Q[j], Q[(j + 1) % Q.length])) return true;
  return false;
}
const polyArea = (P) => Math.abs(P.reduce((s, [x, y], i) => s + x * P[(i + 1) % P.length][1] - P[(i + 1) % P.length][0] * y, 0)) / 2;

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Daugiakampio apkarpymas pusplokštuma (p − m)·d ≤ 0 (Sutherland–Hodgman). */
function clipHalf(P, mx, my, dx, dy) {
  const out = [];
  const side = ([x, y]) => (x - mx) * dx + (y - my) * dy;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    const sa = side(a), sb = side(b);
    if (sa <= 0) out.push(a);
    if (sa * sb < 0) {
      const k = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
    }
  }
  return out;
}

/**
 * Mozaika „arčiausias kadro centras“: kiekviena statmena nuotrauka piešiama tik savo Voronojaus langelyje
 * (ten, kur ji – arčiausiai), apkarpytame centrine kadro dalimi. Siūlės – per vidurį tarp kadrų, todėl
 * nedideli GPS / aukščio netikslumai mažiau matomi, o kraštų iškraipymai (ir pastatų šonai) – nerodomi.
 */
export function voronoiCells(fp) {
  const idx = fp.map((f, i) => i).filter((i) => fp[i].gsd && fp[i].nadir);
  const cells = new Map();
  if (!idx.length) return cells;
  const R = Math.max(...idx.map((i) => Math.hypot(fp[i].W, fp[i].H)));
  // Tinklelis kaimynų paieškai
  const grid = new Map();
  const key = (x, y) => `${Math.floor(x / R)},${Math.floor(y / R)}`;
  for (const i of idx) {
    const k = key(fp[i].e, fp[i].n);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  for (const i of idx) {
    const f = fp[i];
    // Centrinė kadro dalis (kraštai labiausiai iškraipyti)
    const c = 0.9;
    let P = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([a, b]) => [f.e + (f.right[0] * a * f.W * c) / 2 + (f.up[0] * b * f.H * c) / 2, f.n + (f.right[1] * a * f.W * c) / 2 + (f.up[1] * b * f.H * c) / 2]);
    const gx = Math.floor(f.e / R), gy = Math.floor(f.n / R);
    for (let x = gx - 1; x <= gx + 1 && P.length; x++)
      for (let y = gy - 1; y <= gy + 1 && P.length; y++)
        for (const j of grid.get(`${x},${y}`) || []) {
          if (j === i) continue;
          const g = fp[j];
          const dx = g.e - f.e, dy = g.n - f.n;
          if (dx * dx + dy * dy < 1e-6) {
            if (j < i) P = []; // ta pati vieta – lieka viena
            continue;
          }
          P = clipHalf(P, (f.e + g.e) / 2, (f.n + g.n) / 2, dx, dy);
          if (!P.length) break;
        }
    if (P.length >= 3) cells.set(i, P);
  }
  return cells;
}

// Nuotraukų atranka pagal sritį
const CORE = 0.6; // sritis turi patekti į centrinę kadro dalį (60 % pločio ir aukščio) – ten ji tikrai matosi
const MIN_VIEWS = 5; // kiekvieną srities tašką turi matyti bent tiek atrinktų nuotraukų (ODM užtenka 3–5)
const SAMPLES = 400; // tikrinamų srities taškų skaičius

export class PhotoPreview {
  /**
   * @param {HTMLElement} host – konteineris (canvas + įrankių juosta)
   * @param {object[]} photos – analysis.used (su lat, lon, relAlt, f35, gimbalYaw…)
   * @param {{agl?:number, onChange?:()=>void, rtkColor?:(m:object)=>string, tooltip?:(m:object)=>string}} opts
   */
  constructor(host, photos, opts = {}) {
    this.host = host;
    this.photos = photos;
    this.opts = opts;
    const lat0 = photos.reduce((s, m) => s + m.lat, 0) / photos.length;
    const lon0 = photos.reduce((s, m) => s + m.lon, 0) / photos.length;
    this.lat0 = lat0;
    this.proj = localProjection(lat0, lon0);
    const ctx = { yaw: yawMode(photos), anyPitch: photos.some((m) => m.gimbalPitch != null) };
    this.yawMode = ctx.yaw;
    this.fp = photos.map((m) => footprint(m, this.proj.toEN, opts.agl, ctx));
    this.cells = voronoiCells(this.fp);
    this.thumbs = new Map(); // indeksas -> ImageBitmap
    this.tiles = new Map(); // z/x/y -> Image
    this.poly = []; // pasirinkta sritis (E, N)
    this.closed = false;
    this.drawing = false;
    this.showMap = true;
    this.showPhotos = true;
    this.showPoints = true;
    this.mode = 'visible'; // 'visible' – sritis matosi kadro centre; 'all' – visos, bent kraštu liečiančios sritį
    this._sel = null;
    this._raf = 0;

    host.innerHTML = `
      <div class="pv-toolbar">
        <button class="btn btn-sm btn-primary" data-pv="draw">${t('Žymėti sritį')}</button>
        <button class="btn btn-sm btn-outline" data-pv="all">${t('Visa teritorija')}</button>
        <label class="check small"><input type="checkbox" data-pv="photos" checked /> ${t('Nuotraukos')}</label>
        <label class="check small"><input type="checkbox" data-pv="map" checked /> ${t('Žemėlapis')}</label>
        <label class="check small"><input type="checkbox" data-pv="points" checked /> ${t('Kadrų vietos')}</label>
        <label class="small pv-mode">${t('Nuotraukos:')}
          <select data-pv="mode">
            <option value="visible">${t('kuriose sritis aiškiai matosi (greičiau)')}</option>
            <option value="all">${t('visos, bent kraštu liečiančios sritį')}</option>
          </select>
        </label>
        <span class="pv-status small muted"></span>
      </div>
      <div class="pv-canvas-wrap">
        <canvas class="pv-canvas"></canvas>
        <div class="pv-hint small"></div>
        <div class="odm-map-tip small" hidden></div>
      </div>`;
    this.cv = host.querySelector('.pv-canvas');
    this.hint = host.querySelector('.pv-hint');
    this.tip = host.querySelector('.odm-map-tip');
    this.status = host.querySelector('.pv-status');
    host.querySelector('[data-pv=draw]').onclick = () => this.startDrawing();
    host.querySelector('[data-pv=all]').onclick = () => this.clearSelection();
    host.querySelector('[data-pv=photos]').onchange = (e) => ((this.showPhotos = e.target.checked), this.redraw());
    host.querySelector('[data-pv=map]').onchange = (e) => ((this.showMap = e.target.checked), this.redraw());
    host.querySelector('[data-pv=points]').onchange = (e) => ((this.showPoints = e.target.checked), this.redraw());
    host.querySelector('[data-pv=mode]').onchange = (e) => {
      this.mode = e.target.value;
      this._changed();
    };
    this._bindInput();
    this.fit();
    this._updateHint();
    new ResizeObserver(() => this.redraw()).observe(this.cv.parentElement);
    this._loadThumbs();
  }

  // ------------------------------------------------------------ Vaizdas
  fit() {
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const f of this.fp) for (const [e, n] of f.corners || [[f.e, f.n]]) {
      minE = Math.min(minE, e); maxE = Math.max(maxE, e);
      minN = Math.min(minN, n); maxN = Math.max(maxN, n);
    }
    const W = this.cv.parentElement.clientWidth || 800, H = this.cv.parentElement.clientHeight || 420;
    this.scale = Math.min((W - 30) / Math.max(maxE - minE, 1), (H - 30) / Math.max(maxN - minN, 1));
    this.cE = (minE + maxE) / 2;
    this.cN = (minN + maxN) / 2;
  }

  toScreen(e, n) {
    return [this.W / 2 + (e - this.cE) * this.scale, this.H / 2 - (n - this.cN) * this.scale];
  }
  toEN(x, y) {
    return [this.cE + (x - this.W / 2) / this.scale, this.cN - (y - this.H / 2) / this.scale];
  }

  redraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._draw();
    });
  }

  _draw() {
    const cv = this.cv, wrap = cv.parentElement;
    const W = wrap.clientWidth, H = wrap.clientHeight, dpr = devicePixelRatio || 1;
    if (!W || !H) return;
    this.W = W;
    this.H = H;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#16191b';
    g.fillRect(0, 0, W, H);
    if (this.showMap) this._drawTiles(g, dpr);
    if (this.showPhotos) this._drawPhotos(g, dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Nepasirinkta dalis patamsinama
    if (this.closed && this.poly.length >= 3) {
      g.fillStyle = 'rgba(10,12,13,0.55)';
      g.beginPath();
      g.rect(0, 0, W, H);
      this.poly.forEach(([e, n], i) => (i ? g.lineTo(...this.toScreen(e, n)) : g.moveTo(...this.toScreen(e, n))));
      g.closePath();
      g.fill('evenodd');
    }
    if (this.showPoints) this._drawPoints(g);
    this._drawPoly(g);
    this._drawScale(g);
  }

  _drawPhotos(g, dpr) {
    const sel = this.hasSelection ? this.selectedSet() : null;
    // Atmestos – pirmiau ir pritemdytos, atrinktos – virš jų
    const order = this.fp.map((_, i) => i).sort((a, b) => (sel ? sel.has(a) - sel.has(b) : 0) || (this.photos[a].date?.getTime() || 0) - (this.photos[b].date?.getTime() || 0));
    for (const i of order) {
      g.globalAlpha = sel && !sel.has(i) ? 0.3 : 1;
      const f = this.fp[i], bmp = this.thumbs.get(i);
      if (!f.gsd || !f.nadir) continue;
      const s = this.scale;
      if (!bmp) {
        // Dar neįkelta – pėdsako kontūras
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.strokeStyle = 'rgba(255,255,255,0.12)';
        g.beginPath();
        f.corners.forEach(([e, n], k) => (k ? g.lineTo(...this.toScreen(e, n)) : g.moveTo(...this.toScreen(e, n))));
        g.closePath();
        g.stroke();
        continue;
      }
      const cell = this.cells.get(i);
      if (!cell) continue;
      // Apkarpoma savo langeliu (truputį praplėstu, kad tarp langelių neliktų plyšių)
      g.save();
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const C = cell.map(([e, n]) => this.toScreen(e, n));
      const cx0 = C.reduce((a, p) => a + p[0], 0) / C.length, cy0 = C.reduce((a, p) => a + p[1], 0) / C.length;
      g.beginPath();
      C.forEach(([x, y], k) => {
        const d = Math.hypot(x - cx0, y - cy0) || 1;
        const px = x + ((x - cx0) / d) * 0.8, py = y + ((y - cy0) / d) * 0.8;
        k ? g.lineTo(px, py) : g.moveTo(px, py);
      });
      g.closePath();
      g.clip();
      const k = (f.gsd * f.imgW) / bmp.width; // metrų miniatiūros pikseliui
      const [x0, y0] = this.toScreen(f.e - (f.right[0] * f.W) / 2 + (f.up[0] * f.H) / 2, f.n - (f.right[1] * f.W) / 2 + (f.up[1] * f.H) / 2);
      g.setTransform(dpr * s * k * f.right[0], -dpr * s * k * f.right[1], -dpr * s * k * f.up[0], dpr * s * k * f.up[1], dpr * x0, dpr * y0);
      g.drawImage(bmp, 0, 0);
      g.restore();
    }
    g.globalAlpha = 1;
  }

  _drawTiles(g, dpr) {
    const src = BASEMAPS.satellite;
    // Priartinimo lygis pagal mastelį (256 px plytelė ≈ 256 ekrano px)
    const mPerPx = 1 / this.scale;
    const z = Math.max(1, Math.min(src.maxZoom, Math.round(Math.log2((40075016 * Math.cos(this.lat0 * D2R)) / (256 * mPerPx)))));
    const n2 = 2 ** z;
    const [lonW, latN] = this.proj.toLonLat(...this.toEN(0, 0));
    const [lonE, latS] = this.proj.toLonLat(...this.toEN(this.W, this.H));
    const tx = (lon) => ((lon + 180) / 360) * n2;
    const ty = (lat) => ((1 - Math.log(Math.tan(lat * D2R) + 1 / Math.cos(lat * D2R)) / Math.PI) / 2) * n2;
    const x2lon = (x) => (x / n2) * 360 - 180;
    const y2lat = (y) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n2))) / D2R;
    const x0 = Math.floor(tx(lonW)), x1 = Math.floor(tx(lonE)), y0 = Math.floor(ty(latN)), y1 = Math.floor(ty(latS));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 120) return;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = `${z}/${x}/${y}`;
        let img = this.tiles.get(key);
        if (!img) {
          img = new Image();
          img.onload = () => this.redraw();
          img.onerror = () => (img.failed = true);
          img.src = src.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
          this.tiles.set(key, img);
        }
        if (!img.complete || img.failed || !img.naturalWidth) continue;
        const p00 = this.toScreen(...this.proj.toEN(x2lon(x), y2lat(y)));
        const p10 = this.toScreen(...this.proj.toEN(x2lon(x + 1), y2lat(y)));
        const p01 = this.toScreen(...this.proj.toEN(x2lon(x), y2lat(y + 1)));
        g.setTransform(dpr * (p10[0] - p00[0]) / 256, dpr * (p10[1] - p00[1]) / 256, dpr * (p01[0] - p00[0]) / 256, dpr * (p01[1] - p00[1]) / 256, dpr * p00[0], dpr * p00[1]);
        g.drawImage(img, 0, 0, 256, 256);
      }
    }
  }

  _drawPoints(g) {
    const sel = this.closed ? this.selectedSet() : null;
    this.fp.forEach((f, i) => {
      const [x, y] = this.toScreen(f.e, f.n);
      g.fillStyle = sel && !sel.has(i) ? 'rgba(160,160,160,0.6)' : this.opts.rtkColor?.(this.photos[i]) || '#3cc443';
      g.beginPath();
      g.arc(x, y, sel && !sel.has(i) ? 2 : 3, 0, Math.PI * 2);
      g.fill();
    });
  }

  _drawPoly(g) {
    const P = this.poly.map(([e, n]) => this.toScreen(e, n));
    if (!P.length) return;
    g.lineWidth = 2;
    g.strokeStyle = '#00e5ff';
    g.fillStyle = this.closed ? 'rgba(0,229,255,0.06)' : 'rgba(0,229,255,0.12)';
    g.beginPath();
    P.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    if (this.drawing && this._hover) g.lineTo(...this._hover);
    if (this.closed) g.closePath();
    g.fill();
    g.stroke();
    P.forEach(([x, y], i) => {
      g.fillStyle = i === 0 && this.drawing && P.length >= 3 ? '#ffd23f' : '#fff';
      g.beginPath();
      g.arc(x, y, 5, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#00a3b5';
      g.lineWidth = 1.5;
      g.stroke();
    });
  }

  _drawScale(g) {
    const W = this.W, H = this.H;
    const target = (W * 0.18) / this.scale;
    const p10 = 10 ** Math.floor(Math.log10(target));
    const len = [1, 2, 5, 10].map((k) => k * p10).filter((v) => v <= target).pop() || p10;
    g.fillStyle = 'rgba(20,23,25,0.7)';
    g.fillRect(8, H - 34, len * this.scale + 16, 26);
    g.fillStyle = '#e6ebe8';
    g.fillRect(16, H - 16, len * this.scale, 3);
    g.font = '11px Inter, Segoe UI, sans-serif';
    g.fillText(`${new Intl.NumberFormat(locale()).format(len)} m`, 16, H - 21);
    // Šiaurė
    g.beginPath();
    g.moveTo(W - 18, 10);
    g.lineTo(W - 24, 26);
    g.lineTo(W - 12, 26);
    g.closePath();
    g.fill();
    g.fillText(t('Š'), W - 22, 40);
  }

  // ------------------------------------------------------------ Miniatiūros
  async _loadThumbs() {
    const idx = this.fp.map((f, i) => i).filter((i) => this.fp[i].gsd && this.fp[i].nadir);
    const size = idx.length > 300 ? 256 : 384;
    let next = 0, done = 0;
    const worker = async () => {
      while (next < idx.length && !this.disposed) {
        const i = idx[next++];
        try {
          const bmp = await createImageBitmap(this.photos[i].file, { resizeWidth: size, resizeQuality: 'low' });
          if (this.disposed) return bmp.close();
          this.thumbs.set(i, bmp);
        } catch { /* nepavyko iššifruoti – liks kontūras */ }
        done++;
        if (done % 4 === 0 || done === idx.length) {
          this._thumbStatus = done < idx.length ? t('Ruošiama peržiūra: {a} / {b}', { a: done, b: idx.length }) : '';
          this._updateStatus();
          this.redraw();
        }
        await tick();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  dispose() {
    this.disposed = true;
    for (const b of this.thumbs.values()) b.close?.();
    this.thumbs.clear();
  }

  // ------------------------------------------------------------ Sritis
  startDrawing() {
    this.poly = [];
    this.closed = false;
    this.drawing = true;
    this._changed();
  }

  clearSelection() {
    this.poly = [];
    this.closed = false;
    this.drawing = false;
    this._changed();
  }

  _close() {
    if (this.poly.length < 3) return;
    this.drawing = false;
    this.closed = true;
    this._changed();
  }

  _changed() {
    this._updateHint();
    this._updateStatus();
    this.redraw();
    this.opts.onChange?.();
  }

  _updateHint() {
    this.hint.textContent = this.drawing
      ? t('Spustelėkite srities kampus. Uždarykite spustelėję pirmą tašką arba dukart. Esc – atšaukti.')
      : this.closed
        ? t('Taškus galima tempti. Ratukas – priartinti, tempimas – slinkti.')
        : t('Ratukas – priartinti, tempimas – slinkti. „Žymėti sritį“ – pasirinkti, ką apdoroti.');
  }

  _updateStatus() {
    const parts = [];
    if (this._thumbStatus) parts.push(this._thumbStatus);
    if (this.closed) {
      const n = this.selectedSet().size;
      parts.push(t('Sritis {a} ha · nuotraukų: {n} iš {m}', { a: new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(polyArea(this.poly) / 1e4), n, m: this.photos.length }));
      if (this._minViews != null) parts.push(t('kiekvieną srities tašką mato ≥ {k} nuotr.', { k: this._minViews }));
    }
    this.status.textContent = parts.join(' · ');
  }

  get hasSelection() {
    return this.closed && this.poly.length >= 3;
  }

  /**
   * Nuotraukos, kurių reikia pasirinktai sričiai (atranka vyksta naršyklėje, prieš įkeliant į serverį).
   * „visible“: sritis patenka į centrinę kadro dalį; po to tikrinama, ar kiekvieną srities tašką mato
   * bent MIN_VIEWS nuotraukų – jei ne, pridedamos artimiausios jį matančios. „all“: visos, kurių pėdsakas
   * bent kraštu liečia sritį. Nuotraukos, kurios srities visai nemato, neįtraukiamos niekada.
   */
  selectedSet() {
    if (!this.hasSelection) return new Set(this.fp.map((_, i) => i));
    const key = `${this.mode}|${this.poly.map((p) => p.join(',')).join(';')}`;
    if (this._sel?.key === key) return this._sel.set;
    const out = new Set();
    const touching = [];
    this.fp.forEach((f, i) => {
      // Be pėdsako (nėra aukščio / objektyvo) arba įstriža nuotrauka – paliekame (gali matyti sritį iš toliau)
      if (!f.corners || !f.nadir) return out.add(i);
      if (!polysIntersect(f.corners, this.poly)) return; // srities nemato
      touching.push(i);
      if (this.mode === 'all') return out.add(i);
      const core = f.corners.map(([e, n]) => [f.e + (e - f.e) * CORE, f.n + (n - f.n) * CORE]);
      if (polysIntersect(core, this.poly)) out.add(i);
    });
    // Padengimo patikra srities taškuose
    const pts = this._samplePoints();
    const sees = (i, [x, y]) => this.fp[i].corners && pointInPoly(x, y, this.fp[i].corners);
    let minViews = Infinity;
    for (const p of pts) {
      let n = 0;
      for (const i of out) if (sees(i, p)) n++;
      if (n < MIN_VIEWS && this.mode !== 'all') {
        const extra = touching.filter((i) => !out.has(i) && sees(i, p)).sort((a, b) => Math.hypot(this.fp[a].e - p[0], this.fp[a].n - p[1]) - Math.hypot(this.fp[b].e - p[0], this.fp[b].n - p[1]));
        for (const i of extra) {
          if (n >= MIN_VIEWS) break;
          out.add(i);
          n++;
        }
      }
      minViews = Math.min(minViews, n);
    }
    this._minViews = pts.length ? minViews : null;
    this._sel = { key, set: out };
    return out;
  }

  /** Tolygiai išdėstyti taškai srities viduje. */
  _samplePoints() {
    const P = this.poly;
    const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
    const step = Math.max(Math.sqrt(polyArea(P) / SAMPLES), 0.5);
    const out = [];
    for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step)
      for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step) if (pointInPoly(x, y, P)) out.push([x, y]);
    // Ir patys kampai – kraštai svarbiausi
    return out.concat(P.map(([x, y]) => [x, y]));
  }

  selectedPhotos() {
    const s = this.selectedSet();
    return this.photos.filter((_, i) => s.has(i));
  }

  /** Sritis kaip GeoJSON (WGS84) – ODM parinkčiai „boundary“. */
  boundaryGeoJSON() {
    if (!this.hasSelection) return null;
    const ring = this.poly.map(([e, n]) => this.proj.toLonLat(e, n).map((v) => +v.toFixed(8)));
    ring.push(ring[0]);
    return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] };
  }

  get areaM2() {
    return this.hasSelection ? polyArea(this.poly) : 0;
  }

  // ------------------------------------------------------------ Valdymas
  _bindInput() {
    const cv = this.cv;
    let down = null; // {x, y, cE, cN, vertex, moved}
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const vertexAt = (x, y) => this.poly.findIndex(([e, n]) => {
      const [px, py] = this.toScreen(e, n);
      return (px - x) ** 2 + (py - y) ** 2 < 81;
    });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = pos(e);
      const before = this.toEN(x, y);
      this.scale *= Math.exp(-e.deltaY * 0.0015);
      this.scale = Math.min(Math.max(this.scale, 0.02), 200);
      const after = this.toEN(x, y);
      this.cE += before[0] - after[0];
      this.cN += before[1] - after[1];
      this.redraw();
    }, { passive: false });
    cv.addEventListener('pointerdown', (e) => {
      const [x, y] = pos(e);
      cv.setPointerCapture(e.pointerId);
      down = { x, y, cE: this.cE, cN: this.cN, vertex: this.closed ? vertexAt(x, y) : -1, moved: false };
    });
    cv.addEventListener('pointermove', (e) => {
      const [x, y] = pos(e);
      if (down) {
        if (Math.hypot(x - down.x, y - down.y) > 4) down.moved = true;
        if (down.vertex >= 0) {
          this.poly[down.vertex] = this.toEN(x, y);
          this._updateStatus();
          this.redraw();
        } else if (down.moved) {
          this.cE = down.cE - (x - down.x) / this.scale;
          this.cN = down.cN + (y - down.y) / this.scale;
          this.redraw();
        }
        return;
      }
      if (this.drawing) {
        this._hover = [x, y];
        this.redraw();
      }
      cv.style.cursor = this.drawing ? 'crosshair' : this.closed && vertexAt(x, y) >= 0 ? 'move' : 'grab';
      this._tooltip(x, y);
    });
    cv.addEventListener('pointerup', (e) => {
      const [x, y] = pos(e);
      const d = down;
      down = null;
      if (!d) return;
      if (d.vertex >= 0) return this._changed();
      if (d.moved || !this.drawing) return;
      // Spustelėjimas ant pirmo taško – uždaro
      if (this.poly.length >= 3 && vertexAt(x, y) === 0) return this._close();
      this.poly.push(this.toEN(x, y));
      this._changed();
    });
    cv.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (!this.drawing) return;
      // dblclick prideda du taškus (du spustelėjimai) – antrąjį pašaliname
      if (this.poly.length > 3) this.poly.pop();
      this._close();
    });
    cv.addEventListener('pointerleave', () => {
      this._hover = null;
      this.tip.hidden = true;
      this.redraw();
    });
    this._onKey = (e) => {
      if (e.key === 'Escape' && this.drawing && this.host.isConnected) {
        e.stopPropagation();
        this.clearSelection();
      }
    };
    window.addEventListener('keydown', this._onKey, true);
  }

  _tooltip(x, y) {
    if (!this.opts.tooltip || !this.showPoints) return;
    let best = -1, bd = 49;
    this.fp.forEach((f, i) => {
      const [px, py] = this.toScreen(f.e, f.n);
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    if (best < 0 || this.drawing) return (this.tip.hidden = true);
    this.tip.hidden = false;
    this.tip.style.left = `${x + 12}px`;
    this.tip.style.top = `${y + 12}px`;
    this.tip.innerHTML = this.opts.tooltip(this.photos[best]);
  }
}
