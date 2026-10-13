// Matavimų tipai, skaičiavimai ir jų atvaizdavimas 3D vaizde
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {
  horiz, polylineLength, polygonAreaXZ, polygonArea3D, centroid, fitPlaneY, angleAt, triangulate,
  sampleGrid, surfaceAreaFromGrid, volumeFromGrid, sampleProfile,
} from './compute.js';

/** Įrankių aprašai. min/max – taškų skaičius; auto – baigti automatiškai pasiekus max. */
export const TOOLS = {
  distance: { label: 'Atstumas', short: 'Atstumas', key: 'D', icon: 'distance', color: '#ffd23f', min: 2, max: 2,
    hint: 'Spustelėkite du taškus ant modelio.', tip: 'Tiesus 3D atstumas tarp dviejų taškų, taip pat horizontalus atstumas ir aukščių skirtumas.' },
  polyline: { label: 'Laužtė', short: 'Laužtė', key: 'E', icon: 'polyline', color: '#ffb627', min: 2, max: Infinity,
    hint: 'Žymėkite taškus iš eilės. Baigti – Enter arba dvigubas spustelėjimas.', tip: 'Kelių atkarpų ilgis – keliams, tvoroms, kabeliams, perimetrams.' },
  height: { label: 'Aukščių skirtumas', short: 'Aukštis', key: 'H', icon: 'height', color: '#4fc3f7', min: 2, max: 2,
    hint: 'Spustelėkite apatinį ir viršutinį taškus.', tip: 'Vertikalus aukščių skirtumas, horizontalus atstumas ir nuolydis (% ir °).' },
  angle: { label: 'Kampas', short: 'Kampas', key: 'K', icon: 'angle', color: '#e57cff', min: 3, max: 3,
    hint: 'Spustelėkite tris taškus: pirmą, viršūnę ir trečią.', tip: 'Kampas tarp dviejų linijų, kurių viršūnė – antrasis taškas.' },
  point: { label: 'Taško koordinatės', short: 'Taškas', key: 'T', icon: 'point', color: '#ffffff', min: 1, max: 1,
    hint: 'Spustelėkite tašką ant modelio.', tip: 'Taško koordinatės X, Y, Z (originalioje modelio koordinačių sistemoje) ir aukštis.' },
  area: { label: 'Plotas', short: 'Plotas', key: 'A', icon: 'area', color: '#8dc63f', min: 3, max: Infinity, closed: true,
    hint: 'Apibrėžkite kontūrą. Baigti – spustelėkite pirmą tašką, Enter arba dvigubas spustelėjimas.', tip: 'Teritorijos plotas: horizontalus (kaip žemėlapyje) ir paviršiaus (pagal reljefą), perimetras.' },
  volume: { label: 'Tūris', short: 'Tūris', key: 'V', icon: 'volume', color: '#ff8a3d', min: 3, max: Infinity, closed: true,
    hint: 'Apibrėžkite kontūrą ant žemės aplink krūvą ar duobę. Baigti – pirmas taškas / Enter.', tip: 'Krūvos ar iškasos tūris: pylimas, iškasa ir grynasis tūris pagal pasirinktą pagrindą. Taip pat masė pagal tankį.' },
  profile: { label: 'Aukščio profilis', short: 'Profilis', key: 'R', icon: 'profile', color: '#3fe0d0', min: 2, max: Infinity,
    hint: 'Nubrėžkite liniją (2+ taškai). Baigti – Enter arba dvigubas spustelėjimas.', tip: 'Reljefo pjūvis palei liniją su aukščio grafiku apačioje.' },
  checkpoint: { label: 'Kontrolinis taškas', short: 'Kontrol.', key: 'C', icon: 'target', color: '#ff5fd2', min: 1, max: 1,
    hint: 'Spustelėkite ant žinomo taško (GCP, ženklo) modelyje ir įveskite jo LKS-94 koordinates.', tip: 'Tikslumo patikra: modelio ir geodeziškai išmatuoto taško skirtumai (ΔX, ΔY, ΔH). Iš kelių taškų galima pritaikyti pataisą.' },
  scale: { label: 'Mastelis', short: 'Mastelis', key: 'S', icon: 'scale', color: '#ff5d8f', min: 2, max: 2, special: true,
    hint: 'Pažymėkite du taškus, tarp kurių atstumas žinomas.', tip: 'Kalibruokite modelio mastelį pagal žinomą atstumą (pvz. matavimo liniuotė, GCP).' },
  level: { label: 'Išlyginti', short: 'Išlyginti', key: 'L', icon: 'level', color: '#c9f27b', min: 3, max: Infinity, special: true,
    hint: 'Pažymėkite 3 ar daugiau taškų ant žemės / grindų. Baigti – Enter.', tip: 'Pasukite modelį taip, kad pažymėta plokštuma taptų horizontali.' },
};

