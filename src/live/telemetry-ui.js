// Transliacijos puslapio dalis „Dronai (diab)“: ryšio nustatymai, dokų ir dronų būsena, žemėlapio langelis.
import { icon } from '../icons.js';
import { t, locale } from '../i18n.js';
import { PlanMap } from '../plan/map.js';
import { DiabLink, DIAB_DEFAULT_URL, distM, keyExpiry, trackGpx } from './telemetry.js';

const LS_TM = 'atea3d.live.diab';
const WIND_WARN = 10; // m/s
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const nf = (v, d = 0) => new Intl.NumberFormat(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const STATUS = { ONLINE: 'Prisijungęs', OFFLINE: 'Atsijungęs', UNKNOWN: 'Nežinoma' };
const COLORS = { ONLINE: '#3cc443', OFFLINE: '#8a9490' };

/** Ar dronas ne doke (skrenda): pasitraukęs nuo doko > 5 m arba žinomas aukštis > 2 m. */
export const isAway = (b) => !!b?.drone?.pos && ((b.dock && distM(b.dock, b.drone.pos) > 5) || (b.drone.alt != null && b.drone.alt > 2));

const FRONT = '#ffb020'; // drono priekio (priekinių propelerių) spalva
const batColor = (p) => (p < 25 ? '#ff6b5e' : p < 50 ? '#ffb627' : '#3cc443');

/** Minimalistinis dronas (vaizdas iš viršaus, priekis – oranžiniai propeleriai ir rodyklė), pasuktas pagal kryptį. */
export function droneSvg(heading, cls = '') {
  const r = heading != null ? ` transform="rotate(${Math.round(heading)})"` : '';
  return `<svg class="tm-drone ${cls}" viewBox="-16 -16 32 32" aria-hidden="true"><g${r}>
<path d="M-8.5-8.5 8.5 8.5M8.5-8.5-8.5 8.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
<circle cx="-8.5" cy="-8.5" r="3.6" class="f"/><circle cx="8.5" cy="-8.5" r="3.6" class="f"/><circle cx="-8.5" cy="8.5" r="3.6" class="b"/><circle cx="8.5" cy="8.5" r="3.6" class="b"/>
<rect x="-2.6" y="-3.6" width="5.2" height="7.2" rx="2" fill="currentColor"/>
<path d="M-2.2-5.2 0-7.6 2.2-5.2z" fill="${FRONT}"/></g></svg>`;
}

/** Drono būsena žodžiu: skrenda / doke / išjungtas. */
function droneState(b) {
  if (b.drone.power === 'OFF') return { text: t('išjungtas'), cls: '' };
  if (isAway(b)) return { text: t('skrenda'), cls: 'fly' };
  if (b.drone.pos) return { text: t('doke'), cls: 'ok' };
  return { text: '', cls: '' };
}

/** Signalo stulpeliai (0–100 %). */
const bars = (v) => `<svg class="tm-bars" viewBox="0 0 16 12" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<rect x="${i * 4}" y="${9 - i * 3}" width="3" height="${3 + i * 3}" rx="1" class="${v > i * 25 ? 'on' : ''}"/>`).join('')}</svg>`;

/** Telemetrija transliacijos langelyje (ženkliukai ant vaizdo). */
export function telemetryChips(b) {
  if (!b) return '';
  const d = b.drone, st = droneState(b);
  const c = [`<span class="tm-c tm-c-name">${droneSvg(d.heading)}${esc(b.name)}${st.text ? `<em class="${st.cls}">${esc(st.text)}</em>` : ''}</span>`];
  if (d.battery != null) c.push(`<span class="tm-c"><i class="tm-batt"><i style="width:${Math.max(4, Math.min(100, d.battery))}%;background:${batColor(d.battery)}"></i></i>${d.battery} %</span>`);
  if (d.alt != null) c.push(`<span class="tm-c"><small>${esc(t('ALT'))}</small>${nf(d.alt, 0)} m</span>`);
  if (d.speed != null) c.push(`<span class="tm-c"><small>${esc(t('GS'))}</small>${nf(d.speed, 1)} m/s</span>`);
  if (b.rc != null && isAway(b)) c.push(`<span class="tm-c">${bars(b.rc)}${b.rc} %</span>`);
  return c.join('');
}

/** Trumpa eilutė transliacijos langeliui ir įrašui. */
export function telemetryLine(b) {
  if (!b) return '';
  const d = b.drone, parts = [b.name];
  if (b.state) parts.push(b.state);
  if (d.battery != null) parts.push(t('baterija {p} %', { p: d.battery }));
  if (d.alt != null) parts.push(`${nf(d.alt, 0)} m`);
  if (d.speed != null) parts.push(`${nf(d.speed, 1)} m/s`);
  if (d.pos) parts.push(`${d.pos[0].toFixed(6)}, ${d.pos[1].toFixed(6)}`);
  return parts.join(' · ');
}

/**
 * @param {{side:HTMLElement, after:HTMLElement, grid:HTMLElement, gateway:{resolve:()=>Promise<string|null>},
 *   onLayout:()=>void, onChange:()=>void, toast:(m:string,type?:string)=>void, download:(b:Blob,n:string)=>void}} o
 */
export function createTelemetryUI(o) {
  const cfg = { url: DIAB_DEFAULT_URL, key: '', via: 'auto', on: false, ...readCfg() };
  const link = new DiabLink({ gatewayBase: () => o.gateway.resolve().catch(() => null), onChange: () => render() });
  let mapEl = null, map = null, follow = true, fitted = false, zoomed = false;

  const card = document.createElement('section');
  card.className = 'card admin-only';
  card.dataset.card = 'diab';
  card.innerHTML = `
    <h3>Dronai (diab)</h3>
    <p class="small muted">Dokų ir dronų būsena bei vieta žemėlapyje iš diab. Transliacija, kurios pavadinime yra doko kodas (pvz. ATEA1), rodoma su to drono duomenimis.</p>
    <input id="tm-url" class="live-input" spellcheck="false" />
    <input id="tm-key" class="live-input" type="password" autocomplete="off" placeholder="Raktas (Sec-WebSocket-Protocol)" />
    <details class="small muted live-help"><summary>Kur rasti raktą?</summary>
      diab tinklalapyje: <b>F12 → Network → WS</b> → eilutė <b>dashboard</b> → <b>Headers</b> → <b>Request Headers</b> → <b>Sec-WebSocket-Protocol</b>. Nukopijuokite visą reikšmę. Raktas saugomas tik šioje naršyklėje; jei jis baigia galioti – nukopijuokite naują.
    </details>
    <label class="row">Ryšys
      <select id="tm-via">
        <option value="auto">Automatiškai</option>
        <option value="direct">Tiesiogiai naršyklėje</option>
        <option value="server">Per serverį</option>
      </select>
    </label>
    <div class="pane-actions"><button class="btn btn-sm btn-primary" data-tm="conn"></button><button class="btn btn-sm btn-outline" data-tm="map">${icon('map')}Žemėlapis</button></div>
    <div id="tm-status" class="small"></div>
    <div id="tm-boxes"></div>
    <details class="small muted live-help" id="tm-raw-wrap" hidden><summary>Gauti duomenys</summary>
      <p>Paskutinis diab pranešimas (be piloto duomenų). Skrydžio metu čia matysite visus laukus.</p>
      <pre id="tm-raw" class="tm-raw"></pre>
      <button class="btn btn-sm btn-ghost" data-tm="copy">${icon('copy')}Kopijuoti</button>
    </details>`;
  o.after.after(card);
  const $ = (s) => card.querySelector(s);
  $('#tm-url').value = cfg.url;
  $('#tm-key').value = cfg.key;
  $('#tm-via').value = cfg.via;

  function readCfg() {
    try {
      return JSON.parse(localStorage.getItem(LS_TM)) || {};
    } catch {
      return {};
    }
  }
  function save() {
    try {
      localStorage.setItem(LS_TM, JSON.stringify(cfg));
    } catch { /* ignoruojame */ }
  }

  card.addEventListener('change', (e) => {
    if (e.target.id === 'tm-url') cfg.url = e.target.value.trim() || DIAB_DEFAULT_URL;
    else if (e.target.id === 'tm-key') cfg.key = e.target.value.trim();
    else if (e.target.id === 'tm-via') cfg.via = e.target.value;
    else return;
    save();
    if (cfg.on) connect();
  });

  function connect() {
    if (!cfg.key) {
      o.toast(t('Įveskite diab raktą'), 'error');
      $('#tm-key').focus();
      return;
    }
    cfg.on = true;
    save();
    link.connect({ url: cfg.url, key: cfg.key, via: cfg.via });
  }

  card.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tm]');
    if (!b) return;
    const act = b.dataset.tm, key = b.closest('[data-box]')?.dataset.box;
    if (act === 'conn') {
      if (link.state === 'off') connect();
      else {
        cfg.on = false;
        save();
        link.disconnect();
      }
    } else if (act === 'map') showMap();
    else if (act === 'show') {
      showMap();
      const bx = link.boxes.get(key);
      const p = bx?.drone.pos || bx?.dock;
      if (p) {
        follow = false;
        map.setView(p[1], p[0], Math.max(map.zoom, 17));
        renderMapBar();
      }
    } else if (act === 'gpx') {
      const bx = link.boxes.get(key);
      o.download(new Blob([trackGpx(bx?.name || key, link.tracks.get(key) || [])], { type: 'application/gpx+xml' }), `marsrutas_${key}.gpx`);
    } else if (act === 'clear') link.clearTrack(key);
    else if (act === 'copy') {
      await navigator.clipboard.writeText($('#tm-raw').textContent).catch(() => {});
      o.toast(t('Nukopijuota'));
    }
  });

  // ---------------------------------------------------------------- būsena
  function render() {
    const st = link.state;
    $('[data-tm=conn]').textContent = t(st === 'off' ? 'Prisijungti' : 'Atsijungti');
    const exp = keyExpiry(cfg.key);
    let status = '';
    if (st === 'live') status = `<span class="chip ok">${esc(t('Prisijungta'))}</span> <span class="muted">${esc(link.mode === 'server' ? t('per serverį') : t('tiesiogiai'))} · ${esc(t('pranešimų: {n}', { n: link.count }))}</span>`;
    else if (st === 'connecting') status = `<span class="muted">${esc(t('Jungiamasi…'))}</span>`;
    else if (st === 'retry') status = `<span class="bad">${esc(link.error)}</span> <span class="muted">${esc(t('Bandoma vėl po {s} s…', { s: link.retryIn }))}</span>`;
    if (exp && st !== 'off') status += `<div class="muted">${esc(t(exp < Date.now() ? 'Raktas nebegalioja nuo {d}' : 'Raktas galioja iki {d}', { d: new Date(exp).toLocaleString(locale()) }))}</div>`;
    $('#tm-status').innerHTML = status;
    syncBoxes();
    $('#tm-raw-wrap').hidden = !link.raw;
    if (link.raw && $('#tm-raw-wrap').open) $('#tm-raw').textContent = JSON.stringify(link.other ? { ...link.raw, kitas: link.other } : link.raw, null, 2);
    if (map) {
      if (!fitted && link.boxes.size) fit();
      if (follow) {
        const flying = [...link.boxes.values()].find(isAway);
        // Pradėjus sekti – priartinama prie drono (vėliau mastelis paliekamas naudotojo pasirinktas)
        if (flying) map.setView(flying.drone.pos[1], flying.drone.pos[0], zoomed ? map.zoom : Math.max(map.zoom, 17));
        if (flying) zoomed = true;
      }
      map.redraw();
    }
    o.onChange();
  }
  $('#tm-raw-wrap').addEventListener('toggle', render);

  /**
   * Dokų kortelės atnaujinamos po vieną, o jų mygtukai paliekami tie patys DOM elementai (pakeičiami tik pasikeitus
   * mygtukų rinkiniui). Kitaip skrendant (pranešimai kas sekundę) mygtukas būtų perpieštas tarp paspaudimo ir
   * atleidimo – naršyklė tokio paspaudimo neužskaito.
   */
  function syncBoxes() {
    const wrap = $('#tm-boxes');
    const keys = new Set();
    for (const b of link.boxes.values()) {
      keys.add(b.key);
      const html = boxHtml(b);
      const el = [...wrap.children].find((x) => x.dataset.box === b.key);
      if (el?._html === html) continue;
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const nu = tmp.firstElementChild;
      const newAct = nu.querySelector('.pane-actions');
      nu._html = html;
      nu._act = newAct?.innerHTML; // lyginama su ankstesniu žymėjimu, ne su gyvu DOM
      if (!el) {
        wrap.append(nu);
        continue;
      }
      const oldAct = el.querySelector('.pane-actions');
      if (oldAct && newAct && el._act === nu._act) newAct.replaceWith(oldAct);
      el.replaceWith(nu);
    }
    for (const el of [...wrap.children]) if (!keys.has(el.dataset.box)) el.remove();
  }

  function boxHtml(b) {
    const d = b.drone, n = (link.tracks.get(b.key) || []).length, st = droneState(b);
    const warn = [];
    if (b.wind != null && b.wind >= WIND_WARN) warn.push(t('stiprus vėjas'));
    if (b.rain) warn.push(t('lyja'));
    if (d.battery != null && d.battery < 25) warn.push(t('silpna baterija'));
    const m = (label, value, extra = '') => `<div class="tm-m"><span>${esc(label)}</span><b>${value}</b>${extra}</div>`;
    const metrics = [
      d.battery != null ? m(t('Baterija'), `${d.battery} %`, `<i class="tm-bar"><i style="width:${Math.max(3, Math.min(100, d.battery))}%;background:${batColor(d.battery)}"></i></i>`) : '',
      d.alt != null ? m(t('Aukštis'), `${nf(d.alt, 0)} m`) : '',
      d.speed != null ? m(t('Greitis'), `${nf(d.speed, 1)} m/s`, d.vspeed != null && Math.abs(d.vspeed) >= 0.2 ? `<small>${d.vspeed > 0 ? '↑' : '↓'} ${nf(Math.abs(d.vspeed), 1)} m/s</small>` : '') : '',
      d.heading != null ? m(t('Kryptis'), `<svg class="tm-arrow" viewBox="-6 -6 12 12" aria-hidden="true"><path transform="rotate(${Math.round(d.heading)})" d="M0-5 3.6 4 0 2.2-3.6 4z"/></svg>${nf(((d.heading % 360) + 360) % 360, 0)}°`) : '',
      b.rc != null ? m(t('Signalas'), `${bars(b.rc)}${b.rc} %`) : '',
    ].filter(Boolean);
    const dock = [
      b.wind != null ? t('vėjas {v} m/s', { v: nf(b.wind, 1) }) : '',
      b.rain != null ? (b.rain ? t('lyja') : t('nelyja')) : '',
      b.extTemp != null ? t('lauke {v} °C', { v: nf(b.extTemp, 1) }) : '',
      b.temp != null ? t('viduje {v} °C', { v: nf(b.temp, 1) }) : '',
      b.charger === 'CHARGING' ? t('kraunama') : '',
      b.pilot ? t('pilotas {p}', { p: b.pilot }) : '',
    ].filter(Boolean);
    return `<div class="tm-box ${st.cls === 'fly' ? 'flying' : ''}" data-box="${esc(b.key)}">
      <div class="tm-head">
        <span class="tm-avatar ${st.cls}">${droneSvg(d.heading)}</span>
        <div class="tm-title"><b>${esc(b.name)}</b><span>${esc([st.text, b.state && !/fly|idle|dock|land/i.test(b.state) ? b.state : ''].filter(Boolean).join(' · '))}</span></div>
        <span class="chip ${b.status === 'ONLINE' ? 'ok' : ''}">${esc(t(STATUS[b.status] || b.status))}</span>
      </div>
      ${metrics.length ? `<div class="tm-metrics">${metrics.join('')}</div>` : ''}
      ${dock.length ? `<div class="tm-dock"><span>${esc(t('Dokas'))}</span>${dock.map((x) => `<i>${esc(x)}</i>`).join('')}</div>` : ''}
      ${warn.length ? `<div class="tm-warn">${warn.map((x) => `<span class="chip bad">${esc(x)}</span>`).join('')}</div>` : ''}
      <div class="pane-actions">${b.dock || d.pos ? `<button class="btn btn-sm btn-ghost" data-tm="show">${icon('target')}${esc(t('Rodyti'))}</button>` : ''}${n > 1 ? `<button class="btn btn-sm btn-ghost" data-tm="gpx">${icon('save')}GPX · ${esc(t('{n} taškų', { n }))}</button><button class="btn btn-sm btn-ghost" data-tm="clear">${esc(t('Valyti maršrutą'))}</button>` : ''}</div>
    </div>`;
  }

  // ---------------------------------------------------------------- žemėlapis
  function showMap() {
    if (mapEl) return mapEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    mapEl = document.createElement('div');
    mapEl.className = 'live-tile live-map-tile';
    mapEl.innerHTML = `<div class="live-view"><canvas></canvas></div>
      <div class="live-bar"><b class="live-title">${esc(t('Dronų žemėlapis'))}</b>
        <span class="live-tools">
          <button class="btn btn-ghost btn-sm icon-only" data-mt="follow" title="${esc(t('Sekti skrendantį droną'))}">${icon('navigate')}</button>
          <button class="btn btn-ghost btn-sm icon-only" data-mt="fit" title="${esc(t('Rodyti visus'))}">${icon('fit')}</button>
          <button class="btn btn-ghost btn-sm icon-only" data-mt="base" title="${esc(t('Palydovas / žemėlapis'))}">${icon('map')}</button>
          <button class="btn btn-ghost btn-sm icon-only" data-mt="close" title="${esc(t('Uždaryti'))}">${icon('close')}</button>
        </span></div>`;
    o.grid.prepend(mapEl);
    map = new PlanMap(mapEl.querySelector('canvas'), { overlay: drawOverlay });
    mapEl.querySelector('canvas').addEventListener('pointerdown', () => {
      follow = false;
      renderMapBar();
    });
    mapEl.addEventListener('click', (e) => {
      const a = e.target.closest('[data-mt]')?.dataset.mt;
      if (a === 'close') hideMap();
      else if (a === 'fit') fit();
      else if (a === 'follow') {
        follow = !follow;
        zoomed = false;
        render();
      } else if (a === 'base') {
        map.basemap = map.basemap === 'satellite' ? 'osm' : 'satellite';
        map.redraw();
      }
      renderMapBar();
    });
    fitted = zoomed = false;
    renderMapBar();
    o.onLayout();
    requestAnimationFrame(() => render());
  }
  function hideMap() {
    mapEl?.remove();
    mapEl = map = null;
    o.onLayout();
  }
  function renderMapBar() {
    mapEl?.querySelector('[data-mt=follow]').classList.toggle('on', follow);
  }
  function fit() {
    const pts = [];
    for (const b of link.boxes.values()) {
      if (b.dock) pts.push([b.dock[1], b.dock[0]]);
      if (isAway(b)) pts.push([b.drone.pos[1], b.drone.pos[0]]);
    }
    if (!pts.length) return;
    fitted = true;
    if (pts.length === 1) map.setView(pts[0][0], pts[0][1], 16);
    else map.fit(pts);
  }

  function drawOverlay(g, m) {
    g.save();
    g.font = '600 12px Inter, Segoe UI, sans-serif';
    g.textAlign = 'center';
    const pill = (x, y, w, h, r) => {
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, w, h, r);
      else g.rect(x, y, w, h);
    };
    const label = (txt, x, y, color = '#fff') => {
      const w = g.measureText(txt).width + 14;
      g.fillStyle = 'rgba(20,23,25,.82)';
      pill(x - w / 2, y, w, 20, 10);
      g.fill();
      g.fillStyle = color;
      g.fillText(txt, x, y + 14);
    };
    // Maršrutai: tamsus kontūras + šviesi linija
    for (const tr of link.tracks.values()) {
      if (tr.length < 2) continue;
      const pts = tr.map((p) => m.toScreen([p.lon, p.lat]));
      g.lineJoin = g.lineCap = 'round';
      for (const [w, c] of [[6, 'rgba(10,20,30,.55)'], [3, 'rgba(79,195,247,.95)']]) {
        g.strokeStyle = c;
        g.lineWidth = w;
        g.beginPath();
        pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.stroke();
      }
    }
    for (const b of link.boxes.values()) {
      if (b.dock) {
        const [x, y] = m.toScreen([b.dock[1], b.dock[0]]);
        // Dokas – nusileidimo aikštelė su „H“
        g.fillStyle = 'rgba(20,23,25,.85)';
        g.strokeStyle = COLORS[b.status] || COLORS.OFFLINE;
        g.lineWidth = 2.5;
        pill(x - 11, y - 11, 22, 22, 6);
        g.fill();
        g.stroke();
        g.fillStyle = '#fff';
        g.font = '800 12px Inter, Segoe UI, sans-serif';
        g.fillText('H', x, y + 4.5);
        g.font = '600 12px Inter, Segoe UI, sans-serif';
        label(b.name + (b.status !== 'ONLINE' ? ` · ${t(STATUS[b.status] || b.status)}` : ''), x, y + 15);
      }
      const d = b.drone;
      if (d.pos && (isAway(b) || !b.dock)) {
        const [x, y] = m.toScreen([d.pos[1], d.pos[0]]);
        drawDrone(g, x, y, d.heading);
        label([b.code || b.name, d.alt != null ? `${nf(d.alt, 0)} m` : '', d.battery != null ? `${d.battery} %` : ''].filter(Boolean).join(' · '), x, y - 44, '#ffcf6e');
      }
    }
    if (!link.boxes.size) {
      g.textAlign = 'center';
      label(t(link.state === 'off' ? 'Prisijunkite prie diab kairėje' : 'Laukiama duomenų…'), m.W / 2, m.H / 2 - 9);
    }
    g.restore();
  }

  if (cfg.on && cfg.key) connect();
  else render();

  return {
    link,
    get mapShown() {
      return !!mapEl;
    },
    /**
     * Dokas pagal transliacijos pavadinimą; jei pavadinime jo nėra – vienintelis dokas
     * arba vienintelis šiuo metu skrendantis dronas.
     */
    boxFor: (name) => {
      const m = link.match(name);
      if (m) return m;
      const all = [...link.boxes.values()];
      if (all.length === 1) return all[0];
      const fly = all.filter(isAway);
      return fly.length === 1 ? fly[0] : null;
    },
  };
}

/** Dronas žemėlapyje (kaip droneSvg, tik drobėje): šviesus rėmas, oranžiniai priekiniai propeleriai, pasuktas pagal kryptį. */
function drawDrone(g, x, y, heading) {
  g.save();
  g.translate(x, y);
  // Šešėlis-aureolė, kad matytųsi ir ant palydovinės nuotraukos
  g.fillStyle = 'rgba(15,18,20,.45)';
  g.beginPath();
  g.arc(0, 0, 26, 0, Math.PI * 2);
  g.fill();
  if (heading != null) g.rotate((heading * Math.PI) / 180);
  g.scale(1.45, 1.45);
  g.lineCap = g.lineJoin = 'round';
  const A = 8.5, R = 3.6;
  // Rėmas (tamsus kontūras, kad matytųsi ir ant šviesaus pagrindo)
  for (const [w, c] of [[3.4, '#111'], [1.7, '#fff']]) {
    g.strokeStyle = c;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(-A, -A);
    g.lineTo(A, A);
    g.moveTo(A, -A);
    g.lineTo(-A, A);
    g.stroke();
  }
  // Propeleriai: priekiniai – oranžiniai
  for (const [px, py, front] of [[-A, -A, 1], [A, -A, 1], [-A, A, 0], [A, A, 0]]) {
    g.beginPath();
    g.arc(px, py, R, 0, Math.PI * 2);
    g.fillStyle = front ? '#6b4a10' : '#2a2f33';
    g.fill();
    g.lineWidth = 1.4;
    g.strokeStyle = front ? FRONT : '#fff';
    g.stroke();
  }
  // Korpusas ir priekio rodyklė
  g.fillStyle = '#fff';
  g.strokeStyle = '#111';
  g.lineWidth = 0.9;
  g.beginPath();
  if (g.roundRect) g.roundRect(-2.6, -3.6, 5.2, 7.2, 2);
  else g.rect(-2.6, -3.6, 5.2, 7.2);
  g.fill();
  g.stroke();
  g.fillStyle = FRONT;
  g.beginPath();
  g.moveTo(-2.2, -5.2);
  g.lineTo(0, -7.6);
  g.lineTo(2.2, -5.2);
  g.closePath();
  g.fill();
  g.restore();
}
