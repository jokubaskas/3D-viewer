// AI įrašas klientui: vaizdas su įrašytais rėmeliais, skaičiais ir laiku + ataskaita (HTML, CSV, JSON, įvykių kadrai).
// Įrašoma ne pats grotuvas, o drobė, ant kurios kiekvieną kadrą piešiamas vaizdas ir paskutiniai AI rezultatai.
import { classColor, detLabel, stateFamily } from './ai.js';
import { t, locale } from '../i18n.js';
import { drawLogo, logoSvg } from '../logo.js';
import { telemetryLine } from './telemetry-ui.js';
import { distM, trackGpx } from './telemetry.js';
import { flightSummary, flightSection, telemetryCsv } from './flight.js';

const FPS = 25;
const MAX_EVENTS = 150;
// Įvykis = objektų grupės „pasirodymas“: prasideda, kai grupė aptinkama bent 2 kartus per GONE_MS
// (arba 1 kartą, kai AI tikras ≥ SURE), baigiasi, kai jos nematyti GONE_MS – pavieniai praleisti kadrai
// įvykio nenutraukia ir nesukuria pasikartojančių įrašų.
const GONE_MS = 5000;
const SURE = 0.7;
const SHOT_GAP_MS = 2000; // geresnis įvykio kadras ieškomas ne dažniau kaip kas 2 s
const pad2 = (n) => String(n).padStart(2, '0');
const fmtClock = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const fmtDur = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
};
const fmtLen = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? t('{s} s', { s }) : t('{m} min. {s} s', { m: Math.floor(s / 60), s: s % 60 });
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Nupiešia vaizdo kadrą su AI rėmeliais ir informacine juosta.
 * @param {CanvasRenderingContext2D} g
 * @param {HTMLVideoElement|HTMLImageElement} el
 * @param {{dets:object[], w:number, h:number, at:number}|null} last – paskutinis AI rezultatas (vaizdo koordinatėmis)
 * @param {{W:number, H:number, title?:string, lines?:string[], counts?:object}} o
 */
export function drawComposite(g, el, last, o) {
  const { W, H } = o;
  const vw = el.videoWidth || el.naturalWidth || el.width, vh = el.videoHeight || el.naturalHeight || el.height;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  if (!vw || !vh) return;
  const k = Math.min(W / vw, H / vh);
  const ox = (W - vw * k) / 2, oy = (H - vh * k) / 2;
  g.drawImage(el, ox, oy, vw * k, vh * k);
  const s = W / 1280; // užrašų mastelis
  if (last && (o.fresh || performance.now() - last.at < 4000)) {
    const kk = Math.min(W / last.w, H / last.h);
    const ox2 = (W - last.w * kk) / 2, oy2 = (H - last.h * kk) / 2;
    g.lineWidth = Math.max(2, 2.5 * s);
    g.font = `600 ${Math.round(13 * s)}px Inter, Segoe UI, sans-serif`;
    for (const d of last.dets) {
      const [x1, y1, x2, y2] = d.box;
      const x = ox2 + x1 * kk, y = oy2 + y1 * kk, w = (x2 - x1) * kk, h = (y2 - y1) * kk;
      const color = classColor(d.class);
      // o.focus – įvykio objektas (ryškus), kiti – blankesni
      g.globalAlpha = o.focus && d.id !== o.focus ? 0.45 : 1;
      g.lineWidth = Math.max(2, (o.focus && d.id === o.focus ? 3.5 : 2.5) * s);
      g.strokeStyle = color;
      g.strokeRect(x, y, w, h);
      const label = detLabel(d);
      const th = Math.round(17 * s), tw = g.measureText(label).width + 8 * s;
      const ly = y - th < 0 ? y : y - th;
      g.fillStyle = color;
      g.fillRect(x, ly, tw, th);
      g.fillStyle = '#111';
      g.fillText(label, x + 4 * s, ly + th - 4 * s);
    }
    g.globalAlpha = 1;
  }
  // Informacinė juosta viršuje: laikas, pavadinimas, skaičiai
  const lines = o.lines || [];
  if (lines.length) {
    const fh = Math.round(15 * s), pad = Math.round(8 * s);
    g.font = `600 ${fh}px Inter, Segoe UI, sans-serif`;
    const bw = Math.max(...lines.map((l) => g.measureText(l).width)) + pad * 2;
    g.fillStyle = 'rgba(15,18,20,0.72)';
    g.fillRect(pad, pad, bw, lines.length * (fh + 6 * s) + pad);
    g.fillStyle = '#fff';
    lines.forEach((l, i) => g.fillText(l, pad * 2, pad + (i + 1) * (fh + 6 * s) - 2 * s));
  }
  const lh = Math.round(14 * s);
  drawLogo(g, W - lh * 3.9 - 10 * s, H - lh - 10 * s, lh, 'rgba(255,255,255,0.7)');
}

/** Laikmatis Worker'yje: naršyklė jo nestabdo, kai skirtukas fone (įrašas lieka sklandus). */
function ticker(ms, fn) {
  const url = URL.createObjectURL(new Blob(['let i;onmessage=(e)=>{clearInterval(i);if(e.data>0)i=setInterval(()=>postMessage(0),e.data)}'], { type: 'text/javascript' }));
  const w = new Worker(url);
  w.onmessage = fn;
  w.postMessage(ms);
  return () => {
    w.postMessage(0);
    w.terminate();
    URL.revokeObjectURL(url);
  };
}

