// Demonstracinis modelis: karjero / statybvietės reljefas su krūva, duobe ir pastatu (Z aukštyn, metrai)
import * as THREE from 'three';

function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < 5; i++) {
    s += a * noise(x * f, y * f);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}

export function createDemoModel() {
  const size = 120, n = 260;
  const group = new THREE.Group();
  const pos = [], col = [], idx = [];
  const grass = new THREE.Color('#5d7f3a'), soil = new THREE.Color('#8a6a48'), gravel = new THREE.Color('#a9a297'), road = new THREE.Color('#77736c');
  const c = new THREE.Color();

  const heightAt = (x, y) => {
    let h = 3 * fbm(x * 0.02 + 10, y * 0.02 + 3) + 0.004 * x * 10; // bendras nuolydis
    // Krūva (žvyras)
    const dx = x - 18, dy = y - 12;
    const r = Math.sqrt(dx * dx * 0.8 + dy * dy * 1.2);
    const pile = Math.max(0, 9 * (1 - (r / 17) ** 2)) ** 1.05;
    h += pile;
    // Duobė
    const px = x + 28, py = y + 20;
    const pr = Math.sqrt(px * px + py * py);
    h -= Math.max(0, 4.5 * (1 - (pr / 13) ** 2));
    // Kelias
    const roadD = Math.abs(y - (-0.25 * x - 32));
    if (roadD < 4) h = h * (roadD / 4) + (1 - roadD / 4) * (2.2 + 0.004 * x * 10);
    return { h: h + 0.15 * (fbm(x * 0.6, y * 0.6) - 0.5), pile, pit: pr < 13, road: roadD < 3.5 };
  };

  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const x = (i / n - 0.5) * size, y = (j / n - 0.5) * size;
      const { h, pile, pit, road: isRoad } = heightAt(x, y);
      pos.push(x + 500000, y + 6100000, h + 120); // „georeferencuotos“ koordinatės (LKS-94 stiliaus)
      const t = fbm(x * 0.15, y * 0.15);
      if (pile > 0.4) c.copy(gravel).lerp(soil, t * 0.5);
      else if (pit) c.copy(soil).lerp(gravel, t * 0.3);
      else if (isRoad) c.copy(road).lerp(gravel, t * 0.4);
      else c.copy(grass).lerp(soil, Math.max(0, t - 0.45) * 1.4);
      c.offsetHSL(0, 0, (hash(i, j) - 0.5) * 0.06);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, d = a + n + 1, e = d + 1;
      idx.push(a, b, e, a, e, d);
    }
  // Koordinatės dideliems skaičiams – laikome centruotas, o poslinkį grąžiname atskirai
  const offset = new THREE.Vector3(500000, 6100000, 120);
  for (let k = 0; k < pos.length; k += 3) {
    pos[k] -= offset.x;
    pos[k + 1] -= offset.y;
    pos[k + 2] -= offset.z;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const colors = new Float32Array(col);
  // Spalvos sRGB -> linijinės
  for (let k = 0; k < colors.length; k++) colors[k] = colors[k] <= 0.04045 ? colors[k] / 12.92 : ((colors[k] + 0.055) / 1.055) ** 2.4;
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const terrain = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }));
  terrain.name = 'Reljefas';
  group.add(terrain);

  // Pastatas
  const bx = -25, by = 25;
  const ground = heightAt(bx, by).h;
  const bw = 16, bd = 10, bh = 6.5;
  const house = new THREE.Mesh(new THREE.BoxGeometry(bw, bd, bh), new THREE.MeshStandardMaterial({ color: '#d8d2c4', roughness: 0.8 }));
  house.position.set(bx, by, ground + bh / 2 - 0.3);
  house.name = 'Pastatas';
  group.add(house);
  const roofGeom = new THREE.CylinderGeometry(0.01, bd * 0.62, 3, 4, 1);
  roofGeom.rotateY(Math.PI / 4);
  roofGeom.rotateX(Math.PI / 2);
  roofGeom.scale(bw / bd, 1, 1);
  const roof = new THREE.Mesh(roofGeom, new THREE.MeshStandardMaterial({ color: '#7a3b2e', roughness: 0.7 }));
  roof.position.set(bx, by, ground + bh - 0.3 + 1.5);
  roof.name = 'Stogas';
  group.add(roof);

  // Keli medžiai
  for (let t = 0; t < 14; t++) {
    const tx = -55 + hash(t, 3) * 40, ty = -10 + hash(t, 7) * 60;
    const gz = heightAt(tx, ty).h;
    const hgt = 5 + hash(t, 9) * 6;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, hgt * 0.4, 6), new THREE.MeshStandardMaterial({ color: '#5a4030' }));
    trunk.rotation.x = Math.PI / 2;
    trunk.position.set(tx, ty, gz + hgt * 0.2);
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(hgt * 0.32, 1), new THREE.MeshStandardMaterial({ color: '#2f5a2a', flatShading: true }));
    crown.position.set(tx, ty, gz + hgt * 0.62);
    group.add(trunk, crown);
  }
  return { object: group, offset };
}
