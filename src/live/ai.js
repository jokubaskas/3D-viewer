// AI aptikimas tiesioginėje transliacijoje: kadras iš grotuvo → vietinė AI paslauga (RF-DETR, /detect) →
// rėmeliai ant vaizdo, skaičiai, įspėjimai ir (pasirinktinai) kadrų kaupimas būsimam modelio mokymui.
import { AI_CLASSES } from '../ai/client.js';
import { t, locale } from '../i18n.js';

/** Detalumas: kadro dydis siunčiant ir plytelės (maži objektai iš aukštai matomi tik skaidant kadrą). */
export const AI_DETAIL = {
  fast: { label: 'Greitas (visas kadras)', maxSide: 960, tile: 960, overlap: 0 },
  normal: { label: 'Įprastas (2×3 dalys)', maxSide: 1600, tile: 640, overlap: 96 },
  detail: { label: 'Detalus – maži objektai iš aukštai (lėčiau)', maxSide: 3840, tile: 640, overlap: 96 },
};

/** Klasių grupės sąsajoje → AI paslaugos klasės. */
export const AI_GROUPS = {
  person: { label: 'Žmonės', classes: ['person'] },
  car: { label: 'Automobiliai', classes: ['car'] },
  heavy: { label: 'Sunkvežimiai ir autobusai', classes: ['truck', 'bus'] },
  two: { label: 'Motociklai ir dviračiai', classes: ['motorcycle', 'bicycle'] },
};

/** Klasės mokymo duomenų rinkinyje (YOLO): COCO dalis + šalmų klasės, kurias reikės pažymėti rankomis. */
export const DATASET_CLASSES = ['person', 'car', 'truck', 'bus', 'motorcycle', 'bicycle', 'helmet', 'no_helmet'];
const MAX_SAMPLES = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Kadras iš &lt;video&gt; / &lt;img&gt; kaip JPEG (sumažintas iki maxSide). */
async function grab(el, maxSide) {
  const w0 = el.videoWidth || el.naturalWidth, h0 = el.videoHeight || el.naturalHeight;
  if (!w0 || !h0) return null;
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.round(w0 * k), h = Math.round(h0 * k);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(el, 0, 0, w, h);
  const blob = await new Promise((res, rej) => {
    try {
      c.toBlob((b) => (b ? res(b) : rej(new Error('JPEG'))), 'image/jpeg', 0.88);
    } catch {
      rej(new Error(t('Šaltinis neleidžia kopijuoti vaizdo – pasirinkite „Per serverį“')));
    }
  });
  return { blob, w, h, k, w0, h0 };
}

export class LiveDetector {
  /**
   * @param {import('./player.js').LivePlayer} player
   * @param {HTMLElement} view – .live-view (ant jo dedama drobė)
   * @param {{getAi:()=>Promise<import('../ai/client.js').AiClient>, settings:()=>object, onUpdate:(d:LiveDetector)=>void, onAlert:(text:string)=>void, onSample:()=>void, samples:object[]}} opts
   */
  constructor(player, view, opts) {
    this.player = player;
    this.view = view;
    this.opts = opts;
    this.on = false;
    this.last = null; // {dets, w, h, at, ms}
    this.error = '';
    this.counts = {};
    this.prevCounts = {};
    this.cv = document.createElement('canvas');
    this.cv.className = 'live-ai-canvas';
    view.insertBefore(this.cv, view.querySelector('.live-overlay')); // po užrašais
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(view);
    this._lastSample = 0;
  }

  start() {
    if (this.on) return;
    this.on = true;
    this.error = '';
    this.loop();
  }

  stop() {
    this.on = false;
    this.ctl?.abort();
    this.last = null;
    this.counts = {};
    this.draw();
    this.opts.onUpdate(this);
  }

  dispose() {
    this.stop();
    this._ro.disconnect();
    this.cv.remove();
  }

