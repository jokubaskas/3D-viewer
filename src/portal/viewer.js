// Failų peržiūra programos lange: vaizdo įrašai ir HTML ataskaitos (iš AI įrašo ZIP).
// Ataskaita rodoma izoliuotame rėmelyje be skriptų (sandbox be allow-scripts, CSP – tik vietiniai failai),
// todėl net ir pakeistas ZIP negali nieko daryti vartotojo sesijos vardu; perėjimą vaizde valdo ši programa.
import { icon } from '../icons.js';
import { t } from '../i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function frame(title, actions, onClose) {
  const d = document.createElement('dialog');
  d.className = 'dialog fv';
  d.innerHTML = `<div class="fv-head"><b title="${esc(title)}">${esc(title)}</b><span class="fv-tools">${actions}<button class="btn btn-ghost btn-sm icon-only" data-fv="close" title="${esc(t('Uždaryti'))}">${icon('close')}</button></span></div><div class="fv-body"></div>`;
  document.body.append(d);
  d.querySelector('[data-fv=close]').addEventListener('click', () => d.close());
  d.addEventListener('close', () => {
    onClose?.();
    d.remove();
  });
  d.showModal();
  return d;
}

/** MediaRecorder WebM be trukmės: naršyklė rodo „∞“ – nušokus į galą ji perskaičiuojama. */
function fixInfinite(v) {
  const run = () => {
    if (Number.isFinite(v.duration)) return;
    const back = () => {
      if (!Number.isFinite(v.duration)) return;
      v.removeEventListener('durationchange', back);
      clearTimeout(giveUp);
      v.currentTime = 0;
    };
    // Jei failo prasukti neįmanoma (pvz. fragmentuotas MP4) – grįžtama į pradžią, kad bent grotų
    const giveUp = setTimeout(() => {
      v.removeEventListener('durationchange', back);
      if (v.currentTime > 0 || v.seeking) v.currentTime = 0;
    }, 3000);
    v.addEventListener('durationchange', back);
    v.currentTime = 1e101;
  };
  if (v.readyState >= 1) run();
  else v.addEventListener('loadedmetadata', run, { once: true });
}

export function openVideo(url, title, downloadUrl) {
  const d = frame(title, downloadUrl ? `<a class="btn btn-outline btn-sm" href="${esc(downloadUrl)}">${icon('save')}${esc(t('Atsisiųsti'))}</a>` : '');
  const v = document.createElement('video');
  v.controls = true;
  v.preload = 'auto';
  v.playsInline = true;
  fixInfinite(v);
  v.src = url;
  d.querySelector('.fv-body').append(v);
  // Jei naršyklė įrašo parodyti negali – paaiškinimas vietoj juodo lango
  const msg = document.createElement('div');
  msg.className = 'fv-msg';
  msg.hidden = true;
  d.querySelector('.fv-body').append(msg);
  const explain = (why) => {
    if (!d.open || (v.readyState >= 2 && !v.error)) return;
    msg.innerHTML = `<b>${esc(t('Šio įrašo naršyklė parodyti negali'))}</b><span>${esc(why)}</span><span>${esc(t('Jei įrašas ką tik įkeltas, serveris jį dar tvarko – pabandykite po minutės. Kitu atveju atsisiųskite jį ir atidarykite kompiuterio grotuvu (pvz. VLC).'))}</span>`;
    msg.hidden = false;
  };
  v.addEventListener('error', () => explain(v.error?.message || t('Netinkamas arba nepalaikomas vaizdo formatas')));
  v.addEventListener('playing', () => (msg.hidden = true));
  const timer = setTimeout(() => explain(t('Vaizdas neužsikrovė per 15 s.')), 15000);
  d.addEventListener('close', () => {
    clearTimeout(timer);
    v.removeAttribute('src');
    v.load();
  });
  v.play().catch(() => {});
}

// ---------------------------------------------------------------- ZIP (be viso failo išskleidimo atmintyje)
async function zipEntries(blob) {
  const tailLen = Math.min(blob.size, 65557);
  const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
  let p = -1;
  for (let i = tailLen - 22; i >= 0; i--)
    if (tail.getUint32(i, true) === 0x06054b50) {
      p = i;
      break;
    }
  if (p < 0) throw new Error(t('Tai ne ZIP failas'));
  const count = tail.getUint16(p + 10, true);
  const cdSize = tail.getUint32(p + 12, true);
  const cdOff = tail.getUint32(p + 16, true);
  if (count === 0xffff || cdOff === 0xffffffff) throw new Error(t('Per didelis ZIP (ZIP64) – atsisiųskite jį'));
  const cd = new DataView(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const out = new Map();
  for (let q = 0, n = 0; n < count && q + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(q, true) !== 0x02014b50) break;
    const method = cd.getUint16(q + 10, true);
    const csize = cd.getUint32(q + 20, true);
    const nlen = cd.getUint16(q + 28, true);
    const xlen = cd.getUint16(q + 30, true);
    const clen = cd.getUint16(q + 32, true);
    const lho = cd.getUint32(q + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, q + 46, nlen));
    q += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    out.set(name, async (type) => {
      const lh = new DataView(await blob.slice(lho, lho + 30).arrayBuffer());
      const start = lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const data = blob.slice(start, start + csize, type);
      if (method === 0) return data;
      if (method !== 8) throw new Error(t('Nepalaikomas ZIP glaudinimas'));
      const { inflateSync } = await import('three/examples/jsm/libs/fflate.module.js');
      return new Blob([inflateSync(new Uint8Array(await data.arrayBuffer()))], { type });
    });
  }
  return out;
}

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', svg: 'image/svg+xml' };
const SAFE_MEDIA = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm))$/;
const CSP = "default-src 'none'; img-src blob: data:; media-src blob:; style-src 'unsafe-inline'; font-src data:";

