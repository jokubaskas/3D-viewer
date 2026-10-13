import './style.css';
import * as THREE from 'three';
import { Viewer } from './viewer.js';
import { loadModelFiles } from './loaders.js';
import { createDemoModel } from './demo.js';
import { units } from './units.js';
import { hydrateIcons, icon } from './icons.js';
import { TOOLS, BASE_MODES, Measurement, MeasurementVisual, computeMeasurement, describe, quickData, setNextId } from './measurements.js';
import { fitPlaneNormal } from './compute.js';
import { ProfileChart } from './profile.js';
import { Gizmo } from './gizmo.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------------------------------------------------------------------------
// Nustatymai
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'atea3d.settings.v1';
const settings = {
  unit: 'm', precision: 2, snap: false, resolution: 250, density: 1.6, labelSize: 'md', labels: true,
  background: 'dark', pointSize: 2.5, viewMode: 'texture', grid: false,
};
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
} catch { /* privatus režimas */ }
const saveSettings = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* ignoruojame */ }
};
units.display = settings.unit;
units.precision = settings.precision;

// ---------------------------------------------------------------------------
// Pagrindiniai objektai
// ---------------------------------------------------------------------------
hydrateIcons();
const viewport = $('#viewport');
const viewer = new Viewer(viewport);
const gizmo = new Gizmo($('#gizmo'), viewer);
const profile = new ProfileChart($('#profile-chart'), viewer, units);

/** @type {{m: Measurement, visual: MeasurementVisual}[]} */
const items = [];
let selectedId = null;
let modelInfo = null;

