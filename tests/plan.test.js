// Skrydžio plano misijos: tinklelis, 5 krypčių (įstrižinė), orbita; DJI WPML eksportas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAMERAS, computePlan, toWPML, toKML } from '../src/plan/plan.js';
import { localProjection } from '../src/odm/preview.js';

// ~100 × 60 m stačiakampis Vilniuje
const lat0 = 54.6872, lon0 = 25.2797;
const dLat = 60 / 111320, dLon = 100 / (111320 * Math.cos((lat0 * Math.PI) / 180));
const poly = [[lon0, lat0], [lon0 + dLon, lat0], [lon0 + dLon, lat0 + dLat], [lon0, lat0 + dLat]];
const base = { camera: CAMERAS.m3e, alt: 80, front: 80, side: 70, heading: null, crosshatch: false, speed: null, maxSpeed: 12, interval: 1, battery: 35 };
const proj = localProjection((lat0 + lat0 + dLat) / 2, (lon0 + lon0 + dLon) / 2);

function xmlOk(s) {
  const d = mkdtempSync(join(tmpdir(), 'wpml-'));
  const f = join(d, 'x.xml');
  writeFileSync(f, s);
  execFileSync('xmllint', ['--noout', f]);
}

test('tinklelis: kamera žemyn, kryptis pagal maršrutą', () => {
  const p = computePlan(poly, base);
  assert.equal(p.mission, 'grid');
  assert.equal(p.passes, 1);
  assert.ok(p.waypoints.every((w) => w.pitch === -90 && w.yaw == null && w.alt === 80));
  assert.equal(p.waypoints.length % 2, 0);
});

test('5 krypčių: 4 įstriži praskridimai, kamera pakreipta, dronas atitrauktas nuo srities', () => {
  const p = computePlan(poly, { ...base, mission: 'oblique', pitch: 45 });
  assert.equal(p.passes, 5);
  assert.deepEqual(p.passLabels, ['žemyn', 'į šiaurę', 'į rytus', 'į pietus', 'į vakarus']);
  const obl = p.waypoints.filter((w) => w.yaw != null);
  assert.ok(obl.length > 0 && obl.every((w) => Math.abs(w.pitch + 45) < 1e-9));
  assert.deepEqual([...new Set(obl.map((w) => w.yaw))].sort((a, b) => a - b), [-180, -90, 0, 90]);
  // Kamera į šiaurę – dronas pietuose nuo srities per ~alt/tan(45°) = 80 m (kadro centras virš srities)
  const north = obl.filter((w) => w.yaw === 0).map((w) => proj.toEN(w.ll[0], w.ll[1]));
  const avgN = north.reduce((t, q) => t + q[1], 0) / north.length;
  assert.ok(Math.abs(avgN - -80) < 15, `vid. N ${avgN}`);
  assert.ok(Math.abs(p.oblique.offset - 80) < 1e-6);
  assert.ok(p.photos > computePlan(poly, base).photos * 2);
});

test('orbita: ratai aplink pastatą, kamera į pastato vidurį', () => {
  const p = computePlan(poly, { ...base, mission: 'orbit', buildingHeight: 30, rings: 2 });
  assert.equal(p.mission, 'orbit');
  const { radius: R, rings, buildingRadius: rb } = p.orbit;
  assert.equal(rings.length, 2);
  assert.ok(R >= rb + 8);
  assert.ok(rings[0].alt > rings[1].alt && rings[0].alt > 30);
  const c = proj.toEN(p.orbit.center[0], p.orbit.center[1]);
  for (const w of p.waypoints) {
    const q = proj.toEN(w.ll[0], w.ll[1]);
    assert.ok(Math.abs(Math.hypot(q[0] - c[0], q[1] - c[1]) - R) < 0.05, 'taškas ant apskritimo');
    // drono kryptis į centrą
    const want = (Math.atan2(c[0] - q[0], c[1] - q[1]) * 180) / Math.PI;
    assert.ok(Math.abs(((w.yaw - want + 540) % 360) - 180) < 0.5);
    // kameros kampas – į pastato vidurį (15 m)
    assert.ok(Math.abs(w.pitch - -(Math.atan2(w.alt - 15, R) * 180) / Math.PI) < 1e-6);
    assert.equal(w.photo, 'point');
  }
  assert.equal(p.photos, rings.reduce((t, r) => t + r.count, 0));
});

test('DJI WPML: taisyklingas XML, kameros kampai ir kryptys kiekviename taške', () => {
  for (const mission of ['grid', 'oblique', 'orbit']) {
    const p = computePlan(poly, { ...base, mission, pitch: 45, buildingHeight: 30, rings: 2 });
    const f = toWPML('Bandymas', p, { ...base });
    xmlOk(f['wpmz/template.kml']);
    xmlOk(f['wpmz/waylines.wpml']);
    const wl = f['wpmz/waylines.wpml'];
    assert.equal((wl.match(/<Placemark>/g) || []).length, p.waypoints.length, mission);
    if (mission === 'oblique') {
      assert.ok(wl.includes('<wpml:gimbalPitchRotateAngle>-45</wpml:gimbalPitchRotateAngle>'));
      assert.ok(wl.includes('<wpml:waypointHeadingMode>smoothTransition</wpml:waypointHeadingMode><wpml:waypointHeadingAngle>90</wpml:waypointHeadingAngle>'));
    }
    if (mission === 'orbit') {
      assert.equal((wl.match(/takePhoto/g) || []).length, p.photos);
      assert.ok(!wl.includes('multipleDistance'));
      const alts = new Set([...wl.matchAll(/<wpml:executeHeight>([\d.]+)</g)].map((m) => +m[1]));
      assert.deepEqual([...alts].sort((a, b) => a - b), p.orbit.rings.map((r) => r.alt).sort((a, b) => a - b));
    }
    xmlOk(toKML('Bandymas', poly, p, 80));
  }
});
