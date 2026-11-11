// Grynųjų funkcijų testai (node --test): režimai (Atea variklis / ODM „Tik ortofoto“), RAM įvertinimas, koordinatės.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, buildOdmOptions, estimateRamGB, estimateEngineRamGB, diagnoseFailure, lowerMemoryOptions, ODM_STAGES, analyzePhotos, engineBase, isEngineUrl, engineOptions, isEnginePreset, presetLabel } from '../src/odm/project.js';
import { LKS94 } from '../src/geo/tm.js';

const opts = (list) => Object.fromEntries(list.map((o) => [o.name, o.value]));

test('režimai: Greitas ir Aukšta kokybė – Atea variklis, Tik ortofoto – ODM', () => {
  assert.deepEqual(Object.keys(PRESETS), ['fast', 'high', 'orthoOnly']);
  assert.ok(isEnginePreset('fast') && isEnginePreset('high') && !isEnginePreset('orthoOnly'));
  assert.deepEqual(engineOptions('fast'), [{ name: 'quality', value: 'fast' }]);
  assert.deepEqual(engineOptions('high'), [{ name: 'quality', value: 'high' }]);
  assert.equal(presetLabel('standard'), 'Standartinis (ODM)'); // seni projektai sąraše
  assert.equal(presetLabel('nežinomas'), '');
});

test('variklio adresas – tame pačiame serveryje', () => {
  assert.equal(engineBase('./odm/'), './engine/');
  assert.equal(engineBase('http://localhost:8080/odm/'), 'http://localhost:8080/engine/');
  assert.equal(engineBase('http://kitas:3000/'), null);
  assert.ok(isEngineUrl('./engine/') && !isEngineUrl('./odm/'));
});

test('Tik ortofoto (ODM) parinktys', () => {
  const o = opts(buildOdmOptions('orthoOnly'));
  assert.equal(o['fast-orthophoto'], true);
  assert.equal(o.cog, true);
  assert.equal(o['auto-boundary'], true);
  const b = opts(buildOdmOptions('orthoOnly', { boundary: '/var/www/data/x/images/boundary.geojson', photos: 800 }));
  assert.equal(b.boundary, '"/var/www/data/x/images/boundary.geojson"');
  assert.equal(b['auto-boundary'], undefined);
  assert.equal(b['use-hybrid-bundle-adjustment'], true);
});

test('RAM įvertinimas didėja su kokybe ir nuotraukų skaičiumi', () => {
  assert.ok(estimateEngineRamGB('fast', 500) < estimateEngineRamGB('high', 500));
  assert.ok(estimateEngineRamGB('high', 200) < estimateEngineRamGB('high', 1000));
  assert.ok(estimateRamGB(buildOdmOptions('orthoOnly'), 1000) > 1);
});

test('nepavykimo diagnozė: variklio ir ODM žurnalai', () => {
  const d = diagnoseFailure(['Running dense stage – gylio žemėlapiai (GPU)', 'Killed'], engineOptions('high'));
  assert.equal(d.kind, 'memory');
  assert.equal(d.stage, 'dense');
  assert.equal(d.stageLabel, 'gylio žemėlapiai (GPU)');
  assert.equal(diagnoseFailure(['No space left on device']).kind, 'disk');
});

test('ODM „Tik ortofoto“ pakartojimas su mažesne atmintimi', () => {
  const r = lowerMemoryOptions(buildOdmOptions('orthoOnly'), 'opensfm');
  assert.ok(Array.isArray(r.changes));
  assert.ok(ODM_STAGES.includes('odm_orthophoto'));
});

test('LKS-94 projekcija (Vilnius) – grįžtamasis perskaičiavimas', () => {
  const lat = 54.6872, lon = 25.2797;
  const [e, n] = LKS94.forward(lon, lat);
  assert.ok(Math.abs(e - 582000) < 2000 && Math.abs(n - 6062000) < 3000, `${e} ${n}`);
  const [lon2, lat2] = LKS94.inverse(e, n);
  assert.ok(Math.abs(lon2 - lon) < 1e-8 && Math.abs(lat2 - lat) < 1e-8);
});

test('rolling shutter: įjungiama tik eilutinio užrakto kameroms', () => {
  const photo = (make, model, i) => ({ name: `p${i}.jpg`, size: 1, make, model, lat: 54.68 + i * 1e-4, lon: 25.28, absAlt: 200, relAlt: 80, gimbalPitch: -90, width: 5280, height: 3956 });
  const mini = Array.from({ length: 40 }, (_, i) => photo('DJI', 'FC3582', i));
  const m3e = Array.from({ length: 40 }, (_, i) => photo('DJI', 'M3E', i));
  assert.equal(analyzePhotos(mini).rollingShutter, true);
  assert.equal(analyzePhotos(m3e).rollingShutter, false);
  assert.equal(opts(buildOdmOptions('orthoOnly', { rollingShutter: true }))['rolling-shutter'], true);
  assert.equal(opts(buildOdmOptions('orthoOnly'))['rolling-shutter'], undefined);
});
