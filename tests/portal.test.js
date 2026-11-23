// Portalo modelio failų atranka: siunčiami tik peržiūrai reikalingi failai.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelFiles } from '../src/portal/files.js';

const f = (...names) => names.map((name) => ({ name }));
const names = (list) => list.map((x) => x.name).sort();

test('GLB – tik jis, coords.txt ir realistiškas vaizdas', () => {
  const files = f('odm_textured_model_geo.glb', 'odm_georeferenced_model.laz', 'odm_orthophoto.tif', 'coords.txt', 'scene.spz', 'report.pdf');
  assert.deepEqual(names(modelFiles(files)), ['coords.txt', 'odm_textured_model_geo.glb', 'scene.spz']);
});

test('OBJ – su MTL ir tekstūromis, be taškų debesies ir ortofoto / DSM', () => {
  const files = f('m_geo.obj', 'm.obj', 'm_geo.mtl', 'm_geo_map_0.jpg', 'm_geo_map_1.png', 'cloud.laz', 'dsm.tif', 'odm_orthophoto.tif', 'coords.txt');
  assert.deepEqual(names(modelFiles(files)), ['coords.txt', 'm_geo.mtl', 'm_geo.obj', 'm_geo_map_0.jpg', 'm_geo_map_1.png']);
});

test('be tinklo arba su ZIP – visi failai', () => {
  const pc = f('cloud.laz', 'coords.txt');
  assert.equal(modelFiles(pc).length, 2);
  const z = f('all.zip', 'a.glb');
  assert.equal(modelFiles(z).length, 2);
});
