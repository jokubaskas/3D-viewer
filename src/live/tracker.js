// Objektų sekimas transliacijoje: kiekvienam aptiktam objektui – pastovus numeris (#1, #2…).
// Trumpam (tarp AI analizių) objektas susiejamas pagal vietą ir judėjimo kryptį, o kai jis dingsta iš kadro ir
// vėl pasirodo – pagal išvaizdą (spalvų „parašas“ viršutinėje ir apatinėje dalyje), todėl skaičiuojamas ne kaip naujas.
// Iš judančio drono panašiai apsirengę žmonės (vienodos liemenės) gali būti supainioti – tai apytikslis atpažinimas.

const BINS_H = 12, BINS_S = 3, BINS_V = 3;
const HIST = BINS_H * BINS_S * BINS_V;
const CONFIRM = 2; // numeris suteikiamas po 2 aptikimų (pavieniai klaidingi aptikimai numerių „nesuvalgo“)
const TENTATIVE_MS = 4000; // nepatvirtintas objektas pamirštamas po 4 s
const ACTIVE_MS = 4000; // tiek laiko objektas laikomas „matomu“ – susiejamas pagal vietą
const REID_SIM = 0.78; // išvaizdos panašumas grįžusiam objektui atpažinti

const sample = document.createElement('canvas');
sample.width = 16;
sample.height = 32;
const sg = sample.getContext('2d', { willReadFrequently: true });

/** Spalvų histograma (HSV) atskirai viršutinei ir apatinei objekto daliai – normuota. */
function appearance(frame, box, k) {
  const [x1, y1, x2, y2] = box.map((v) => v * k);
  const w = x2 - x1, h = y2 - y1;
  if (w < 2 || h < 2) return null;
  // Apkarpoma 15 % kraštų – mažiau fono
  sg.drawImage(frame, x1 + w * 0.15, y1 + h * 0.08, w * 0.7, h * 0.84, 0, 0, 16, 32);
  const px = sg.getImageData(0, 0, 16, 32).data;
  const hist = new Float32Array(HIST * 2);
  for (let i = 0; i < 16 * 32; i++) {
    const r = px[i * 4] / 255, g = px[i * 4 + 1] / 255, b = px[i * 4 + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let hh = 0;
    if (d > 1e-6) hh = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    const s = mx ? d / mx : 0;
    const bin = Math.min(BINS_H - 1, Math.floor((hh / 6) * BINS_H)) * BINS_S * BINS_V + Math.min(BINS_S - 1, Math.floor(s * BINS_S)) * BINS_V + Math.min(BINS_V - 1, Math.floor(mx * BINS_V));
    hist[(i < 256 ? 0 : HIST) + bin] += 1;
  }
  for (let i = 0; i < hist.length; i++) hist[i] /= 256;
  return hist;
}

/** Bhattacharyya panašumas (0…1), viršus ir apačia po lygiai. */
function similarity(a, b) {
  if (!a || !b) return 0;
  let s1 = 0, s2 = 0;
  for (let i = 0; i < HIST; i++) s1 += Math.sqrt(a[i] * b[i]);
  for (let i = HIST; i < HIST * 2; i++) s2 += Math.sqrt(a[i] * b[i]);
  return (s1 + s2) / 2;
}

function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = ix * iy;
  return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i || 1);
}

export class Tracker {
  /** @param {{memoryMs?:number}} o – kiek laiko prisimenamas dingęs objektas */
  constructor(o = {}) {
    this.memoryMs = o.memoryMs ?? 10 * 60 * 1000;
    this.tracks = [];
    this.nextId = 1;
    this.unique = {}; // grupė → kiek skirtingų objektų matyta
  }

  reset() {
    this.tracks = [];
    this.nextId = 1;
    this.unique = {};
  }