/**
 * Drono skrydžio žurnalas įrašo metu (diab telemetrija kas sekundę + maršrutas) – su AI ir be jo.
 * @param {() => object|null} get dabartinė doko/drono būsena (telemetry.js normalizeBox)
 */
export class FlightLog {
  constructor(get, started = Date.now()) {
    this.get = get;
    this.started = started;
    this.tele = []; // {t, pos, alt, speed, vspeed, heading, battery, rc, wind, state}
    this.route = []; // {t (laiko žyma), lat, lon, alt}
    this.dock = null;
    this.drone = '';
    this.sample();
    this._stop = ticker(1000, () => this.sample());
  }

  sample() {
    const b = this.get?.();
    if (!b) return;
    const d = b.drone || {};
    const t = Date.now() - this.started;
    const s = { t, pos: d.pos ? [+d.pos[0].toFixed(7), +d.pos[1].toFixed(7)] : null, alt: d.alt, speed: d.speed, vspeed: d.vspeed, heading: d.heading, battery: d.battery, rc: b.rc, wind: b.wind, state: b.state || null };
    if (!Object.values(s).some((v, i) => i > 0 && v != null)) return;
    this.tele.push(s);
    if (b.dock) this.dock = b.dock;
    if (s.pos) this.pos(t);
  }

  /** Drono padėtis dabar: [platuma, ilguma, aukštis|null]; papildo maršrutą. */
  pos(t1) {
    const b = this.get?.();
    const p = b?.drone?.pos;
    if (!p) return null;
    const pos = [+p[0].toFixed(7), +p[1].toFixed(7), b.drone.alt ?? null];
    this.drone = b.name;
    const last = this.route[this.route.length - 1];
    if (!last || distM([last.lat, last.lon], p) >= 0.5) this.route.push({ t: this.started + t1, lat: pos[0], lon: pos[1], alt: pos[2] });
    return pos;
  }

  stop() {
    this._stop?.();
    this._stop = null;
    this.ended ??= Date.now();
  }
}

/** Stabilizuojant – dar neužfiksuota būsena (šalmas) į skaičius ir įvykius nepatenka. */
const unsure = (x) => x.locked === false && !!stateFamily(x.class);

/** Grupių pavadinimai ir spalvos (iš detektoriaus; įraše – sukaupti visi pasitaikę). */
const GROUPS = {};
const remember = (groups) => Object.assign(GROUPS, groups || {});
const gLabel = (k) => GROUPS[k]?.label || k;
const countsText = (counts, keep = () => true, unique = null) =>
  Object.entries(counts || {})
    .filter(([k]) => keep(k))
    .map(([k, n]) => `${gLabel(k)}: ${n}${unique?.[k] ? ` (${t('iš viso {n}', { n: unique[k] })})` : ''}`)
    .join('   ');

/** Įrašo drobę su AI žymėjimais ir kaupia rezultatų seką bei įvykius. */
export class AiComposer {
  /**
   * @param {import('./player.js').LivePlayer} player
   * @param {import('./ai.js').LiveDetector} detector
   * @param {{name:string, settings:object}} meta
   */
  constructor(player, detector, meta) {
    this.player = player;
    this.detector = detector;
    this.meta = meta;
    for (const k of Object.keys(GROUPS)) delete GROUPS[k]; // naujas įrašas – iš naujo
    this.started = Date.now();
    this.t0 = performance.now();
    this.track = []; // {t, counts, pos?, dets:[[class, score, x1, y1, x2, y2] (0…1)]}
    this.events = []; // {t, at, kind:'start'|'episode', group, n (daugiausia), end?, counts, img?:Blob}
    this._g = {}; // grupės būsena: {hits, firstT, firstAt, lastT, ep}
    this.max = {};
    const el = player.el;
    const vw = el.videoWidth || el.naturalWidth || 1280, vh = el.videoHeight || el.naturalHeight || 720;
    const k = Math.min(1, 1920 / Math.max(vw, vh));
    this.cv = document.createElement('canvas');
    this.cv.width = Math.round((vw * k) / 2) * 2;
    this.cv.height = Math.round((vh * k) / 2) * 2;
    this.g = this.cv.getContext('2d');
    this._onResult = (d) => this.onResult(d);
    detector.listeners.add(this._onResult);
    // Įrašo pradžioje – paskutinis AI rezultatas (kad grafikas prasidėtų nuo 0 s)
    if (detector.last) this.track.push({ t: 0, counts: { ...detector.counts }, dets: [] });
    this.draw();
    // Pirmas įvykis – įrašo pradžia su tuo metu matomais objektais
    const ev0 = { t: 0, at: Date.now(), kind: 'start', group: null, n: 0, counts: { ...detector.counts } };
    this.events.push(ev0);
    const L0 = detector.last;
    (L0?.frame && performance.now() - L0.at < 4000 ? this.frameShot(L0, 0, Date.now(), detector.counts) : this.snapshot()).then((b) => (ev0.img = b));
    ev0.counts = this.reportCounts(ev0.counts);
    this._stopTick = ticker(1000 / FPS, () => this.draw());
    // Telemetrija – nepriklausomai nuo AI dažnio (ataskaitos skrydžio žemėlapiui ir grafikams)
    this.flight = new FlightLog(meta.telemetry, this.started);
  }

