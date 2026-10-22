import './style.css';
import * as THREE from 'three';
import { Viewer } from './viewer.js';
import { loadModelFiles } from './loaders.js';
import { createDemoModel } from './demo.js';
import { units } from './units.js';
import { hydrateIcons, icon } from './icons.js';
import { logoSvg, drawLogo, LOGO_VIEWBOX } from './logo.js';
import { t as tr, getLang, setLang, onLangChange, startI18n, locale } from './i18n.js';
import { TOOLS, BASE_MODES, Measurement, MeasurementVisual, computeMeasurement, describe, quickData, setNextId, checkpointResidual } from './measurements.js';
import { fitPlaneNormal } from './compute.js';
import { ProfileChart } from './profile.js';
import { Gizmo } from './gizmo.js';
import { createOdmUI } from './odm/ui.js';
import { createLiveUI } from './live/ui.js';
import { createPlanUI } from './plan/ui.js';
import { extractFromZipUrl, WANT_MODEL, WANT_MODEL_GLB, WANT_POINTS } from './odm/results.js';
import { AiClient, AI_CLASSES } from './ai/client.js';
import { findLocalServer } from './local-server.js';
import { renderTopDown } from './ai/ortho.js';
import { Basemap, BASEMAPS } from './geo/basemap.js';
import { CompareModel, analyzeChange, buildChangeMesh } from './compare.js';
import { exportObjZip, exportGlb, exportLas } from './export.js';
import { whoAmI } from './portal/api.js';
import { showLogin, showInvite, changePasswordDialog, logout } from './portal/auth.js';
import { createPortalUI } from './portal/ui.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------------------------------------------------------------------------
// Nustatymai
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'atea3d.settings.v1';
const settings = {
  aiUrl: '', aiClasses: ['car', 'truck', 'bus', 'motorcycle'], aiThreshold: 0.5, aiOutlineKind: 'volume',
  coordOrder: 'ne', unit: 'm', precision: 2, snap: false, resolution: 250, density: 1.6, labelSize: 'md', labels: true,
  background: 'atea', pointSize: 2.5, viewMode: 'texture', grid: false,
  mapOn: false, mapSource: 'satellite', mapUrl: '', mapOpacity: 1,
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
$('#brand-logo').innerHTML = logoSvg();
if (!['atea', 'graphite', 'light', 'white'].includes(settings.background)) settings.background = 'atea';
const viewport = $('#viewport');
const viewer = new Viewer(viewport);
const gizmo = new Gizmo($('#gizmo'), viewer);
const basemap = new Basemap(viewer);
viewer.basemap = basemap;
const cmp = new CompareModel(viewer);
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
  el.textContent = tr(msg);
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ---------------------------------------------------------------------------
// Įrankių juosta
// ---------------------------------------------------------------------------
const TOOL_ORDER = [['navigate'], ['distance', 'polyline', 'height', 'angle', 'point'], ['area', 'volume', 'profile'], ['aiOutline', 'aiDetect'], ['checkpoint', 'scale', 'level']];
const AI_DETECT_BTN = { short: 'Transp.', label: 'AI transporto aptikimas', key: 'X', icon: 'car', tip: 'Dirbtinis intelektas (RF-DETR) suranda automobilius, sunkvežimius ir autobusus visame modelyje ir pateikia jų sąrašą su koordinatėmis.' };
const toolbar = $('#toolbar');
const tipEl = document.createElement('div');
tipEl.className = 'tool-tip';
tipEl.hidden = true;
document.body.append(tipEl);

TOOL_ORDER.forEach((group, gi) => {
  if (gi) toolbar.insertAdjacentHTML('beforeend', '<div class="tool-sep"></div>');
  for (const id of group) {
    const t = id === 'navigate' ? { short: 'Naršyti', label: 'Naršymas', key: 'Esc', icon: 'navigate', tip: 'Modelio apžiūra: sukimas, stūmimas, priartinimas.' } : id === 'aiDetect' ? AI_DETECT_BTN : TOOLS[id];
    const b = document.createElement('button');
    b.className = 'tool-btn';
    b.dataset.tool = id;
    b.innerHTML = `<span data-icon="${t.icon}">${icon(t.icon)}</span><span class="tool-label">${t.short}</span>${t.key && t.key !== 'Esc' ? `<span class="tool-key">${t.key}</span>` : ''}`;
    b.addEventListener('click', () => (id === 'navigate' ? tools.deactivate() : id === 'aiDetect' ? runDetection() : tools.activate(id)));
    b.addEventListener('mouseenter', () => {
      tipEl.innerHTML = `<b>${tr(t.label)}</b> <span style="opacity:.7">(${t.key})</span><br>${tr(t.tip)}`;
      const r = b.getBoundingClientRect();
      tipEl.style.left = `${r.right + 10}px`;
      tipEl.style.top = `${r.top + 4}px`;
      tipEl.hidden = false;
    });
    b.addEventListener('mouseleave', () => (tipEl.hidden = true));
    toolbar.append(b);
  }
});
$('#help-tools').innerHTML = [...Object.values(TOOLS).filter((t) => t.key), AI_DETECT_BTN].map((t) => `<li><span>${t.label}</span><kbd>${t.key}</kbd></li>`).join('');

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
    $('#tool-hint-title').textContent = tr(t.label);
    const n = this.points.length;
    $('#tool-hint-body').textContent = n ? `${tr(t.hint)} ${tr('Pažymėta taškų: {n}.', { n })}` : tr(t.hint);
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
      if (this.points.length) toast(tr('Reikia bent {n} taškų', { n: t.min }), 'info', 1800);
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
    if (type === 'checkpoint') return askCheckpoint(pts[0]);
    if (type === 'aiOutline') return aiOutline(pts[0]);
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
  const p = Math.max(units.precision, 2);
  const rows = viewer.coordRows(hit.local, units, settings.coordOrder);
  el.textContent = `${rows.map(([k, v]) => `${k.split(' ')[0]} ${units.num(v, p)}`).join('   ')} ${units.display}${viewer.crs ? `   ${viewer.crs.name.split(' (')[0]}` : ''}${hit.snapped ? `   ◆ ${tr('viršūnė')}` : ''}`;
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
    toast(tr('Nepavyko apskaičiuoti: {e}', { e: err.message }), 'error');
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
  renderCheckpoints();
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
    if (m.type === 'detections' && m.options.items?.length) {
      const b = document.createElement('div');
      b.className = 'm-options';
      b.innerHTML = `<button class="btn btn-sm btn-outline"><span data-icon="table">${icon('table')}</span>${tr('Objektų sąrašas (CSV)')}</button>`;
      b.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        exportDetectionsCsv(m);
      });
      el.append(b);
    }
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
    <label class="row" ${m.options.base === 'custom' ? '' : 'hidden'}>${tr('Pagrindo aukštis ({u})', { u: units.display })}
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
    toast(tr('Mastelis pritaikytas: koeficientas {k}', { k: units.calibration.toPrecision(6) }));
  };
}

// ---------------------------------------------------------------------------
// Vietinis dirbtinis intelektas (deploy/ai): išmanus kontūras ir transporto aptikimas
// ---------------------------------------------------------------------------
const defaultAiUrl = () => (location.protocol === 'file:' ? 'http://localhost:8080/ai/' : './ai/');
async function aiClient(recheck = false) {
  if (settings.aiUrl) return new AiClient(settings.aiUrl);
  const local = await findLocalServer(recheck);
  if (local && $('#ai-url').value === defaultAiUrl()) $('#ai-url').value = local + 'ai/';
  return new AiClient(local ? local + 'ai/' : defaultAiUrl());
}
const metersToWorld = (m) => m / units.metersPerUnit;

