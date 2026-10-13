// Failų įkėlimas: OBJ/MTL, GLB/GLTF, PLY, STL, FBX, DAE, 3MF, PCD, LAS, XYZ/PTS/TXT/CSV, ZIP
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { TIFFLoader } from 'three/examples/jsm/loaders/TIFFLoader.js';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { CRS, parseCoordsTxt, isLithuanianUtm, makeUtmToLks, reprojectUtmLocalObject, detectLasCrs } from './geo/georef.js';

const MODEL_PRIORITY = ['glb', 'gltf', 'obj', 'fbx', 'ply', 'las', 'laz', 'dae', '3mf', 'stl', 'pcd', 'xyz', 'pts', 'csv', 'txt'];
const MAX_POINTS = 25_000_000;

const ext = (name) => (name.split('.').pop() || '').toLowerCase();
const base = (name) => decodeURIComponent(name.split(/[\\/]/).pop().split('?')[0]).toLowerCase();

function readFile(file, asText, onProgress) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    r.onerror = () => reject(r.error || new Error('Nepavyko perskaityti failo'));
    r.onload = () => resolve(r.result);
    if (asText) r.readAsText(file);
    else r.readAsArrayBuffer(file);
  });
}

/** Išskleidžia ZIP archyvus į atskirus File objektus. */
async function expandZips(files, onStatus) {
  const out = [];
  for (const f of files) {
    if (ext(f.name) !== 'zip') {
      out.push(f);
      continue;
    }
    onStatus?.(`Išskleidžiamas archyvas ${f.name}…`);
    const buf = new Uint8Array(await f.arrayBuffer());
    const entries = unzipSync(buf);
    for (const [path, data] of Object.entries(entries)) {
      if (path.endsWith('/') || path.startsWith('__MACOSX')) continue;
      out.push(new File([data], path.split('/').pop(), { lastModified: Date.now() }));
    }
  }
  return out;
}

function dracoPath() {
  return location.protocol === 'file:' ? 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/' : './draco/';
}

/**
 * Įkelia modelį iš pasirinktų failų.
 * @returns {Promise<{object: THREE.Object3D, name: string, format: string, originOffset: THREE.Vector3, suggestedUp: 'y'|'z'|null, warnings: string[]}>}
 */
