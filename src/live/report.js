// AI įrašas klientui: vaizdas su įrašytais rėmeliais, skaičiais ir laiku + ataskaita (HTML, CSV, JSON, įvykių kadrai).
// Įrašoma ne pats grotuvas, o drobė, ant kurios kiekvieną kadrą piešiamas vaizdas ir paskutiniai AI rezultatai.
import { AI_CLASSES } from '../ai/client.js';
import { AI_GROUPS } from './ai.js';
import { t, locale } from '../i18n.js';

const FPS = 25;
const MAX_EVENTS = 80;
const pad2 = (n) => String(n).padStart(2, '0');
const fmtClock = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const fmtDur = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
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
  const vw = el.videoWidth || el.naturalWidth, vh = el.videoHeight || el.naturalHeight;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  if (!vw || !vh) return;
  const k = Math.min(W / vw, H / vh);
  const ox = (W - vw * k) / 2, oy = (H - vh * k) / 2;
  g.drawImage(el, ox, oy, vw * k, vh * k);
  const s = W / 1280; // užrašų mastelis
  if (last && performance.now() - last.at < 4000) {
    const kk = Math.min(W / last.w, H / last.h);
    const ox2 = (W - last.w * kk) / 2, oy2 = (H - last.h * kk) / 2;
    g.lineWidth = Math.max(2, 2.5 * s);
    g.font = `600 ${Math.round(13 * s)}px Inter, Segoe UI, sans-serif`;
    for (const d of last.dets) {
      const [x1, y1, x2, y2] = d.box;
      const x = ox2 + x1 * kk, y = oy2 + y1 * kk, w = (x2 - x1) * kk, h = (y2 - y1) * kk;
      const color = AI_CLASSES[d.class]?.color || '#fff';
      g.strokeStyle = color;
      g.strokeRect(x, y, w, h);
      const label = `${t(AI_CLASSES[d.class]?.lt || d.class)} ${Math.round(d.score * 100)}%`;
      const th = Math.round(17 * s), tw = g.measureText(label).width + 8 * s;
      const ly = y - th < 0 ? y : y - th;
      g.fillStyle = color;
      g.fillRect(x, ly, tw, th);
      g.fillStyle = '#111';
      g.fillText(label, x + 4 * s, ly + th - 4 * s);
    }
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
  g.font = `600 ${Math.round(11 * s)}px Inter, Segoe UI, sans-serif`;
  const mark = 'Atea 3D Matuoklis';
  g.fillStyle = 'rgba(255,255,255,0.6)';
  g.fillText(mark, W - g.measureText(mark).width - 10 * s, H - 10 * s);
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

const countsText = (counts) =>
  Object.entries(counts || {})
    .map(([k, n]) => `${t(AI_GROUPS[k]?.label || k)}: ${n}`)
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
    this.started = Date.now();
    this.t0 = performance.now();
    this.track = []; // {t, counts, dets:[[class, score, x1, y1, x2, y2] (0…1)]}
    this.events = []; // {t, kind, group, n, counts, img?:Blob}
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
    this._prev = { ...detector.counts };
    this.draw();
    // Pirmas įvykis – įrašo pradžia su tuo metu matomais objektais
    const ev0 = { t: 0, at: Date.now(), kind: 'start', group: null, n: 0, counts: { ...detector.counts } };
    this.events.push(ev0);
    this.snapshot().then((b) => (ev0.img = b));
    this._stopTick = ticker(1000 / FPS, () => this.draw());
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
    return [`● REC ${fmtDur(Date.now() - this.started)}   ${fmtClock(now)}`, this.meta.name, countsText(this.detector.counts)].filter(Boolean);
  }

  draw() {
    const el = this.player.el;
    if (!(el instanceof HTMLVideoElement || el instanceof HTMLImageElement)) return;
    try {
      drawComposite(this.g, el, this.detector.last, { W: this.cv.width, H: this.cv.height, lines: this.hud() });
    } catch { /* kadras dar neparuoštas */ }
  }

  onResult(d) {
    const t1 = Date.now() - this.started;
    const L = d.last;
    if (!L) return;
    const counts = { ...d.counts };
    this.track.push({
      t: t1,
      counts,
      dets: L.dets.map((x) => [x.class, +x.score.toFixed(2), ...x.box.map((v, i) => +(v / (i % 2 ? L.h : L.w)).toFixed(4))]),
    });
    for (const [k, n] of Object.entries(counts)) {
      const prev = this._prev?.[k] ?? 0;
      if (n > (this.max[k] ?? -1)) this.max[k] = n;
      // Įvykiai: atsirado / išnyko (ne dažniau nei kas 5 s tai pačiai grupei)
      const kind = prev === 0 && n > 0 ? 'appeared' : prev > 0 && n === 0 ? 'gone' : null;
      if (!kind || this.events.length >= MAX_EVENTS) continue;
      const lastSame = [...this.events].reverse().find((e) => e.group === k);
      if (lastSame && t1 - lastSame.t < 5000 && lastSame.kind === kind) continue;
      const ev = { t: t1, at: Date.now(), kind, group: k, n, counts };
      this.events.push(ev);
      if (kind === 'appeared') this.snapshot().then((b) => (ev.img = b));
    }
    this._prev = counts;
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
  }
}

