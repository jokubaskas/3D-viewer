// Ortofoto (GeoTIFF) žemėlapyje: skaitomos tik matomos dalys pagal mastelį (iš peržiūros lygių, jei jie yra),
// plytelės perskaičiuojamos iš rastro koordinačių sistemos (UTM, LKS-94, WGS84, Web Mercator) į žemėlapį.
// Failas gali būti adresas (skaitoma dalimis per HTTP Range – nereikia atsisiųsti viso) arba vietinis failas.
import { t } from '../i18n.js';
import { LKS94, UTM } from '../geo/tm.js';

const TILE = 256;
const D2R = Math.PI / 180;
const R = 6378137;

/** Koordinačių sistema pagal EPSG kodą: [E, N] ↔ [lon, lat]. */
export function crsFor(epsg) {
  if (epsg === 3346) return { epsg, name: 'LKS-94 (EPSG:3346)', toLL: (e, n) => LKS94.inverse(e, n), fromLL: (lon, lat) => LKS94.forward(lon, lat), meters: true };
  if (epsg >= 32601 && epsg <= 32660) {
    const z = epsg - 32600;
    return { epsg, name: `WGS84 / UTM ${z}N (EPSG:${epsg})`, toLL: (e, n) => UTM(z).inverse(e, n), fromLL: (lon, lat) => UTM(z).forward(lon, lat), meters: true };
  }
  if (epsg >= 32701 && epsg <= 32760) {
    const z = epsg - 32700;
    return { epsg, name: `WGS84 / UTM ${z}S (EPSG:${epsg})`, toLL: (e, n) => UTM(z).inverse(e, n - 1e7), fromLL: (lon, lat) => { const [e, n] = UTM(z).forward(lon, lat); return [e, n + 1e7]; }, meters: true };
  }
  if (epsg === 3857 || epsg === 900913 || epsg === 3785) {
    return {
      epsg,
      name: `Web Mercator (EPSG:${epsg})`,
      toLL: (x, y) => [x / R / D2R, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / D2R],
      fromLL: (lon, lat) => [lon * D2R * R, Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) * R],
      meters: true,
    };
  }
  if (epsg === 4326 || epsg === 4258 || epsg === 4979) return { epsg, name: `WGS84 (EPSG:${epsg})`, toLL: (x, y) => [x, y], fromLL: (lon, lat) => [lon, lat], meters: false };
  return null;
}

function epsgOf(image) {
  const k = image.getGeoKeys() || {};
  const code = k.ProjectedCSTypeGeoKey || (k.GTModelTypeGeoKey === 2 ? k.GeographicTypeGeoKey || 4326 : null) || k.GeographicTypeGeoKey;
  if (code && code !== 32767) return code;
  // Vartotojo apibrėžta (32767): atpažįstame iš pavadinimo
  const cit = `${k.GTCitationGeoKey || ''} ${k.PCSCitationGeoKey || ''}`;
  const utm = /UTM zone (\d+)([NS])/i.exec(cit);
  if (utm) return (utm[2].toUpperCase() === 'N' ? 32600 : 32700) + +utm[1];
  if (/LKS[ -]?94|Lithuania 1994/i.test(cit)) return 3346;
  return null;
}

/**
 * @param {string|Blob} src adresas arba failas
 * @returns {Promise<OrthoRaster>}
 */
export async function openOrtho(src, name = '') {
  const { fromUrl, fromBlob } = await import('geotiff');
  const tiff = typeof src === 'string' ? await fromUrl(src, { allowFullFile: false, blockSize: 1 << 16, cacheSize: 400 }) : await fromBlob(src);
  const main = await tiff.getImage(0);
  const n = await tiff.getImageCount();
  const images = [main];
  for (let i = 1; i < n; i++) {
    const im = await tiff.getImage(i);
    const sub = im.fileDirectory.NewSubfileType || 0;
    // Peržiūros lygiai (ne kaukės): mažesni už pagrindinį, tos pačios proporcijos
    if (sub & 4) continue;
    if (im.getWidth() < main.getWidth() && im.getSamplesPerPixel() === main.getSamplesPerPixel()) images.push(im);
  }
  images.sort((a, b) => b.getWidth() - a.getWidth());
  const bits = main.getBitsPerSample();
  if (bits !== 8) throw new Error(t('Tai ne ortofoto: palaikomi 8 bitų RGB / RGBA / pilkų tonų GeoTIFF (šio failo – {b} bitų, pvz. aukščių modelis).', { b: bits }));
  const epsg = epsgOf(main);
  const crs = crsFor(epsg);
  if (!crs) throw new Error(epsg ? t('Nepalaikoma koordinačių sistema EPSG:{e} (palaikomos UTM, LKS-94, WGS84, Web Mercator).', { e: epsg }) : t('GeoTIFF faile nėra koordinačių sistemos.'));
  return new OrthoRaster({ tiff, images, crs, name, src });
}