/**
 * Kontrolinio taško liekamoji paklaida rodomais vienetais (E, N, H ašimis).
 * known – originaliais modelio vienetais (be kalibravimo), kaip ir viewer.center.
 */
export function checkpointResidual(m, viewer, U) {
  const k = m.options.known;
  const meas = viewer.dispCoords(m.points[0], U);
  const known = new THREE.Vector3(U.lenRaw(k.x), U.lenRaw(k.y), U.lenRaw(k.z));
  return { dx: meas.x - known.x, dy: meas.y - known.y, dz: meas.z - known.z, meas, known };
}

export const BASE_MODES = {
  fit: 'Plokštuma per kontūrą',
  min: 'Žemiausias kontūro taškas',
  mean: 'Vidutinis kontūro aukštis',
  custom: 'Nurodytas aukštis',
};

let nextId = 1;

export class Measurement {
  constructor(type, points = [], name) {
    this.id = name === '' ? 0 : nextId++; // '' – laikinas (peržiūros) matavimas
    this.type = type;
    this.points = points.map((p) => p.clone());
    this.name = name || `${TOOLS[type].label} ${this.id}`;
    this.visible = true;
    this.data = null;
    this.status = 'ready';
    this.progress = 0;
    this.options = type === 'volume' ? { base: 'fit', baseY: null, density: null } : {};
  }
}

export function setNextId(n) {
  nextId = Math.max(nextId, n);
}

// ---------------------------------------------------------------------------
// Skaičiavimai (pasaulio vienetais)
// ---------------------------------------------------------------------------
/** Greiti (sinchroniniai) skaičiavimai – naudojami ir peržiūrai braižant. */
export function quickData(type, W) {
  switch (type) {
    case 'distance':
    case 'scale': {
      if (W.length < 2) return null;
      const [a, b] = W;
      const d = a.distanceTo(b), h = horiz(a, b), v = b.y - a.y;
      return { d, h, v, slope: h > 0 ? (v / h) * 100 : null };
    }
    case 'polyline': {
      if (W.length < 2) return null;
      const { length, horizontal } = polylineLength(W);
      return { length, horizontal, v: W[W.length - 1].y - W[0].y, segments: W.slice(1).map((p, i) => W[i].distanceTo(p)) };
    }
    case 'height': {
      if (W.length < 2) return null;
      const [a, b] = W;
      const v = b.y - a.y, h = horiz(a, b);
      return { v, h, d: a.distanceTo(b), slopePct: h > 0 ? (Math.abs(v) / h) * 100 : null, slopeDeg: Math.atan2(Math.abs(v), h) };
    }
    case 'angle': {
      if (W.length < 3) return null;
      const [a, b, c] = W;
      const ah = new THREE.Vector3(a.x, b.y, a.z), ch = new THREE.Vector3(c.x, b.y, c.z);
      return { angle: angleAt(a, b, c), angleH: angleAt(ah, b, ch) };
    }
    case 'point':
      return W.length ? {} : null;
    case 'area':
    case 'volume': {
      if (W.length < 3) return null;
      const { length } = polylineLength(W, true);
      return { area2d: polygonAreaXZ(W), area3d: polygonArea3D(W).area, perimeter: length };
    }
    case 'profile': {
      if (W.length < 2) return null;
      return { length: polylineLength(W).horizontal };
    }
    case 'level':
      return null;
  }
  return null;
}

