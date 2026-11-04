// PDF ataskaitos langas ir turinio paruošimas (src/report/report.js).
import { $, settings, saveSettings, viewer, items, state, app, toast, download, baseName, stamp } from './core.js';
import { units } from '../units.js';
import { t as tr, locale } from '../i18n.js';
import { TOOLS, describe, checkpointResidual } from '../measurements.js';
import { AI_CLASSES } from '../ai/client.js';
import { detectionTable } from './ai-tools.js';
import { checkpointStats } from './checkpoints.js';
import { compareRows, changeLayer } from './compare-ui.js';

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
    change: !!state.compareState?.result,
    checkpoints: !!checkpointStats(),
    ai: ms.some((i) => i.m.type === 'detections' && i.m.options.items?.length),
  };
}

function openReportDialog() {
  if (!viewer.hasModel) return toast('Pirmiausia atidarykite modelį', 'error');
  app.tools.deactivate();
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
  const r = state.compareState?.result;
  if (r) {
    const g = r.grid;
    change = {
      rows: compareRows(r),
      range: r.range,
      fmtLen: (v) => units.fmtLen(v),
      oldName: r.cmpIsOld ? state.compareState.name : state.modelInfo?.name,
      newName: r.cmpIsOld ? state.modelInfo?.name : state.compareState.name,
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
    viewer, units, t: tr, changeLayer: changeLayer,
    meta: { title, object, author, notes, date },
    sections, labels, measurements, change, checkpoints, detections,
    modelRows: app.modelInfoRows(true),
  };
}

async function makeReport(opts) {
  app.setLoading(true, tr('Kuriama PDF ataskaita…'), 0.05);
  try {
    const { createReport } = await import('../report/report.js');
    const blob = await createReport(reportContext(opts), (t) => ($('#loading-text').textContent = t));
    const safe = opts.object.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'ataskaita';
    download(`${safe}_ataskaita_${stamp()}.pdf`, blob);
    toast('PDF ataskaita sukurta');
  } catch (e) {
    console.error(e);
    toast(tr('Nepavyko sukurti ataskaitos: {e}', { e: e.message || e }), 'error', 9000);
  } finally {
    app.setLoading(false);
  }
}

$('#btn-report').addEventListener('click', openReportDialog);