// ---------------------------------------------------------------------------
// Pranešimai
// ---------------------------------------------------------------------------
function toast(msg, type = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ---------------------------------------------------------------------------
// Įrankių juosta
// ---------------------------------------------------------------------------
const TOOL_ORDER = [['navigate'], ['distance', 'polyline', 'height', 'angle', 'point'], ['area', 'volume', 'profile'], ['scale', 'level']];
const toolbar = $('#toolbar');
const tipEl = document.createElement('div');
tipEl.className = 'tool-tip';
tipEl.hidden = true;
document.body.append(tipEl);

TOOL_ORDER.forEach((group, gi) => {
  if (gi) toolbar.insertAdjacentHTML('beforeend', '<div class="tool-sep"></div>');
  for (const id of group) {
    const t = id === 'navigate' ? { short: 'Naršyti', label: 'Naršymas', key: 'Esc', icon: 'navigate', tip: 'Modelio apžiūra: sukimas, stūmimas, priartinimas.' } : TOOLS[id];
    const b = document.createElement('button');
    b.className = 'tool-btn';
    b.dataset.tool = id;
    b.innerHTML = `<span data-icon="${t.icon}">${icon(t.icon)}</span><span class="tool-label">${t.short}</span>${t.key && t.key !== 'Esc' ? `<span class="tool-key">${t.key}</span>` : ''}`;
    b.addEventListener('click', () => (id === 'navigate' ? tools.deactivate() : tools.activate(id)));
    b.addEventListener('mouseenter', () => {
      tipEl.innerHTML = `<b>${t.label}</b> <span style="opacity:.7">(${t.key})</span><br>${t.tip}`;
      const r = b.getBoundingClientRect();
      tipEl.style.left = `${r.right + 10}px`;
      tipEl.style.top = `${r.top + 4}px`;
      tipEl.hidden = false;
    });
    b.addEventListener('mouseleave', () => (tipEl.hidden = true));
    toolbar.append(b);
  }
});
$('#help-tools').innerHTML = Object.values(TOOLS).map((t) => `<li><span>${t.label}</span><kbd>${t.key}</kbd></li>`).join('');

// ---------------------------------------------------------------------------
// Įrankių valdymas (taškų žymėjimas)
// ---------------------------------------------------------------------------
const tools = {
  active: null,
  points: [],
  hover: null,
  preview: null,
  _down: null,
  _lastClick: { t: 0, x: 0, y: 0 },

  activate(id) {
    if (!viewer.hasModel) return toast('Pirmiausia atidarykite modelį', 'error');
    if (this.active === id) return this.deactivate();
    this.cancel();
    this.active = id;
    viewport.classList.add('picking');
    this.preview = this.preview || new MeasurementVisual(viewer);
    this._updateUI();
  },
  deactivate() {
    this.cancel();
    this.active = null;
    viewport.classList.remove('picking');
    this._updateUI();
  },
  cancel() {
    this.points = [];
    this.hover = null;
    this.preview?.clear();
    viewer.requestRender();
    this._updateUI();
  },
  undo() {
    if (!this.points.length) return;
    this.points.pop();
    this._redraw();
  },

  _updateUI() {
    $$('.tool-btn').forEach((b) => b.classList.toggle('active', (this.active || 'navigate') === b.dataset.tool));
    const hint = $('#tool-hint');
    if (!this.active) return (hint.hidden = true);
    const t = TOOLS[this.active];
    hint.hidden = false;
    hint.style.borderLeftColor = t.color;
    $('#tool-hint-title').textContent = t.label;
    const n = this.points.length;
    $('#tool-hint-body').textContent = n ? `${t.hint} Pažymėta taškų: ${n}.` : t.hint;
    $('#hint-undo').disabled = !n;
    $('#hint-finish').hidden = t.max === n || t.max <= 2 || t.max === 3;
    $('#hint-finish').disabled = n < t.min;
  },

  _redraw() {
    if (!this.active) return;
    const m = new Measurement(this.active, this.points, '');
    const hoverLocal = this.hover?.local || null;
    const all = hoverLocal ? [...this.points, hoverLocal] : this.points;
    const temp = new Measurement(this.active, all, '');
    const desc = TOOLS[this.active].special && this.active === 'level' ? { labels: [] } : describe(temp, viewer, units, settings, true);
    if (this.active === 'scale') desc.labels.forEach((l) => (l.text = `${l.text} (modelyje)`));
    this.preview.update(m, { hover: hoverLocal, preview: true, desc });
    $('#tool-hint-live').textContent = all.length >= TOOLS[this.active].min || (this.active === 'point' && all.length) ? desc.value || '' : '';
    this._updateUI();
  },

  _isNearFirst(clientX, clientY) {
    const t = TOOLS[this.active];
    if (!t.closed || this.points.length < 3) return false;
    const s = viewer.toScreen(viewer.localToWorld(this.points[0]));
    const r = viewer.renderer.domElement.getBoundingClientRect();
    return Math.hypot(s.x + r.left - clientX, s.y + r.top - clientY) < 14;
  },

  click(e) {
    if (!this.active) return;
    const now = performance.now();
    const lc = this._lastClick;
    const dbl = now - lc.t < 350 && Math.hypot(e.clientX - lc.x, e.clientY - lc.y) < 6;
    this._lastClick = { t: now, x: e.clientX, y: e.clientY };
    if (dbl) return; // antras dvigubo spustelėjimo paspaudimas – tvarko dblclick
    if (this._isNearFirst(e.clientX, e.clientY)) return this.finish();
    const hit = viewer.pick(e.clientX, e.clientY, { snap: settings.snap || e.altKey });
    if (!hit) return toast('Spustelėkite ant modelio paviršiaus', 'info', 1500);
    this.points.push(hit.local);
    const t = TOOLS[this.active];
    if (this.points.length >= t.max) return this.finish();
    this._redraw();
  },

  hoverAt(e) {
    const hit = viewer.pick(e.clientX, e.clientY, { snap: settings.snap || e.altKey });
    updateStatusCoords(hit);
    if (!this.active) return;
    this.hover = hit;
    if (hit && this._isNearFirst(e.clientX, e.clientY)) this.hover = { local: this.points[0].clone() };
    this._redraw();
  },

  async finish() {
    if (!this.active) return;
    const t = TOOLS[this.active];
    if (this.points.length < t.min) {
      if (this.points.length) toast(`Reikia bent ${t.min} taškų`, 'info', 1800);
      return;
    }
    const type = this.active;
    const pts = this.points.slice();
    this.points = [];
    this.hover = null;
    this.preview.clear();
    this._updateUI();
    $('#tool-hint-live').textContent = '';
    if (type === 'scale') return calibrate(pts);
    if (type === 'level') return level(pts);
    const m = new Measurement(type, pts);
    addMeasurement(m, true);
  },
};

// Pelės įvykiai drobėje
const canvas = viewer.renderer.domElement;
canvas.addEventListener('pointerdown', (e) => {
  tools._down = { x: e.clientX, y: e.clientY, b: e.button, t: performance.now() };
});
canvas.addEventListener('pointerup', (e) => {
  const d = tools._down;
  tools._down = null;
  if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
  if (d.b === 0) tools.click(e);
  else if (d.b === 2 && tools.active) tools.finish();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('dblclick', (e) => {
  if (tools.active) {
    const t = TOOLS[tools.active];
    if (t.max > 3) tools.finish();
    return;
  }
  const hit = viewer.pick(e.clientX, e.clientY);
  if (hit) viewer.orbitAround(hit.world);
});
let hoverPending = null, hoverBusy = false;
canvas.addEventListener('pointermove', (e) => {
  if (tools._down && tools._down.b !== undefined && e.buttons) return; // sukimas
  hoverPending = e;
  if (!hoverBusy) {
    hoverBusy = true;
    requestAnimationFrame(() => {
      const ev = hoverPending;
      hoverPending = null;
      const t0 = performance.now();
      if (ev) tools.hoverAt(ev);
      // Labai dideliems taškų debesims – retesnis atnaujinimas
      const dt = performance.now() - t0;
      setTimeout(() => (hoverBusy = false), dt > 40 ? dt : 0);
    });
  }
});
canvas.addEventListener('pointerleave', () => {
  if (tools.active && tools.hover) {
    tools.hover = null;
    tools._redraw();
  }
});

$('#hint-undo').addEventListener('click', () => tools.undo());
$('#hint-finish').addEventListener('click', () => tools.finish());
$('#hint-cancel').addEventListener('click', () => tools.deactivate());

function updateStatusCoords(hit) {
  const el = $('#status-coords');
  if (!hit) {
    el.textContent = 'X — Y — Z —';
    return;
  }
  const o = viewer.dispCoords(hit.local, units);
  const p = Math.max(units.precision, 2);
  el.textContent = `X ${units.num(o.x, p)}   Y ${units.num(o.y, p)}   Z ${units.num(o.z, p)} ${units.display}${hit.snapped ? '   ◆ viršūnė' : ''}`;
}

// ---------------------------------------------------------------------------
// Matavimai
// ---------------------------------------------------------------------------
function addMeasurement(m, select = false) {
  const visual = new MeasurementVisual(viewer, () => selectMeasurement(m.id));
  const it = { m, visual };
  items.push(it);
  if (select) selectedId = m.id;
  recompute(it);
  renderList();
  return it;
}

async function recompute(it) {
  const { m } = it;
  it.abort?.abort();
  const ctrl = new AbortController();
  it.abort = ctrl;
  const slow = ['area', 'volume'].includes(m.type);
  if (slow) {
    m.status = 'computing';
    m.progress = 0;
    m.data = quickData(m.type, m.points.map((p) => viewer.localToWorld(p)));
    redrawItem(it);
    renderList();
  }
  try {
    m.data = await computeMeasurement(m, viewer, settings, (p) => {
      m.progress = p;
      const bar = document.querySelector(`.m-item[data-id="${m.id}"] .m-bar div`);
      if (bar) bar.style.width = `${Math.round(p * 100)}%`;
    }, ctrl.signal);
    m.status = 'ready';
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    m.status = 'error';
    toast(`Nepavyko apskaičiuoti: ${err.message}`, 'error');
  }
  redrawItem(it);
  renderList();
  if (m.type === 'profile' && (selectedId === m.id || !profile.current)) profile.show(m);
}

function redrawItem(it) {
  const desc = describe(it.m, viewer, units, settings);
  it.visual.update(it.m, { selected: it.m.id === selectedId, desc, showName: false });
}

function redrawAll() {
  items.forEach(redrawItem);
  renderList();
  if (profile.current) profile.render();
  viewer.requestRender();
}

function selectMeasurement(id, focus = false) {
  selectedId = id;
  items.forEach(redrawItem);
  renderList();
  const it = items.find((i) => i.m.id === id);
  if (it && it.m.type === 'profile' && it.m.data?.samples) profile.show(it.m);
  if (it && focus) viewer.focusPoints(it.m.points.map((p) => viewer.localToWorld(p)));
  const el = document.querySelector(`.m-item[data-id="${id}"]`);
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  showTab('measurements');
}

function removeMeasurement(id) {
  const i = items.findIndex((x) => x.m.id === id);
  if (i < 0) return;
  items[i].abort?.abort();
  items[i].visual.dispose();
  if (profile.current?.id === id) profile.hide();
  items.splice(i, 1);
  if (selectedId === id) selectedId = null;
  renderList();
}

function renderList() {
  const list = $('#m-list');
  $('#m-count').textContent = items.length;
  $('#m-empty').hidden = items.length > 0;
  list.innerHTML = '';
  for (const it of items) {
    const { m } = it;
    const t = TOOLS[m.type];
    const desc = describe(m, viewer, units, settings);
    const el = document.createElement('div');
    el.className = `m-item${m.id === selectedId ? ' selected' : ''}${m.visible ? '' : ' hidden-m'}`;
    el.dataset.id = m.id;
    el.style.setProperty('--c', t.color);
    const pending = m.status === 'computing' && (m.type === 'volume' || !desc.value);
    el.innerHTML = `
      <div class="m-head">
        <span class="m-icon">${icon(t.icon)}</span>
        <input class="m-name" value="${escapeHtml(m.name)}" title="Pervadinti" />
        <div class="m-actions">
          <button data-act="focus" title="Rodyti">${icon('target')}</button>
          <button data-act="copy" title="Kopijuoti reikšmę">${icon('copy')}</button>
          <button data-act="vis" title="${m.visible ? 'Slėpti' : 'Rodyti'}">${icon(m.visible ? 'eye' : 'eyeOff')}</button>
          <button data-act="del" class="del" title="Ištrinti">${icon('trash')}</button>
        </div>
      </div>
      <div class="m-value${pending ? ' pending' : ''}">${pending ? 'Skaičiuojama…' : m.status === 'error' ? 'Klaida' : escapeHtml(desc.value)}</div>
      ${m.status === 'computing' ? `<div class="m-bar"><div style="width:${Math.round(m.progress * 100)}%"></div></div>` : ''}
      ${desc.details.length ? `<dl class="m-details">${desc.details.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>` : ''}
    `;
    if (m.type === 'volume') el.append(volumeOptions(it));
    if (m.type === 'profile' && m.data?.samples) {
      const b = document.createElement('div');
      b.className = 'm-options';
      b.innerHTML = `<button class="btn btn-sm btn-outline"><span data-icon="chart">${icon('chart')}</span>Rodyti profilį</button>`;
      b.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        selectMeasurement(m.id);
        profile.show(m);
      });
      el.append(b);
    }
    el.querySelector('.m-head').addEventListener('click', (e) => {
      if (e.target.closest('button,input')) return;
      selectMeasurement(m.id);
    });
    el.querySelector('.m-value').addEventListener('click', () => selectMeasurement(m.id, true));
    const name = el.querySelector('.m-name');
    name.addEventListener('change', () => {
      m.name = name.value.trim() || m.name;
      redrawItem(it);
    });
    name.addEventListener('keydown', (e) => e.key === 'Enter' && name.blur());
    el.querySelectorAll('[data-act]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'del') removeMeasurement(m.id);
        else if (act === 'vis') {
          m.visible = !m.visible;
          redrawItem(it);
          renderList();
        } else if (act === 'focus') selectMeasurement(m.id, true);
        else if (act === 'copy') {
          const text = `${m.name}: ${desc.value}${desc.details.length ? '\n' + desc.details.map(([k, v]) => `${k}: ${v}`).join('\n') : ''}`;
          navigator.clipboard?.writeText(text).then(() => toast('Nukopijuota į iškarpinę', 'info', 1500));
        }
      }),
    );
    list.append(el);
  }
}