  get tele() {
    return this.flight.tele;
  }
  get route() {
    return this.flight.route;
  }
  get dock() {
    return this.flight.dock;
  }
  get drone() {
    return this.flight.drone;
  }

  /** Vaizdo srautas įrašymui: drobė + originalus garsas (jei yra). */
  get stream() {
    const s = this.cv.captureStream(FPS);
    const el = this.player.el;
    let audio = [];
    if (this.player.media) audio = this.player.media.getAudioTracks();
    else if (el instanceof HTMLVideoElement) {
      try {
        audio = (el.captureStream || el.mozCaptureStream).call(el).getAudioTracks();
      } catch { /* be garso */ }
    }
    return new MediaStream([...s.getVideoTracks(), ...audio]);
  }

  hud() {
    const now = new Date();
    remember(this.detector.groups);
    return [`● REC ${fmtDur(Date.now() - this.started)}   ${fmtClock(now)}`, this.meta.name, telemetryLine(this.meta.telemetry?.()), countsText(this.detector.counts, undefined, this.detector.tracking ? this.unique : null)].filter(Boolean);
  }

  /** Drono padėtis dabar (diab): [platuma, ilguma, aukštis|null]; kaupiamas įrašo maršrutas. */
  dronePos(t1) {
    return this.flight.pos(t1);
  }


  draw() {
    const el = this.player.el;
    if (!(el instanceof HTMLVideoElement || el instanceof HTMLImageElement)) return;
    try {
      drawComposite(this.g, el, this.detector.last, { W: this.cv.width, H: this.cv.height, lines: this.hud() });
    } catch { /* kadras dar neparuoštas */ }
  }

  onResult(d) {
    remember(d.groups);
    const L = d.last;
    if (!L) return;
    // Laikas – kada kadras paimtas analizei (ne kada atėjo atsakymas), kad sutaptų su vaizdu įraše
    const t1 = Math.max(0, Math.round(L.at - (L.ms || 0) - this.t0));
    const counts = { ...d.counts };
    const pos = this.dronePos(t1);
    this.track.push({
      t: t1,
      counts,
      ...(pos ? { pos } : {}),
      dets: L.dets.map((x) => [x.class, +x.score.toFixed(2), ...x.box.map((v, i) => +(v / (i % 2 ? L.h : L.w)).toFixed(4)), ...(x.id ? [x.id] : [])]),
    });
    if (d.tracking) {
      // Skirtingi objektai šiame įraše (numeriai – nuo AI įjungimo, todėl skaičiuojama atskirai)
      const groups = d.groups || {};
      this._seen ||= {};
      for (const x of L.dets) {
        const k = x.id && !unsure(x) && Object.keys(groups).find((g) => groups[g].classes.includes(x.class));
        if (k) (this._seen[k] ||= new Set()).add(x.id);
      }
      this.unique = Object.fromEntries(Object.entries(this._seen).map(([k, v]) => [k, v.size]));
      this.onObjects(L, t1, counts);
    }
    for (const [k, n] of Object.entries(counts)) {
      if (n > (this.max[k] ?? -1)) this.max[k] = n;
      if (d.tracking) continue; // sekant – įvykiai pagal objektus (onObjects)
      const g = (this._g[k] ||= { hits: 0, lastT: -Infinity, ep: null });
      if (n > 0 && this.inReport(k)) {
        if (t1 - g.lastT >= GONE_MS) Object.assign(g, { hits: 0, firstT: t1, firstAt: this.started + t1 });
        g.hits++;
        g.lastT = t1;
        if (!g.ep && (g.hits >= 2 || this.groupDets(L, k).some((x) => x.score >= SURE)) && this.events.length < MAX_EVENTS) {
          g.ep = { t: g.firstT, at: g.firstAt, kind: 'episode', group: k, n, end: t1, counts: this.reportCounts(counts), q: -1, shotT: -Infinity, pos };
          this.events.push(g.ep);
        }
        if (g.ep) {
          g.ep.end = t1;
          if (n > g.ep.n) Object.assign(g.ep, { n, counts: this.reportCounts(counts) });
          this.betterShot(g.ep, L, k, t1, counts);
        }
      } else if (g.ep && (t1 - g.lastT >= GONE_MS || !this.inReport(k))) g.ep = null;
    }
  }

