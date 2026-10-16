// 3D modelio išsaugojimas kompiuteryje: OBJ (ZIP su tekstūromis, tikros LKS-94 / failo koordinatės),
// GLB (peržiūros programoms) ir LAS (taškų debesis).
import * as THREE from 'three';
import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Originalios (failo / LKS-94) koordinatės iš modelRoot lokalių: centras + kontrolinių taškų pataisa,
 * kalibravimo mastelis taikomas santykiniams dydžiams nuo centro (kaip programoje).
 */
function originMapper(viewer, units) {
  const c = viewer.center.clone().add(viewer.datumShift);
  const k = units.calibration || 1;
  const inv = new THREE.Matrix4().copy(viewer.modelRoot.matrixWorld).invert();
  return { c, k, inv };
}

async function textureBlob(tex) {
  const img = tex?.image;
  if (!img || !(img.width || img.videoWidth)) return null;
  const cv = document.createElement('canvas');
  cv.width = img.width;
  cv.height = img.height;
  const g = cv.getContext('2d');
  if (img.data && !(img instanceof ImageBitmap)) {
    // DataTexture
    const id = g.createImageData(img.width, img.height);
    id.data.set(img.data.length === id.data.length ? img.data : new Uint8ClampedArray(id.data.length));
    g.putImageData(id, 0, 0);
  } else g.drawImage(img, 0, 0);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/**
 * OBJ + MTL + tekstūros vienu ZIP. Koordinatės – originalios (LKS-94 georeferencuotiems modeliams),
 * ašys kaip faile (ODM / LAS – Z aukštyn, kaip GIS / CAD programose).
 * @returns {Promise<Blob>}
 */
export async function exportObjZip(viewer, units, baseName, onProgress) {
  const { c, k, inv } = originMapper(viewer, units);
  const lines = [];
  const mtl = [];
  const files = {};
  const texIndex = new Map(); // Texture -> failo vardas
  const matIndex = new Map(); // Material -> pavadinimas
  const v = new THREE.Vector3();
  let vBase = 1, vtBase = 1;
  const fmt = (x) => (Math.round(x * 1e4) / 1e4).toString();
  // modelRoot lokalios ašys sutampa su failo ašimis (be centro) – rašome originalias koordinates
  const toOrig = (p) => `${fmt(p.x * k + c.x)} ${fmt(p.y * k + c.y)} ${fmt(p.z * k + c.z)}`;
  lines.push(`# Atea 3D Matuoklis – ${baseName}`);
  lines.push(`# Koordinačių sistema: ${viewer.crs?.name || 'failo koordinatės'}${viewer.heightSystem ? `; aukščiai: ${viewer.heightSystem}` : ''}; ${viewer.upAxis === 'z' ? 'Z' : 'Y'} – aukštis`);
  lines.push(`mtllib ${baseName}.mtl`);

  const meshes = viewer.meshes;
  for (let mi = 0; mi < meshes.length; mi++) {
    const mesh = meshes[mi];
    const g = mesh.geometry;
    const pos = g.attributes.position, uv = g.attributes.uv;
    const m = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    const mats = [].concat(mesh.userData.origMaterial || mesh.material);
    lines.push(`o ${(mesh.name || `mesh_${mi}`).replace(/\s+/g, '_')}`);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      lines.push(`v ${toOrig(v)}`);
    }
    // Tekstūros koordinatės: OBJ v=0 – apačia; glTF tekstūros (flipY=false) – atvirkščiai
    const flip = !(mats[0]?.map?.flipY ?? true);
    if (uv) for (let i = 0; i < uv.count; i++) lines.push(`vt ${fmt(uv.getX(i))} ${fmt(flip ? 1 - uv.getY(i) : uv.getY(i))}`);
    // Medžiagos
    const names = [];
    for (const mat of mats) {
      if (!mat) {
        names.push(null);
        continue;
      }
      if (!matIndex.has(mat)) {
        const name = `mat_${matIndex.size}`;
        matIndex.set(mat, name);
        const col = mat.color || new THREE.Color(1, 1, 1);
        mtl.push(`newmtl ${name}`, `Kd ${col.r.toFixed(4)} ${col.g.toFixed(4)} ${col.b.toFixed(4)}`, 'Ka 0 0 0', 'Ks 0 0 0', 'd 1', 'illum 1');
        if (mat.map) {
          if (!texIndex.has(mat.map)) {
            const data = await textureBlob(mat.map);
            const fname = `${baseName}_tex${texIndex.size}.jpg`;
            texIndex.set(mat.map, data ? fname : null);
            if (data) files[fname] = [data, { level: 0 }];
          }
          if (texIndex.get(mat.map)) mtl.push(`map_Kd ${texIndex.get(mat.map)}`);
        }
        mtl.push('');
      }
      names.push(matIndex.get(mat));
    }
    const idx = g.index;
    const triCount = idx ? idx.count : pos.count;
    const groups = g.groups.length ? g.groups : [{ start: 0, count: triCount, materialIndex: 0 }];
    for (const grp of groups) {
      const name = names[grp.materialIndex ?? 0] || names[0];
      if (name) lines.push(`usemtl ${name}`);
      for (let i = grp.start; i < grp.start + grp.count; i += 3) {
        const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, d = idx ? idx.getX(i + 2) : i + 2;
        lines.push(uv ? `f ${a + vBase}/${a + vtBase} ${b + vBase}/${b + vtBase} ${d + vBase}/${d + vtBase}` : `f ${a + vBase} ${b + vBase} ${d + vBase}`);
      }
    }
    vBase += pos.count;
    if (uv) vtBase += uv.count;
    onProgress?.((mi + 1) / Math.max(1, meshes.length));
    await tick();
  }
  // Taškų debesys: „v x y z r g b“ (paplitęs OBJ plėtinys)
  for (const pc of viewer.pointClouds) {
    const pos = pc.geometry.attributes.position, col = pc.geometry.attributes.color;
    const m = new THREE.Matrix4().multiplyMatrices(inv, pc.matrixWorld);
    lines.push(`o ${(pc.name || 'points').replace(/\s+/g, '_')}`);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      lines.push(col ? `v ${toOrig(v)} ${col.getX(i).toFixed(3)} ${col.getY(i).toFixed(3)} ${col.getZ(i).toFixed(3)}` : `v ${toOrig(v)}`);
    }
  }
  files[`${baseName}.obj`] = strToU8(lines.join('\n') + '\n');
  files[`${baseName}.mtl`] = strToU8(mtl.join('\n') + '\n');
  if (viewer.crs?.epsg) files[`${baseName}.prj.txt`] = strToU8(`EPSG:${viewer.crs.epsg} – ${viewer.crs.name}\n`);
  await tick();
  return new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' });
}

