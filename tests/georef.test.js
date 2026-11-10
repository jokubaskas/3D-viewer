// Panašumo transformacija UTM → LKS-94 (splatų sluoksniui): sutampa su tikru perskaičiavimu
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { reprojectUtmLocalObject } from '../src/geo/georef.js';

test('ODM vietinės koordinatės → LKS-94: matrica atitinka viršūnių perskaičiavimą (< 1 cm)', () => {
  // ~400 × 300 m sritis Vilniuje (UTM 35N), ODM poslinkis
  const offE = 581000, offN = 6062000;
  const pts = [];
  for (let i = 0; i < 50; i++) pts.push(Math.random() * 400 - 200, Math.random() * 300 - 150, Math.random() * 40);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const obj = new THREE.Group();
  obj.add(new THREE.Mesh(geom));
  reprojectUtmLocalObject(obj, { zone: 35, offE, offN });
  const M = obj.userData.odmToLocal;
  assert.ok(M instanceof THREE.Matrix4);
  const out = geom.attributes.position.array;
  let worst = 0;
  for (let k = 0; k < 50; k++) {
    const v = new THREE.Vector3(pts[k * 3], pts[k * 3 + 1], pts[k * 3 + 2]).applyMatrix4(M);
    worst = Math.max(worst, Math.hypot(v.x - out[k * 3], v.y - out[k * 3 + 1]), Math.abs(v.z - out[k * 3 + 2]));
  }
  assert.ok(worst < 0.01, `didžiausia paklaida ${worst} m`);
});
