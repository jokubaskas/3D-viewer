import './style.css';
import * as THREE from 'three';
import { loadModelFiles } from './loaders.js';
import { createDemoModel } from './demo.js';
import { units } from './units.js';
import { hydrateIcons, icon } from './icons.js';
import { logoSvg } from './logo.js';
import { t as tr, getLang, setLang, onLangChange, startI18n, locale } from './i18n.js';
import { TOOLS, BASE_MODES, Measurement, MeasurementVisual, computeMeasurement, describe, quickData } from './measurements.js';
import { createOdmUI } from './odm/ui.js';
import { createLiveUI } from './live/ui.js';
import { createPlanUI } from './plan/ui.js';
import { createOrthoUI } from './ortho/ui.js';
import { createSplatUI } from './splat/ui.js';
import { extractFromZipUrl, fetchDirect, DIRECT_MODEL, DIRECT_POINTS, WANT_MODEL, WANT_MODEL_GLB, WANT_POINTS } from './odm/results.js';
import { whoAmI } from './portal/api.js';
import { showLogin, showInvite, showDown, changePasswordDialog, logout } from './portal/auth.js';
import { createPortalUI } from './portal/ui.js';
import { createHome } from './portal/home.js';
import { createOrdersUI } from './portal/orders.js';
import { api } from './portal/api.js';
import { $, $$, settings, saveSettings, viewport, viewer, gizmo, basemap, profile, items, state, app, toast, download, baseName, escapeHtml } from './app/core.js';
import { screenshot } from './app/screenshot.js';
import { syncSaveCard, openOdmSaveDialog } from './app/save.js';
import { aiClient, aiOutline, runDetection, exportDetectionsCsv } from './app/ai-tools.js';
import { askCheckpoint, level, renderCheckpoints, updateScaleBadge } from './app/checkpoints.js';
import { clearCompare } from './app/compare-ui.js';
import { refreshMap, toggleMap } from './app/basemap-ui.js';
import { attachSplatLayer, detachSplatLayer, toggleSplatLayer } from './app/splat-layer.js';
import './app/measure-io.js';
import './app/report-ui.js';

// main.js funkcijos, kurias kviečia moduliai (src/app/*)
Object.assign(app, { addMeasurement, recompute, redrawAll, setupClipSliders, updateModelInfo, modelInfoRows, setLoading, isAbort, startCancellable });



// ---------------------------------------------------------------------------
// Pagrindiniai objektai
// ---------------------------------------------------------------------------
hydrateIcons();
$('#brand-logo').innerHTML = logoSvg();


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
$('#help-version').textContent = `Atea 3D Matuoklis · ${tr('versija')} ${__APP_VERSION__}`;
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
app.tools = tools;

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
  if (select) state.selectedId = m.id;
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
  if (m.type === 'profile' && (state.selectedId === m.id || !profile.current)) profile.show(m);
}

function redrawItem(it) {
  const desc = describe(it.m, viewer, units, settings);
  it.visual.update(it.m, { selected: it.m.id === state.selectedId, desc, showName: false });
}

function redrawAll() {
  items.forEach(redrawItem);
  renderList();
  if (profile.current) profile.render();
  viewer.requestRender();
}