/**
 * GLB – peržiūros programoms (Windows 3D Viewer, Blender…). Koordinatės santykinės (centras ties 0),
 * originalus poslinkis įrašomas į šakninio mazgo extras.atea.offset.
 * @returns {Promise<Blob>}
 */
export async function exportGlb(viewer, units) {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const content = viewer.content;
  const swapped = [];
  // Originalios medžiagos (ne peržiūros režimo – reljefo, aukščių spalvų)
  for (const o of [...viewer.meshes, ...viewer.pointClouds]) {
    if (o.userData.origMaterial && o.material !== o.userData.origMaterial) {
      swapped.push([o, o.material]);
      o.material = o.userData.origMaterial;
    }
  }
  // Tekstūros – JPEG (PNG fotogrametrijos modeliui kelis kartus didesnis)
  const texs = new Set();
  for (const o of viewer.meshes) [].concat(o.material).forEach((m) => m?.map && texs.add(m.map));
  const prevMime = [...texs].map((t) => [t, t.userData.mimeType]);
  texs.forEach((t) => (t.userData.mimeType = 'image/jpeg'));
  // Programos vidiniai duomenys (userData) į failą nerašomi – GLTFExporter juos dėtų į „extras“
  const stashed = [];
  content.traverse((o) => {
    stashed.push([o, o.userData]);
    o.userData = {};
    for (const m of [].concat(o.material || [])) {
      stashed.push([m, m.userData]);
      m.userData = {};
    }
  });
  // Originalių koordinačių poslinkis – šakninio mazgo „extras“ (GLB koordinatės santykinės)
  const off0 = viewer.center.clone().add(viewer.datumShift);
  content.userData = { atea: { crs: viewer.crs?.epsg ? `EPSG:${viewer.crs.epsg}` : null, offset: off0.toArray(), upAxis: viewer.upAxis } };
  const prevQ = content.quaternion.clone();
  const prevS = content.scale.clone();
  content.quaternion.copy(viewer.modelRoot.quaternion); // Z aukštyn -> glTF Y aukštyn
  content.scale.setScalar(units.calibration || 1);
  content.updateMatrixWorld(true);
  try {
    const off = viewer.center.clone().add(viewer.datumShift);
    const result = await new GLTFExporter().parseAsync(content, { binary: true, onlyVisible: false });
    const blob = new Blob([result], { type: 'model/gltf-binary' });
    return { blob, offset: off };
  } finally {
    content.quaternion.copy(prevQ);
    content.scale.copy(prevS);
    content.updateMatrixWorld(true);
    swapped.forEach(([o, m]) => (o.material = m));
    prevMime.forEach(([t, m]) => (m === undefined ? delete t.userData.mimeType : (t.userData.mimeType = m)));
    stashed.forEach(([o, u]) => (o.userData = u));
    viewer.requestRender();
  }
}