  async loop() {
    while (this.on) {
      const el = this.player.el;
      const ok = this.player.state === 'live' && (el instanceof HTMLVideoElement || el instanceof HTMLImageElement);
      if (!ok) {
        if (this.player.embedded) {
          this.error = t('AI veikia tik su vaizdo srautu, ne su įterptu tinklalapiu');
          this.opts.onUpdate(this);
        }
        await sleep(700);
        continue;
      }
      const s = this.opts.settings();
      const det = AI_DETAIL[s.detail] || AI_DETAIL.normal;
      const classes = Object.entries(AI_GROUPS).filter(([k]) => s.groups[k]).flatMap(([, g]) => g.classes);
      if (!classes.length) {
        await sleep(700);
        continue;
      }
      const t0 = performance.now();
      try {
        const fr = await grab(el, det.maxSide);
        if (!fr) {
          await sleep(300);
          continue;
        }
        const ai = await this.opts.getAi();
        this.ctl = new AbortController();
        const res = await ai.detect(fr.blob, { classes, threshold: s.threshold, tile: Math.min(det.tile, Math.max(fr.w, fr.h)), overlap: det.overlap, refine: false, signal: this.ctl.signal });
        if (!this.on) break;
        if (res.cancelled) continue;
        const dets = (res.detections || []).map((d) => ({ ...d, box: d.box.map((v) => v / fr.k) }));
        this.last = { dets, w: fr.w0, h: fr.h0, at: performance.now(), ms: performance.now() - t0 };
        this.error = '';
        this.updateCounts(dets, s);
        this.collect(fr, res.detections || [], s);
      } catch (e) {
        if (e.name === 'AbortError' || !this.on) break;
        this.error = e.message;
        this.last = null;
        await sleep(3000);
      }
      this.draw();
      this.opts.onUpdate(this);
      // Ne dažniau kaip ~3 kartus per sekundę – kad liktų laiko ir kitoms transliacijoms
      const dt = performance.now() - t0;
      if (dt < 330) await sleep(330 - dt);
    }
  }

  updateCounts(dets, s) {
    const c = {};
    for (const [k, g] of Object.entries(AI_GROUPS)) if (s.groups[k]) c[k] = dets.filter((d) => g.classes.includes(d.class)).length;
    this.prevCounts = this.counts;
    this.counts = c;
    // Įspėjimas: atsirado žmonių (anksčiau nebuvo)
    if (s.alertPerson && c.person > 0 && !(this.prevCounts.person > 0)) this.opts.onAlert(t('Aptikta žmonių: {n}', { n: c.person }));
  }

  /** Kadrų kaupimas mokymui: kas ~3 s, kai yra aptikimų (arba kas 15 s – ir „tušti“ kadrai reikalingi). */
  collect(fr, dets, s) {
    if (!s.collect) return;
    const now = Date.now();
    const gap = dets.length ? 3000 : 15000;
    if (now - this._lastSample < gap || this.opts.samples.length >= MAX_SAMPLES) return;
    this._lastSample = now;
    this.opts.samples.push({ blob: fr.blob, w: fr.w, h: fr.h, dets: dets.map((d) => ({ class: d.class, box: d.box, score: d.score })), at: now, source: this.player.stream.name });
    this.opts.onSample();
  }

