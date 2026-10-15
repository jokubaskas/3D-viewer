// PDF ataskaita: modelio informacija, vaizdai, matavimai, pokyčiai, kontroliniai taškai, AI objektai.
// jsPDF ir šriftas įkeliami tik kuriant ataskaitą (atskira programos dalis).
import * as THREE from 'three';
import { drawLogo } from '../logo.js';

const A4 = { w: 210, h: 297 };
const M = 14; // paraštės, mm
const GREEN = [0, 139, 1];
const INK = [31, 35, 38];
const MUTED = [110, 118, 122];
const LINE = [222, 227, 225];
const ZEBRA = [246, 248, 247];

// Simboliai, kurių šrifte nėra
const clean = (s) => String(s ?? '').replace(/⟂\s?/g, '').replace(/﻿/g, '');

// ---------------------------------------------------------------------------
// Vaizdų atvaizdavimas (be ekrano: atskiras kadras norimu dydžiu)
// ---------------------------------------------------------------------------

/**
 * Nupiešia sceną nurodyta kamera į drobę.
 * @param {import('../viewer.js').Viewer} viewer
 */
function renderCanvas(viewer, camera, W, H, { background = null, overlay = true } = {}) {
  const r = viewer.renderer;
  const rt = new THREE.WebGLRenderTarget(W, H, { samples: 4 });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const prevOverlay = viewer.overlay.visible;
  const prevHelpers = viewer.helpers.visible;
  viewer.overlay.visible = overlay;
  viewer.helpers.visible = false;
  const res = [...viewer.lineMaterials].map((m) => [m, m.resolution.clone()]);
  res.forEach(([m]) => m.resolution.set(W, H));
  const prevClear = r.getClearColor(new THREE.Color());
  const prevAlpha = r.getClearAlpha();
  r.setClearColor(0x000000, 0);
  try {
    viewer.headlight.position.copy(camera.position);
    r.setRenderTarget(rt);
    r.clear();
    r.render(viewer.scene, camera);
    const buf = new Uint8Array(W * H * 4);
    r.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const g = cv.getContext('2d');
    if (background) background(g, W, H);
    const tmp = document.createElement('canvas');
    tmp.width = W;
    tmp.height = H;
    const img = tmp.getContext('2d').createImageData(W, H);
    const row = W * 4;
    for (let y = 0; y < H; y++) img.data.set(buf.subarray((H - 1 - y) * row, (H - y) * row), y * row);
    tmp.getContext('2d').putImageData(img, 0, 0);
    g.drawImage(tmp, 0, 0);
    return cv;
  } finally {
    r.setRenderTarget(null);
    r.setClearColor(prevClear, prevAlpha);
    rt.dispose();
    res.forEach(([m, v]) => m.resolution.copy(v));
    viewer.overlay.visible = prevOverlay;
    viewer.helpers.visible = prevHelpers;
    viewer.requestRender();
  }
}

/** Matavimų etiketės ant vaizdo (kaip programoje). */
function drawLabels(g, camera, W, H, labels, scale) {
  g.textBaseline = 'middle';
  const placed = [];
  for (const l of labels) {
    const p = l.world.clone().project(camera);
    if (p.z < -1 || p.z > 1) continue;
    const x = ((p.x + 1) / 2) * W, y = ((1 - p.y) / 2) * H;
    if (x < 0 || y < 0 || x > W || y > H) continue;
    const fs = (l.sub ? 11 : 13) * scale;
    g.font = `${l.sub ? 500 : 600} ${fs}px Inter, "Segoe UI", Arial, sans-serif`;
    const text = clean(l.text);
    const tw = g.measureText(text).width;
    const bw = tw + 16 * scale, bh = fs + 10 * scale;
    let bx = x - bw / 2, by = y - bh / 2;
    // Nedidelis persidengimų vengimas
    for (let k = 0; k < 6 && placed.some((q) => bx < q[2] && bx + bw > q[0] && by < q[3] && by + bh > q[1]); k++) by -= bh + 2 * scale;
    placed.push([bx, by, bx + bw, by + bh]);
    g.fillStyle = 'rgba(24,27,30,0.86)';
    g.beginPath();
    g.roundRect(bx, by, bw, bh, 5 * scale);
    g.fill();
    g.fillStyle = l.color || '#00e5ff';
    g.fillRect(bx, by + 2 * scale, 3 * scale, bh - 4 * scale);
    g.fillStyle = '#fff';
    g.fillText(text, bx + 10 * scale, by + bh / 2 + 0.5 * scale);
  }
}