async function aiOutline(local) {
  const P = viewer.localToWorld(local);
  const box = viewer.worldBox;
  const ext = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  let S = Math.min(ext * 1.05, metersToWorld(80));
  const ac = startCancellable(tr('AI ieško objekto kontūro…'), 0.3);
  const { signal } = ac;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const half = S / 2;
      const img = await renderTopDown(viewer, { minX: P.x - half, maxX: P.x + half, minZ: P.z - half, maxZ: P.z + half, gsd: S / 1024, maxPx: 1024 });
      const [px, py] = img.toPixel(P.x, P.z);
      $('#loading-bar').style.width = `${40 + attempt * 20}%`;
      const res = await (await aiClient()).segment(img.blob, px, py, { signal });
      signal.throwIfAborted();
      // Kontūras siekia vaizdo kraštą – objektas didesnis, didiname sritį
      if (res.touches_border && S < ext && attempt < 2) {
        S = Math.min(S * 2.2, ext * 1.05);
        continue;
      }
      const pts = res.polygon.map(([x, y]) => {
        const [wx, wz] = img.toWorld(x, y);
        let wy = viewer.topHeightAt(wx, wz);
        if (!isFinite(wy)) wy = P.y;
        return viewer.worldToLocal(new THREE.Vector3(wx, wy, wz));
      });
      if (pts.length < 3) throw new Error(tr('Objekto nepavyko atskirti'));
      const kind = settings.aiOutlineKind === 'area' ? 'area' : 'volume';
      const m = new Measurement(kind, pts, `${tr('AI')} ${tr(TOOLS[kind].label).toLowerCase()} ${items.length + 1}`);
      addMeasurement(m, true);
      toast(tr('AI kontūras sukurtas ({n} taškų). Jei reikia – spustelėkite kitoje objekto vietoje.', { n: pts.length }));
      return;
    }
  } catch (e) {
    if (isAbort(e)) toast('AI skaičiavimas atšauktas');
    else toast(e.message, 'error', 9000);
  } finally {
    setLoading(false);
  }
}

async function runDetection() {
  if (!viewer.hasModel) return toast('Pirmiausia atidarykite modelį', 'error');
  tools.deactivate();
  const classes = settings.aiClasses.length ? settings.aiClasses : ['car', 'truck', 'bus'];
  const box = viewer.worldBox;
  const ac = startCancellable(tr('Ruošiamas vaizdas iš viršaus…'), 0.1);
  const { signal } = ac;
  try {
    await new Promise((r) => setTimeout(r, 30));
    signal.throwIfAborted();
    const img = await renderTopDown(viewer, { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z, gsd: metersToWorld(0.06), maxPx: 6144 });
    const gsdM = units.toMeters(img.gsd);
    $('#loading-text').textContent = tr('AI ieško transporto… ({w}×{h} px, {g} cm/px)', { w: img.width, h: img.height, g: (gsdM * 100).toFixed(1) });
    $('#loading-bar').style.width = '50%';
    const res = await (await aiClient()).detect(img.blob, { classes, threshold: settings.aiThreshold, gsd: gsdM, signal });
    signal.throwIfAborted();
    const det = res.detections || [];
    if (!det.length) return toast(tr('Objektų nerasta. Galite sumažinti patikimumo slenkstį nustatymuose.'), 'info', 7000);
    const lift = metersToWorld(0.25);
    const surfY = (wx, wz) => viewer.topHeightAt(wx, wz);
    let itemsOut = det.map((d) => {
      const [x0, y0, x1, y1] = d.box;
      const px = d.corners || [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      const pcx = px.reduce((a, p) => a + p[0], 0) / 4, pcy = px.reduce((a, p) => a + p[1], 0) / 4;
      const [cx, cz] = img.toWorld(pcx, pcy);
      // Objekto aukštis virš aplinkos: viršus – kontūro viduje, žemė – 1 m už kontūro
      const inside = [[pcx, pcy], ...px.map(([x, y]) => [pcx + (x - pcx) * 0.4, pcy + (y - pcy) * 0.4])];
      const top = Math.max(...inside.map(([x, y]) => surfY(...img.toWorld(x, y))).filter(isFinite));
      const ring = [...px, ...px.map((p, i) => [(p[0] + px[(i + 1) % 4][0]) / 2, (p[1] + px[(i + 1) % 4][1]) / 2])].map(([x, y]) => {
        const dx = x - pcx, dy = y - pcy, len = Math.hypot(dx, dy) || 1;
        const k = (len + metersToWorld(1) / img.gsd) / len;
        return surfY(...img.toWorld(pcx + dx * k, pcy + dy * k));
      });
      const ground = Math.min(...ring.filter(isFinite));
      const height = isFinite(top) && isFinite(ground) ? units.toMeters(top - ground) : null;
      let cy = surfY(cx, cz);
      if (!isFinite(cy)) cy = box.min.y;
      const corners = px.map(([x, y]) => {
        const [wx, wz] = img.toWorld(x, y);
        let wy = surfY(wx, wz);
        if (!isFinite(wy)) wy = cy;
        return viewer.worldToLocal(new THREE.Vector3(wx, wy + lift, wz)).toArray();
      });
      return {
        cls: d.class, score: d.score,
        c: viewer.worldToLocal(new THREE.Vector3(cx, cy + lift, cz)).toArray(),
        // Matmenys – tik kai yra tikslus (pasuktas) kontūras; ašinė dėžutė pasuktam automobiliui per didelė
        size: d.length != null ? [d.width, d.length] : null,
        heading: d.heading ?? null,
        height,
        corners,
      };
    });
    // Plokšti objektai (kelio ženklinimas, šuliniai, šešėliai) – ne transportas. Filtras taikomas tik
    // tada, kai modelis turi aiškų reljefą (dauguma objektų iškilę), kitaip – pvz. plokščias ortofoto.
    const raised = itemsOut.filter((it) => it.height == null || it.height >= 0.5);
    let flat = 0;
    if (raised.length >= itemsOut.length / 2) {
      flat = itemsOut.length - raised.length;
      itemsOut = raised;
    }
    if (!itemsOut.length) return toast(tr('Objektų nerasta. Galite sumažinti patikimumo slenkstį nustatymuose.'), 'info', 7000);
    const m = new Measurement('detections', itemsOut.map((it) => new THREE.Vector3(...it.c)));
    m.options.items = itemsOut;
    m.options.meta = { classes, threshold: settings.aiThreshold, gsd: gsdM, seconds: res.seconds, rejected: (res.rejected || 0) + flat };
    addMeasurement(m, true);
    const skipped = (res.rejected || 0) + flat;
    toast(
      tr('AI rado objektų: {n} (per {s} s)', { n: itemsOut.length, s: res.seconds }) +
        (skipped ? ' · ' + tr('atmesta netinkamo dydžio ar plokščių: {n}', { n: skipped }) : ''),
    );
    if (gsdM > 0.15) toast(tr('Modelis didelis – vaizdo raiška {g} cm/px, maži objektai gali būti praleisti.', { g: (gsdM * 100).toFixed(0) }), 'info', 8000);
  } catch (e) {
    if (isAbort(e)) toast('AI skaičiavimas atšauktas');
    else toast(e.message, 'error', 9000);
  } finally {
    setLoading(false);
  }
}

function detectionTable(m) {
  const names = viewer.coordRows(new THREE.Vector3(...m.options.items[0].c), units, settings.coordOrder).map(([k]) => k.split(' ')[0]);
  const rows = [[tr('Nr.'), tr('Klasė'), tr('Patikimumas'), ...names.map((n) => `${n} (${units.display})`), tr('Ilgis (m)'), tr('Plotis (m)'), tr('Aukštis (m)'), tr('Kryptis (°)')]];
  m.options.items.forEach((it, i) => {
    const cr = viewer.coordRows(new THREE.Vector3(...it.c), units, settings.coordOrder);
    rows.push([i + 1, tr(AI_CLASSES[it.cls]?.lt || it.cls), units.num(it.score * 100, 0) + ' %', ...cr.map(([, v]) => units.num(v, 3)), ...(it.size ? [units.num(it.size[1], 2), units.num(it.size[0], 2)] : ['', '']), it.height != null ? units.num(it.height, 2) : '', it.heading != null ? units.num(it.heading, 0) : '']);
  });
  return rows;
}

function exportDetectionsCsv(m) {
  const rows = detectionTable(m);
  const csv = '\ufeff' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""').replace(/\u00a0|\u202f/g, ' ')}"`).join(';')).join('\r\n');
  download(`${baseName()}_ai_objektai_${stamp()}.csv`, csv, 'text/csv;charset=utf-8');
}

// AI nustatymai
function setupAiSettings() {
  const url = $('#ai-url');
  url.value = settings.aiUrl || defaultAiUrl();
  url.addEventListener('change', () => {
    const v = url.value.trim();
    settings.aiUrl = v === defaultAiUrl() || /^http:\/\/localhost:80[89]\d\/ai\/?$/.test(v) ? '' : v;
    saveSettings();
  });
  $('#ai-classes').innerHTML = Object.entries(AI_CLASSES)
    .map(([k, c]) => `<label class="check small"><input type="checkbox" value="${k}" ${settings.aiClasses.includes(k) ? 'checked' : ''}/> <span>${c.many}</span></label>`)
    .join('');
  $('#ai-classes').addEventListener('change', () => {
    settings.aiClasses = [...$('#ai-classes').querySelectorAll('input:checked')].map((i) => i.value);
    saveSettings();
  });
  const thr = $('#ai-threshold');
  thr.value = Math.round(settings.aiThreshold * 100);
  const thrLabel = () => ($('#ai-threshold-val').textContent = `${thr.value} %`);
  thrLabel();
  thr.addEventListener('input', () => {
    settings.aiThreshold = +thr.value / 100;
    thrLabel();
    saveSettings();
  });
  $('#ai-outline-kind').value = settings.aiOutlineKind;
  $('#ai-outline-kind').addEventListener('change', (e) => {
    settings.aiOutlineKind = e.target.value;
    saveSettings();
  });
  $('#ai-check').addEventListener('click', async () => {
    const st = $('#ai-status');
    st.textContent = tr('Jungiamasi…');
    st.className = 'small muted';
    try {
      const h = await (await aiClient(true)).health();
      st.textContent = `● ${tr('Prisijungta')} · ${h.device.toUpperCase()}`;
      st.className = 'small ok';
    } catch (e) {
      st.textContent = `● ${e.message}`;
      st.className = 'small bad';
    }
  });
}
setupAiSettings();

// ---------------------------------------------------------------------------
// Kontroliniai taškai (tikslumo patikra ir pataisa)
// ---------------------------------------------------------------------------
function askCheckpoint(local) {
  const dlg = $('#dlg-checkpoint');
  const rows = viewer.coordRows(local, units, settings.coordOrder);
  const inputs = ['#cp-a', '#cp-b', '#cp-c'].map((q) => $(q));
  rows.forEach(([k, v], i) => {
    $(`#cp-l${i}`).textContent = `${k} (${units.display})`;
    inputs[i].value = '';
    inputs[i].placeholder = units.num(v, 3).replace(/\s/g, '');
  });
  const n = items.filter((i) => i.m.type === 'checkpoint').length + 1;
  $('#cp-name').value = `KT${n}`;
  dlg.returnValue = '';
  dlg.showModal();
  setTimeout(() => inputs[0].focus(), 50);
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const vals = inputs.map((el) => parseFloat(String(el.value).replace(',', '.').replace(/\s/g, '')));
    if (vals.some((v) => !isFinite(v))) return toast('Įveskite visas tris koordinates', 'error');
    // Rodomos ašys -> E, N, H
    const geo = viewer.crs?.geodetic && settings.coordOrder === 'ne';
    const [E, N, H] = geo ? [vals[1], vals[0], vals[2]] : vals;
    const raw = (v) => v / units.lenRaw(1);
    const m = new Measurement('checkpoint', [local], $('#cp-name').value.trim() || `KT${n}`);
    m.options.known = { x: raw(E), y: raw(N), z: raw(H) };
    addMeasurement(m, true);
    renderCheckpoints();
  };
}