  /**
   * Sekant objektus: vienas įvykis kiekvienam objektui (#numeris) – kada matėsi (keli laikotarpiai, jei dingo ir grįžo)
   * ir geriausias jo kadras.
   */
  onObjects(L, t1, counts) {
    const groups = this.detector.groups || GROUPS;
    const groupOf = (c) => Object.keys(groups).find((k) => groups[k].classes.includes(c));
    this._obj ||= {};
    for (const x of L.dets) {
      if (!x.id || unsure(x)) continue;
      const k = groupOf(x.class);
      if (!k || !this.inReport(k)) continue;
      let o = this._obj[x.id];
      if (o && o.group !== k) Object.assign(o, { group: k, q: -1 }); // būsena pasikeitė (pvz. nusiėmė šalmą) – naujas kadras
      if (!o) {
        if (this.events.length >= MAX_EVENTS) continue;
        o = this._obj[x.id] = { t: t1, at: this.started + t1, kind: 'object', id: x.id, group: k, end: t1, spans: [[t1, t1]], counts: this.reportCounts(counts), q: -1, shotT: -Infinity, pos: this.track[this.track.length - 1]?.pos };
        this.events.push(o);
      }
      const last = o.spans[o.spans.length - 1];
      if (t1 - last[1] >= GONE_MS) o.spans.push([t1, t1]);
      else last[1] = t1;
      o.end = t1;
      // Geriausias objekto kadras: didesnis, užtikrintesnis, nenukirptas krašte
      const [x1, y1, x2, y2] = x.box, m = 0.01 * Math.max(L.w, L.h);
      const edge = x1 < m || y1 < m || x2 > L.w - m || y2 > L.h - m;
      const q = x.score + Math.min(0.4, Math.sqrt(((x2 - x1) * (y2 - y1)) / (L.w * L.h)) * 2) - (edge ? 0.5 : 0);
      if (L.frame && q > o.q + 0.03 && (!o.img || t1 - o.shotT >= SHOT_GAP_MS)) {
        o.q = q;
        o.shotT = t1;
        o.counts = this.reportCounts(counts);
        o.pos = this.track[this.track.length - 1]?.pos || o.pos; // drono vieta geriausio kadro metu
        const token = (o.token = (o.token || 0) + 1);
        this.frameShot(L, t1, this.started + t1, counts, x.id).then((b) => b && token === o.token && (o.img = b));
      }
    }
  }

  /** Ar grupė rodoma ataskaitos įvykiuose (nustatymas „Į ataskaitą“; tikrinama kiekvieną kartą – galima keisti įrašant). */
  inReport(k) {
    const s = this.meta.settings || {};
    return !s.reportOff?.[s.model || 'std']?.[k];
  }

  reportCounts(counts) {
    return Object.fromEntries(Object.entries(counts || {}).filter(([k]) => this.inReport(k)));
  }

  /** Klasės, kurių rėmeliai piešiami įvykių kadruose. */
  reportClasses() {
    const groups = this.detector.groups || GROUPS;
    return new Set(Object.entries(groups).filter(([k]) => this.inReport(k)).flatMap(([, g]) => g.classes));
  }

  groupDets(L, k) {
    const cls = this.detector.groups?.[k]?.classes || GROUPS[k]?.classes || [];
    return L.dets.filter((x) => cls.includes(x.class));
  }

  /** Kadro kokybė grupei: daugiau objektų, didesnis pasitikėjimas, objektai ne prie krašto (nenukirpti). */
  quality(L, k) {
    const ds = this.groupDets(L, k);
    if (!ds.length) return -1;
    const m = 0.01 * Math.max(L.w, L.h);
    const edge = ds.filter(({ box: [x1, y1, x2, y2] }) => x1 < m || y1 < m || x2 > L.w - m || y2 > L.h - m).length;
    return ds.length + ds.reduce((a, x) => a + x.score, 0) / ds.length - (0.6 * edge) / ds.length;
  }

  betterShot(ep, L, k, t1, counts) {
    if (!L.frame) return;
    const q = this.quality(L, k);
    if (q <= ep.q + 0.05 || (ep.img && t1 - ep.shotT < SHOT_GAP_MS)) return;
    ep.q = q;
    ep.shotT = t1;
    const token = (ep.token = (ep.token || 0) + 1);
    this.frameShot(L, t1, this.started + t1, counts).then((b) => b && token === ep.token && (ep.img = b));
  }

  /** Įvykio kadras: tas pats kadras, kurį analizavo AI, su jo rėmeliais (rėmeliai tiksliai ant objektų). */
  frameShot(L, t1, at, counts, focus = 0) {
    const f = L.frame;
    const k = Math.min(1, 960 / Math.max(f.width, f.height));
    const W = Math.round(f.width * k), H = Math.round(f.height * k);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const keep = this.reportClasses();
    const pos = this.track[this.track.length - 1]?.pos;
    const where = pos ? `${this.drone || ''} ${pos[0].toFixed(6)}, ${pos[1].toFixed(6)}${pos[2] != null ? ` · ${Math.round(pos[2])} m` : ''}`.trim() : '';
    const lines = [`${fmtDur(t1)}   ${fmtClock(new Date(at))}`, this.meta.name, where, countsText(counts, (k) => this.inReport(k))].filter(Boolean);
    drawComposite(c.getContext('2d'), f, { ...L, dets: L.dets.filter((d) => keep.has(d.class)) }, { W, H, lines, fresh: true, focus });
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
  }

  /** Dabartinis kadras su žymėjimais (JPEG, ≤ 960 px). */
  snapshot() {
    const k = Math.min(1, 960 / this.cv.width);
    const c = document.createElement('canvas');
    c.width = Math.round(this.cv.width * k);
    c.height = Math.round(this.cv.height * k);
    c.getContext('2d').drawImage(this.cv, 0, 0, c.width, c.height);
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  }

