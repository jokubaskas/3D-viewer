// Vienos transliacijos grotuvas: WebRTC (WHEP), HLS, vaizdo failas, MJPEG, kadrai, įterptas grotuvas.
// Bando būdus iš eilės, kol vienas pavyksta; ryšiui nutrūkus jungiasi iš naujo.
import { classify, probeKind } from './sources.js';
import { t } from '../i18n.js';

const START_TIMEOUT = 12000; // per kiek laiko turi pasirodyti vaizdas
const STALL_TIMEOUT = 10000; // kiek laiko be naujų kadrų laikoma nutrūkimu

const sleep = (ms, signal) =>
  new Promise((res, rej) => {
    const id = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(id), rej(new DOMException('aborted', 'AbortError'))), { once: true });
  });

/** Laukia įvykio arba klaidos / laiko pabaigos. */
function waitFor(el, ok, bad, ms, signal) {
  return new Promise((res, rej) => {
    const done = (fn, v) => {
      clearTimeout(timer);
      el.removeEventListener(ok, onOk);
      if (bad) el.removeEventListener(bad, onBad);
      fn(v);
    };
    const onOk = () => done(res);
    const onBad = () => done(rej, new Error(t('Šaltinis neatsako arba formatas nepalaikomas')));
    const timer = setTimeout(() => done(rej, new Error(t('Vaizdas nepasirodė per {s} s', { s: Math.round(ms / 1000) }))), ms);
    el.addEventListener(ok, onOk);
    if (bad) el.addEventListener(bad, onBad);
    signal?.addEventListener('abort', () => done(rej, new DOMException('aborted', 'AbortError')), { once: true });
  });
}

/** Pirmas vaizdo kadras (nebūtinai „playing“ – naršyklė gali neleisti automatinio grojimo su garsu). */
async function waitFirstFrame(video, ms, signal) {
  video.muted = true;
  video.play().catch(() => {});
  if (video.readyState >= 2 && video.videoWidth) return;
  await waitFor(video, 'loadeddata', 'error', ms, signal);
}

/**
 * @param {HTMLElement} host – kur įdėti vaizdą
 * @param {{url:string, name?:string, via?:'auto'|'direct'|'server'}} stream
 * @param {import('./sources.js').LiveGateway} gateway
 */
export class LivePlayer {
  constructor(host, stream, gateway, { onState } = {}) {
    this.host = host;
    this.stream = stream;
    this.gateway = gateway;
    this.onState = onState || (() => {});
    this.state = 'idle'; // idle | connecting | live | retry | error
    this.mode = ''; // WebRTC | HLS | …
    this.error = '';
    this.el = null; // <video> | <img> | <iframe>
    this.media = null; // MediaStream (WebRTC)
    this.pc = null;
    this.hls = null;
    this.retries = 0;
    this.ctl = null;
    this.recorder = null;
    this.stats = {};
    this._statTimer = null;
    this._frames = 0;
  }

  // ---------------------------------------------------------------- būsena
  set(state, extra = {}) {
    Object.assign(this, { state }, extra);
    this.onState(this);
  }

  /** Būdų sąrašas pagal nuorodą ir pasirinkimą „tiesiogiai / per serverį“. */
  async plan(signal) {
    if (this.stream.path) return [['gw-webrtc'], ['gw-hls']]; // jau serveryje (siunčia dronas / kamera)
    const c = classify(this.stream.url);
    const via = this.stream.via || 'auto';
    if (c.kind === 'invalid') throw new Error(t('Netinkama nuoroda'));
    if (c.kind === 'gateway') return [['gw-webrtc'], ['gw-hls']];
    if (c.kind === 'embed') return [['embed', c.embed]];
    let kind = c.kind;
    let url = c.url;
    this.srcUrl = null; // srautas, rastas grotuvo tinklalapyje
    if (kind === 'auto') {
      const p = await probeKind(c.url, signal);
      kind = p?.kind || 'guess';
      if (p?.url) url = this.srcUrl = p.url;
    }
    const direct = {
      whep: [['webrtc', url]],
      hls: [['hls', url]],
      file: [['file', url]],
      mjpeg: [['mjpeg', url]],
      image: [['image', url]],
      embed: [['embed', url]],
      guess: [['file', url], ['hls', url], ['mjpeg', url]],
    }[kind];
    // HLS be CORS leidimo naršyklė perskaityti negali – tada per serverį
    const server = kind === 'hls' || kind === 'guess' ? [['gw-webrtc'], ['gw-hls']] : [];
    if (via === 'server') return server.length ? server : direct;
    if (via === 'direct') return direct;
    return [...direct, ...server];
  }