  /** Rėmeliai ant vaizdo (vaizdas „contain“ – su juodomis juostomis). */
  draw() {
    const cv = this.cv, view = this.view, dpr = devicePixelRatio || 1;
    const W = view.clientWidth, H = view.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    const L = this.last;
    if (!this.on || !L) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const k = Math.min(W / L.w, H / L.h);
    const ox = (W - L.w * k) / 2, oy = (H - L.h * k) / 2;
    const age = (performance.now() - L.at) / 1000;
    g.globalAlpha = age > 4 ? 0.35 : 1;
    g.font = '600 11px Inter, Segoe UI, sans-serif';
    g.lineWidth = 2;
    for (const d of L.dets) {
      const [x1, y1, x2, y2] = d.box;
      const x = ox + x1 * k, y = oy + y1 * k, w = (x2 - x1) * k, h = (y2 - y1) * k;
      const color = AI_CLASSES[d.class]?.color || '#fff';
      g.strokeStyle = color;
      g.strokeRect(x, y, w, h);
      if (w > 14 || L.dets.length < 40) {
        const label = `${t(AI_CLASSES[d.class]?.lt || d.class)} ${Math.round(d.score * 100)}%`;
        const tw = g.measureText(label).width + 6;
        g.fillStyle = color;
        g.fillRect(x, y - 15 < 0 ? y : y - 15, tw, 15);
        g.fillStyle = '#111';
        g.fillText(label, x + 3, (y - 15 < 0 ? y : y - 15) + 11);
      }
    }
    g.globalAlpha = 1;
  }

  /** Trumpas aprašas juostai: „Žmonės 3 · Automobiliai 12 · 0,8 s“. */
  summary() {
    if (this.error) return this.error;
    if (!this.last) return t('AI: laukiama pirmo rezultato…');
    const parts = Object.entries(this.counts).map(([k, n]) => `${t(AI_GROUPS[k].label)} ${n}`);
    parts.push(t('AI kas {s} s', { s: new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format(Math.max(this.last.ms, 330) / 1000) }));
    return parts.join(' · ');
  }
}

/** Sukaupti kadrai → ZIP (YOLO formatas): images/, labels/, data.yaml ir paaiškinimas. */
export async function datasetZip(samples) {
  const { zipSync, strToU8 } = await import('three/examples/jsm/libs/fflate.module.js');
  const files = {};
  const pad = (i) => String(i + 1).padStart(4, '0');
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    files[`images/kadras_${pad(i)}.jpg`] = new Uint8Array(await s.blob.arrayBuffer());
    const lines = s.dets
      .filter((d) => DATASET_CLASSES.includes(d.class))
      .map((d) => {
        const [x1, y1, x2, y2] = d.box;
        const cx = (x1 + x2) / 2 / s.w, cy = (y1 + y2) / 2 / s.h, w = (x2 - x1) / s.w, h = (y2 - y1) / s.h;
        return `${DATASET_CLASSES.indexOf(d.class)} ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`;
      });
    files[`labels/kadras_${pad(i)}.txt`] = strToU8(lines.join('\n') + (lines.length ? '\n' : ''));
  }
  files['classes.txt'] = strToU8(DATASET_CLASSES.join('\n') + '\n');
  files['data.yaml'] = strToU8(`# Atea 3D Matuoklis – kadrai iš tiesioginės transliacijos (YOLO formatas)\npath: .\ntrain: images\nval: images\nnames:\n${DATASET_CLASSES.map((c, i) => `  ${i}: ${c}`).join('\n')}\n`);
  files['SKAITYK.txt'] = strToU8(
    [
      'Kadrai su automatiniais AI pažymėjimais (žmonės, transportas) – pradinis duomenų rinkinys modelio mokymui.',
      '',
      '1. Įkelkite aplanką į žymėjimo programą (CVAT, Label Studio arba Roboflow) kaip YOLO formatą.',
      '2. Patikrinkite ir pataisykite automatinius rėmelius.',
      '3. Pažymėkite naujas klases: helmet (statybinis šalmas) ir no_helmet (galva be šalmo).',
      '4. Reikia bent 300–1000 kadrų iš panašaus aukščio ir kampo, kokiu skraidysite.',
      '5. Pažymėtą rinkinį galima naudoti RF-DETR modelio pritaikymui (fine-tuning) – po to modelis',
      '   įdedamas į AI paslaugą vietoje standartinio.',
      '',
      `Kadrų: ${samples.length}. Sukurta: ${new Date().toLocaleString('lt-LT')}.`,
    ].join('\n'),
  );
  return new Blob([zipSync(files, { level: 0 })], { type: 'application/zip' });
}