export async function loadModelFiles(fileList, { onProgress, onStatus } = {}) {
  let files = await expandZips(Array.from(fileList), onStatus);
  const byName = new Map();
  for (const f of files) byName.set(base(f.webkitRelativePath || f.name), f);

  // ODM rezultatai: coords.txt nurodo UTM zoną ir poslinkį
  const coordsFile = byName.get('coords.txt');
  const odmCoords = coordsFile ? parseCoordsTxt(await coordsFile.text()) : null;
  // ODM archyve gali būti keli OBJ – renkamės georeferencuotą
  const geoObj = files.find((f) => /_geo\.obj$/i.test(f.name));
  if (geoObj) files = files.filter((f) => ext(f.name) !== 'obj' || f === geoObj);

  const main = files
    .filter((f) => MODEL_PRIORITY.includes(ext(f.name)) && !/^(coords|geo|gcp_list|image_groups)\.txt$/i.test(f.name))
    .sort((a, b) => MODEL_PRIORITY.indexOf(ext(a.name)) - MODEL_PRIORITY.indexOf(ext(b.name)) || b.size - a.size)[0];
  if (!main) throw new Error('Nerastas palaikomas 3D failas. Palaikoma: OBJ, GLB/GLTF, PLY, LAS, STL, FBX, DAE, 3MF, PCD, XYZ, ZIP.');

  const warnings = [];
  const missing = new Set();
  const blobUrls = [];
  const urlFor = new Map();
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:')) return url;
    const key = base(url);
    const f = byName.get(key);
    if (f) {
      if (!urlFor.has(key)) {
        const u = URL.createObjectURL(f);
        blobUrls.push(u);
        urlFor.set(key, u);
      }
      return urlFor.get(key);
    }
    if (!url.startsWith('blob:')) missing.add(key);
    return url;
  });
  const tracker = trackManager(manager);
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  manager.addHandler(/\.tiff?$/i, new TIFFLoader(manager));

  const format = ext(main.name);
  onStatus?.(`Skaitomas ${main.name}…`);
  const textual = ['obj', 'dae', 'xyz', 'pts', 'csv', 'txt', 'gltf'].includes(format);
  const data = await readFile(main, textual, (p) => onProgress?.(p * 0.6));
  onStatus?.('Apdorojama geometrija…');
  onProgress?.(0.65);
  await nextFrame();

  let object;
  let originOffset = new THREE.Vector3();
  let suggestedUp = null;
  let crs = null;

  switch (format) {
    case 'glb':
    case 'gltf': {
      const loader = new GLTFLoader(manager);
      const draco = new DRACOLoader().setDecoderPath(dracoPath()); // be manager – dekoderio failai nėra modelio dalis
      loader.setDRACOLoader(draco);
      loader.setMeshoptDecoder(MeshoptDecoder);
      const ktx2 = new KTX2Loader().setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/basis/');
      loader.setKTX2Loader(ktx2);
      const gltf = await new Promise((res, rej) => loader.parse(data, '', res, rej));
      object = gltf.scene || gltf.scenes[0];
      suggestedUp = 'y';
      break;
    }
    case 'obj': {
      const objLoader = new OBJLoader(manager);
      const mtlName = (data.match(/^\s*mtllib\s+(.+?)\s*$/m) || [])[1];
      let mtlFile = mtlName ? byName.get(base(mtlName)) : null;
      if (!mtlFile) mtlFile = files.find((f) => ext(f.name) === 'mtl');
      if (mtlFile) {
        const mtlText = await mtlFile.text();
        const mtl = new MTLLoader(manager);
        mtl.setMaterialOptions({ side: THREE.DoubleSide });
        const materials = mtl.parse(mtlText, '');
        materials.preload();
        objLoader.setMaterials(materials);
      } else if (mtlName) {
        warnings.push(`Nerastas medžiagų failas „${mtlName}“ – modelis bus rodomas be tekstūrų.`);
      }
      // Georeferencuotos koordinatės (pvz. LKS-94) netelpa į Float32 tikslumą –
      // prieš analizuodami atimame poslinkį dvigubu tikslumu.
      const shifted = shiftLargeObjCoords(data);
      originOffset = shifted.offset;
      object = objLoader.parse(shifted.text);
      break;
    }
    case 'ply': {
      const geom = new PLYLoader(manager).parse(data);
      const header = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(8192, data.byteLength))).split('end_header')[0];
      const tex = (header.match(/comment\s+TextureFile\s+(.+?)\s*$/m) || [])[1];
      const faces = +((header.match(/element\s+face\s+(\d+)/) || [])[1] || 0);
      object = geometryToObject(geom, faces === 0, manager, tex);
      break;
    }
    case 'stl': {
      const geom = new STLLoader(manager).parse(data);
      object = geometryToObject(geom, false);
      suggestedUp = 'z';
      break;
    }
    case 'fbx':
      object = new FBXLoader(manager).parse(data, '');
      suggestedUp = 'y';
      break;
    case 'dae':
      object = new ColladaLoader(manager).parse(data, '').scene;
      suggestedUp = 'y';
      break;
    case '3mf':
      object = new ThreeMFLoader(manager).parse(data);
      suggestedUp = 'z';
      break;
    case 'pcd':
      object = new PCDLoader(manager).parse(data);
      break;
    case 'las':
    case 'laz': {
      onStatus?.(format === 'laz' ? 'Išskleidžiamas LAZ taškų debesis…' : 'Skaitomas LAS taškų debesis…');
      const r = await parseLAS(data, warnings, odmCoords ? { zone: odmCoords.zone } : null, (p) => onProgress?.(0.65 + p * 0.3));
      object = r.object;
      originOffset = r.offset;
      crs = r.crs;
      suggestedUp = 'z';
      break;
    }
    case 'xyz':
    case 'pts':
    case 'csv':
    case 'txt': {
      const r = parseXYZ(data, warnings);
      object = r.object;
      originOffset = r.offset;
      suggestedUp = 'z';
      break;
    }
    default:
      throw new Error(`Formatas .${format} nepalaikomas`);
  }

  // Palaukiame, kol įsikels tekstūros
  await waitForManager(tracker, onProgress);
  if (missing.size) {
    const list = [...missing].filter((m) => !m.endsWith('.mtl')).slice(0, 4);
    if (list.length) warnings.push(`Nerasti failai: ${list.join(', ')}${missing.size > 4 ? '…' : ''}. Atidarykite visą aplanką arba ZIP.`);
  }
  setTimeout(() => blobUrls.forEach((u) => URL.revokeObjectURL(u)), 60_000);

  // ODM tekstūruotas modelis (UTM minus poslinkis) -> LKS-94
  if (odmCoords && format !== 'las' && format !== 'laz') {
    if (isLithuanianUtm(odmCoords.zone, odmCoords.south)) {
      onStatus?.('Perskaičiuojama į LKS-94…');
      await nextFrame();
      originOffset = reprojectUtmLocalObject(object, odmCoords);
      crs = CRS.LKS94;
      suggestedUp = 'z';
      warnings.push(`Modelis perskaičiuotas iš WGS84 / UTM ${odmCoords.zone}N į LKS-94.`);
    } else {
      originOffset = new THREE.Vector3(odmCoords.offE, odmCoords.offN, 0);
      crs = CRS.utm(odmCoords.zone);
      suggestedUp = 'z';
    }
  }

  prepareObject(object);
  return { object, name: main.name, format: format.toUpperCase(), originOffset, suggestedUp, warnings, crs };
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function shiftLargeObjCoords(text) {
  const m = text.match(/^v\s+(\S+)\s+(\S+)\s+(\S+)/m);
  const offset = new THREE.Vector3();
  if (!m) return { text, offset };
  const first = [+m[1], +m[2], +m[3]];
  if (!first.some((v) => Math.abs(v) > 5000)) return { text, offset };
  const o = first.map((v) => Math.round(v));
  offset.set(o[0], o[1], o[2]);
  const out = text.replace(/^v[ \t]+(\S+)[ \t]+(\S+)[ \t]+(\S+)/gm, (_s, x, y, z) => `v ${+x - o[0]} ${+y - o[1]} ${+z - o[2]}`);
  return { text: out, offset };
}