export function baseFunction(W, mode, baseY) {
  switch (mode) {
    case 'min': {
      const y = Math.min(...W.map((p) => p.y));
      return { fn: () => y, desc: 'horizontali, žemiausiame taške' };
    }
    case 'mean': {
      const y = W.reduce((s, p) => s + p.y, 0) / W.length;
      return { fn: () => y, desc: 'horizontali, vidutiniame aukštyje' };
    }
    case 'custom': {
      const y = baseY ?? Math.min(...W.map((p) => p.y));
      return { fn: () => y, desc: 'horizontali, nurodytame aukštyje' };
    }
    default: {
      const pl = fitPlaneY(W);
      return { fn: pl.fn, desc: 'per kontūro taškus', rms: pl.rms, slopeDeg: pl.slopeDeg };
    }
  }
}

/**
 * Pilnas matavimo skaičiavimas (gali būti asinchroninis).
 * @param {import('./viewer.js').Viewer} viewer
 */
export async function computeMeasurement(m, viewer, settings, onProgress, signal) {
  const W = m.points.map((p) => viewer.localToWorld(p));
  const q = quickData(m.type, W) || {};
  switch (m.type) {
    case 'point': {
      return {};
    }
    case 'area': {
      const g = await sampleGrid(viewer, W, Math.min(settings.resolution, 400), onProgress, signal);
      const s = surfaceAreaFromGrid(g, W);
      return { ...q, surface: q.area2d * s.ratio, coverage: s.coverage };
    }
    case 'volume': {
      const g = await sampleGrid(viewer, W, settings.resolution, onProgress, signal);
      const baseY = m.options.base === 'custom' ? m.options.baseY : null;
      const base = baseFunction(W, m.options.base, baseY);
      const v = volumeFromGrid(g, W, base.fn);
      const s = surfaceAreaFromGrid(g, W);
      return { ...q, ...v, surface: q.area2d * s.ratio, baseDesc: base.desc, baseRms: base.rms, baseSlope: base.slopeDeg, baseFn: base.fn };
    }
    case 'profile': {
      const prof = sampleProfile(viewer, W, 500);
      const ys = prof.samples.map((s) => s.y).filter((y) => !isNaN(y));
      let gain = 0, loss = 0, maxSlope = 0;
      for (let i = 1; i < prof.samples.length; i++) {
        const a = prof.samples[i - 1], b = prof.samples[i];
        if (isNaN(a.y) || isNaN(b.y)) continue;
        const dy = b.y - a.y;
        if (dy > 0) gain += dy;
        else loss -= dy;
        const dd = b.d - a.d;
        if (dd > 0) maxSlope = Math.max(maxSlope, Math.abs(dy / dd));
      }
      return { ...q, samples: prof.samples, minY: Math.min(...ys), maxY: Math.max(...ys), gain, loss, maxSlope: maxSlope * 100 };
    }
    default:
      return q;
  }
}

// ---------------------------------------------------------------------------
// Aprašymas (tekstai) – priklauso nuo vienetų
// ---------------------------------------------------------------------------
/**
 * @returns {{value: string, details: [string,string][], labels: {pos: THREE.Vector3, text: string, sub?: boolean}[]}}
 */
