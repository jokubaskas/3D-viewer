// „Tiesioginė transliacija“ – nuorodų sąrašas, kelių transliacijų vaizdas, kadrai ir įrašymas
import { icon } from '../icons.js';
import { t, locale } from '../i18n.js';
import { classify, LiveGateway } from './sources.js';
import { LivePlayer } from './player.js';
import { LiveDetector, AI_DETAIL, AI_GROUPS, datasetZip } from './ai.js';

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

  const page = document.createElement('section');
  page.className = 'odm-page live-page';
  page.hidden = true;
  page.innerHTML = `
    <header class="odm-head">
      <div>
        <h2>Tiesioginė transliacija</h2>
        <p class="muted small">Įklijuokite transliacijos nuorodą – drono, IP kameros ar svetainės. Galima žiūrėti kelias vienu metu, daryti kadrus ir įrašyti.</p>
      </div>
      <button class="btn btn-ghost icon-only" data-act="close" title="Uždaryti">${icon('close')}</button>
    </header>
    <div class="odm-body">
      <aside class="odm-side">
        <section class="card">
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
        <section class="card">
          <h3>Išsaugotos</h3>
          <div id="live-list"></div>
        </section>
        <section class="card">
          <h3>AI aptikimas</h3>
          <p class="small muted">Įjunkite prie transliacijos mygtuku ${icon('magic')}. Kadrai analizuojami šio kompiuterio AI paslaugoje (be interneto).</p>
          <div id="live-ai-groups" class="live-ai-groups"></div>
          <label class="row">Detalumas
            <select id="live-ai-detail"></select>
          </label>
          <label class="row">Jautrumas <span class="live-ai-th"><input id="live-ai-th" type="range" min="0.2" max="0.8" step="0.05" /><span id="live-ai-th-v" class="small muted"></span></span></label>
          <label class="row check"><input type="checkbox" id="live-ai-alert" /> Įspėti, kai aptinkamas žmogus</label>
          <label class="row check"><input type="checkbox" id="live-ai-collect" /> Kaupti kadrus modelio mokymui</label>
          <div id="live-ai-ds" class="small muted"></div>
        </section>
        <section class="card">
          <h3>Drono transliacija į šį kompiuterį</h3>
          <div class="row"><span>Serveris</span><span id="live-gw" class="chip">…</span></div>
          <p class="small muted">Valdymo pulte (pvz. DJI Pilot, Anzu Smart Control) pasirinkite <b>Transliacija → RTMP</b> ir įveskite adresą. Pultas ir šis kompiuteris turi būti tame pačiame tinkle.</p>
          <label class="row">Pavadinimas <input id="live-push-name" class="num wide" style="text-align:left" spellcheck="false" /></label>
          <div id="live-push-urls"></div>
          <div id="live-pushed"></div>
        </section>
      </aside>
      <div class="odm-main live-main">
        <div id="live-grid" class="live-grid"></div>
        <div id="live-empty" class="live-empty">
          ${icon('live')}
          <b>Nėra rodomų transliacijų</b>
          <span class="muted small">Įklijuokite nuorodą kairėje arba pasirinkite išsaugotą.</span>
        </div>
      </div>
    </div>`;
  document.getElementById('app').append(page);
  const $ = (s) => page.querySelector(s);
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
        <div class="live-overlay"><span class="live-badge"></span><span class="live-stat"></span><span class="live-ai-sum" hidden></span></div>
        <div class="live-msg" hidden></div>
      </div>
      <div class="live-bar">
        <b class="live-title">${esc(stream.name)}</b>
        <span class="live-rec" hidden></span>
        <span class="live-tools">
          <button class="btn btn-ghost btn-sm icon-only" data-tact="ai" title="AI: žmonės ir transportas">${icon('magic')}</button>
          <button class="btn btn-ghost btn-sm icon-only" data-tact="sound" title="Garsas">${icon('mute')}</button>
          <button class="btn btn-ghost btn-sm icon-only" data-tact="snap" title="Kadras (PNG)">${icon('camera')}</button>
          <button class="btn btn-ghost btn-sm icon-only" data-tact="rec" title="Įrašyti">${icon('record')}</button>
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

  function layout() {
    const n = tiles.size;
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
    if ((c.kind === 'gateway' || tile.stream.via === 'server') && gwState !== 'ok') h = t('Transliacijų serveris nepasiekiamas – paleiskite start-windows.bat (Docker).');
    else if (c.kind === 'gateway') h = t('Patikrinkite, ar šaltinis siunčia vaizdą ir ar adresas pasiekiamas iš šio kompiuterio.');
    else if (tile.stream.via === 'direct') h = t('Jei šaltinis neleidžia rodyti kitose svetainėse (CORS), pasirinkite „Per serverį“.');
    return h ? `<span class="small muted">${esc(h)}</span>` : '';
  }

  $('#live-grid').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-tact]')?.dataset.tact;
    const tile = tiles.get(e.target.closest('.live-tile')?.dataset.id);
    if (!act || !tile) return;
    const { player: p, stream: s, el } = tile;
    if (act === 'close') hide(s.id);
    else if (act === 'ai') {
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
        const png = await p.snapshot().finally(() => !p.recorder && el.classList.remove('capturing'));
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
          await p.startRecording();
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

  async function stopRec(tile) {
    tile.el.classList.remove('capturing');
    const btn = tile.el.querySelector('[data-tact=rec]');
    btn.classList.remove('recording');
    btn.innerHTML = icon('record');
    tile.el.querySelector('.live-rec').hidden = true;
    const r = await tile.player.stopRecording();
    if (r) saveRecording(tile.stream, r, false);
  }
  function saveRecording(stream, { blob, ext }, cut) {
    if (!blob.size) return;
    download(blob, `${safe(stream.name)}_${stamp()}.${ext}`);
    app.toast(cut ? 'Ryšys nutrūko – įrašas išsaugotas' : 'Įrašas išsaugotas', cut ? 'warn' : 'success', 5000);
    const tile = tiles.get(stream.id);
    if (tile) {
      const btn = tile.el.querySelector('[data-tact=rec]');
      btn.classList.remove('recording');
      btn.innerHTML = icon('record');
      tile.el.querySelector('.live-rec').hidden = true;
    }
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
  function renderAiSettings() {
    $('#live-ai-groups').innerHTML = Object.entries(AI_GROUPS)
      .map(([k, g]) => `<label class="check small"><input type="checkbox" data-aig="${k}" ${aiSet.groups[k] ? 'checked' : ''}/> ${esc(t(g.label))}</label>`)
      .join('');
    $('#live-ai-detail').innerHTML = Object.entries(AI_DETAIL)
      .map(([k, d]) => `<option value="${k}" ${aiSet.detail === k ? 'selected' : ''}>${esc(t(d.label))}</option>`)
      .join('');
    $('#live-ai-th').value = aiSet.threshold;
    $('#live-ai-th-v').textContent = `${Math.round(aiSet.threshold * 100)} %`;
    $('#live-ai-alert').checked = aiSet.alertPerson;
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
    if (g) aiSet.groups[g.dataset.aig] = g.checked;
    else if (e.target.id === 'live-ai-detail') aiSet.detail = e.target.value;
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
    renderList();
    renderPushUrls();
    refreshGateway();
    clearInterval(gwTimer);
    gwTimer = setInterval(refreshGateway, 4000);
    setTimeout(() => !tiles.size && $('#live-url').focus(), 50);
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

  return {
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