function selectMeasurement(id, focus = false) {
  state.selectedId = id;
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
  if (state.selectedId === id) state.selectedId = null;
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
    el.className = `m-item${m.id === state.selectedId ? ' selected' : ''}${m.visible ? '' : ' hidden-m'}`;
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
function isAbort(e) {
  return e?.name === 'AbortError';
}
$('#loading-cancel').addEventListener('click', () => loadingAbort?.abort());

function guessUp(object, suggested) {
  if (suggested) return suggested;
  const s = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  return s.z <= s.y ? 'z' : 'y';
}

let lastOpenedFiles = null; // portalui: „Įkelti dabar atidarytą modelį“
async function openFiles(fileList, opts = {}) {
  if (!fileList || !fileList.length) return;
  // Kopija iškart: kvietėjas po to išvalo <input type=file>, o tada tas pats FileList ištuštėja
  const files = Array.from(fileList);
  // Vienas GeoTIFF – ortofoto žemėlapis (ne 3D modelis)
  if (files.length === 1 && /\.tiff?$/i.test(files[0].name)) {
    openOrthoPage({ src: files[0], name: files[0].name.replace(/\.tiff?$/i, ''), downloadName: files[0].name, canUpload: !!orthoApp.uploadToPortal });
    return;
  }
  tools.deactivate();
  state.odmProject = null;
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
    lastOpenedFiles = opts.remote ? null : files;
  } catch (err) {
    console.error(err);
    toast(tr('Nepavyko atidaryti: {e}', { e: err.message || err }), 'error', 7000);
  } finally {
    setLoading(false);
  }
}

async function showModel(object, offset, up, name, format, { crs = null, heightSystem = null } = {}) {
  detachSplatLayer();
  clearMeasurements();
  units.calibration = 1;
  $('#opt-scale').value = 1;
  updateScaleBadge();
  await viewer.setModel(object, offset, up, (t) => ($('#loading-text').textContent = t), { crs, heightSystem });
  renderCheckpoints();
  viewer.setViewMode(settings.viewMode);
  state.modelInfo = { name, format };
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
    ['Failas', state.modelInfo?.name || '—'],
    ['Formatas', state.modelInfo?.format || '—'],
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
// Eksportas / importas
// ---------------------------------------------------------------------------

$('#btn-clear').addEventListener('click', () => {
  if (!items.length) return;
  if (confirm(tr('Ištrinti visus matavimus ({n})?', { n: items.length }))) clearMeasurements();
});

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
  /** ODM ortofoto: skaitomas dalimis tiesiai iš serverio; jei serveris taip neatiduoda – išimamas iš all.zip. */
  async openOrtho(project) {
    const safe = project.name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'projektas';
    const base = { name: project.name, downloadName: `${safe}_ortofoto.tif`, canUpload: !!orthoApp.uploadToPortal };
    if (await openOrthoPage({ ...base, src: project.orthoUrl, downloadUrl: project.orthoUrl }, { quiet: true })) return true;
    setLoading(true, tr('Atsisiunčiami rezultatai…'), 0);
    try {
      const files = await extractFromZipUrl(project.downloadUrl, (p) => p === 'odm_orthophoto/odm_orthophoto.tif', (p, bytes) => {
        $('#loading-bar').style.width = `${Math.round(p * 100)}%`;
        $('#loading-text').textContent = `${tr('Atsisiunčiami rezultatai…')} ${(bytes / 1e6).toFixed(0)} MB`;
      });
      setLoading(false);
      if (!files.length) throw new Error(tr('Šiame projekte ortofoto nėra (galbūt išjungtas kuriant projektą).'));
      return await openOrthoPage({ ...base, src: files[0] });
    } catch (e) {
      setLoading(false);
      orthoUI.close();
      toast(tr('Nepavyko atidaryti ortofoto: {e}', { e: e.message }), 'error', 9000);
      return false;
    }
  },
  saveResults(project) {
    openOdmSaveDialog(project);
  },
  /** Realistiškas vaizdas (Gaussian Splatting) – atskiras puslapis. */
  openSplat(o) {
    closePages();
    return splatUI.open(o);
  },
  async openResult(project, kind) {
    tools.deactivate();
    setLoading(true, 'Atsisiunčiami rezultatai…', 0);
    try {
      const progress = (p, bytes) => {
        $('#loading-bar').style.width = `${Math.round(p * 100)}%`;
        $('#loading-text').textContent = `${tr('Atsisiunčiami rezultatai…')} ${(bytes / 1e6).toFixed(0)} MB`;
      };
      // Pirmiausia – tik reikalingi failai tiesiai iš serverio (dešimtys MB vietoj kelių GB all.zip)
      let files = await fetchDirect(project.filesUrl, kind === 'points' ? DIRECT_POINTS : DIRECT_MODEL, progress);
      if (!files) files = await extractFromZipUrl(project.downloadUrl, kind === 'points' ? WANT_POINTS : WANT_MODEL_GLB, progress);
      if (kind !== 'points' && !files.some((f) => /\.glb$/i.test(f.name))) files = await extractFromZipUrl(project.downloadUrl, WANT_MODEL, progress);
      if (!files.some((f) => /\.(obj|glb|laz|las)$/i.test(f.name))) throw new Error(tr(kind === 'points' ? 'Archyve nerasta taškų debesies' : 'Archyve nerastas 3D modelis'));
      setLoading(false);
      await openFiles(files, { heightSystem: project.heightSystem, name: project.name });
      if (viewer.hasModel) {
        state.odmProject = project;
        syncSaveCard();
        // Realistiškas sluoksnis (splatai), jei šiam projektui apmokytas – rodomas iš karto, matavimai ant modelio
        if (kind !== 'points' && project.splatUrl && (await attachSplatLayer(project.splatUrl)))
          toast(tr('Rodomas realistiškas vaizdas. Matavimai – ant 3D modelio. Perjungti: G arba skydelis „Modelis“.'), 'info', 7000);
      }
    } catch (e) {
      setLoading(false);
      toast(tr('Nepavyko atidaryti rezultatų: {e}', { e: e.message }), 'error', 8000);
    }
  },
});
const openOdm = () => (liveUI.close(), planUI.close(), orthoUI.close(), splatUI.close(), portalUI?.close(), ordersUI?.close(), homeUI?.close(), odmUI.open());
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
  ordersUI?.close();
  orthoUI.close();
  homeUI?.close();
  liveUI.open();
});