function volumeOptions(it) {
  const { m } = it;
  const wrap = document.createElement('div');
  wrap.className = 'm-options';
  const baseElevDisplay = m.options.baseY != null ? viewer.dispElev(m.options.baseY, units).toFixed(3) : '';
  wrap.innerHTML = `
    <label class="row">Pagrindas
      <select data-o="base">${Object.entries(BASE_MODES).map(([k, v]) => `<option value="${k}" ${k === m.options.base ? 'selected' : ''}>${v}</option>`).join('')}</select>
    </label>
    <label class="row" ${m.options.base === 'custom' ? '' : 'hidden'}>Pagrindo aukštis (${units.display})
      <input type="number" class="num wide" step="0.01" data-o="elev" value="${baseElevDisplay}" />
    </label>
    <label class="row">Tankis (t/m³)
      <input type="number" class="num" step="0.05" min="0" data-o="density" value="${m.options.density ?? settings.density}" />
    </label>`;
  wrap.addEventListener('click', (e) => e.stopPropagation());
  wrap.querySelector('[data-o=base]').addEventListener('change', (e) => {
    m.options.base = e.target.value;
    if (m.options.base === 'custom' && m.options.baseY == null) {
      const W = m.points.map((p) => viewer.localToWorld(p));
      m.options.baseY = Math.min(...W.map((w) => w.y));
    }
    recompute(it);
  });
  wrap.querySelector('[data-o=elev]').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (isFinite(v)) {
      m.options.baseY = viewer.worldYFromDispElev(v, units);
      recompute(it);
    }
  });
  wrap.querySelector('[data-o=density]').addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    m.options.density = isFinite(v) ? v : null;
    renderList();
  });
  return wrap;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function clearMeasurements() {
  [...items].forEach((it) => removeMeasurement(it.m.id));
  profile.hide();
}