function checkpointStats() {
  const cps = items.filter((i) => i.m.type === 'checkpoint' && i.m.options.known).map((i) => checkpointResidual(i.m, viewer, units));
  if (!cps.length) return null;
  const mean = (f) => cps.reduce((a, r) => a + f(r), 0) / cps.length;
  const rms = (f) => Math.sqrt(mean((r) => f(r) ** 2));
  return {
    n: cps.length,
    mean: { x: mean((r) => r.dx), y: mean((r) => r.dy), z: mean((r) => r.dz) },
    rmsXY: rms((r) => Math.hypot(r.dx, r.dy)),
    rmsZ: rms((r) => r.dz),
  };
}

function renderCheckpoints() {
  const el = $('#cp-summary');
  if (!el) return;
  const st = viewer.hasModel ? checkpointStats() : null;
  const shifted = viewer.datumShift.lengthSq() > 0;
  const p3 = Math.max(units.precision, 3);
  const f = (v) => `${v > 0 ? '+' : ''}${units.num(v, p3)} ${units.display}`;
  const geo = viewer.crs?.geodetic && settings.coordOrder === 'ne';
  el.innerHTML = st
    ? `<dl class="kv">
        <dt>Taškų</dt><dd>${st.n}</dd>
        <dt>RMS plokštumoje</dt><dd>${units.fmtDisp(st.rmsXY, p3)}</dd>
        <dt>RMS aukščio</dt><dd>${units.fmtDisp(st.rmsZ, p3)}</dd>
        <dt>Vid. ${geo ? 'ΔX (š.)' : 'ΔX'}</dt><dd>${f(geo ? st.mean.y : st.mean.x)}</dd>
        <dt>Vid. ${geo ? 'ΔY (r.)' : 'ΔY'}</dt><dd>${f(geo ? st.mean.x : st.mean.y)}</dd>
        <dt>Vid. ΔH</dt><dd>${f(st.mean.z)}</dd>
      </dl>
      <div class="pane-actions" style="margin-top:10px">
        <button class="btn btn-sm btn-primary" data-cp="h">Taikyti ΔH pataisą</button>
        <button class="btn btn-sm btn-outline" data-cp="xyz">Taikyti X, Y, H</button>
      </div>`
    : '<p class="muted small">Pažymėkite modelyje geodeziškai išmatuotus taškus įrankiu <b>Kontrolinis taškas</b> <kbd>C</kbd> – pamatysite tikslumą ir galėsite pritaikyti aukščio pataisą (pvz. geoido N).</p>';
  if (shifted) el.insertAdjacentHTML('beforeend', `<p class="small muted">Pritaikyta pataisa. <button class="btn btn-sm btn-ghost" data-cp="reset">Atstatyti</button></p>`);
  el.querySelectorAll('[data-cp]').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.cp === 'reset') viewer.datumShift.set(0, 0, 0);
      else {
        const k = 1 / units.lenRaw(1);
        viewer.datumShift.z -= st.mean.z * k;
        if (b.dataset.cp === 'xyz') {
          viewer.datumShift.x -= st.mean.x * k;
          viewer.datumShift.y -= st.mean.y * k;
        }
        toast('Pataisa pritaikyta – visos koordinatės ir aukščiai perskaičiuoti');
      }
      basemap.syncDatum();
      redrawAll();
      updateModelInfo();
      renderCheckpoints();
    }),
  );
}

function updateScaleBadge() {
  const b = $('#scale-badge');
  b.hidden = Math.abs(units.calibration - 1) < 1e-9;
  b.textContent = `${tr('Mastelis')} ×${units.num(units.calibration, 4)}`;
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
  // Pakeitus aukščio ašį žemėlapis kuriamas iš naujo (arba paslepiamas, jei Z nebe aukštyn)
  if (settings.mapOn && viewer.hasModel && basemap.source?.axis !== viewer.upAxis) refreshMap(true);
  clearChangeLayer();
});

// ---------------------------------------------------------------------------
// Modelio įkėlimas
// ---------------------------------------------------------------------------
let loadingAbort = null; // atšaukiamo veiksmo valdiklis (žr. startCancellable)
function setLoading(on, text = 'Įkeliama…', p = null) {
  if (!on) {
    loadingAbort = null;
    $('#loading-cancel').hidden = true;
  }
  $('#loading').hidden = !on;
  $('#loading-text').textContent = text;
  if (p != null) $('#loading-bar').style.width = `${Math.round(p * 100)}%`;
}

/**
 * Atšaukiamas ilgas veiksmas: įkėlimo lange rodomas mygtukas „Atšaukti“ (taip pat Esc).
 * @returns {AbortController}
 */
function startCancellable(text, p) {
  const ac = new AbortController();
  setLoading(true, text, p);
  loadingAbort = ac;
  $('#loading-cancel').hidden = false;
  return ac;
}
const isAbort = (e) => e?.name === 'AbortError';
$('#loading-cancel').addEventListener('click', () => loadingAbort?.abort());

function guessUp(object, suggested) {
  if (suggested) return suggested;
  const s = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  return s.z <= s.y ? 'z' : 'y';
}

let lastOpenedFiles = null; // portalui: „Įkelti dabar atidarytą modelį“
async function openFiles(files, opts = {}) {
  if (!files || !files.length) return;
  tools.deactivate();
  odmProject = null;
  setLoading(true, 'Įkeliama…', 0);
  try {
    const res = await loadModelFiles(files, {
      onProgress: (p) => ($('#loading-bar').style.width = `${Math.round(p * 100)}%`),
      onStatus: (t) => ($('#loading-text').textContent = t),
    });
    await showModel(res.object, res.originOffset, guessUp(res.object, res.suggestedUp), opts.name || res.name, res.format, {
      crs: res.crs,
      heightSystem: opts.heightSystem ?? null,
    });
    res.warnings.forEach((w) => toast(w, /perskaičiuot/.test(w) ? 'info' : 'error', 7000));
    lastOpenedFiles = opts.remote ? null : Array.from(files);
  } catch (err) {
    console.error(err);
    toast(tr('Nepavyko atidaryti: {e}', { e: err.message || err }), 'error', 7000);
  } finally {
    setLoading(false);
  }
}