  stop() {
    this._stopTick?.();
    this._stopTick = null;
    this.detector.listeners.delete(this._onResult);
    this.ended = Date.now();
    this.flight.ended = this.ended;
    this.flight.stop();
    for (const g of Object.values(this._g)) g.ep = null;
  }
}

const REPORT_CSS = `  :root { --g: #008b01; --ink: #1f2326; --mut: #6b7570; }
  body { font-family: Inter, "Segoe UI", system-ui, sans-serif; color: var(--ink); margin: 0; background: #f4f6f5; }
  header { background: #1f2326; color: #fff; padding: 18px 28px; border-bottom: 4px solid var(--g); }
  header .logo { height: 22px; width: auto; display: block; margin-bottom: 10px; }
  header h1 { margin: 0 0 4px; font-size: 22px; } header p { margin: 0; color: #c3cac6; font-size: 13px; }
  main { max-width: 1000px; margin: 0 auto; padding: 20px 20px 40px; }
  section { background: #fff; border-radius: 10px; padding: 16px 18px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h2 { margin: 0 0 12px; font-size: 13px; text-transform: uppercase; letter-spacing: .8px; color: var(--g); }
  video { width: 100%; border-radius: 8px; background: #000; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
  .card { border: 1px solid #e3e7e5; border-radius: 8px; padding: 10px 12px; }
  .card b { font-size: 20px; display: block; } .card span { color: var(--mut); font-size: 12.5px; }
  svg { width: 100%; height: auto; font-size: 11px; fill: #555; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  td, th { text-align: left; padding: 7px 8px; border-bottom: 1px solid #eef1ef; vertical-align: top; }
  th { color: var(--mut); font-weight: 600; font-size: 12px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; }
  td img { width: 220px; border-radius: 6px; display: block; }
  a.geo { color: var(--mut); font-size: 12px; }
  svg.route { width: 100%; height: auto; border-radius: 8px; display: block; background: #2b3236; }
  svg.route a.t { cursor: pointer; }
  .legend { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; font-size: 12.5px; color: var(--mut); }
  .legend .grad { width: 90px; height: 8px; border-radius: 4px; background: linear-gradient(90deg, hsl(220,90%,55%), hsl(110,90%,55%), hsl(0,90%,55%)); }
  .evn { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; border-radius: 10px; background: #1f2326; color: #fff; font-size: 11px; margin-right: 6px; }
  svg.tchart { margin-top: 6px; }
  a.t { color: var(--g); font-weight: 600; text-decoration: none; cursor: pointer; }
  .meta td:first-child { color: var(--mut); width: 220px; }
  footer { text-align: center; color: var(--mut); font-size: 12px; }
  @media print { video { display: none; } body { background: #fff; } section { box-shadow: none; border: 1px solid #ddd; break-inside: avoid; } td img { width: 160px; } }
`;

// Ataskaitos sąveika (atidarius naršyklėje; programos peržiūroje tą patį daro portal/viewer.js)
const REPORT_JS = `  const v = document.getElementById('v');
  const seek = (s) => { v.currentTime = s; v.play(); v.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  document.querySelectorAll('a.t').forEach((a) => a.onclick = () => seek(+a.dataset.t));
  document.querySelectorAll('#chart, svg.tchart').forEach((c) => c.onclick = (e) => { const r = c.getBoundingClientRect(), W = +c.dataset.w, P = +c.dataset.p; const x = (e.clientX - r.left) / r.width * W; seek(Math.max(0, (x - P) / (W - P - 10)) * c.dataset.dur / 1000); });
  // Skrydžio žemėlapyje – drono vieta, atitinkanti vaizdo laiką
  const route = document.getElementById('route'), now = document.getElementById('route-now');
  if (route && now && route.dataset.timeline) {
    const tl = route.dataset.timeline.split(';').map((p) => p.split(',').map(Number));
    v.addEventListener('timeupdate', () => {
      const s = v.currentTime; let i = tl.findIndex((p) => p[0] > s); if (i < 0) i = tl.length; const a = tl[Math.max(0, i - 1)], b = tl[Math.min(tl.length - 1, i)];
      const k = b[0] > a[0] ? Math.min(1, Math.max(0, (s - a[0]) / (b[0] - a[0]))) : 0;
      now.setAttribute('cx', a[1] + (b[1] - a[1]) * k); now.setAttribute('cy', a[2] + (b[2] - a[2]) * k);
    });
  }
`;

// ------------------------------------------------------------------ ataskaita
function stats(comp) {
  const groups = [...new Set(comp.track.flatMap((r) => Object.keys(r.counts)))];
  const dur = (comp.ended || Date.now()) - comp.started;
  return groups.map((k) => {
    const vals = comp.track.map((r) => r.counts[k] || 0);
    const present = vals.filter((v) => v > 0).length;
    return {
      key: k,
      label: gLabel(k),
      max: vals.length ? Math.max(...vals) : 0,
      avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,
      presence: vals.length ? present / vals.length : 0,
      dur,
    };
  });
}