// ---------------------------------------------------------------------------
// Mastelio kalibravimas ir išlyginimas
// ---------------------------------------------------------------------------
function calibrate(pts) {
  const W = pts.map((p) => viewer.localToWorld(p));
  const dModel = W[0].distanceTo(W[1]);
  if (dModel <= 0) return toast('Taškai sutampa', 'error');
  const dlg = $('#dlg-calibrate');
  $('#cal-model-dist').textContent = units.fmtLen(dModel, 4);
  $('#cal-unit').value = ['m', 'cm', 'mm', 'ft'].includes(units.display) ? units.display : 'm';
  $('#cal-real').value = '';
  dlg.returnValue = '';
  dlg.showModal();
  setTimeout(() => $('#cal-real').focus(), 50);
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const real = parseFloat($('#cal-real').value);
    if (!(real > 0)) return toast('Įveskite teigiamą atstumą', 'error');
    const realMeters = real * { m: 1, cm: 0.01, mm: 0.001, ft: 0.3048 }[$('#cal-unit').value];
    // metersPerUnit * dModel turi būti lygu realMeters
    const modelUnitMeters = units.metersPerUnit / units.calibration;
    units.calibration = realMeters / (dModel * modelUnitMeters);
    $('#opt-scale').value = +units.calibration.toPrecision(8);
    updateScaleBadge();
    redrawAll();
    updateModelInfo();
    toast(`Mastelis pritaikytas: koeficientas ${units.calibration.toPrecision(6)}`);
  };
}

function updateScaleBadge() {
  const b = $('#scale-badge');
  b.hidden = Math.abs(units.calibration - 1) < 1e-9;
  b.textContent = `Mastelis ×${units.num(units.calibration, 4)}`;
}

function level(pts) {
  const W = pts.map((p) => viewer.localToWorld(p));
  const n = fitPlaneNormal(W);
  viewer.applyLeveling(n);
  toast('Modelis išlygintas pagal pažymėtą plokštumą');
}

viewer.addEventListener('orientation', () => {
  // Pasikeitus orientacijai vertikalūs dydžiai keičiasi – perskaičiuojame
  items.forEach((it) => recompute(it));
  setupClipSliders();
});

// ---------------------------------------------------------------------------
// Modelio įkėlimas
// ---------------------------------------------------------------------------
function setLoading(on, text = 'Įkeliama…', p = null) {
  $('#loading').hidden = !on;
  $('#loading-text').textContent = text;
  if (p != null) $('#loading-bar').style.width = `${Math.round(p * 100)}%`;
}

function guessUp(object, suggested) {
  if (suggested) return suggested;
  const s = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  return s.z <= s.y ? 'z' : 'y';
}