async function showModel(object, offset, up, name, format, { crs = null, heightSystem = null } = {}) {
  clearMeasurements();
  units.calibration = 1;
  $('#opt-scale').value = 1;
  updateScaleBadge();
  await viewer.setModel(object, offset, up, (t) => ($('#loading-text').textContent = t), { crs, heightSystem });
  renderCheckpoints();
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
  basemap.clear();
  basemap.hide();
  if (settings.mapOn) refreshMap(true);
  clearCompare();
  syncSaveCard();
  const s = viewer.stats;
  $('#status-model').textContent = s.points ? tr('{n} taškų', { n: fmtInt(s.points) }) : tr('{n} trikampių', { n: fmtInt(s.triangles) });
  toast(tr('Atidaryta: {name}', { name }));
}

const fmtInt = (n) => n.toLocaleString(locale());

function updateModelInfo() {
  if (!viewer.hasModel) return;
  $('#model-info').innerHTML = modelInfoRows().map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
}

/** Modelio informacija. translate – PDF ataskaitai (UI tekstus verčia automatinis DOM vertimas). */
function modelInfoRows(translate = false) {
  const s = viewer.stats;
  const size = viewer.worldBox.getSize(new THREE.Vector3());
  const rows = [
    ['Failas', modelInfo?.name || '—'],
    ['Formatas', modelInfo?.format || '—'],
  ];
  if (s.triangles) rows.push(['Trikampiai', fmtInt(s.triangles)], ['Viršūnės', fmtInt(s.vertices)]);
  if (s.points) rows.push(['Taškai', fmtInt(s.points)]);
  if (s.textures) rows.push(['Tekstūros', String(s.textures)]);
  if (viewer.crs?.geodetic) rows.push(['Ilgis rytų kryptimi', units.fmtLen(size.x)], ['Ilgis šiaurės kryptimi', units.fmtLen(size.z)], ['Aukščių skirtumas', units.fmtLen(size.y)]);
  else rows.push(['Plotis (X)', units.fmtLen(size.x)], ['Ilgis (Y)', units.fmtLen(size.z)], ['Aukštis (Z)', units.fmtLen(size.y)]);
  rows.push(['Žemiausias taškas', units.fmtDisp(viewer.dispElev(viewer.worldBox.min.y, units))]);
  rows.push(['Aukščiausias taškas', units.fmtDisp(viewer.dispElev(viewer.worldBox.max.y, units))]);
  if (s.triangles && s.triangles < 8e6) {
    const { area, volume } = viewer.meshAreaVolume();
    rows.push(['Paviršiaus plotas', units.fmtArea(area)]);
    rows.push(['Tūris (jei uždaras)', units.fmtVol(volume)]);
  }
  const cr = viewer.coordRows(viewer.worldToLocal(viewer.worldBox.getCenter(new THREE.Vector3())), units, settings.coordOrder);
  rows.push(['Centras', cr.map(([k, v]) => `${k.split(' ')[0]} ${units.num(v, 2)}`).join('; ')]);
  rows.unshift(['Koordinačių sistema', viewer.crs?.name || 'Vietinė / nežinoma'], ['Aukščių sistema', viewer.heightSystem || '—']);
  if (viewer.datumShift.lengthSq() > 0) rows.push(['Pritaikyta pataisa', `${units.num(units.lenRaw(viewer.datumShift.x), 3)}; ${units.num(units.lenRaw(viewer.datumShift.y), 3)}; ${units.num(units.lenRaw(viewer.datumShift.z), 3)}`]);
  return translate ? rows.map(([k, v]) => [tr(k), tr(v)]) : rows;
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
  $('#clip-readout').textContent = min == null && max == null ? tr('Pjūvis išjungtas') : tr('Rodoma nuo {a} iki {b}', { a: min == null ? tr('apačios') : f(min), b: max == null ? tr('viršaus') : f(max) });
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
$('#opt-coord-order').value = settings.coordOrder;
$('#opt-coord-order').addEventListener('change', (e) => {
  settings.coordOrder = e.target.value;
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
  orthoBtn.textContent = viewer.isOrtho ? tr('Orto') : tr('Persp.');
  orthoBtn.classList.toggle('active', viewer.isOrtho);
};
orthoBtn.addEventListener('click', toggleOrtho);

// ---------------------------------------------------------------------------
// Palyginimas su kita data
// ---------------------------------------------------------------------------
/** Paskutinio palyginimo rezultatas (naudojamas ir PDF ataskaitoje). */
let compareState = null;
const changeLayer = new THREE.Group();
changeLayer.name = 'change';
viewer.scene.add(changeLayer);

function clearChangeLayer() {
  changeLayer.children.forEach((m) => {
    m.geometry.dispose();
    m.material.dispose();
  });
  changeLayer.clear();
  if (compareState) compareState.result = null;
  $('#cmp-result').hidden = true;
  viewer.requestRender();
}

function clearCompare() {
  clearChangeLayer();
  cmp.clear();
  compareState = null;
  viewer.content.visible = true;
  $('#cmp-body').hidden = true;
  $('#cmp-empty').hidden = false;
}

async function openCompareFiles(files) {
  if (!files?.length) return;
  if (!viewer.hasModel) return toast('Pirmiausia atidarykite modelį', 'error');
  tools.deactivate();
  setLoading(true, tr('Įkeliamas palyginimo modelis…'), 0);
  try {
    const res = await loadModelFiles(files, {
      onProgress: (p) => ($('#loading-bar').style.width = `${Math.round(p * 100)}%`),
      onStatus: (t) => ($('#loading-text').textContent = t),
    });
    const a = viewer.crs?.id || null, b = res.crs?.id || null;
    if (a && b && a !== b) throw new Error(tr('Modelių koordinačių sistemos skiriasi ({a} ir {b}).', { a: viewer.crs.name, b: res.crs.name }));
    clearChangeLayer();
    await cmp.set(res, res.name, (i, n) => ($('#loading-text').textContent = tr('Ruošiamas greitas matavimas ({i}/{n})…', { i: i + 1, n })));
    const ov = overlapXZ();
    if (!ov) {
      clearCompare();
      throw new Error(tr('Modeliai nepersidengia – patikrinkite, ar abu turi tas pačias koordinates.'));
    }
    compareState = { name: res.name, result: null };
    if (!a || !b) toast('Bent vienas modelis neturi koordinačių sistemos – lyginama pagal failų koordinates.', 'info', 7000);
    res.warnings.forEach((w) => toast(w, 'info', 6000));
    $('#cmp-empty').hidden = true;
    $('#cmp-body').hidden = false;
    $('#cmp-show-cmp').checked = false;
    cmp.visible = false;
    renderCompareInfo();
    fillCompareRegions();
    toast(tr('Palyginimo modelis įkeltas: {n}. Spauskite „Skaičiuoti pokyčius“.', { n: res.name }), 'info', 6000);
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'error', 8000);
  } finally {
    setLoading(false);
  }
}

/** Abiejų modelių persidengimas XZ plokštumoje (pasaulio koordinatėmis). */
function overlapXZ() {
  const A = viewer.worldBox, B = cmp.box;
  const o = { minX: Math.max(A.min.x, B.min.x), maxX: Math.min(A.max.x, B.max.x), minZ: Math.max(A.min.z, B.min.z), maxZ: Math.min(A.max.z, B.max.z) };
  return o.maxX > o.minX && o.maxZ > o.minZ ? o : null;
}

function renderCompareInfo() {
  const ov = overlapXZ();
  const rows = [
    [tr('Failas'), compareState.name],
    [tr('Persidengimas'), ov ? units.fmtArea((ov.maxX - ov.minX) * (ov.maxZ - ov.minZ)) + ' ' + tr('(stačiakampis)') : '—'],
  ];
  $('#cmp-info').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
}

function fillCompareRegions() {
  const sel = $('#cmp-region');
  const prev = sel.value;
  const polys = items.filter((i) => ['area', 'volume'].includes(i.m.type) && i.m.points.length >= 3);
  sel.innerHTML =
    `<option value="">${tr('Visa persidengianti sritis')}</option>` +
    polys.map((i) => `<option value="${i.m.id}">${escapeHtml(i.m.name || tr(TOOLS[i.m.type].label))}</option>`).join('');
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function runCompare() {
  if (!cmp.loaded) return;
  const ov = overlapXZ();
  if (!ov) return toast('Modeliai nepersidengia – patikrinkite, ar abu turi tas pačias koordinates.', 'error');
  const regionId = $('#cmp-region').value;
  const region = regionId ? items.find((i) => String(i.m.id) === regionId)?.m : null;
  const poly = region ? region.points.map((p) => viewer.localToWorld(p)) : null;
  const bounds = poly
    ? { minX: Math.min(...poly.map((p) => p.x)), maxX: Math.max(...poly.map((p) => p.x)), minZ: Math.min(...poly.map((p) => p.z)), maxZ: Math.max(...poly.map((p) => p.z)) }
    : ov;
  const ext = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  const cell = Math.max(ext / Math.max(200, settings.resolution * 2), metersToWorld(0.05));
  const threshold = metersToWorld(Math.max(0, +$('#cmp-threshold').value || 0));
  const mainAt = (x, z) => viewer.topHeightAt(x, z);
  const cmpAt = (x, z) => cmp.heightAt(x, z);
  const cmpIsOld = $('#cmp-order').value === 'old';
  clearChangeLayer();
  const ac = startCancellable(tr('Skaičiuojami pokyčiai…'), 0);
  try {
    const res = await analyzeChange(cmpIsOld ? cmpAt : mainAt, cmpIsOld ? mainAt : cmpAt, bounds, {
      cell, poly, threshold, signal: ac.signal,
      onProgress: (p) => ($('#loading-bar').style.width = `${Math.round(p * 100)}%`),
    });
    if (!res.area) throw new Error(tr('Pasirinktoje srityje modeliai nepersidengia.'));
    const mesh = buildChangeMesh(res, metersToWorld(0.03));
    changeLayer.add(mesh);
    changeLayer.visible = $('#cmp-show-map').checked;
    compareState.result = { ...res, region: region ? region.name || tr(TOOLS[region.type].label) : tr('Visa persidengianti sritis'), cmpIsOld, range: mesh.userData.range, density: settings.density };
    renderCompareResult();
    viewer.requestRender();
  } catch (e) {
    if (isAbort(e)) toast('Skaičiavimas atšauktas');
    else toast(e.message || String(e), 'error', 8000);
  } finally {
    setLoading(false);
  }
}

/** Pokyčių eilutės (UI ir PDF ataskaitai). */
function compareRows(r = compareState?.result) {
  if (!r) return [];
  const m3 = (v) => units.toCubicMeters(v);
  const rows = [
    [tr('Sritis'), r.region],
    [tr('Palyginta sritis'), units.fmtArea(r.area)],
    [tr('Pridėta (pylimas)'), units.fmtVol(r.fill)],
    [tr('Pašalinta (iškasa)'), units.fmtVol(r.cut)],
    [tr('Grynasis pokytis'), (r.net > 0 ? '+' : '') + units.fmtVol(r.net)],
  ];
  if (r.density > 0) {
    rows.push([tr('Pridėta masė ({d} t/m³)', { d: units.num(r.density, 2) }), `${units.num(m3(r.fill) * r.density, 1)} t`]);
    rows.push([tr('Pašalinta masė ({d} t/m³)', { d: units.num(r.density, 2) }), `${units.num(m3(r.cut) * r.density, 1)} t`]);
  }
  rows.push(
    [tr('Plotas, kur pridėta'), units.fmtArea(r.fillArea)],
    [tr('Plotas, kur pašalinta'), units.fmtArea(r.cutArea)],
    [tr('Didžiausias pakilimas'), units.fmtLen(r.maxUp)],
    [tr('Didžiausias nusileidimas'), units.fmtLen(r.maxDown)],
    [tr('Nejautrumo riba'), '±' + units.fmtLen(r.threshold)],
    [tr('Tinklelio žingsnis'), units.fmtLen(r.grid.cell)],
  );
  return rows;
}

function renderCompareResult() {
  const r = compareState?.result;
  $('#cmp-result').hidden = !r;
  if (!r) return;
  $('#cmp-leg-min').textContent = '−' + units.fmtLen(r.range);
  $('#cmp-leg-max').textContent = '+' + units.fmtLen(r.range);
  $('#cmp-values').innerHTML = compareRows().map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('');
}

$('#cmp-open').addEventListener('click', () => $('#cmp-input').click());
$('#cmp-open-folder').addEventListener('click', () => $('#cmp-folder-input').click());
for (const id of ['#cmp-input', '#cmp-folder-input'])
  $(id).addEventListener('change', (e) => {
    openCompareFiles([...e.target.files]);
    e.target.value = '';
  });
$('#cmp-run').addEventListener('click', runCompare);
$('#cmp-remove').addEventListener('click', clearCompare);
$('#cmp-region').addEventListener('focus', fillCompareRegions);
$('#cmp-region').addEventListener('mousedown', fillCompareRegions);
$('#cmp-show-main').addEventListener('change', (e) => {
  viewer.content.visible = e.target.checked;
  viewer.requestRender();
});
$('#cmp-show-cmp').addEventListener('change', (e) => (cmp.visible = e.target.checked));
$('#cmp-show-map').addEventListener('change', (e) => {
  changeLayer.visible = e.target.checked;
  viewer.requestRender();
});
cmp.visible = false;

// ---------------------------------------------------------------------------
// Žemėlapis po modeliu
// ---------------------------------------------------------------------------
const mapSource = () =>
  settings.mapSource === 'custom' ? { url: settings.mapUrl.trim(), maxZoom: 20, attribution: '' } : BASEMAPS[settings.mapSource] || BASEMAPS.satellite;
let mapBusy = null;

/** Parodo / paslepia žemėlapį pagal settings.mapOn. quiet – be klaidų pranešimų (pvz. įkeliant modelį). */
async function refreshMap(quiet = false) {
  syncMapUi();
  if (!settings.mapOn) return basemap.hide();
  if (!viewer.hasModel) return;
  const why = basemap.reason;
  if (why) {
    basemap.hide();
    if (!quiet) toast(why, 'info', 7000);
    return;
  }
  const src = mapSource();
  if (!src.url || !/\{z\}/.test(src.url) || !/\{x\}/.test(src.url) || !/\{y\}/.test(src.url)) {
    basemap.hide();
    return toast(tr('Įveskite žemėlapio adresą su {z}, {x} ir {y}.'), 'error', 7000);
  }
  const run = (mapBusy = basemap.show({ ...src, axis: viewer.upAxis }));
  try {
    const r = await run;
    if (r && r.failed) toast(tr('Dalies žemėlapio plytelių nepavyko atsisiųsti ({n}).', { n: r.failed }), 'info', 6000);
  } catch (e) {
    if (mapBusy === run) toast(e.message, 'error', 8000);
  }
}

function syncMapUi() {
  $('#btn-map').classList.toggle('active', settings.mapOn);
  $('#map-on').checked = settings.mapOn;
  $('#map-source').value = settings.mapSource;
  $('#row-map-url').hidden = settings.mapSource !== 'custom';
  const a = $('#map-attrib');
  a.hidden = !settings.mapOn || !viewer.hasModel;
  a.textContent = mapSource().attribution || '';
}

function toggleMap(on = !settings.mapOn) {
  settings.mapOn = on;
  saveSettings();
  refreshMap();
}

$('#btn-map').addEventListener('click', () => toggleMap());
$('#map-on').addEventListener('change', (e) => toggleMap(e.target.checked));
$('#map-source').addEventListener('change', (e) => {
  settings.mapSource = e.target.value;
  saveSettings();
  syncMapUi();
  if (settings.mapOn && (settings.mapSource !== 'custom' || settings.mapUrl)) refreshMap();
});
$('#map-url').value = settings.mapUrl;
$('#map-url').addEventListener('change', (e) => {
  settings.mapUrl = e.target.value.trim();
  saveSettings();
  if (settings.mapOn) refreshMap();
});
$('#map-opacity').value = settings.mapOpacity;
basemap.setOpacity(settings.mapOpacity);
$('#map-opacity').addEventListener('input', (e) => {
  settings.mapOpacity = +e.target.value;
  basemap.setOpacity(settings.mapOpacity);
  saveSettings();
});
syncMapUi();

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

// ---------------------------------------------------------------------------
// Išsaugojimas kompiuteryje: 3D modelis (OBJ / GLB / LAS) ir ODM rezultatai (ortofoto, DSM, DTM…)
// ---------------------------------------------------------------------------
let odmProject = null; // projektas, iš kurio atidarytas dabartinis modelis

function syncSaveCard() {
  const has = viewer.hasModel;
  $$('#save-card [data-save]').forEach((b) => (b.disabled = !has));
  $('#save-card [data-save=las]').hidden = !viewer.pointClouds.length;
  $('#save-card [data-save=obj]').hidden = !viewer.meshes.length && viewer.pointClouds.length > 0;
  $('#save-odm').hidden = !odmProject;
  if (odmProject) $('#save-odm-name').textContent = odmProject.name;
}

async function saveModel(kind) {
  if (!viewer.hasModel) return toast('Pirmiausia atidarykite modelį', 'error');
  const name = baseName().replace(/[\\/:*?"<>|\s]+/g, '_') || 'modelis';
  const crsTag = viewer.crs?.id === 'LKS94' ? '_LKS94' : viewer.crs?.id ? `_${viewer.crs.id}` : '';
  setLoading(true, tr('Ruošiamas failas…'), 0.1);
  await new Promise((r) => setTimeout(r, 30));
  try {
    if (kind === 'obj') {
      const blob = await exportObjZip(viewer, units, name, (p) => ($('#loading-bar').style.width = `${Math.round(10 + p * 80)}%`));
      download(`${name}${crsTag}_obj.zip`, blob);
    } else if (kind === 'glb') {
      const { blob, offset } = await exportGlb(viewer, units);
      download(`${name}.glb`, blob);
      if (viewer.crs) toast(tr('GLB koordinatės santykinės (centras ties 0). Poslinkis: X {x}, Y {y}, Z {z} – tikslioms koordinatėms naudokite OBJ.', { x: units.num(offset.x, 3), y: units.num(offset.y, 3), z: units.num(offset.z, 3) }), 'info', 9000);
    } else if (kind === 'las') {
      download(`${name}${crsTag}.las`, exportLas(viewer, units));
    }
    toast('Failas išsaugotas');
  } catch (e) {
    console.error(e);
    toast(tr('Nepavyko išsaugoti: {e}', { e: e.message || e }), 'error', 8000);
  } finally {
    setLoading(false);
  }
}
$$('#save-card [data-save]').forEach((b) => b.addEventListener('click', () => saveModel(b.dataset.save)));

const ODM_FILES = {
  ortho: { path: 'odm_orthophoto/odm_orthophoto.tif', label: 'ortofoto', raster: true },
  dsm: { path: 'odm_dem/dsm.tif', label: 'DSM', raster: true },
  dtm: { path: 'odm_dem/dtm.tif', label: 'DTM', raster: true },
  laz: { path: 'odm_georeferencing/odm_georeferenced_model.laz', label: 'taskai', ext: 'laz' },
};

/** Atsisiunčia vieną ODM rezultatą (iš all.zip srautu); rastrus pagal pasirinkimą perskaičiuoja į LKS-94. */
async function saveOdmResult(project, kind, crs) {
  const safe = project.name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'projektas';
  if (kind === 'all') {
    const a = document.createElement('a');
    a.href = project.downloadUrl;
    a.download = `${safe}_all.zip`;
    a.click();
    return;
  }
  const ac = startCancellable(tr('Atsisiunčiami rezultatai…'), 0);
  const { signal } = ac;
  const progress = (p, bytes) => {
    $('#loading-bar').style.width = `${Math.round(p * (crs === 'lks' ? 60 : 100))}%`;
    $('#loading-text').textContent = `${tr('Atsisiunčiami rezultatai…')} ${(bytes / 1e6).toFixed(0)} MB`;
  };
  try {
    if (kind === 'model') {
      const want = (p) => WANT_MODEL(p) || WANT_MODEL_GLB(p);
      const files = await extractFromZipUrl(project.downloadUrl, want, progress, signal);
      if (!files.some((f) => /\.(obj|glb)$/i.test(f.name))) throw new Error(tr('Archyve nerastas 3D modelis'));
      const entries = {};
      for (const f of files) entries[f.name] = [new Uint8Array(await f.arrayBuffer()), { level: /\.(png|jpe?g|glb)$/i.test(f.name) ? 0 : 6 }];
      const { zipSync } = await import('three/examples/jsm/libs/fflate.module.js');
      download(`${safe}_3d_modelis_ODM.zip`, new Blob([zipSync(entries)], { type: 'application/zip' }));
      return toast('Failas išsaugotas');
    }
    const def = ODM_FILES[kind];
    const files = await extractFromZipUrl(project.downloadUrl, (p) => p === def.path, progress, signal);
    if (!files.length) throw new Error(tr('Šio projekto rezultatuose nėra: {f} (galbūt išjungtas kuriant projektą).', { f: def.path }));
    let blob = files[0];
    let suffix = '_UTM';
    if (def.raster && crs === 'lks') {
      $('#loading-text').textContent = tr('Perskaičiuojama į LKS-94…');
      $('#loading-bar').style.width = '70%';
      blob = await (await aiClient()).toLks94(files[0], `${safe}_${def.label}`, { signal });
      suffix = '_LKS94';
    }
    signal.throwIfAborted();
    download(`${safe}_${def.label}${suffix}.${def.ext || 'tif'}`, blob);
    toast('Failas išsaugotas');
  } catch (e) {
    if (isAbort(e)) toast('Atsisiuntimas atšauktas');
    else toast(tr('Nepavyko: {e}', { e: e.message || e }), 'error', 9000);
  } finally {
    setLoading(false);
  }
}

function bindOdmButtons(root, getProject) {
  root.querySelectorAll('[data-odm]').forEach((b) =>
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const p = getProject();
      if (!p) return;
      const crs = root.querySelector('.save-crs')?.value || 'lks';
      settings.saveCrs = crs;
      saveSettings();
      saveOdmResult(p, b.dataset.odm, crs);
    }),
  );
  const sel = root.querySelector('.save-crs');
  if (sel && settings.saveCrs) sel.value = settings.saveCrs;
}
bindOdmButtons($('#save-odm'), () => odmProject);
let dialogProject = null;
bindOdmButtons($('#dlg-odm-save'), () => {
  $('#dlg-odm-save').close();
  return dialogProject;
});
syncSaveCard();
function openOdmSaveDialog(project) {
  dialogProject = project;
  $('#dlg-odm-save-name').textContent = project.name;
  if (settings.saveCrs) $('#dlg-odm-save .save-crs').value = settings.saveCrs;
  $('#dlg-odm-save').showModal();
}

// ---------------------------------------------------------------------------
// PDF ataskaita
// ---------------------------------------------------------------------------
const REPORT_SKIP = new Set(['checkpoint', 'detections']); // turi atskirus skyrius

function reportAvailability() {
  const ms = items.filter((i) => i.m.visible !== false);
  return {
    view: true,
    top: true,
    measurements: ms.some((i) => !REPORT_SKIP.has(i.m.type)),
    change: !!compareState?.result,
    checkpoints: !!checkpointStats(),
    ai: ms.some((i) => i.m.type === 'detections' && i.m.options.items?.length),
  };
}

function openReportDialog() {
  if (!viewer.hasModel) return toast('Pirmiausia atidarykite modelį', 'error');
  tools.deactivate();
  const dlg = $('#dlg-report');
  $('#rep-title').value ||= tr('Matavimų ataskaita');
  $('#rep-object').value = baseName();
  $('#rep-author').value = settings.reportAuthor || '';
  const av = reportAvailability();
  dlg.querySelectorAll('#rep-sections input').forEach((cb) => {
    const ok = av[cb.value];
    cb.disabled = !ok;
    cb.checked = ok && settings.reportSections?.[cb.value] !== false;
    cb.closest('label').classList.toggle('disabled', !ok);
  });
  dlg.returnValue = '';
  dlg.showModal();
}

$('#dlg-report').addEventListener('close', () => {
  const dlg = $('#dlg-report');
  if (dlg.returnValue !== 'ok') return;
  const sections = {};
  dlg.querySelectorAll('#rep-sections input').forEach((cb) => (sections[cb.value] = cb.checked && !cb.disabled));
  settings.reportAuthor = $('#rep-author').value.trim();
  settings.reportSections = Object.fromEntries([...dlg.querySelectorAll('#rep-sections input')].filter((cb) => !cb.disabled).map((cb) => [cb.value, cb.checked]));
  saveSettings();
  makeReport({
    title: $('#rep-title').value.trim() || tr('Matavimų ataskaita'),
    object: $('#rep-object').value.trim() || baseName(),
    author: settings.reportAuthor,
    notes: $('#rep-notes').value.trim(),
    sections,
  });
});

function reportContext({ title, object, author, notes, sections }) {
  const visible = items.filter((i) => i.m.visible !== false).map((i) => i.m);
  const labels = [];
  const measurements = [];
  for (const m of visible) {
    const desc = describe(m, viewer, units, settings);
    const color = TOOLS[m.type]?.color;
    if (settings.labels) desc.labels.forEach((l) => labels.push({ world: viewer.localToWorld(l.pos), text: l.text, sub: l.sub, color: l.color || color }));
    if (REPORT_SKIP.has(m.type)) continue;
    const rows = m.points.map((p) => viewer.coordRows(p, units, settings.coordOrder));
    measurements.push({
      name: m.name,
      type: tr(TOOLS[m.type]?.label || m.type),
      value: desc.value || '—',
      details: desc.details.map(([k, v]) => [tr(k), String(v)]),
      coordNames: rows[0]?.map(([k]) => tr(k)) || [],
      points: m.type === 'scale' ? [] : rows.map((r) => r.map(([, v]) => units.num(v, Math.max(3, units.precision)))),
    });
  }

  let change = null;
  const r = compareState?.result;
  if (r) {
    const g = r.grid;
    change = {
      rows: compareRows(r),
      range: r.range,
      fmtLen: (v) => units.fmtLen(v),
      oldName: r.cmpIsOld ? compareState.name : modelInfo?.name,
      newName: r.cmpIsOld ? modelInfo?.name : compareState.name,
      bounds: { minX: g.minX, maxX: g.minX + (g.nx - 1) * g.cell, minZ: g.minZ, maxZ: g.minZ + (g.nz - 1) * g.cell },
    };
  }

  let checkpoints = null;
  const st = checkpointStats();
  if (st) {
    const p3 = Math.max(units.precision, 3);
    const geo = viewer.crs?.geodetic && settings.coordOrder === 'ne';
    const f = (v) => `${v > 0 ? '+' : ''}${units.num(v, p3)}`;
    const cps = items.filter((i) => i.m.type === 'checkpoint' && i.m.options.known);
    checkpoints = {
      summary: [
        [tr('Taškų'), String(st.n)],
        [tr('RMS plokštumoje'), units.fmtDisp(st.rmsXY, p3)],
        [tr('RMS aukščio'), units.fmtDisp(st.rmsZ, p3)],
        [tr('Vid. ΔH'), `${f(st.mean.z)} ${units.display}`],
      ],
      cols: [tr('Taškas'), `${geo ? 'ΔX (š.)' : 'ΔX'} (${units.display})`, `${geo ? 'ΔY (r.)' : 'ΔY'} (${units.display})`, `ΔH (${units.display})`, `${tr('Δ plokštumoje')} (${units.display})`],
      rows: cps.map((i) => {
        const c = checkpointResidual(i.m, viewer, units);
        return [i.m.name, f(geo ? c.dy : c.dx), f(geo ? c.dx : c.dy), f(c.dz), units.num(Math.hypot(c.dx, c.dy), p3)];
      }),
    };
  }

  const detections = visible
    .filter((m) => m.type === 'detections' && m.options.items?.length)
    .map((m) => {
      const [head, ...rows] = detectionTable(m);
      const counts = {};
      m.options.items.forEach((it) => (counts[it.cls] = (counts[it.cls] || 0) + 1));
      return {
        name: m.name,
        summary: [
          ...Object.entries(counts).map(([c, n]) => [tr(AI_CLASSES[c]?.many || c), String(n)]),
          [tr('Vidutinis patikimumas'), units.fmtPercent((m.options.items.reduce((a, it) => a + it.score, 0) / m.options.items.length) * 100)],
        ],
        cols: head.map(String),
        rows: rows.slice(0, 500).map((r) => r.map(String)),
      };
    });

  const date = new Date().toLocaleString(locale(), { dateStyle: 'long', timeStyle: 'short' });
  return {
    viewer, units, t: tr, changeLayer,
    meta: { title, object, author, notes, date },
    sections, labels, measurements, change, checkpoints, detections,
    modelRows: modelInfoRows(true),
  };
}

async function makeReport(opts) {
  setLoading(true, tr('Kuriama PDF ataskaita…'), 0.05);
  try {
    const { createReport } = await import('./report/report.js');
    const blob = await createReport(reportContext(opts), (t) => ($('#loading-text').textContent = t));
    const safe = opts.object.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'ataskaita';
    download(`${safe}_ataskaita_${stamp()}.pdf`, blob);
    toast('PDF ataskaita sukurta');
  } catch (e) {
    console.error(e);
    toast(tr('Nepavyko sukurti ataskaitos: {e}', { e: e.message || e }), 'error', 9000);
  } finally {
    setLoading(false);
  }
}

$('#btn-report').addEventListener('click', openReportDialog);

$('#btn-export-csv').addEventListener('click', () => {
  if (!items.length) return toast('Nėra matavimų eksportui');
  const axisNames = viewer.hasModel && items.length ? viewer.coordRows(items[0].m.points[0], units, settings.coordOrder).map(([k]) => k.split(' ')[0]).join(' ') : 'X Y Z';
  const rows = [[tr('Nr.'), tr('Pavadinimas'), tr('Tipas'), tr('Reikšmė'), tr('Detalės'), `${tr('Taškai')} (${axisNames}${viewer.crs ? ', ' + tr(viewer.crs.name) : ''})`]];
  items.forEach(({ m }, i) => {
    const d = describe(m, viewer, units, settings);
    const pts = m.points.map((p) => {
      return viewer.coordRows(p, units, settings.coordOrder).map(([, v]) => units.num(v, 3)).join(' ');
    });
    rows.push([i + 1, m.name, tr(TOOLS[m.type].label), d.value, d.details.map(([k, v]) => `${k}: ${v}`).join(' | '), pts.join(' ; ')]);
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
    crs: viewer.crs?.id || null,
    datumShift: viewer.datumShift.toArray(),
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
    if (Array.isArray(data.datumShift)) viewer.datumShift.fromArray(data.datumShift);
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
    if (modelInfo?.name && data.model && data.model !== modelInfo.name) toast(tr('Dėmesio: matavimai buvo atlikti modeliui „{m}“', { m: data.model }), 'error', 6000);
    toast(tr('Įkelta matavimų: {n}', { n }));
  } catch (err) {
    toast(tr('Nepavyko įkelti: {e}', { e: err.message }), 'error');
  }
});

$('#btn-clear').addEventListener('click', () => {
  if (!items.length) return;
  if (confirm(tr('Ištrinti visus matavimus ({n})?', { n: items.length }))) clearMeasurements();
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
  const bgs = { atea: ['#1d4629', '#102d21', '#1f2326'], graphite: ['#30363a', '#1f2326', '#141719'], light: ['#f4f7f6', '#d9e2df', '#c6d2ce'], white: ['#ffffff', '#ffffff', '#ffffff'] };
  const [c0, c1, c2] = bgs[settings.background] || bgs.atea;
  const grad = g.createRadialGradient(w * 0.3, h * 0.4, 0, w * 0.3, h * 0.4, Math.max(w, h) * 0.85);
  grad.addColorStop(0, c0);
  grad.addColorStop(0.6, c1);
  grad.addColorStop(1, c2);
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
  // Žyma: ATEA logotipas + failas ir data
  const pad = 14 * pr, bh = 40 * pr;
  g.font = `600 ${12 * pr}px Inter, Segoe UI, Arial, sans-serif`;
  const caption = `${modelInfo?.name || ''}  •  ${new Date().toLocaleString(locale())}`;
  const logoW = (LOGO_VIEWBOX[0] / LOGO_VIEWBOX[1]) * 16 * pr;
  const boxW = 14 * pr + logoW + 14 * pr + g.measureText(caption).width + 14 * pr;
  g.fillStyle = 'rgba(31,35,38,0.92)';
  roundRect(g, pad, h - pad - bh, boxW, bh, 4 * pr);
  g.fill();
  g.fillStyle = '#008b01';
  g.fillRect(pad, h - pad - bh, 4 * pr, bh);
  drawLogo(g, pad + 14 * pr, h - pad - bh / 2 - 8 * pr, 16 * pr, '#ffffff');
  g.fillStyle = '#c3cac6';
  g.textBaseline = 'middle';
  g.fillText(caption, pad + 28 * pr + logoW, h - pad - bh / 2);
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
  const local0 = viewer.worldToLocal(new THREE.Vector3(m.data.samples[0].x, 0, m.data.samples[0].z));
  const names = viewer.coordRows(local0, units, settings.coordOrder).map(([k]) => k.split(' ')[0]);
  const rows = [['Atstumas', names[0], names[1], 'Aukštis'].map((h) => `${h} (${units.display})`)];
  for (const s of m.data.samples) {
    const local = viewer.worldToLocal(new THREE.Vector3(s.x, isNaN(s.y) ? 0 : s.y, s.z));
    const cr = viewer.coordRows(local, units, settings.coordOrder);
    rows.push([units.len(s.d), cr[0][1], cr[1][1], isNaN(s.y) ? '' : viewer.dispElev(s.y, units)].map((v) => (v === '' ? '' : v.toFixed(3).replace('.', ','))));
  }
  download(`${baseName()}_profilis_${m.id}.csv`, '﻿' + rows.map((r) => r.join(';')).join('\r\n'), 'text/csv;charset=utf-8');
});
profile.onResize = () => viewer.resize();

// ---------------------------------------------------------------------------
// Modelio kūrimas iš nuotraukų (OpenDroneMap)
// ---------------------------------------------------------------------------
const odmUI = createOdmUI({
  toast,
  filesFromDataTransfer,
  saveResults(project) {
    openOdmSaveDialog(project);
  },
  async openResult(project, kind) {
    tools.deactivate();
    setLoading(true, 'Atsisiunčiami rezultatai…', 0);
    try {
      const progress = (p, bytes) => {
        $('#loading-bar').style.width = `${Math.round(p * 100)}%`;
        $('#loading-text').textContent = `${tr('Atsisiunčiami rezultatai…')} ${(bytes / 1e6).toFixed(0)} MB`;
      };
      let files = await extractFromZipUrl(project.downloadUrl, kind === 'points' ? WANT_POINTS : WANT_MODEL_GLB, progress);
      if (kind !== 'points' && !files.some((f) => /\.glb$/i.test(f.name))) files = await extractFromZipUrl(project.downloadUrl, WANT_MODEL, progress);
      if (!files.some((f) => /\.(obj|glb|laz|las)$/i.test(f.name))) throw new Error(tr(kind === 'points' ? 'Archyve nerasta taškų debesies' : 'Archyve nerastas 3D modelis'));
      setLoading(false);
      await openFiles(files, { heightSystem: project.heightSystem, name: project.name });
      if (viewer.hasModel) {
        odmProject = project;
        syncSaveCard();
      }
    } catch (e) {
      setLoading(false);
      toast(tr('Nepavyko atidaryti rezultatų: {e}', { e: e.message }), 'error', 8000);
    }
  },
});
const openOdm = () => (liveUI.close(), planUI.close(), portalUI?.close(), odmUI.open());
$('#btn-odm').addEventListener('click', openOdm);
$('#btn-odm-2').addEventListener('click', openOdm);
$('#odm-badge').addEventListener('click', openOdm);

// ---------------------------------------------------------------------------
// Tiesioginė transliacija
// ---------------------------------------------------------------------------
const liveUI = createLiveUI({
  toast,
  getAi: () => aiClient(),
  onActive: (n) => $('#btn-live').classList.toggle('live-on', n > 0),
});
$('#btn-live').addEventListener('click', () => {
  if (liveUI.isOpen) return liveUI.close();
  if (odmUI.isOpen) odmUI.close();
  planUI.close();
  portalUI?.close();
  liveUI.open();
});

// ---------------------------------------------------------------------------
// Skrydžio planas
// ---------------------------------------------------------------------------
const planUI = createPlanUI({ toast });
$('#btn-plan').addEventListener('click', () => {
  if (planUI.isOpen) return planUI.close();
  if (odmUI.isOpen) odmUI.close();
  liveUI.close();
  portalUI?.close();
  planUI.open();
});

// ---------------------------------------------------------------------------
// Portalas: paskyros (admin / klientas) ir „Mano sritis“. Teises tikrina serveris – čia tik sąsaja.
// ---------------------------------------------------------------------------
let portalUI = null;
(async () => {
  const invite = /#invite=([\w-]+)/.exec(location.hash)?.[1];
  if (invite) return showInvite(invite);
  const who = await whoAmI();
  if (who.mode === 'login') return showLogin();
  if (who.mode !== 'user') return; // be serverio (iš disko) – kaip anksčiau
  const user = who.user;
  document.body.classList.add('portal', `role-${user.role}`);
  $('#user-name').textContent = user.name || user.email;
  portalUI = createPortalUI({
    user,
    toast,
    loading: (on, text, p) => setLoading(on, text, p),
    openModel: (files, name) => openFiles(files, { name, remote: true }),
    openStream: (item) => (odmUI.isOpen && odmUI.close(), planUI.close(), liveUI.openItem(item)),
    lastModelFiles: () => lastOpenedFiles,
  });
  liveUI.setPortal({ role: user.role, portal: portalUI });
  const openPortal = () => {
    if (portalUI.isOpen) return portalUI.close();
    if (odmUI.isOpen) odmUI.close();
    liveUI.close();
    planUI.close();
    portalUI.open();
  };
  $('#btn-portal').addEventListener('click', openPortal);
  $('#btn-portal-2').addEventListener('click', () => (portalUI.isOpen || openPortal()));
  $('#btn-user').addEventListener('click', (e) => {
    const old = document.querySelector('.user-menu');
    if (old) return old.remove();
    const m = document.createElement('div');
    m.className = 'user-menu';
    m.innerHTML = `<div class="small"><b>${escapeHtml(user.name || user.email)}</b><div class="muted">${escapeHtml(user.email)} · ${escapeHtml(tr(user.role === 'admin' ? 'administratorius' : 'klientas'))}</div></div>
      <button class="btn btn-ghost btn-sm" data-um="pw">${icon('edit')}${escapeHtml(tr('Keisti slaptažodį'))}</button>
      <button class="btn btn-ghost btn-sm" data-um="out">${icon('logout')}${escapeHtml(tr('Atsijungti'))}</button>`;
    document.body.append(m);
    const r = e.currentTarget.getBoundingClientRect();
    m.style.top = `${r.bottom + 6}px`;
    m.style.right = `${Math.max(8, innerWidth - r.right)}px`;
    m.addEventListener('click', (ev) => {
      const a = ev.target.closest('[data-um]')?.dataset.um;
      if (a === 'pw') changePasswordDialog(toast);
      else if (a === 'out') logout();
      m.remove();
    });
    setTimeout(() => document.addEventListener('pointerdown', (ev) => !m.contains(ev.target) && m.remove(), { once: true }), 0);
  });
  // Klientas pradeda nuo savo srities
  if (user.role === 'client') portalUI.open();
})();

// Skydelis mažuose ekranuose
$('#btn-panel').addEventListener('click', () => $('#sidepanel').classList.toggle('open'));

// Pagalba
$('#btn-help').addEventListener('click', () => $('#dlg-help').showModal());

// ---------------------------------------------------------------------------
// Klaviatūra
// ---------------------------------------------------------------------------
const KEY_TOOLS = Object.fromEntries(Object.entries(TOOLS).filter(([, t]) => t.key).map(([id, t]) => [t.key.toLowerCase(), id]));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && loadingAbort) {
    e.preventDefault();
    return loadingAbort.abort();
  }
  if (e.target.closest('input, select, textarea') || document.querySelector('dialog[open]') || odmUI.isOpen || liveUI.isOpen || planUI.isOpen || portalUI?.isOpen) return;
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
  else if (k === 'x') runDetection();
  else if (k === 'm') toggleMap();
  else if (KEY_TOOLS[k]) tools.activate(KEY_TOOLS[k]);
});

