// Išsaugojimas kompiuteryje: 3D modelis (OBJ / GLB / LAS) ir ODM rezultatai (ortofoto, DSM, DTM, taškai).
import { $, $$, settings, saveSettings, viewer, state, app, toast, download, baseName } from './core.js';
import { units } from '../units.js';
import { t as tr } from '../i18n.js';
import { exportObjZip, exportGlb, exportLas } from '../export.js';
import { extractFromZipUrl, fetchDirect, WANT_MODEL, WANT_MODEL_GLB } from '../odm/results.js';
import { aiClient } from './ai-tools.js';

// ---------------------------------------------------------------------------
// Išsaugojimas kompiuteryje: 3D modelis (OBJ / GLB / LAS) ir ODM rezultatai (ortofoto, DSM, DTM…)
// ---------------------------------------------------------------------------

export function syncSaveCard() {
  const has = viewer.hasModel;
  $$('#save-card [data-save]').forEach((b) => (b.disabled = !has));
  $('#save-card [data-save=las]').hidden = !viewer.pointClouds.length;
  $('#save-card [data-save=obj]').hidden = !viewer.meshes.length && viewer.pointClouds.length > 0;
  $('#save-odm').hidden = !state.odmProject;
  if (state.odmProject) $('#save-odm-name').textContent = state.odmProject.name;
}

async function saveModel(kind) {
  if (!viewer.hasModel) return toast('Pirmiausia atidarykite modelį', 'error');
  const name = baseName().replace(/[\\/:*?"<>|\s]+/g, '_') || 'modelis';
  const crsTag = viewer.crs?.id === 'LKS94' ? '_LKS94' : viewer.crs?.id ? `_${viewer.crs.id}` : '';
  app.setLoading(true, tr('Ruošiamas failas…'), 0.1);
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
    app.setLoading(false);
  }
}
$$('#save-card [data-save]').forEach((b) => b.addEventListener('click', () => saveModel(b.dataset.save)));

const ODM_FILES = {
  ortho: { path: 'odm_orthophoto/odm_orthophoto.tif', label: 'ortofoto', raster: true },
  dsm: { path: 'odm_dem/dsm.tif', label: 'DSM', raster: true },
  dtm: { path: 'odm_dem/dtm.tif', label: 'DTM', raster: true },
  laz: { path: 'odm_georeferencing/odm_georeferenced_model.laz', label: 'taskai', ext: 'laz' },
};

/** Atsisiunčia vieną ODM rezultatą (tiesiai iš serverio, kitaip iš all.zip srautu); rastrus pagal pasirinkimą perskaičiuoja į LKS-94. */
async function saveOdmResult(project, kind, crs) {
  const safe = project.name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'projektas';
  if (kind === 'all') {
    const a = document.createElement('a');
    a.href = project.downloadUrl;
    a.download = `${safe}_all.zip`;
    a.click();
    return;
  }
  const ac = app.startCancellable(tr('Atsisiunčiami rezultatai…'), 0);
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
    const files = (await fetchDirect(project.filesUrl, [def.path], progress, signal)) || (await extractFromZipUrl(project.downloadUrl, (p) => p === def.path, progress, signal));
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
    if (app.isAbort(e)) toast('Atsisiuntimas atšauktas');
    else toast(tr('Nepavyko: {e}', { e: e.message || e }), 'error', 9000);
  } finally {
    app.setLoading(false);
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
bindOdmButtons($('#save-odm'), () => state.odmProject);
let dialogProject = null;
bindOdmButtons($('#dlg-odm-save'), () => {
  $('#dlg-odm-save').close();
  return dialogProject;
});
syncSaveCard();
export function openOdmSaveDialog(project) {
  dialogProject = project;
  $('#dlg-odm-save-name').textContent = project.name;
  if (settings.saveCrs) $('#dlg-odm-save .save-crs').value = settings.saveCrs;
  $('#dlg-odm-save').showModal();
}