async function openFiles(files) {
  if (!files || !files.length) return;
  tools.deactivate();
  setLoading(true, 'Įkeliama…', 0);
  try {
    const res = await loadModelFiles(files, {
      onProgress: (p) => ($('#loading-bar').style.width = `${Math.round(p * 100)}%`),
      onStatus: (t) => ($('#loading-text').textContent = t),
    });
    await showModel(res.object, res.originOffset, guessUp(res.object, res.suggestedUp), res.name, res.format);
    res.warnings.forEach((w) => toast(w, 'error', 7000));
  } catch (err) {
    console.error(err);
    toast(`Nepavyko atidaryti: ${err.message || err}`, 'error', 7000);
  } finally {
    setLoading(false);
  }
}

async function showModel(object, offset, up, name, format) {
  clearMeasurements();
  units.calibration = 1;
  $('#opt-scale').value = 1;
  updateScaleBadge();
  await viewer.setModel(object, offset, up, (t) => ($('#loading-text').textContent = t));
  viewer.setViewMode(settings.viewMode);
  modelInfo = { name, format };
  $('#file-name').textContent = name;
  $('#file-name').title = name;
  $('#empty-state').hidden = true;
  $$('#up-axis button').forEach((b) => b.classList.toggle('active', b.dataset.up === viewer.upAxis));
  const pointsOnly = viewer.meshes.length === 0;
  $$('#view-mode button').forEach((b) => (b.disabled = pointsOnly && (b.dataset.mode === 'lit' || b.dataset.mode === 'solid')));
  if (pointsOnly && ['lit', 'solid'].includes(settings.viewMode)) setViewMode('texture');
  setupClipSliders(true);
  updateModelInfo();
  const s = viewer.stats;
  $('#status-model').textContent = s.points ? `${fmtInt(s.points)} taškų` : `${fmtInt(s.triangles)} trikampių`;
  toast(`Atidaryta: ${name}`);
}

const fmtInt = (n) => n.toLocaleString('lt-LT');

function updateModelInfo() {
  if (!viewer.hasModel) return;
  const s = viewer.stats;
  const size = viewer.worldBox.getSize(new THREE.Vector3());
  const rows = [
    ['Failas', modelInfo?.name || '—'],
    ['Formatas', modelInfo?.format || '—'],
  ];
  if (s.triangles) rows.push(['Trikampiai', fmtInt(s.triangles)], ['Viršūnės', fmtInt(s.vertices)]);
  if (s.points) rows.push(['Taškai', fmtInt(s.points)]);
  if (s.textures) rows.push(['Tekstūros', String(s.textures)]);
  rows.push(['Plotis (X)', units.fmtLen(size.x)], ['Ilgis (Y)', units.fmtLen(size.z)], ['Aukštis (Z)', units.fmtLen(size.y)]);
  rows.push(['Žemiausias taškas', units.fmtDisp(viewer.dispElev(viewer.worldBox.min.y, units))]);
  rows.push(['Aukščiausias taškas', units.fmtDisp(viewer.dispElev(viewer.worldBox.max.y, units))]);
  if (s.triangles && s.triangles < 8e6) {
    const { area, volume } = viewer.meshAreaVolume();
    rows.push(['Paviršiaus plotas', units.fmtArea(area)]);
    rows.push(['Tūris (jei uždaras)', units.fmtVol(volume)]);
  }
  const c = viewer.center;
  rows.push(['Centras', `${units.num(c.x, 2)}; ${units.num(c.y, 2)}; ${units.num(c.z, 2)}`]);
  $('#model-info').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
}

// Failų pasirinkimas
const fileInput = $('#file-input');
const openDialog = () => fileInput.click();
$('#btn-open').addEventListener('click', openDialog);
$('#btn-open-2').addEventListener('click', openDialog);
$('#btn-open-folder').addEventListener('click', () => $('#folder-input').click());
fileInput.addEventListener('change', () => {
  openFiles(fileInput.files);
  fileInput.value = '';
});
$('#folder-input').addEventListener('change', (e) => {
  openFiles(e.target.files);
  e.target.value = '';
});
$('#btn-demo').addEventListener('click', async () => {
  setLoading(true, 'Kuriamas demonstracinis modelis…', 0.3);
  await new Promise((r) => setTimeout(r, 30));
  const { object, offset } = createDemoModel();
  await showModel(object, offset, 'z', 'Demonstracinis_karjeras.obj', 'DEMO');
  setLoading(false);
  toast('Išbandykite: V – krūvos tūris, A – plotas, R – profilis', 'info', 6000);
});

// Nutempimas
let dragDepth = 0;
viewport.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  viewport.classList.add('dragging');
});
viewport.addEventListener('dragover', (e) => e.preventDefault());
viewport.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    viewport.classList.remove('dragging');
  }
});
viewport.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  viewport.classList.remove('dragging');
  const files = await filesFromDataTransfer(e.dataTransfer);
  openFiles(files);
});

/** Leidžia nutempti ir ištisus aplankus. */
async function filesFromDataTransfer(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const walk = async (entry) => {
    if (entry.isFile) out.push(await new Promise((res, rej) => entry.file(res, rej)));
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const en of batch) await walk(en);
      } while (batch.length);
    }
  };
  for (const en of entries) await walk(en);
  return out;
}

// ---------------------------------------------------------------------------
// Skydeliai ir nustatymai
// ---------------------------------------------------------------------------
function showTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

