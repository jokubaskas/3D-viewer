// Palyginimas su kita data: antras modelis, skirtumų žemėlapis, iškasta / supilta.
import { $, settings, viewer, cmp, items, state, app, toast, escapeHtml, metersToWorld } from './core.js';
import * as THREE from 'three';
import { units } from '../units.js';
import { t as tr } from '../i18n.js';
import { TOOLS } from '../measurements.js';
import { loadModelFiles } from '../loaders.js';
import { analyzeChange, buildChangeMesh } from '../compare.js';

// ---------------------------------------------------------------------------
// Palyginimas su kita data
// ---------------------------------------------------------------------------
/** Paskutinio palyginimo rezultatas (naudojamas ir PDF ataskaitoje). */
export const changeLayer = new THREE.Group();
changeLayer.name = 'change';
viewer.scene.add(changeLayer);

export function clearChangeLayer() {
  changeLayer.children.forEach((m) => {
    m.geometry.dispose();
    m.material.dispose();
  });
  changeLayer.clear();
  if (state.compareState) state.compareState.result = null;
  $('#cmp-result').hidden = true;
  viewer.requestRender();
}

export function clearCompare() {
  clearChangeLayer();
  cmp.clear();
  state.compareState = null;
  viewer.content.visible = true;
  $('#cmp-body').hidden = true;
  $('#cmp-empty').hidden = false;
}

async function openCompareFiles(files) {
  if (!files?.length) return;
  if (!viewer.hasModel) return toast('Pirmiausia atidarykite modelį', 'error');
  app.tools.deactivate();
  app.setLoading(true, tr('Įkeliamas palyginimo modelis…'), 0);
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
    state.compareState = { name: res.name, result: null };
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
    app.setLoading(false);
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
    [tr('Failas'), state.compareState.name],
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
  const ac = app.startCancellable(tr('Skaičiuojami pokyčiai…'), 0);
  try {
    const res = await analyzeChange(cmpIsOld ? cmpAt : mainAt, cmpIsOld ? mainAt : cmpAt, bounds, {
      cell, poly, threshold, signal: ac.signal,
      onProgress: (p) => ($('#loading-bar').style.width = `${Math.round(p * 100)}%`),
    });
    if (!res.area) throw new Error(tr('Pasirinktoje srityje modeliai nepersidengia.'));
    const mesh = buildChangeMesh(res, metersToWorld(0.03));
    changeLayer.add(mesh);
    changeLayer.visible = $('#cmp-show-map').checked;
    state.compareState.result = { ...res, region: region ? region.name || tr(TOOLS[region.type].label) : tr('Visa persidengianti sritis'), cmpIsOld, range: mesh.userData.range, density: settings.density };
    renderCompareResult();
    viewer.requestRender();
  } catch (e) {
    if (app.isAbort(e)) toast('Skaičiavimas atšauktas');
    else toast(e.message || String(e), 'error', 8000);
  } finally {
    app.setLoading(false);
  }
}

/** Pokyčių eilutės (UI ir PDF ataskaitai). */
export function compareRows(r = state.compareState?.result) {
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
  const r = state.compareState?.result;
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

