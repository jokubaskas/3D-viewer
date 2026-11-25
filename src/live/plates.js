// Valstybinių numerių filtras tiesioginėje transliacijoje: transporto priemonių iškarpos iš pilnos raiškos kadro →
// vietinė AI paslauga (/plates, fast-alpr) → numerių balsavimas per kelis kadrus → priartintas numeris ant vaizdo
// ir sąrašas ataskaitai. Duomenys laikomi tik naršyklės atmintyje ir įrašo ataskaitoje (asmens duomenys – BDAR).

export const PLATE_VEHICLES = ['car', 'truck', 'bus', 'motorcycle'];
const MIN_SIDE = 40; // mažesnės (pilnos raiškos px) transporto priemonės – numeris neįskaitomas, nesiunčiama
const MAX_CROPS = 6; // vienoje užklausoje – didžiausios transporto priemonės
const PAD = 0.15; // iškarpa – rėmelis + 15 %
const INTERVAL = 900; // ms tarp užklausų
const SHOW_MS = 3500; // kiek laiko rodomas priartintas numeris po paskutinio perskaitymo
const TEXT_RE = /^[A-Z0-9]{4,10}$/;
const MIN_SCORE = 0.5;
const SURE = 0.85; // vienas perskaitymas su tokiu tikrumu – numeris laikomas patvirtintu

/** Redagavimo atstumas (iki 2 – daugiau nereikia). */
function near(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 9;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

const blobOf = (c, q = 0.92) => new Promise((r) => c.toBlob(r, 'image/jpeg', q));

function crop(src, x, y, w, h, maxSide = 1024) {
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
  return { c, k };
}

export class PlateBook {
  constructor() {
    this.reset();
  }

  reset() {
    this.recs = []; // {key, id, votes:Map, text, score, reads, firstAt, lastAt, box, vbox, img}
    this.busy = false;
    this.lastReq = 0;
    this.seq = 0;
    this.error = '';
  }

  due(now = performance.now()) {
    return !this.busy && now - this.lastReq >= INTERVAL;
  }

  /** Patvirtinti numeriai (ne vieno neaiškaus perskaitymo). */
  get confirmed() {
    return this.recs.filter((r) => r.sure);
  }

  /**
   * @param {import('../ai/client.js').AiClient} ai
   * @param {HTMLCanvasElement} native – pilnos raiškos kadras (tas pats, kuris analizuotas)
   * @param {{class:string, box:number[], id?:number}[]} dets – transporto priemonės (pilnos raiškos px)
   * @param {number} at – kadro laikas (performance.now())
   */
  async read(ai, native, dets, at) {
    this.lastReq = performance.now();
    const W = native.width, H = native.height;
    const cand = dets
      .filter((d) => PLATE_VEHICLES.includes(d.class) && Math.min(d.box[2] - d.box[0], d.box[3] - d.box[1]) >= MIN_SIDE)
      .sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]))
      .slice(0, MAX_CROPS);
    if (!cand.length) return false;
    this.busy = true;
    try {
      const parts = cand.map((d) => {
        const [x1, y1, x2, y2] = d.box, pw = (x2 - x1) * PAD, ph = (y2 - y1) * PAD;
        const x = Math.max(0, Math.floor(x1 - pw)), y = Math.max(0, Math.floor(y1 - ph));
        const w = Math.min(W, Math.ceil(x2 + pw)) - x, h = Math.min(H, Math.ceil(y2 + ph)) - y;
        return { d, x, y, ...crop(native, x, y, w, h) };
      });
      const blobs = await Promise.all(parts.map((p) => blobOf(p.c)));
      const res = await ai.plates(blobs);
      (res.results || []).forEach((list, i) => {
        const p = parts[i];
        const best = (list || []).filter((r) => TEXT_RE.test(r.text || '') && r.score >= MIN_SCORE).sort((a, b) => b.det * b.score - a.det * a.score)[0];
        if (!best) return;
        const box = best.box.map((v, n) => (n % 2 ? p.y : p.x) + v / p.k);
        this.add(best.text, best.score, box, p.d, native, at);
      });
      this.error = '';
      return true;
    } catch (e) {
      this.error = e.message;
      return false;
    } finally {
      this.busy = false;
    }
  }

  add(text, score, box, veh, native, at) {
    const recent = (r, ms) => at - r.lastAt < ms;
    const rec =
      (veh.id && this.recs.find((r) => r.id === veh.id && recent(r, 30000))) ||
      this.recs.find((r) => r.votes.has(text)) ||
      this.recs.find((r) => recent(r, 60000) && near(r.text, text) <= 1) ||
      this.recs[this.recs.push({ key: ++this.seq, id: veh.id || null, votes: new Map(), text, score: 0, reads: 0, firstAt: at, lastAt: at }) - 1];
    rec.votes.set(text, (rec.votes.get(text) || 0) + score);
    rec.reads++;
    rec.lastAt = at;
    rec.box = box;
    rec.vbox = veh.box;
    if (veh.id) rec.id = veh.id;
    rec.cls = veh.class;
    // Rodomas tekstas – daugiausia balsų surinkęs variantas; iškarpa – geriausias to varianto perskaitymas
    const top = [...rec.votes].sort((a, b) => b[1] - a[1])[0][0];
    if (text === top && (rec.text !== top || score >= rec.score || !rec.img)) {
      const [x1, y1, x2, y2] = box, bw = x2 - x1, bh = y2 - y1;
      const x = Math.max(0, x1 - bw * 0.2), y = Math.max(0, y1 - bh * 0.35);
      rec.img = crop(native, x, y, Math.min(native.width - x, bw * 1.4), Math.min(native.height - y, bh * 1.7), 640).c;
      rec.score = score;
    }
    rec.text = top;
    // Patvirtintas: bent du perskaitymai sutampa arba vienas labai tikras
    rec.sure = rec.votes.get(top) >= 2 * MIN_SCORE || rec.score >= SURE;
  }

  /** Šiuo metu rodomi (neseniai perskaityti) numeriai. */
  visible(now = performance.now()) {
    return this.recs.filter((r) => now - r.lastAt < SHOW_MS && r.img);
  }
}

