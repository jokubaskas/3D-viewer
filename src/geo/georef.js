// Georeferencavimas: ODM / UTM rezultatų perskaičiavimas į LKS-94 (EPSG:3346).
import * as THREE from 'three';
import { LKS94, UTM, utmToLks, fitFastTransform } from './tm.js';

export const CRS = {
  LKS94: { id: 'LKS94', name: 'LKS-94 (EPSG:3346)', epsg: 3346, geodetic: true },
  LOCAL: { id: 'LOCAL', name: 'Vietinė / nežinoma', epsg: null, geodetic: false },
  utm: (zone) => ({ id: `UTM${zone}`, name: `WGS84 / UTM ${zone}N (EPSG:${32600 + zone})`, epsg: 32600 + zone, geodetic: false }),
};

/** ODM coords.txt: „WGS84 UTM 34N“ ir „rytai šiaurė“ poslinkis. */
export function parseCoordsTxt(text) {
  const lines = text.trim().split(/\r?\n/);
  const m = lines[0]?.match(/WGS84\s+UTM\s+(\d+)\s*([NS])/i);
  if (!m) return null;
  const [e, n] = (lines[1] || '').trim().split(/\s+/).map(Number);
  if (!isFinite(e) || !isFinite(n)) return null;
  return { zone: +m[1], south: m[2].toUpperCase() === 'S', offE: e, offN: n };
}

/** Ar UTM zona tinka Lietuvai (34N arba 35N). */
export const isLithuanianUtm = (zone, south) => !south && (zone === 34 || zone === 35);

/**
 * Sukuria greitą UTM -> LKS-94 transformaciją srities ribose.
 * @returns {(E:number, N:number) => [number, number]}
 */
export function makeUtmToLks(zone, minE, minN, maxE, maxN) {
  const pad = Math.max(maxE - minE, maxN - minN, 10) * 0.05;
  const exact = (E, N) => utmToLks(zone, E, N);
  const fast = fitFastTransform(exact, minE - pad, minN - pad, maxE + pad, maxN + pad);
  return fast.maxErr < 1e-4 ? fast.fn : exact; // < 0,1 mm, kitaip – tikslus skaičiavimas kiekvienam taškui
}

/**
 * ODM tekstūruotas modelis: viršūnės yra UTM minus poslinkis (coords.txt).
 * Perskaičiuoja į LKS-94 ir grąžina naują poslinkį (originOffset), kad Float32 tikslumas išliktų.
 */
export function reprojectUtmLocalObject(object, { zone, offE, offN }) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const fn = makeUtmToLks(zone, box.min.x + offE, box.min.y + offN, box.max.x + offE, box.max.y + offN);
  const [oE, oN] = utmToLks(zone, offE, offN);
  const origin = new THREE.Vector3(Math.round(oE), Math.round(oN), 0);
  const seen = new Set();
  object.traverse((o) => {
    if (!(o.isMesh || o.isPoints) || seen.has(o.geometry)) return;
    seen.add(o.geometry);
    const pos = o.geometry.attributes.position;
    const a = pos.array;
    for (let i = 0; i < pos.count; i++) {
      const [e, n] = fn(a[i * 3] + offE, a[i * 3 + 1] + offN);
      a[i * 3] = e - origin.x;
      a[i * 3 + 1] = n - origin.y;
    }
    pos.needsUpdate = true;
    o.geometry.computeBoundingBox();
    o.geometry.computeBoundingSphere();
  });
  return origin;
}

/** LAS VLR'uose ieško koordinačių sistemos (GeoTIFF raktai arba WKT). */
export function detectLasCrs(dv, headerSize, numVlrs) {
  let p = headerSize;
  let text = '';
  for (let k = 0; k < numVlrs && p + 54 <= dv.byteLength; k++) {
    const recordId = dv.getUint16(p + 18, true);
    const len = dv.getUint16(p + 20, true);
    const data = p + 54;
    if (recordId === 34735 && data + 8 <= dv.byteLength) {
      const nKeys = dv.getUint16(data + 6, true);
      for (let i = 0; i < nKeys; i++) {
        const o = data + 8 + i * 8;
        if (o + 8 > dv.byteLength) break;
        const keyId = dv.getUint16(o, true), loc = dv.getUint16(o + 2, true), val = dv.getUint16(o + 6, true);
        if (keyId === 3072 && loc === 0) return epsgToCrs(val);
      }
    } else if (recordId === 2112 || recordId === 2111) {
      text += new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset + data, Math.min(len, dv.byteLength - data)));
    }
    p = data + len;
  }
  if (text) {
    const ep = [...text.matchAll(/(?:AUTHORITY|ID)\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi)].map((m) => +m[1]);
    for (const c of ep.reverse()) {
      const crs = epsgToCrs(c);
      if (crs) return crs;
    }
    const z = text.match(/UTM zone (\d+)N/i);
    if (z) return { kind: 'utm', zone: +z[1] };
    if (/LKS[ -]?94|Lithuania 1994/i.test(text)) return { kind: 'lks' };
  }
  return null;
}

function epsgToCrs(code) {
  if (code >= 32601 && code <= 32660) return { kind: 'utm', zone: code - 32600 };
  if (code >= 25828 && code <= 25838) return { kind: 'utm', zone: code - 25800 }; // ETRS89 / UTM
  if (code === 3346) return { kind: 'lks' };
  return null;
}

export { LKS94, UTM, utmToLks };
