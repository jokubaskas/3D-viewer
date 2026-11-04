// Vietinis dirbtinis intelektas (deploy/ai): išmanus kontūras, transporto aptikimas, AI nustatymai.
import { $, settings, saveSettings, viewer, items, app, toast, download, baseName, stamp, metersToWorld } from './core.js';
import * as THREE from 'three';
import { units } from '../units.js';
import { t as tr } from '../i18n.js';
import { TOOLS, Measurement } from '../measurements.js';
import { AiClient, AI_CLASSES } from '../ai/client.js';
import { findLocalServer } from '../local-server.js';
import { renderTopDown } from '../ai/ortho.js';

// ---------------------------------------------------------------------------
// Vietinis dirbtinis intelektas (deploy/ai): išmanus kontūras ir transporto aptikimas
// ---------------------------------------------------------------------------
const defaultAiUrl = () => (location.protocol === 'file:' ? 'http://localhost:8080/ai/' : './ai/');
export async function aiClient(recheck = false) {
  if (settings.aiUrl) return new AiClient(settings.aiUrl);
  const local = await findLocalServer(recheck);
  if (local && $('#ai-url').value === defaultAiUrl()) $('#ai-url').value = local + 'ai/';
  return new AiClient(local ? local + 'ai/' : defaultAiUrl());
}

export async function aiOutline(local) {
  const P = viewer.localToWorld(local);
  const box = viewer.worldBox;
  const ext = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
  let S = Math.min(ext * 1.05, metersToWorld(80));
  const ac = app.startCancellable(tr('AI ieško objekto kontūro…'), 0.3);
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
      app.addMeasurement(m, true);
      toast(tr('AI kontūras sukurtas ({n} taškų). Jei reikia – spustelėkite kitoje objekto vietoje.', { n: pts.length }));
      return;
    }
  } catch (e) {
    if (app.isAbort(e)) toast('AI skaičiavimas atšauktas');
    else toast(e.message, 'error', 9000);
  } finally {
    app.setLoading(false);
  }
}

export async function runDetection() {
  if (!viewer.hasModel) return toast('Pirmiausia atidarykite modelį', 'error');
  app.tools.deactivate();
  const classes = settings.aiClasses.length ? settings.aiClasses : ['car', 'truck', 'bus'];
  const box = viewer.worldBox;
  const ac = app.startCancellable(tr('Ruošiamas vaizdas iš viršaus…'), 0.1);
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
    app.addMeasurement(m, true);
    const skipped = (res.rejected || 0) + flat;
    toast(
      tr('AI rado objektų: {n} (per {s} s)', { n: itemsOut.length, s: res.seconds }) +
        (skipped ? ' · ' + tr('atmesta netinkamo dydžio ar plokščių: {n}', { n: skipped }) : ''),
    );
    if (gsdM > 0.15) toast(tr('Modelis didelis – vaizdo raiška {g} cm/px, maži objektai gali būti praleisti.', { g: (gsdM * 100).toFixed(0) }), 'info', 8000);
  } catch (e) {
    if (app.isAbort(e)) toast('AI skaičiavimas atšauktas');
    else toast(e.message, 'error', 9000);
  } finally {
    app.setLoading(false);
  }
}

export function detectionTable(m) {
  const names = viewer.coordRows(new THREE.Vector3(...m.options.items[0].c), units, settings.coordOrder).map(([k]) => k.split(' ')[0]);
  const rows = [[tr('Nr.'), tr('Klasė'), tr('Patikimumas'), ...names.map((n) => `${n} (${units.display})`), tr('Ilgis (m)'), tr('Plotis (m)'), tr('Aukštis (m)'), tr('Kryptis (°)')]];
  m.options.items.forEach((it, i) => {
    const cr = viewer.coordRows(new THREE.Vector3(...it.c), units, settings.coordOrder);
    rows.push([i + 1, tr(AI_CLASSES[it.cls]?.lt || it.cls), units.num(it.score * 100, 0) + ' %', ...cr.map(([, v]) => units.num(v, 3)), ...(it.size ? [units.num(it.size[1], 2), units.num(it.size[0], 2)] : ['', '']), it.height != null ? units.num(it.height, 2) : '', it.heading != null ? units.num(it.heading, 0) : '']);
  });
  return rows;
}

export function exportDetectionsCsv(m) {
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