function darkBackground(g, W, H) {
  const grad = g.createRadialGradient(W * 0.3, H * 0.4, 0, W * 0.3, H * 0.4, Math.max(W, H) * 0.85);
  grad.addColorStop(0, '#1d4629');
  grad.addColorStop(0.6, '#102d21');
  grad.addColorStop(1, '#1f2326');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
}
const lightBackground = (g, W, H) => {
  g.fillStyle = '#f3f5f4';
  g.fillRect(0, 0, W, H);
};

/** Bendras vaizdas – dabartinis naudotojo kampas. */
function perspectiveImage(viewer, labels, W) {
  const H = Math.round((W * viewer.height) / viewer.width);
  const cam = viewer.camera.clone();
  if (cam.isPerspectiveCamera) cam.aspect = W / H;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  const cv = renderCanvas(viewer, cam, W, H, { background: darkBackground });
  drawLabels(cv.getContext('2d'), cam, W, H, labels, W / 1000);
  return cv;
}

/** Ortografinis vaizdas iš viršaus (šiaurė – viršuje) su mastelio juosta. */
function topImage(viewer, bounds, labels, maxPx, { overlay = true, metersPerUnit = 1 } = {}) {
  const box = viewer.worldBox;
  const pad = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * 0.04;
  const minX = bounds.minX - pad, maxX = bounds.maxX + pad, minZ = bounds.minZ - pad, maxZ = bounds.maxZ + pad;
  const sx = maxX - minX, sz = maxZ - minZ;
  const k = maxPx / Math.max(sx, sz);
  const W = Math.max(64, Math.round(sx * k)), H = Math.max(64, Math.round(sz * k));
  const cam = new THREE.OrthographicCamera(-sx / 2, sx / 2, sz / 2, -sz / 2, 0.01, box.max.y - box.min.y + 1e5);
  cam.up.set(0, 0, -1);
  cam.position.set((minX + maxX) / 2, box.max.y + 100, (minZ + maxZ) / 2);
  cam.lookAt((minX + maxX) / 2, box.min.y, (minZ + maxZ) / 2);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  const cv = renderCanvas(viewer, cam, W, H, { background: lightBackground, overlay });
  const g = cv.getContext('2d');
  const s = Math.max(W, H) / 1400;
  if (labels) drawLabels(g, cam, W, H, labels, s);
  drawScaleBar(g, W, H, sx / W, metersPerUnit, s);
  drawNorth(g, W, s);
  return cv;
}

function drawScaleBar(g, W, H, unitsPerPx, mpu, s) {
  const mPerPx = unitsPerPx * mpu;
  const target = (W * 0.22) * mPerPx;
  const p = 10 ** Math.floor(Math.log10(target));
  const n = target / p;
  const len = (n < 2 ? 1 : n < 5 ? 2 : 5) * p;
  const px = len / mPerPx;
  const x = 20 * s, y = H - 24 * s;
  g.fillStyle = 'rgba(255,255,255,0.88)';
  g.fillRect(x - 8 * s, y - 26 * s, px + 16 * s + 70 * s, 38 * s);
  g.fillStyle = '#1f2326';
  g.fillRect(x, y, px, 5 * s);
  g.fillStyle = '#fff';
  g.fillRect(x + px / 2, y + 1 * s, px / 2 - 1 * s, 3 * s);
  g.font = `600 ${13 * s}px Inter, Arial, sans-serif`;
  g.fillStyle = '#1f2326';
  g.textBaseline = 'alphabetic';
  g.fillText(len >= 1000 ? `${len / 1000} km` : `${len} m`, x, y - 8 * s);
}

