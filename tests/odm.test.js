// Grynųjų funkcijų testai (node --test): ODM parinktys, RAM įvertinimas, koordinatės, vienetai.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, buildOdmOptions, estimateRamGB, diagnoseFailure, lowerMemoryOptions, ODM_STAGES } from '../src/odm/project.js';
import { LKS94 } from '../src/geo/tm.js';

const opts = (list) => Object.fromEntries(list.map((o) => [o.name, o.value]));

test('visi ruošiniai sukuria parinktis', () => {
  for (const k of Object.keys(PRESETS)) {
    const o = opts(buildOdmOptions(k));
    assert.equal(o.cog, true, k);
    assert.equal(o['auto-boundary'], true, k);
    assert.ok(estimateRamGB(buildOdmOptions(k), 300) > 1, k);
  }
});

test('OpenMVS tinklas tik kai yra 3D modelis', () => {
  assert.equal(opts(buildOdmOptions('standard', { mvsMesh: true }))['mesh-method'], 'openmvs');
  assert.equal(opts(buildOdmOptions('orthoOnly', { mvsMesh: true }))['mesh-method'], undefined);
});

test('sritis, skaidymas, dideli rinkiniai', () => {
  const o = opts(buildOdmOptions('standard', { boundary: '/var/www/data/x/images/boundary.geojson', split: true, photos: 800, ortho: false }));
  assert.equal(o.boundary, '"/var/www/data/x/images/boundary.geojson"');
  assert.equal(o['auto-boundary'], undefined);
  assert.equal(o.split, 400);
  assert.equal(o['use-hybrid-bundle-adjustment'], true);
  assert.equal(o['skip-orthophoto'], true);
});

test('RAM įvertinimas didėja su kokybe ir nuotraukų skaičiumi', () => {
  const r = (k, n) => estimateRamGB(buildOdmOptions(k), n);
  assert.ok(r('fast', 500) < r('standard', 500));
  assert.ok(r('standard', 500) < r('high', 500));
  assert.ok(r('high', 500) < r('max', 500));
  assert.ok(r('standard', 200) < r('standard', 1000));
  assert.ok(r('orthoOnly', 1000) < r('fast', 1000));
});

test('nepavykimo diagnozė', () => {
  const lines = ['Running openmvs stage', 'Killed'];
  const d = diagnoseFailure(lines, buildOdmOptions('high'));
  assert.equal(d.kind, 'memory');
  assert.equal(d.stage, 'openmvs');
  assert.equal(diagnoseFailure(['No space left on device']).kind, 'disk');
});

test('pakartojimas su mažesne atmintimi', () => {
  const r = lowerMemoryOptions(buildOdmOptions('max'), 'openmvs');
  const o = opts(r.options);
  assert.equal(o['pc-quality'], 'high');
  assert.equal(o['feature-quality'], 'ultra'); // sujungimas nekartojamas
  assert.equal(o['rerun-from'], 'openmvs');
  assert.ok(r.changes.length >= 2);
  assert.ok(ODM_STAGES.includes('odm_meshing'));
});

test('LKS-94 projekcija (Vilnius) – grįžtamasis perskaičiavimas', () => {
  const lat = 54.6872, lon = 25.2797;
  const [e, n] = LKS94.forward(lon, lat);
  assert.ok(Math.abs(e - 582000) < 2000 && Math.abs(n - 6062000) < 3000, `${e} ${n}`);
  const [lon2, lat2] = LKS94.inverse(e, n);
  assert.ok(Math.abs(lon2 - lon) < 1e-8 && Math.abs(lat2 - lat) < 1e-8);
});