// ---------------------------------------------------------------------------
// Kalba (LT / EN)
// ---------------------------------------------------------------------------
const langSwitch = $('#lang-switch');
const syncLangSwitch = () => {
  const l = getLang();
  langSwitch.dataset.lang = l;
  langSwitch.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lang === l)));
};
langSwitch.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-lang]');
  setLang(b ? b.dataset.lang : getLang() === 'lt' ? 'en' : 'lt');
});
onLangChange(() => {
  syncLangSwitch();
  tools._updateUI();
  if (tools.active) tools._redraw();
  redrawAll();
  updateModelInfo();
  updateScaleBadge();
  applyClip();
  odmUI.rerender();
  liveUI.rerender();
  planUI.rerender();
  portalUI?.rerender();
  if (viewer.hasModel) {
    const s = viewer.stats;
    $('#status-model').textContent = s.points ? tr('{n} taškų', { n: fmtInt(s.points) }) : tr('{n} trikampių', { n: fmtInt(s.triangles) });
  }
  if (viewer.isOrtho) orthoBtn.textContent = tr('Orto');
  gizmo._last = null;
  gizmo.update();
});
syncLangSwitch();
startI18n();

// Testams / derinimui: ?debug
if (new URLSearchParams(location.search).has('debug')) window.__atea = { viewer, units, items, settings };

// Vaizdo atnaujinimas – gizmo
viewer.addEventListener('render', () => gizmo.update());
gizmo.update();
