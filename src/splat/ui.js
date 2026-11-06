// Realistiškas vaizdas (Gaussian Splatting) – peržiūra. Splatai apmokomi serveryje (deploy/splat) iš ODM projekto;
// čia – tik rodymas su Spark (MIT). Stiklas, atspindžiai, medžiai atrodo kaip nuotraukose; matavimams – 3D modelis.
// Koordinatės – ODM vietinis rėmas (Z aukštyn), kaip ir 3D modelio.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = (n) => Number(n).toLocaleString('lt-LT');

/** SH laipsnis (atspindžiai): Spark pritaiko perkūręs generatorių. */
function setSh(mesh, n) {
  mesh.maxSh = n;
  mesh.updateGenerator?.();
}

export function createSplatUI(app) {
  const page = document.createElement('section');
  page.className = 'odm-page splat-page';
  page.hidden = true;
  page.innerHTML = `
    <header class="odm-head">
      <div><h2 id="sp-title">Realistiškas vaizdas</h2><p class="muted small" id="sp-sub">Gaussian Splatting: stiklas, atspindžiai ir medžiai – kaip nuotraukose. Matavimams naudokite 3D modelį.</p></div>
      <button class="btn btn-ghost icon-only" data-act="close" title="Uždaryti">${icon('close')}</button>
    </header>
    <div class="splat-main">
      <div class="splat-view" id="sp-view"></div>
      <div class="or-map-btns">
        <button class="btn btn-sm icon-only" type="button" data-sp="fit" title="Rodyti visą sceną">${icon('fit')}</button>
        <button class="btn btn-sm icon-only" type="button" data-sp="drone" title="Vaizdas iš drono padėties">${icon('camera')}</button>
        <button class="btn btn-sm icon-only" type="button" data-sp="top" title="Vaizdas iš viršaus">${icon('map')}</button>
        <button class="btn btn-sm icon-only" type="button" data-sp="sh" aria-pressed="true" title="Atspindžiai (spalva pagal žiūrėjimo kampą) – įjungti / išjungti. Išjungus vaizdas iš šono ramesnis.">${icon('sun')}</button>
      </div>
      <div class="splat-info small" id="sp-info"></div>
      <div class="splat-help small muted">Kairys pelės klavišas – sukti, dešinys – stumti, ratukas – priartinti</div>
      <div class="ot-loading small" id="sp-loading" hidden></div>
    </div>`;
  document.getElementById('app').append(page);
  const $ = (s) => page.querySelector(s);

  let ctx = null; // { renderer, scene, camera, controls, mesh, ro }
  let meta = null;

  function fit(top = false, fromCamera = false) {
    if (!ctx) return;
    // Pradžia – iš drono kameros padėties (meta.view): iš ten vaizdas atrodo geriausiai (splatai mokyti iš tų kampų)
    if (fromCamera && meta?.view) {
      const { camera, controls } = ctx;
      const [p, q] = [meta.view.position, meta.view.target];
      const dist = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      controls.target.set(q[0], q[1], q[2]);
      camera.position.set(p[0], p[1], p[2]);
      camera.near = Math.max(0.05, dist / 2000);
      camera.far = dist * 50;
      camera.updateProjectionMatrix();
      controls.update();
      return;
    }
    const [lo, hi] = meta?.bbox || [[-50, -50, 0], [50, 50, 30]];
    const c = lo.map((v, i) => (v + hi[i]) / 2);
    const r = Math.max(5, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
    const d = r * 2.2;
    const { camera, controls } = ctx;
    controls.target.set(c[0], c[1], c[2]);
    if (top) camera.position.set(c[0], c[1] - d * 0.02, c[2] + d * 1.3);
    else camera.position.set(c[0] + d * 0.55, c[1] - d * 0.75, c[2] + d * 0.55);
    camera.near = Math.max(0.05, r / 2000);
    camera.far = r * 50;
    camera.updateProjectionMatrix();
    controls.update();
  }

  async function open({ url, name, meta: m = null, downloads = [] }) {
    close();
    page.hidden = false;
    document.body.classList.add('portal-open');
    meta = m;
    $('#sp-title').textContent = name || t('Realistiškas vaizdas');
    $('#sp-info').innerHTML = [
      m?.splats ? t('{n} splatų', { n: nf(m.splats) }) : '',
      m?.cameras ? t('{n} nuotr.', { n: nf(m.cameras) }) : '',
      ...downloads.map((d) => `<a href="${esc(d.href)}" download="${esc(d.name)}">${esc(t(d.label))}</a>`),
    ].filter(Boolean).join(' · ');
    const loading = $('#sp-loading');
    loading.hidden = false;
    loading.textContent = t('Įkeliamas realistiškas vaizdas…');
    try {
      const { SparkRenderer, SplatMesh } = await import('@sparkjsdev/spark');
      if (page.hidden) return;
      const host = $('#sp-view');
      const renderer = new THREE.WebGLRenderer({ antialias: false });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      host.append(renderer.domElement);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x1d2326);
      const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);
      camera.up.set(0, 0, 1);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.screenSpacePanning = true;
      scene.add(new SparkRenderer({ renderer }));
      const mesh = new SplatMesh({ url });
      scene.add(mesh);
      const resize = () => {
        const w = host.clientWidth || 1, h = host.clientHeight || 1;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(host);
      ctx = { renderer, scene, camera, controls, mesh, ro };
      resize();
      fit(false, true);
      renderer.setAnimationLoop(() => {
        controls.update();
        renderer.render(scene, camera);
      });
      await mesh.initialized;
      if (ctx?.mesh !== mesh) return;
      // Įsimintas atspindžių jungiklis
      let shOn = true;
      try {
        shOn = localStorage.getItem('atea3d.splat.sh') !== '0';
      } catch {}
      if (!shOn) {
        setSh(mesh, 0);
        const b = $('[data-sp=sh]');
        b.setAttribute('aria-pressed', 'false');
        b.style.opacity = '.55';
      }
      loading.hidden = true;
      app.onOpened?.();
    } catch (e) {
      loading.textContent = t('Nepavyko atidaryti: {e}', { e: e.message || e });
      app.toast?.(t('Nepavyko atidaryti realistiško vaizdo: {e}', { e: e.message || e }), 'error', 9000);
    }
  }

  function close() {
    if (ctx) {
      ctx.renderer.setAnimationLoop(null);
      ctx.ro.disconnect();
      ctx.controls.dispose();
      ctx.mesh.dispose?.();
      ctx.renderer.dispose();
      ctx.renderer.domElement.remove();
      ctx = null;
    }
    if (!page.hidden) {
      page.hidden = true;
      document.body.classList.remove('portal-open');
    }
  }

  page.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act], [data-sp]');
    if (!b) return;
    if (b.dataset.act === 'close') close();
    else if (b.dataset.sp === 'fit') fit();
    else if (b.dataset.sp === 'top') fit(true);
    else if (b.dataset.sp === 'sh' && ctx) {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      b.style.opacity = on ? '' : '.55';
      setSh(ctx.mesh, on ? 3 : 0);
      try {
        localStorage.setItem('atea3d.splat.sh', on ? '1' : '0');
      } catch {}
    }
    else if (b.dataset.sp === 'drone') fit(false, true);
  });

  return {
    open,
    close,
    get isOpen() {
      return !page.hidden;
    },
  };
}

/** Splat paslaugos adresas pagal ODM serverio adresą (./odm/ → ./splat/); null – jei kitas NodeODM serveris. */
export function splatBase(odmUrl) {
  const u = String(odmUrl || '');
  return /\/?odm\/?$/.test(u) ? u.replace(/odm\/?$/, 'splat/') : null;
}