export function describe(m, viewer, U, settings, live = false) {
  const L = m.points;
  const W = L.map((p) => viewer.localToWorld(p));
  const d = m.data || (live ? quickData(m.type, W) : null);
  const out = { value: '', details: [], labels: [] };
  if (!d && m.type !== 'level') return out;
  const toLocal = (w) => viewer.worldToLocal(w);
  const mid = (a, b) => a.clone().add(b).multiplyScalar(0.5);
  const elev = (w) => U.fmtDisp(viewer.dispElev(w.y, U));

  switch (m.type) {
    case 'distance':
    case 'scale': {
      out.value = U.fmtLen(d.d);
      out.details = [
        ['Horizontalus', U.fmtLen(d.h)],
        ['Aukščių skirtumas', U.fmtLen(d.v)],
        ['Nuolydis', d.slope != null ? U.fmtPercent(Math.abs(d.slope)) : '—'],
      ];
      out.labels.push({ pos: mid(L[0], L[1]), text: out.value });
      break;
    }
    case 'polyline': {
      out.value = U.fmtLen(d.length);
      out.details = [
        ['Horizontalus ilgis', U.fmtLen(d.horizontal)],
        ['Atkarpų', String(d.segments.length)],
        ['Aukščių skirtumas', U.fmtLen(d.v)],
      ];
      d.segments.forEach((s, i) => out.labels.push({ pos: mid(L[i], L[i + 1]), text: U.fmtLen(s), sub: true }));
      out.labels.push({ pos: L[L.length - 1].clone(), text: `Σ ${out.value}` });
      break;
    }
    case 'height': {
      out.value = `Δ ${U.fmtLen(d.v)}`;
      out.details = [
        ['Horizontalus atstumas', U.fmtLen(d.h)],
        ['Tiesus atstumas', U.fmtLen(d.d)],
        ['Nuolydis', d.slopePct != null ? `${U.fmtPercent(d.slopePct)} (${U.fmtAngle(d.slopeDeg)})` : '—'],
        ['Apatinio aukštis', elev(W[0].y <= W[1].y ? W[0] : W[1])],
        ['Viršutinio aukštis', elev(W[0].y <= W[1].y ? W[1] : W[0])],
      ];
      const c = new THREE.Vector3(W[1].x, W[0].y, W[1].z);
      out.labels.push({ pos: toLocal(mid(c, W[1])), text: `↕ ${U.fmtLen(Math.abs(d.v))}` });
      if (d.h > 0) out.labels.push({ pos: toLocal(mid(W[0], c)), text: `↔ ${U.fmtLen(d.h)}`, sub: true });
      break;
    }
    case 'angle': {
      out.value = U.fmtAngle(d.angle);
      out.details = [['Horizontalioje plokštumoje', U.fmtAngle(d.angleH)], ['Papildomas kampas', U.fmtAngle(Math.PI - d.angle)]];
      out.labels.push({ pos: L[1].clone(), text: out.value });
      break;
    }
    case 'point': {
      const rows = viewer.coordRows(L[0], U, settings.coordOrder);
      out.value = `${rows[2][0].split(' ')[0]} ${U.fmtDisp(viewer.dispElev(W[0].y, U))}`;
      out.details = rows.map(([k, v]) => [k, U.num(v, Math.max(U.precision, 3))]);
      out.labels.push({ pos: L[0].clone(), text: out.value });
      break;
    }
    case 'checkpoint': {
      const k = m.options.known;
      if (!k) break;
      const r = checkpointResidual(m, viewer, U);
      const p3 = Math.max(U.precision, 3);
      const sgn = (v) => (v > 0 ? '+' : '') + U.num(v, p3);
      out.value = `ΔH ${sgn(r.dz)} ${U.display}`;
      const geo = viewer.crs?.geodetic && settings.coordOrder === 'ne';
      out.details = [
        [geo ? 'ΔX (šiaurė)' : 'ΔX', `${sgn(geo ? r.dy : r.dx)} ${U.display}`],
        [geo ? 'ΔY (rytai)' : 'ΔY', `${sgn(geo ? r.dx : r.dy)} ${U.display}`],
        ['Δ plokštumoje', U.fmtDisp(Math.hypot(r.dx, r.dy), p3)],
        ['Δ 3D', U.fmtDisp(Math.hypot(r.dx, r.dy, r.dz), p3)],
        ['Žinomas taškas', (geo ? [r.known.y, r.known.x, r.known.z] : [r.known.x, r.known.y, r.known.z]).map((v) => U.num(v, p3)).join('; ')],
        ['Modelyje', (geo ? [r.meas.y, r.meas.x, r.meas.z] : [r.meas.x, r.meas.y, r.meas.z]).map((v) => U.num(v, p3)).join('; ')],
      ];
      out.labels.push({ pos: L[0].clone(), text: `${m.name}: ${out.value}` });
      break;
    }
    case 'area': {
      out.value = U.fmtArea(d.area2d);
      out.details = [
        ['Paviršiaus plotas (reljefas)', d.surface != null ? U.fmtArea(d.surface) : m.status === 'computing' ? 'skaičiuojama…' : '—'],
        ['Plokštumos plotas (3D)', U.fmtArea(d.area3d)],
        ['Perimetras', U.fmtLen(d.perimeter)],
      ];
      if (U.toSquareMeters(d.area2d) >= 1000) out.details.unshift(['Hektarais', U.fmtHectares(d.area2d)]);
      if (d.coverage != null && d.coverage < 0.97) out.details.push(['Paviršiaus padengimas', U.fmtPercent(d.coverage * 100)]);
      out.labels.push({ pos: centroidOnSurface(L), text: out.value });
      break;
    }
    case 'volume': {
      if (d.net == null) {
        out.value = live ? U.fmtArea(d.area2d) : 'Skaičiuojama…';
        out.labels.push({ pos: centroidOnSurface(L), text: live ? out.value : 'Skaičiuojama…' });
        break;
      }
      out.value = U.fmtVol(d.net);
      const density = m.options.density ?? settings.density;
      out.details = [
        ['Pylimas (virš pagrindo)', U.fmtVol(d.fill)],
        ['Iškasa (po pagrindu)', U.fmtVol(d.cut)],
        ['Pagrindo plotas', U.fmtArea(d.area2d)],
        ['Paviršiaus plotas', U.fmtArea(d.surface)],
        ['Didžiausias aukštis', U.fmtLen(d.maxUp)],
      ];
      if (density > 0) out.details.push([`Masė (${U.num(density, 2)} t/m³)`, `${U.num(U.toCubicMeters(d.fill) * density, 1)} t`]);
      if (d.coverage < 0.97) out.details.push(['Paviršiaus padengimas', U.fmtPercent(d.coverage * 100)]);
      if (d.baseRms != null) out.details.push(['Pagrindo nuokrypis (RMS)', U.fmtLen(d.baseRms)]);
      out.labels.push({ pos: centroidOnSurface(L), text: `${out.value}` });
      break;
    }
    case 'profile': {
      out.value = U.fmtLen(d.length);
      if (d.samples) {
        out.details = [
          ['Žemiausias taškas', U.fmtDisp(viewer.dispElev(d.minY, U))],
          ['Aukščiausias taškas', U.fmtDisp(viewer.dispElev(d.maxY, U))],
          ['Aukščių skirtumas', U.fmtLen(d.maxY - d.minY)],
          ['Kilimas / leidimasis', `${U.fmtLen(d.gain)} / ${U.fmtLen(d.loss)}`],
          ['Didžiausias nuolydis', U.fmtPercent(d.maxSlope)],
        ];
      }
      out.labels.push({ pos: L[L.length - 1].clone(), text: `⟂ ${out.value}` });
      break;
    }
  }
  return out;
}

