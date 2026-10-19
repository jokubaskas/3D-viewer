// Tiesioginės transliacijos: nuorodos atpažinimas ir MediaMTX tarpininkas (deploy/mediamtx.yml).
// Naršyklė pati rodo HLS (.m3u8), MP4/WebM, MJPEG, WebRTC (WHEP) ir YouTube / Twitch / Vimeo,
// o RTSP / RTMP / SRT perduoda serverio MediaMTX, kuris vaizdą grąžina per WebRTC arba HLS.
import { findLocalServer } from '../local-server.js';
import { t } from '../i18n.js';

/** Protokolai, kurių naršyklė parodyti negali – tik per serverį. */
const GATEWAY_PROTOS = ['rtsp', 'rtsps', 'rtmp', 'rtmps', 'srt', 'udp'];

function youtubeId(u) {
  const h = u.hostname.replace(/^(www|m)\./, '');
  if (h === 'youtu.be') return u.pathname.slice(1).split('/')[0];
  if (h !== 'youtube.com' && h !== 'youtube-nocookie.com') return null;
  if (u.searchParams.get('v')) return u.searchParams.get('v');
  const m = u.pathname.match(/^\/(?:live|embed|shorts)\/([\w-]{6,})/);
  return m ? m[1] : null;
}

/**
 * Nustato, kaip rodyti nuorodą.
 * @returns {{kind:'gateway'|'whep'|'hls'|'file'|'mjpeg'|'image'|'embed'|'auto'|'invalid', url:string, embed?:string, label:string}}
 */
export function classify(raw) {
  const url = String(raw || '').trim();
  let u;
  try {
    u = new URL(url);
  } catch {
    return { kind: 'invalid', url, label: '' };
  }
  const proto = u.protocol.slice(0, -1).toLowerCase();
  if (GATEWAY_PROTOS.includes(proto)) return { kind: 'gateway', url, label: proto.toUpperCase() };
  if (proto !== 'http' && proto !== 'https') return { kind: 'invalid', url, label: '' };

  const yt = youtubeId(u);
  if (yt) return { kind: 'embed', url, embed: `https://www.youtube.com/embed/${encodeURIComponent(yt)}?autoplay=1&mute=1&playsinline=1`, label: 'YouTube' };
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'twitch.tv') {
    const ch = u.pathname.split('/')[1];
    // Twitch reikalauja „parent“ – tik programai atidarytai per serverį (ne file://)
    if (ch && location.hostname) return { kind: 'embed', url, embed: `https://player.twitch.tv/?channel=${encodeURIComponent(ch)}&parent=${location.hostname}&muted=true`, label: 'Twitch' };
  }
  if (host === 'vimeo.com') {
    const id = u.pathname.match(/^\/(\d+)/)?.[1];
    if (id) return { kind: 'embed', url, embed: `https://player.vimeo.com/video/${id}?autoplay=1&muted=1`, label: 'Vimeo' };
  }

  const path = u.pathname.toLowerCase();
  if (/\/whep\/?$/.test(path)) return { kind: 'whep', url, label: 'WebRTC' };
  if (/\.m3u8$/.test(path)) return { kind: 'hls', url, label: 'HLS' };
  if (/\.(mp4|webm|ogv|mov|m4v)$/.test(path)) return { kind: 'file', url, label: 'Video' };
  if (/\.(mjpe?g|cgi)$|\/mjpe?g|\/video\.cgi|\/stream$/.test(path) || u.searchParams.get('action') === 'stream') return { kind: 'mjpeg', url, label: 'MJPEG' };
  if (/\.(jpe?g|png|webp)$/.test(path) || /snapshot/.test(path)) return { kind: 'image', url, label: t('Kadras') };
  // MediaMTX puslapiai: http://serveris:8889/kelias (WebRTC) ir http://serveris:8888/kelias (HLS)
  if (u.port === '8889' && path.length > 1) return { kind: 'whep', url: `${url.replace(/\/+$/, '')}/whep`, label: 'WebRTC' };
  if (u.port === '8888' && path.length > 1) return { kind: 'hls', url: `${url.replace(/\/+$/, '')}/index.m3u8`, label: 'HLS' };
  return { kind: 'auto', url, label: 'HTTP' };
}

