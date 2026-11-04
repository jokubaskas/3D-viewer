// Kontroliniai taškai (tikslumo patikra ir pataisa), mastelio kalibravimas, išlyginimas, pjūvis.
import { $, settings, viewer, basemap, items, app, toast } from './core.js';
import { units } from '../units.js';
import { t as tr } from '../i18n.js';
import { Measurement, checkpointResidual } from '../measurements.js';
import { fitPlaneNormal } from '../compute.js';
import { clearChangeLayer } from './compare-ui.js';
import { refreshMap } from './basemap-ui.js';

// ---------------------------------------------------------------------------
// Kontroliniai taškai (tikslumo patikra ir pataisa)
// ---------------------------------------------------------------------------
export function askCheckpoint(local) {
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
    app.addMeasurement(m, true);
    renderCheckpoints();
  };
}

export function checkpointStats() {
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

export function renderCheckpoints() {
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
      app.redrawAll();
      app.updateModelInfo();
      renderCheckpoints();
    }),
  );
}

export function updateScaleBadge() {
  const b = $('#scale-badge');
  b.hidden = Math.abs(units.calibration - 1) < 1e-9;
  b.textContent = `${tr('Mastelis')} ×${units.num(units.calibration, 4)}`;
}

export function level(pts) {
  const W = pts.map((p) => viewer.localToWorld(p));
  const n = fitPlaneNormal(W);
  viewer.applyLeveling(n);
  toast('Modelis išlygintas pagal pažymėtą plokštumą');
}

viewer.addEventListener('orientation', () => {
  // Pasikeitus orientacijai vertikalūs dydžiai keičiasi – perskaičiuojame
  items.forEach((it) => app.recompute(it));
  app.setupClipSliders();
  // Pakeitus aukščio ašį žemėlapis kuriamas iš naujo (arba paslepiamas, jei Z nebe aukštyn)
  if (settings.mapOn && viewer.hasModel && basemap.source?.axis !== viewer.upAxis) refreshMap(true);
  clearChangeLayer();
});

