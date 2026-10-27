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
    const d = b.drone, n = (link.tracks.get(b.key) || []).length;
    const warn = [];
    if (b.wind != null && b.wind >= WIND_WARN) warn.push(t('stiprus vėjas'));
    if (b.rain) warn.push(t('lyja'));
    if (d.battery != null && d.battery < 25) warn.push(t('silpna baterija'));
    const rows = [
      [t('Dronas'), [b.state, d.power === 'OFF' ? t('išjungtas') : '', d.battery != null ? t('baterija {p} %', { p: d.battery }) : '', b.rc != null ? `RC ${b.rc} %` : '', isAway(b) ? t('skrenda') : d.pos ? t('doke') : ''].filter(Boolean).join(' · ')],
      [t('Skrydis'), [d.alt != null ? t('aukštis {v} m', { v: nf(d.alt, 0) }) : '', d.speed != null ? `${nf(d.speed, 1)} m/s` : '', d.heading != null ? `${nf(d.heading, 0)}°` : ''].filter(Boolean).join(' · ')],
      [t('Oras'), [b.wind != null ? t('vėjas {v} m/s', { v: nf(b.wind, 1) }) : '', b.rain != null ? (b.rain ? t('lyja') : t('nelyja')) : '', b.extTemp != null ? t('lauke {v} °C', { v: nf(b.extTemp, 1) }) : ''].filter(Boolean).join(' · ')],
      [t('Dokas'), [b.temp != null ? t('viduje {v} °C', { v: nf(b.temp, 1) }) : '', b.charger === 'CHARGING' ? t('kraunama') : '', b.pilot ? t('pilotas {p}', { p: b.pilot }) : ''].filter(Boolean).join(' · ')],
      [t('Maršrutas'), n > 1 ? t('{n} taškų', { n }) : ''],
    ].filter(([, v]) => v);
    return `<div class="tm-box" data-box="${esc(b.key)}">
      <div class="row"><b>${esc(b.name)}</b><span class="chip ${b.status === 'ONLINE' ? 'ok' : ''}">${esc(t(STATUS[b.status] || b.status))}</span></div>
      ${rows.map(([k, v]) => `<div class="small"><span class="muted">${esc(k)}:</span> ${esc(v)}</div>`).join('')}
      ${warn.length ? `<div class="small bad">${esc(warn.join(' · '))}</div>` : ''}
      <div class="pane-actions">${b.dock || d.pos ? `<button class="btn btn-sm btn-ghost" data-tm="show">${icon('target')}${esc(t('Rodyti'))}</button>` : ''}${n > 1 ? `<button class="btn btn-sm btn-ghost" data-tm="gpx">${icon('save')}GPX</button><button class="btn btn-sm btn-ghost" data-tm="clear">${esc(t('Valyti maršrutą'))}</button>` : ''}</div>
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
    const label = (txt, x, y, color = '#fff') => {
      const w = g.measureText(txt).width + 10;
      g.fillStyle = 'rgba(20,23,25,.8)';
      g.fillRect(x - w / 2, y, w, 18);
      g.fillStyle = color;
      g.fillText(txt, x, y + 13);
    };
    // Maršrutai
    for (const tr of link.tracks.values()) {
      if (tr.length < 2) continue;
      g.strokeStyle = 'rgba(79,195,247,.95)';
      g.lineWidth = 2.5;
      g.beginPath();
      tr.forEach((p, i) => {
        const [x, y] = m.toScreen([p.lon, p.lat]);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.stroke();
    }
    for (const b of link.boxes.values()) {
      if (b.dock) {
        const [x, y] = m.toScreen([b.dock[1], b.dock[0]]);
        g.fillStyle = COLORS[b.status] || COLORS.OFFLINE;
        g.strokeStyle = '#fff';
        g.lineWidth = 2;
        g.fillRect(x - 7, y - 7, 14, 14);
        g.strokeRect(x - 7, y - 7, 14, 14);
        label(b.name + (b.status !== 'ONLINE' ? ` · ${t(STATUS[b.status] || b.status)}` : ''), x, y + 10);
      }
      const d = b.drone;
      if (d.pos && (isAway(b) || !b.dock)) {
        const [x, y] = m.toScreen([d.pos[1], d.pos[0]]);
        if (d.heading != null) {
          const a = (d.heading * Math.PI) / 180;
          g.fillStyle = '#ffb020';
          g.beginPath();
          g.moveTo(x + Math.sin(a) * 18, y - Math.cos(a) * 18);
          g.lineTo(x + Math.sin(a + 2.6) * 9, y - Math.cos(a + 2.6) * 9);
          g.lineTo(x + Math.sin(a - 2.6) * 9, y - Math.cos(a - 2.6) * 9);
          g.fill();
        }
        g.fillStyle = '#ffb020';
        g.strokeStyle = '#111';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, 7, 0, Math.PI * 2);
        g.fill();
        g.stroke();
        label([b.code || b.name, d.alt != null ? `${nf(d.alt, 0)} m` : '', d.battery != null ? `${d.battery} %` : ''].filter(Boolean).join(' · '), x, y - 32, '#ffcf6e');
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