/** SVG grafikas: kiekvienos grupės skaičius laike (spustelėjus – peršokama į tą vaizdo vietą). */
function chartSvg(comp, st) {
  const W = 900, H = 220, P = 34;
  const T = Math.max(1, (comp.ended || Date.now()) - comp.started);
  const maxV = Math.max(1, ...st.map((s) => s.max));
  const x = (tt) => P + ((W - P - 10) * tt) / T;
  const top = 32, bottom = H - P + 4; // virš – legenda
  const y = (v) => bottom - ((bottom - top) * v) / maxV;
  const lines = st
    .map((s) => {
      const rows = comp.track.length ? [...comp.track, { t: T, counts: comp.track[comp.track.length - 1].counts }] : []; // iki įrašo pabaigos
      const pts = rows.map((r) => `${x(r.t).toFixed(1)},${y(r.counts[s.key] || 0).toFixed(1)}`).join(' ');
      return `<polyline fill="none" stroke="${GROUPS[s.key]?.color || classColor(s.key)}" stroke-width="2" points="${pts}"/>`;
    })
    .join('');
  const ticks = [];
  for (let i = 0; i <= 5; i++) {
    const tt = (T * i) / 5;
    ticks.push(`<text x="${x(tt)}" y="${H - 10}" text-anchor="middle">${fmtDur(tt).replace(/^00:/, '')}</text>`);
  }
  const yt = [0, Math.round(maxV / 2), maxV].map((v) => `<text x="${P - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text><line x1="${P}" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}" stroke="#ccd" stroke-dasharray="3 3"/>`);
  const legend = st.map((s, i) => `<g transform="translate(${P + 10 + i * 190},12)"><rect width="14" height="4" y="4" fill="${GROUPS[s.key]?.color || classColor(s.key)}"/><text x="20" y="10">${esc(s.label)}</text></g>`).join('');
  return `<svg id="chart" viewBox="0 0 ${W} ${H}" data-dur="${T}" data-p="${P}" data-w="${W}">${yt.join('')}${lines}${ticks.join('')}${legend}</svg>`;
}

/**
 * ZIP klientui: ataskaita.html (atsidaro naršyklėje), vaizdo įrašas, duomenys.json, ivykiai.csv, kadrai/.
 * @param {{name:string, video:{blob:Blob, ext:string}, comp:AiComposer, settings:object}} o
 */