  /**
   * Priskiria aptikimams numerius (d.id, d.isNew – naujas objektas, d.returned – grįžęs po pertraukos).
   * @param {{class:string, score:number, box:number[]}[]} dets – vaizdo koordinatėmis
   * @param {(cls:string)=>string|null} groupOf – klasė → grupė (sekama atskirai kiekvienai grupei)
   * @param {HTMLCanvasElement} frame – analizuotas kadras; k – mastelis vaizdo → kadro koordinatės
   * @param {number} t – laikas, ms
   */
  update(dets, groupOf, frame, k, t) {
    this.tracks = this.tracks.filter((tr) => (tr.id ? t - tr.lastT < this.memoryMs : t - tr.lastT < TENTATIVE_MS));
    const items = dets.map((d) => ({ d, g: groupOf(d.class), hist: frame ? appearance(frame, d.box, k) : null })).filter((x) => x.g);
    // 1. Matomi objektai: vieta (su numatytu poslinkiu) + išvaizda
    const pairs = [];
    items.forEach((it, i) => {
      const b = it.d.box, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, sz = Math.hypot(b[2] - b[0], b[3] - b[1]);
      this.tracks.forEach((tr, j) => {
        if (tr.g !== it.g || t - tr.lastT > ACTIVE_MS) return;
        const dt = Math.min(t - tr.lastT, 1500);
        const p = tr.box.map((v, n) => v + (n % 2 ? tr.vy : tr.vx) * dt);
        const dist = Math.hypot(cx - (p[0] + p[2]) / 2, cy - (p[1] + p[3]) / 2) / Math.max(sz, tr.size);
        if (dist > 3) return;
        const sim = similarity(it.hist, tr.hist);
        const score = 0.45 * iou(b, p) + 0.35 * sim + 0.2 * (1 - dist / 3);
        if (score > 0.3) pairs.push({ i, j, score });
      });
    });
    pairs.sort((a, b) => b.score - a.score);
    const usedI = new Set(), usedJ = new Set();
    for (const { i, j } of pairs) {
      if (usedI.has(i) || usedJ.has(j)) continue;
      usedI.add(i);
      usedJ.add(j);
      this.assign(items[i], this.tracks[j], t);
    }
    // 2. Neatpažinti – ar tai grįžęs (anksčiau matytas) objektas? Tik pagal išvaizdą.
    const lost = this.tracks.map((tr, j) => ({ tr, j })).filter(({ tr, j }) => tr.id && !usedJ.has(j) && t - tr.lastT > 800);
    const re = [];
    items.forEach((it, i) => {
      if (usedI.has(i) || !it.hist) return;
      for (const { tr, j } of lost) if (tr.g === it.g) {
        const sim = similarity(it.hist, tr.hist);
        if (sim >= REID_SIM) re.push({ i, j, sim });
      }
    });
    re.sort((a, b) => b.sim - a.sim);
    for (const { i, j } of re) {
      if (usedI.has(i) || usedJ.has(j)) continue;
      usedI.add(i);
      usedJ.add(j);
      this.assign(items[i], this.tracks[j], t, true);
    }
    // 3. Nauji objektai
    items.forEach((it, i) => {
      if (usedI.has(i)) return;
      const b = it.d.box;
      const tr = { id: 0, g: it.g, box: b, vx: 0, vy: 0, size: Math.hypot(b[2] - b[0], b[3] - b[1]), hist: it.hist, hits: 0, firstT: t, lastT: t };
      this.tracks.push(tr);
      this.assign(it, tr, t);
    });
  }

  assign(it, tr, t, returned = false) {
    const b = it.d.box;
    const dt = t - tr.lastT;
    if (dt > 0 && dt < 3000 && tr.hits) {
      // Greitis (px/ms) – vidurkinamas, kad sektų ir judant dronui
      const vx = ((b[0] + b[2]) / 2 - (tr.box[0] + tr.box[2]) / 2) / dt, vy = ((b[1] + b[3]) / 2 - (tr.box[1] + tr.box[3]) / 2) / dt;
      tr.vx = tr.vx * 0.5 + vx * 0.5;
      tr.vy = tr.vy * 0.5 + vy * 0.5;
    } else if (returned) tr.vx = tr.vy = 0;
    tr.box = b;
    tr.size = Math.hypot(b[2] - b[0], b[3] - b[1]);
    if (it.hist) {
      if (!tr.hist) tr.hist = it.hist;
      else for (let n = 0; n < tr.hist.length; n++) tr.hist[n] = tr.hist[n] * 0.85 + it.hist[n] * 0.15;
    }
    tr.hits++;
    tr.lastT = t;
    if (!tr.id && tr.hits >= CONFIRM) {
      tr.id = this.nextId++;
      this.unique[tr.g] = (this.unique[tr.g] || 0) + 1;
      it.d.isNew = true;
    }
    it.d.id = tr.id || 0;
    if (returned && tr.id) it.d.returned = true;
  }
}
