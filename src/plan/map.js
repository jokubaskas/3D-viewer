// Paprastas plytelių žemėlapis (Web Mercator) su srities brėžimu / redagavimu ir papildomų sluoksnių piešimu.
import { BASEMAPS } from '../geo/basemap.js';
import { t, locale } from '../i18n.js';

const D2R = Math.PI / 180;
const TILE = 256;
// Pasaulinės koordinatės: 0…1 (x – rytai, y – pietūs)
const lon2x = (lon) => (lon + 180) / 360;
const lat2y = (lat) => (1 - Math.log(Math.tan(lat * D2R) + 1 / Math.cos(lat * D2R)) / Math.PI) / 2;
const x2lon = (x) => x * 360 - 180;
const y2lat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / D2R;

export class PlanMap {
  /**
   * @param {HTMLCanvasElement} cv
   * @param {{onChange?:()=>void, onHome?:(ll:[number,number])=>void, overlay?:(g:CanvasRenderingContext2D, map:PlanMap)=>void,
   *   onClick?:(ll:[number,number], xy:[number,number])=>void, color?:string}} opts
   */
  constructor(cv, opts = {}) {
    this.cv = cv;
    this.opts = opts;
    this.lat = 55.17;
    this.lon = 23.9; // Lietuvos centras
    this.zoom = 7;
    this.poly = []; // [lon, lat]
    this.closed = false;
    this.mode = null; // null | 'draw' | 'home'
    this.basemap = 'satellite';
    this.editable = true; // ar galima tempti viršūnes
    this.color = opts.color || '#00e5ff';
    this.tiles = new Map();
    this._raf = 0;
    this._bind();
    new ResizeObserver(() => this.redraw()).observe(cv.parentElement);
  }

  // ---------------------------------------------------------------- koordinatės
  get scale() {
    return TILE * 2 ** this.zoom; // px pasauliui
  }
  toScreen([lon, lat]) {
    const s = this.scale;
    return [this.W / 2 + (lon2x(lon) - lon2x(this.lon)) * s, this.H / 2 + (lat2y(lat) - lat2y(this.lat)) * s];
  }
  toLL(x, y) {
    const s = this.scale;
    return [x2lon(lon2x(this.lon) + (x - this.W / 2) / s), y2lat(lat2y(this.lat) + (y - this.H / 2) / s)];
  }
  /** Metrai viename ekrano taške (centre). */
  get mPerPx() {
    return (40075016.686 * Math.cos(this.lat * D2R)) / this.scale;
  }

  setView(lon, lat, zoom = this.zoom) {
    this.lon = lon;
    this.lat = lat;
    this.zoom = Math.min(Math.max(zoom, 3), 21);
    this.redraw();
  }

  /** Parodo visą sritį. */
  fit(pts = this.poly) {
    if (!pts.length) return;
    const xs = pts.map((p) => lon2x(p[0])), ys = pts.map((p) => lat2y(p[1]));
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const W = this.cv.parentElement.clientWidth || 800, H = this.cv.parentElement.clientHeight || 500;
    const z = Math.log2(Math.min((W * 0.8) / Math.max(x1 - x0, 1e-9), (H * 0.8) / Math.max(y1 - y0, 1e-9)) / TILE);
    this.setView(x2lon((x0 + x1) / 2), y2lat((y0 + y1) / 2), Math.min(z, 19));
  }