// ---------------------------------------------------------------------------
// Skrydžio planas
// ---------------------------------------------------------------------------
const planUI = createPlanUI({ toast });

// ---------------------------------------------------------------------------
// Ortofoto žemėlapis (GeoTIFF): peržiūra, matavimai; administratoriui – įkėlimas į portalą
// ---------------------------------------------------------------------------
const orthoApp = { toast, uploadToPortal: null };
const orthoUI = createOrthoUI(orthoApp);
const splatUI = createSplatUI({ toast });
function openOrthoPage(o, opts) {
  if (odmUI.isOpen) odmUI.close();
  liveUI.close();
  planUI.close();
  portalUI?.close();
  ordersUI?.close();
  homeUI?.close();
  return orthoUI.open(o, opts);
}
$('#btn-plan').addEventListener('click', () => {
  if (planUI.isOpen) return planUI.close();
  if (odmUI.isOpen) odmUI.close();
  liveUI.close();
  portalUI?.close();
  ordersUI?.close();
  orthoUI.close();
  homeUI?.close();
  planUI.open();
});

// ---------------------------------------------------------------------------
// Portalas: paskyros (admin / klientas) ir „Mano sritis“. Teises tikrina serveris – čia tik sąsaja.
// ---------------------------------------------------------------------------
let portalUI = null;
let homeUI = null;
let ordersUI = null;
/** Uždaro visus puslapius (lieka 3D peržiūra). */
const closePages = () => {
  if (odmUI.isOpen) odmUI.close();
  splatUI.close();
  liveUI.close();
  planUI.close();
  portalUI?.close();
  ordersUI?.close();
  orthoUI.close();
  homeUI?.close();
};
(async () => {
  // Įkėlimo užsklanda (index.html) nuimama, kai aišku, ką rodyti; atsarginis laikmatis – jei kas nors užstrigtų
  const booted = () => document.documentElement.classList.remove('booting');
  setTimeout(booted, 15000);
  const invite = /#invite=([\w-]+)/.exec(location.hash)?.[1];
  if (invite) return booted(), showInvite(invite);
  const who = await whoAmI();
  if (who.mode === 'login') return booted(), showLogin();
  if (who.mode === 'down') return booted(), showDown();
  if (who.mode !== 'user') return booted(); // be serverio (iš disko) – kaip anksčiau
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
    openOrtho: (o) => openOrthoPage(o),
    toLks94: user.role === 'admin' ? async (blob, name) => (await aiClient()).toLks94(blob, name) : undefined,
  });
  if (user.role === 'admin') orthoApp.uploadToPortal = (o) => portalUI.publishOrtho(o);
  liveUI.setPortal({ role: user.role, portal: portalUI });
  const admin = user.role === 'admin';
  const portalTab = (tab) => () => (closePages(), portalUI.open(tab));
  ordersUI = createOrdersUI({ user, toast, openResult: (it) => portalTab(it.kind)() });
  const openOrders = () => (closePages(), ordersUI.open());
  // Pradžios ekranas: dideli mygtukai pagal teises
  const tiles = admin
    ? [
        { id: 'orders', icon: 'order', title: 'Užsakymai', desc: 'Klientų užsakymai žemėlapyje, būsena ir žinutės', run: openOrders },
        { id: 'model', icon: 'cube', title: '3D modeliai', desc: 'Peržiūra, matavimai, įkėlimas ir priskyrimas klientams', run: portalTab('model') },
        { id: 'viewer', icon: 'ruler', title: 'Atidaryti iš kompiuterio', desc: 'OBJ, GLB, PLY, LAS ir kt. failai matavimams', run: () => (closePages(), openDialog()) },
        { id: 'odm', icon: 'camera', title: 'Kurti 3D iš nuotraukų', desc: 'OpenDroneMap apdorojimas šiame kompiuteryje', run: () => (closePages(), odmUI.open()) },
        { id: 'plan', icon: 'map', title: 'Skrydžio planas', desc: 'Maršrutas, aukštis pagal GSD, eksportas į pultą', run: () => (closePages(), planUI.open()) },
        { id: 'stream', icon: 'live', title: 'Gyvos transliacijos', desc: 'Dronai, kameros, AI aptikimas, įrašai, diab', run: () => (closePages(), liveUI.open()) },
        { id: 'ortho', icon: 'layers', title: 'Ortofoto žemėlapiai', desc: 'Peržiūra, matavimai ir priskyrimas klientams', run: portalTab('ortho') },
        { id: 'report', icon: 'report', title: 'Ataskaitos', desc: 'Klientams skirtos ataskaitos', run: portalTab('report') },
        { id: 'recording', icon: 'record', title: 'Įrašai', desc: 'AI įrašai ir vaizdo medžiaga klientams', run: portalTab('recording') },
        { id: 'clients', icon: 'user', title: 'Klientai', desc: 'Paskyros, kvietimai ir prieigos', run: portalTab('clients') },
      ]
    : [
        { id: 'orders', icon: 'order', title: 'Užsakyti darbą', desc: 'Pažymėkite teritoriją žemėlapyje ir aprašykite, ko reikia', run: openOrders },
        { id: 'model', icon: 'cube', title: 'Mano 3D modeliai', desc: 'Peržiūra ir matavimai', run: portalTab('model') },
        { id: 'stream', icon: 'live', title: 'Mano gyvos transliacijos', desc: 'Tiesioginis vaizdas ir AI aptikimas', run: () => (closePages(), liveUI.open()) },
        { id: 'ortho', icon: 'layers', title: 'Mano ortofoto žemėlapiai', desc: 'Žemėlapio peržiūra ir matavimai', run: portalTab('ortho') },
        { id: 'report', icon: 'report', title: 'Mano ataskaitos', desc: 'Peržiūra ir atsisiuntimas', run: portalTab('report') },
        { id: 'recording', icon: 'record', title: 'Mano įrašai', desc: 'Vaizdo įrašai ir duomenys', run: portalTab('recording') },
      ];
  homeUI = createHome({
    user,
    tiles,
    counts: async () => {
      const [items, users, oc] = await Promise.all([api('items'), admin ? api('users') : Promise.resolve([]), ordersUI.counts().catch(() => null)]);
      const c = {};
      for (const i of items) c[i.kind] = (c[i.kind] || 0) + 1;
      if (admin) c.clients = users.filter((u) => u.role === 'client').length;
      // Užsakymai: su naujienomis – paryškintas skaičius, kitaip – kiek iš viso
      if (oc?.unread) c.orders = { n: oc.unread, title: 'Yra naujienų' };
      else if (oc?.total) c.orders = oc.total;
      return c;
    },
  });
  const goHome = () => (closePages(), homeUI.open());
  // Nuoroda iš laiško: #order=N – iškart atidaromas užsakymas
  const orderLink = /#order=(\d+)/.exec(location.hash)?.[1];
  if (orderLink) {
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(() => (closePages(), ordersUI.open(+orderLink)));
  }
  $('#btn-portal').addEventListener('click', goHome);
  // Puslapių „×“ → „← Pradžia“ (puslapio kairėje, kaip pradžios ekrano navigacija)
  document.querySelectorAll('.odm-page .odm-head').forEach((head) => {
    const x = head.querySelector('[data-act=close], [data-pa=close]');
    if (!x) return;
    x.className = 'btn btn-outline btn-sm head-back';
    x.innerHTML = `${icon('back')}<span>${escapeHtml(tr('Pradžia'))}</span>`;
    head.prepend(x);
  });
  $('#btn-portal-2').addEventListener('click', portalTab('model'));
  $('#brand-logo').closest('.brand').addEventListener('click', goHome);
  // Puslapio „Uždaryti“ (×) – grįžtama į pradžią
  document.addEventListener('click', (e) => {
    if (e.target.closest('.odm-page [data-act=close], .portal-page [data-pa=close]')) setTimeout(() => !odmUI.isOpen && !liveUI.isOpen && !planUI.isOpen && !portalUI.isOpen && !ordersUI.isOpen && !orthoUI.isOpen && homeUI.open());
  });
  $('#btn-user').addEventListener('click', (e) => {
    const old = document.querySelector('.user-menu');
    if (old) return old.remove();
    const m = document.createElement('div');
    m.className = 'user-menu';
    m.innerHTML = `<div class="small"><b>${escapeHtml(user.name || user.email)}</b><div class="muted">${escapeHtml(user.email)} · ${escapeHtml(tr(user.role === 'admin' ? 'administratorius' : 'klientas'))}</div></div>
      <button class="btn btn-ghost btn-sm" data-um="notify" aria-pressed="${user.notify !== false}">${icon(user.notify !== false ? 'check' : 'close')}${escapeHtml(tr(user.notify !== false ? 'Pranešimai el. paštu: įjungti' : 'Pranešimai el. paštu: išjungti'))}</button>
      <button class="btn btn-ghost btn-sm" data-um="pw">${icon('edit')}${escapeHtml(tr('Keisti slaptažodį'))}</button>
      <button class="btn btn-ghost btn-sm" data-um="out">${icon('logout')}${escapeHtml(tr('Atsijungti'))}</button>
      <div class="small muted" style="padding:2px 4px">${escapeHtml(tr('versija'))} ${escapeHtml(__APP_VERSION__)}</div>`;
    document.body.append(m);
    const r = e.currentTarget.getBoundingClientRect();
    m.style.top = `${r.bottom + 6}px`;
    m.style.right = `${Math.max(8, innerWidth - r.right)}px`;
    m.addEventListener('click', (ev) => {
      const a = ev.target.closest('[data-um]')?.dataset.um;
      if (a === 'notify')
        api('me', { method: 'PATCH', body: { notify: user.notify === false } })
          .then((u) => {
            user.notify = u.notify;
            toast(tr(u.notify ? 'Pranešimai el. paštu įjungti' : 'Pranešimai el. paštu išjungti'));
          })
          .catch((ex) => toast(ex.message, 'error'));
      else if (a === 'pw') changePasswordDialog(toast);
      else if (a === 'out') logout();
      m.remove();
    });
    // Meniu uždaromas paspaudus bet kur kitur (klausytojas pašalinamas kartu su meniu)
    const outside = (ev) => {
      if (m.contains(ev.target) || ev.target.closest('#btn-user')) return;
      m.remove();
    };
    new MutationObserver((_, obs) => !m.isConnected && (document.removeEventListener('pointerdown', outside, true), obs.disconnect())).observe(document.body, { childList: true });
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  });
  homeUI.open();
  booted();
})();