function setViewMode(mode) {
  settings.viewMode = mode;
  saveSettings();
  viewer.setViewMode(mode);
  $$('#view-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#row-contours').style.opacity = mode === 'height' ? 1 : 0.5;
}
$$('#view-mode button').forEach((b) => b.addEventListener('click', () => setViewMode(b.dataset.mode)));
setViewMode(settings.viewMode);

$('#opt-wireframe').addEventListener('change', (e) => viewer.setWireframe(e.target.checked));
const applyContours = () => {
  const on = $('#opt-contours').checked;
  const step = units.fromDisplayLen(parseFloat($('#opt-contour-step').value) || 1);
  viewer.setContours(on ? step : 0);
  if (on && settings.viewMode !== 'height') setViewMode('height');
};
$('#opt-contours').addEventListener('change', applyContours);
$('#opt-contour-step').addEventListener('change', applyContours);

const ps = $('#opt-point-size');
ps.value = settings.pointSize;
viewer.setPointSize(settings.pointSize);
ps.addEventListener('input', () => {
  settings.pointSize = +ps.value;
  viewer.setPointSize(settings.pointSize);
  saveSettings();
});

const bg = $('#opt-background');
bg.value = settings.background;
viewport.dataset.bg = settings.background;
bg.addEventListener('change', () => {
  settings.background = bg.value;
  viewport.dataset.bg = bg.value;
  saveSettings();
});

$('#opt-grid').checked = settings.grid;
viewer.showGrid(settings.grid);
$('#opt-grid').addEventListener('change', (e) => {
  settings.grid = e.target.checked;
  viewer.showGrid(settings.grid);
  saveSettings();
});

// Pjūvis
function setupClipSliders(reset = false) {
  if (!viewer.hasModel) return;
  if (reset) {
    $('#clip-min').value = 0;
    $('#clip-max').value = 1000;
  }
  applyClip();
}
function applyClip() {
  const box = viewer.worldBox;
  const a = +$('#clip-min').value / 1000, b = +$('#clip-max').value / 1000;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const pad = (box.max.y - box.min.y) * 0.001;
  const min = lo > 0 ? box.min.y + (box.max.y - box.min.y) * lo : null;
  const max = hi < 1 ? box.min.y + (box.max.y - box.min.y) * hi + pad : null;
  viewer.setClip(min, max);
  const f = (y) => units.fmtDisp(viewer.dispElev(y, units));
  $('#clip-readout').textContent = min == null && max == null ? 'Pjūvis išjungtas' : `Rodoma nuo ${min == null ? 'apačios' : f(min)} iki ${max == null ? 'viršaus' : f(max)}`;
}
$('#clip-min').addEventListener('input', applyClip);
$('#clip-max').addEventListener('input', applyClip);

$$('#up-axis button').forEach((b) =>
  b.addEventListener('click', () => {
    if (!viewer.hasModel) return;
    viewer.setUpAxis(b.dataset.up);
    $$('#up-axis button').forEach((x) => x.classList.toggle('active', x === b));
    updateModelInfo();
  }),
);
$('#btn-reset-level').addEventListener('click', () => {
  viewer.resetLeveling();
  updateModelInfo();
});

// Vienetai
const unitSel = $('#unit-select');
unitSel.value = settings.unit;
unitSel.addEventListener('change', () => {
  settings.unit = units.display = unitSel.value;
  $$('.unit-label').forEach((e) => (e.textContent = units.display));
  saveSettings();
  redrawAll();
  updateModelInfo();
});
$$('.unit-label').forEach((e) => (e.textContent = units.display));

$('#opt-model-unit').addEventListener('change', (e) => {
  units.modelUnit = e.target.value;
  redrawAll();
  updateModelInfo();
});
$('#opt-scale').addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if (v > 0) {
    units.calibration = v;
    updateScaleBadge();
    redrawAll();
    updateModelInfo();
  }
});
$('#btn-reset-scale').addEventListener('click', () => {
  units.calibration = 1;
  units.modelUnit = 'm';
  $('#opt-model-unit').value = 'm';
  $('#opt-scale').value = 1;
  updateScaleBadge();
  redrawAll();
  updateModelInfo();
});

const prec = $('#opt-precision');
prec.value = settings.precision;
prec.addEventListener('change', () => {
  settings.precision = units.precision = +prec.value;
  saveSettings();
  redrawAll();
  updateModelInfo();
});
$('#opt-snap').checked = settings.snap;
$('#opt-snap').addEventListener('change', (e) => {
  settings.snap = e.target.checked;
  saveSettings();
});
$('#opt-resolution').value = settings.resolution;
$('#opt-resolution').addEventListener('change', (e) => {
  settings.resolution = +e.target.value;
  saveSettings();
  items.filter((i) => ['area', 'volume'].includes(i.m.type)).forEach(recompute);
});
$('#opt-density').value = settings.density;
$('#opt-density').addEventListener('change', (e) => {
  settings.density = parseFloat(e.target.value) || 0;
  saveSettings();
  renderList();
});
const applyLabelPrefs = () => {
  viewport.classList.remove('labels-sm', 'labels-lg');
  if (settings.labelSize !== 'md') viewport.classList.add(`labels-${settings.labelSize}`);
  viewport.classList.toggle('labels-hidden', !settings.labels);
};
$('#opt-label-size').value = settings.labelSize;
$('#opt-labels').checked = settings.labels;
$('#opt-label-size').addEventListener('change', (e) => {
  settings.labelSize = e.target.value;
  saveSettings();
  applyLabelPrefs();
});
$('#opt-labels').addEventListener('change', (e) => {
  settings.labels = e.target.checked;
  saveSettings();
  applyLabelPrefs();
});
applyLabelPrefs();