// ------------------------------------------------------------------ ataskaita
function stats(comp) {
  const groups = Object.keys(AI_GROUPS).filter((k) => comp.track.some((r) => k in r.counts));
  const dur = (comp.ended || Date.now()) - comp.started;
  return groups.map((k) => {
    const vals = comp.track.map((r) => r.counts[k] || 0);
    const present = vals.filter((v) => v > 0).length;
    return {
      key: k,
      label: t(AI_GROUPS[k].label),
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
  const colors = { person: AI_CLASSES.person.color, car: AI_CLASSES.car.color, heavy: AI_CLASSES.truck.color, two: AI_CLASSES.motorcycle.color };
  const lines = st
    .map((s) => {
      const rows = comp.track.length ? [...comp.track, { t: T, counts: comp.track[comp.track.length - 1].counts }] : []; // iki įrašo pabaigos
      const pts = rows.map((r) => `${x(r.t).toFixed(1)},${y(r.counts[s.key] || 0).toFixed(1)}`).join(' ');
      return `<polyline fill="none" stroke="${colors[s.key] || '#fff'}" stroke-width="2" points="${pts}"/>`;
    })
    .join('');
  const ticks = [];
  for (let i = 0; i <= 5; i++) {
    const tt = (T * i) / 5;
    ticks.push(`<text x="${x(tt)}" y="${H - 10}" text-anchor="middle">${fmtDur(tt).replace(/^00:/, '')}</text>`);
  }
  const yt = [0, Math.round(maxV / 2), maxV].map((v) => `<text x="${P - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text><line x1="${P}" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}" stroke="#ccd" stroke-dasharray="3 3"/>`);
  const legend = st.map((s, i) => `<g transform="translate(${P + 10 + i * 190},12)"><rect width="14" height="4" y="4" fill="${colors[s.key]}"/><text x="20" y="10">${esc(s.label)}</text></g>`).join('');
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
  const evText = (e) => (e.kind === 'start' ? t('Įrašo pradžia') : e.kind === 'appeared' ? t('Atsirado: {g} ({n})', { g: t(AI_GROUPS[e.group].label), n: e.n }) : t('Išnyko: {g}', { g: t(AI_GROUPS[e.group].label) }));

  // CSV: kiekvienas AI rezultatas
  const groups = st.map((s) => s.key);
  const csv = [[t('laikas_s'), t('data_laikas'), ...st.map((s) => s.label)].join(';')];
  for (const r of comp.track) csv.push([(r.t / 1000).toFixed(1), fmtClock(new Date(comp.started + r.t)), ...groups.map((g) => r.counts[g] ?? 0)].join(';'));
  files['ivykiai.csv'] = strToU8('﻿' + [t('laikas_s'), t('data_laikas'), t('ivykis')].join(';') + '\n' + evRows.map((e) => [(e.t / 1000).toFixed(1), fmtClock(new Date(e.at)), evText(e)].join(';')).join('\n') + '\n');
  files['skaiciai.csv'] = strToU8('﻿' + csv.join('\n') + '\n');
  files['duomenys.json'] = strToU8(
    JSON.stringify({ name, start: start.toISOString(), durationMs: dur, settings, classes: Object.fromEntries(Object.entries(AI_GROUPS).map(([k, g]) => [k, g.classes])), stats: st, events: evRows.map(({ img: _i, ...e }) => e), track: comp.track }, null, 0),
  );

  const nf = (v, d = 0) => new Intl.NumberFormat(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
  const html = `<!doctype html>
<html lang="${locale().slice(0, 2)}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} – ${esc(t('AI stebėjimo ataskaita'))}</title>
<style>
  :root { --g: #008b01; --ink: #1f2326; --mut: #6b7570; }
  body { font-family: Inter, "Segoe UI", system-ui, sans-serif; color: var(--ink); margin: 0; background: #f4f6f5; }
  header { background: #1f2326; color: #fff; padding: 18px 28px; border-bottom: 4px solid var(--g); }
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
  td img { width: 220px; border-radius: 6px; display: block; }
  a.t { color: var(--g); font-weight: 600; text-decoration: none; cursor: pointer; }
  .meta td:first-child { color: var(--mut); width: 220px; }
  footer { text-align: center; color: var(--mut); font-size: 12px; }
  @media print { video { display: none; } body { background: #fff; } section { box-shadow: none; border: 1px solid #ddd; break-inside: avoid; } td img { width: 160px; } }
</style>
</head>
<body>
<header><h1>${esc(name)}</h1><p>${esc(t('AI stebėjimo ataskaita'))} · ${esc(fmtClock(start))} · ${esc(t('trukmė {d}', { d: fmtDur(dur) }))}</p></header>
<main>
<section><h2>${esc(t('Vaizdo įrašas'))}</h2><video id="v" src="${videoName}" controls preload="metadata"></video>
<p style="color:var(--mut);font-size:12.5px">${esc(t('Rėmeliai, skaičiai ir laikas įrašyti vaizde. Spustelėjus grafiką ar įvykio laiką – peršokama į tą vietą.'))}</p></section>
<section><h2>${esc(t('Santrauka'))}</h2><div class="cards">
${st.map((s) => `<div class="card"><span>${esc(s.label)}</span><b>${esc(t('daugiausia {n}', { n: s.max }))}</b><span>${esc(t('vidutiniškai {a} · matėsi {p} % laiko', { a: nf(s.avg, 1), p: nf(s.presence * 100) }))}</span></div>`).join('\n')}
<div class="card"><span>${esc(t('Įvykių'))}</span><b>${evRows.length}</b><span>${esc(t('AI analizių: {n}', { n: comp.track.length }))}</span></div>
</div></section>
<section><h2>${esc(t('Skaičius laike'))}</h2>${chartSvg(comp, st)}</section>
<section><h2>${esc(t('Įvykiai'))}</h2>
${evRows.length ? `<table><tr><th>${esc(t('Laikas įraše'))}</th><th>${esc(t('Data ir laikas'))}</th><th>${esc(t('Įvykis'))}</th><th>${esc(t('Kadras'))}</th></tr>
${evRows.map((e) => `<tr><td><a class="t" data-t="${e.t / 1000}">${fmtDur(e.t)}</a></td><td>${esc(fmtClock(new Date(e.at)))}</td><td>${esc(evText(e))}<br><span style="color:var(--mut);font-size:12px">${esc(countsText(e.counts))}</span></td><td>${e.img ? `<img src="${e.img}" alt="">` : ''}</td></tr>`).join('\n')}
</table>` : `<p>${esc(t('Įvykių nebuvo.'))}</p>`}
</section>
<section><h2>${esc(t('Duomenys'))}</h2><table class="meta">
<tr><td>${esc(t('Šaltinis'))}</td><td>${esc(name)}</td></tr>
<tr><td>${esc(t('Pradžia'))}</td><td>${esc(fmtClock(start))}</td></tr>
<tr><td>${esc(t('Trukmė'))}</td><td>${esc(fmtDur(dur))}</td></tr>
<tr><td>${esc(t('Ieškota'))}</td><td>${esc(Object.entries(AI_GROUPS).filter(([k]) => settings.groups?.[k]).map(([, g]) => t(g.label)).join(', '))}</td></tr>
<tr><td>${esc(t('Jautrumas'))}</td><td>${Math.round((settings.threshold || 0) * 100)} %</td></tr>
<tr><td>${esc(t('Failai'))}</td><td>${videoName}, skaiciai.csv, ivykiai.csv, duomenys.json, kadrai/</td></tr>
</table></section>
<footer>${esc(t('Sukurta su Atea 3D Matuoklis. AI rezultatai yra automatiniai ir gali būti netikslūs.'))}</footer>
</main>
<script>
  const v = document.getElementById('v');
  const seek = (s) => { v.currentTime = s; v.play(); v.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  document.querySelectorAll('a.t').forEach((a) => a.onclick = () => seek(+a.dataset.t));
  const c = document.getElementById('chart');
  c.onclick = (e) => { const r = c.getBoundingClientRect(), W = +c.dataset.w, P = +c.dataset.p; const x = (e.clientX - r.left) / r.width * W; seek(Math.max(0, (x - P) / (W - P - 10)) * c.dataset.dur / 1000); };
</script>
</body>
</html>
`;
  files['ataskaita.html'] = strToU8(html);
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}
