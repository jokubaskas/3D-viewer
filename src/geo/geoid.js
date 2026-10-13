import { t } from '../i18n.js';
// Geoido (kvazigeoido) aukščių modelis: elipsoidinis h -> normalinis H = h − N.
// Lietuvoje naudojama LAS07 aukščių sistema ir kvazigeoido modelis LIT15G.
// Modelio failas su programa neplatinamas – jį galima įkelti (GTX, Gravsoft .gri/.grd arba tekstinis „platuma ilguma N“).

export class GeoidGrid {
  /** @param {{lat0:number, lon0:number, dlat:number, dlon:number, rows:number, cols:number, data:Float32Array, name:string}} g – eilutės nuo pietų į šiaurę */
  constructor(g) {
    Object.assign(this, g);
  }

  covers(lat, lon) {
    return lat >= this.lat0 && lat <= this.lat0 + (this.rows - 1) * this.dlat && lon >= this.lon0 && lon <= this.lon0 + (this.cols - 1) * this.dlon;
  }

  /** Bilinijinė interpoliacija; NaN – už ribų. */
  undulation(lat, lon) {
    const fy = (lat - this.lat0) / this.dlat, fx = (lon - this.lon0) / this.dlon;
    const i = Math.floor(fy), j = Math.floor(fx);
    if (i < 0 || j < 0 || i >= this.rows - 1 || j >= this.cols - 1) {
      if (i === this.rows - 1 || j === this.cols - 1) return this.data[Math.min(i, this.rows - 1) * this.cols + Math.min(j, this.cols - 1)];
      return NaN;
    }
    const ty = fy - i, tx = fx - j;
    const v = (r, c) => this.data[r * this.cols + c];
    const a = v(i, j), b = v(i, j + 1), c = v(i + 1, j), d = v(i + 1, j + 1);
    if ([a, b, c, d].some((x) => !isFinite(x) || Math.abs(x) > 1000)) return NaN;
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  }
}

/** Įkelia geoido tinklelį iš failo. */
export async function loadGeoidFile(file) {
  const name = file.name;
  const lower = name.toLowerCase();
  if (lower.endsWith('.gtx')) return parseGtx(await file.arrayBuffer(), name);
  const text = await file.text();
  return parseGravsoft(text, name) || parseXyzGrid(text, name);
}

// NOAA/PROJ GTX: big-endian, antraštė lat0 lon0 dlat dlon (double), rows cols (int32), tada float32 reikšmės nuo pietų.
function parseGtx(buf, name) {
  const dv = new DataView(buf);
  const lat0 = dv.getFloat64(0), lon0n = dv.getFloat64(8), dlat = dv.getFloat64(16), dlon = dv.getFloat64(24);
  const rows = dv.getInt32(32), cols = dv.getInt32(36);
  if (!(rows > 1 && cols > 1) || 40 + rows * cols * 4 > buf.byteLength) throw new Error(t('Netinkamas GTX failas'));
  const data = new Float32Array(rows * cols);
  for (let k = 0; k < rows * cols; k++) data[k] = dv.getFloat32(40 + k * 4);
  const lon0 = lon0n > 180 ? lon0n - 360 : lon0n;
  return new GeoidGrid({ lat0, lon0, dlat, dlon, rows, cols, data, name });
}

// Gravsoft: antraštė „lat1 lat2 lon1 lon2 dlat dlon“, reikšmės eilutėmis nuo šiaurės į pietus, iš vakarų į rytus.
function parseGravsoft(text, name) {
  const nums = text.replace(/#.*$/gm, '').trim().split(/\s+/).map(Number);
  if (nums.length < 10 || nums.slice(0, 6).some((v) => !isFinite(v))) return null;
  const [lat1, lat2, lon1, lon2, dlat, dlon] = nums;
  if (!(lat2 > lat1 && lon2 > lon1 && dlat > 0 && dlon > 0)) return null;
  const rows = Math.round((lat2 - lat1) / dlat) + 1, cols = Math.round((lon2 - lon1) / dlon) + 1;
  if (nums.length - 6 < rows * cols) return null;
  const data = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) data[(rows - 1 - r) * cols + c] = nums[6 + r * cols + c];
  return new GeoidGrid({ lat0: lat1, lon0: lon1, dlat, dlon, rows, cols, data, name });
}

// Tekstinis: „platuma ilguma N“ eilutėmis, taisyklingas tinklelis.
function parseXyzGrid(text, name) {
  const pts = [];
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split(/[\s,;]+/).map(Number);
    if (p.length >= 3 && p.slice(0, 3).every(isFinite)) pts.push(p);
  }
  if (pts.length < 4) throw new Error(t('Nepavyko atpažinti geoido failo formato'));
  // Nustatome, kuris stulpelis platuma (Lietuvoje 53–57°), kuris ilguma (20–27°)
  const swap = pts[0][0] < 40 && pts[0][1] > 40;
  const lats = [...new Set(pts.map((p) => +(swap ? p[1] : p[0]).toFixed(8)))].sort((a, b) => a - b);
  const lons = [...new Set(pts.map((p) => +(swap ? p[0] : p[1]).toFixed(8)))].sort((a, b) => a - b);
  const dlat = lats[1] - lats[0], dlon = lons[1] - lons[0];
  const rows = lats.length, cols = lons.length;
  const data = new Float32Array(rows * cols).fill(NaN);
  for (const p of pts) {
    const la = swap ? p[1] : p[0], lo = swap ? p[0] : p[1];
    const r = Math.round((la - lats[0]) / dlat), c = Math.round((lo - lons[0]) / dlon);
    if (r >= 0 && c >= 0 && r < rows && c < cols) data[r * cols + c] = p[2];
  }
  return new GeoidGrid({ lat0: lats[0], lon0: lons[0], dlat, dlon, rows, cols, data, name });
}