// Vaizdai
$$('[data-view]').forEach((b) => b.addEventListener('click', () => viewer.setView(b.dataset.view)));
$('#btn-fit').addEventListener('click', () => viewer.fitView());
const orthoBtn = $('#btn-ortho');
const toggleOrtho = () => {
  viewer.setOrtho(!viewer.isOrtho);
  orthoBtn.textContent = viewer.isOrtho ? 'Orto' : 'Persp.';
  orthoBtn.classList.toggle('active', viewer.isOrtho);
};
orthoBtn.addEventListener('click', toggleOrtho);

// ---------------------------------------------------------------------------
// Eksportas / importas
// ---------------------------------------------------------------------------
function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const baseName = () => (modelInfo?.name || 'modelis').replace(/\.[^.]+$/, '');
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

$('#btn-export-csv').addEventListener('click', () => {
  if (!items.length) return toast('Nėra matavimų eksportui');
  const rows = [['Nr.', 'Pavadinimas', 'Tipas', 'Reikšmė', 'Detalės', 'Taškai (X Y Z)']];
  items.forEach(({ m }, i) => {
    const d = describe(m, viewer, units, settings);
    const pts = m.points.map((p) => {
      const o = viewer.dispCoords(p, units);
      return [o.x, o.y, o.z].map((v) => units.num(v, 3)).join(' ');
    });
    rows.push([i + 1, m.name, TOOLS[m.type].label, d.value, d.details.map(([k, v]) => `${k}: ${v}`).join(' | '), pts.join(' ; ')]);
  });
  const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""').replace(/ | /g, ' ')}"`).join(';')).join('\r\n');
  download(`${baseName()}_matavimai_${stamp()}.csv`, csv, 'text/csv;charset=utf-8');
});

$('#btn-export-json').addEventListener('click', () => {
  if (!items.length) return toast('Nėra matavimų išsaugojimui');
  const data = {
    app: 'Atea 3D Matuoklis', version: 1, model: modelInfo?.name, created: new Date().toISOString(),
    calibration: units.calibration, modelUnit: units.modelUnit, upAxis: viewer.upAxis,
    level: viewer.levelQuat.toArray(),
    measurements: items.map(({ m }) => ({
      type: m.type, name: m.name, visible: m.visible, options: m.options,
      points: m.points.map((p) => viewer.localToOriginal(p).toArray()),
    })),
  };
  download(`${baseName()}_matavimai.json`, JSON.stringify(data, null, 2), 'application/json');
});

$('#btn-import-json').addEventListener('click', () => {
  if (!viewer.hasModel) return toast('Pirmiausia atidarykite modelį', 'error');
  $('#json-input').click();
});
$('#json-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data.measurements)) throw new Error('netinkamas failas');
    if (data.upAxis && data.upAxis !== viewer.upAxis) {
      viewer.setUpAxis(data.upAxis, false);
      $$('#up-axis button').forEach((b) => b.classList.toggle('active', b.dataset.up === viewer.upAxis));
    }
    if (Array.isArray(data.level)) {
      viewer.levelQuat.fromArray(data.level);
      viewer._applyOrientation();
    }
    if (data.calibration) {
      units.calibration = data.calibration;
      units.modelUnit = data.modelUnit || 'm';
      $('#opt-scale').value = units.calibration;
      $('#opt-model-unit').value = units.modelUnit;
      updateScaleBadge();
    }
    let n = 0;
    for (const r of data.measurements) {
      if (!TOOLS[r.type]) continue;
      const pts = r.points.map((a) => new THREE.Vector3().fromArray(a).sub(viewer.center));
      const m = new Measurement(r.type, pts, r.name);
      m.visible = r.visible !== false;
      if (r.options) m.options = { ...m.options, ...r.options };
      addMeasurement(m);
      n++;
    }
    setNextId(items.length + 1);
    if (modelInfo?.name && data.model && data.model !== modelInfo.name) toast(`Dėmesio: matavimai buvo atlikti modeliui „${data.model}“`, 'error', 6000);
    toast(`Įkelta matavimų: ${n}`);
  } catch (err) {
    toast(`Nepavyko įkelti: ${err.message}`, 'error');
  }
});

$('#btn-clear').addEventListener('click', () => {
  if (!items.length) return;
  if (confirm(`Ištrinti visus matavimus (${items.length})?`)) clearMeasurements();
});

