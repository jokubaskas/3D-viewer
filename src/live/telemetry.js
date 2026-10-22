// Dronų telemetrija iš diab (atea.diab.app): WebSocket „/api/ws/v2/dashboard“ siunčia visų dokų ir dronų būseną
// JSON pranešimais ({"boxes":[…]}). Prisijungimo raktas perduodamas per Sec-WebSocket-Protocol – taip pat, kaip diab
// tinklalapyje. Jei diab neįsileidžia kitų svetainių (Origin), jungiamasi per mūsų serverį (/ext/diab/…, nginx).
import { t } from '../i18n.js';

export const DIAB_DEFAULT_URL = 'wss://atea.diab.app/api/ws/v2/dashboard';
const MAX_TRACK = 20000;

/**
 * Koordinatės diab'e – sveikieji skaičiai: dokas ×1e6 (54903627), dronas ×1e7 (549036284). Mastelis nustatomas pagal
 * platumą (Europoje 10…90°) ir pritaikomas ir ilgumai. Jau laipsniais pateiktos reikšmės paliekamos.
 */
export function decodeLatLon(lat, lon) {
  if (lat == null || lon == null || lat === '' || lon === '') return null;
  lat = +lat;
  lon = +lon;
  if (!isFinite(lat) || !isFinite(lon) || (lat === 0 && lon === 0)) return null;
  if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return [lat, lon];
  const digits = Math.floor(Math.log10(Math.abs(lat))) + 1;
  const k = 10 ** Math.max(0, digits - 2);
  const r = [lat / k, lon / k];
  return Math.abs(r[0]) <= 90 && Math.abs(r[1]) <= 180 ? r : null;
}

/** Pirmas rastas laukas iš kelių galimų pavadinimų (iki 2 lygių gylio) – skrydžio laukų pavadinimai dar nežinomi. */
function pick(o, names) {
  if (!o || typeof o !== 'object') return undefined;
  for (const n of names) if (o[n] != null && typeof o[n] !== 'object') return o[n];
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Array.isArray(v)) for (const n of names) if (v[n] != null && typeof v[n] !== 'object') return v[n];
  return undefined;
}
const num = (v) => (v == null || v === '' || !isFinite(+v) ? null : +v);

/** diab doko įrašas → vienoda forma. Asmens duomenys (piloto el. paštas) nesaugomi – tik vardas. */
export function normalizeBox(b) {
  const d = b.drone || {};
  const st = b.droneState || {};
  const enc = b.enclosure || {};
  const dock = decodeLatLon(b.location?.lat, b.location?.long ?? b.location?.lon ?? b.location?.lng);
  const pos = decodeLatLon(d.location?.lat, d.location?.long ?? d.location?.lon ?? d.location?.lng);
  return {
    key: String(b.boxCode || b.boxId),
    code: b.boxCode || '',
    name: b.name || b.boxCode || String(b.boxId),
    status: b.status || 'UNKNOWN',
    updated: num(b.lastUpdate),
    dock,
    drone: {
      power: d.power || null,
      battery: num(d.battery?.capacityPct ?? d.battery?.percent),
      pos,
      alt: num(pick(d.location, ['alt', 'altitude', 'height', 'relativeAltitude', 'elevation']) ?? pick(d, ['altitude', 'height'])),
      heading: num(pick(d, ['heading', 'yaw', 'attitudeHead', 'course', 'bearing'])),
      speed: num(pick(d, ['speed', 'horizontalSpeed', 'groundSpeed', 'velocity'])),
      vspeed: num(pick(d, ['verticalSpeed', 'vSpeed', 'climbRate'])),
    },
    state: st.status || null,
    rc: num(st.rcStrength),
    wind: num(enc.weather?.windSpeed),
    rain: enc.weather?.rain ?? null,
    temp: num(enc.hvac?.temperature),
    extTemp: num(enc.hvac?.externalTemperature),
    charger: enc.charger?.state || null,
    pilot: [b.pilot?.firstName, b.pilot?.lastName].filter(Boolean).join(' ') || null,
  };
}

/** Atstumas metrais tarp [lat, lon]. */
export function distM(a, b) {
  const R = 6371000, D = Math.PI / 180;
  const dLat = (b[0] - a[0]) * D, dLon = (b[1] - a[1]) * D;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * D) * Math.cos(b[0] * D) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Rakto galiojimo pabaiga (jei tai JWT), ms; kitaip null. */
export function keyExpiry(key) {
  for (const part of String(key || '').split(/[\s,]+/)) {
    const seg = part.split('.');
    if (seg.length !== 3) continue;
    try {
      const p = JSON.parse(atob(seg[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(seg[1].length / 4) * 4, '=')));
      if (p.exp) return p.exp * 1000;
    } catch { /* ne JWT */ }
  }
  return null;
}

/** Ryšys su diab: būsena, dokų sąrašas, drono maršrutai. */
export class DiabLink {
  /** @param {{gatewayBase:()=>Promise<string|null>, onChange:()=>void}} opts */
  constructor(opts) {
    this.opts = opts;
    this.boxes = new Map(); // key → normalizuotas dokas
    this.tracks = new Map(); // key → [{t, lat, lon, alt}]
    this.state = 'off'; // off | connecting | live | retry | error
    this.error = '';
    this.mode = '';
    this.raw = null; // paskutinis pranešimas (be asmens duomenų) – naujiems laukams pamatyti
    this.other = null; // paskutinis kitokio formato pranešimas
    this.count = 0;
    this.listeners = new Set();
  }

  /** @param {{url:string, key:string, via:'auto'|'direct'|'server'}} cfg */
  async connect(cfg) {
    this.disconnect();
    this.cfg = cfg;
    this.wanted = true;
    this.fails = 0;
    this._open();
  }

