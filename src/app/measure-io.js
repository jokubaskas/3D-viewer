// Matavimų eksportas (CSV), išsaugojimas ir įkėlimas (JSON).
import { $, $$, settings, viewer, items, state, app, toast, download, baseName, stamp } from './core.js';
import * as THREE from 'three';
import { units } from '../units.js';
import { t as tr } from '../i18n.js';
import { TOOLS, Measurement, describe, setNextId } from '../measurements.js';
import { updateScaleBadge } from './checkpoints.js';

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
    app: 'Atea 3D Matuoklis', version: 1, model: state.modelInfo?.name, created: new Date().toISOString(),
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
      app.addMeasurement(m);
      n++;
    }
    setNextId(items.length + 1);
    if (state.modelInfo?.name && data.model && data.model !== state.modelInfo.name) toast(tr('Dėmesio: matavimai buvo atlikti modeliui „{m}“', { m: data.model }), 'error', 6000);
    toast(tr('Įkelta matavimų: {n}', { n }));
  } catch (err) {
    toast(tr('Nepavyko įkelti: {e}', { e: err.message }), 'error');
  }
});