function centroidOnSurface(L) {
  return centroid(L);
}

// ---------------------------------------------------------------------------
// Atvaizdavimas
// ---------------------------------------------------------------------------
let markerTexture = null;
function getMarkerTexture() {
  if (markerTexture) return markerTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.beginPath();
  g.arc(32, 32, 26, 0, Math.PI * 2);
  g.fillStyle = '#ffffff';
  g.fill();
  g.lineWidth = 9;
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.stroke();
  markerTexture = new THREE.CanvasTexture(c);
  markerTexture.colorSpace = THREE.SRGBColorSpace;
  return markerTexture;
}

export class MeasurementVisual {
  /**
   * @param {import('./viewer.js').Viewer} viewer
   */
  constructor(viewer, onLabelClick) {
    this.viewer = viewer;
    this.group = new THREE.Group();
    this.onLabelClick = onLabelClick;
    this.materials = [];
    viewer.overlay.add(this.group);
  }

  clear() {
    for (const m of this.materials) {
      if (m.isLineMaterial) this.viewer.unregisterLineMaterial(m);
      m.dispose();
    }
    this.materials = [];
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.isCSS2DObject) o.element.remove();
    });
    this.group.clear();
  }

  dispose() {
    this.clear();
    this.group.removeFromParent();
    this.viewer.requestRender();
  }

  _line(points, color, { width = 3, opacity = 1, closed = false } = {}) {
    if (points.length < 2) return;
    const pts = closed ? [...points, points[0]] : points;
    const geom = new LineGeometry();
    geom.setPositions(pts.flatMap((p) => [p.x, p.y, p.z]));
    const mat = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthTest: false, depthWrite: false });
    this.viewer.registerLineMaterial(mat);
    this.materials.push(mat);
    const line = new Line2(geom, mat);
    line.computeLineDistances();
    line.renderOrder = 1000;
    line.frustumCulled = false;
    this.group.add(line);
    // Tamsus kontūras po linija – geriau matosi ant šviesių tekstūrų
    const mat2 = new LineMaterial({ color: 0x000000, linewidth: width + 2.5, transparent: true, opacity: 0.45 * opacity, depthTest: false, depthWrite: false });
    this.viewer.registerLineMaterial(mat2);
    this.materials.push(mat2);
    const halo = new Line2(geom, mat2);
    halo.renderOrder = 999;
    halo.frustumCulled = false;
    this.group.add(halo);
  }

  _markers(points, color, size = 11) {
    if (!points.length) return;
    const g = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.PointsMaterial({ color, size, sizeAttenuation: false, map: getMarkerTexture(), transparent: true, depthTest: false, depthWrite: false, alphaTest: 0.1 });
    this.materials.push(mat);
    const pts = new THREE.Points(g, mat);
    pts.renderOrder = 1001;
    pts.frustumCulled = false;
    this.group.add(pts);
  }

  _fill(points, color, opacity = 0.22) {
    if (points.length < 3) return;
    const idx = triangulate(points);
    if (!idx.length) return;
    const g = new THREE.BufferGeometry().setFromPoints(points);
    g.setIndex(idx);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    this.materials.push(mat);
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 900;
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  _label(pos, text, color, { sub = false, preview = false, selected = false, name = null } = {}) {
    const el = document.createElement('div');
    el.className = `m-label${sub ? ' sub' : ''}${preview ? ' preview' : ''}${selected ? ' selected' : ''}`;
    el.style.setProperty('--c', color);
    if (name) {
      const n = document.createElement('span');
      n.className = 'lbl-name';
      n.textContent = name;
      el.append(n);
    }
    el.append(document.createTextNode(text));
    if (this.onLabelClick) el.addEventListener('pointerdown', (e) => { e.stopPropagation(); this.onLabelClick(); });
    const obj = new CSS2DObject(el);
    obj.position.copy(pos);
    obj.center.set(0.5, 1);
    this.group.add(obj);
  }

  /**
   * Perpiešia matavimą.
   * @param {Measurement} m
   * @param {{hover?: THREE.Vector3, preview?: boolean, selected?: boolean, desc: any}} o
   */
  update(m, { hover = null, preview = false, selected = false, desc, showName = false } = {}) {
    this.clear();
    this.group.visible = m.visible;
    const tool = TOOLS[m.type];
    const color = tool.color;
    const L = hover ? [...m.points, hover] : m.points;
    const width = selected ? 4.5 : 3;
    const v = this.viewer;
    const closed = tool.closed && L.length >= 3;

    switch (m.type) {
      case 'height': {
        if (L.length >= 2) {
          const W = L.map((p) => v.localToWorld(p));
          const c = v.worldToLocal(new THREE.Vector3(W[1].x, W[0].y, W[1].z));
          this._line([L[0], L[1]], color, { width: 1.5, opacity: 0.6 });
          this._line([L[0], c, L[1]], color, { width });
          this._markers([c], color, 7);
        }
        break;
      }
      case 'volume': {
        this._line(L, color, { width, closed });
        if (m.data?.baseFn && !preview) {
          const W = L.map((p) => v.localToWorld(p));
          const B = W.map((w) => v.worldToLocal(new THREE.Vector3(w.x, m.data.baseFn(w.x, w.z), w.z)));
          this._fill(B, color, 0.28);
          this._line(B, color, { width: 1.5, opacity: 0.7, closed: true });
        } else if (closed) this._fill(L, color, 0.15);
        break;
      }
      case 'area':
        this._line(L, color, { width, closed });
        if (closed) this._fill(L, color, 0.22);
        break;
      case 'level':
        this._line(L, color, { width: 2, closed });
        if (closed) this._fill(L, color, 0.2);
        break;
      default:
        this._line(L, color, { width });
    }
    this._markers(L, color, selected ? 13 : 11);

    if (desc) {
      desc.labels.forEach((l, i) =>
        this._label(l.pos, l.text, color, { sub: l.sub, preview, selected, name: showName && i === desc.labels.length - 1 ? m.name : null }),
      );
    }
    v.requestRender();
  }
}