/**
 * HTML ataskaita iš ZIP (arba atskiras .html) → peržiūros langas.
 * @param {Blob} blob ZIP ar HTML
 * @param {{title:string, downloadUrl:string, html?:boolean}} o
 */
export async function openReport(blob, { title, downloadUrl, html: isHtml }) {
  const urls = [];
  let text;
  let entries = new Map();
  if (isHtml) text = await blob.text();
  else {
    entries = await zipEntries(blob);
    const main = entries.has('ataskaita.html') ? 'ataskaita.html' : [...entries.keys()].find((n) => /\.html?$/i.test(n) && !n.includes('/'));
    if (!main) throw new Error(t('ZIP faile nėra HTML ataskaitos'));
    text = await (await entries.get(main)()).text();
  }
  const doc = new DOMParser().parseFromString(text, 'text/html');
  doc.querySelectorAll('script, iframe, frame, object, embed, base, link, meta, form, noscript').forEach((x) => x.remove());
  const cache = new Map();
  const local = async (ref) => {
    const name = decodeURIComponent(ref.split(/[?#]/)[0]).replace(/^\.\//, '');
    if (!entries.has(name)) return null;
    if (!cache.has(name)) {
      const type = MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';
      if (!SAFE_MEDIA.test(type)) return null; // SVG ir kt. su galimais skriptais – nerodoma
      const u = URL.createObjectURL(await entries.get(name)(type));
      urls.push(u);
      cache.set(name, u);
    }
    return cache.get(name);
  };
  for (const x of doc.querySelectorAll('*')) {
    for (const a of [...x.attributes]) if (/^on/i.test(a.name) || a.name === 'srcset' || a.name === 'formaction') x.removeAttribute(a.name);
    for (const a of ['src', 'poster']) {
      const v = x.getAttribute(a);
      if (v == null) continue;
      const u = await local(v);
      if (u) x.setAttribute(a, u);
      else x.removeAttribute(a);
    }
    const h = x.getAttribute('href');
    if (h != null) {
      const u = /^https?:\/\//i.test(h) ? h : await local(h);
      if (u) {
        x.setAttribute('href', u);
        x.setAttribute('target', '_blank');
        x.setAttribute('rel', 'noopener noreferrer');
      } else x.removeAttribute('href');
    }
  }
  const m = doc.createElement('meta');
  m.httpEquiv = 'Content-Security-Policy';
  m.content = CSP;
  doc.head.prepend(m);

  const d = frame(
    title,
    `<button class="btn btn-outline btn-sm" data-fv="print">${icon('report')}${esc(t('Spausdinti / PDF'))}</button><a class="btn btn-outline btn-sm" href="${esc(downloadUrl)}">${icon('save')}${esc(t(isHtml ? 'Atsisiųsti' : 'Atsisiųsti ZIP'))}</a>`,
    () => urls.forEach((u) => URL.revokeObjectURL(u)),
  );
  const f = document.createElement('iframe');
  f.className = 'fv-report';
  // Be allow-scripts: ataskaitos skriptai nevykdomi; allow-same-origin – kad ši programa galėtų valdyti vaizdą
  f.sandbox = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-modals';
  f.referrerPolicy = 'no-referrer';
  f.srcdoc = `<!doctype html>${doc.documentElement.outerHTML}`;
  d.querySelector('.fv-body').append(f);
  d.querySelector('[data-fv=print]').addEventListener('click', () => f.contentWindow?.print());
  f.addEventListener('load', () => wireReport(f.contentDocument));
}

/** Ataskaitos sąveika (vietoj jos pačios skripto): įvykio laikas ar grafikas → peršokti vaizde. */
function wireReport(doc) {
  const v = doc?.querySelector('video');
  if (!v) return;
  fixInfinite(v);
  const seek = (s) => {
    v.currentTime = s;
    v.play().catch(() => {});
    v.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  doc.addEventListener('click', (e) => {
    const a = e.target.closest?.('a.t[data-t]');
    if (a) return seek(+a.dataset.t || 0);
    const c = e.target.closest?.('#chart');
    if (!c) return;
    const r = c.getBoundingClientRect();
    const W = +c.dataset.w;
    const P = +c.dataset.p;
    const x = ((e.clientX - r.left) / r.width) * W;
    seek((Math.max(0, (x - P) / (W - P - 10)) * c.dataset.dur) / 1000);
  });
}
