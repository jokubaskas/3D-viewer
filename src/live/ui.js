// „Tiesioginė transliacija“ – nuorodų sąrašas, kelių transliacijų vaizdas, kadrai ir įrašymas
import { icon } from '../icons.js';
import { t, locale } from '../i18n.js';
import { classify, LiveGateway } from './sources.js';
import { LivePlayer } from './player.js';
import { LiveDetector, AI_DETAIL, AI_GROUPS, datasetZip, activeGroups, TRACK_MEMORY, hasStates, LOCK_SCORES, classColor, classLabel } from './ai.js';
import { trackGpx } from './telemetry.js';
import { AiComposer, FlightLog, drawComposite, flightReportZip, reportZip } from './report.js';
import { createTelemetryUI, telemetryChips } from './telemetry-ui.js';
import { api, uploadFile } from '../portal/api.js';

const LS_STREAMS = 'atea3d.live.streams';
const LS_PUSH = 'atea3d.live.push';
const LS_AI = 'atea3d.live.ai';
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
const nf = (v, d = 0) => new Intl.NumberFormat(locale(), { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const id = () => Math.random().toString(36).slice(2, 10);
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const safe = (s) => String(s || 'transliacija').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40);
const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
/** Rodomas adresas be slaptažodžio. */
function shortUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '•••';
    return u.href.replace(/\/$/, '');
  } catch {
    return url;
  }
}

