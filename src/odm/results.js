// ODM rezultatų archyvo (all.zip) skaitymas srautu – išskleidžiami tik reikalingi failai,
// todėl kelių GB archyvo nereikia laikyti atmintyje.
import { Unzip, UnzipInflate } from 'three/examples/jsm/libs/fflate.module.js';
import { t } from '../i18n.js';

// ODM 3.x kuria ir GLB (Draco, įterptos JPEG tekstūros) – jis kelis kartus mažesnis už OBJ + PNG
export const WANT_MODEL_GLB = (path) => path === 'odm_georeferencing/coords.txt' || path === 'odm_texturing/odm_textured_model_geo.glb';

export const WANT_MODEL = (path) =>
  path === 'odm_georeferencing/coords.txt' ||
  (/^odm_texturing\//.test(path) && !/\/$/.test(path) && !/_labeling\.vec$|\.conf$|_unaligned\.obj$|\.glb$/i.test(path) && !/odm_textured_model\.(obj|mtl)$/i.test(path));

/** Failai tiesiai iš serverio (nginx /odm/files/<uuid>/…): 3D modelis ir taškų debesis be viso all.zip. */
export const DIRECT_MODEL = ['odm_georeferencing/coords.txt', 'odm_texturing/odm_textured_model_geo.glb'];
export const DIRECT_POINTS = ['odm_georeferencing/coords.txt', 'odm_georeferencing/odm_georeferenced_model.laz'];

/**
 * ODM rezultatų failai tiesiai iš serverio. null – serveris taip neatiduoda (pvz. kitas NodeODM ar senas
 * serveris) arba failo nėra – tada naudojamas all.zip.
 * @param {string} base – pvz. „./odm/files/<uuid>/“
 * @param {string[]} paths
 * @returns {Promise<File[]|null>}
 */
export async function fetchDirect(base, paths, onProgress, signal) {
  if (!base) return null;
  const opened = [];
  const drop = () => opened.forEach(([, r]) => r.body?.cancel().catch(() => {}));
  for (const p of paths) {
    const r = await fetch(base + p, { signal, credentials: 'same-origin' }).catch(() => null);
    if (!r?.ok || /json|html/i.test(r.headers.get('content-type') || '')) {
      r?.body?.cancel().catch(() => {});
      drop();
      return null;
    }
    opened.push([p, r]);
  }
  const total = opened.reduce((s, [, r]) => s + (+r.headers.get('content-length') || 0), 0);
  let loaded = 0;
  const files = [];
  for (const [p, r] of opened) {
    const reader = r.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress?.(total ? loaded / total : 0, loaded);
    }
    files.push(new File(chunks, p.split('/').pop()));
  }
  return files;
}

export const WANT_POINTS = (path) => path === 'odm_georeferencing/coords.txt' || path === 'odm_georeferencing/odm_georeferenced_model.laz';

/**
 * @param {string} url – all.zip adresas
 * @param {(path:string)=>boolean} want
 * @returns {Promise<File[]>}
 */
export async function extractFromZipUrl(url, want, onProgress, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(t('Nepavyko atsisiųsti rezultatų (HTTP {s})', { s: res.status }));
  const ctype = res.headers.get('content-type') || '';
  if (ctype.includes('json')) {
    const j = await res.json();
    throw new Error(j.error || t('Rezultatai dar neparuošti'));
  }
  const total = +res.headers.get('content-length') || 0;
  const files = [];
  const pending = [];
  const uz = new Unzip((entry) => {
    if (!want(entry.name)) return;
    const chunks = [];
    pending.push(
      new Promise((resolve, reject) => {
        entry.ondata = (err, data, final) => {
          if (err) return reject(err);
          chunks.push(data);
          if (final) {
            files.push(new File(chunks, entry.name.split('/').pop()));
            resolve();
          }
        };
      }),
    );
    entry.start();
  });
  uz.register(UnzipInflate);

  const reader = res.body.getReader();
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      uz.push(new Uint8Array(0), true);
      break;
    }
    loaded += value.length;
    uz.push(value);
    onProgress?.(total ? loaded / total : 0, loaded);
  }
  await Promise.all(pending);
  return files;
}