export async function reportZip({ name, video, comp, settings }) {
  const { zipSync, strToU8 } = await import('three/examples/jsm/libs/fflate.module.js');
  // Įvykių kadrai gali dar būti ruošiami
  await new Promise((r) => setTimeout(r, 300));
  const st = stats(comp);
  const stR = st.filter((x) => comp.inReport(x.key)); // ataskaitos santraukai ir grafikui – tik pasirinktos grupės
  const files = {};
  const videoName = `irasas.${video.ext}`;
  files[videoName] = new Uint8Array(await video.blob.arrayBuffer());
  const evRows = [];
  let n = 0;
  for (const e of comp.events) {
    let img = '';
    if (e.img) {
      img = `kadrai/ivykis_${String(++n).padStart(3, '0')}.jpg`;
      files[img] = new Uint8Array(await e.img.arrayBuffer());
    }
    evRows.push({ ...e, img });
  }
  const start = new Date(comp.started);
  const dur = (comp.ended || Date.now()) - comp.started;
  const spanText = (e) => e.spans.map(([a, b]) => `${fmtDur(a)}–${fmtDur(b)}`).join(', ');
  const evText = (e) =>
    e.kind === 'start'
      ? t('Įrašo pradžia')
      : e.kind === 'object'
        ? `${gLabel(e.group)} #${e.id}: ${e.spans.length > 1 ? t('matėsi {k} kartus ({s}), iš viso {d}', { k: e.spans.length, s: spanText(e), d: fmtLen(e.spans.reduce((a, [x, y]) => a + (y - x), 0)) }) : t('matėsi {a}–{b} ({d})', { a: fmtDur(e.t), b: fmtDur(e.end), d: fmtLen(e.end - e.t) })}`
        : t('{g}: matėsi {a}–{b} ({d}), daugiausia {n}', { g: gLabel(e.group), a: fmtDur(e.t), b: fmtDur(e.end), d: fmtLen(e.end - e.t), n: e.n });

  // Skrydis (diab telemetrija): maršrutas su įvykių vietomis, santrauka, grafikai; be telemetrijos – nieko
  const fs = flightSummary(comp);
  const flight = await flightSection(
    fs,
    evRows.map((e, i) => ({ t: e.t, pos: e.pos, n: i + 1, color: GROUPS[e.group]?.color, label: evText(e) })),
    comp.started,
  ).catch(() => ({ html: '', files: {} }));
  for (const [k, b] of Object.entries(flight.files)) files[k] = new Uint8Array(await b.arrayBuffer());
  if (fs) files['telemetrija.csv'] = strToU8(telemetryCsv(fs, comp.started));

  // CSV: kiekvienas AI rezultatas
  const groups = st.map((s) => s.key);
  const hasPos = comp.track.some((r) => r.pos);
  const csv = [[t('laikas_s'), t('data_laikas'), ...st.map((s) => s.label), ...(hasPos ? [t('platuma'), t('ilguma'), t('aukstis_m')] : [])].join(';')];
  for (const r of comp.track) csv.push([(r.t / 1000).toFixed(1), fmtClock(new Date(comp.started + r.t)), ...groups.map((g) => r.counts[g] ?? 0), ...(hasPos ? [r.pos?.[0] ?? '', r.pos?.[1] ?? '', r.pos?.[2] ?? ''] : [])].join(';'));
  if (comp.route.length > 1) files['marsrutas.gpx'] = strToU8(trackGpx(`${name} – ${comp.drone || ''}`, comp.route));
  files['ivykiai.csv'] = strToU8('﻿' + [t('laikas_s'), t('data_laikas'), t('pabaiga_s'), t('ivykis'), t('kadras'), t('platuma'), t('ilguma')].join(';') + '\n' + evRows.map((e) => [(e.t / 1000).toFixed(1), fmtClock(new Date(e.at)), e.end != null ? (e.end / 1000).toFixed(1) : '', evText(e), e.img, e.pos?.[0] ?? '', e.pos?.[1] ?? ''].join(';')).join('\n') + '\n');
  files['skaiciai.csv'] = strToU8('﻿' + csv.join('\n') + '\n');
  files['duomenys.json'] = strToU8(
    JSON.stringify({ name, start: start.toISOString(), durationMs: dur, settings, classes: Object.fromEntries(Object.entries(GROUPS).map(([k, g]) => [k, g.classes])), stats: st, unique: comp.unique || null, flight: fs ? { dock: fs.dock, distM: Math.round(fs.dist), telemetry: fs.S } : null, events: evRows.map(({ img: _i, q: _q, shotT: _s, token: _k, ...e }) => e), track: comp.track }, null, 0),
  );

  const nf = (v, d = 0) => new Intl.NumberFormat(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
  const html = `<!doctype html>
<html lang="${locale().slice(0, 2)}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} – ${esc(t('AI stebėjimo ataskaita'))}</title>
<style>
${REPORT_CSS}</style>
</head>
<body>
<header>${logoSvg('logo', '#fff')}<h1>${esc(name)}</h1><p>${esc(t('AI stebėjimo ataskaita'))} · ${esc(fmtClock(start))} · ${esc(t('trukmė {d}', { d: fmtDur(dur) }))}</p></header>
<main>
<section><h2>${esc(t('Vaizdo įrašas'))}</h2><video id="v" src="${videoName}" controls preload="metadata"></video>
<p style="color:var(--mut);font-size:12.5px">${esc(t('Rėmeliai, skaičiai ir laikas įrašyti vaizde. Spustelėjus grafiką ar įvykio laiką – peršokama į tą vietą.'))}</p></section>
<section><h2>${esc(t('Santrauka'))}</h2><div class="cards">
${stR.map((s) => `<div class="card"><span>${esc(s.label)}</span>${comp.unique?.[s.key] ? `<b>${esc(t('{n} skirtingų', { n: comp.unique[s.key] }))}</b><span>${esc(t('daugiausia vienu metu {n}', { n: s.max }))} · ` : `<b>${esc(t('daugiausia {n}', { n: s.max }))}</b><span>`}${esc(t('vidutiniškai {a} · matėsi {p} % laiko', { a: nf(s.avg, 1), p: nf(s.presence * 100) }))}</span></div>`).join('\n')}
<div class="card"><span>${esc(t('Įvykių'))}</span><b>${evRows.length}</b><span>${esc(t('AI analizių: {n}', { n: comp.track.length }))}</span></div>
</div></section>
${flight.html}
<section><h2>${esc(t('Skaičius laike'))}</h2>${chartSvg(comp, stR)}</section>
<section><h2>${esc(t('Įvykiai'))}</h2>
${evRows.length ? `<table><tr><th>${esc(t('Laikas įraše'))}</th><th>${esc(t('Data ir laikas'))}</th><th>${esc(t('Įvykis'))}</th><th>${esc(t('Kadras'))}</th></tr>
${evRows.map((e, i) => `<tr><td>${e.pos && fs?.route.length ? `<b class="evn">${i + 1}</b>` : ''}<a class="t" data-t="${Math.max(0, e.t - 1000) / 1000}">${fmtDur(e.t)}</a></td><td>${esc(fmtClock(new Date(e.at)))}</td><td>${e.group ? `<i class="dot" style="background:${esc(GROUPS[e.group]?.color || '#888')}"></i>` : ''}${esc(evText(e))}<br><span style="color:var(--mut);font-size:12px">${esc(countsText(e.counts))}</span>${e.pos ? `<br><a class="geo" href="https://maps.google.com/?q=${e.pos[0]},${e.pos[1]}" target="_blank">${esc(t('Drono vieta'))}: ${e.pos[0].toFixed(6)}, ${e.pos[1].toFixed(6)}${e.pos[2] != null ? ` · ${Math.round(e.pos[2])} m` : ''}</a>` : ''}</td><td>${e.img ? `<a href="${e.img}" target="_blank"><img src="${e.img}" alt=""></a>` : ''}</td></tr>`).join('\n')}
</table>` : `<p>${esc(t('Įvykių nebuvo.'))}</p>`}
</section>
<section><h2>${esc(t('Duomenys'))}</h2><table class="meta">
<tr><td>${esc(t('Šaltinis'))}</td><td>${esc(name)}</td></tr>
<tr><td>${esc(t('Pradžia'))}</td><td>${esc(fmtClock(start))}</td></tr>
<tr><td>${esc(t('Trukmė'))}</td><td>${esc(fmtDur(dur))}</td></tr>
<tr><td>${esc(t('Ieškota'))}</td><td>${esc(Object.values(GROUPS).map((g) => g.label).join(', '))}</td></tr>
<tr><td>${esc(t('Ataskaitoje'))}</td><td>${esc(stR.map((x) => x.label).join(', ') || '–')}</td></tr>
${comp.drone ? `<tr><td>${esc(t('Dronas'))}</td><td>${esc(comp.drone)}${comp.route.length > 1 ? ` · ${esc(t('maršrutas: marsrutas.gpx'))}` : ''}</td></tr>` : ''}
<tr><td>${esc(t('AI modelis'))}</td><td>${esc(settings.modelName || t('Standartinis (COCO)'))}</td></tr>
<tr><td>${esc(t('Jautrumas'))}</td><td>${Math.round((settings.threshold || 0) * 100)} %</td></tr>
<tr><td>${esc(t('Failai'))}</td><td>${videoName}, skaiciai.csv, ivykiai.csv, duomenys.json, kadrai/${fs ? ', telemetrija.csv' : ''}${comp.route.length > 1 ? ', marsrutas.gpx, skrydis/' : ''}</td></tr>
</table></section>
<footer>${esc(t('Sukurta su Atea 3D Matuoklis. AI rezultatai yra automatiniai ir gali būti netikslūs.'))}</footer>
</main>
<script>
${REPORT_JS}</script>
</body>
</html>
`;
  files['ataskaita.html'] = strToU8(html);
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}

/**
 * Skrydžio ataskaita be AI: vaizdas, maršrutas žemėlapyje, santrauka, telemetrijos grafikai, CSV ir GPX.
 * @returns {Promise<Blob|null>} null – telemetrijos nebuvo
 */
export async function flightReportZip({ name, video, log }) {
  const fs = flightSummary(log);
  if (!fs) return null;
  const { zipSync, strToU8 } = await import('three/examples/jsm/libs/fflate.module.js');
  const files = {};
  const videoName = `irasas.${video.ext}`;
  files[videoName] = new Uint8Array(await video.blob.arrayBuffer());
  const flight = await flightSection(fs, [], log.started).catch(() => ({ html: '', files: {} }));
  for (const [k, b] of Object.entries(flight.files)) files[k] = new Uint8Array(await b.arrayBuffer());
  files['telemetrija.csv'] = strToU8(telemetryCsv(fs, log.started));
  if (log.route.length > 1) files['marsrutas.gpx'] = strToU8(trackGpx(`${name} – ${log.drone || ''}`, log.route));
  files['duomenys.json'] = strToU8(JSON.stringify({ name, start: new Date(log.started).toISOString(), durationMs: fs.dur, drone: log.drone, dock: fs.dock, distM: Math.round(fs.dist), telemetry: fs.S }));
  const start = new Date(log.started);
  const html = `<!doctype html>
<html lang="${locale().slice(0, 2)}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} – ${esc(t('Skrydžio ataskaita'))}</title>
<style>
${REPORT_CSS}</style>
</head>
<body>
<header>${logoSvg('logo', '#fff')}<h1>${esc(name)}</h1><p>${esc(t('Skrydžio ataskaita'))} · ${esc(fmtClock(start))} · ${esc(t('trukmė {d}', { d: fmtDur(fs.dur) }))}</p></header>
<main>
<section><h2>${esc(t('Vaizdo įrašas'))}</h2><video id="v" src="${videoName}" controls preload="metadata"></video>
<p style="color:var(--mut);font-size:12.5px">${esc(t('Spustelėjus grafiką – peršokama į tą vaizdo vietą; žemėlapio žymeklis rodo, kur tuo metu buvo dronas.'))}</p></section>
${flight.html}
<section><h2>${esc(t('Duomenys'))}</h2><table class="meta">
<tr><td>${esc(t('Šaltinis'))}</td><td>${esc(name)}</td></tr>
${log.drone ? `<tr><td>${esc(t('Dronas'))}</td><td>${esc(log.drone)}</td></tr>` : ''}
<tr><td>${esc(t('Pradžia'))}</td><td>${esc(fmtClock(start))}</td></tr>
<tr><td>${esc(t('Trukmė'))}</td><td>${esc(fmtDur(fs.dur))}</td></tr>
<tr><td>${esc(t('Failai'))}</td><td>${videoName}, telemetrija.csv, duomenys.json${log.route.length > 1 ? ', marsrutas.gpx, skrydis/' : ''}</td></tr>
</table></section>
<footer>${esc(t('Sukurta su Atea 3D Matuoklis.'))}</footer>
</main>
<script>
${REPORT_JS}</script>
</body>
</html>
`;
  files['ataskaita.html'] = strToU8(html);
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}