export class OrthoRaster {
  constructor({ tiff, images, crs, name, src }) {
    this.tiff = tiff;
    this.images = images;
    this.crs = crs;
    this.name = name;
    this.src = src;
    const m = images[0];
    this.width = m.getWidth();
    this.height = m.getHeight();
    this.samples = m.getSamplesPerPixel();
    [this.ox, this.oy] = m.getOrigin();
    [this.rx, this.ry] = m.getResolution(); // ry < 0
    this.nodata = m.getGDALNoData();
    this.maxLevel = Math.max(0, Math.ceil(Math.log2(Math.max(this.width, this.height) / TILE)));
    this.cache = new Map(); // "L/x/y" → {bmp, last} | {pending}
    this.onTile = null; // kviečiama, kai plytelė paruošta (perpiešti)
    this.queue = [];
    this.active = 0;
    this.gen = 0;
    // Krašto taškai lon/lat (srities rėmas, mastelis)
    const P = [[0, 0], [this.width, 0], [this.width, this.height], [0, this.height]].map(([x, y]) => this.pixToLL(x, y));
    this.outline = P;
    const [lon0, lat0] = this.pixToLL(this.width / 2, this.height / 2);
    this.center = [lon0, lat0];
    // Pikselio dydis metrais (WGS84 rastrui – apytiksliai pagal centrą)
    this.res = crs.meters ? Math.abs(this.rx) : Math.abs(this.rx) * D2R * 6371008 * Math.cos(lat0 * D2R);
  }

  get hasOverviews() {
    return this.images.length > 1;
  }
  get areaM2() {
    return this.width * this.height * this.res * this.res;
  }

  pixToLL(x, y) {
    return this.crs.toLL(this.ox + x * this.rx, this.oy + y * this.ry);
  }
  llToPix(lon, lat) {
    const [e, n] = this.crs.fromLL(lon, lat);
    return [(e - this.ox) / this.rx, (n - this.oy) / this.ry];
  }

  /** Piešia matomas plyteles į žemėlapį (PlanMap). */
  draw(g, map, opacity = 1) {
    const dpr = devicePixelRatio || 1;
    // Lygis: kiek rastro pikselių tenka ekrano pikseliui
    const f = map.mPerPx / dpr / this.res;
    let L = Math.min(this.maxLevel, Math.max(0, Math.floor(Math.log2(Math.max(f, 1e-9)))));
    // Matoma rastro sritis
    const corners = [[0, 0], [map.W, 0], [map.W, map.H], [0, map.H]].map(([x, y]) => this.llToPix(...map.toLL(x, y)));
    const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
    const px0 = Math.max(0, Math.min(...xs)), px1 = Math.min(this.width, Math.max(...xs));
    const py0 = Math.max(0, Math.min(...ys)), py1 = Math.min(this.height, Math.max(...ys));
    if (px1 <= px0 || py1 <= py0) return;
    let range;
    for (;;) {
      const S = TILE * 2 ** L;
      range = [Math.floor(px0 / S), Math.floor((px1 - 1e-6) / S), Math.floor(py0 / S), Math.floor((py1 - 1e-6) / S)];
      if ((range[1] - range[0] + 1) * (range[3] - range[2] + 1) <= 80 || L >= this.maxLevel) break;
      L++;
    }
    g.save();
    g.globalAlpha = opacity;
    g.imageSmoothingQuality = 'high';
    // Pirma – stambesnių lygių jau turimos plytelės (kol kraunasi smulkesnės), paskui – reikiamas lygis
    for (let l = this.maxLevel; l > L; l--) this._drawLevel(g, map, l, px0, px1, py0, py1, false);
    this._drawLevel(g, map, L, px0, px1, py0, py1, true);
    g.restore();
    this._pump();
  }

  _drawLevel(g, map, L, px0, px1, py0, py1, load) {
    const S = TILE * 2 ** L;
    const now = performance.now();
    const want = [];
    for (let ty = Math.floor(py0 / S); ty <= Math.floor((py1 - 1e-6) / S); ty++) {
      for (let tx = Math.floor(px0 / S); tx <= Math.floor((px1 - 1e-6) / S); tx++) {
        const key = `${L}/${tx}/${ty}`;
        const c = this.cache.get(key);
        if (c?.bmp) {
          c.last = now;
          this._drawTile(g, map, c, tx * S, ty * S);
        } else if (load && !c) want.push({ key, L, tx, ty, d: Math.hypot(tx * S + S / 2 - (px0 + px1) / 2, ty * S + S / 2 - (py0 + py1) / 2) });
      }
    }
    if (!load) return;
    // Nauja peržiūra – senos eilės nebereikia; arčiau centro – pirmiau
    this.gen++;
    this.queue = want.sort((a, b) => a.d - b.d).map((w) => ({ ...w, gen: this.gen }));
  }