  disconnect() {
    this.wanted = false;
    clearTimeout(this._retry);
    if (this.ws) {
      this.ws.onclose = this.ws.onerror = this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch { /* jau uždarytas */ }
      this.ws = null;
    }
    this.state = 'off';
    this.error = '';
    this._emit();
  }

  async serverUrl(url) {
    const base = await this.opts.gatewayBase();
    if (!base) return null;
    const u = new URL(url);
    if (!/\.diab\.app$/i.test(u.hostname)) return null;
    const root = new URL('../', base); // „…/live/“ → „…/“
    root.protocol = root.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${root.href}ext/diab/${u.hostname}${u.pathname}${u.search}`;
  }

  async _open() {
    const { url, key, via } = this.cfg;
    const protocols = String(key || '').split(',').map((s) => s.trim()).filter(Boolean);
    // Tiesiogiai, o nepavykus (ir „Automatiškai“) – per serverį
    const plan = via === 'server' ? ['server'] : via === 'direct' ? ['direct'] : this._lastOk ? [this._lastOk, this._lastOk === 'direct' ? 'server' : 'direct'] : ['direct', 'server'];
    this.state = 'connecting';
    this._emit();
    let lastErr = '';
    for (const m of plan) {
      if (!this.wanted) return;
      const target = m === 'server' ? await this.serverUrl(url) : url;
      if (!target) {
        lastErr = t('Transliacijų serveris nepasiekiamas – paleiskite start-windows.bat (Docker).');
        continue;
      }
      const ok = await this._try(target, protocols, m);
      if (ok === true) return;
      lastErr = ok;
    }
    this.fails++;
    const exp = keyExpiry(key);
    this.error = exp && exp < Date.now() ? t('Raktas nebegalioja (baigėsi {d}) – nukopijuokite naują iš diab', { d: new Date(exp).toLocaleString() }) : lastErr || t('Nepavyko prisijungti – patikrinkite adresą ir raktą (raktai dažnai galioja ribotą laiką)');
    this._schedule();
  }

  /** @returns {Promise<true|string>} */
  _try(target, protocols, mode) {
    return new Promise((res) => {
      let ws;
      try {
        ws = new WebSocket(target, protocols.length ? protocols : undefined);
      } catch (e) {
        return res(e.message);
      }
      let opened = false;
      const timer = setTimeout(() => !opened && (ws.close(), res(t('Serveris neatsako'))), 10000);
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        this.ws = ws;
        this.mode = mode;
        this._lastOk = mode;
        this.state = 'live';
        this.error = '';
        this.fails = 0;
        this._emit();
        res(true);
      };
      ws.onmessage = (e) => this._message(e.data);
      ws.onerror = () => {};
      ws.onclose = (e) => {
        clearTimeout(timer);
        if (!opened) return res(e.code === 1006 ? t('Ryšys atmestas') : `${t('Ryšys atmestas')} (${e.code}${e.reason ? `: ${e.reason}` : ''})`);
        if (this.ws !== ws) return;
        this.ws = null;
        this.error = e.reason || t('Ryšys nutrūko');
        this._schedule();
      };
    });
  }

  _schedule() {
    if (!this.wanted) return;
    this.state = 'retry';
    const s = Math.min(60, 2 ** Math.min(this.fails, 5) * 2);
    this.retryIn = s;
    this._emit();
    this._retry = setTimeout(() => this.wanted && this._open(), s * 1000);
  }

  _message(data) {
    let m;
    try {
      m = JSON.parse(typeof data === 'string' ? data : '');
    } catch {
      return;
    }
    this.count++;
    const list = Array.isArray(m?.boxes) ? m.boxes : m?.boxCode || m?.boxId ? [m] : null;
    if (!list) {
      this.other = m;
      this._emit();
      return;
    }
    this.raw = { ...m, boxes: list.map(({ pilot: _p, ...b }) => b) };
    const now = Date.now();
    for (const b of list) {
      const n = normalizeBox(b);
      this.boxes.set(n.key, n);
      const p = n.drone.pos;
      if (!p) continue;
      const tr = this.tracks.get(n.key) || [];
      const last = tr[tr.length - 1];
      // Maršrutas: taškas, kai dronas pasislinko ≥ 0,5 m arba pasikeitė aukštis (stovint doke – nekaupiama)
      if (!last || distM([last.lat, last.lon], p) >= 0.5 || (n.drone.alt != null && Math.abs((last.alt ?? n.drone.alt) - n.drone.alt) >= 0.5)) {
        tr.push({ t: now, lat: p[0], lon: p[1], alt: n.drone.alt });
        if (tr.length > MAX_TRACK) tr.splice(0, tr.length - MAX_TRACK);
        this.tracks.set(n.key, tr);
      }
    }
    this._emit();
  }

  /** Dokas pagal transliacijos pavadinimą („ATEA1“, „Atea 1“). */
  match(name) {
    const s = String(name || '').toLowerCase().replace(/\s+/g, '');
    if (!s) return null;
    for (const b of this.boxes.values()) {
      const c = b.code.toLowerCase(), n = b.name.toLowerCase().replace(/\s+/g, '');
      if ((c && (s === c || s.includes(c))) || (n && (s === n || s.includes(n)))) return b;
    }
    return null;
  }

  clearTrack(key) {
    this.tracks.delete(key);
    this._emit();
  }

  _emit() {
    this.opts.onChange?.();
    this.listeners.forEach((f) => f(this));
  }
}

/** Maršrutas → GPX. */
export function trackGpx(name, pts) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const seg = pts.map((p) => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${p.alt != null ? `<ele>${p.alt}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time></trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Atea 3D Matuoklis" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${esc(name)}</name><trkseg>\n${seg}\n</trkseg></trk>\n</gpx>\n`;
}
