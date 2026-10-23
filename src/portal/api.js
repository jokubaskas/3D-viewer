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

/** Failo įkėlimas (be multipart – tinka ir keliems GB) su eiga. */
export function uploadFile(itemId, file, name, onProgress) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `./api/items/${itemId}/files?name=${encodeURIComponent(name)}`);
    x.setRequestHeader('X-Atea', '1');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => {
      let d = null;
      try {
        d = JSON.parse(x.responseText);
      } catch { /* ne JSON */ }
      if (x.status >= 200 && x.status < 300) res(d);
      else rej(new ApiError(d?.detail || `HTTP ${x.status}`, x.status));
    };
    x.onerror = () => rej(new ApiError(t('Ryšys nutrūko'), 0));
    x.send(file);
  });
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