// Ekrano kopija su etiketėmis ir Atea žyma
async function screenshot() {
  if (!viewer.hasModel) return toast('Nėra ką fotografuoti');
  const src = viewer.snapshot();
  const w = src.width, h = src.height;
  const pr = w / viewer.width;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d');
  const bgs = { dark: ['#2c3a36', '#0f1513'], green: ['#0f6b4f', '#00241a'], light: ['#f4f7f6', '#c6d2ce'], white: ['#ffffff', '#ffffff'] };
  const [c0, c1] = bgs[settings.background] || bgs.dark;
  const grad = g.createRadialGradient(w / 2, h * 0.35, 0, w / 2, h * 0.35, Math.max(w, h) * 0.75);
  grad.addColorStop(0, c0);
  grad.addColorStop(1, c1);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.drawImage(src, 0, 0);
  // Etiketės
  if (settings.labels) {
    const vr = viewport.getBoundingClientRect();
    document.querySelectorAll('.label-layer .m-label').forEach((el) => {
      if (el.style.display === 'none' || el.closest('[style*="display: none"]')) return;
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const cs = getComputedStyle(el);
      const x = (r.left - vr.left) * pr, y = (r.top - vr.top) * pr, bw = r.width * pr, bh = r.height * pr;
      g.fillStyle = cs.backgroundColor;
      roundRect(g, x, y, bw, bh, 6 * pr);
      g.fill();
      g.fillStyle = cs.getPropertyValue('--c') || '#fff';
      g.fillRect(x, y + 2 * pr, 3 * pr, bh - 4 * pr);
      g.fillStyle = '#fff';
      g.font = `${cs.fontWeight} ${parseFloat(cs.fontSize) * pr}px ${cs.fontFamily}`;
      g.textBaseline = 'middle';
      const lines = el.innerText.split('\n');
      lines.forEach((t, i) => g.fillText(t, x + parseFloat(cs.paddingLeft) * pr + 2 * pr, y + (bh / lines.length) * (i + 0.5)));
    });
  }
  // Žyma
  const pad = 14 * pr;
  g.font = `800 ${22 * pr}px Segoe UI, Arial, sans-serif`;
  const text = 'atea';
  const tw = g.measureText(text).width;
  g.fillStyle = 'rgba(0,87,63,0.9)';
  roundRect(g, pad, h - pad - 40 * pr, tw + 260 * pr, 40 * pr, 8 * pr);
  g.fill();
  g.fillStyle = '#fff';
  g.textBaseline = 'middle';
  g.fillText(text, pad + 12 * pr, h - pad - 20 * pr);
  g.font = `600 ${12 * pr}px Segoe UI, Arial, sans-serif`;
  g.fillText(`${modelInfo?.name || ''}  •  ${new Date().toLocaleString('lt-LT')}`, pad + tw + 24 * pr, h - pad - 20 * pr);
  out.toBlob((blob) => download(`${baseName()}_${stamp()}.png`, blob));
  toast('Ekrano kopija išsaugota');
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
$('#btn-screenshot').addEventListener('click', screenshot);

// Profilis
$('#profile-close').addEventListener('click', () => profile.hide());
$('#profile-csv').addEventListener('click', () => {
  const m = profile.current;
  if (!m?.data?.samples) return;
  const rows = [['Atstumas', 'X', 'Y', 'Aukštis'].map((h) => `${h} (${units.display})`)];
  for (const s of m.data.samples) {
    const local = viewer.worldToLocal(new THREE.Vector3(s.x, isNaN(s.y) ? 0 : s.y, s.z));
    const o = viewer.dispCoords(local, units);
    rows.push([units.len(s.d), o.x, o.y, isNaN(s.y) ? '' : viewer.dispElev(s.y, units)].map((v) => (v === '' ? '' : v.toFixed(3).replace('.', ','))));
  }
  download(`${baseName()}_profilis_${m.id}.csv`, '﻿' + rows.map((r) => r.join(';')).join('\r\n'), 'text/csv;charset=utf-8');
});
profile.onResize = () => viewer.resize();

// Skydelis mažuose ekranuose
$('#btn-panel').addEventListener('click', () => $('#sidepanel').classList.toggle('open'));

// Pagalba
$('#btn-help').addEventListener('click', () => $('#dlg-help').showModal());

// ---------------------------------------------------------------------------
// Klaviatūra
// ---------------------------------------------------------------------------
const KEY_TOOLS = Object.fromEntries(Object.entries(TOOLS).map(([id, t]) => [t.key.toLowerCase(), id]));
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'o') {
    e.preventDefault();
    return openDialog();
  }
  if ((e.ctrlKey || e.metaKey) && k === 'z') {
    e.preventDefault();
    return tools.undo();
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'escape') {
    if (tools.points.length) tools.cancel();
    else tools.deactivate();
  } else if (k === 'enter') tools.finish();
  else if (k === 'backspace') {
    e.preventDefault();
    tools.undo();
  } else if (k === 'delete' && selectedId != null) removeMeasurement(selectedId);
  else if (k === 'f') viewer.fitView();
  else if (k === 'o') toggleOrtho();
  else if (k === 'p') screenshot();
  else if (k === '?' || (e.shiftKey && k === '/')) $('#dlg-help').showModal();
  else if (k === '7') viewer.setView('top');
  else if (k === '1') viewer.setView('front');
  else if (k === '3') viewer.setView('right');
  else if (k === '5') viewer.setView('iso');
  else if (KEY_TOOLS[k]) tools.activate(KEY_TOOLS[k]);
});

// Vaizdo atnaujinimas – gizmo
viewer.addEventListener('render', () => gizmo.update());
gizmo.update();
