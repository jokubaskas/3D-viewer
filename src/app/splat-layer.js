// Realistiškas sluoksnis 3D peržiūroje: ODM projekto splatai (Gaussian Splatting) rodomi kartu su 3D modeliu.
// Splatai ir modelis – tame pačiame rėme (ODM vietinės koordinatės); modelis programoje perskaičiuojamas į LKS-94,
// tas pats perskaičiavimas splatams pritaikomas matrica (object.userData.odmToLocal). Splatai prikabinami prie modelio
// šakninio objekto – paveldi centravimą, orientaciją ir išlyginimą.
// Režimai: „Modelis“ – kaip įprasta; „Realistiškas“ – matomi splatai, modelis nematomas, bet matavimai (spinduliai)
// vyksta ant jo; tarpinės vertės – modelis permatomas virš splatų.
import { $, viewer, toast } from './core.js';
import { t } from '../i18n.js';

let layer = null; // { mesh, spark, model }
let mix = 1; // 0 – tik modelis, 1 – tik realistiškas

function apply() {
  if (!layer) return;
  // Spark piešia splatus per SparkRenderer objektą scenoje – jį ir slepiame (SplatMesh.visible nepakanka)
  const show = mix > 0.01;
  layer.spark.visible = show;
  layer.mesh.visible = show;
  viewer.setModelOpacity(1 - mix);
  viewer.continuous = true; // ir paslėpus – Spark atnaujina sceną kitame kadre (1,5 s po pakeitimo)
  viewer.requestRender();
  const card = $('#splat-layer-card');
  const vb = $('#btn-splat-layer');
  vb.hidden = false;
  vb.classList.toggle('active', mix >= 0.5);
  if (card) {
    card.querySelectorAll('[data-sl]').forEach((b) => b.classList.toggle('active', (b.dataset.sl === 'model' && mix <= 0.01) || (b.dataset.sl === 'splat' && mix >= 0.99)));
    $('#splat-layer-mix').value = Math.round(mix * 100);
  }
}

/** Atjungia sluoksnį (naujas modelis, uždarymas). */
export function detachSplatLayer() {
  if (!layer) return;
  layer.mesh.parent?.remove(layer.mesh);
  layer.mesh.dispose?.();
  layer.spark.parent?.remove(layer.spark);
  layer.spark.dispose?.();
  layer = null;
  viewer.continuous = false;
  viewer.setModelOpacity(1);
  const card = $('#splat-layer-card');
  if (card) card.hidden = true;
  $('#btn-splat-layer').hidden = true;
}

/**
 * Prijungia realistišką sluoksnį prie dabar atidaryto (ODM) modelio.
 * @param {string} url scene.spz
 */
export async function attachSplatLayer(url) {
  detachSplatLayer();
  const model = viewer.model;
  if (!model) return false;
  const M = model.userData.odmToLocal;
  if (!M) return false; // ne ODM modelis – rėmas nežinomas
  const card = $('#splat-layer-card');
  if (card) {
    card.hidden = false;
    $('#splat-layer-status').textContent = t('Įkeliamas realistiškas vaizdas…');
  }
  try {
    const { SparkRenderer, SplatMesh } = await import('@sparkjsdev/spark');
    if (viewer.model !== model) return false;
    const spark = new SparkRenderer({ renderer: viewer.renderer });
    viewer.scene.add(spark);
    const mesh = new SplatMesh({ url });
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(M);
    model.add(mesh);
    layer = { mesh, spark, model };
    await mesh.initialized;
    if (layer?.mesh !== mesh) return false;
    model.updateMatrixWorld(true);
    if (card) $('#splat-layer-status').textContent = t('Matavimai – ant 3D modelio (tikslūs), vaizdas – realistiškas.');
    mix = 1;
    apply();
    return true;
  } catch (e) {
    detachSplatLayer();
    toast(t('Nepavyko įkelti realistiško vaizdo: {e}', { e: e.message || e }), 'error', 8000);
    return false;
  }
}

export const hasSplatLayer = () => !!layer;

// Valdymas (kortelė „Realistiškas vaizdas“ skydelyje „Modelis“)
$('#splat-layer-card')?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sl]');
  if (!b || !layer) return;
  mix = b.dataset.sl === 'model' ? 0 : 1;
  apply();
});
/** Greitas perjungimas (mygtukas peržiūroje, klavišas R). */
export function toggleSplatLayer() {
  if (!layer) return;
  mix = mix >= 0.5 ? 0 : 1;
  apply();
}
$('#btn-splat-layer')?.addEventListener('click', toggleSplatLayer);
$('#splat-layer-mix')?.addEventListener('input', (e) => {
  mix = +e.target.value / 100;
  apply();
});