  _drawTile(g, map, c, x0, y0) {
    // Plytelė – afininė transformacija pagal tris kampus (kiekvienai plytelei atskirai – kreivumas įskaitomas)
    const x1 = x0 + c.pw, y1 = y0 + c.ph;
    const [ax, ay] = map.toScreen(this.pixToLL(x0, y0));
    const [bx, by] = map.toScreen(this.pixToLL(x1, y0));
    const [dx, dy] = map.toScreen(this.pixToLL(x0, y1));
    const w = c.bmp.width, h = c.bmp.height;
    // Nedidelis persidengimas, kad tarp plytelių neliktų plyšių
    const ex = 0.6 / Math.max(1, Math.hypot(bx - ax, by - ay)) * w, ey = 0.6 / Math.max(1, Math.hypot(dx - ax, dy - ay)) * h;
    const dpr = devicePixelRatio || 1;
    g.setTransform(((bx - ax) / w) * dpr, ((by - ay) / w) * dpr, ((dx - ax) / h) * dpr, ((dy - ay) / h) * dpr, ax * dpr, ay * dpr);
    g.drawImage(c.bmp, 0, 0, w + ex, h + ey);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _pump() {
    while (this.active < 4 && this.queue.length) {
      const job = this.queue.shift();
      if (this.cache.has(job.key)) continue;
      this.cache.set(job.key, { pending: true });
      this.active++;
      this._load(job)
        .then((c) => {
          this.cache.set(job.key, c);
          this._trim();
        })
        .catch((e) => {
          this.cache.set(job.key, { failed: true }); // nekartojama be galo
          this.onError?.(e);
        })
        .finally(() => {
          this.active--;
          this._pump();
          this.onTile?.();
        });
    }
  }

  async _load({ L, tx, ty }) {
    const k = 2 ** L;
    const S = TILE * k;
    const x0 = tx * S, y0 = ty * S;
    const x1 = Math.min(this.width, x0 + S), y1 = Math.min(this.height, y0 + S);
    const w = Math.max(1, Math.round((x1 - x0) / k)), h = Math.max(1, Math.round((y1 - y0) / k));
    // Stambiausias peržiūros lygis, kurio raiška dar pakankama
    let im = this.images[0];
    for (const cand of this.images) if (this.width / cand.getWidth() <= k * 1.001) im = cand;
    const sx = im.getWidth() / this.width, sy = im.getHeight() / this.height;
    const win = [Math.floor(x0 * sx), Math.floor(y0 * sy), Math.min(im.getWidth(), Math.ceil(x1 * sx)), Math.min(im.getHeight(), Math.ceil(y1 * sy))];
    const data = await im.readRasters({ window: win, width: w, height: h, interleave: true, resampleMethod: 'bilinear' });
    const rgba = new Uint8ClampedArray(w * h * 4);
    const s = this.samples;
    const nd = this.nodata;
    for (let i = 0, j = 0; i < w * h; i++, j += s) {
      const o = i * 4;
      if (s >= 3) {
        rgba[o] = data[j];
        rgba[o + 1] = data[j + 1];
        rgba[o + 2] = data[j + 2];
        rgba[o + 3] = s >= 4 ? data[j + 3] : nd != null && data[j] === nd && data[j + 1] === nd && data[j + 2] === nd ? 0 : 255;
      } else {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = data[j];
        rgba[o + 3] = s === 2 ? data[j + 1] : nd != null && data[j] === nd ? 0 : 255;
      }
    }
    const bmp = await createImageBitmap(new ImageData(rgba, w, h));
    return { bmp, pw: x1 - x0, ph: y1 - y0, last: performance.now() };
  }

  _trim() {
    if (this.cache.size <= 400) return;
    const done = [...this.cache.entries()].filter(([, c]) => c.bmp).sort((a, b) => a[1].last - b[1].last);
    for (const [k, c] of done.slice(0, this.cache.size - 300)) {
      c.bmp.close();
      this.cache.delete(k);
    }
  }

  dispose() {
    this.queue = [];
    for (const c of this.cache.values()) c.bmp?.close();
    this.cache.clear();
    this.tiff?.close?.();
  }
}
