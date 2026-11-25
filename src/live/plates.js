// Valstybinių numerių filtras tiesioginėje transliacijoje: transporto priemonių iškarpos iš pilnos raiškos kadro →
// vietinė AI paslauga (/plates, fast-alpr) → numerių balsavimas per kelis kadrus → priartintas numeris ant vaizdo
// ir sąrašas ataskaitai. Duomenys laikomi tik naršyklės atmintyje ir įrašo ataskaitoje (asmens duomenys – BDAR).

import { t, locale } from '../i18n.js';

export const PLATE_VEHICLES = ['car', 'truck', 'bus', 'motorcycle'];

/**
 * Automobilio požymis tekstu: atpažintas – reikšmė, neatpažintas – null.
 * @param {object} a – {value, lt?, p, small?}
 */
export const attrValue = (a) => (a?.value ? (locale().startsWith('lt') && a.lt ? a.lt : a.value) : null);

/** Trumpas aprašas ekrane: tik atpažinti požymiai („balta · Volkswagen Golf“). */
export function vehicleShort(v) {
  if (!v) return '';
  const mk = attrValue(v.make), md = attrValue(v.model);
  return [attrValue(v.color), mk ? `${mk}${md ? ` ${md}` : ''}` : attrValue(v.body)].filter(Boolean).join(' · ');
}

/** Ataskaitai: kiekvienas požymis arba „neatpažinta“ (su priežastimi), kad neklaidintų. */
export function vehicleRows(v) {
  const nr = (a) => (a?.small ? t('neatpažinta (per mažas vaizdas)') : t('neatpažinta'));
  const row = (label, a) => ({ label, value: attrValue(a), p: a?.value ? a.p : null, note: a?.value ? '' : nr(a) });
  return [
    row(t('Spalva'), v?.color),
    row(t('Kėbulas'), v?.body),
    row(t('Markė'), v?.make),
    row(t('Modelis'), v?.model),
    { label: t('Metai'), value: null, p: null, note: t('iš vaizdo nenustatoma') },
  ];
}
const MIN_SIDE = 40; // mažesnės (pilnos raiškos px) transporto priemonės – numeris neįskaitomas, nesiunčiama
const MAX_CROPS = 6; // vienoje užklausoje – didžiausios transporto priemonės
const PAD = 0.15; // iškarpa – rėmelis + 15 %
const INTERVAL = 900; // ms tarp užklausų
const INTERVAL_HOT = 450; // kai matomas numeris – dažniau (daugiau kadrų sujungimui)
const VEH_CROPS = 4; // automobilio iškarpos požymiams
const VEH_GAP = 2000; // ms tarp požymių užklausų
const MAX_READS = 40; // kiek paskutinių perskaitymų laikoma balsavimui
const MAX_SHOTS = 10; // kiek paskutinių numerio kadrų laikoma sujungimui
const FUSE_MIN = 3; // sujungiama, kai yra bent tiek kadrų
const FUSE_GAP = 1200; // ms tarp sujungimų
const FUSE_WEIGHT = 3; // sujungto vaizdo perskaitymas – patikimesnis už vieną kadrą
const SHOW_MS = 3500; // kiek laiko rodomas priartintas numeris po paskutinio perskaitymo
const TEXT_RE = /^[A-Z0-9]{4,10}$/;
const MIN_SCORE = 0.5;
const SURE = 0.85; // vienas perskaitymas su tokiu tikrumu – numeris laikomas patvirtintu

/**
 * Balsavimas pagal simbolio vietą (MVCP, Nascimento ir kt. 2025; taip pat ICPR 2026 žemos raiškos numerių
 * varžybų lyderių praktika): dažniausias ilgis, tada kiekvienoje vietoje – simbolis su didžiausia tikrumų suma.
 * @param {{chars:[string, number][], w:number}[]} readings
 * @returns {{text:string, share:number}} share – silpniausios vietos balsų dalis (0–1)
 */