/** Seka visus LoadingManager užkrovimus (tekstūras ir pan.). */
function trackManager(manager) {
  const t = { started: 0, ended: 0 };
  const s = manager.itemStart.bind(manager);
  const e = manager.itemEnd.bind(manager);
  const er = manager.itemError.bind(manager);
  manager.itemStart = (u) => { t.started++; s(u); };
  manager.itemEnd = (u) => { t.ended++; e(u); };
  manager.itemError = (u) => { er(u); };
  return t;
}

async function waitForManager(tracker, onProgress) {
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, 60));
  while (tracker.ended < tracker.started && performance.now() - t0 < 60_000) {
    onProgress?.(0.7 + 0.25 * (tracker.ended / Math.max(1, tracker.started)));
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** BufferGeometry -> Mesh arba Points */
function geometryToObject(geom, isPoints, manager, textureName) {
  const hasColor = !!geom.attributes.color;
  if (isPoints) {
    return new THREE.Points(geom, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: hasColor, color: hasColor ? 0xffffff : 0xcfd8d4 }));
  }
  if (!geom.attributes.normal) geom.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: hasColor, color: hasColor ? 0xffffff : 0xc9d1cd, roughness: 0.85, side: THREE.DoubleSide });
  if (textureName && geom.attributes.uv) {
    mat.map = new THREE.TextureLoader(manager).load(textureName);
    mat.map.colorSpace = THREE.SRGBColorSpace;
    mat.vertexColors = false;
    mat.color.set(0xffffff);
  }
  return new THREE.Mesh(geom, mat);
}

/** Bendras paruošimas: medžiagos, normalės. */
function prepareObject(root) {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o.isMesh) {
      const g = o.geometry;
      if (!g.attributes.normal) g.computeVertexNormals();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        if (m.map) {
          m.map.colorSpace = THREE.SRGBColorSpace;
          m.map.anisotropy = 8;
        }
        if (g.attributes.color && !m.map && !m.vertexColors) m.vertexColors = true;
        m.side = THREE.DoubleSide;
      }
      o.frustumCulled = false;
    } else if (o.isPoints) {
      const m = o.material;
      if (o.geometry.attributes.color) m.vertexColors = true;
      m.sizeAttenuation = false;
    }
  });
}