  // ---------------------------------------------------------------- piešimas
  redraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._draw();
    });
  }

  _draw() {
    const cv = this.cv, wrap = cv.parentElement, dpr = devicePixelRatio || 1;
    this.W = wrap.clientWidth;
    this.H = wrap.clientHeight;
    if (!this.W || !this.H) return;
    if (cv.width !== Math.round(this.W * dpr) || cv.height !== Math.round(this.H * dpr)) {
      cv.width = Math.round(this.W * dpr);
      cv.height = Math.round(this.H * dpr);
      cv.style.width = `${this.W}px`;
      cv.style.height = `${this.H}px`;
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#1a1e21';
    g.fillRect(0, 0, this.W, this.H);
    this._drawTiles(g);
    this._drawPoly(g);
    this.opts.overlay?.(g, this);
    this._drawScale(g);
  }

  _drawTiles(g) {
    const src = BASEMAPS[this.basemap] || BASEMAPS.satellite;
    const z = Math.max(0, Math.min(src.maxZoom || 19, Math.round(this.zoom)));
    const n = 2 ** z;
    const k = 2 ** (this.zoom - z); // plytelės mastelis ekrane
    const [lonW, latN] = this.toLL(0, 0), [lonE, latS] = this.toLL(this.W, this.H);
    const x0 = Math.floor(lon2x(lonW) * n), x1 = Math.floor(lon2x(lonE) * n);
    const y0 = Math.max(0, Math.floor(lat2y(latN) * n)), y1 = Math.min(n - 1, Math.floor(lat2y(latS) * n));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 200) return;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const xx = ((x % n) + n) % n;
        const key = `${this.basemap}/${z}/${xx}/${y}`;
        let img = this.tiles.get(key);
        if (!img) {
          img = new Image();
          img.onload = () => this.redraw();
          img.onerror = () => (img.failed = true);
          img.src = src.url.replace('{z}', z).replace('{x}', xx).replace('{y}', y);
          this.tiles.set(key, img);
          if (this.tiles.size > 600) this.tiles.delete(this.tiles.keys().next().value);
        }
        if (!img.complete || img.failed || !img.naturalWidth) continue;
        const [sx, sy] = this.toScreen([x2lon(x / n), y2lat(y / n)]);
        g.drawImage(img, sx, sy, TILE * k + 0.5, TILE * k + 0.5);
      }
    }
  }

  _drawPoly(g) {
    if (!this.poly.length) return;
    const P = this.poly.map((p) => this.toScreen(p));
    g.lineWidth = 2;
    g.strokeStyle = this.color;
    g.fillStyle = `${this.color}1f`;
    g.beginPath();
    P.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    if (this.mode === 'draw' && this._hover) g.lineTo(...this._hover);
    if (this.closed) g.closePath();
    g.fill();
    g.stroke();
    if (!this.editable && this.mode !== 'draw') return;
    P.forEach(([x, y], i) => {
      g.fillStyle = i === 0 && this.mode === 'draw' && P.length >= 3 ? '#ffd23f' : '#fff';
      g.beginPath();
      g.arc(x, y, 5.5, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#00a3b5';
      g.lineWidth = 1.5;
      g.stroke();
    });
    // Kraštinių vidurio taškai – tempiant pridedama viršūnė
    if (this.closed && this.mode !== 'draw') {
      g.fillStyle = 'rgba(255,255,255,0.55)';
      P.forEach(([x, y], i) => {
        const [x2, y2] = P[(i + 1) % P.length];
        g.beginPath();
        g.arc((x + x2) / 2, (y + y2) / 2, 3.5, 0, Math.PI * 2);
        g.fill();
      });
    }
  }

  _drawScale(g) {
    const target = (this.W * 0.18) * this.mPerPx;
    const p10 = 10 ** Math.floor(Math.log10(target));
    const len = [1, 2, 5, 10].map((k) => k * p10).filter((v) => v <= target).pop() || p10;
    const px = len / this.mPerPx;
    g.fillStyle = 'rgba(20,23,25,0.75)';
    g.fillRect(8, this.H - 34, px + 16, 26);
    g.fillStyle = '#e6ebe8';
    g.fillRect(16, this.H - 16, px, 3);
    g.font = '11px Inter, Segoe UI, sans-serif';
    g.fillText(len >= 1000 ? `${new Intl.NumberFormat(locale()).format(len / 1000)} km` : `${new Intl.NumberFormat(locale()).format(len)} m`, 16, this.H - 21);
    const src = BASEMAPS[this.basemap] || BASEMAPS.satellite;
    if (src.attribution) {
      g.font = '10px Inter, Segoe UI, sans-serif';
      const w = g.measureText(src.attribution).width;
      g.fillStyle = 'rgba(20,23,25,0.6)';
      g.fillRect(this.W - w - 10, this.H - 16, w + 10, 16);
      g.fillStyle = '#c3cac6';
      g.fillText(src.attribution, this.W - w - 5, this.H - 4);
    }
  }

  // ---------------------------------------------------------------- sritis
  startDrawing() {
    this.poly = [];
    this.closed = false;
    this.mode = 'draw';
    this.opts.onChange?.();
    this.redraw();
  }
  setPolygon(pts) {
    this.poly = pts.map((p) => [p[0], p[1]]);
    this.closed = pts.length >= 3;
    this.mode = null;
    this.opts.onChange?.();
    this.redraw();
  }
  clear() {
    this.poly = [];
    this.closed = false;
    this.mode = null;
    this.opts.onChange?.();
    this.redraw();
  }
  /** Užbaigti brėžimą (mygtukas – patogu jutikliniame ekrane). */
  finish() {
    if (this.mode === 'draw') this._close();
  }
  /** Pašalinti paskutinį nubrėžtą tašką. */
  undo() {
    if (this.mode !== 'draw' || !this.poly.length) return;
    this.poly.pop();
    this.opts.onChange?.();
    this.redraw();
  }
  _close() {
    if (this.poly.length < 3) return;
    this.closed = true;
    this.mode = null;
    this._hover = null;
    this.opts.onChange?.();
    this.redraw();
  }

  _bind() {
    const cv = this.cv;
    let down = null;
    const pos = (e) => {
      const r = cv.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const near = (x, y, P, r = 9) => P.findIndex(([px, py]) => (px - x) ** 2 + (py - y) ** 2 < r * r);
    const mids = () => {
      const P = this.poly.map((p) => this.toScreen(p));
      return P.map(([x, y], i) => [(x + P[(i + 1) % P.length][0]) / 2, (y + P[(i + 1) % P.length][1]) / 2]);
    };
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = pos(e);
      const before = this.toLL(x, y);
      this.zoom = Math.min(Math.max(this.zoom - e.deltaY * 0.0022, 3), 21);
      const after = this.toLL(x, y);
      this.lon += before[0] - after[0];
      this.lat += before[1] - after[1];
      this.redraw();
    }, { passive: false });
    // Du pirštai – mastelis ir slinkimas (telefone / planšetėje)
    const touches = new Map();
    let pinch = null;
    const pinchStart = () => {
      const [a, b] = [...touches.values()];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, zoom: this.zoom, mid: this.toLL((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) };
      down = null;
    };
    cv.addEventListener('pointerdown', (e) => {
      const [x, y] = pos(e);
      cv.setPointerCapture(e.pointerId);
      touches.set(e.pointerId, [x, y]);
      if (touches.size === 2) return pinchStart();
      if (touches.size > 2) return;
      let vertex = -1;
      if (this.closed && this.mode !== 'draw' && this.editable) {
        vertex = near(x, y, this.poly.map((p) => this.toScreen(p)));
        if (vertex < 0) {
          const m = near(x, y, mids(), 7);
          if (m >= 0) {
            this.poly.splice(m + 1, 0, this.toLL(x, y));
            vertex = m + 1;
          }
        }
      }
      down = { x, y, lon: this.lon, lat: this.lat, vertex, moved: false };
    });
    cv.addEventListener('pointermove', (e) => {
      const [x, y] = pos(e);
      if (touches.has(e.pointerId)) touches.set(e.pointerId, [x, y]);
      if (pinch && touches.size === 2) {
        const [a, b] = [...touches.values()];
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        this.zoom = Math.min(Math.max(pinch.zoom + Math.log2(Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d), 3), 21);
        // Pirštų vidurio taškas lieka ties ta pačia vieta žemėlapyje
        const s = this.scale;
        this.lon = x2lon(lon2x(pinch.mid[0]) - (mx - this.W / 2) / s);
        this.lat = y2lat(lat2y(pinch.mid[1]) - (my - this.H / 2) / s);
        this.redraw();
        return;
      }
      if (down) {
        if (Math.hypot(x - down.x, y - down.y) > 4) down.moved = true;
        if (down.vertex >= 0) {
          this.poly[down.vertex] = this.toLL(x, y);
          this.opts.onChange?.(true);
          this.redraw();
        } else if (down.moved) {
          const s = this.scale;
          this.lon = x2lon(lon2x(down.lon) - (x - down.x) / s);
          this.lat = y2lat(lat2y(down.lat) - (y - down.y) / s);
          this.redraw();
        }
        return;
      }
      if (this.mode === 'draw') {
        this._hover = [x, y];
        this.redraw();
      }
      const P = this.poly.map((p) => this.toScreen(p));
      cv.style.cursor = this.mode ? 'crosshair' : this.closed && this.editable && (near(x, y, P) >= 0 || near(x, y, mids(), 7) >= 0) ? 'move' : this.opts.onClick ? 'pointer' : 'grab';
    });
    const lift = (e) => {
      touches.delete(e.pointerId);
      if (pinch && touches.size < 2) {
        pinch = null;
        down = null;
        return true;
      }
      return false;
    };
    cv.addEventListener('pointercancel', (e) => {
      lift(e);
      down = null;
    });
    cv.addEventListener('pointerup', (e) => {
      const [x, y] = pos(e);
      if (lift(e)) return;
      const d = down;
      down = null;
      if (!d) return;
      if (d.vertex >= 0) return this.opts.onChange?.();
      if (d.moved) return;
      if (this.mode === 'home') {
        this.mode = null;
        return this.opts.onHome?.(this.toLL(x, y));
      }
      if (this.mode !== 'draw') return this.opts.onClick?.(this.toLL(x, y), [x, y]);
      if (this.poly.length >= 3 && near(x, y, [this.toScreen(this.poly[0])]) === 0) return this._close();
      this.poly.push(this.toLL(x, y));
      this.opts.onChange?.();
      this.redraw();
    });
    cv.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (this.mode !== 'draw') return;
      if (this.poly.length > 3) this.poly.pop();
      this._close();
    });
    // Dešiniu pelės mygtuku ant viršūnės – pašalinti
    cv.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const [x, y] = pos(e);
      const i = near(x, y, this.poly.map((p) => this.toScreen(p)));
      if (i >= 0 && this.poly.length > 3 && (this.editable || this.mode === 'draw')) {
        this.poly.splice(i, 1);
        this.opts.onChange?.();
        this.redraw();
      }
    });
    cv.addEventListener('pointerleave', () => {
      this._hover = null;
      this.redraw();
    });
  }

  hint() {
    if (this.mode === 'draw')
      return this.poly.length < 3 ? t('Spustelėkite žemėlapyje srities kampus') : t('Spustelėkite pirmą tašką arba dukart – užbaigti');
    if (this.mode === 'home') return t('Spustelėkite pakilimo vietą');
    if (this.closed) return t('Tempkite taškus; vidurio taškas – nauja viršūnė; dešiniu pelės mygtuku – pašalinti');
    return t('Paspauskite „Žymėti sritį“ arba įkelkite KML / GeoJSON');
  }
}