  // ---------------------------------------------------------------- paleidimas
  async start() {
    this.stop(false);
    const ctl = (this.ctl = new AbortController());
    const { signal } = ctl;
    this.set('connecting', { error: '', mode: '' });
    const errs = [];
    try {
      const plan = await this.plan(signal);
      for (const [mode, url] of plan) {
        try {
          await this.attempt(mode, url, signal);
          this.retries = 0;
          this.set('live');
          this.watch(signal);
          return;
        } catch (e) {
          if (signal.aborted) return;
          if (!errs.includes(e.message)) errs.push(e.message);
          this.teardown();
          if (e.sourceDown) break; // šaltinis neveikia – kitas rodymo būdas nepadės
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      errs.push(e.message);
    }
    this.fail(new Error(errs.join(' · ') || t('Nepavyko parodyti')));
  }

  /** Nepavyko arba nutrūko – bandoma iš naujo vis rečiau (2, 4, 8 … 30 s). */
  async fail(err) {
    const signal = this.ctl?.signal;
    if (!signal || signal.aborted) return;
    this.teardown();
    this.retries++;
    const wait = Math.min(30, 2 ** Math.min(this.retries, 5));
    this.set('retry', { error: err?.message || String(err), retryIn: wait });
    try {
      await sleep(wait * 1000, signal);
      this.start();
    } catch { /* sustabdyta */ }
  }

  async attempt(mode, url, signal) {
    if (mode === 'gw-webrtc' || mode === 'gw-hls') {
      const name = this.stream.path || (await this.gateway.addSource(this.srcUrl || this.stream.url));
      this.gwName = name;
      if (mode === 'gw-webrtc') return this.playWebrtc(await this.gateway.whepUrl(name), signal, t('WebRTC per serverį'));
      return this.playHls(await this.gateway.hlsUrl(name), signal, t('HLS per serverį'));
    }
    if (mode === 'webrtc') return this.playWebrtc(url, signal, 'WebRTC');
    if (mode === 'hls') return this.playHls(url, signal, 'HLS');
    if (mode === 'file') return this.playFile(url, signal);
    if (mode === 'mjpeg') return this.playImage(url, signal, false);
    if (mode === 'image') return this.playImage(url, signal, true);
    if (mode === 'embed') return this.playEmbed(url);
    throw new Error(mode);
  }

  video() {
    const v = document.createElement('video');
    v.playsInline = true;
    v.autoplay = true;
    v.muted = this.stream.muted !== false;
    v.className = 'live-media';
    this.host.replaceChildren(v);
    this.el = v;
    return v;
  }

  async playWebrtc(whep, signal, label) {
    const v = this.video();
    const pc = (this.pc = new RTCPeerConnection());
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const ms = (this.media = new MediaStream());
    pc.ontrack = (e) => ms.addTrack(e.track);
    v.srcObject = ms;
    await pc.setLocalDescription(await pc.createOffer());
    // Laukiame ICE kandidatų (be „trickle“ – paprasčiau ir veikia per bet kokį tarpininką)
    await new Promise((res) => {
      if (pc.iceGatheringState === 'complete') return res();
      const timer = setTimeout(res, 1500);
      pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && (clearTimeout(timer), res()));
    });
    const r = await fetch(whep, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp, signal });
    if (!r.ok) {
      let msg = await r.text().catch(() => '');
      try {
        msg = JSON.parse(msg).error || msg;
      } catch { /* tekstas */ }
      if (/timed out|no one is publishing|no stream is available/i.test(msg)) {
        const err = new Error(t('Šaltinis neatsako – patikrinkite adresą, slaptažodį ir ar kamera / dronas pasiekiami iš šio kompiuterio'));
        err.sourceDown = true;
        throw err;
      }
      if (/codecs? not supported/i.test(msg)) msg = t('naršyklė nepalaiko vaizdo kodeko ({m})', { m: msg.slice(0, 120) });
      throw new Error(r.status === 404 ? t('Transliacija nerasta (šaltinis nesiunčia vaizdo)') : `WebRTC: ${msg.slice(0, 200) || `HTTP ${r.status}`}`);
    }
    const loc = r.headers.get('location');
    // Sesijos adresas (uždarymui): MediaMTX grąžina „/<kelias>/whep/<id>“ – per tarpininką jį reikia pridėti prie mūsų adreso
    const i = loc ? loc.indexOf('/whep/') : -1;
    this.whepSession = i >= 0 ? whep + loc.slice(i + 5) : loc ? new URL(loc, whep).href : null;
    await pc.setRemoteDescription({ type: 'answer', sdp: await r.text() });
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && this.state === 'live' && this.pc === pc) this.fail(new Error(t('WebRTC ryšys nutrūko')));
    });
    await waitFirstFrame(v, START_TIMEOUT, signal);
    this.mode = label;
  }

  async playHls(url, signal, label) {
    const v = this.video();
    const native = v.canPlayType('application/vnd.apple.mpegurl');
    const { default: Hls } = await import('hls.js/light');
    if (Hls.isSupported()) {
      const hls = (this.hls = new Hls({ lowLatencyMode: true, liveSyncDurationCount: 2, maxLiveSyncPlaybackRate: 1.5, backBufferLength: 10, manifestLoadingMaxRetry: 2 }));
      const fatal = new Promise((_, rej) =>
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (!d.fatal) return;
          const err = new Error(d.response?.code ? `HLS: HTTP ${d.response.code}` : `HLS: ${d.details}`);
          if (this.state === 'live' && this.hls === hls) this.fail(err);
          rej(err);
        }),
      );
      fatal.catch(() => {});
      hls.on(Hls.Events.FRAG_LOADED, (_e, d) => (this._bytes = (this._bytes || 0) + (d.frag?.stats?.loaded || 0)));
      hls.loadSource(url);
      hls.attachMedia(v);
      await Promise.race([waitFirstFrame(v, START_TIMEOUT, signal), fatal]);
    } else if (native) {
      v.src = url;
      await waitFirstFrame(v, START_TIMEOUT, signal);
    } else throw new Error(t('Naršyklė nepalaiko HLS'));
    this.mode = label;
  }

  async playFile(url, signal) {
    const v = this.video();
    v.src = url;
    await waitFirstFrame(v, START_TIMEOUT, signal);
    v.addEventListener('error', () => this.state === 'live' && this.el === v && this.fail(new Error(t('Vaizdo srautas nutrūko'))));
    this.mode = 'Video';
  }

  async playImage(url, signal, refresh) {
    const img = document.createElement('img');
    img.className = 'live-media';
    img.alt = '';
    img.decoding = 'async';
    const load = (u) => {
      const p = waitFor(img, 'load', 'error', START_TIMEOUT, signal);
      img.src = u;
      return p;
    };
    this.host.replaceChildren(img);
    this.el = img;
    await load(url);
    this.mode = refresh ? t('Kadrai') : 'MJPEG';
    if (refresh) {
      // Kameros momentinis kadras: atnaujinamas kas sekundę
      (async () => {
        const sep = url.includes('?') ? '&' : '?';
        while (!signal.aborted && this.el === img) {
          await sleep(1000, signal).catch(() => {});
          if (signal.aborted) break;
          try {
            await load(`${url}${sep}_t=${Date.now()}`);
            this._frames++;
          } catch (e) {
            if (!signal.aborted) this.fail(e);
            break;
          }
        }
      })();
    } else img.addEventListener('error', () => this.state === 'live' && this.el === img && this.fail(new Error(t('Vaizdo srautas nutrūko'))));
  }

  playEmbed(url) {
    const f = document.createElement('iframe');
    f.className = 'live-media';
    f.src = url;
    f.allow = 'autoplay; fullscreen; picture-in-picture';
    f.allowFullscreen = true;
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    this.host.replaceChildren(f);
    this.el = f;
    this.mode = classify(this.stream.url).label || t('Puslapis');
    this.embedded = true;
  }

  // ---------------------------------------------------------------- stebėjimas
  /** Statistika ir užstrigimo aptikimas. */
  watch(signal) {
    const v = this.el instanceof HTMLVideoElement ? this.el : null;
    let lastT = -1, lastChange = performance.now(), lastFrames = 0, lastTick = performance.now(), lastBytes = 0;
    if (v && 'requestVideoFrameCallback' in v) {
      const cb = () => {
        if (signal.aborted || this.el !== v) return;
        this._frames++;
        v.requestVideoFrameCallback(cb);
      };
      v.requestVideoFrameCallback(cb);
    }
    clearInterval(this._statTimer);
    this._statTimer = setInterval(async () => {
      if (signal.aborted) return clearInterval(this._statTimer);
      const now = performance.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;
      const s = {};
      if (v) {
        s.w = v.videoWidth;
        s.h = v.videoHeight;
        if (v.currentTime !== lastT) {
          lastT = v.currentTime;
          lastChange = now;
        } else if (now - lastChange > STALL_TIMEOUT && !v.paused) {
          return this.fail(new Error(t('Vaizdas sustojo')));
        }
        if (v.paused && v.readyState >= 2) v.play().catch(() => {});
      } else if (this.el instanceof HTMLImageElement) {
        s.w = this.el.naturalWidth;
        s.h = this.el.naturalHeight;
      }
      s.fps = dt > 0 ? (this._frames - lastFrames) / dt : 0;
      lastFrames = this._frames;
      if (this.hls) {
        s.latency = this.hls.latency;
        const b = this._bytes || 0;
        if (lastBytes && dt > 0 && b > lastBytes) s.kbps = ((b - lastBytes) * 8) / 1000 / dt;
        else s.kbps = this.stats.kbps; // segmentai ateina ne kas sekundę
        lastBytes = b;
      }
      if (this.pc) {
        try {
          const rep = await this.pc.getStats();
          let bytes = 0, jb = 0, jc = 0;
          rep.forEach((r) => {
            if (r.type === 'inbound-rtp') {
              bytes += r.bytesReceived || 0;
              if (r.kind === 'video') {
                jb = r.jitterBufferDelay || 0;
                jc = r.jitterBufferEmittedCount || 0;
                if (r.framesPerSecond) s.fps = r.framesPerSecond;
              }
            }
          });
          if (lastBytes && dt > 0) s.kbps = ((bytes - lastBytes) * 8) / 1000 / dt;
          lastBytes = bytes;
          if (jc) s.latency = jb / jc + 0.1; // buferis + tinklas (apytiksliai)
        } catch { /* ignoruojame */ }
      }
      this.stats = s;
      this.onState(this);
    }, 1000);
  }

  // ---------------------------------------------------------------- veiksmai
  get canCapture() {
    return this.state === 'live' && (this.el instanceof HTMLVideoElement || this.el instanceof HTMLImageElement);
  }

  setMuted(m) {
    this.stream.muted = m;
    if (this.el instanceof HTMLVideoElement) {
      this.el.muted = m;
      if (!m) this.el.play().catch(() => {});
    }
  }

  get hasAudio() {
    if (this.media) return this.media.getAudioTracks().length > 0;
    const v = this.el;
    if (!(v instanceof HTMLVideoElement)) return false;
    return v.mozHasAudio || (v.webkitAudioDecodedByteCount ?? 0) > 0 || (v.audioTracks?.length ?? 0) > 0 || !!this.hls?.audioTracks?.length;
  }

  /** Kadras kaip PNG. */
  snapshot() {
    const el = this.el;
    const w = el.videoWidth || el.naturalWidth, h = el.videoHeight || el.naturalHeight;
    if (!w || !h) throw new Error(t('Dar nėra vaizdo'));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(el, 0, 0, w, h);
    return new Promise((res, rej) => {
      try {
        c.toBlob((b) => (b ? res(b) : rej(new Error('PNG'))), 'image/png');
      } catch {
        rej(new Error(t('Šaltinis neleidžia kopijuoti vaizdo – pasirinkite „Per serverį“')));
      }
    });
  }

  /** Įrašymo pradžia; grąžina Promise<Blob>, kuris išsipildo sustabdžius. */
  startRecording() {
    const el = this.el;
    let stream;
    if (this.media) stream = this.media;
    else if (el instanceof HTMLVideoElement) stream = (el.captureStream || el.mozCaptureStream)?.call(el);
    else if (el instanceof HTMLImageElement) {
      // MJPEG / kadrai: piešiama į drobę
      const c = document.createElement('canvas');
      c.width = el.naturalWidth;
      c.height = el.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(el, 0, 0);
      try {
        c.getContext('2d').getImageData(0, 0, 1, 1);
      } catch {
        throw new Error(t('Šaltinis neleidžia kopijuoti vaizdo – pasirinkite „Per serverį“'));
      }
      const id = setInterval(() => g.drawImage(el, 0, 0, c.width, c.height), 100);
      stream = c.captureStream(10);
      stream._stop = () => clearInterval(id);
    }
    if (!stream) throw new Error(t('Naršyklė negali įrašyti šio vaizdo'));
    const types = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    const mimeType = types.find((m) => window.MediaRecorder?.isTypeSupported?.(m));
    if (!mimeType) throw new Error(t('Naršyklė negali įrašyti šio vaizdo'));
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8e6 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((res) => {
      rec.onstop = () => {
        stream._stop?.();
        res(new Blob(chunks, { type: mimeType.split(';')[0] }));
      };
    });
    rec.start(1000);
    this.recorder = { rec, done, started: Date.now(), ext: mimeType.startsWith('video/mp4') ? 'mp4' : 'webm' };
    return this.recorder;
  }

  async stopRecording() {
    const r = this.recorder;
    if (!r) return null;
    this.recorder = null;
    if (r.rec.state !== 'inactive') r.rec.stop();
    return { blob: await r.done, ext: r.ext };
  }

  // ---------------------------------------------------------------- sustabdymas
  teardown() {
    clearInterval(this._statTimer);
    if (this.recorder) this.stopRecording().then((r) => r && this.onRecordingCut?.(r));
    if (this.whepSession) fetch(this.whepSession, { method: 'DELETE' }).catch(() => {});
    this.whepSession = null;
    this.hls?.destroy();
    this.hls = null;
    this.pc?.close();
    this.pc = null;
    this.media?.getTracks().forEach((tr) => tr.stop());
    this.media = null;
    if (this.el instanceof HTMLVideoElement) {
      this.el.removeAttribute('src');
      this.el.srcObject = null;
      this.el.load();
    } else if (this.el instanceof HTMLImageElement) this.el.removeAttribute('src');
    else if (this.el instanceof HTMLIFrameElement) this.el.src = 'about:blank';
    this.el = null;
    this.stats = {};
    this._bytes = 0;
    this.embedded = false;
  }

  stop(notify = true) {
    this.ctl?.abort();
    this.ctl = null;
    this.teardown();
    if (notify) this.set('idle');
  }
}