/** Pagal turinio tipą (jei serveris leidžia jį perskaityti) patikslina „auto“ nuorodą. */
export async function probeKind(url, signal) {
  try {
    const r = await fetch(url, { method: 'GET', signal, cache: 'no-store' });
    const type = (r.headers.get('content-type') || '').toLowerCase();
    r.body?.cancel().catch(() => {});
    if (/mpegurl/.test(type)) return 'hls';
    if (/multipart\/x-mixed-replace/.test(type)) return 'mjpeg';
    if (/^image\//.test(type)) return 'image';
    if (/^video\//.test(type)) return 'file';
    if (/text\/html/.test(type)) return 'embed';
    return null;
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return null; // CORS ar tinklas – bandysime kitais būdais
  }
}

/** Trumpas pastovus kelio pavadinimas MediaMTX serveryje pagal šaltinio adresą. */
export function pathNameFor(url) {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) h = Math.imul(h ^ url.charCodeAt(i), 0x01000193) >>> 0;
  return `src_${h.toString(36)}`;
}

/** MediaMTX tarpininkas per programos nginx (/live/…). */
export class LiveGateway {
  constructor() {
    this.base = null; // pvz. "./live/" arba "http://localhost:8081/live/"
  }

  async resolve() {
    if (this.base) return this.base;
    if (location.protocol !== 'file:') return (this.base = new URL('./live/', location.href).href);
    const srv = await findLocalServer();
    if (srv) this.base = `${srv}live/`;
    return this.base;
  }

  async api(path, opts = {}) {
    const base = await this.resolve();
    if (!base) throw new Error(t('Transliacijų serveris nepasiekiamas – paleiskite start-windows.bat (Docker).'));
    const r = await fetch(`${base}api/v3/${path}`, { cache: 'no-store', ...opts });
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch { /* ne JSON */ }
    if (!r.ok) {
      const err = new Error(data?.error || (r.status === 404 && !data ? t('Serveryje nėra transliacijų paslaugos – atnaujinkite ir paleiskite start-windows.bat') : `HTTP ${r.status}`));
      err.status = r.status;
      throw err;
    }
    return data;
  }

  /** Ar paslauga veikia. */
  async check() {
    await this.api('paths/list');
    return true;
  }

  /** Serveryje šiuo metu esančios transliacijos (siunčiamos drono / kameros arba paimamos iš šaltinio). */
  async list() {
    const d = await this.api('paths/list');
    return (d?.items || []).map((p) => ({
      name: p.name,
      ready: !!p.ready,
      source: p.source?.type || '',
      tracks: p.tracks || [],
      readers: (p.readers || []).length,
      bytes: p.bytesReceived || 0,
    }));
  }

  /** Užregistruoja šaltinį (RTSP / RTMP / SRT / HLS) – MediaMTX jį paims, kai kas nors žiūrės. */
  async addSource(url) {
    const name = pathNameFor(url);
    const body = JSON.stringify({ source: url, sourceOnDemand: true, sourceOnDemandStartTimeout: '8s', sourceOnDemandCloseAfter: '20s', rtspTransport: 'tcp' });
    // Jau užregistruotas tas pats šaltinis – nekeičiame (pakeitus nutrūktų kitų žiūrinčiųjų vaizdas)
    const cur = await this.api(`config/paths/get/${name}`).catch(() => null);
    if (cur?.source === url) return name;
    await this.api(`config/paths/replace/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    return name;
  }

  async whepUrl(name) {
    return `${await this.resolve()}webrtc/${name}/whep`;
  }

  async hlsUrl(name) {
    return `${await this.resolve()}hls/${name}/index.m3u8`;
  }
}
