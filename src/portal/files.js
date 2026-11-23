// Portalo failų atranka (gryna funkcija – testuojama be naršyklės).
const MESH_EXT = /\.(glb|gltf|obj|fbx|dae|3mf|stl)$/i;
const AUX = /(^|\/)(coords\.txt)$|\.(mtl|spz|bin|jpe?g|png|webp|ktx2|tga|bmp|dds|tiff?)$/i;

/**
 * Peržiūrai reikalingi modelio failai: jei yra 3D tinklas (GLB, OBJ…) – jis ir jo priedai (MTL, tekstūros, coords.txt,
 * realistiškas vaizdas .spz); taškų debesys (LAZ, PLY…) ir kiti failai tada nesiunčiami. Be tinklo – visi failai.
 * Ortofoto / DSM GeoTIFF (didelis, ne tekstūra) – niekada, jei yra tinklas.
 */
export function modelFiles(files) {
  const mesh = files.filter((f) => MESH_EXT.test(f.name));
  if (!mesh.length || files.some((f) => /\.zip$/i.test(f.name))) return files;
  const glb = mesh.find((f) => /\.glb$/i.test(f.name));
  // GLB – viskas viduje; OBJ ir kt. – su MTL ir tekstūromis
  const keep = (f) => (glb ? f === glb || /(^|\/)coords\.txt$|\.spz$/i.test(f.name) : MESH_EXT.test(f.name) || (AUX.test(f.name) && !/(dsm|dtm|orthophoto|ortofoto)[^/]*\.tiff?$/i.test(f.name)));
  const out = files.filter(keep);
  // ODM: keli OBJ – peržiūrai naudojamas georeferencuotas (*_geo.obj)
  const geo = out.find((f) => /_geo\.obj$/i.test(f.name));
  return geo ? out.filter((f) => !/\.obj$/i.test(f.name) || f === geo) : out;
}