export function voteChars(readings) {
  const byLen = new Map();
  for (const r of readings) if (r.chars.length) byLen.set(r.chars.length, (byLen.get(r.chars.length) || 0) + r.w * (r.chars.reduce((a, [, p]) => a + p, 0) / r.chars.length));
  if (!byLen.size) return { text: '', share: 0 };
  const L = [...byLen].sort((a, b) => b[1] - a[1])[0][0];
  const acc = Array.from({ length: L }, () => new Map());
  for (const r of readings) if (r.chars.length === L) r.chars.forEach(([c, p], i) => acc[i].set(c, (acc[i].get(c) || 0) + r.w * p));
  let text = '', share = 1;
  for (const m of acc) {
    const [c, v] = [...m].sort((a, b) => b[1] - a[1])[0];
    const tot = [...m.values()].reduce((a, b) => a + b, 0);
    text += c;
    share = Math.min(share, v / Math.max(1e-6, tot));
  }
  return { text, share };
}

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

/**
 * Automobilio nuotrauka ataskaitai: automobilis su aplinka (+35 %) iš pilnos raiškos kadro, numerio vieta pažymėta.
 * Imama didžiausia (arčiausiai matyta) – ryškiausia.
 */
function vehiclePhoto(native, vbox, pbox) {
  const [x1, y1, x2, y2] = vbox, pw = (x2 - x1) * 0.35, ph = (y2 - y1) * 0.35;
  const x = Math.max(0, x1 - pw), y = Math.max(0, y1 - ph);
  const w = Math.min(native.width, x2 + pw) - x, h = Math.min(native.height, y2 + ph) - y;
  const { c, k } = crop(native, x, y, w, h, 960);
  if (pbox) {
    const g = c.getContext('2d');
    g.strokeStyle = '#ffd23f';
    g.lineWidth = Math.max(2, c.width / 240);
    const m = g.lineWidth * 1.5;
    g.strokeRect((pbox[0] - x) * k - m, (pbox[1] - y) * k - m, (pbox[2] - pbox[0]) * k + 2 * m, (pbox[3] - pbox[1]) * k + 2 * m);
  }
  return c;
}