/**
 * Priartinti numeriai ant vaizdo: šalia automobilio – padidinta numerio iškarpa ir perskaitytas tekstas.
 * @param {CanvasRenderingContext2D} g
 * @param {PlateBook} book
 * @param {{dets:object[]}|null} last – paskutinis AI rezultatas (automobilio poslinkiui sekti)
 * @param {{k:number, ox:number, oy:number, s?:number, W:number, H:number}} m – kadro px → drobės px
 */
export function drawPlates(g, book, last, m) {
  if (!book) return;
  const s = m.s || 1;
  for (const r of book.visible()) {
    // Automobilis pajudėjo nuo perskaitymo – numerio vieta pastumiama kartu (pagal sekimo numerį)
    const cur = r.id && last?.dets.find((d) => d.id === r.id);
    const dx = cur ? (cur.box[0] + cur.box[2] - r.vbox[0] - r.vbox[2]) / 2 : 0;
    const dy = cur ? (cur.box[1] + cur.box[3] - r.vbox[1] - r.vbox[3]) / 2 : 0;
    const [x1, y1, x2, y2] = r.box;
    const px = m.ox + (x1 + dx) * m.k, py = m.oy + (y1 + dy) * m.k, pw = (x2 - x1) * m.k, ph = (y2 - y1) * m.k;
    // Priartinimas: iškarpa ~70 px aukščio (bent 2× didesnė nei vaizde)
    const ih = Math.max(70 * s, ph * 2 * 1.7), iw = (ih * r.img.width) / r.img.height;
    const th = Math.round(20 * s);
    // Virš automobilio (kad jo neuždengtų); per arti viršaus – po juo
    const vt = m.oy + (r.vbox[1] + dy) * m.k, vb = m.oy + (r.vbox[3] + dy) * m.k;
    let ix = px + pw / 2 - iw / 2, iy = vt - ih - th - 12 * s;
    if (iy < 4 * s) iy = vb + 12 * s;
    ix = Math.max(4 * s, Math.min(m.W - iw - 4 * s, ix));
    iy = Math.max(4 * s, Math.min(m.H - ih - th - 4 * s, iy));
    const color = r.sure ? '#ffd23f' : '#ffffff';
    g.save();
    g.globalAlpha = 1;
    g.strokeStyle = color;
    g.lineWidth = Math.max(1.5, 2 * s);
    g.strokeRect(px, py, pw, ph);
    g.beginPath();
    g.moveTo(px + pw / 2, iy > py ? py + ph : py);
    g.lineTo(ix + iw / 2, iy > py ? iy : iy + ih + th);
    g.stroke();
    g.fillStyle = '#000';
    g.fillRect(ix - 2 * s, iy - 2 * s, iw + 4 * s, ih + th + 4 * s);
    g.imageSmoothingQuality = 'high';
    g.drawImage(r.img, ix, iy, iw, ih);
    g.strokeRect(ix - 2 * s, iy - 2 * s, iw + 4 * s, ih + th + 4 * s);
    g.fillStyle = color;
    g.fillRect(ix, iy + ih, iw, th);
    g.fillStyle = '#111';
    g.font = `700 ${Math.round(14 * s)}px Inter, Segoe UI, sans-serif`;
    g.textAlign = 'center';
    g.fillText(r.sure ? r.text : `${r.text}?`, ix + iw / 2, iy + ih + th - 5 * s);
    g.restore();
  }
}
