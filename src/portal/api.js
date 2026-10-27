// Portalo API (deploy/portal): paskyros, klientams priskirti duomenys. Visos užklausos – su sesijos slapuku;
// keičiančios – su antrašte X-Atea (serveris be jos atmeta – apsauga nuo kitų svetainių užklausų).
import { t } from '../i18n.js';

export class ApiError extends Error {
  constructor(msg, status) {
    super(msg);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { ...headers }, cache: 'no-store' };
  if (method !== 'GET') opts.headers['X-Atea'] = '1';
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(`./api/${path}`, opts);
  } catch {
    throw new ApiError(t('Serveris nepasiekiamas'), 0);
  }
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch { /* ne JSON */ }
  if (!r.ok) throw new ApiError(data?.detail || (r.status === 401 ? t('Prisijunkite') : `HTTP ${r.status}`), r.status);
  return data;
}

/** Viena užklausa su eiga. */
function putBlob(url, body, onProgress) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('X-Atea', '1');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded);
    x.onload = () => {
      let d = null;
      try {
        d = JSON.parse(x.responseText);
      } catch { /* ne JSON */ }
      if (x.status >= 200 && x.status < 300) res(d);
      else rej(Object.assign(new ApiError(d?.detail || (x.status === 413 ? t('Failas per didelis vienai užklausai') : `HTTP ${x.status}`), x.status), { data: d }));
    };
    x.onerror = () => rej(new ApiError(t('Ryšys nutrūko'), 0));
    x.send(body);
  });
}

const CHUNK = 32 * 1024 * 1024; // per Cloudflare vienos užklausos riba – 100 MB (nemokamas planas)

/**
 * Failo įkėlimas (be multipart – tinka ir keliems GB) su eiga. Didesni nei 64 MB – dalimis po 32 MB:
 * taip praeina per Cloudflare, o nutrūkus ryšiui tęsiama nuo paskutinės gautos dalies (iki 6 bandymų).
 */
export async function uploadFile(itemId, file, name, onProgress) {
  const base = `./api/items/${itemId}/files?name=${encodeURIComponent(name)}`;
  if (file.size <= 2 * CHUNK) return putBlob(base, file, (n) => onProgress?.(n / (file.size || 1)));
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  let offset = 0;
  let fails = 0;
  for (;;) {
    const end = Math.min(file.size, offset + CHUNK);
    try {
      const r = await putBlob(`${base}&upload=${id}&offset=${offset}&total=${file.size}`, file.slice(offset, end), (n) => onProgress?.((offset + n) / file.size));
      fails = 0;
      if (r?.done === false) offset = r.have;
      else return r;
    } catch (e) {
      if (e.status === 409 && e.data?.have != null) {
        offset = e.data.have; // serveris jau turi daugiau / mažiau – tęsiame nuo ten
        continue;
      }
      if (++fails > 6 || (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429)) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** fails));
    }
  }
}

export const fileUrl = (item, f, download = false) => `./api/items/${item.id}/files/${f.id}/${encodeURIComponent(f.name.split('/').pop())}${download ? '?download=1' : ''}`;

/** Prisijungęs vartotojas; null – portalo nėra (programa atidaryta iš disko ar be serverio) arba neprisijungta. */
export async function whoAmI() {
  if (location.protocol === 'file:') return { mode: 'local' };
  try {
    const r = await fetch('./api/me', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) return { mode: 'login' };
    if (r.status >= 500) return { mode: 'down' }; // portalas paleidžiamas arba sustojęs
    if (!r.ok) return { mode: 'local' }; // 404 – serveryje nėra portalo (pvz. kūrimo režimas)
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) return { mode: 'local' };
    return { mode: 'user', user: await r.json() };
  } catch {
    return { mode: 'local' };
  }
}