const blobOf = (c, q = 0.97) => new Promise((r) => c.toBlob(r, 'image/jpeg', q));
const pngOf = (c) => new Promise((r) => c.toBlob(r, 'image/png'));

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
    this.lastReq = -Infinity;
    this.seq = 0;
    this.error = '';
    this.fuseBusy = false;
    this.lastFuse = -Infinity;
    this.vehBusy = false;
    this.lastVeh = -Infinity;
  }

  due(now = performance.now()) {
    const hot = this.recs.some((r) => now - r.lastAt < 3000);
    return !this.busy && now - this.lastReq >= (hot ? INTERVAL_HOT : INTERVAL);
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
        const rec = this.add(best.text, best.score, box, p.d, native, at, best.chars);
        this.keepVehicle(rec, p, native);
      });
      this.error = '';
      this.fuse(ai);
      this.describe(ai);
      return true;
    } catch (e) {
      this.error = e.message;
      return false;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Kelių kadrų sujungimas: to paties numerio iškarpos iš skirtingų vaizdo kadrų sulygiuojamos ir suvidurkinamos
   * AI paslaugoje – mažiau triukšmo ir suspaudimo artefaktų, numeris įskaitomesnis (tik tikri pikseliai).
   */
  /** Automobilio iškarpos požymiams (spalva, markė…): laikomos kelios didžiausios. */
  keepVehicle(rec, p, native) {
    const side = Math.min(p.d.box[2] - p.d.box[0], p.d.box[3] - p.d.box[1]);
    if (!rec.photo || side > (rec.photoSide || 0) * 1.1) {
      rec.photo = vehiclePhoto(native, p.d.box, rec.box);
      rec.photoSide = side;
    }
    const v = (rec.vcrops ||= []);
    v.push({ c: p.c, side });
    v.sort((a, b) => b.side - a.side);
    v.length = Math.min(v.length, VEH_CROPS);
    rec.vside = v[0].side;
  }

  /**
   * Automobilio požymiai (AI paslauga /vehicle): užklausiama, kai automobilis pirmą kartą perskaitytas ir vėl,
   * kai jis matomas gerokai didesnis (arčiau) – tada atpažinimas patikimesnis.
   */
  async describe(ai) {
    const now = performance.now();
    if (this.vehBusy || now - this.lastVeh < VEH_GAP || !ai.vehicle) return;
    const rec = this.recs.find((r) => r.vcrops?.length && now - r.lastAt < 10000 && (!r.veh || r.vside >= (r.vehSide || 0) * 1.4));
    if (!rec) return;
    this.vehBusy = true;
    this.lastVeh = now;
    const side = rec.vside;
    try {
      rec.veh = await ai.vehicle(await Promise.all(rec.vcrops.map((x) => blobOf(x.c, 0.92))), { kind: rec.cls });
      rec.vehSide = side;
    } catch {
      /* papildoma informacija – nepavykus lieka be jos */
    } finally {
      this.vehBusy = false;
    }
  }

  async fuse(ai) {
    const now = performance.now();
    if (this.fuseBusy || now - this.lastFuse < FUSE_GAP || !ai.plateFuse) return;
    const rec = this.recs
      .filter((r) => r.shots?.length >= FUSE_MIN && r.shotSeq > (r.fusedSeq || 0) && now - r.lastAt < 10000)
      .sort((a, b) => b.shotSeq - (b.fusedSeq || 0) - (a.shotSeq - (a.fusedSeq || 0)))[0];
    if (!rec) return;
    this.fuseBusy = true;
    this.lastFuse = now;
    const seq = rec.shotSeq;
    try {
      const shots = rec.shots.slice();
      const res = await ai.plateFuse(await Promise.all(shots.map((x) => pngOf(x.c))), shots.map((x) => x.inner));
      if (res.image) {
        const bmp = await createImageBitmap(await (await fetch(`data:image/jpeg;base64,${res.image}`)).blob());
        const c = document.createElement('canvas');
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close?.();
        rec.fused = c;
      }
      rec.fusedN = res.frames || 0;
      rec.fusedText = TEXT_RE.test(res.text || '') && res.score >= MIN_SCORE ? res.text : '';
      rec.fusedChars = rec.fusedText ? res.chars || [...res.text].map((c) => [c, res.score]) : null;
      rec.fusedScore = res.score || 0;
      rec.fusedSeq = seq;
      this.tally(rec);
    } catch {
      /* sujungimas – papildomas; nepavykus lieka pavienių kadrų rezultatas */
    } finally {
      this.fuseBusy = false;
    }
  }

  /**
   * Rodomas tekstas – balsavimas pagal simbolių vietas per visus kadrus (sujungtas vaizdas – didesnis svoris).
   * Teisingas numeris gaunamas net tada, kai nė vienas kadras nebuvo perskaitytas be klaidų.
   */
  tally(rec) {
    const reads = [...(rec.readings || [])];
    if (rec.fusedChars) reads.push({ chars: rec.fusedChars, w: FUSE_WEIGHT });
    const { text, share } = voteChars(reads);
    rec.text = TEXT_RE.test(text) ? text : rec.text;
    rec.share = share;
    const same = (rec.readings || []).filter((r) => r.text === rec.text).length;
    // Patvirtintas: du perskaitymai sutampa, vienas labai tikras, sujungtas vaizdas tikras,
    // arba ≥3 perskaitymai ir kiekvienoje vietoje aiški dauguma
    rec.sure = same >= 2 || (rec.votes.get(rec.text) || 0) >= SURE || (rec.fusedText === rec.text && rec.fusedScore >= SURE) || ((rec.readings?.length || 0) >= 3 && share >= 0.6);
    return rec.text;
  }

  add(text, score, box, veh, native, at, chars = null) {
    const recent = (r, ms) => at - r.lastAt < ms;
    const rec =
      (veh.id && this.recs.find((r) => r.id === veh.id && recent(r, 30000))) ||
      this.recs.find((r) => r.votes.has(text)) ||
      this.recs.find((r) => recent(r, 60000) && near(r.text, text) <= 1) ||
      this.recs[this.recs.push({ key: ++this.seq, id: veh.id || null, votes: new Map(), text, score: 0, reads: 0, firstAt: at, lastAt: at }) - 1];
    rec.votes.set(text, (rec.votes.get(text) || 0) + score);
    (rec.readings ||= []).push({ text, chars: chars?.length ? chars : [...text].map((c) => [c, score]), w: 1 });
    if (rec.readings.length > MAX_READS) rec.readings.shift();
    rec.reads++;
    rec.lastAt = at;
    rec.box = box;
    rec.vbox = veh.box;
    if (veh.id) rec.id = veh.id;
    rec.cls = veh.class;
    // Numerio iškarpa (pilna raiška, su paraštėmis) – rodymui ir kelių kadrų sujungimui
    const [x1, y1, x2, y2] = box, bw = x2 - x1, bh = y2 - y1;
    const x = Math.max(0, x1 - bw * 0.2), y = Math.max(0, y1 - bh * 0.35);
    const w = Math.min(native.width - x, bw * 1.4), h = Math.min(native.height - y, bh * 1.7);
    const shot = crop(native, x, y, w, h, 640).c;
    (rec.shots ||= []).push({ c: shot, inner: [(x1 - x) / w, (y1 - y) / h, (x2 - x) / w, (y2 - y) / h] });
    if (rec.shots.length > MAX_SHOTS) rec.shots.shift();
    rec.shotSeq = (rec.shotSeq || 0) + 1;
    const prev = rec.text;
    const top = this.tally(rec);
    // Originalus kadras – geriausias rodomo varianto perskaitymas
    if (text === top && (prev !== top || score >= rec.score || !rec.img)) {
      rec.img = shot;
      rec.score = score;
    }
    return rec;
  }

  /** Šiuo metu rodomi (neseniai perskaityti) numeriai. */
  visible(now = performance.now()) {
    return this.recs.filter((r) => now - r.lastAt < SHOW_MS && (r.fused || r.img));
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
    const im = r.fused || r.img; // sujungtas iš kelių kadrų (ryškesnis), kol nėra – geriausias pavienis
    const ih = Math.max(70 * s, ph * 2 * 1.7), iw = (ih * im.width) / im.height;
    const th = Math.round(20 * s);
    const desc = vehicleShort(r.veh), dh = desc ? Math.round(16 * s) : 0; // automobilio požymiai po numeriu
    // Virš automobilio (kad jo neuždengtų); per arti viršaus – po juo
    const vt = m.oy + (r.vbox[1] + dy) * m.k, vb = m.oy + (r.vbox[3] + dy) * m.k;
    let ix = px + pw / 2 - iw / 2, iy = vt - ih - th - dh - 12 * s;
    if (iy < 4 * s) iy = vb + 12 * s;
    ix = Math.max(4 * s, Math.min(m.W - iw - 4 * s, ix));
    iy = Math.max(4 * s, Math.min(m.H - ih - th - dh - 4 * s, iy));
    const color = r.sure ? '#ffd23f' : '#ffffff';
    g.save();
    g.globalAlpha = 1;
    g.strokeStyle = color;
    g.lineWidth = Math.max(1.5, 2 * s);
    g.strokeRect(px, py, pw, ph);
    g.beginPath();
    g.moveTo(px + pw / 2, iy > py ? py + ph : py);
    g.lineTo(ix + iw / 2, iy > py ? iy : iy + ih + th + dh);
    g.stroke();
    g.fillStyle = '#000';
    g.fillRect(ix - 2 * s, iy - 2 * s, iw + 4 * s, ih + th + dh + 4 * s);
    g.imageSmoothingQuality = 'high';
    g.drawImage(im, ix, iy, iw, ih);
    g.strokeRect(ix - 2 * s, iy - 2 * s, iw + 4 * s, ih + th + dh + 4 * s);
    if (desc) {
      g.fillStyle = '#fff';
      g.font = `600 ${Math.round(11 * s)}px Inter, Segoe UI, sans-serif`;
      g.textAlign = 'center';
      g.fillText(desc, ix + iw / 2, iy + ih + th + dh - 4 * s, iw - 4 * s);
    }
    g.fillStyle = color;
    g.fillRect(ix, iy + ih, iw, th);
    g.fillStyle = '#111';
    g.font = `700 ${Math.round(14 * s)}px Inter, Segoe UI, sans-serif`;
    g.textAlign = 'center';
    g.fillText(r.sure ? r.text : `${r.text}?`, ix + iw / 2, iy + ih + th - 5 * s);
    if (r.fused && r.fusedN > 1) {
      // Kiek kadrų sujungta
      g.font = `600 ${Math.round(10 * s)}px Inter, Segoe UI, sans-serif`;
      g.textAlign = 'right';
      g.fillStyle = 'rgba(0,0,0,.55)';
      g.fillText(`×${r.fusedN}`, ix + iw - 4 * s, iy + ih + th - 6 * s);
    }
    g.restore();
  }
}
