// „Skrydžio planas“ – srities žymėjimas žemėlapyje, kameros ir persidengimo nustatymai, maršrutas, eksportas pultui
import { icon } from '../icons.js';
import { t, locale } from '../i18n.js';
import { readPhotoMeta } from '../odm/exif.js';
import { PlanMap } from './map.js';
import { CAMERAS, gsdAt, altForGsd, computePlan, toKML, toGeoJSON, toWPML, parseArea } from './plan.js';

const LS_CUR = 'atea3d.plan.current';
const LS_SAVED = 'atea3d.plan.saved';
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
const nf = (v, d = 0) => (v == null || !isFinite(v) ? '—' : new Intl.NumberFormat(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(v));
const safe = (s) => String(s || 'planas').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40);
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
const fmtMin = (s) => {
  const m = Math.round(s / 60);
  return m >= 60 ? t('{h} val. {m} min.', { h: Math.floor(m / 60), m: m % 60 }) : t('{m} min.', { m });
};

const DEFAULTS = {
  name: '',
  camera: 'raptorT12',
  custom: { f35: 24, width: 4000, height: 3000, interval: 2 },
  alt: 80,
  front: 80,
  side: 70,
  autoHeading: true,
  heading: 0,
  crosshatch: false,
  maxSpeed: 12,
  interval: null, // null – pagal kamerą
  battery: 35,
  poly: [],
  home: null,
  view: null,
};