/**
 * Taškų debesis LAS 1.2 (taško formatas 2 – su RGB), originaliomis koordinatėmis, 1 mm tikslumu.
 * @returns {Blob}
 */
export function exportLas(viewer, units) {
  const { c, k, inv } = originMapper(viewer, units);
  let n = 0;
  for (const pc of viewer.pointClouds) n += pc.geometry.attributes.position.count;
  const HDR = 227, REC = 26;
  const buf = new ArrayBuffer(HDR + n * REC);
  const dv = new DataView(buf);
  const scale = 0.001;
  const off = [Math.round(c.x), Math.round(c.y), Math.round(c.z)];
  const v = new THREE.Vector3();
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let p = HDR;
  for (const pc of viewer.pointClouds) {
    const pos = pc.geometry.attributes.position, col = pc.geometry.attributes.color;
    const m = new THREE.Matrix4().multiplyMatrices(inv, pc.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      const xyz = [v.x * k + c.x, v.y * k + c.y, v.z * k + c.z];
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], xyz[a]);
        max[a] = Math.max(max[a], xyz[a]);
        dv.setInt32(p + a * 4, Math.round((xyz[a] - off[a]) / scale), true);
      }
      dv.setUint16(p + 12, 0, true); // intensyvumas
      dv.setUint8(p + 14, 0b00001001); // grąža 1 iš 1
      dv.setUint8(p + 15, 0); // klasė
      if (col) {
        dv.setUint16(p + 20, Math.round(col.getX(i) * 65535), true);
        dv.setUint16(p + 22, Math.round(col.getY(i) * 65535), true);
        dv.setUint16(p + 24, Math.round(col.getZ(i) * 65535), true);
      }
      p += REC;
    }
  }
  const str = (o, s, len) => {
    for (let i = 0; i < len; i++) dv.setUint8(o + i, i < s.length ? s.charCodeAt(i) & 0x7f : 0);
  };
  str(0, 'LASF', 4);
  dv.setUint8(24, 1); // versija 1.2
  dv.setUint8(25, 2);
  str(26, 'Atea 3D Matuoklis', 32);
  str(58, 'Atea 3D Matuoklis', 32);
  const now = new Date();
  dv.setUint16(90, Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 864e5), true);
  dv.setUint16(92, now.getFullYear(), true);
  dv.setUint16(94, HDR, true);
  dv.setUint32(96, HDR, true); // taškų pradžia
  dv.setUint32(100, 0, true); // VLR nėra
  dv.setUint8(104, 2); // taško formatas
  dv.setUint16(105, REC, true);
  dv.setUint32(107, n, true);
  dv.setUint32(111, n, true); // grąža 1
  [scale, scale, scale].forEach((s, i) => dv.setFloat64(131 + i * 8, s, true));
  off.forEach((o, i) => dv.setFloat64(155 + i * 8, o, true));
  dv.setFloat64(179, max[0], true);
  dv.setFloat64(187, min[0], true);
  dv.setFloat64(195, max[1], true);
  dv.setFloat64(203, min[1], true);
  dv.setFloat64(211, max[2], true);
  dv.setFloat64(219, min[2], true);
  return new Blob([buf], { type: 'application/octet-stream' });
}