/** @param {{toast:(msg:string,type?:string,ms?:number)=>void, onActive?:(n:number)=>void}} app */
export function createLiveUI(app) {
  const gateway = new LiveGateway();
  let streams = ls.get(LS_STREAMS, []);
  const tiles = new Map(); // stream.id -> {stream, player, el}
  let gwState = null; // null | 'ok' | klaidos tekstas
  let pushed = []; // serveryje gaunamos transliacijos
  let gwTimer = null;
  let recTimer = null;
  let tm = null; // dronų telemetrija (diab)

  const page = document.createElement('section');
  page.className = 'odm-page live-page';
  page.hidden = true;
  page.innerHTML = `
    <header class="odm-head">
      <div>
        <h2>Tiesioginė transliacija</h2>
        <p class="muted small admin-only">Dronų, kamerų ir svetainių transliacijos, AI aptikimas, kadrai ir įrašai.</p>
        <p class="muted small client-only">Jums priskirtos transliacijos. Galite įjungti AI aptikimą ir pasirinkti, kokie objektai atpažįstami.</p>
      </div>
      <button class="btn btn-ghost icon-only" data-act="close" title="Uždaryti">${icon('close')}</button>
    </header>
    <div class="odm-body">
      <aside class="odm-side">
        <section class="card admin-only" data-card="add">
          <h3>Nauja transliacija</h3>
          <form id="live-add" autocomplete="off">
            <input id="live-url" class="live-input" placeholder="rtsp://…, rtmp://…, https://….m3u8, YouTube…" spellcheck="false" />
            <div id="live-kind" class="small muted live-kind"></div>
            <input id="live-name" class="live-input" placeholder="Pavadinimas (nebūtinas)" />
            <input id="live-auth" class="live-input" type="password" autocomplete="off" placeholder="Raktas / prisijungimas (nebūtinas)" title="Jei serveris reikalauja prisijungimo: raktas (token, JWT), „Bearer …“ arba vartotojas:slaptažodis" />
            <label class="row">Rodymas
              <select id="live-via">
                <option value="auto">Automatiškai</option>
                <option value="direct">Tiesiogiai naršyklėje</option>
                <option value="server">Per serverį</option>
              </select>
            </label>
            <button class="btn btn-primary" type="submit" style="width:100%">${icon('play')}Žiūrėti</button>
          </form>
          <details class="small muted live-help">
            <summary>Kokios nuorodos tinka?</summary>
            <ul>
              <li><b>RTSP, RTMP, SRT</b> (dronai, IP kameros) – per serverį, rodoma per WebRTC (~0,5 s vėlavimas) arba HLS.</li>
              <li><b>HLS (.m3u8), MP4 / WebM, WebRTC (…/whep)</b> – tiesiogiai naršyklėje.</li>
              <li><b>MJPEG</b> ir kameros kadras (snapshot.jpg) – tiesiogiai.</li>
              <li><b>YouTube, Twitch, Vimeo</b> – įterptas grotuvas (be kadrų ir įrašymo).</li>
            </ul>
            Slaptažodį galima įrašyti nuorodoje: rtsp://vartotojas:slaptazodis@192.168.1.64:554/…
          </details>
        </section>
        <section class="card admin-only" data-card="saved">
          <h3>Išsaugotos</h3>
          <div id="live-list"></div>
        </section>
        <section class="card portal-card" data-card="mine">
          <h3 id="live-mine-title">Mano gyvos transliacijos</h3>
          <div id="live-mine"></div>
        </section>
        <section class="card" data-card="ai">
          <h3>AI aptikimas</h3>
          <p class="small muted">Įjunkite prie transliacijos mygtuku ${icon('magic')}. Kadrai analizuojami šio kompiuterio AI paslaugoje (be interneto).</p>
          <label class="row">Modelis <select id="live-ai-model"></select></label>
          <div id="live-ai-groups" class="live-ai-groups"></div>
          <div class="small muted admin-only" style="margin-top:6px">Į įrašo ataskaitos įvykius:</div>
          <div id="live-ai-report" class="live-ai-groups admin-only"></div>
          <label class="row">Detalumas
            <select id="live-ai-detail"></select>
          </label>
          <label class="row">Jautrumas <span class="live-ai-th"><input id="live-ai-th" type="range" min="0.2" max="0.8" step="0.05" /><span id="live-ai-th-v" class="small muted"></span></span></label>
          <label class="row check"><input type="checkbox" id="live-ai-track" /> Sekti objektus (#numeriai; grįžęs objektas – ne naujas)</label>
          <label class="row" id="live-ai-mem-row">Prisiminti dingusį objektą <select id="live-ai-mem"></select></label>
          <label class="row check" id="live-ai-stab-row"><input type="checkbox" id="live-ai-stab" /> Fiksuoti šalmo būseną (kol neaišku – „Žmogus“)</label>
          <label class="row" id="live-ai-lock-row">Fiksuoti, kai AI tikras ≥ <select id="live-ai-lock"></select></label>
          <label class="row check"><input type="checkbox" id="live-ai-alert" /> <span id="live-ai-alert-l">Įspėti, kai aptinkamas žmogus</span></label>
          <label class="row" id="live-ai-alert-row" hidden>Įspėti, kai aptinkama <select id="live-ai-alert-class"></select></label>
          <label class="row check admin-only"><input type="checkbox" id="live-ai-collect" /> Kaupti kadrus modelio mokymui</label>
          <div id="live-ai-ds" class="small muted admin-only"></div>
        </section>
        <section class="card admin-only" data-card="train">
          <h3>Savas AI modelis</h3>
          <p class="small muted">Apmokykite AI atpažinti tai, ko reikia jums (pvz. žmones su šalmais ir be jų) – iš Label Studio / CVAT YOLO eksporto. Mokoma šiame kompiuteryje.</p>
          <div id="live-train"></div>
          <div class="pane-actions"><button class="btn btn-sm btn-outline" data-tr="new">${icon('magic')}Mokyti naują modelį…</button></div>
          <div id="live-models"></div>
        </section>
        <section class="card admin-only" data-card="push">
          <h3>Drono transliacija į šį kompiuterį</h3>
          <div class="row"><span>Serveris</span><span id="live-gw" class="chip">…</span></div>
          <p class="small muted">Valdymo pulte (pvz. DJI Pilot, Anzu Smart Control) pasirinkite <b>Transliacija → RTMP</b> ir įveskite adresą. Pultas ir šis kompiuteris turi būti tame pačiame tinkle.</p>
          <label class="row">Pavadinimas <input id="live-push-name" class="num wide" style="text-align:left" spellcheck="false" /></label>
          <div id="live-push-urls"></div>
          <div id="live-pushed"></div>
        </section>
      </aside>
      <div class="odm-main live-main">
        <div id="live-grid" class="live-grid" data-n="0"></div>
        <div id="live-empty" class="live-empty">
          ${icon('live')}
          <b>Nėra rodomų transliacijų</b>
          <span class="muted small admin-only">Įklijuokite nuorodą kairėje arba pasirinkite išsaugotą.</span>
          <span class="muted small client-only">Pasirinkite transliaciją kairėje.</span>
        </div>
      </div>
    </div>`;
  document.getElementById('app').append(page);
  const $ = (s) => page.querySelector(s);
  tm = createTelemetryUI({
    after: page.querySelector('#live-list').closest('section'),
    grid: $('#live-grid'),
    gateway,
    onLayout: () => layout(),
    onChange: () => tiles.forEach((_, k) => renderTm(k)),
    toast: app.toast,
    download,
  });
  const dlgTrain = document.createElement('dialog');
  dlgTrain.className = 'dialog';
  dlgTrain.innerHTML = `<form method="dialog">
      <h2>Mokyti savo modelį</h2>
      <p class="small muted">YOLO formato ZIP iš Label Studio (Export → YOLO), CVAT ar Roboflow: images/, labels/ ir classes.txt. Rinkinys padalijamas 85 / 15 (mokymas / patikra), mokoma nuo standartinio modelio.</p>
      <label class="row">Rinkinys (ZIP) <input type="file" id="tr-file" accept=".zip" required /></label>
      <div id="tr-info" class="small muted"></div>
      <label class="row">Pavadinimas <input id="tr-name" class="num wide" style="text-align:left;width:200px" value="Šalmai" /></label>
      <label class="row">Modelio dydis
        <select id="tr-size">
          <option value="nano">Mažas – greičiausias (transliacijai)</option>
          <option value="small" selected>Vidutinis – rekomenduojamas</option>
          <option value="medium">Didelis – tiksliausias, lėčiausias</option>
        </select>
      </label>
      <label class="row">Epochų (kartų per visą rinkinį) <input id="tr-epochs" type="number" class="num" min="1" max="300" value="40" /></label>
      <div id="tr-est" class="small muted"></div>
      <menu>
        <button value="cancel" class="btn btn-ghost" formnovalidate>Atšaukti</button>
        <button value="ok" class="btn btn-primary">Pradėti mokymą</button>
      </menu>
    </form>`;
  page.append(dlgTrain);
  $('#live-push-name').value = ls.get(LS_PUSH, 'drone');

  // ------------------------------------------------------------------ Nauja nuoroda
  const KIND_TEXT = {
    gateway: 'per serverį (WebRTC / HLS)',
    whep: 'WebRTC',
    hls: 'HLS',
    file: 'vaizdo failas / srautas',
    mjpeg: 'MJPEG',
    image: 'kameros kadras (atnaujinamas kas sekundę)',
    embed: 'įterptas grotuvas',
    auto: 'bus nustatyta automatiškai',
  };
  $('#live-url').addEventListener('input', () => {
    const v = $('#live-url').value.trim();
    const c = v ? classify(v) : null;
    $('#live-kind').textContent = !c ? '' : c.kind === 'invalid' ? t('Netinkama nuoroda') : `${c.label ? `${c.label} · ` : ''}${t(KIND_TEXT[c.kind])}`;
    $('#live-kind').classList.toggle('bad', c?.kind === 'invalid');
  });
  $('#live-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#live-url').value.trim();
    if (!url) return $('#live-url').focus();
    const c = classify(url);
    if (c.kind === 'invalid') return app.toast('Netinkama nuoroda', 'error');
    let s = streams.find((x) => x.url === url && !x.path);
    if (!s) {
      let name = $('#live-name').value.trim();
      if (!name) {
        try {
          const u = new URL(url);
          name = c.kind === 'embed' ? c.label : `${u.hostname}${u.pathname.length > 1 ? u.pathname.replace(/\/(index\.m3u8|whep)$/i, '') : ''}`;
        } catch {
          name = url;
        }
      }
      s = { id: id(), name, url, via: $('#live-via').value, muted: true };
      streams.unshift(s);
    } else s.via = $('#live-via').value;
    if ($('#live-auth').value.trim()) s.auth = $('#live-auth').value.trim();
    const open = tiles.get(s.id);
    if (open) {
      open.player.retries = 0;
      open.player.start();
    }
    save();
    $('#live-url').value = '';
    $('#live-name').value = '';
    $('#live-auth').value = '';
    $('#live-kind').textContent = '';
    show(s);
  });

  function save() {
    ls.set(LS_STREAMS, streams.filter((s) => !s.temp));
    renderList();
  }

  // ------------------------------------------------------------------ Išsaugotų sąrašas
  function renderList() {
    const list = streams.filter((s) => !s.temp);
    $('#live-list').innerHTML = list.length
      ? list
          .map(
            (s) => `
        <div class="live-item${tiles.has(s.id) ? ' on' : ''}" data-id="${s.id}">
          <button class="live-item-main" data-lact="toggle" title="${esc(tiles.has(s.id) ? t('Uždaryti') : t('Žiūrėti'))}">
            <span class="live-dot ${tiles.get(s.id)?.player.state || ''}"></span>
            <span class="live-item-text"><b>${esc(s.name)}</b><span class="muted small">${esc(shortUrl(s.url))}</span></span>
          </button>
          <button class="btn btn-ghost btn-sm icon-only" data-lact="rename" title="${esc(t('Pavadinimas ir raktas'))}">${icon('edit')}</button>
          <button class="btn btn-ghost btn-sm icon-only" data-lact="delete" title="${esc(t('Pašalinti'))}">${icon('trash')}</button>
        </div>`,
          )
          .join('')
      : `<p class="small muted">${t('Kol kas nėra. Pridėtos nuorodos įsimenamos šioje naršyklėje.')}</p>`;
  }
  $('#live-list').addEventListener('click', (e) => {
    const act = e.target.closest('[data-lact]')?.dataset.lact;
    const s = streams.find((x) => x.id === e.target.closest('[data-id]')?.dataset.id);
    if (!act || !s) return;
    if (act === 'toggle') tiles.has(s.id) ? hide(s.id) : show(s);
    else if (act === 'rename') {
      const n = prompt(t('Pavadinimas'), s.name);
      if (n === null) return;
      if (n.trim()) s.name = n.trim();
      const a = prompt(t('Raktas / prisijungimas (jei serveris jo reikalauja; palikite tuščią, jei nereikia)'), s.auth || '');
      if (a !== null) s.auth = a.trim() || undefined;
      save();
      const tile = tiles.get(s.id);
      if (tile) {
        tile.el.querySelector('.live-title').textContent = s.name;
        if (a !== null) {
          tile.player.retries = 0;
          tile.player.start();
        }
      }
    } else if (act === 'delete') {
      if (!confirm(t('Pašalinti „{n}“?', { n: s.name }))) return;
      hide(s.id);
      streams = streams.filter((x) => x !== s);
      save();
    }
  });

  // ------------------------------------------------------------------ Langeliai
  function show(stream) {
    if (tiles.has(stream.id)) {
      tiles.get(stream.id).el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    const el = document.createElement('div');
    el.className = 'live-tile';
    el.dataset.id = stream.id;
    el.innerHTML = `
      <div class="live-view"><div class="live-host"></div>
        <div class="live-overlay"><span class="live-badge"></span><span class="live-stat"></span><span class="live-ai-sum" hidden></span><span class="live-tm" hidden></span></div>
        <div class="live-msg" hidden></div>
      </div>
      <div class="live-bar">
        <b class="live-title">${esc(stream.name)}</b>
        <span class="live-rec" hidden></span>
        <span class="live-tools">
          <button class="btn btn-ghost btn-sm icon-only" data-tact="ai" title="AI: žmonės ir transportas">${icon('magic')}</button>
          <button class="btn btn-ghost btn-sm icon-only" data-tact="sound" title="Garsas">${icon('mute')}</button>
          <button class="btn btn-ghost btn-sm icon-only admin-only" data-tact="snap" title="Kadras (PNG)">${icon('camera')}</button>
          <button class="btn btn-ghost btn-sm icon-only admin-only" data-tact="rec" title="Įrašyti">${icon('record')}</button>
          <button class="btn btn-ghost btn-sm icon-only admin-only portal-only" data-tact="publish" title="Priskirti klientams">${icon('user')}</button>
          <button class="btn btn-ghost btn-sm icon-only" data-tact="reload" title="Prisijungti iš naujo">${icon('refresh')}</button>
          <button class="btn btn-ghost btn-sm icon-only" data-tact="full" title="Visas ekranas">${icon('fullscreen')}</button>
          <button class="btn btn-ghost btn-sm icon-only" data-tact="close" title="Uždaryti">${icon('close')}</button>
        </span>
      </div>`;
    $('#live-grid').append(el);
    const player = new LivePlayer(el.querySelector('.live-host'), stream, gateway, { onState: () => renderTile(stream.id) });
    player.onRecordingCut = (r, userStopped) => (el.classList.remove('capturing'), saveRecording(stream, r, !userStopped));
    tiles.set(stream.id, { stream, player, el });
    layout();
    player.start();
    renderList();
    renderPushed();
    renderTm(stream.id);
    app.onActive?.(tiles.size);
  }

  function hide(sid) {
    const tile = tiles.get(sid);
    if (!tile) return;
    if (tile.player.recorder) stopRec(tile);
    tile.ai?.dispose();
    tile.player.stop(false);
    tile.el.remove();
    tiles.delete(sid);
    if (tile.stream.temp) streams = streams.filter((x) => x !== tile.stream);
    layout();
    renderList();
    renderPushed();
    app.onActive?.(tiles.size);
  }

  /** Susieto drono (diab doko) duomenys transliacijos langelyje. */
  function renderTm(sid) {
    const tile = tiles.get(sid);
    const el = tile?.el.querySelector('.live-tm');
    if (!el) return;
    const html = telemetryChips(tm?.boxFor(tile.stream.name));
    el.hidden = !html;
    if (el._html !== html) el.innerHTML = el._html = html;
  }

  function layout() {
    const n = tiles.size + (tm?.mapShown ? 1 : 0);
    $('#live-grid').dataset.n = String(Math.min(n, 9));
    $('#live-empty').hidden = n > 0;
  }

  const STATE_TEXT = { connecting: 'Jungiamasi…', retry: 'Ryšys nutrūko', error: 'Klaida', idle: '' };
  function renderTile(sid) {
    const tile = tiles.get(sid);
    if (!tile) return;
    const { player: p, el } = tile;
    const live = p.state === 'live';
    el.classList.toggle('is-live', live);
    const badge = el.querySelector('.live-badge');
    badge.textContent = live ? `● ${t('TIESIOGIAI')}${p.mode ? ` · ${p.mode}` : ''}` : t(STATE_TEXT[p.state] || '');
    badge.className = `live-badge ${p.state}`;
    const s = p.stats || {};
    const parts = [];
    if (s.w && s.h) parts.push(`${s.w}×${s.h}`);
    if (s.fps > 0.5) parts.push(`${nf(s.fps, 0)} fps`);
    if (s.kbps > 0) parts.push(s.kbps > 1000 ? `${nf(s.kbps / 1000, 1)} Mb/s` : `${nf(s.kbps, 0)} kb/s`);
    if (s.latency > 0 && isFinite(s.latency)) parts.push(t('vėlavimas {s} s', { s: nf(s.latency, 1) }));
    // Įterptas tinklalapis: kitos svetainės turinio naršyklė neleidžia nei kopijuoti, nei įrašyti
    if (live && p.embedded) parts.push(p.canCapture ? t('Tinklalapis – kadras ir įrašas imami iš ekrano (naršyklė paprašys leidimo bendrinti skirtuką)') : t('Tinklalapis – įrašyti galima tik programą atidarius per localhost arba https'));
    el.querySelector('.live-stat').textContent = live ? parts.join(' · ') : '';
    const msg = el.querySelector('.live-msg');
    msg.hidden = live || p.state === 'idle';
    if (!msg.hidden) {
      msg.innerHTML =
        p.state === 'retry'
          ? `<b>${esc(t('Nepavyko parodyti'))}</b><span>${esc(p.error)}</span><span class="muted">${esc(t('Bandoma vėl po {s} s…', { s: p.retryIn }))}</span>${hint(tile)}`
          : `<span class="live-spin"></span><span>${esc(t('Jungiamasi…'))}</span>`;
    }
    const sum = el.querySelector('.live-ai-sum');
    sum.hidden = !tile.ai?.on;
    if (tile.ai?.on) {
      sum.textContent = tile.ai.summary();
      sum.classList.toggle('bad', !!tile.ai.error);
    }
    el.querySelector('[data-tact=ai]').classList.toggle('on', !!tile.ai?.on);
    el.querySelector('[data-tact=ai]').disabled = !tile.ai?.on && (p.embedded || !live);
    const cap = p.canCapture;
    el.querySelector('[data-tact=snap]').disabled = !cap;
    el.querySelector('[data-tact=rec]').disabled = !cap && !p.recorder;
    el.querySelector('[data-tact=sound]').disabled = !(p.el instanceof HTMLVideoElement);
    el.querySelector('[data-tact=sound]').innerHTML = icon(tile.stream.muted === false ? 'sound' : 'mute');
    const dot = page.querySelector(`.live-item[data-id="${sid}"] .live-dot`);
    if (dot) dot.className = `live-dot ${p.state}`;
  }

  /** Patarimas, kodėl gali nepavykti. */
  function hint(tile) {
    const c = tile.stream.path ? { kind: 'gateway' } : classify(tile.stream.url);
    let h = '';
    if (role === 'client') h = t('Šaltinis šiuo metu nesiunčia vaizdo – bandoma vėl automatiškai. Jei neprasideda, kreipkitės į administratorių.');
    else if ((c.kind === 'gateway' || tile.stream.via === 'server') && gwState !== 'ok') h = t('Transliacijų serveris nepasiekiamas – paleiskite start-windows.bat (Docker).');
    else if (c.kind === 'gateway') h = t('Patikrinkite, ar šaltinis siunčia vaizdą ir ar adresas pasiekiamas iš šio kompiuterio.');
    else if (tile.stream.via === 'direct') h = t('Jei šaltinis neleidžia rodyti kitose svetainėse (CORS), pasirinkite „Per serverį“.');
    return h ? `<span class="small muted">${esc(h)}</span>` : '';
  }

  $('#live-grid').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-tact]')?.dataset.tact;
    const tile = tiles.get(e.target.closest('.live-tile')?.dataset.id);
    if (!act || !tile) return;
    const { player: p, stream: s, el } = tile;
    // Klientas tik žiūri ir valdo AI: kadrus ir įrašus jam pateikia administratorius
    if (role === 'client' && (act === 'snap' || act === 'rec' || act === 'publish')) return;
    if (act === 'close') hide(s.id);
    else if (act === 'publish') {
      // Admin: transliacija klientams – serveryje lieka šaltinis ir raktai, klientas gauna tik kelią
      const src = p.publishSource();
      if (!src) return app.toast(t('Šios transliacijos klientams priskirti negalima: serveris gali perduoti tik RTSP, RTMP, SRT, HLS ir WebRTC srautus (ne tinklalapį, MJPEG ar vaizdo failą).'), 'error', 7000);
      portal?.publishStream(s.name, src, renderMine);
    } else if (act === 'ai') {
      if (!tile.ai)
        tile.ai = new LiveDetector(p, el.querySelector('.live-view'), {
          getAi: app.getAi,
          settings: () => aiSet,
          samples,
          onUpdate: () => renderTile(s.id),
          onAlert: (text) => alertUser(`${s.name}: ${text}`),
          onSample: renderDataset,
        });
      tile.ai.on ? tile.ai.stop() : tile.ai.start();
      renderTile(s.id);
    } else if (act === 'reload') {
      p.retries = 0;
      p.start();
    } else if (act === 'full') {
      const v = el.querySelector('.live-view');
      if (document.fullscreenElement) document.exitFullscreen();
      else v.requestFullscreen?.().catch(() => {});
    } else if (act === 'sound') {
      p.setMuted(s.muted !== false ? false : true);
      if (!s.temp) save();
      renderTile(s.id);
    } else if (act === 'snap') {
      try {
        // Įterpto puslapio kadras imamas iš ekrano – užrašai ant vaizdo paslepiami
        if (p.embedded) el.classList.add('capturing');
        const png = tile.ai?.on && !p.embedded ? await aiSnapshot(tile) : await p.snapshot().finally(() => !p.recorder && el.classList.remove('capturing'));
        download(png, `${safe(s.name)}_${stamp()}.png`);
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 250);
      } catch (err) {
        app.toast(err.message, 'error', 6000);
      }
    } else if (act === 'rec') {
      if (p.recorder) stopRec(tile);
      else {
        try {
          if (p.embedded) el.classList.add('capturing');
          if (tile.ai?.on && !p.embedded) {
            // Įrašas su AI žymėjimais: vaizdas + rėmeliai + skaičiai + laikas, po to – ataskaita klientui
            const comp = new AiComposer(p, tile.ai, { name: s.name, settings: aiSet, telemetry: () => tm?.boxFor(s.name) });
            try {
              await p.startRecording({ stream: comp.stream, extra: { comp } });
            } catch (err) {
              comp.stop();
              throw err;
            }
          } else {
            // Be AI – kaupiama tik drono telemetrija (skrydžio ataskaitai), jei ji gaunama
            const log = new FlightLog(() => tm?.boxFor(s.name));
            try {
              await p.startRecording({ extra: { log } });
            } catch (err) {
              log.stop();
              throw err;
            }
          }
          el.querySelector('[data-tact=rec]').classList.add('recording');
          el.querySelector('[data-tact=rec]').innerHTML = icon('stop');
          tickRec();
        } catch (err) {
          el.classList.remove('capturing');
          app.toast(err.name === 'NotAllowedError' ? 'Įrašymas atšauktas – nesuteiktas leidimas bendrinti skirtuką' : err.message, 'error', 6000);
        }
      }
    }
  });
  // Dvigubas spustelėjimas – visas ekranas
  $('#live-grid').addEventListener('dblclick', (e) => {
    const v = e.target.closest('.live-view');
    if (!v || v.querySelector('iframe')) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else v.requestFullscreen?.().catch(() => {});
  });

  /** Kadras su AI rėmeliais ir laiku (PNG). */
  function aiSnapshot(tile) {
    const el = tile.player.el;
    const w = el.videoWidth || el.naturalWidth, h = el.videoHeight || el.naturalHeight;
    if (!w || !h) throw new Error(t('Dar nėra vaizdo'));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const now = new Date();
    const counts = Object.entries(tile.ai.counts).map(([k, n]) => `${tile.ai.groups?.[k]?.label || k}: ${n}`).join('   ');
    drawComposite(c.getContext('2d'), el, tile.ai.last, { W: w, H: h, lines: [now.toLocaleString(locale()), tile.stream.name, counts].filter(Boolean) });
    return new Promise((res, rej) => {
      try {
        c.toBlob((b) => (b ? res(b) : rej(new Error('PNG'))), 'image/png');
      } catch {
        rej(new Error(t('Šaltinis neleidžia kopijuoti vaizdo – pasirinkite „Per serverį“')));
      }
    });
  }

  async function stopRec(tile) {
    tile.el.classList.remove('capturing');
    const btn = tile.el.querySelector('[data-tact=rec]');
    btn.classList.remove('recording');
    btn.innerHTML = icon('record');
    tile.el.querySelector('.live-rec').hidden = true;
    const r = await tile.player.stopRecording();
    if (r) saveRecording(tile.stream, r, false);
  }
  async function saveRecording(stream, { blob, ext, extra, original }, cut) {
    const comp = extra?.comp;
    comp?.stop();
    const log = extra?.log;
    log?.stop();
    if (!blob.size) return;
    const fly = comp || (log?.tele.length ? log : null); // skrydžio duomenys (maršrutas, telemetrija)
    resetRecButton(stream.id);
    // Administratorius (serveryje): originalus vaizdas → „Įrašai“, AI ataskaita → „Ataskaitos“
    if (role === 'admin') {
      try {
        await saveToPortal(stream, { blob, ext, comp, log, original }, cut);
        return;
      } catch (err) {
        app.toast(t('Į serverį išsaugoti nepavyko ({e}) – atsisiunčiama į kompiuterį', { e: err.message }), 'error', 8000);
      }
    }
    if (comp) {
      app.toast('Ruošiama ataskaita…', 'info', 3000);
      try {
        const zip = await reportZip({ name: stream.name, video: { blob, ext }, comp, settings: { ...aiSet, modelName: aiSet.model ? aiSet.modelName : '' } });
        download(zip, `${safe(stream.name)}_${stamp()}_AI.zip`);
      } catch (err) {
        download(blob, `${safe(stream.name)}_${stamp()}.${ext}`);
        app.toast(t('Ataskaitos sukurti nepavyko: {e}', { e: err.message }), 'error', 8000);
      }
    } else if (fly) {
      const zip = await flightReportZip({ name: stream.name, video: { blob, ext }, log: fly }).catch(() => null);
      download(zip || blob, `${safe(stream.name)}_${stamp()}${zip ? '_skrydis.zip' : `.${ext}`}`);
    } else download(blob, `${safe(stream.name)}_${stamp()}.${ext}`);
    app.toast(cut ? 'Ryšys nutrūko – įrašas išsaugotas' : comp ? 'Įrašas ir AI ataskaita išsaugoti' : 'Įrašas išsaugotas', cut ? 'warn' : 'success', 5000);
  }
  function resetRecButton(sid) {
    const tile = tiles.get(sid);
    if (!tile) return;
    const btn = tile.el.querySelector('[data-tact=rec]');
    btn.classList.remove('recording');
    btn.innerHTML = icon('record');
    tile.el.querySelector('.live-rec').hidden = true;
  }
  /** Įrašas ir ataskaita į portalą (nepriskirti – matomi tik administratoriui, vėliau priskiriami klientams). */
  async function saveToPortal(stream, { blob, ext, comp, log, original }, cut) {
    const fly = comp || (log?.tele.length ? log : null);
    const when = new Date().toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' });
    const base = `${safe(stream.name)}_${stamp()}`;
    // „Įrašai“ – toks vaizdas, koks įrašytas: su AI – su rėmeliais, skaičiais ir laiku (kaip ataskaitoje)
    const video = blob?.size ? { blob, ext } : original;
    const done = [];
    const upload = async (kind, title, note, file, name) => {
      const it = await api('items', { method: 'POST', body: { kind, title, note, clients: [] } });
      app.toast(t('Įkeliama: {n} ({s} MB)…', { n: title, s: Math.round(file.size / 1e6) }), 'info', 4000);
      let shown = -1;
      try {
        await uploadFile(it.id, file, name, (p) => {
          const pct = Math.floor(p * 10) * 10;
          if (file.size > 50e6 && pct > shown && pct < 100) {
            shown = pct;
            app.toast(t('Įkeliama: {n} – {p} %', { n: title, p: pct }), 'info', 3000);
          }
        });
      } catch (e) {
        // Nepavyko – tuščios kortelės nepaliekame (įrašas bus atsisiųstas į kompiuterį)
        await api(`items/${it.id}`, { method: 'DELETE' }).catch(() => {});
        throw e;
      }
      return it;
    };
    if (video) {
      const it = await upload('recording', `${stream.name} · ${when}`, cut ? t('Ryšys nutrūko – įrašas gali būti nepilnas') : '', video.blob, `${base}.${video.ext}`);
      done.push(t('įrašas – „Įrašai“'));
      // Drono maršrutas (diab) – kartu su įrašu (GPX atsidaro Google Earth, QGIS ir kt.)
      if (fly?.route.length > 1)
        await uploadFile(it.id, new Blob([trackGpx(`${stream.name} – ${fly.drone || ''}`, fly.route)], { type: 'application/gpx+xml' }), `${base}_marsrutas.gpx`).catch(() => {});
    }
    if (comp) {
      app.toast('Ruošiama ataskaita…', 'info', 3000);
      const zip = await reportZip({ name: stream.name, video: { blob, ext }, comp, settings: { ...aiSet, modelName: aiSet.model ? aiSet.modelName : '' } });
      await upload('report', `${stream.name} · AI ataskaita · ${when}`, t('Atsisiųskite ZIP ir atidarykite ataskaita.html'), zip, `${base}_AI.zip`);
      done.push(t('AI ataskaita – „Ataskaitos“'));
    } else if (fly && video) {
      // Be AI, bet su telemetrija – skrydžio ataskaita (maršrutas, santrauka, grafikai)
      const zip = await flightReportZip({ name: stream.name, video, log: fly }).catch(() => null);
      if (zip) {
        await upload('report', `${stream.name} · ${t('Skrydžio ataskaita')} · ${when}`, t('Atsisiųskite ZIP ir atidarykite ataskaita.html'), zip, `${base}_skrydis.zip`);
        done.push(t('skrydžio ataskaita – „Ataskaitos“'));
      }
    }
    app.toast(t('Išsaugota serveryje: {l}. Priskirti klientams galite pradžios ekrane.', { l: done.join(', ') }), cut ? 'warn' : 'success', 8000);
  }
  function tickRec() {
    clearInterval(recTimer);
    recTimer = setInterval(() => {
      let any = false;
      for (const { player, el } of tiles.values()) {
        const r = el.querySelector('.live-rec');
        r.hidden = !player.recorder;
        if (player.recorder) {
          any = true;
          r.textContent = `● REC ${fmtTime(Date.now() - player.recorder.started)}`;
        }
      }
      if (!any) clearInterval(recTimer);
    }, 500);
  }

  // ------------------------------------------------------------------ Dronas → kompiuteris
  const pushName = () => (($('#live-push-name').value || 'drone').trim().replace(/[^A-Za-z0-9_-]/g, '') || 'drone');
  function renderPushUrls() {
    const local = !location.hostname || /^(localhost|127\.|\[?::1)/.test(location.hostname);
    const host = local ? t('KOMPIUTERIO-IP') : location.hostname;
    const n = pushName();
    const urls = [
      ['RTMP', `rtmp://${host}:1935/${n}`],
      ['RTSP', `rtsp://${host}:8554/${n}`],
      ['SRT', `srt://${host}:8890?streamid=publish:${n}`],
    ];
    $('#live-push-urls').innerHTML =
      urls
        .map(([k, u]) => `<div class="live-push"><span class="chip">${k}</span><code>${esc(u)}</code><button class="btn btn-ghost btn-sm icon-only" data-copy="${esc(u)}" title="${esc(t('Kopijuoti'))}">${icon('copy')}</button></div>`)
        .join('') + (local ? `<p class="small muted">${t('KOMPIUTERIO-IP – šio kompiuterio adresas tinkle (komanda ipconfig → IPv4 Address, pvz. 192.168.1.10).')}</p>` : '');
  }
  $('#live-push-name').addEventListener('input', () => {
    ls.set(LS_PUSH, pushName());
    renderPushUrls();
  });
  page.addEventListener('click', (e) => {
    const c = e.target.closest('[data-copy]');
    if (!c) return;
    navigator.clipboard?.writeText(c.dataset.copy).then(
      () => app.toast('Nukopijuota', 'success', 1500),
      () => app.toast(c.dataset.copy, 'info', 8000),
    );
  });

  async function refreshGateway() {
    try {
      pushed = (await gateway.list()).filter((p) => !p.name.startsWith('src_'));
      gwState = 'ok';
    } catch (e) {
      gwState = e.message;
      pushed = [];
    }
    const chip = $('#live-gw');
    chip.className = `chip ${gwState === 'ok' ? 'ok' : 'bad'}`;
    chip.textContent = gwState === 'ok' ? t('veikia') : t('nepasiekiamas');
    chip.title = gwState === 'ok' ? '' : gwState;
    renderPushed();
  }
  function renderPushed() {
    const box = $('#live-pushed');
    if (gwState !== 'ok') {
      box.innerHTML = gwState ? `<p class="small muted">${esc(t('Transliacijų serveris nepasiekiamas – paleiskite start-windows.bat (Docker).'))}</p>` : '';
      return;
    }
    box.innerHTML = `<div class="small muted" style="margin:10px 0 4px">${t('Gaunamos transliacijos')}</div>${
      pushed.length
        ? pushed
            .map((p) => {
              const on = [...tiles.values()].some((x) => x.stream.path === p.name);
              const tr = p.tracks.map((x) => (typeof x === 'string' ? x : x.codec || '')).filter(Boolean).join(', ');
              return `<div class="live-item${on ? ' on' : ''}"><button class="live-item-main" data-push="${esc(p.name)}">
                <span class="live-dot ${p.ready ? 'live' : 'retry'}"></span>
                <span class="live-item-text"><b>${esc(p.name)}</b><span class="muted small">${p.ready ? esc(tr || t('gaunama')) : t('laukiama')}</span></span>
              </button></div>`;
            })
            .join('')
        : `<p class="small muted">${t('Šiuo metu niekas nesiunčia. Įjunkite transliaciją pulte – ji atsiras čia.')}</p>`
    }`;
  }
  $('#live-pushed').addEventListener('click', (e) => {
    const name = e.target.closest('[data-push]')?.dataset.push;
    if (!name) return;
    const on = [...tiles.values()].find((x) => x.stream.path === name);
    if (on) return hide(on.stream.id);
    let s = streams.find((x) => x.path === name);
    if (!s) {
      s = { id: id(), name, path: name, url: `rtmp://…/${name}`, temp: true, muted: true };
      streams.push(s);
    }
    show(s);
  });

  // ------------------------------------------------------------------ AI aptikimas
  const aiSet = { detail: 'normal', threshold: 0.5, alertPerson: false, collect: false, ...ls.get(LS_AI, {}) };
  aiSet.groups = { person: true, car: true, heavy: true, two: false, ...(aiSet.groups || {}) };
  const samples = []; // kadrai mokymui (tik šioje sesijoje – atmintyje)
  let customModels = []; // AI paslaugos savi modeliai
  function renderAiSettings() {
    const cur = customModels.find((m) => m.id === aiSet.model);
    if (aiSet.model && !cur && customModels.length) aiSet.model = ''; // ištrintas
    $('#live-ai-model').innerHTML =
      `<option value="">${esc(t('Standartinis (žmonės, transportas)'))}</option>` +
      customModels.map((m) => `<option value="${esc(m.id)}" ${m.id === aiSet.model ? 'selected' : ''}>${esc(m.name)} · ${esc(m.created)}</option>`).join('');
    if (aiSet.model && !cur) $('#live-ai-model').insertAdjacentHTML('beforeend', `<option value="${esc(aiSet.model)}" selected>${esc(aiSet.modelName || aiSet.model)}</option>`);
    if (aiSet.model) {
      const classes = cur?.classes || aiSet.customClasses || [];
      aiSet.customClasses = classes;
      $('#live-ai-groups').innerHTML = classes
        .map((c) => `<label class="check small"><input type="checkbox" data-aic="${esc(c)}" ${aiSet.customOn?.[c] !== false ? 'checked' : ''}/> <span class="live-ai-swatch" style="background:${classColor(c)}"></span>${esc(classLabel(c))}</label>`)
        .join('');
      if (!classes.includes(aiSet.alertClass)) aiSet.alertClass = classes.find((c) => /no|be_|without/i.test(c)) || classes[0] || '';
      $('#live-ai-alert-class').innerHTML = classes.map((c) => `<option value="${esc(c)}" ${c === aiSet.alertClass ? 'selected' : ''}>${esc(classLabel(c))}</option>`).join('');
    } else {
      $('#live-ai-groups').innerHTML = Object.entries(AI_GROUPS)
        .map(([k, g]) => `<label class="check small"><input type="checkbox" data-aig="${k}" ${aiSet.groups[k] ? 'checked' : ''}/> ${esc(t(g.label))}</label>`)
        .join('');
    }
    // Ataskaitos filtras: kurios aptinkamos grupės patenka į įvykius, santrauką ir grafiką (pagal modelį)
    const off = aiSet.reportOff?.[aiSet.model || 'std'] || {};
    const act = activeGroups(aiSet);
    $('#live-ai-report').innerHTML =
      Object.entries(act)
        .map(([k, g]) => `<label class="check small"><input type="checkbox" data-air="${esc(k)}" ${off[k] ? '' : 'checked'}/> <span class="live-ai-swatch" style="background:${g.color}"></span>${esc(g.label)}</label>`)
        .join('') || `<span class="small muted">${esc(t('Pasirinkite, ką aptikti'))}</span>`;
    $('#live-ai-alert-l').textContent = aiSet.model ? t('Įspėjimas (garsas ir pranešimas)') : t('Įspėti, kai aptinkamas žmogus');
    $('#live-ai-alert-row').hidden = !aiSet.model;
    $('#live-ai-detail').innerHTML = Object.entries(AI_DETAIL)
      .map(([k, d]) => `<option value="${k}" ${aiSet.detail === k ? 'selected' : ''}>${esc(t(d.label))}</option>`)
      .join('');
    $('#live-ai-th').value = aiSet.threshold;
    $('#live-ai-th-v').textContent = `${Math.round(aiSet.threshold * 100)} %`;
    $('#live-ai-alert').checked = aiSet.alertPerson;
    $('#live-ai-track').checked = aiSet.track !== false;
    $('#live-ai-mem-row').hidden = aiSet.track === false;
    const states = !!aiSet.model && hasStates(aiSet.customClasses);
    $('#live-ai-stab-row').hidden = !states || aiSet.track === false;
    $('#live-ai-lock-row').hidden = $('#live-ai-stab-row').hidden || aiSet.stabilize === false;
    $('#live-ai-stab').checked = aiSet.stabilize !== false;
    $('#live-ai-lock').innerHTML = LOCK_SCORES.map((v) => `<option value="${v}" ${(+aiSet.lockScore || 0.7) === v ? 'selected' : ''}>${Math.round(v * 100)} %</option>`).join('');
    $('#live-ai-mem').innerHTML = Object.entries(TRACK_MEMORY)
      .map(([k, l]) => `<option value="${k}" ${String(aiSet.trackMemory || 15) === k ? 'selected' : ''}>${esc(t(l))}</option>`)
      .join('');
    $('#live-ai-collect').checked = aiSet.collect;
  }
  function renderDataset() {
    const n = samples.length;
    $('#live-ai-ds').innerHTML = aiSet.collect || n
      ? `${esc(t('Sukaupta kadrų: {n}', { n }))}${n ? ` <button class="btn btn-sm btn-outline" data-ds="zip">${icon('save')}${esc(t('Atsisiųsti (ZIP)'))}</button> <button class="btn btn-sm btn-ghost" data-ds="clear">${esc(t('Išvalyti'))}</button>` : ''}`
      : '';
  }
  page.addEventListener('change', (e) => {
    const g = e.target.closest('[data-aig]');
    const cc = e.target.closest('[data-aic]');
    const rr = e.target.closest('[data-air]');
    if (g || cc) {
      if (g) aiSet.groups[g.dataset.aig] = g.checked;
      else aiSet.customOn = { ...aiSet.customOn, [cc.dataset.aic]: cc.checked };
      renderAiSettings();
    } else if (rr) {
      const mk = aiSet.model || 'std';
      aiSet.reportOff = { ...aiSet.reportOff, [mk]: { ...aiSet.reportOff?.[mk], [rr.dataset.air]: !rr.checked } };
    }
    else if (e.target.id === 'live-ai-model') {
      aiSet.model = e.target.value;
      const m = customModels.find((x) => x.id === aiSet.model);
      aiSet.modelName = m?.name || '';
      aiSet.customClasses = m?.classes || [];
      renderAiSettings();
    } else if (e.target.id === 'live-ai-alert-class') aiSet.alertClass = e.target.value;
    else if (e.target.id === 'live-ai-detail') aiSet.detail = e.target.value;
    else if (e.target.id === 'live-ai-track') {
      aiSet.track = e.target.checked;
      renderAiSettings();
    } else if (e.target.id === 'live-ai-mem') aiSet.trackMemory = +e.target.value;
    else if (e.target.id === 'live-ai-stab') {
      aiSet.stabilize = e.target.checked;
      renderAiSettings();
    } else if (e.target.id === 'live-ai-lock') aiSet.lockScore = +e.target.value;
    else if (e.target.id === 'live-ai-alert') {
      aiSet.alertPerson = e.target.checked;
      if (aiSet.alertPerson && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    } else if (e.target.id === 'live-ai-collect') {
      aiSet.collect = e.target.checked;
      renderDataset();
    } else return;
    ls.set(LS_AI, aiSet);
  });
  $('#live-ai-th').addEventListener('input', (e) => {
    aiSet.threshold = +e.target.value;
    $('#live-ai-th-v').textContent = `${Math.round(aiSet.threshold * 100)} %`;
    ls.set(LS_AI, aiSet);
  });
  $('#live-ai-ds').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-ds]')?.dataset.ds;
    if (a === 'clear') {
      if (!confirm(t('Išvalyti sukauptus kadrus?'))) return;
      samples.length = 0;
    } else if (a === 'zip') download(await datasetZip(samples), `ai_kadrai_${stamp()}.zip`);
    renderDataset();
  });
  // ------------------------------------------------------------------ Savas modelis: mokymas ir sąrašas
  let trainTimer = null;
  let trainSt = null;
  const PHASE = { preparing: 'Ruošiamas rinkinys…', downloading: 'Siunčiamas pradinis modelis', training: 'Mokoma', done: 'Baigta', error: 'Klaida', stopped: 'Nutraukta' };
  const fmtEta = (s) => (s >= 3600 ? t('{h} val. {m} min.', { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) }) : t('{m} min.', { m: Math.max(1, Math.round(s / 60)) }));
  async function refreshModels() {
    try {
      const ai = await app.getAi();
      const [m, st] = await Promise.all([ai.models(), ai.trainStatus().catch(() => null)]);
      customModels = m.models || [];
      const wasRunning = trainSt?.running;
      trainSt = st && st.job ? st : null;
      if (wasRunning && trainSt && !trainSt.running && trainSt.phase === 'done') app.toast(t('Modelis „{n}“ apmokytas', { n: trainSt.model?.name || '' }), 'success', 8000);
    } catch (e) {
      customModels = [];
      trainSt = { phase: 'error', message: e.message, offline: true };
    }
    renderModels();
    renderAiSettings();
    clearTimeout(trainTimer);
    if (trainSt?.running && !page.hidden) trainTimer = setTimeout(refreshModels, 5000);
  }
  function renderModels() {
    const st = trainSt;
    let html = '';
    if (st && !st.offline) {
      const pct = st.phase === 'downloading' ? st.download || 0 : st.epochs ? Math.min(100, (100 * (st.epoch || 0)) / st.epochs) : 0;
      const map = st.metrics?.map50 != null ? ` · ${t('tikslumas mAP50 {v} %', { v: nf(st.metrics.map50 * 100, 0) })}` : '';
      html += `<div class="live-train ${st.phase}">
        <div class="row"><b>${esc(t(PHASE[st.phase] || st.phase))}${st.phase === 'training' ? ` ${st.epoch || 0} / ${st.epochs}` : st.phase === 'downloading' ? ` ${st.download || 0} %` : ''}</b>
          ${st.running ? `<button class="btn btn-sm btn-ghost danger" data-tr="cancel">${esc(t('Nutraukti'))}</button>` : ''}</div>
        ${st.running ? `<div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>` : ''}
        <div class="small muted">${st.stats ? esc(t('{i} kadrų, {b} pažymėtų objektų', { i: st.stats.images, b: st.stats.boxes })) : ''}${st.running && st.eta ? ` · ${esc(t('liko ~{t}', { t: fmtEta(st.eta) }))}` : ''}${map}</div>
        ${st.message ? `<div class="small bad">${esc(st.message)}</div>` : ''}
      </div>`;
    } else if (st?.offline) html += `<p class="small muted">${esc(t('AI paslauga nepasiekiama – paleiskite start-windows.bat.'))}</p>`;
    $('#live-train').innerHTML = html;
    $('#live-models').innerHTML = customModels
      .map(
        (m) => `<div class="live-model" data-mid="${esc(m.id)}">
        <div><b>${esc(m.name)}</b> <span class="muted small">${esc(m.created)} · ${esc(m.size)}</span></div>
        <div class="small muted">${esc(m.classes.map(classLabel).join(', '))}${m.metrics?.map50 != null ? ` · mAP50 ${nf(m.metrics.map50 * 100, 0)} %` : ''}${m.stats ? ` · ${esc(t('{i} kadrų', { i: m.stats.images }))}` : ''}</div>
        <div class="pane-actions"><button class="btn btn-sm btn-outline" data-tr="use">${esc(t(aiSet.model === m.id ? 'Naudojamas' : 'Naudoti'))}</button><button class="btn btn-sm btn-ghost danger" data-tr="del">${icon('trash')}</button></div>
      </div>`,
      )
      .join('');
  }
  page.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tr]');
    if (!b) return;
    const ai = await app.getAi();
    const id = b.closest('[data-mid]')?.dataset.mid;
    try {
      if (b.dataset.tr === 'new') {
        if (trainSt?.running) return app.toast('Jau vyksta kitas mokymas', 'error');
        dlgTrain.querySelector('#tr-info').textContent = '';
        dlgTrain.querySelector('#tr-est').textContent = '';
        dlgTrain.showModal();
      } else if (b.dataset.tr === 'cancel') {
        if (!confirm(t('Nutraukti mokymą?'))) return;
        await ai.trainCancel();
      } else if (b.dataset.tr === 'use') {
        const m = customModels.find((x) => x.id === id);
        Object.assign(aiSet, { model: id, modelName: m?.name || '', customClasses: m?.classes || [] });
        ls.set(LS_AI, aiSet);
        renderAiSettings();
        renderModels();
        app.toast(t('AI aptikimui naudojamas „{n}“', { n: m?.name || id }), 'success');
      } else if (b.dataset.tr === 'del') {
        if (!confirm(t('Ištrinti modelį „{n}“?', { n: customModels.find((x) => x.id === id)?.name || id }))) return;
        await ai.deleteModel(id);
        if (aiSet.model === id) aiSet.model = '';
        ls.set(LS_AI, aiSet);
      }
    } catch (err) {
      app.toast(err.message, 'error', 8000);
    }
    refreshModels();
  });
  // Rinkinio peržiūra: kadrų skaičius ir apytikslė trukmė (procesoriumi)
  const SEC_PER_IMG = { nano: 1.2, small: 2, medium: 3.7 }; // matuota 4 branduoliais
  let trainImages = 0;
  function estimate() {
    const size = dlgTrain.querySelector('#tr-size').value, ep = +dlgTrain.querySelector('#tr-epochs').value || 40;
    if (!trainImages) return;
    const sec = trainImages * 0.85 * SEC_PER_IMG[size] * ep;
    dlgTrain.querySelector('#tr-est').textContent = t('Apytiksliai {t} procesoriumi (su NVIDIA GPU – keliasdešimt kartų greičiau). Mokymo metu AI aptikimas veiks lėčiau.', { t: fmtEta(sec) });
  }
  dlgTrain.querySelector('#tr-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    trainImages = 0;
    if (!f) return;
    try {
      const { unzipSync } = await import('three/examples/jsm/libs/fflate.module.js');
      let imgs = 0, labels = 0;
      // Klasės ir žymėjimai: objektų skaičius kiekvienai klasei, „person“ dublikatai (žmogus pažymėtas dar ir kaip šalmas)
      const z = unzipSync(new Uint8Array(await f.arrayBuffer()), {
        filter: (x) => {
          if (/\.(jpe?g|png|bmp|webp)$/i.test(x.name)) imgs++;
          else if (/labels\/.*\.txt$/i.test(x.name)) labels++;
          return /(^|\/)classes\.txt$/i.test(x.name) || /labels\/.*\.txt$/i.test(x.name);
        },
      });
      const dec = new TextDecoder();
      const ct = Object.entries(z).find(([n]) => /(^|\/)classes\.txt$/i.test(n))?.[1];
      const names = ct ? dec.decode(ct).split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [];
      const counts = names.map(() => 0);
      const personIdx = names.map((n, i) => (/^(person|people|human|žmogus|zmogus|worker)$/i.test(n) ? i : -1)).filter((i) => i >= 0);
      const attrIdx = names.map((n, i) => (/helmet|hard.?hat|šalm|salm|vest|liemen/i.test(n) ? i : -1)).filter((i) => i >= 0);
      const iou = (a, b) => {
        const iw = Math.max(0, Math.min(a[0] + a[2] / 2, b[0] + b[2] / 2) - Math.max(a[0] - a[2] / 2, b[0] - b[2] / 2));
        const ih = Math.max(0, Math.min(a[1] + a[3] / 2, b[1] + b[3] / 2) - Math.max(a[1] - a[3] / 2, b[1] - b[3] / 2));
        return (iw * ih) / (a[2] * a[3] + b[2] * b[3] - iw * ih + 1e-12);
      };
      let dup = 0;
      for (const [n, data] of Object.entries(z)) {
        if (!/labels\/.*\.txt$/i.test(n)) continue;
        const rows = dec.decode(data).split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((v) => v.length >= 5 && v[0] < names.length);
        const attrBoxes = rows.filter((r) => attrIdx.includes(r[0])).map((r) => r.slice(1, 5));
        for (const r of rows) {
          if (personIdx.includes(r[0]) && attrBoxes.some((a) => iou(r.slice(1, 5), a) > 0.7)) dup++;
          else counts[r[0]]++;
        }
      }
      trainImages = imgs;
      const per = names.map((n, i) => `<span class="${counts[i] < 100 ? 'bad' : ''}">${esc(classLabel(n))}: <b>${counts[i]}</b></span>`).join(' · ');
      const weak = names.filter((n, i) => counts[i] > 0 && counts[i] < 100).map(classLabel);
      dlgTrain.querySelector('#tr-info').innerHTML = [
        esc(t('Kadrų: {i}, žymėjimų failų: {l}.', { i: imgs, l: labels })),
        names.length ? `${esc(t('Objektai pagal klasę:'))} ${per}` : esc(t('Nerastas classes.txt')),
        dup ? esc(t('{n} „person“ žymų sutampa su šalmo žyma – jos bus pašalintos, kad tas pats žmogus nebūtų dviejų klasių.', { n: dup })) : '',
        weak.length ? esc(t('Mažai pavyzdžių ({c}) – šios klasės bus atpažįstamos prasčiau; rekomenduojama bent 150–300.', { c: weak.join(', ') })) : '',
      ].filter(Boolean).map((x) => `<div>${x}</div>`).join('');
      estimate();
    } catch {
      dlgTrain.querySelector('#tr-info').textContent = t('Nepavyko perskaityti ZIP');
    }
  });
  dlgTrain.querySelector('#tr-size').addEventListener('change', estimate);
  dlgTrain.querySelector('#tr-epochs').addEventListener('input', estimate);
  dlgTrain.addEventListener('close', async () => {
    if (dlgTrain.returnValue !== 'ok') return;
    const f = dlgTrain.querySelector('#tr-file').files[0];
    if (!f) return;
    try {
      app.toast('Įkeliamas rinkinys…', 'info', 3000);
      const ai = await app.getAi();
      await ai.train(f, { name: dlgTrain.querySelector('#tr-name').value.trim() || 'Savas modelis', size: dlgTrain.querySelector('#tr-size').value, epochs: +dlgTrain.querySelector('#tr-epochs').value || 40 });
      app.toast('Mokymas pradėtas – eigą matysite kortelėje „Savas AI modelis“', 'success', 6000);
    } catch (err) {
      app.toast(err.message, 'error', 8000);
    }
    refreshModels();
  });

  /** Įspėjimas: pranešimas, garsas ir (jei leista) sistemos pranešimas. */
  function alertUser(text) {
    app.toast(text, 'warn', 6000);
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.5);
      o.connect(g).connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + 0.5);
    } catch { /* be garso */ }
    try {
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('Atea 3D Matuoklis', { body: text });
    } catch { /* nebūtina */ }
  }
  renderAiSettings();
  renderDataset();

  // ------------------------------------------------------------------ Atidarymas / uždarymas
  function open() {
    page.hidden = false;
    renderMine();
    renderList();
    renderPushUrls();
    refreshGateway();
    clearInterval(gwTimer);
    gwTimer = setInterval(refreshGateway, 4000);
    setTimeout(() => !tiles.size && $('#live-url').focus(), 50);
    refreshModels();
  }
  function close() {
    page.hidden = true;
    clearInterval(gwTimer); // transliacijos toliau rodomos (ir įrašomos) fone
  }
  page.addEventListener('click', (e) => e.target.closest('[data-act=close]') && close());
  page.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && !document.fullscreenElement && e.target.tagName !== 'INPUT') close();
  });
  window.addEventListener('beforeunload', (e) => {
    if ([...tiles.values()].some((x) => x.player.recorder)) e.preventDefault();
  });

  // ------------------------------------------------------------------ Portalas (admin / klientas)
  let portal = null;
  let role = null;
  let mine = [];
  /** Kliento priskirtos transliacijos. */
  /** Serveryje saugomos transliacijos: klientui – jam priskirtos, administratoriui – visos priskirtos klientams. */
  async function renderMine() {
    if (!role) return;
    const admin = role === 'admin';
    $('#live-mine-title').textContent = t(admin ? 'Priskirtos klientams' : 'Mano gyvos transliacijos');
    try {
      mine = await api('items?kind=stream');
    } catch (e) {
      $('#live-mine').innerHTML = `<p class="small bad">${esc(e.message)}</p>`;
      return;
    }
    const who = (i) => (i.clients?.length ? t('{n} klient.', { n: i.clients.length }) : t('nepriskirta'));
    $('#live-mine').innerHTML = mine.length
      ? mine
          .map(
            (i) => `<div class="live-item" data-mine="${i.id}"><span class="live-dot ${tiles.get(`item-${i.id}`)?.player.state || ''}"></span>
            <b>${esc(i.title)}</b>${admin ? `<span class="small muted">${esc(who(i))}</span>` : ''}
            <span class="live-item-tools"><button class="btn btn-sm btn-outline" data-mine-act="watch">${icon('play')}${esc(t('Žiūrėti'))}</button>
            ${admin ? `<button class="btn btn-ghost btn-sm icon-only" data-mine-act="assign" title="${esc(t('Priskirti klientams'))}">${icon('user')}</button><button class="btn btn-ghost btn-sm icon-only danger" data-mine-act="del" title="${esc(t('Ištrinti'))}">${icon('trash')}</button>` : ''}</span></div>`,
          )
          .join('')
      : `<p class="small muted">${esc(t(admin ? 'Dar nėra – prie rodomos transliacijos spauskite 👤 „Priskirti klientams“.' : 'Dar nėra priskirtų transliacijų.'))}</p>`;
  }
  page.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-mine-act]');
    if (!b) return;
    const it = mine.find((x) => x.id === +b.closest('[data-mine]').dataset.mine);
    if (!it) return;
    try {
      if (b.dataset.mineAct === 'watch') await openItem(it);
      else if (b.dataset.mineAct === 'assign') portal?.assignItem(it, renderMine);
      else if (b.dataset.mineAct === 'del') {
        if (!confirm(t('Ištrinti „{n}“? Klientai jos nebematys.', { n: it.title }))) return;
        await api(`items/${it.id}`, { method: 'DELETE' });
        hide(`item-${it.id}`);
        renderMine();
      }
    } catch (ex) {
      app.toast(ex.message, 'error', 7000);
    }
  });
  /** Priskirta transliacija: serveris paruošia šaltinį, rodoma per serverį (iš interneto – HLS, vietoje – WebRTC). */
  async function openItem(item) {
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
    // Iš interneto – paprašoma siųsti į persiuntėją (VPS), jei jis nustatytas; kol žiūrima, prašymas kartojamas
    const { path, relay } = await api(`items/${item.id}/play${local ? '' : '?relay=1'}`, { method: 'POST' });
    const id = `item-${item.id}`;
    show({ id, name: item.title, path, preferHls: !local, relay: !!relay, temp: true, item: item.id });
    if (relay) {
      const keep = setInterval(() => {
        if (!tiles.has(id)) return clearInterval(keep);
        api(`items/${item.id}/play?relay=1`, { method: 'POST' }).catch(() => {});
      }, 25000);
    }
    open();
  }

  return {
    /** @param {{role:'admin'|'client', portal:object|null}} o */
    setPortal(o) {
      role = o.role;
      portal = o.portal;
      page.classList.toggle('live-client', role === 'client');
      // Pavadinimas – kaip pradžios ekrano mygtuko
      page.querySelector('.odm-head h2').textContent = t(role === 'client' ? 'Mano gyvos transliacijos' : 'Gyvos transliacijos');
      renderMine();
    },
    openItem,
    open,
    close,
    get isOpen() {
      return !page.hidden;
    },
    rerender() {
      renderAiSettings();
      renderDataset();
      renderList();
      renderPushUrls();
      renderPushed();
      tiles.forEach((_, k) => renderTile(k));
    },
  };
}