// ---------------------------------------------------------------------------
// LAS (nesuspaustas) skaitymas
// ---------------------------------------------------------------------------
let lazPerfPromise = null;
async function getLazPerf() {
  if (!lazPerfPromise) {
    lazPerfPromise = (async () => {
      const [{ default: createLazPerf }, { default: wasmUrl }] = await Promise.all([
        import('laz-perf/lib/web/laz-perf.js'),
        import('laz-perf/lib/web/laz-perf.wasm?url'),
      ]);
      const wasmBinary = await (await fetch(wasmUrl)).arrayBuffer();
      return createLazPerf({ wasmBinary });
    })();
  }
  return lazPerfPromise;
}

/**
 * LAS / LAZ skaitymas. Jei faile nurodyta UTM 34N/35N sistema – taškai perskaičiuojami į LKS-94.
 * @param {{zone:number}|null} forceUtm – UTM zona, jei žinoma iš kitur (pvz. ODM coords.txt)
 */
async function parseLAS(buffer, warnings, forceUtm = null, onProgress) {
  const dv = new DataView(buffer);
  const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (sig !== 'LASF') throw new Error('Netinkamas LAS failas');
  const vMinor = dv.getUint8(25);
  const headerSize = dv.getUint16(94, true);
  const dataOffset = dv.getUint32(96, true);
  const numVlrs = dv.getUint32(100, true);
  const formatRaw = dv.getUint8(104);
  const compressed = !!(formatRaw & 0x80 || formatRaw & 0x40);
  const fmt = formatRaw & 0x3f;
  const recLen = dv.getUint16(105, true);
  let count = dv.getUint32(107, true);
  if (vMinor >= 4 && headerSize >= 375) {
    const big = Number(dv.getBigUint64(247, true));
    if (big > 0) count = big;
  }
  const sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
  const ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
  const maxX = dv.getFloat64(179, true), minX = dv.getFloat64(187, true);
  const maxY = dv.getFloat64(195, true), minY = dv.getFloat64(203, true);
  const maxZ = dv.getFloat64(211, true), minZ = dv.getFloat64(219, true);

  // Koordinačių sistema
  const detected = detectLasCrs(dv, headerSize, numVlrs);
  let crs = detected?.kind === 'lks' ? CRS.LKS94 : null;
  let toLks = null;
  const zone = forceUtm?.zone ?? (detected?.kind === 'utm' ? detected.zone : null);
  if (zone && isLithuanianUtm(zone, false)) {
    toLks = makeUtmToLks(zone, minX, minY, maxX, maxY);
    crs = CRS.LKS94;
    warnings.push(`Taškų debesis perskaičiuotas iš WGS84 / UTM ${zone}N į LKS-94.`);
  } else if (zone) crs = CRS.utm(zone);

  let center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  if (toLks) {
    const [e, n] = toLks(center.x, center.y);
    center = new THREE.Vector3(Math.round(e), Math.round(n), Math.round(center.z));
  }

  if (!compressed) count = Math.min(count, Math.floor((buffer.byteLength - dataOffset) / recLen));
  const stride = Math.max(1, Math.ceil(count / MAX_POINTS));
  if (stride > 1) warnings.push(`Taškų debesis labai didelis (${count.toLocaleString('lt-LT')} t.) – rodomas kas ${stride}-as taškas.`);
  const n = Math.floor(count / stride);

  const rgbOffset = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }[fmt];
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let maxC = 0;
  let minI = Infinity, maxI = -Infinity;
  const inten = rgbOffset == null ? new Float32Array(n) : null;

  const store = (k, rv, o) => {
    const X = rv.getInt32(o, true) * sx + ox, Y = rv.getInt32(o + 4, true) * sy + oy, Z = rv.getInt32(o + 8, true) * sz + oz;
    if (toLks) {
      const [e, nn] = toLks(X, Y);
      pos[k * 3] = e - center.x;
      pos[k * 3 + 1] = nn - center.y;
    } else {
      pos[k * 3] = X - center.x;
      pos[k * 3 + 1] = Y - center.y;
    }
    pos[k * 3 + 2] = Z - center.z;
    if (rgbOffset != null) {
      const r = rv.getUint16(o + rgbOffset, true), g = rv.getUint16(o + rgbOffset + 2, true), b = rv.getUint16(o + rgbOffset + 4, true);
      col[k * 3] = r; col[k * 3 + 1] = g; col[k * 3 + 2] = b;
      if (r > maxC) maxC = r;
      if (g > maxC) maxC = g;
      if (b > maxC) maxC = b;
    } else {
      const it = rv.getUint16(o + 12, true);
      inten[k] = it;
      if (it < minI) minI = it;
      if (it > maxI) maxI = it;
    }
  };

  if (!compressed) {
    for (let i = 0, k = 0; k < n; i += stride, k++) store(k, dv, dataOffset + i * recLen);
  } else {
    const L = await getLazPerf();
    const bytes = new Uint8Array(buffer);
    const filePtr = L._malloc(bytes.length);
    L.HEAPU8.set(bytes, filePtr);
    const laszip = new L.LASZip();
    try {
      laszip.open(filePtr, bytes.length);
      const pl = laszip.getPointLength();
      const total = Math.min(count, laszip.getCount());
      const dataPtr = L._malloc(pl);
      let rv = new DataView(L.HEAPU8.buffer, dataPtr, pl);
      for (let i = 0, k = 0; i < total && k < n; i++) {
        laszip.getPoint(dataPtr);
        if (rv.buffer !== L.HEAPU8.buffer) rv = new DataView(L.HEAPU8.buffer, dataPtr, pl);
        if (i % stride === 0) store(k++, rv, 0);
        if ((i & 0xfffff) === 0 && i) {
          onProgress?.(i / total);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      L._free(dataPtr);
    } finally {
      laszip.delete();
      L._free(filePtr);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  let hasColor = false;
  if (rgbOffset != null && maxC > 0) {
    const div = maxC > 255 ? 65535 : 255;
    for (let i = 0; i < col.length; i++) col[i] = srgbToLinear(col[i] / div);
    hasColor = true;
  } else if (inten && maxI > minI) {
    for (let k = 0; k < n; k++) {
      const v = srgbToLinear(0.15 + 0.85 * ((inten[k] - minI) / (maxI - minI)));
      col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = v;
    }
    hasColor = true;
  }
  if (hasColor) geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(geom, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: hasColor, color: hasColor ? 0xffffff : 0xcfd8d4 }));
  return { object: pts, offset: center, crs };
}

function srgbToLinear(c) {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

// ---------------------------------------------------------------------------
// XYZ / PTS / CSV / TXT taškų debesys
// ---------------------------------------------------------------------------
function parseXYZ(text, warnings) {
  const lines = text.split(/\r?\n/);
  const pos = [];
  const col = [];
  let offset = null;
  let colorScale = 0;
  let cols = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line || line[0] === '#' || line[0] === '/') continue;
    const parts = line.split(/[\s,;]+/);
    if (parts.length < 3) continue;
    const x = +parts[0], y = +parts[1], z = +parts[2];
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    if (!offset) {
      offset = new THREE.Vector3(x, y, z);
      cols = parts.length;
    }
    pos.push(x - offset.x, y - offset.y, z - offset.z);
    let r, g, b;
    if (cols >= 7) { r = +parts[4]; g = +parts[5]; b = +parts[6]; }
    else if (cols >= 6) { r = +parts[3]; g = +parts[4]; b = +parts[5]; }
    if (r != null && isFinite(r)) {
      col.push(r, g, b);
      colorScale = Math.max(colorScale, r, g, b);
    }
  }
  if (!pos.length) throw new Error('Taškų faile nerasta koordinačių');
  // Perkeliam į centrą (dvigubu tikslumu jau atimtas pirmas taškas)
  const geom = new THREE.BufferGeometry();
  const arr = new Float32Array(pos);
  geom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  let hasColor = false;
  if (col.length === pos.length && colorScale > 0) {
    const div = colorScale > 1.0001 ? (colorScale > 255 ? 65535 : 255) : 1;
    const c = new Float32Array(col.length);
    for (let i = 0; i < col.length; i++) c[i] = srgbToLinear(col[i] / div);
    geom.setAttribute('color', new THREE.BufferAttribute(c, 3));
    hasColor = true;
  }
  if (pos.length / 3 > MAX_POINTS) warnings.push('Labai didelis taškų debesis – darbas gali būti lėtas.');
  const pts = new THREE.Points(geom, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: hasColor, color: hasColor ? 0xffffff : 0xcfd8d4 }));
  return { object: pts, offset };
}