// Ar atidarytas kuris nors puslapis (ne 3D peržiūra) – antraštėje tada nerodomi 3D peržiūros mygtukai
{
  const sync = () => document.body.classList.toggle('page-open', [...document.querySelectorAll('.odm-page, .home-page')].some((p) => !p.hidden));
  new MutationObserver(sync).observe(document.getElementById('app'), { attributes: true, subtree: true, attributeFilter: ['hidden'], childList: true });
  sync();
}

// Šoninių stulpelių kortelės sutraukiamos (antraštė – mygtukas); būsena įsimenama
{
  const LS_CARDS = 'atea3d.cards';
  const DEFAULT_CLOSED = ['live:diab', 'live:train', 'live:push', 'plan:saved', 'odm:server'];
  let state = {};
  try {
    state = JSON.parse(localStorage.getItem(LS_CARDS)) || {};
  } catch { /* nebūtina */ }
  const pageKey = (el) => (el.closest('.live-page') ? 'live' : el.closest('.plan-page') ? 'plan' : 'odm');
  const setup = (card) => {
    if (card.dataset.collapsible) return;
    card.dataset.collapsible = '1';
    const key = `${pageKey(card)}:${card.dataset.card}`;
    card.classList.add('collapsible');
    card.classList.toggle('collapsed', state[key] ?? DEFAULT_CLOSED.includes(key));
    card.querySelector(':scope > h3')?.addEventListener('click', () => {
      state[key] = card.classList.toggle('collapsed');
      try {
        localStorage.setItem(LS_CARDS, JSON.stringify(state));
      } catch { /* nebūtina */ }
    });
  };
  document.querySelectorAll('.odm-side section.card[data-card]').forEach(setup);
}

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
  if (e.target.closest('input, select, textarea') || document.querySelector('dialog[open]') || odmUI.isOpen || liveUI.isOpen || planUI.isOpen || portalUI?.isOpen || ordersUI?.isOpen || orthoUI.isOpen || splatUI.isOpen || homeUI?.isOpen) return;
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
  } else if (k === 'delete' && state.selectedId != null) removeMeasurement(state.selectedId);
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
  else if (k === 'g') toggleSplatLayer();
  else if (KEY_TOOLS[k]) tools.activate(KEY_TOOLS[k]);
});

// ---------------------------------------------------------------------------
// Tema (tamsi / šviesi) – kaip kalbos perjungiklis, įsimenama naršyklėje
// ---------------------------------------------------------------------------
const themeSwitch = $('#theme-switch');
function applyTheme(th) {
  document.documentElement.dataset.theme = th;
  themeSwitch.dataset.theme = th;
  themeSwitch.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeSet === th)));
  viewer.setTheme?.(th);
  try {
    localStorage.setItem('atea3d.theme', th);
  } catch { /* privatus režimas */ }
}
themeSwitch.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-theme-set]');
  applyTheme(b ? b.dataset.themeSet : document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});
applyTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

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
  ordersUI?.rerender();
  orthoUI.rerender();
  homeUI?.rerender();
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
if (new URLSearchParams(location.search).has('debug')) window.__atea = { viewer, units, items, settings, ortho: orthoUI };

// Vaizdo atnaujinimas – gizmo
viewer.addEventListener('render', () => gizmo.update());
gizmo.update();