function drawNorth(g, W, s) {
  const x = W - 34 * s, y = 34 * s;
  g.fillStyle = 'rgba(255,255,255,0.88)';
  g.beginPath();
  g.arc(x, y, 22 * s, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1f2326';
  g.beginPath();
  g.moveTo(x, y - 15 * s);
  g.lineTo(x + 8 * s, y + 9 * s);
  g.lineTo(x, y + 4 * s);
  g.lineTo(x - 8 * s, y + 9 * s);
  g.closePath();
  g.fill();
  g.font = `700 ${10 * s}px Inter, Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#008b01';
  g.fillText('N', x, y + 15 * s);
  g.textAlign = 'start';
}

function logoPng(color = '#1f2326') {
  const h = 80;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil((156 / 40) * h) + 8;
  cv.height = h + 8;
  drawLogo(cv.getContext('2d'), 4, 4, h, color);
  return { url: cv.toDataURL('image/png'), ratio: cv.width / cv.height };
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
class Doc {
  constructor(jsPDF, fonts, meta, t) {
    this.pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    const p = this.pdf;
    p.addFileToVFS('Inter-Regular.ttf', fonts.INTER_REGULAR);
    p.addFont('Inter-Regular.ttf', 'Inter', 'normal');
    p.addFileToVFS('Inter-Bold.ttf', fonts.INTER_BOLD);
    p.addFont('Inter-Bold.ttf', 'Inter', 'bold');
    p.setFont('Inter', 'normal');
    p.setProperties({ title: meta.title, subject: meta.object, author: meta.author || 'Atea 3D Matuoklis', creator: 'Atea 3D Matuoklis' });
    this.meta = meta;
    this.t = t;
    this.y = M;
    this.logo = logoPng();
  }

  get bottom() {
    return A4.h - M - 8;
  }

  ensure(h) {
    if (this.y + h > this.bottom) this.newPage();
  }

  newPage() {
    this.pdf.addPage();
    this.y = M;
    this.pageHeader();
  }

  pageHeader() {
    const p = this.pdf;
    p.addImage(this.logo.url, 'PNG', M, M - 1, 6 * this.logo.ratio, 6);
    p.setFont('Inter', 'normal').setFontSize(8).setTextColor(...MUTED);
    p.text(clean(`${this.meta.title} · ${this.meta.object}`), A4.w - M, M + 3.2, { align: 'right' });
    p.setDrawColor(...LINE).setLineWidth(0.3).line(M, M + 8, A4.w - M, M + 8);
    this.y = M + 14;
  }

  footers() {
    const p = this.pdf;
    const n = p.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      p.setPage(i);
      p.setFont('Inter', 'normal').setFontSize(7.5).setTextColor(...MUTED);
      p.setDrawColor(...LINE).setLineWidth(0.3).line(M, A4.h - M + 1, A4.w - M, A4.h - M + 1);
      p.text(clean(`${this.t('Sugeneruota')}: Atea 3D Matuoklis · ${this.meta.date}`), M, A4.h - M + 5);
      p.text(this.t('Puslapis {i} iš {n}', { i, n }), A4.w - M, A4.h - M + 5, { align: 'right' });
    }
  }

  h1(text) {
    this.ensure(14);
    const p = this.pdf;
    p.setFont('Inter', 'bold').setFontSize(13).setTextColor(...INK);
    p.text(clean(text), M, this.y + 5);
    p.setDrawColor(...GREEN).setLineWidth(0.8).line(M, this.y + 7.5, M + 14, this.y + 7.5);
    this.y += 12;
  }

  h2(text) {
    this.ensure(10);
    this.pdf.setFont('Inter', 'bold').setFontSize(10).setTextColor(...INK);
    this.pdf.text(clean(text), M, this.y + 4);
    this.y += 7;
  }

  para(text, { size = 9, color = MUTED } = {}) {
    const p = this.pdf;
    p.setFont('Inter', 'normal').setFontSize(size).setTextColor(...color);
    const lines = p.splitTextToSize(clean(text), A4.w - 2 * M);
    const lh = size * 0.45;
    for (const l of lines) {
      this.ensure(lh);
      p.text(l, M, this.y + lh * 0.8);
      this.y += lh;
    }
    this.y += 2;
  }

  /** Raktas–reikšmė lentelė dviem stulpeliais (ilgos reikšmės laužomos). */
  kv(rows, { cols = 2 } = {}) {
    const p = this.pdf;
    if (rows.length === 1) cols = 1;
    const colW = (A4.w - 2 * M - (cols - 1) * 6) / cols;
    const lh = 3.7;
    const per = Math.ceil(rows.length / cols);
    const cells = rows.map(([k, v]) => {
      p.setFont('Inter', 'normal').setFontSize(8.5);
      const kl = p.splitTextToSize(clean(k), colW * 0.44);
      p.setFont('Inter', 'bold');
      const vl = p.splitTextToSize(clean(v), colW * 0.54);
      return { kl, vl, h: Math.max(kl.length, vl.length) * lh + 2 };
    });
    // Stulpelių aukščiai
    const colH = [...Array(cols)].map((_, c) => cells.slice(c * per, (c + 1) * per).reduce((a, x) => a + x.h, 0));
    this.ensure(Math.min(Math.max(...colH), 60));
    const y0 = this.y;
    let maxY = y0;
    for (let c = 0; c < cols; c++) {
      let y = y0;
      const x = M + c * (colW + 6);
      for (const { kl, vl, h } of cells.slice(c * per, (c + 1) * per)) {
        p.setFont('Inter', 'normal').setFontSize(8.5).setTextColor(...MUTED);
        kl.forEach((l, i) => p.text(l, x, y + 4 + i * lh));
        p.setFont('Inter', 'bold').setTextColor(...INK);
        vl.forEach((l, i) => p.text(l, x + colW, y + 4 + i * lh, { align: 'right' }));
        y += h;
        p.setDrawColor(...LINE).setLineWidth(0.2).line(x, y, x + colW, y);
      }
      maxY = Math.max(maxY, y);
    }
    this.y = maxY + 4;
  }

  /**
   * Lentelė.
   * @param {{title:string, w:number, align?:'left'|'right'}[]} cols – w santykiniai pločiai
   */
  table(cols, rows) {
    const p = this.pdf;
    const total = cols.reduce((a, c) => a + c.w, 0);
    const width = A4.w - 2 * M;
    const ws = cols.map((c) => (c.w / total) * width);
    const pad = 1.6, fs = cols.length > 8 ? 7.2 : 8, lh = fs * 0.42;
    const head = () => {
      this.ensure(8);
      p.setFillColor(...INK).rect(M, this.y, width, 6.5, 'F');
      p.setFont('Inter', 'bold').setFontSize(cols.length > 8 ? 6.8 : 7.8).setTextColor(255, 255, 255);
      let x = M;
      cols.forEach((c, i) => {
        const tx = c.align === 'right' ? x + ws[i] - pad : x + pad;
        p.text(p.splitTextToSize(clean(c.title), ws[i] - 2 * pad + 1)[0], tx, this.y + 4.4, { align: c.align === 'right' ? 'right' : 'left' });
        x += ws[i];
      });
      this.y += 6.5;
    };
    head();
    rows.forEach((row, ri) => {
      p.setFont('Inter', 'normal').setFontSize(fs);
      const cells = row.map((v, i) => p.splitTextToSize(clean(v), ws[i] - 2 * pad));
      const h = Math.max(...cells.map((c) => c.length)) * lh + 2.6;
      if (this.y + h > this.bottom) {
        this.newPage();
        head();
      }
      if (ri % 2) p.setFillColor(...ZEBRA).rect(M, this.y, width, h, 'F');
      let x = M;
      cells.forEach((c, i) => {
        p.setFont('Inter', i === 0 || cols[i].bold ? 'bold' : 'normal').setTextColor(...INK);
        const right = cols[i].align === 'right';
        c.forEach((line, li) => p.text(line, right ? x + ws[i] - pad : x + pad, this.y + 1.3 + lh * (li + 0.8), { align: right ? 'right' : 'left' }));
        x += ws[i];
      });
      this.y += h;
    });
    p.setDrawColor(...LINE).setLineWidth(0.3).line(M, this.y, M + width, this.y);
    this.y += 5;
  }

  image(canvas, { maxH = 150, caption } = {}) {
    const width = A4.w - 2 * M;
    let w = width, h = (canvas.height / canvas.width) * w;
    if (h > maxH) {
      h = maxH;
      w = (canvas.width / canvas.height) * h;
    }
    this.ensure(h + (caption ? 7 : 3));
    const x = M + (width - w) / 2;
    this.pdf.addImage(canvas.toDataURL('image/jpeg', 0.88), 'JPEG', x, this.y, w, h);
    this.pdf.setDrawColor(...LINE).setLineWidth(0.3).rect(x, this.y, w, h);
    this.y += h + 2;
    if (caption) {
      this.pdf.setFont('Inter', 'normal').setFontSize(7.8).setTextColor(...MUTED);
      this.pdf.text(clean(caption), M + width / 2, this.y + 2.5, { align: 'center' });
      this.y += 5;
    }
    this.y += 2;
  }

  /** Spalvų legenda pokyčių žemėlapiui. */
  legend(range, fmt) {
    const p = this.pdf;
    this.ensure(10);
    const w = 90, x = M + (A4.w - 2 * M - w) / 2, y = this.y;
    const stops = [[26, 84, 219], [140, 199, 250], [235, 237, 236], [250, 191, 107], [214, 38, 31]];
    const n = 60;
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * (stops.length - 1), a = Math.floor(Math.min(t, stops.length - 2)), f = t - a;
      const c = stops[a].map((v, k) => Math.round(v + (stops[a + 1][k] - v) * f));
      p.setFillColor(...c).rect(x + (i * w) / n, y, w / n + 0.05, 3.2, 'F');
    }
    p.setFont('Inter', 'normal').setFontSize(7.5).setTextColor(...MUTED);
    p.text(`−${fmt(range)}`, x - 2, y + 2.6, { align: 'right' });
    p.text(`+${fmt(range)}`, x + w + 2, y + 2.6);
    p.text(clean(this.t('pašalinta')), x, y + 7);
    p.text(clean(this.t('pridėta')), x + w, y + 7, { align: 'right' });
    this.y += 11;
  }
}

/**
 * Sukuria PDF ataskaitą.
 * @param {object} ctx – duomenys iš programos (žr. main.js buildReport)
 * @returns {Promise<Blob>}
 */
export async function createReport(ctx, onStatus) {
  const { viewer, units, t, meta, sections } = ctx;
  onStatus?.(t('Ruošiami vaizdai…'));
  await new Promise((r) => setTimeout(r, 20));
  const [{ jsPDF }, fonts] = await Promise.all([import('jspdf'), import('./fonts.js')]);
  const doc = new Doc(jsPDF, fonts, meta, t);
  const p = doc.pdf;
  const mpu = units.metersPerUnit;
  const wb = viewer.worldBox;
  const fullBounds = { minX: wb.min.x, maxX: wb.max.x, minZ: wb.min.z, maxZ: wb.max.z };

  // --- Titulinė dalis ---
  p.addImage(doc.logo.url, 'PNG', M, M, 11 * doc.logo.ratio, 11);
  p.setFont('Inter', 'normal').setFontSize(8.5).setTextColor(...MUTED);
  p.text(meta.date, A4.w - M, M + 4, { align: 'right' });
  if (meta.author) p.text(clean(`${t('Parengė')}: ${meta.author}`), A4.w - M, M + 9, { align: 'right' });
  doc.y = M + 22;
  p.setFont('Inter', 'bold').setFontSize(20).setTextColor(...INK);
  p.text(p.splitTextToSize(clean(meta.title), A4.w - 2 * M), M, doc.y + 6);
  doc.y += 12;
  p.setFont('Inter', 'normal').setFontSize(11).setTextColor(...MUTED);
  p.text(p.splitTextToSize(clean(meta.object), A4.w - 2 * M)[0], M, doc.y + 4);
  doc.y += 8;
  p.setFillColor(...GREEN).rect(M, doc.y, 24, 1.2, 'F');
  doc.y += 6;
  if (meta.notes) doc.para(meta.notes, { size: 9.5, color: INK });

  doc.kv(ctx.modelRows);

  if (sections.view) {
    onStatus?.(t('Ruošiamas bendras vaizdas…'));
    await new Promise((r) => setTimeout(r, 0));
    doc.image(perspectiveImage(viewer, ctx.labels, 2000), { maxH: 120, caption: t('Bendras vaizdas') });
  }

  // --- Vaizdas iš viršaus ---
  if (sections.top) {
    onStatus?.(t('Ruošiamas vaizdas iš viršaus…'));
    await new Promise((r) => setTimeout(r, 0));
    const chVis = ctx.changeLayer.visible;
    ctx.changeLayer.visible = false; // pokyčiai – atskirame skyriuje
    const cv = topImage(viewer, fullBounds, ctx.labels, 2400, { metersPerUnit: mpu });
    ctx.changeLayer.visible = chVis;
    doc.newPage();
    doc.h1(t('Vaizdas iš viršaus'));
    doc.image(cv, { maxH: 225, caption: t('Ortografinė projekcija, šiaurė – viršuje') });
  }

  // --- Matavimai ---
  if (sections.measurements && ctx.measurements.length) {
    doc.newPage();
    doc.h1(t('Matavimai'));
    doc.table(
      [{ title: t('Nr.'), w: 7 }, { title: t('Pavadinimas'), w: 30 }, { title: t('Tipas'), w: 20 }, { title: t('Rezultatas'), w: 26, align: 'right' }],
      ctx.measurements.map((m, i) => [String(i + 1), m.name, m.type, m.value]),
    );
    for (const [i, m] of ctx.measurements.entries()) {
      if (!m.details.length && !m.points.length) continue;
      doc.ensure(22);
      doc.h2(`${i + 1}. ${m.name} — ${m.value}`);
      if (m.details.length) doc.kv(m.details);
      if (m.points.length && m.points.length <= 40) {
        doc.table(
          [{ title: t('Taškas'), w: 8 }, ...m.coordNames.map((n) => ({ title: `${n} (${units.display})`, w: 20, align: 'right' }))],
          m.points.map((pt, k) => [String(k + 1), ...pt]),
        );
      }
    }
  }

  // --- Pokyčiai ---
  if (sections.change && ctx.change) {
    onStatus?.(t('Ruošiamas pokyčių žemėlapis…'));
    await new Promise((r) => setTimeout(r, 0));
    const c = ctx.change;
    doc.newPage();
    doc.h1(t('Pokyčiai tarp datų'));
    doc.para(t('Lyginama: {a} (ankstesnis) ir {b} (vėlesnis).', { a: c.oldName, b: c.newName }), { size: 9, color: INK });
    const prevVis = ctx.changeLayer.visible;
    ctx.changeLayer.visible = true;
    const cv = topImage(viewer, c.bounds, null, 2400, { overlay: false, metersPerUnit: mpu });
    ctx.changeLayer.visible = prevVis;
    doc.image(cv, { maxH: 150, caption: t('Aukščių pokytis: raudona – pridėta, mėlyna – pašalinta') });
    doc.legend(c.range, c.fmtLen);
    doc.kv(c.rows);
    doc.para(t('Tūriai skaičiuojami tinkleliu tarp dviejų paviršių; pokyčiai, mažesni už nejautrumo ribą, laikomi matavimo triukšmu ir neskaičiuojami.'));
  }

  // --- Kontroliniai taškai ---
  if (sections.checkpoints && ctx.checkpoints) {
    const cp = ctx.checkpoints;
    doc.ensure(40);
    doc.h1(t('Kontroliniai taškai'));
    doc.kv(cp.summary);
    doc.table(cp.cols.map((title, i) => ({ title, w: i === 0 ? 22 : 14, align: i === 0 ? 'left' : 'right' })), cp.rows);
  }

  // --- AI objektai ---
  if (sections.ai && ctx.detections.length) {
    for (const d of ctx.detections) {
      doc.ensure(40);
      doc.h1(`${t('AI aptikti objektai')}: ${d.name}`);
      doc.kv(d.summary);
      const wts = [5, 12, 12, 17, 17, 11, 9, 10, 10, 10];
      doc.table(d.cols.map((title, i) => ({ title, w: wts[i] ?? 10, align: i < 2 ? 'left' : 'right' })), d.rows);
    }
  }

  doc.footers();
  onStatus?.(t('Kuriamas PDF…'));
  return p.output('blob');
}
