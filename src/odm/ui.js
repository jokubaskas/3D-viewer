// „Modelio kūrimas iš nuotraukų“ – vartotojo sąsaja (OpenDroneMap / NodeODM)
import { icon } from '../icons.js';
import { readAllMeta, rtkLabel } from './exif.js';
import { analyzePhotos, uniqueUploadNames, buildGeoTxt, buildOdmOptions, photoHeight, PRESETS, HEIGHT_MODES, ODM_OUTPUTS } from './project.js';
import { NodeODM, STATUS, STATUS_LABELS } from './nodeodm.js';
import { loadGeoidFile } from '../geo/geoid.js';

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

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = (v, d = 0) => (v == null || !isFinite(v) ? '—' : new Intl.NumberFormat('lt-LT', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v));
const fmtBytes = (b) => (b > 1e9 ? `${nf(b / 1e9, 1)} GB` : `${nf(b / 1e6, 0)} MB`);
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} val. ${m} min.` : m ? `${m} min. ${s % 60} s` : `${s} s`;
};

/**
 * @param {{toast:(msg:string,type?:string,ms?:number)=>void, openResult:(project:object, kind:'model'|'points')=>Promise<void>}} app
 */
export function createOdmUI(app) {
  // Atidarius HTML failą tiesiai iš disko – serveris pagal deploy/ numatytuosius nustatymus
  const server = ls.get(LS_SERVER, { url: location.protocol === 'file:' ? 'http://localhost:8080/odm/' : './odm/', token: '' });
  if (location.protocol === 'file:' && /^\.\//.test(server.url)) server.url = 'http://localhost:8080/odm/';
  let projects = ls.get(LS_PROJECTS, []);
  let client = new NodeODM(server.url, server.token);
  let analysis = null;
  let metas = [];
  let geoid = null; // GeoidGrid
  let uploading = null; // {abort, project}
  let pollTimer = null;

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
    saveServer();
    const st = $('#odm-server-state');
    st.textContent = 'Jungiamasi…';
    st.className = 'small muted';
    try {
      const i = await client.info();
      st.textContent = '● Prisijungta';
      st.className = 'small ok';
      $('#odm-server-info').innerHTML = `NodeODM ${esc(i.version)} · ODM ${esc(i.engineVersion || '')}<br>
        CPU branduolių: ${esc(i.cpuCores)} · Laisva RAM: ${i.availableMemory ? fmtBytes(i.availableMemory) : '—'} / ${i.totalMemory ? fmtBytes(i.totalMemory) : '—'}<br>
        Eilėje užduočių: ${esc(i.taskQueueCount)}${i.maxImages ? ` · Maks. nuotraukų: ${esc(i.maxImages)}` : ''}`;
      return i;
    } catch (e) {
      st.textContent = '● Nepavyko prisijungti';
      st.className = 'small bad';
      $('#odm-server-info').textContent = `${e.message.replace(/[.?!]?$/, (m) => m || ".")} Instrukcija – README skyrius „Serverio diegimas“.`;
      if (!quiet) app.toast('Nepavyko prisijungti prie apdorojimo serverio', 'error');
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
    box.innerHTML = `<div class="odm-progress"><div class="progress"><div class="progress-bar" style="width:0"></div></div><span class="small muted">Skaitomi ${nf(jpgs.length)} nuotraukų metaduomenys…</span></div>`;
    const t0 = performance.now();
    metas = await readAllMeta(jpgs, (p) => (box.querySelector('.progress-bar').style.width = `${Math.round(p * 100)}%`));
    console.info(`EXIF: ${jpgs.length} nuotr. per ${Math.round(performance.now() - t0)} ms`);
    reanalyze();
    if (!$('#odm-name').value) {
      const d = analysis.timeFrom || new Date();
      $('#odm-name').value = `Skrydis ${d.toLocaleDateString('lt-LT')} ${d.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit' })}`;
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
        ${stat('Nuotraukų', `${nf(n)}`, `iš ${nf(metas.length)} · ${fmtBytes(a.totalBytes)}`)}
        ${stat('RTK FIX', `${nf(fixPct, 0)} %`, `FLOAT ${a.rtk.float} · kita ${a.rtk.single + a.rtk.none + a.rtk.unknown}`, fixPct > 95 ? 'ok' : fixPct > 70 ? 'warn' : 'bad')}
        ${stat('RTK tikslumas', a.stdH != null ? `±${nf(a.stdH * 100, 1)} cm` : '—', a.stdV != null ? `aukštis ±${nf(a.stdV * 100, 1)} cm` : 'plokštumoje')}
        ${stat('Skrydžio aukštis', a.agl != null ? `${nf(a.agl, 0)} m` : '—', 'virš pakilimo vietos')}
        ${stat('GSD', a.gsd != null ? `${nf(a.gsd * 100, 2)} cm/px` : '—', 'žemės pikselio dydis')}
        ${stat('Plotas', `${nf(a.areaM2 / 10000, 2)} ha`, 'pagal nuotraukų vietas')}
        ${stat('Kamera', esc(a.models.join(', ') || '—'), a.versions.length ? `DJI XMP ${esc(a.versions.join(', '))}` : '')}
        ${stat('Laikas', a.timeFrom ? a.timeFrom.toLocaleDateString('lt-LT') : '—', a.timeFrom ? `${a.timeFrom.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit' })}–${a.timeTo.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit' })}` : '')}
      </div>
      ${a.warnings.length ? `<ul class="odm-warn">${a.warnings.map((w) => `<li class="${w.level}">${esc(w.text)}</li>`).join('')}</ul>` : '<p class="small ok">Nuotraukų rinkinys tvarkingas.</p>'}
      ${extraFiles.length ? `<p class="small">Pridėtas GCP failas: <b>${esc(extraFiles.map((f) => f.name).join(', '))}</b> (bus perduotas ODM).</p>` : ''}
      <div class="odm-map-wrap">
        <canvas id="odm-map"></canvas>
        <div class="odm-legend small"><span class="dot fix"></span>FIX <span class="dot float"></span>FLOAT <span class="dot other"></span>be RTK <span class="muted">· LKS-94</span></div>
        <div class="odm-map-tip small" hidden></div>
      </div>`;
    drawMap();
  }

  const stat = (label, value, sub, cls = '') => `<div class="odm-stat ${cls}"><span class="muted small">${label}</span><b>${value}</b><span class="muted small">${sub || ''}</span></div>`;

  function drawMap() {
    const cv = $('#odm-map');
    if (!cv || !analysis) return;
    const wrap = cv.parentElement;
    const W = wrap.clientWidth, H = 300, dpr = devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.height = `${H}px`;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = '#16191b';
    g.fillRect(0, 0, W, H);
    const pts = analysis.lks;
    if (!pts.length) return;
    let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const [e, n] of pts) {
      minE = Math.min(minE, e); maxE = Math.max(maxE, e);
      minN = Math.min(minN, n); maxN = Math.max(maxN, n);
    }
    const pad = 24;
    const s = Math.min((W - 2 * pad) / Math.max(maxE - minE, 1), (H - 2 * pad) / Math.max(maxN - minN, 1));
    const ox = (W - (maxE - minE) * s) / 2, oy = (H - (maxN - minN) * s) / 2;
    const P = (e, n) => [ox + (e - minE) * s, H - (oy + (n - minN) * s)];
    // Skrydžio trajektorija pagal laiką
    const order = analysis.used.map((m, i) => i).sort((a, b) => (analysis.used[a].date?.getTime() || 0) - (analysis.used[b].date?.getTime() || 0));
    g.strokeStyle = 'rgba(255,255,255,.12)';
    g.lineWidth = 1;
    g.beginPath();
    order.forEach((i, k) => {
      const [x, y] = P(...pts[i]);
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.stroke();
    const color = (m) => (m.rtkFlag === 50 ? '#3cc443' : m.rtkFlag === 34 ? '#ffb627' : '#ff5e57');
    analysis.used.forEach((m, i) => {
      const [x, y] = P(...pts[i]);
      g.fillStyle = color(m);
      g.beginPath();
      g.arc(x, y, 3, 0, Math.PI * 2);
      g.fill();
    });
    // Mastelio juosta
    const target = (W * 0.2) / s;
    const p10 = Math.pow(10, Math.floor(Math.log10(target)));
    const len = [1, 2, 5, 10].map((k) => k * p10).filter((v) => v <= target).pop() || p10;
    g.fillStyle = '#c3cac6';
    g.fillRect(12, H - 16, len * s, 3);
    g.font = '11px Inter, Segoe UI, sans-serif';
    g.fillText(`${nf(len)} m`, 12, H - 22);
    // Šiaurės rodyklė
    g.beginPath();
    g.moveTo(W - 18, 12);
    g.lineTo(W - 24, 28);
    g.lineTo(W - 12, 28);
    g.closePath();
    g.fill();
    g.fillText('Š', W - 22, 42);

    cv.onmousemove = (e) => {
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      let best = -1, bd = 64;
      pts.forEach((p, i) => {
        const [x, y] = P(...p);
        const d = (x - mx) ** 2 + (y - my) ** 2;
        if (d < bd) { bd = d; best = i; }
      });
      const tip = page.querySelector('.odm-map-tip');
      if (best < 0) return (tip.hidden = true);
      const m = analysis.used[best];
      tip.hidden = false;
      tip.style.left = `${mx + 12}px`;
      tip.style.top = `${my + 12}px`;
      tip.innerHTML = `<b>${esc(m.name)}</b><br>RTK ${rtkLabel(m.rtkFlag)}${m.stdLat != null ? ` ±${nf(Math.max(m.stdLat, m.stdLon) * 100, 1)} / ${nf(m.stdHgt * 100, 1)} cm` : ''}<br>Aukštis ${nf(m.absAlt ?? m.alt, 2)} m (virš pakil. ${nf(m.relAlt, 1)} m)`;
    };
    cv.onmouseleave = () => (page.querySelector('.odm-map-tip').hidden = true);
  }
  new ResizeObserver(() => !page.hidden && drawMap()).observe(page);

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
    if (takeoff != null) html += `<div>Pakilimo vietos aukštis nuotraukose: <b>${nf(takeoff, 2)} m</b></div>`;
    if (hm === 'ellipsoid') {
      if (N != null && isFinite(N)) {
        html += `<div>N objekto centre: <b>${nf(N, 3)} m</b> → pakilimo vieta LAS07 ≈ <b>${nf(takeoff - N, 2)} m</b></div>`;
        const H = photoHeight(sample, 'ellipsoid', fn);
        html += `<div class="muted">Pvz. ${esc(sample.name)}: h ${nf(sample.absAlt ?? sample.alt, 3)} → H ${nf(H, 3)} m</div>`;
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
      app.toast(`Nepavyko įkelti geoido: ${err.message}`, 'error');
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
    const n = analysis.used.length;
    // Labai apytikslis laikas (8 branduolių serveris, standartinė kokybė): ~6–10 s nuotraukai
    const perImg = { fast: 4, standard: 8, high: 18 }[preset];
    $('#odm-start-summary').innerHTML = `${nf(n)} nuotr. (${fmtBytes(analysis.totalBytes)}) · ${PRESETS[preset].label} · aukščiai: ${esc(heightSystem())}<br>Apytikslė trukmė: ${fmtDur(n * perImg * 1000)} – ${fmtDur(n * perImg * 2500)} (priklauso nuo serverio)`;
  }

  // ------------------------------------------------------------------ Paleidimas
  async function start() {
    if (!analysis?.used.length) return app.toast('Pirmiausia pasirinkite nuotraukas', 'error');
    if (uploading) return app.toast('Jau vyksta įkėlimas', 'error');
    const info = await checkServer(true);
    if (!info) return app.toast('Apdorojimo serveris nepasiekiamas', 'error');
    if (info.maxImages && analysis.used.length > info.maxImages) return app.toast(`Serveris priima iki ${info.maxImages} nuotraukų`, 'error');
    if ($('#odm-hmode').value === 'ellipsoid' && geoidMode() === 'const' && !geoidFn()) {
      return app.toast('Įveskite geoido aukštį N arba pasirinkite kitą variantą', 'error');
    }

    const name = $('#odm-name').value.trim() || 'Projektas';
    const entries = uniqueUploadNames(analysis.used);
    const geoTxt = buildGeoTxt(entries, $('#odm-hmode').value, geoidFn());
    const options = buildOdmOptions(preset, {
      dsm: $('#odm-dsm').checked, dtm: $('#odm-dtm').checked, ortho: $('#odm-ortho').checked, split: $('#odm-split').checked,
    });
    const items = entries.map((e) => ({ name: e.name, file: e.file }));
    items.push({ name: 'geo.txt', file: new Blob([geoTxt], { type: 'text/plain' }) });
    for (const f of extraFiles) items.push({ name: f.name, file: f });

    const project = {
      uuid: null, name, server: server.url, created: Date.now(), photos: entries.length,
      rtkFix: analysis.rtk.fix, preset, heightSystem: heightSystem(), status: 'uploading', progress: 0,
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
      project.uuid = await client.init(name, options, ODM_OUTPUTS);
      saveProject(project);
      const t0 = performance.now();
      await client.upload(project.uuid, items, (sent, total, done) => {
        const p = sent / total;
        const el = (performance.now() - t0) / 1000;
        const speed = sent / Math.max(el, 0.1);
        $('#odm-up-bar').style.width = `${(p * 100).toFixed(1)}%`;
        $('#odm-up-text').textContent = `${nf(p * 100, 1)} % · ${fmtBytes(sent)} / ${fmtBytes(total)} · ${nf(speed / 1e6, 1)} MB/s · liko ~${fmtDur(((total - sent) / Math.max(speed, 1)) * 1000)} · ${done}/${items.length} failų`;
      }, { signal: ctrl.signal });
      await client.commit(project.uuid);
      project.status = 'queued';
      saveProject(project);
      app.toast('Nuotraukos įkeltos – apdorojimas pradėtas. Galite uždaryti šį langą.');
      run.innerHTML = `<p>Projektas <b>${esc(name)}</b> perduotas apdoroti. Eigą matysite projektų sąraše kairėje – galite toliau dirbti ar net uždaryti naršyklę.</p>`;
      resetWizard();
      poll();
    } catch (e) {
      if (e.name === 'AbortError') app.toast('Įkėlimas nutrauktas', 'error');
      else app.toast(`Klaida: ${e.message}`, 'error', 8000);
      if (project.uuid) client.remove(project.uuid).catch(() => {});
      removeProject(project.uuid);
      run.innerHTML = `<p class="bad">Nepavyko: ${esc(e.message)}</p>`;
    } finally {
      uploading = null;
      renderProjects();
    }
  }

  function resetWizard() {
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
    if (code === STATUS.RUNNING) return `<span class="chip run">Apdorojama ${nf(p.progress, 0)} %</span>`;
    if (code === STATUS.QUEUED) return '<span class="chip">Eilėje</span>';
    return '<span class="chip">—</span>';
  }

  function renderProjects() {
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
        <div class="small muted">${new Date(p.created).toLocaleString('lt-LT')} · ${nf(p.photos)} nuotr. · ${esc(PRESETS[p.preset]?.label || '')}${p.processingTime ? ` · ${fmtDur(p.processingTime)}` : ''}</div>
        ${p.statusCode === STATUS.RUNNING ? `<div class="progress"><div class="progress-bar" style="width:${p.progress || 0}%"></div></div>` : ''}
        ${p.statusCode === STATUS.FAILED && p.error ? `<div class="small bad">${esc(p.error)}</div>` : ''}
        <div class="odm-proj-actions">
          ${p.statusCode === STATUS.COMPLETED ? `
            <button class="btn btn-sm btn-primary" data-pact="model" title="Atidaryti tekstūruotą 3D modelį LKS-94">${icon('cube')}3D modelis</button>
            <button class="btn btn-sm btn-outline" data-pact="points" title="Atidaryti taškų debesį LKS-94">Taškai</button>
            <a class="btn btn-sm btn-outline" href="${esc(new NodeODM(p.server, server.token).downloadUrl(p.uuid))}" download title="Atsisiųsti visus rezultatus (all.zip, UTM)"><span data-icon="save">${icon('save')}</span></a>` : ''}
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
    const c = new NodeODM(p.server, server.token);
    try {
      if (act === 'model' || act === 'points') {
        await app.openResult({ ...p, downloadUrl: c.downloadUrl(uuid) }, act);
        close();
      } else if (act === 'cancel') {
        if (confirm(`Atšaukti „${p.name}“ apdorojimą?`)) await c.cancel(uuid);
      } else if (act === 'restart') {
        await c.restart(uuid);
      } else if (act === 'delete') {
        if (!confirm(`Pašalinti projektą „${p.name}“ ir jo rezultatus serveryje?`)) return;
        await c.remove(uuid).catch(() => {});
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

  async function poll() {
    clearTimeout(pollTimer);
    let active = false;
    for (const p of projects) {
      if (!p.uuid || p.status === 'uploading' || p.status === 'missing') continue;
      if (p.statusCode === STATUS.COMPLETED || p.statusCode === STATUS.CANCELED) continue;
      if (p.statusCode === STATUS.FAILED && p._polledFailed) continue;
      try {
        const i = await new NodeODM(p.server, server.token).taskInfo(p.uuid);
        const prev = p.statusCode;
        p.statusCode = i.status?.code;
        p.error = i.status?.errorMessage;
        p.progress = i.progress;
        p.processingTime = i.processingTime;
        p.status = 'server';
        if (p.statusCode === STATUS.FAILED) p._polledFailed = true;
        if (prev !== STATUS.COMPLETED && p.statusCode === STATUS.COMPLETED) {
          app.toast(`Modelis „${p.name}“ paruoštas!`, 'info', 8000);
          notify(`Modelis „${p.name}“ paruoštas`);
        }
        if (p.statusCode === STATUS.QUEUED || p.statusCode === STATUS.RUNNING) active = true;
      } catch (e) {
        if (/not found|Invalid UUID|uuid/i.test(e.message)) p.status = 'missing';
      }
    }
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
    b.textContent = running.length ? `${running.length} apdorojama${running[0].statusCode === STATUS.RUNNING ? ` · ${nf(running[0].progress, 0)} %` : ''}` : `${done.length} paruošta`;
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

  poll();
  return { open, close, get isOpen() { return !page.hidden; } };
}