/** @param {{toast:(msg:string,type?:string,ms?:number)=>void}} app */
export function createPlanUI(app) {
  let st = { ...DEFAULTS, ...ls.get(LS_CUR, {}) };
  st.custom = { ...DEFAULTS.custom, ...st.custom };
  let plan = null;

  const page = document.createElement('section');
  page.className = 'odm-page plan-page';
  page.hidden = true;
  page.innerHTML = `
    <header class="odm-head">
      <div>
        <h2>Skrydžio planas</h2>
        <p class="muted small">Pažymėkite teritoriją – programa apskaičiuos aukštį pagal norimą tikslumą (GSD), maršrutą, nuotraukų skaičių, trukmę ir akumuliatorius. Planą įkelkite į pultą (KML / KMZ).</p>
      </div>
      <button class="btn btn-ghost icon-only" data-act="close" title="Uždaryti">${icon('close')}</button>
    </header>
    <div class="odm-body">
      <aside class="odm-side">
        <section class="card" data-card="area">
          <h3>Teritorija</h3>
          <input id="pl-name" class="live-input" placeholder="Plano pavadinimas" />
          <div class="pane-actions">
            <button class="btn btn-sm btn-primary" data-pl="draw">${icon('area')}Žymėti sritį</button>
            <button class="btn btn-sm btn-outline" data-pl="import">${icon('upload')}KML / GeoJSON</button>
            <button class="btn btn-sm btn-ghost" data-pl="clear">${icon('trash')}Išvalyti</button>
          </div>
          <form id="pl-search" class="pl-search" autocomplete="off">
            <input id="pl-q" class="live-input" placeholder="Adresas arba koordinatės (54.90, 23.90)" />
            <button class="btn btn-sm btn-outline icon-only" type="submit" title="Ieškoti">${icon('target')}</button>
          </form>
          <div class="pane-actions">
            <button class="btn btn-sm btn-ghost" data-pl="locate">${icon('point')}Mano vieta</button>
            <button class="btn btn-sm btn-ghost" data-pl="home">${icon('navigate')}Pakilimo vieta</button>
          </div>
          <input type="file" id="pl-file" accept=".kml,.geojson,.json" hidden />
        </section>
        <section class="card" data-card="camera">
          <h3>Kamera ir tikslumas</h3>
          <select id="pl-camera" class="pl-wide"></select>
          <div id="pl-custom" class="pl-grid3" hidden>
            <label>Židinys (35 mm)<input id="pl-f35" type="number" class="num" min="5" max="400" step="0.1" /></label>
            <label>Plotis, px<input id="pl-w" type="number" class="num" min="100" step="1" /></label>
            <label>Aukštis, px<input id="pl-h" type="number" class="num" min="100" step="1" /></label>
          </div>
          <button class="btn btn-sm btn-ghost" data-pl="photo">${icon('camera')}Kamera iš nuotraukos…</button>
          <input type="file" id="pl-photo" accept=".jpg,.jpeg" hidden />
          <div class="pl-grid2">
            <label>GSD, cm/px<input id="pl-gsd" type="number" class="num" min="0.2" max="20" step="0.1" /></label>
            <label>Aukštis, m<input id="pl-alt" type="number" class="num" min="10" max="500" step="1" /></label>
          </div>
          <div id="pl-alt-warn" class="small bad" hidden></div>
        </section>
        <section class="card" data-card="overlap">
          <h3>Persidengimas ir skrydis</h3>
          <label class="row">Išilginis persidengimas <span><input id="pl-front" type="number" class="num" min="50" max="95" step="1" /> %</span></label>
          <label class="row">Skersinis persidengimas <span><input id="pl-side" type="number" class="num" min="40" max="95" step="1" /> %</span></label>
          <label class="row check"><input type="checkbox" id="pl-autoh" /> Kryptis automatiškai (mažiausiai posūkių)</label>
          <label class="row">Kryptis nuo šiaurės <span><input id="pl-heading" type="number" class="num" min="0" max="359" step="1" /> °</span></label>
          <label class="row check"><input type="checkbox" id="pl-cross" /> Kryžminis (dvigubas) – geresniam 3D modeliui</label>
          <label class="row">Didžiausias greitis <span><input id="pl-speed" type="number" class="num" min="1" max="20" step="0.5" /> m/s</span></label>
          <label class="row">Kadro intervalas <span><input id="pl-interval" type="number" class="num" min="0.3" max="10" step="0.1" /> s</span></label>
          <label class="row">Vieno akumuliatoriaus skrydis <span><input id="pl-battery" type="number" class="num" min="5" max="90" step="1" /> min</span></label>
        </section>
        <section class="card" data-card="saved">
          <h3>Išsaugoti planai</h3>
          <div class="pane-actions"><button class="btn btn-sm btn-outline" data-pl="save">${icon('save')}Išsaugoti šį planą</button></div>
          <div id="pl-saved"></div>
        </section>
      </aside>
      <div class="odm-main plan-main">
        <div class="plan-map-wrap">
          <canvas id="pl-map"></canvas>
          <div class="plan-map-tools">
            <select id="pl-basemap" title="Žemėlapis">
              <option value="satellite">Palydovinė</option>
              <option value="osm">OpenStreetMap</option>
            </select>
            <button class="btn btn-sm btn-ghost icon-only" data-pl="fit" title="Rodyti visą sritį">${icon('fit')}</button>
          </div>
          <div id="pl-hint" class="pv-hint small"></div>
        </div>
        <div id="pl-stats" class="odm-stats plan-stats"></div>
        <div id="pl-advice" class="small muted plan-advice"></div>
        <div class="pane-actions plan-export">
          <button class="btn btn-sm btn-primary" data-pl="kml">${icon('save')}KML (sritis + maršrutas)</button>
          <button class="btn btn-sm btn-outline" data-pl="kmz">${icon('save')}DJI WPML (KMZ)</button>
          <button class="btn btn-sm btn-outline" data-pl="geojson">${icon('save')}GeoJSON</button>
        </div>
      </div>
    </div>`;
  document.getElementById('app').append(page);
  const $ = (s) => page.querySelector(s);

  const map = new PlanMap($('#pl-map'), {
    onChange: (dragging) => {
      st.poly = map.closed ? map.poly.map((p) => [p[0], p[1]]) : [];
      if (!dragging) save();
      recompute();
    },
    onHome: (ll) => {
      st.home = ll;
      save();
      recompute();
    },
    overlay: drawOverlay,
  });

  // ------------------------------------------------------------------ nustatymai
  $('#pl-camera').innerHTML = Object.entries(CAMERAS)
    .map(([k, c]) => `<option value="${k}">${esc(t(c.label))}</option>`)
    .join('');

  const camera = () => (st.camera === 'custom' ? { ...CAMERAS.custom, ...st.custom } : CAMERAS[st.camera] || CAMERAS.raptorT12);

  function fillForm() {
    $('#pl-name').value = st.name || '';
    $('#pl-camera').value = st.camera;
    $('#pl-custom').hidden = st.camera !== 'custom';
    $('#pl-f35').value = st.custom.f35;
    $('#pl-w').value = st.custom.width;
    $('#pl-h').value = st.custom.height;
    $('#pl-alt').value = Math.round(st.alt);
    $('#pl-gsd').value = (gsdAt(camera(), st.alt) * 100).toFixed(2);
    $('#pl-front').value = st.front;
    $('#pl-side').value = st.side;
    $('#pl-autoh').checked = st.autoHeading;
    $('#pl-heading').value = Math.round(st.heading);
    $('#pl-heading').disabled = st.autoHeading;
    $('#pl-cross').checked = st.crosshatch;
    $('#pl-speed').value = st.maxSpeed;
    $('#pl-interval').value = st.interval ?? camera().interval;
    $('#pl-battery').value = st.battery;
    $('#pl-basemap').value = map.basemap;
  }

  const num = (sel, min, max) => {
    const v = parseFloat($(sel).value);
    return isFinite(v) ? Math.min(Math.max(v, min), max) : null;
  };
  page.addEventListener('input', (e) => {
    const id = e.target.id;
    if (!id?.startsWith('pl-') || ['pl-q', 'pl-file', 'pl-photo'].includes(id)) return;
    if (id === 'pl-name') st.name = e.target.value;
    else if (id === 'pl-camera') {
      st.camera = e.target.value;
      st.interval = null;
      $('#pl-custom').hidden = st.camera !== 'custom';
      $('#pl-interval').value = camera().interval;
      $('#pl-gsd').value = (gsdAt(camera(), st.alt) * 100).toFixed(2);
    } else if (['pl-f35', 'pl-w', 'pl-h'].includes(id)) {
      st.custom = { ...st.custom, f35: num('#pl-f35', 5, 400) || st.custom.f35, width: num('#pl-w', 100, 20000) || st.custom.width, height: num('#pl-h', 100, 20000) || st.custom.height };
      $('#pl-gsd').value = (gsdAt(camera(), st.alt) * 100).toFixed(2);
    } else if (id === 'pl-alt') {
      const a = num('#pl-alt', 5, 1000);
      if (a == null) return;
      st.alt = a;
      $('#pl-gsd').value = (gsdAt(camera(), st.alt) * 100).toFixed(2);
    } else if (id === 'pl-gsd') {
      const g = num('#pl-gsd', 0.05, 50);
      if (g == null) return;
      st.alt = Math.round(altForGsd(camera(), g / 100));
      $('#pl-alt').value = st.alt;
    } else if (id === 'pl-front') st.front = num('#pl-front', 30, 95) ?? st.front;
    else if (id === 'pl-side') st.side = num('#pl-side', 30, 95) ?? st.side;
    else if (id === 'pl-autoh') {
      st.autoHeading = e.target.checked;
      $('#pl-heading').disabled = st.autoHeading;
      if (!st.autoHeading && plan) $('#pl-heading').value = (st.heading = Math.round(plan.heading));
    } else if (id === 'pl-heading') st.heading = num('#pl-heading', 0, 359) ?? st.heading;
    else if (id === 'pl-cross') st.crosshatch = e.target.checked;
    else if (id === 'pl-speed') st.maxSpeed = num('#pl-speed', 1, 25) ?? st.maxSpeed;
    else if (id === 'pl-interval') st.interval = num('#pl-interval', 0.3, 10);
    else if (id === 'pl-battery') st.battery = num('#pl-battery', 5, 120) ?? st.battery;
    else if (id === 'pl-basemap') {
      map.basemap = e.target.value;
      map.redraw();
      return;
    }
    save();
    recompute();
  });

  function save() {
    st.view = { lon: map.lon, lat: map.lat, zoom: map.zoom };
    ls.set(LS_CUR, st);
  }

  // ------------------------------------------------------------------ skaičiavimas
  let raf = 0;
  function recompute() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const cam = camera();
      plan = st.poly.length >= 3
        ? computePlan(st.poly, { camera: cam, alt: st.alt, front: st.front, side: st.side, heading: st.autoHeading ? null : st.heading, crosshatch: st.crosshatch, speed: null, maxSpeed: st.maxSpeed, interval: st.interval ?? cam.interval, battery: st.battery, home: st.home })
        : null;
      renderStats();
      map.redraw();
      $('#pl-hint').textContent = map.hint();
    });
  }

  function renderStats() {
    const warn = $('#pl-alt-warn');
    warn.hidden = st.alt <= 120;
    warn.textContent = t('Lietuvoje be specialaus leidimo galima skristi iki 120 m virš žemės.');
    page.querySelectorAll('[data-pl=kml],[data-pl=kmz],[data-pl=geojson]').forEach((b) => (b.disabled = !plan));
    if (!plan) {
      $('#pl-stats').innerHTML = '';
      $('#pl-advice').innerHTML = esc(t('Pažymėkite teritoriją žemėlapyje – čia atsiras maršrutas ir jo skaičiai.'));
      return;
    }
    const stat = (label, value, cls = '') => `<div class="odm-stat ${cls}"><span class="small muted">${esc(t(label))}</span><b>${value}</b></div>`;
    $('#pl-stats').innerHTML = [
      stat('Plotas', `${nf(plan.area / 1e4, 2)} ha`),
      stat('GSD', `${nf(plan.gsd * 100, 2)} cm/px`),
      stat('Aukštis', `${nf(st.alt)} m`, st.alt > 120 ? 'warn' : ''),
      stat('Nuotraukų', nf(plan.photos), plan.photos > 1500 ? 'warn' : ''),
      stat('Linijų', `${nf(plan.lines)} · ${nf(plan.heading)}°`),
      stat('Maršrutas', `${nf(plan.length / 1000, 2)} km`),
      stat('Greitis', `${nf(plan.speed, 1)} m/s`),
      stat('Trukmė', fmtMin(plan.time)),
      stat('Akumuliatorių', nf(plan.batteries), plan.batteries > 1 ? 'warn' : 'ok'),
    ].join('');
    const tips = [];
    tips.push(t('Pulte nustatykite: aukštis {a} m, persidengimas {f} % / {s} %, kryptis {h}°, greitis iki {v} m/s.', { a: nf(st.alt), f: st.front, s: st.side, h: nf(plan.heading), v: nf(plan.speed, 1) }));
    if (plan.speedLimitedByCamera) tips.push(t('Greitį riboja kameros intervalas ({i} s): kas {d} m reikia nuotraukos.', { i: nf(st.interval ?? camera().interval, 1), d: nf(plan.photoStep, 1) }));
    if (plan.batteries > 1) tips.push(t('Reikės {n} akumuliatorių – skrydis bus pratęstas nuo tos vietos, kur sustojo (pulto funkcija „Tęsti misiją“).', { n: plan.batteries }));
    if (plan.photos > 1500) tips.push(t('Daug nuotraukų: apdorojimui reikės daug RAM. Su 16 GB kompiuteriu rinkitės didesnį GSD arba skaidykite teritoriją.'));
    if (!st.home) tips.push(t('Pažymėkite pakilimo vietą – trukmė bus skaičiuojama su skrydžiu iki teritorijos ir atgal.'));
    tips.push(t('Aukštis – nuo pakilimo vietos. Jei teritorijoje yra kalvų ar aukštų pastatų, atitinkamai padidinkite aukštį.'));
    $('#pl-advice').innerHTML = tips.map((x) => `<div>• ${esc(x)}</div>`).join('');
  }

  // ------------------------------------------------------------------ piešimas ant žemėlapio
  function drawOverlay(g, m) {
    if (st.home) {
      const [x, y] = m.toScreen(st.home);
      g.fillStyle = '#ffd23f';
      g.beginPath();
      g.arc(x, y, 9, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#1f2326';
      g.font = 'bold 11px Inter, Segoe UI, sans-serif';
      g.fillText('H', x - 4, y + 4);
    }
    if (!plan) return;
    // Vieno kadro pėdsakas maršruto pradžioje – kad matytųsi persidengimas
    const r = plan.routeLL;
    if (r.length >= 2) {
      const [x0, y0] = m.toScreen(r[0]), [x1, y1] = m.toScreen(r[1]);
      const ang = Math.atan2(y1 - y0, x1 - x0);
      const w = plan.footH / m.mPerPx, h = plan.footW / m.mPerPx;
      g.save();
      g.translate(x0, y0);
      g.rotate(ang);
      g.fillStyle = 'rgba(255,210,63,0.12)';
      g.strokeStyle = 'rgba(255,210,63,0.8)';
      g.setLineDash([4, 3]);
      g.lineWidth = 1;
      g.fillRect(-w / 2, -h / 2, w, h);
      g.strokeRect(-w / 2, -h / 2, w, h);
      g.restore();
      g.setLineDash([]);
    }
    g.lineWidth = 2;
    plan.passesLL.forEach((lines, pi) => {
      g.strokeStyle = pi ? '#ff9f43' : '#3cc443';
      g.beginPath();
      let first = true;
      for (const [a, b] of lines) {
        const pa = m.toScreen(a), pb = m.toScreen(b);
        if (first) g.moveTo(...pa);
        else g.lineTo(...pa);
        g.lineTo(...pb);
        first = false;
      }
      g.stroke();
    });
    // Nuotraukų vietos – tik kai jos ne per tankiai
    if (plan.photoStep / m.mPerPx > 6) {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      for (const p of plan.photosLL) {
        const [x, y] = m.toScreen(p);
        if (x < -5 || y < -5 || x > m.W + 5 || y > m.H + 5) continue;
        g.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    }
    // Pradžia ir pabaiga
    const mark = (p, label, color) => {
      const [x, y] = m.toScreen(p);
      g.fillStyle = color;
      g.beginPath();
      g.arc(x, y, 8, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.font = 'bold 10px Inter, Segoe UI, sans-serif';
      g.fillText(label, x - 3.5, y + 3.5);
    };
    mark(r[0], 'S', '#008b01');
    mark(r[r.length - 1], 'F', '#d93a32');
  }

  // ------------------------------------------------------------------ veiksmai
  page.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pl]');
    if (e.target.closest('[data-act=close]')) return close();
    if (!b) return;
    const act = b.dataset.pl;
    if (act === 'draw') map.startDrawing();
    else if (act === 'clear') {
      map.clear();
      st.home = null;
      save();
    } else if (act === 'import') $('#pl-file').click();
    else if (act === 'photo') $('#pl-photo').click();
    else if (act === 'fit') map.fit(st.home ? [...st.poly, st.home] : st.poly);
    else if (act === 'home') {
      map.mode = 'home';
      $('#pl-hint').textContent = map.hint();
    } else if (act === 'locate') {
      if (!navigator.geolocation) return app.toast('Naršyklė nepalaiko vietos nustatymo', 'error');
      navigator.geolocation.getCurrentPosition(
        (p) => map.setView(p.coords.longitude, p.coords.latitude, 17),
        (err) => app.toast(t('Vietos nustatyti nepavyko: {e}', { e: err.message }), 'error'),
        { enableHighAccuracy: true, timeout: 10000 },
      );
    } else if (act === 'save') savePlan();
    else if (act === 'kml' || act === 'kmz' || act === 'geojson') exportPlan(act);
    recompute();
  });

  $('#pl-search').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('#pl-q').value.trim();
    if (!q) return;
    const c = q.match(/^\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)\s*$/);
    if (c) {
      const a = parseFloat(c[1].replace(',', '.')), b = parseFloat(c[2].replace(',', '.'));
      // Lietuvoje platuma ~53–57, ilguma ~20–27: jei sukeista – sukeičiame
      const [lat, lon] = a > 40 && b < 40 ? [a, b] : [b, a];
      return map.setView(lon, lat, 17);
    }
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=${locale().slice(0, 2)}&q=${encodeURIComponent(q)}`);
      const [hit] = await r.json();
      if (!hit) return app.toast('Adresas nerastas', 'error');
      map.setView(+hit.lon, +hit.lat, 17);
    } catch (err) {
      app.toast(t('Paieška nepavyko: {e}', { e: err.message }), 'error');
    }
  });

  $('#pl-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const pts = parseArea(await f.text());
      map.setPolygon(pts);
      map.fit(pts);
      if (!st.name) $('#pl-name').value = st.name = f.name.replace(/\.[^.]+$/, '');
      save();
    } catch (err) {
      app.toast(t(err.message), 'error', 6000);
    }
  });

  // Kamera iš nuotraukos: 35 mm židinys ir kadro dydis iš EXIF
  $('#pl-photo').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const m = await readPhotoMeta(f);
    if (!m.f35 || !m.width) return app.toast('Nuotraukoje nėra objektyvo duomenų (35 mm židinio)', 'error', 6000);
    st.camera = 'custom';
    st.custom = { ...st.custom, f35: m.f35, width: m.width, height: m.height || Math.round((m.width * 3) / 4) };
    fillForm();
    save();
    recompute();
    app.toast(t('Kamera: {m}, {f} mm (35 mm), {w}×{h} px', { m: m.model || '—', f: m.f35, w: m.width, h: m.height }), 'success', 6000);
  });

  function exportPlan(kind) {
    if (!plan) return;
    const name = st.name || t('Skrydžio planas');
    const cam = camera();
    const s = { camera: cam, alt: st.alt, front: st.front, side: st.side };
    if (kind === 'kml') download(new Blob([toKML(name, st.poly, plan, st.alt)], { type: 'application/vnd.google-earth.kml+xml' }), `${safe(name)}.kml`);
    else if (kind === 'geojson') download(new Blob([toGeoJSON(name, st.poly, plan, s)], { type: 'application/geo+json' }), `${safe(name)}.geojson`);
    else {
      import('three/examples/jsm/libs/fflate.module.js').then(({ zipSync, strToU8 }) => {
        const files = Object.fromEntries(Object.entries(toWPML(name, plan, s)).map(([k, v]) => [k, strToU8(v)]));
        download(new Blob([zipSync(files)], { type: 'application/vnd.google-earth.kmz' }), `${safe(name)}.kmz`);
      });
    }
  }

  // ------------------------------------------------------------------ išsaugoti planai
  function savePlan() {
    if (st.poly.length < 3) return app.toast('Pirmiausia pažymėkite teritoriją', 'error');
    const name = st.name || prompt(t('Plano pavadinimas'), t('Skrydžio planas'));
    if (!name) return;
    st.name = name;
    $('#pl-name').value = name;
    const saved = ls.get(LS_SAVED, []).filter((x) => x.name !== name);
    saved.unshift({ ...st, saved: Date.now() });
    ls.set(LS_SAVED, saved.slice(0, 50));
    save();
    renderSaved();
    app.toast('Planas išsaugotas', 'success');
  }
  function renderSaved() {
    const saved = ls.get(LS_SAVED, []);
    $('#pl-saved').innerHTML = saved.length
      ? saved
          .map(
            (p, i) => `<div class="live-item" data-i="${i}">
          <button class="live-item-main" data-sp="load"><span class="live-item-text"><b>${esc(p.name)}</b><span class="muted small">${new Date(p.saved).toLocaleDateString(locale())} · ${nf(p.alt)} m · ${esc(t((CAMERAS[p.camera] || CAMERAS.custom).label))}</span></span></button>
          <button class="btn btn-ghost btn-sm icon-only" data-sp="del" title="${esc(t('Pašalinti'))}">${icon('trash')}</button>
        </div>`,
          )
          .join('')
      : `<p class="small muted">${esc(t('Išsaugoti planai lieka šioje naršyklėje.'))}</p>`;
  }
  $('#pl-saved').addEventListener('click', (e) => {
    const act = e.target.closest('[data-sp]')?.dataset.sp;
    const i = +e.target.closest('[data-i]')?.dataset.i;
    const saved = ls.get(LS_SAVED, []);
    if (!act || !saved[i]) return;
    if (act === 'del') {
      if (!confirm(t('Pašalinti „{n}“?', { n: saved[i].name }))) return;
      saved.splice(i, 1);
      ls.set(LS_SAVED, saved);
      return renderSaved();
    }
    st = { ...DEFAULTS, ...saved[i] };
    st.custom = { ...DEFAULTS.custom, ...st.custom };
    fillForm();
    map.setPolygon(st.poly);
    map.fit(st.poly);
    save();
    recompute();
  });

  // ------------------------------------------------------------------ atidarymas
  let first = true;
  function open() {
    page.hidden = false;
    if (first) {
      first = false;
      fillForm();
      if (st.poly.length >= 3) {
        map.setPolygon(st.poly);
        if (st.view) map.setView(st.view.lon, st.view.lat, st.view.zoom);
        else map.fit(st.poly);
      } else if (st.view) map.setView(st.view.lon, st.view.lat, st.view.zoom);
      renderSaved();
    }
    recompute();
  }
  function close() {
    page.hidden = true;
    save();
  }
  page.addEventListener('keydown', (e) => e.stopPropagation());
  window.addEventListener('keydown', (e) => {
    if (page.hidden || document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape' && e.target.tagName !== 'INPUT') {
      if (map.mode) {
        map.mode = null;
        if (!map.closed) map.clear();
        recompute();
      } else close();
    }
  });

  return {
    open,
    close,
    get isOpen() {
      return !page.hidden;
    },
    rerender() {
      if (!page.hidden) {
        $('#pl-camera').innerHTML = Object.entries(CAMERAS).map(([k, c]) => `<option value="${k}">${esc(t(c.label))}</option>`).join('');
        $('#pl-camera').value = st.camera;
        renderSaved();
        recompute();
      }
    },
  };
}
