// „Modelio kūrimas iš nuotraukų“ – vartotojo sąsaja (OpenDroneMap / NodeODM)
import { findLocalServer } from '../local-server.js';
import { icon } from '../icons.js';
import { readAllMeta, rtkLabel } from './exif.js';
import { analyzePhotos, uniqueUploadNames, buildGeoTxt, buildOdmOptions, photoHeight, boundaryPath, hasInlineBoundary, diagnoseFailure, lowerMemoryOptions, PRESETS, HEIGHT_MODES, ODM_OUTPUTS } from './project.js';
import { NodeODM, STATUS, STATUS_LABELS } from './nodeodm.js';
import { PhotoPreview } from './preview.js';
import { loadGeoidFile } from '../geo/geoid.js';
import { t, locale } from '../i18n.js';

const LS_SERVER = 'atea3d.odm.server';
const LS_PROJECTS = 'atea3d.odm.projects';
const ls = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch { /* ignoruojame */ }
  },
};

/** UUID v4 (crypto.randomUUID veikia tik per HTTPS / localhost, getRandomValues – visur). */
const uuidv4 = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** Vietinis Atea serveris (deploy/): „./odm/“ arba http://localhost:PRIEVADAS/odm/. */
const isLocalOdm = (u) => /^(\.\/odm\/?|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/odm\/?)$/i.test(String(u || '').trim());

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = (v, d = 0) => (v == null || !isFinite(v) ? '—' : new Intl.NumberFormat(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(v));
const fmtBytes = (b) => (b > 1e9 ? `${nf(b / 1e9, 1)} GB` : `${nf(b / 1e6, 0)} MB`);
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? t('{h} val. {m} min.', { h, m }) : m ? t('{m} min. {s} s', { m, s: s % 60 }) : `${s} s`;
};

/**
 * @param {{toast:(msg:string,type?:string,ms?:number)=>void, openResult:(project:object, kind:'model'|'points')=>Promise<void>, saveResults:(project:object)=>void}} app
 */
export function createOdmUI(app) {
  // Atidarius HTML failą tiesiai iš disko – serveris pagal deploy/ numatytuosius nustatymus
  const server = ls.get(LS_SERVER, { url: location.protocol === 'file:' ? 'http://localhost:8080/odm/' : './odm/', token: '' });
  if (location.protocol === 'file:' && /^\.\//.test(server.url)) server.url = 'http://localhost:8080/odm/';
  // Programa atidaryta per vietinį serverį (http://localhost:PRIEVADAS): ODM pasiekiamas tuo pačiu adresu.
  // start-windows.bat gali parinkti kitą prievadą (8081…), todėl įsimintas absoliutus vietinis adresas pasensta.
  if (location.protocol !== 'file:' && isLocalOdm(server.url) && !server.url.startsWith('./') && !server.url.startsWith(location.origin)) {
    server.url = './odm/';
    ls.set(LS_SERVER, server);
  }
  let projects = ls.get(LS_PROJECTS, []);
  let client = new NodeODM(server.url, server.token);
  /** Projekto serveris: vietiniam serveriui – dabartinis adresas (prievadas galėjo pasikeisti). */
  const serverFor = (p) => (isLocalOdm(p.server) ? server.url : p.server);
  let analysis = null;
  let metas = [];
  let geoid = null; // GeoidGrid
  let uploading = null; // {abort, project}
  let pollTimer = null;
  let preview = null; // PhotoPreview – nuotraukų peržiūra ir srities pasirinkimas
  let serverTasks = []; // visos serverio užduotys (ir tos, kurių nėra šios naršyklės sąraše)
  let serverError = null;

  // ------------------------------------------------------------------ DOM
  const page = document.createElement('section');
  page.className = 'odm-page';
  page.hidden = true;
  page.innerHTML = `
    <header class="odm-head">
      <div>
        <h2>Modelio kūrimas iš drono nuotraukų</h2>
        <p class="muted small">OpenDroneMap apdoroja nuotraukas jūsų serveryje. Rezultatai automatiškai perskaičiuojami į LKS-94.</p>
      </div>
      <button class="btn btn-ghost icon-only" data-act="close" title="Uždaryti">${icon('close')}</button>
    </header>
    <div class="odm-body">
      <aside class="odm-side">
        <section class="card">
          <h3>Apdorojimo serveris</h3>
          <label class="row">Adresas <input id="odm-url" class="num wide" style="text-align:left;width:170px" /></label>
          <label class="row">Raktas <input id="odm-token" type="password" class="num wide" style="text-align:left;width:170px" placeholder="(nebūtinas)" /></label>
          <div class="row"><button class="btn btn-sm btn-outline" data-act="check">${icon('check')}Tikrinti ryšį</button><span id="odm-server-state" class="small muted"></span></div>
          <div id="odm-server-info" class="small muted"></div>
        </section>
        <section class="card">
          <h3>Projektai</h3>
          <div id="odm-projects"></div>
          <div id="odm-server-queue"></div>
        </section>
      </aside>
      <div class="odm-main">
        <section class="card odm-step" id="odm-step-photos">
          <h3>1. Nuotraukos</h3>
          <div class="odm-drop" id="odm-drop">
            <div class="odm-drop-inner">
              <span class="odm-drop-icon">${icon('upload')}</span>
              <b>Nutempkite drono nuotraukas arba aplanką</b>
              <span class="muted small">DJI Mavic 3T: naudojamos plačiakampės (_W) nuotraukos, terminės (_T) ir priartinimo (_Z) praleidžiamos automatiškai.</span>
              <div class="pane-actions" style="justify-content:center;margin-top:8px">
                <button class="btn btn-primary btn-sm" data-act="pick">${icon('open')}Pasirinkti nuotraukas</button>
                <button class="btn btn-outline btn-sm" data-act="pick-folder">${icon('folder')}Aplankas</button>
              </div>
            </div>
          </div>
          <input type="file" id="odm-files" multiple accept=".jpg,.jpeg,.JPG,.JPEG,.txt" hidden />
          <input type="file" id="odm-folder" webkitdirectory directory multiple hidden />
          <div id="odm-analysis"></div>
        </section>

        <section class="card odm-step" id="odm-step-settings" hidden>
          <h3>2. Nustatymai</h3>
          <div class="odm-grid2">
            <div>
              <label class="row">Projekto pavadinimas <input id="odm-name" class="num wide" style="text-align:left;width:220px" /></label>
              <div class="row" style="align-items:flex-start;flex-direction:column;gap:6px">
                <span>Kokybė</span>
                <div class="seg" id="odm-preset" style="width:100%">
                  ${Object.entries(PRESETS).map(([k, p]) => `<button data-preset="${k}" class="${k === 'standard' ? 'active' : ''}">${p.label}</button>`).join('')}
                </div>
                <span class="muted small" id="odm-preset-desc">${PRESETS.standard.desc}</span>
              </div>
              <label class="row check"><input type="checkbox" id="odm-dsm" checked /> Paviršiaus modelis (DSM)</label>
              <label class="row check"><input type="checkbox" id="odm-dtm" checked /> Reljefo modelis (DTM, be augmenijos)</label>
              <label class="row check"><input type="checkbox" id="odm-ortho" checked /> Ortofotonuotrauka</label>
              <label class="row check"><input type="checkbox" id="odm-onlyfix" /> Naudoti tik RTK FIX nuotraukas</label>
              <label class="row check" id="odm-split-row"><input type="checkbox" id="odm-split" /> Skaidyti į dalis (mažiau RAM; 3D tekstūruotas modelis nebus sujungtas)</label>
            </div>
            <div>
              <label class="row">Nuotraukų aukščiai
                <select id="odm-hmode">${Object.entries(HEIGHT_MODES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
              </label>
              <div id="odm-geoid-box">
                <p class="small muted" style="margin:4px 0 6px">Normaliniams aukščiams (LAS07) reikia kvazigeoido aukščio N (Lietuvoje ~20–29 m): H = h − N.</p>
                <label class="row check"><input type="radio" name="odm-geoid" value="grid" /> Geoido modelio failas (LIT15G: .gtx / .gri / .txt)</label>
                <div class="row" id="odm-geoid-file-row" hidden>
                  <button class="btn btn-sm btn-outline" data-act="geoid-file">${icon('upload')}Įkelti failą</button>
                  <span id="odm-geoid-file-info" class="small muted"></span>
                </div>
                <input type="file" id="odm-geoid-file" hidden />
                <label class="row check"><input type="radio" name="odm-geoid" value="const" checked /> Vienas N objektui</label>
                <div class="row" id="odm-geoid-const-row"><span class="small muted">N (m), pvz. iš LitPOS / GNSS imtuvo</span><input id="odm-geoid-n" class="num" inputmode="decimal" placeholder="pvz. 24,315" /></div>
                <label class="row check"><input type="radio" name="odm-geoid" value="none" /> Palikti elipsoidinius – pataisysiu kontroliniais taškais</label>
              </div>
              <div id="odm-height-preview" class="small"></div>
            </div>
          </div>
          <div class="odm-start">
            <div id="odm-start-summary" class="small muted"></div>
            <button class="btn btn-primary btn-lg" data-act="start">${icon('cube')}Pradėti apdorojimą</button>
          </div>
        </section>

        <section class="card odm-step" id="odm-step-run" hidden>
          <h3>3. Apdorojimas</h3>
          <div id="odm-run"></div>
        </section>
      </div>
    </div>`;
  document.getElementById('app').append(page);
  const dlgRestart = document.createElement('dialog');
  dlgRestart.className = 'dialog';
  dlgRestart.innerHTML = `<form method="dialog">
      <h2>Kartoti apdorojimą</h2>
      <p class="small"><b class="rs-name"></b></p>
      <div class="rs-diag"></div>
      <div class="rs-opts"></div>
      <menu>
        <button value="cancel" class="btn btn-ghost">Atšaukti</button>
        <button value="ok" class="btn btn-primary">Kartoti</button>
      </menu>
    </form>`;
  page.append(dlgRestart);

  const $ = (q) => page.querySelector(q);
  $('#odm-url').value = server.url;
  $('#odm-token').value = server.token;

  // ------------------------------------------------------------------ Serveris
  function saveServer() {
    server.url = $('#odm-url').value.trim() || './odm/';
    server.token = $('#odm-token').value.trim();
    ls.set(LS_SERVER, server);
    client = new NodeODM(server.url, server.token);
  }
  $('#odm-url').addEventListener('change', saveServer);
  $('#odm-token').addEventListener('change', saveServer);

  async function checkServer(quiet = false) {
    // Iš disko atidarytai programai – surandame, kuriuo prievadu veikia vietinis serveris
    if (/^http:\/\/localhost:80[89]\d\/odm\/?$/.test($('#odm-url').value.trim())) {
      const local = await findLocalServer();
      if (local) $('#odm-url').value = local + 'odm/';
    }
    saveServer();
    const st = $('#odm-server-state');
    st.textContent = 'Jungiamasi…';
    st.className = 'small muted';
    try {
      const i = await client.info();
      st.textContent = '● Prisijungta';
      st.className = 'small ok';
      $('#odm-server-info').innerHTML = `NodeODM ${esc(i.version)} · ODM ${esc(i.engineVersion || '')}<br>
        ${t('CPU branduolių: {c} · Laisva RAM: {f} / {tot}', { c: esc(i.cpuCores), f: i.availableMemory ? fmtBytes(i.availableMemory) : '—', tot: i.totalMemory ? fmtBytes(i.totalMemory) : '—' })}<br>
        ${t('Eilėje užduočių: {n}', { n: esc(i.taskQueueCount) })}${i.maxImages ? ` · ${t('Maks. nuotraukų: {n}', { n: esc(i.maxImages) })}` : ''}`;
      return i;
    } catch (e) {
      st.textContent = /rakt|token/i.test(e.message) ? t('● Raktas netinka') : /paleidžiamas|starting/.test(e.message) ? t('● Serveris paleidžiamas') : t('● Nepavyko prisijungti');
      st.className = 'small bad';
      $('#odm-server-info').textContent = `${e.message.replace(/[.?!]?$/, (m) => m || '.')} ${t('Instrukcija – README skyrius „Serverio diegimas“.')}`;
      if (!quiet) app.toast(e.message, 'error', 8000);
      return null;
    }
  }

  // ------------------------------------------------------------------ Nuotraukos
  $('#odm-files').addEventListener('change', (e) => {
    handleFiles([...e.target.files]);
    e.target.value = '';
  });
  $('#odm-folder').addEventListener('change', (e) => {
    handleFiles([...e.target.files]);
    e.target.value = '';
  });
  const drop = $('#odm-drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    drop.classList.remove('over');
    handleFiles(await app.filesFromDataTransfer(e.dataTransfer));
  });

  let extraFiles = []; // pvz. gcp_list.txt
  async function handleFiles(files) {
    const jpgs = files.filter((f) => /\.jpe?g$/i.test(f.name));
    extraFiles = files.filter((f) => /^gcp.*\.txt$/i.test(f.name));
    if (!jpgs.length) return app.toast('Nerasta JPG nuotraukų', 'error');
    const box = $('#odm-analysis');
    box.innerHTML = `<div class="odm-progress"><div class="progress"><div class="progress-bar" style="width:0"></div></div><span class="small muted">${t('Skaitomi {n} nuotraukų metaduomenys…', { n: nf(jpgs.length) })}</span></div>`;
    const t0 = performance.now();
    metas = await readAllMeta(jpgs, (p) => (box.querySelector('.progress-bar').style.width = `${Math.round(p * 100)}%`));
    console.info(`EXIF: ${jpgs.length} nuotr. per ${Math.round(performance.now() - t0)} ms`);
    reanalyze();
    if (!$('#odm-name').value) {
      const d = analysis.timeFrom || new Date();
      $('#odm-name').value = `${t('Skrydis')} ${d.toLocaleDateString(locale())} ${d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}`;
    }
  }

  function reanalyze() {
    if (!metas.length) return;
    analysis = analyzePhotos(metas, { onlyFix: $('#odm-onlyfix').checked });
    renderAnalysis();
    $('#odm-step-settings').hidden = false;
    $('#odm-split-row').hidden = analysis.used.length < 500;
    updateHeightPreview();
  }
  $('#odm-onlyfix').addEventListener('change', reanalyze);

  function renderAnalysis() {
    const a = analysis;
    const n = a.used.length;
    const fixPct = n ? (a.rtk.fix / n) * 100 : 0;
    const box = $('#odm-analysis');
    box.innerHTML = `
      <div class="odm-stats">
        ${stat('Nuotraukų', `${nf(n)}`, `${t('iš {n}', { n: nf(metas.length) })} · ${fmtBytes(a.totalBytes)}`)}
        ${stat('RTK FIX', `${nf(fixPct, 0)} %`, `FLOAT ${a.rtk.float} · ${t('kita')} ${a.rtk.single + a.rtk.none + a.rtk.unknown}`, fixPct > 95 ? 'ok' : fixPct > 70 ? 'warn' : 'bad')}
        ${stat('RTK tikslumas', a.stdH != null ? `±${nf(a.stdH * 100, 1)} cm` : '—', a.stdV != null ? t('aukštis ±{v} cm', { v: nf(a.stdV * 100, 1) }) : 'plokštumoje')}
        ${stat('Skrydžio aukštis', a.agl != null ? `${nf(a.agl, 0)} m` : '—', 'virš pakilimo vietos')}
        ${stat('GSD', a.gsd != null ? `${nf(a.gsd * 100, 2)} cm/px` : '—', 'žemės pikselio dydis')}
        ${stat('Plotas', `${nf(a.areaM2 / 10000, 2)} ha`, 'pagal nuotraukų vietas')}
        ${stat('Kamera', esc(a.models.join(', ') || '—'), a.versions.length ? `XMP ${esc(a.versions.join(', '))}` : '')}
        ${stat('Laikas', a.timeFrom ? a.timeFrom.toLocaleDateString(locale()) : '—', a.timeFrom ? `${a.timeFrom.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}–${a.timeTo.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}` : '')}
      </div>
      ${a.warnings.length ? `<ul class="odm-warn">${a.warnings.map((w) => `<li class="${w.level}">${esc(w.text)}</li>`).join('')}</ul>` : '<p class="small ok">Nuotraukų rinkinys tvarkingas.</p>'}
      ${extraFiles.length ? `<p class="small">${t('Pridėtas GCP failas: {f} (bus perduotas ODM).', { f: esc(extraFiles.map((f) => f.name).join(', ')) })}</p>` : ''}
      <h4 class="odm-sub">${t('Peržiūra ir apdorojama sritis')}</h4>
      <p class="small muted" style="margin:0 0 8px">${t('Apytikslis vaizdas iš nuotraukų (pagal GPS, aukštį ir kameros kryptį). Jei visos teritorijos nereikia – pažymėkite sritį: dar prieš įkėlimą bus atrinktos tik nuotraukos, kuriose ji aiškiai matosi (kitos pritemdomos ir neįkeliamos), o ODM apdoros tik pažymėtą sritį. Apdorojimo laikas priklauso nuo nuotraukų skaičiaus.')}</p>
      <div class="odm-preview" id="odm-preview"></div>
      <div class="odm-legend small"><span class="dot fix"></span>FIX <span class="dot float"></span>FLOAT <span class="dot other"></span>${t('be RTK')}</div>`;
    preview?.dispose();
    const rtkColor = (m) => (m.rtkFlag === 50 ? '#3cc443' : m.rtkFlag === 34 ? '#ffb627' : '#ff5e57');
    preview = new PhotoPreview($('#odm-preview'), a.used, {
      agl: a.agl,
      rtkColor,
      tooltip: (m) => `<b>${esc(m.name)}</b><br>RTK ${t(rtkLabel(m.rtkFlag))}${m.stdLat != null ? ` ±${nf(Math.max(m.stdLat, m.stdLon) * 100, 1)} / ${nf(m.stdHgt * 100, 1)} cm` : ''}<br>${t('Aukštis {h} m (virš pakil. {r} m)', { h: nf(m.absAlt ?? m.alt, 2), r: nf(m.relAlt, 1) })}`,
      onChange: () => updateStartSummary(),
    });
  }

  const stat = (label, value, sub, cls = '') => `<div class="odm-stat ${cls}"><span class="muted small">${label}</span><b>${value}</b><span class="muted small">${sub || ''}</span></div>`;


  // ------------------------------------------------------------------ Aukščiai / geoidas
  const geoidMode = () => page.querySelector('input[name="odm-geoid"]:checked')?.value;
  const parseNum = (v) => parseFloat(String(v).replace(',', '.').replace(/\s/g, ''));

  function geoidFn() {
    if ($('#odm-hmode').value !== 'ellipsoid') return null;
    const mode = geoidMode();
    if (mode === 'grid' && geoid) return (lat, lon) => geoid.undulation(lat, lon);
    if (mode === 'const') {
      const n = parseNum($('#odm-geoid-n').value);
      if (isFinite(n)) return () => n;
    }
    return null;
  }

  function heightSystem() {
    const hm = $('#odm-hmode').value;
    if (hm === 'normal') return 'LAS07';
    if (hm === 'egm96') return 'EGM96 (≈ jūros lygis)';
    return geoidFn() ? 'LAS07' : 'elipsoidinis ETRS89';
  }

  function updateHeightPreview() {
    const hm = $('#odm-hmode').value;
    $('#odm-geoid-box').hidden = hm !== 'ellipsoid';
    $('#odm-geoid-file-row').hidden = geoidMode() !== 'grid';
    $('#odm-geoid-const-row').style.opacity = geoidMode() === 'const' ? 1 : 0.4;
    const el = $('#odm-height-preview');
    if (!analysis?.used.length) return (el.innerHTML = '');
    const c = analysis.center;
    const sample = analysis.used[0];
    const fn = geoidFn();
    const N = fn?.(c.lat, c.lon);
    const takeoff = analysis.takeoff;
    let html = '<div class="odm-hp">';
    if (takeoff != null) html += `<div>${t('Pakilimo vietos aukštis nuotraukose:')} <b>${nf(takeoff, 2)} m</b></div>`;
    if (hm === 'ellipsoid') {
      if (N != null && isFinite(N)) {
        html += `<div>${t('N objekto centre:')} <b>${nf(N, 3)} m</b> → ${t('pakilimo vieta LAS07 ≈')} <b>${nf(takeoff - N, 2)} m</b></div>`;
        const H = photoHeight(sample, 'ellipsoid', fn);
        html += `<div class="muted">${t('Pvz. {f}: h {h} → H {H} m', { f: esc(sample.name), h: nf(sample.absAlt ?? sample.alt, 3), H: nf(H, 3) })}</div>`;
      } else if (geoidMode() === 'grid' && geoid && !geoid.covers(c.lat, c.lon)) {
        html += '<div class="bad">Geoido modelis nedengia objekto vietos.</div>';
      } else {
        html += '<div class="warn">Aukščiai liks elipsoidiniai (~20–29 m didesni už LAS07). Pataisykite kontroliniu tašku.</div>';
      }
    } else if (hm === 'egm96') {
      html += '<div class="warn">EGM96 ir LAS07 gali skirtis keliais dm – patikrinkite kontroliniu tašku.</div>';
    }
    html += `<div class="muted">Rezultato aukščių sistema: <b>${esc(heightSystem())}</b></div></div>`;
    el.innerHTML = html;
    updateStartSummary();
  }
  $('#odm-hmode').addEventListener('change', updateHeightPreview);
  page.querySelectorAll('input[name="odm-geoid"]').forEach((r) => r.addEventListener('change', updateHeightPreview));
  $('#odm-geoid-n').addEventListener('input', updateHeightPreview);
  $('#odm-geoid-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      geoid = await loadGeoidFile(f);
      $('#odm-geoid-file-info').textContent = `${geoid.name}: ${geoid.rows}×${geoid.cols}`;
      updateHeightPreview();
    } catch (err) {
      app.toast(t('Nepavyko įkelti geoido: {e}', { e: err.message }), 'error');
    }
  });

  let preset = 'standard';
  page.querySelectorAll('#odm-preset button').forEach((b) =>
    b.addEventListener('click', () => {
      preset = b.dataset.preset;
      page.querySelectorAll('#odm-preset button').forEach((x) => x.classList.toggle('active', x === b));
      $('#odm-preset-desc').textContent = PRESETS[preset].desc;
      updateStartSummary();
    }),
  );

  function updateStartSummary() {
    if (!analysis) return;
    const photos = preview?.hasSelection ? preview.selectedPhotos() : analysis.used;
    const n = photos.length;
    const bytes = photos.reduce((s, m) => s + m.size, 0);
    // Labai apytikslis laikas (8 branduolių serveris, standartinė kokybė): ~6–10 s nuotraukai
    const perImg = { fast: 4, standard: 8, high: 18 }[preset];
    const area = preview?.hasSelection ? ` · ${t('sritis {a} ha', { a: nf(preview.areaM2 / 1e4, 2) })}` : '';
    $('#odm-start-summary').innerHTML = `${t('{n} nuotr.', { n: nf(n) })}${n < analysis.used.length ? ` ${t('iš {n}', { n: nf(analysis.used.length) })}` : ''} (${fmtBytes(bytes)})${area} · ${t(PRESETS[preset].label)} · ${t('aukščiai:')} ${esc(t(heightSystem()))}<br>${t('Apytikslė trukmė: {a} – {b} (priklauso nuo serverio)', { a: fmtDur(n * perImg * 1000), b: fmtDur(n * perImg * 2500) })}`;
  }

  // ------------------------------------------------------------------ Paleidimas
  async function start() {
    if (!analysis?.used.length) return app.toast('Pirmiausia pasirinkite nuotraukas', 'error');
    const photos = preview?.hasSelection ? preview.selectedPhotos() : analysis.used;
    const boundary = preview?.hasSelection ? preview.boundaryGeoJSON() : null;
    // Su riba – užduoties ID parenkame patys, kad ODM parinktyje būtų galima nurodyti failo kelią
    const presetUuid = boundary ? uuidv4() : undefined;
    if (photos.length < 5) return app.toast('Pasirinktą sritį dengia per mažai nuotraukų – padidinkite sritį', 'error');
    if (uploading) return app.toast('Jau vyksta įkėlimas', 'error');
    const info = await checkServer(true);
    if (!info) return app.toast('Apdorojimo serveris nepasiekiamas', 'error');
    if (info.maxImages && photos.length > info.maxImages) return app.toast(t('Serveris priima iki {n} nuotraukų', { n: info.maxImages }), 'error');
    if ($('#odm-hmode').value === 'ellipsoid' && geoidMode() === 'const' && !geoidFn()) {
      return app.toast('Įveskite geoido aukštį N arba pasirinkite kitą variantą', 'error');
    }

    const name = $('#odm-name').value.trim() || 'Projektas';
    const entries = uniqueUploadNames(photos);
    const geoTxt = buildGeoTxt(entries, $('#odm-hmode').value, geoidFn());
    const options = buildOdmOptions(preset, {
      dsm: $('#odm-dsm').checked, dtm: $('#odm-dtm').checked, ortho: $('#odm-ortho').checked, split: $('#odm-split').checked,
      boundary: boundary ? boundaryPath(presetUuid) : null,
    });
    const items = entries.map((e) => ({ name: e.name, file: e.file }));
    items.push({ name: 'geo.txt', file: new Blob([geoTxt], { type: 'text/plain' }) });
    if (boundary) items.push({ name: 'boundary.geojson', file: new Blob([JSON.stringify(boundary)], { type: 'application/geo+json' }) });
    for (const f of extraFiles) items.push({ name: f.name, file: f });

    const project = {
      uuid: null, name, server: server.url, created: Date.now(), photos: entries.length,
      rtkFix: photos.filter((m) => m.rtkFlag === 50).length, preset, area: boundary ? Math.round(preview.areaM2) : null, heightSystem: heightSystem(), status: 'uploading', progress: 0,
    };
    const ctrl = new AbortController();
    uploading = { abort: () => ctrl.abort(), project };
    $('#odm-step-run').hidden = false;
    $('#odm-step-run').scrollIntoView({ behavior: 'smooth' });
    const run = $('#odm-run');
    run.innerHTML = `
      <div class="odm-run-row"><b>Įkeliamos nuotraukos</b><span id="odm-up-text" class="small muted"></span></div>
      <div class="progress big"><div class="progress-bar" id="odm-up-bar"></div></div>
      <div class="pane-actions" style="margin-top:10px"><button class="btn btn-sm btn-ghost danger" data-act="abort-upload">Nutraukti įkėlimą</button></div>`;
    try {
      project.uuid = await client.init(name, options, ODM_OUTPUTS, presetUuid);
      saveProject(project);
      const t0 = performance.now();
      await client.upload(project.uuid, items, (sent, total, done) => {
        const p = sent / total;
        const el = (performance.now() - t0) / 1000;
        const speed = sent / Math.max(el, 0.1);
        $('#odm-up-bar').style.width = `${(p * 100).toFixed(1)}%`;
        $('#odm-up-text').textContent = `${nf(p * 100, 1)} % · ${fmtBytes(sent)} / ${fmtBytes(total)} · ${nf(speed / 1e6, 1)} MB/s · ${t('liko ~{t}', { t: fmtDur(((total - sent) / Math.max(speed, 1)) * 1000) })} · ${t('{a}/{b} failų', { a: done, b: items.length })}`;
      }, { signal: ctrl.signal });
      await client.commit(project.uuid);
      project.status = 'queued';
      saveProject(project);
      app.toast('Nuotraukos įkeltos – apdorojimas pradėtas. Galite uždaryti šį langą.');
      run.innerHTML = `<p>${t('Projektas „{n}“ perduotas apdoroti. Eigą matysite projektų sąraše kairėje – galite toliau dirbti ar net uždaryti naršyklę.', { n: esc(name) })}</p>`;
      resetWizard();
      poll();
    } catch (e) {
      if (e.name === 'AbortError') app.toast('Įkėlimas nutrauktas', 'error');
      else app.toast(t('Klaida: {e}', { e: e.message }), 'error', 8000);
      if (project.uuid) client.remove(project.uuid).catch(() => {});
      removeProject(project.uuid);
      run.innerHTML = `<p class="bad">${t('Nepavyko: {e}', { e: esc(e.message) })}</p>`;
    } finally {
      uploading = null;
      renderProjects();
    }
  }

  function resetWizard() {
    preview?.dispose();
    preview = null;
    metas = [];
    analysis = null;
    extraFiles = [];
    $('#odm-analysis').innerHTML = '';
    $('#odm-name').value = '';
    $('#odm-step-settings').hidden = true;
  }

  window.addEventListener('beforeunload', (e) => {
    if (uploading) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ------------------------------------------------------------------ Projektai
  function saveProject(p) {
    const i = projects.findIndex((x) => x.uuid === p.uuid);
    if (i >= 0) projects[i] = { ...projects[i], ...p };
    else projects.unshift(p);
    ls.set(LS_PROJECTS, projects);
  }
  function removeProject(uuid) {
    projects = projects.filter((p) => p.uuid !== uuid);
    ls.set(LS_PROJECTS, projects);
  }

  function statusChip(p) {
    const code = p.statusCode;
    if (p.status === 'uploading') return '<span class="chip run">Įkeliama</span>';
    if (p.status === 'missing') return '<span class="chip bad">Nerasta serveryje</span>';
    if (code === STATUS.COMPLETED) return '<span class="chip ok">Baigta</span>';
    if (code === STATUS.FAILED) return '<span class="chip bad">Nepavyko</span>';
    if (code === STATUS.CANCELED) return '<span class="chip">Atšaukta</span>';
    if (code === STATUS.RUNNING) return `<span class="chip run">${t('Apdorojama {p} %', { p: nf(p.progress, 0) })}</span>`;
    if (code === STATUS.QUEUED) return '<span class="chip">Eilėje</span>';
    return '<span class="chip">—</span>';
  }

  /** Kodėl užduotis laukia: kas dabar vykdoma serveryje. */
  function queueWhy(p) {
    if (serverError) return t('Serverio eilės nepavyko patikrinti.');
    const running = serverTasks.filter((x) => x.status?.code === STATUS.RUNNING);
    const queued = serverTasks.filter((x) => x.status?.code === STATUS.QUEUED).sort((a, b) => (a.dateCreated || 0) - (b.dateCreated || 0));
    const pos = queued.findIndex((x) => x.uuid === p.uuid);
    if (running.length) {
      const r = running[0];
      const mine = projects.find((x) => x.uuid === r.uuid);
      return t('Laukia, kol baigsis: „{n}“ ({p} %){o}. Vieta eilėje: {k}.', { n: esc(mine?.name || r.name || r.uuid.slice(0, 8)), p: nf(r.progress, 0), o: mine ? '' : ` – ${t('šios užduoties nėra jūsų sąraše, žr. žemiau')}`, k: pos + 1 || '—' });
    }
    if (serverTasks.length) return t('Serveris šiuo metu nieko neapdoroja, bet užduotis nepradedama – NodeODM greičiausiai užstrigo. Perkraukite jį: aplanke deploy paleiskite „docker compose restart nodeodm“ (užduotys neprarandamos).');
    return '';
  }

  function renderServerQueue() {
    const box = $('#odm-server-queue');
    const mine = new Set(projects.map((p) => p.uuid));
    const others = serverTasks.filter((x) => !mine.has(x.uuid));
    if (!others.length) return (box.innerHTML = '');
    box.innerHTML = `
      <h4 class="odm-sub">${t('Kitos užduotys serveryje')}</h4>
      <p class="small muted" style="margin:0 0 6px">${t('Šios užduotys yra serveryje, bet ne šios naršyklės sąraše (pvz. pradėtos kitame kompiuteryje ar kitu adresu). Pridėkite jas į sąrašą arba pašalinkite.')}</p>
      ${others.map((x) => `
        <div class="odm-proj" data-suuid="${esc(x.uuid)}">
          <div class="odm-proj-head"><b>${esc(x.name || x.uuid.slice(0, 8))}</b>${statusChip({ statusCode: x.status?.code, progress: x.progress })}</div>
          ${x.status?.code === STATUS.FAILED && x.status.errorMessage ? `<div class="small bad">${esc(x.status.errorMessage)}</div>` : ''}
          <div class="small muted">${x.dateCreated ? new Date(x.dateCreated).toLocaleString(locale()) : ''} · ${t('{n} nuotr.', { n: nf(x.imagesCount) })}${x.processingTime ? ` · ${fmtDur(x.processingTime)}` : ''}</div>
          <div class="odm-proj-actions">
            <button class="btn btn-sm btn-outline" data-sact="adopt">${t('Pridėti į sąrašą')}</button>
            ${[STATUS.RUNNING, STATUS.QUEUED].includes(x.status?.code) ? `<button class="btn btn-sm btn-ghost danger" data-sact="cancel">${t('Atšaukti')}</button>` : `<button class="btn btn-sm btn-ghost icon-only danger" data-sact="remove" title="${t('Pašalinti iš serverio')}">${icon('trash')}</button>`}
          </div>
        </div>`).join('')}`;
    box.querySelectorAll('[data-sact]').forEach((b) =>
      b.addEventListener('click', async () => {
        const uuid = b.closest('[data-suuid]').dataset.suuid;
        const x = serverTasks.find((y) => y.uuid === uuid);
        try {
          if (b.dataset.sact === 'adopt') {
            saveProject({ uuid, name: x.name || uuid.slice(0, 8), server: server.url, created: x.dateCreated || Date.now(), photos: x.imagesCount, preset: '', status: 'server', statusCode: x.status.code, progress: x.progress });
          } else if (b.dataset.sact === 'remove') {
            if (confirm(t('Pašalinti projektą „{n}“ ir jo rezultatus serveryje?', { n: x.name || uuid }))) await client.remove(uuid);
          } else if (confirm(t('Atšaukti „{n}“ apdorojimą?', { n: x.name || uuid }))) {
            await client.cancel(uuid);
          }
        } catch (e) {
          app.toast(e.message, 'error');
        }
        poll();
      }),
    );
  }

  function renderProjects() {
    renderServerQueue();
    const box = $('#odm-projects');
    if (!projects.length) {
      box.innerHTML = '<p class="muted small">Projektų dar nėra.</p>';
      updateBadge();
      return;
    }
    box.innerHTML = projects
      .map(
        (p) => `
      <div class="odm-proj" data-uuid="${esc(p.uuid)}">
        <div class="odm-proj-head"><b>${esc(p.name)}</b>${statusChip(p)}</div>
        <div class="small muted">${new Date(p.created).toLocaleString(locale())} · ${t('{n} nuotr.', { n: nf(p.photos) })} · ${esc(t(PRESETS[p.preset]?.label || ''))}${p.processingTime ? ` · ${fmtDur(p.processingTime)}` : ''}</div>
        ${p.statusCode === STATUS.RUNNING ? `<div class="progress"><div class="progress-bar" style="width:${p.progress || 0}%"></div></div>` : ''}
        ${p.statusCode === STATUS.FAILED && (p.diag || p.error) ? `<div class="small bad">${esc(p.diag?.text || p.error)}</div>${p.diag?.line ? `<div class="small muted odm-errline" title="${esc(p.diag.line)}">${esc(p.diag.line)}</div>` : ''}` : ''}
        ${p.retryNote && p.statusCode !== STATUS.FAILED ? `<div class="small muted">${t('Kartojama: {c}', { c: esc(p.retryNote) })}</div>` : ''}
        ${p.statusCode === STATUS.QUEUED && p.status !== 'uploading' ? `<div class="small muted odm-queue-why">${queueWhy(p)}</div>` : ''}
        ${p.pollError ? `<div class="small bad">${t('Nepavyksta gauti būsenos: {e}', { e: esc(p.pollError) })}</div>` : ''}
        <div class="odm-proj-actions">
          ${p.statusCode === STATUS.COMPLETED ? `
            <button class="btn btn-sm btn-primary" data-pact="model" title="Atidaryti tekstūruotą 3D modelį LKS-94">${icon('cube')}3D modelis</button>
            <button class="btn btn-sm btn-outline" data-pact="points" title="Atidaryti taškų debesį LKS-94">Taškai</button>
            <button class="btn btn-sm btn-outline" data-pact="save" title="Atsisiųsti ortofoto, DSM, DTM, taškų debesį ar 3D modelį"><span data-icon="save">${icon('save')}</span>Atsisiųsti</button>` : ''}
          ${p.statusCode === STATUS.RUNNING || p.statusCode === STATUS.QUEUED ? `<button class="btn btn-sm btn-outline" data-pact="log">Žurnalas</button><button class="btn btn-sm btn-ghost danger" data-pact="cancel">Atšaukti</button>` : ''}
          ${p.statusCode === STATUS.FAILED || p.statusCode === STATUS.CANCELED ? `<button class="btn btn-sm btn-outline" data-pact="log">Žurnalas</button><button class="btn btn-sm btn-outline" data-pact="restart">Kartoti</button>` : ''}
          ${p.status !== 'uploading' ? `<button class="btn btn-sm btn-ghost icon-only danger" data-pact="delete" title="Pašalinti">${icon('trash')}</button>` : ''}
        </div>
        <pre class="odm-log" hidden></pre>
      </div>`,
      )
      .join('');
    box.querySelectorAll('[data-pact]').forEach((b) => b.addEventListener('click', () => projectAction(b.closest('.odm-proj').dataset.uuid, b.dataset.pact, b)));
    updateBadge();
  }

  async function projectAction(uuid, act, btn) {
    const p = projects.find((x) => x.uuid === uuid);
    if (!p) return;
    const c = new NodeODM(serverFor(p), server.token);
    try {
      if (act === 'save') {
        app.saveResults({ ...p, downloadUrl: c.downloadUrl(uuid) });
        return;
      }
      if (act === 'model' || act === 'points') {
        await app.openResult({ ...p, downloadUrl: c.downloadUrl(uuid) }, act);
        close();
      } else if (act === 'cancel') {
        if (confirm(t('Atšaukti „{n}“ apdorojimą?', { n: p.name }))) await c.cancel(uuid);
      } else if (act === 'restart') {
        await openRestart(p, c);
      } else if (act === 'delete') {
        if (!confirm(t('Pašalinti projektą „{n}“ ir jo rezultatus serveryje?', { n: p.name }))) return;
        try {
          await c.remove(uuid);
        } catch (e) {
          // Jau nėra serveryje – tiesiog išimame iš sąrašo; kitaip neišimame, kad užduotis neliktų „nematoma“
          if (!/not found|Invalid UUID/i.test(e.message)) throw e;
        }
        removeProject(uuid);
      } else if (act === 'log') {
        const pre = btn.closest('.odm-proj').querySelector('.odm-log');
        pre.hidden = !pre.hidden;
        if (!pre.hidden) {
          const lines = await c.output(uuid, -60).catch(() => c.output(uuid, 0));
          pre.textContent = (Array.isArray(lines) ? lines.slice(-60) : []).join('\n') || '(tuščia)';
          pre.scrollTop = pre.scrollHeight;
        }
        return;
      }
    } catch (e) {
      app.toast(e.message, 'error');
    }
    poll();
  }

  /** Nepavykusios užduoties priežastis pagal ODM žurnalą. */
  async function diagnose(c, uuid, options) {
    try {
      const lines = await c.output(uuid, -250).catch(() => c.output(uuid, 0));
      return diagnoseFailure(Array.isArray(lines) ? lines.slice(-250) : [], options);
    } catch {
      return null;
    }
  }

  /** „Kartoti“: tais pačiais nustatymais, su mažesniu RAM poreikiu, be srities ribos arba viską iš naujo. */
  async function openRestart(p, c) {
    const info = await c.taskInfo(p.uuid);
    const none = { kind: 'other', stage: null, text: '' };
    const diag = info.status?.code === STATUS.CANCELED ? none : (await diagnose(c, p.uuid, info.options)) || p.diag || none;
    let options = info.options || [];
    const inline = hasInlineBoundary(options);
    // Sukurta senesne versija: riba perduota JSON tekstu, kurį NodeODM sugadina – kartojame be jos
    if (inline) options = options.filter((o) => o.name !== 'boundary').concat({ name: 'auto-boundary', value: true });
    const base = options.filter((o) => !['rerun-from', 'rerun-all', 'rerun'].includes(o.name));
    const low = lowerMemoryOptions(options, diag.stage);
    const hasBoundary = options.some((o) => o.name === 'boundary');
    let ram = '';
    if (diag.kind === 'memory') {
      const si = await c.info().catch(() => null);
      if (si?.totalMemory) ram = t('Apdorojimo serveriui (Docker) skirta {m} RAM.', { m: fmtBytes(si.totalMemory) });
    }
    const choices = [];
    if (low.changes.length)
      choices.push({ id: 'low', title: t('Su mažesniu atminties poreikiu'), desc: `${low.changes.join('; ')}.${diag.stage && diag.stage !== 'dataset' && diag.stage !== 'opensfm' ? ` ${t('Tęsiama nuo etapo „{s}“ – jau atlikti etapai nekartojami.', { s: diag.stageLabel })}` : ''}`, options: low.options });
    if (hasBoundary && diag.kind === 'boundary')
      choices.push({ id: 'nob', title: t('Be pasirinktos srities ribos'), desc: t('Apdorojama visa nuotraukų teritorija.'), options: base.filter((o) => o.name !== 'boundary').concat({ name: 'auto-boundary', value: true }, { name: 'rerun-from', value: 'odm_filterpoints' }) });
    choices.push({ id: 'same', title: t('Tais pačiais nustatymais'), desc: t('Tęsiama nuo nutrūkusios vietos. Tinka, jei klaida buvo atsitiktinė (pvz. serveris buvo perkrautas).'), options: inline ? options : undefined });
    choices.push({ id: 'all', title: t('Viską iš naujo'), desc: t('Visi etapai kartojami nuo pradžių (ilgiausia).'), options: base.concat({ name: 'rerun-all', value: true }) });
    const def = diag.kind === 'memory' && low.changes.length ? 'low' : diag.kind === 'boundary' && hasBoundary ? 'nob' : 'same';

    dlgRestart.querySelector('.rs-name').textContent = p.name;
    dlgRestart.querySelector('.rs-diag').innerHTML = diag.text
      ? `<div class="odm-warn"><li class="${diag.kind === 'other' ? 'warn' : 'error'}">${esc(diag.text)}${ram ? `<br><span class="muted">${esc(ram)} ${esc(t('Docker Desktop: daugiau RAM skiriama faile %UserProfile%\\.wslconfig (memory=…), po to – wsl --shutdown.'))}</span>` : ''}${diag.line ? `<br><code class="small">${esc(diag.line)}</code>` : ''}</li></div>`
      : '';
    dlgRestart.querySelector('.rs-opts').innerHTML = choices
      .map((ch) => `<label class="rs-opt"><input type="radio" name="rs" value="${ch.id}" ${ch.id === def ? 'checked' : ''}><span><b>${esc(ch.title)}</b><span class="small muted">${esc(ch.desc)}</span></span></label>`)
      .join('');
    const res = await new Promise((resolve) => {
      dlgRestart.addEventListener('close', () => resolve(dlgRestart.returnValue), { once: true });
      dlgRestart.showModal();
    });
    if (res !== 'ok') return;
    const ch = choices.find((x) => x.id === dlgRestart.querySelector('input[name=rs]:checked')?.value) || choices[0];
    await c.restart(p.uuid, ch.options);
    if (inline) app.toast('Užduotis paleista iš naujo be pasirinktos srities ribos (ji buvo perduota netinkamai). Bus apdorota visa nuotraukų teritorija.', 'info', 9000);
    // Kitaip būsena nebebūtų tikrinama ir projektas liktų „Nepavyko“
    Object.assign(p, { statusCode: STATUS.QUEUED, error: null, diag: null, _polledFailed: false, progress: 0, retryNote: ch.id === 'low' ? low.changes.join('; ') : ch.id === 'nob' ? t('be srities ribos') : ch.id === 'all' ? t('viskas iš naujo') : '' });
    ls.set(LS_PROJECTS, projects);
    renderProjects();
    app.toast('Užduotis paleista iš naujo', 'info');
  }

  async function poll() {
    clearTimeout(pollTimer);
    let active = false;
    for (const p of projects) {
      if (!p.uuid || p.status === 'uploading' || p.status === 'missing') continue;
      if (p.statusCode === STATUS.COMPLETED || p.statusCode === STATUS.CANCELED) continue;
      if (p.statusCode === STATUS.FAILED && p._polledFailed) {
        // Senesnės versijos projektai – priežastis dar nenustatyta
        if (p.diag === undefined) {
          const c = new NodeODM(serverFor(p), server.token);
          const i = await c.taskInfo(p.uuid).catch(() => null);
          p.diag = i ? await diagnose(c, p.uuid, i.options) : null;
        }
        continue;
      }
      try {
        const i = await new NodeODM(serverFor(p), server.token).taskInfo(p.uuid);
        const prev = p.statusCode;
        p.statusCode = i.status?.code;
        p.error = i.status?.errorMessage;
        p.progress = i.progress;
        p.processingTime = i.processingTime;
        p.status = 'server';
        if (p.statusCode === STATUS.FAILED && !p._polledFailed) {
          p._polledFailed = true;
          p.diag = await diagnose(new NodeODM(serverFor(p), server.token), p.uuid, i.options);
        }
        if (prev !== STATUS.COMPLETED && p.statusCode === STATUS.COMPLETED) {
          app.toast(t('Modelis „{n}“ paruoštas!', { n: p.name }), 'info', 8000);
          notify(t('Modelis „{n}“ paruoštas', { n: p.name }));
        }
        if (p.statusCode === STATUS.QUEUED || p.statusCode === STATUS.RUNNING) active = true;
        p.pollError = null;
      } catch (e) {
        if (/not found|Invalid UUID|uuid/i.test(e.message)) p.status = 'missing';
        else p.pollError = e.message;
      }
    }
    // Visa serverio eilė (ir užduotys, kurių nėra šiame sąraše) – kad būtų aišku, kodėl užduotis laukia
    if (active || projects.some((p) => p.statusCode === STATUS.QUEUED) || !page.hidden) {
      try {
        const list = await client.list();
        const infos = await Promise.all((Array.isArray(list) ? list : []).slice(0, 30).map((x) => client.taskInfo(x.uuid).catch(() => null)));
        serverTasks = infos.filter(Boolean);
        serverError = null;
        if (serverTasks.some((x) => x.status?.code === STATUS.RUNNING || x.status?.code === STATUS.QUEUED)) active = true;
      } catch (e) {
        serverError = e.message;
      }
    } else serverTasks = [];
    ls.set(LS_PROJECTS, projects);
    if (!page.hidden) renderProjects();
    else updateBadge();
    pollTimer = setTimeout(poll, active ? 10_000 : 60_000);
  }

  function notify(text) {
    try {
      if ('Notification' in window && Notification.permission === 'granted') new Notification('Atea 3D Matuoklis', { body: text });
    } catch { /* nebūtina */ }
  }

  function updateBadge() {
    const b = document.getElementById('odm-badge');
    if (!b) return;
    const running = projects.filter((p) => p.status === 'uploading' || p.statusCode === STATUS.RUNNING || p.statusCode === STATUS.QUEUED);
    const done = projects.filter((p) => p.statusCode === STATUS.COMPLETED && !p.seen);
    b.hidden = !running.length && !done.length;
    b.textContent = running.length ? `${t('{n} apdorojama', { n: running.length })}${running[0].statusCode === STATUS.RUNNING ? ` · ${nf(running[0].progress, 0)} %` : ''}` : t('{n} paruošta', { n: done.length });
    b.className = `badge ${running.length ? 'run' : 'ok'}`;
  }

  // ------------------------------------------------------------------ Atidarymas / uždarymas
  function open() {
    page.hidden = false;
    projects.forEach((p) => p.statusCode === STATUS.COMPLETED && (p.seen = true));
    ls.set(LS_PROJECTS, projects);
    renderProjects();
    checkServer(true);
    poll();
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }
  function close() {
    page.hidden = true;
    updateBadge();
  }

  page.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') close();
    else if (act === 'check') checkServer();
    else if (act === 'pick') $('#odm-files').click();
    else if (act === 'pick-folder') $('#odm-folder').click();
    else if (act === 'start') start();
    else if (act === 'abort-upload') uploading?.abort();
    else if (act === 'geoid-file') $('#odm-geoid-file').click();
  });
  page.addEventListener('keydown', (e) => e.stopPropagation());

  /** Perpiešia dinamines dalis (pvz. pakeitus kalbą). */
  function rerender() {
    if (analysis) renderAnalysis();
    updateHeightPreview();
    updateStartSummary();
    $('#odm-preset-desc').textContent = PRESETS[preset].desc;
    renderProjects();
    if (!$('#odm-server-state').textContent.startsWith('●')) return;
    checkServer(true);
  }

  poll();
  return { open, close, rerender, get isOpen() { return !page.hidden; } };
}
