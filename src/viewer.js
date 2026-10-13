// 3D peržiūros branduolys: scena, kameros, valdymas, atvaizdavimo režimai, taškų parinkimas
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const UP = new THREE.Vector3(0, 1, 0);

// Aukščio spalvų skalė (žalia – geltona – ruda – balta, panašiai kaip topografiniuose žemėlapiuose)
const RAMP_GLSL = /* glsl */ `
vec3 heightRamp(float t) {
  vec3 c0 = vec3(0.10, 0.25, 0.55);
  vec3 c1 = vec3(0.12, 0.60, 0.55);
  vec3 c2 = vec3(0.45, 0.78, 0.25);
  vec3 c3 = vec3(0.98, 0.85, 0.25);
  vec3 c4 = vec3(0.85, 0.40, 0.15);
  vec3 c5 = vec3(0.95, 0.95, 0.95);
  if (t < 0.2) return mix(c0, c1, t / 0.2);
  if (t < 0.4) return mix(c1, c2, (t - 0.2) / 0.2);
  if (t < 0.6) return mix(c2, c3, (t - 0.4) / 0.2);
  if (t < 0.8) return mix(c3, c4, (t - 0.6) / 0.2);
  return mix(c4, c5, (t - 0.8) / 0.2);
}
float contour(float h, float step) {
  if (step <= 0.0) return 0.0;
  float f = h / step;
  float w = fwidth(f);
  float d = abs(fract(f - 0.5) - 0.5) / max(w, 1e-5);
  return 1.0 - clamp(d - 0.25, 0.0, 1.0);
}
`;

function heightMaterial(points) {
  const uniforms = {
    uMin: { value: 0 },
    uMax: { value: 1 },
    uContour: { value: 0 },
    uSize: { value: 2 },
    uPixelRatio: { value: 1 },
  };
  const vertex = /* glsl */ `
    #include <clipping_planes_pars_vertex>
    uniform float uSize; uniform float uPixelRatio;
    varying float vH; varying vec3 vWorld;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vH = wp.y; vWorld = wp.xyz;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;
      ${points ? 'gl_PointSize = uSize * uPixelRatio;' : ''}
      #include <clipping_planes_vertex>
    }`;
  const fragment = /* glsl */ `
    #include <clipping_planes_pars_fragment>
    uniform float uMin; uniform float uMax; uniform float uContour;
    varying float vH; varying vec3 vWorld;
    ${RAMP_GLSL}
    void main() {
      #include <clipping_planes_fragment>
      float t = clamp((vH - uMin) / max(uMax - uMin, 1e-6), 0.0, 1.0);
      vec3 c = heightRamp(t);
      ${
        points
          ? ''
          : `vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
      float shade = 0.55 + 0.45 * abs(dot(n, normalize(vec3(0.35, 1.0, 0.25))));
      c *= shade;`
      }
      c = mix(c, vec3(0.08, 0.1, 0.09), contour(vH, uContour) * 0.85);
      gl_FragColor = vec4(c, 1.0);
    }`;
  return new THREE.ShaderMaterial({ uniforms, vertexShader: vertex, fragmentShader: fragment, clipping: true, side: THREE.DoubleSide });
}

export class Viewer extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, logarithmicDepthBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.localClippingEnabled = true;
    this.renderer.domElement.classList.add('gl');
    this.renderer.domElement.tabIndex = 0;
    container.prepend(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.insertBefore(this.labelRenderer.domElement, this.renderer.domElement.nextSibling);

    this.scene = new THREE.Scene();
    this.perspCam = new THREE.PerspectiveCamera(50, 1, 0.01, 10000);
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -100000, 100000);
    this.camera = this.perspCam;
    this.perspCam.position.set(10, 10, 10);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => (this.dirty = true));

    // Šviesos
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445550, 1.6));
    this.headlight = new THREE.DirectionalLight(0xffffff, 1.6);
    this.scene.add(this.headlight, this.headlight.target);

    // Modelio hierarchija: modelRoot (orientacija) -> content (centruotas modelis) + overlay (matavimai)
    this.modelRoot = new THREE.Group();
    this.content = new THREE.Group();
    this.overlay = new THREE.Group();
    this.overlay.renderOrder = 10;
    this.modelRoot.add(this.content, this.overlay);
    this.scene.add(this.modelRoot);
    this.helpers = new THREE.Group();
    this.scene.add(this.helpers);

    this.model = null;
    this.meshes = [];
    this.pointClouds = [];
    this.center = new THREE.Vector3(); // originalių koordinačių centras
    this.datumShift = new THREE.Vector3(); // pataisa pagal kontrolinius taškus (originaliomis ašimis)
    this.crs = null;
    this.heightSystem = null;
    this.upAxis = 'z';
    this.levelQuat = new THREE.Quaternion();
    this.viewMode = 'texture';
    this.wireframe = false;
    this.pointSize = 2.5;
    this.contourStep = 0;
    this.clip = { min: null, max: null };
    this.clipPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)];
    this.lineMaterials = new Set();
    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;
    this.heightMatMesh = heightMaterial(false);
    this.heightMatPts = heightMaterial(true);
    this.solidMat = new THREE.MeshStandardMaterial({ color: 0xc4ccc8, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
    this.worldBox = new THREE.Box3();
    this._pointGrid = null;
    this._anim = null;
    this.dirty = true;

    this._onResize = () => this.resize();
    new ResizeObserver(this._onResize).observe(container);
    this.resize();
    this._clock = new THREE.Clock();
    this.renderer.setAnimationLoop(() => this._tick());
  }

  // -------------------------------------------------------------------------
  // Pagrindinis ciklas
  // -------------------------------------------------------------------------
  _tick() {
    const dt = this._clock.getDelta();
    if (this._anim) this._stepAnim(dt);
    if (this.controls.update()) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    this.headlight.position.copy(this.camera.position);
    this.headlight.target.position.copy(this.controls.target);
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    this.dispatchEvent(new Event('render'));
  }

  requestRender() {
    this.dirty = true;
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.labelRenderer.setSize(w, h);
    this.perspCam.aspect = w / h;
    this.perspCam.updateProjectionMatrix();
    this._updateOrthoFrustum();
    const pr = this.renderer.getPixelRatio();
    for (const m of this.lineMaterials) m.resolution.set(w * pr, h * pr);
    this.heightMatPts.uniforms.uPixelRatio.value = pr;
    this.dirty = true;
  }

  registerLineMaterial(m) {
    const pr = this.renderer.getPixelRatio();
    m.resolution.set(this.width * pr, this.height * pr);
    this.lineMaterials.add(m);
  }
  unregisterLineMaterial(m) {
    this.lineMaterials.delete(m);
  }

  // -------------------------------------------------------------------------
  // Modelis
  // -------------------------------------------------------------------------
  clearModel() {
    if (this.model) {
      this.content.remove(this.model);
      this.model.traverse((o) => {
        if (o.geometry) {
          o.geometry.disposeBoundsTree?.();
          o.geometry.dispose();
        }
        const mats = o.userData.origMaterial ? [].concat(o.userData.origMaterial) : [].concat(o.material || []);
        mats.forEach((m) => {
          m?.map?.dispose();
          m?.dispose?.();
        });
      });
    }
    this.model = null;
    this.meshes = [];
    this.pointClouds = [];
    this._pointGrid = null;
    this.dirty = true;
  }

  /**
   * @param {THREE.Object3D} object
   * @param {THREE.Vector3} originOffset - originalių koordinačių poslinkis (pvz. LAS/XYZ)
   */
  async setModel(object, originOffset, upAxis, onStatus, { crs = null, heightSystem = null } = {}) {
    this.clearModel();
    this.crs = crs;
    this.heightSystem = heightSystem;
    this.datumShift.set(0, 0, 0);
    this.model = object;
    object.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(object);
    const c = box.getCenter(new THREE.Vector3());
    object.position.sub(c);
    this.center.copy(c).add(originOffset || new THREE.Vector3());
    this.content.add(object);

    let tris = 0, verts = 0, points = 0, textures = new Set();
    const toIndex = [];
    object.traverse((o) => {
      if (o.isMesh) {
        this.meshes.push(o);
        const g = o.geometry;
        verts += g.attributes.position.count;
        tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
        [].concat(o.material).forEach((m) => m?.map && textures.add(m.map.uuid));
        o.userData.origMaterial = o.material;
        toIndex.push(g);
      } else if (o.isPoints) {
        this.pointClouds.push(o);
        points += o.geometry.attributes.position.count;
        o.userData.origMaterial = o.material;
      }
    });
    // BVH greitam spindulių sekimui (svarbu didiesiems fotogrametrijos modeliams)
    for (let i = 0; i < toIndex.length; i++) {
      onStatus?.(`Ruošiamas greitas matavimas (${i + 1}/${toIndex.length})…`);
      await new Promise((r) => setTimeout(r, 0));
      toIndex[i].computeBoundsTree({ maxLeafTris: 10 });
    }
    this.stats = { triangles: Math.round(tris), vertices: verts, points, textures: textures.size, meshes: this.meshes.length };
    this.setUpAxis(upAxis, false);
    this._applyMaterials();
    this.fitView(false);
    this.dirty = true;
  }

  /** Orientacija: kuri originali ašis yra „aukštyn“. */
  setUpAxis(axis, refit = true) {
    this.upAxis = axis;
    this.levelQuat.identity();
    this._applyOrientation();
    if (refit) this.fitView(true);
  }

  /** Papildomas pasukimas (išlyginimas pagal žemės plokštumą). */
  applyLeveling(normalWorld) {
    const n = normalWorld.clone().normalize();
    if (n.y < 0) n.negate();
    const q = new THREE.Quaternion().setFromUnitVectors(n, UP);
    this.levelQuat.premultiply(q);
    this._applyOrientation();
  }

  resetLeveling() {
    this.levelQuat.identity();
    this._applyOrientation();
  }

  _applyOrientation() {
    const base = new THREE.Quaternion();
    if (this.upAxis === 'z') base.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    this.modelRoot.quaternion.copy(this.levelQuat).multiply(base);
    this.modelRoot.updateMatrixWorld(true);
    this._pointGrid = null;
    this._updateWorldBox();
    this._updateHeightUniforms();
    this._updateGrid();
    this.dispatchEvent(new Event('orientation'));
    this.dirty = true;
  }

  _updateWorldBox() {
    this.worldBox.makeEmpty();
    if (this.model) {
      this.content.updateMatrixWorld(true);
      // Tikslesnis nei setFromObject(precise=false) pasuktiems objektams
      this.worldBox.setFromObject(this.content, false);
    }
  }

  get hasModel() {
    return !!this.model;
  }

  /** Originalios (failo) koordinatės iš modelRoot lokalių. */
  localToOriginal(v) {
    return v.clone().add(this.center);
  }
  localToWorld(v) {
    return this.modelRoot.localToWorld(v.clone());
  }
  worldToLocal(v) {
    return this.modelRoot.worldToLocal(v.clone());
  }
  /** Aukščio ašies centras + poslinkis pagal kontrolinius taškus. */
  get upCenter() {
    return this.upAxis === 'z' ? this.center.z + this.datumShift.z : this.center.y + this.datumShift.y;
  }
  /**
   * Rodomas aukštis (rodomais vienetais). Kalibravimo mastelis taikomas tik
   * santykiniams dydžiams nuo modelio centro, todėl absoliučios reikšmės išlieka artimos originalioms.
   */
  dispElev(worldY, U) {
    return U.lenRaw(this.upCenter) + U.len(worldY);
  }
  worldYFromDispElev(v, U) {
    return (v - U.lenRaw(this.upCenter)) / U.len(1);
  }
  /** Rodomos koordinatės (originalioje failo sistemoje) iš lokalių. */
  dispCoords(local, U) {
    const c = this.center.clone().add(this.datumShift);
    return new THREE.Vector3(U.lenRaw(c.x) + U.len(local.x), U.lenRaw(c.y) + U.len(local.y), U.lenRaw(c.z) + U.len(local.z));
  }
  /** Rodomos koordinatės -> lokalios (atvirkštinė dispCoords). */
  localFromDisp(d, U) {
    const c = this.center.clone().add(this.datumShift);
    const k = U.len(1);
    return new THREE.Vector3((d.x - U.lenRaw(c.x)) / k, (d.y - U.lenRaw(c.y)) / k, (d.z - U.lenRaw(c.z)) / k);
  }
  /**
   * Koordinačių eilutės rodymui. LKS-94 geodeziniu žymėjimu X – šiaurė, Y – rytai.
   * @returns {[string, number][]}
   */
  coordRows(local, U, order = 'ne') {
    const o = this.dispCoords(local, U);
    const hLabel = this.heightSystem ? `H (${this.heightSystem})` : 'Z';
    if (this.crs?.geodetic && order === 'ne') return [['X (šiaurė)', o.y], ['Y (rytai)', o.x], [hLabel, o.z]];
    if (this.crs?.geodetic) return [['E (rytai)', o.x], ['N (šiaurė)', o.y], [hLabel, o.z]];
    return [['X', o.x], ['Y', o.y], [hLabel, o.z]];
  }

  // -------------------------------------------------------------------------
  // Atvaizdavimas
  // -------------------------------------------------------------------------
  setViewMode(mode) {
    this.viewMode = mode;
    this._applyMaterials();
  }
  setWireframe(on) {
    this.wireframe = on;
    this._applyMaterials();
  }
  setPointSize(px) {
    this.pointSize = px;
    this._applyMaterials();
  }
  setContours(step) {
    this.contourStep = step;
    this.heightMatMesh.uniforms.uContour.value = step;
    this.heightMatPts.uniforms.uContour.value = step;
    this.dirty = true;
  }

  _basicFrom(m) {
    if (!m) return m;
    if (!m.userData._basic) {
      m.userData._basic = new THREE.MeshBasicMaterial({
        map: m.map || null,
        color: m.map ? 0xffffff : m.color ? m.color.clone() : 0xffffff,
        vertexColors: !!m.vertexColors,
        side: THREE.DoubleSide,
        transparent: m.transparent,
        opacity: m.opacity,
        alphaTest: m.alphaTest,
      });
    }
    return m.userData._basic;
  }

  _applyMaterials() {
    const planes = this._activeClipPlanes();
    const setCommon = (m) => {
      if (!m) return;
      m.clippingPlanes = planes;
      if ('wireframe' in m) m.wireframe = this.wireframe;
      m.needsUpdate = true;
    };
    for (const mesh of this.meshes) {
      const orig = mesh.userData.origMaterial;
      let mat;
      switch (this.viewMode) {
        case 'lit':
          mat = orig;
          break;
        case 'solid':
          mat = this.solidMat;
          break;
        case 'height':
          mat = this.heightMatMesh;
          break;
        default:
          mat = Array.isArray(orig) ? orig.map((m) => this._basicFrom(m)) : this._basicFrom(orig);
      }
      mesh.material = mat;
      [].concat(mat).forEach(setCommon);
    }
    for (const pc of this.pointClouds) {
      const orig = pc.userData.origMaterial;
      const mat = this.viewMode === 'height' ? this.heightMatPts : orig;
      if (mat.isPointsMaterial) {
        mat.size = this.pointSize; // three.js pats daugina iš pixelRatio
        mat.sizeAttenuation = false;
      }
      this.heightMatPts.uniforms.uSize.value = this.pointSize;
      pc.material = mat;
      setCommon(mat);
    }
    this.dirty = true;
  }

  _updateHeightUniforms() {
    if (this.worldBox.isEmpty()) return;
    for (const m of [this.heightMatMesh, this.heightMatPts]) {
      m.uniforms.uMin.value = this.worldBox.min.y;
      m.uniforms.uMax.value = this.worldBox.max.y;
    }
  }

  // Pjūvis pagal aukštį (pasaulio Y)
  setClip(min, max) {
    this.clip.min = min;
    this.clip.max = max;
    this._applyMaterials();
  }
  _activeClipPlanes() {
    const planes = [];
    if (this.clip.min != null) {
      this.clipPlanes[0].constant = -this.clip.min;
      planes.push(this.clipPlanes[0]);
    }
    if (this.clip.max != null) {
      this.clipPlanes[1].constant = this.clip.max;
      planes.push(this.clipPlanes[1]);
    }
    return planes;
  }
  _passesClip(p) {
    if (this.clip.min != null && p.y < this.clip.min) return false;
    if (this.clip.max != null && p.y > this.clip.max) return false;
    return true;
  }

  showGrid(on) {
    this._gridOn = on;
    this._updateGrid();
  }
  _updateGrid() {
    this.helpers.clear();
    if (!this._gridOn || this.worldBox.isEmpty()) return (this.dirty = true);
    const size = this.worldBox.getSize(new THREE.Vector3());
    const ext = Math.max(size.x, size.z) * 1.4;
    const step = niceStep(ext / 20);
    const div = Math.ceil(ext / step);
    const grid = new THREE.GridHelper(div * step, div, 0x008b01, 0x4a5357);
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    const c = this.worldBox.getCenter(new THREE.Vector3());
    grid.position.set(c.x, this.worldBox.min.y - size.y * 0.002, c.z);
    this.helpers.add(grid);
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Kamera
  // -------------------------------------------------------------------------
  get isOrtho() {
    return this.camera === this.orthoCam;
  }

  _updateOrthoFrustum() {
    const d = this.perspCam.position.distanceTo(this.controls?.target || new THREE.Vector3());
    const h = 2 * d * Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov / 2));
    const aspect = (this.width || 1) / (this.height || 1);
    this.orthoCam.top = h / 2;
    this.orthoCam.bottom = -h / 2;
    this.orthoCam.left = (-h / 2) * aspect;
    this.orthoCam.right = (h / 2) * aspect;
    this.orthoCam.updateProjectionMatrix();
  }

  setOrtho(on) {
    if (on === this.isOrtho) return;
    if (on) {
      this._updateOrthoFrustum();
      this.orthoCam.position.copy(this.perspCam.position);
      this.orthoCam.quaternion.copy(this.perspCam.quaternion);
      this.orthoCam.zoom = 1;
      this.orthoCam.updateProjectionMatrix();
      this.camera = this.orthoCam;
    } else {
      // Atstumą perskaičiuojame pagal ortografinį priartinimą
      const dir = new THREE.Vector3().subVectors(this.orthoCam.position, this.controls.target).normalize();
      const h = (this.orthoCam.top - this.orthoCam.bottom) / this.orthoCam.zoom;
      const d = h / 2 / Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov / 2));
      this.perspCam.position.copy(this.controls.target).addScaledVector(dir, d);
      this.perspCam.quaternion.copy(this.orthoCam.quaternion);
      this.camera = this.perspCam;
    }
    this.controls.object = this.camera;
    this.controls.update();
    this.dirty = true;
  }

  /** Rodyti visą modelį. */
  fitView(animate = true, dir) {
    const box = this.worldBox.isEmpty() ? new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5)) : this.worldBox;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(sphere.radius, 1e-3);
    const fov = THREE.MathUtils.degToRad(this.perspCam.fov);
    const dist = (r / Math.sin(Math.min(fov, fov * this.perspCam.aspect) / 2)) * 0.82;
    const d = dir ? dir.clone().normalize() : new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    if (!dir && (!isFinite(d.x) || d.lengthSq() < 0.5)) d.set(1, 0.9, 1.2).normalize();
    if (!this._fitted) {
      d.set(0.9, 1.1, 1.4).normalize();
      this._fitted = true;
    }
    this.perspCam.near = Math.max(r / 1000, 0.001);
    this.perspCam.far = r * 200;
    this.perspCam.updateProjectionMatrix();
    this.orthoCam.near = -r * 100;
    this.orthoCam.far = r * 100;
    const target = sphere.center.clone();
    const pos = target.clone().addScaledVector(d, dist);
    this.controls.maxDistance = r * 50;
    this._animateTo(pos, target, animate, () => {
      if (this.isOrtho) {
        this._updateOrthoFrustum();
        this.orthoCam.zoom = 1;
        this.orthoCam.updateProjectionMatrix();
      }
    });
  }

  setView(name) {
    const dirs = {
      top: new THREE.Vector3(0, 1, 0.0001),
      bottom: new THREE.Vector3(0, -1, 0.0001),
      front: new THREE.Vector3(0, 0, 1),
      back: new THREE.Vector3(0, 0, -1),
      right: new THREE.Vector3(1, 0, 0),
      left: new THREE.Vector3(-1, 0, 0),
      iso: new THREE.Vector3(1, 0.85, 1),
    };
    this.fitView(true, dirs[name]);
  }

  /** Nustatyti sukimosi centrą (pvz. dvigubu spustelėjimu). */
  orbitAround(worldPoint) {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    const len = offset.length();
    const newDist = Math.min(len, Math.max(this.camera.position.distanceTo(worldPoint), len * 0.35));
    offset.setLength(newDist);
    this._animateTo(worldPoint.clone().add(offset), worldPoint.clone(), true);
  }

  /** Priartinti prie taškų rinkinio (pasaulio koordinatėmis). */
  focusPoints(worldPts) {
    if (!worldPts.length) return;
    const box = new THREE.Box3().setFromPoints(worldPts);
    const s = box.getBoundingSphere(new THREE.Sphere());
    const r = Math.max(s.radius, this.worldBox.getSize(new THREE.Vector3()).length() * 0.03);
    const fov = THREE.MathUtils.degToRad(this.perspCam.fov);
    const dist = (r / Math.sin(fov / 2)) * 1.4;
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    this._animateTo(s.center.clone().addScaledVector(dir, dist), s.center.clone(), true);
  }

  _animateTo(pos, target, animate, done) {
    const cam = this.camera;
    if (this.isOrtho) {
      // Ortografinėje kameroje atstumą keičia „zoom“
      const fromH = (this.orthoCam.top - this.orthoCam.bottom) / this.orthoCam.zoom;
      const d = pos.distanceTo(target);
      const toH = 2 * d * Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov / 2));
      const zoomTo = (this.orthoCam.top - this.orthoCam.bottom) / toH;
      this._anim = { t: 0, dur: animate ? 0.6 : 0, p0: cam.position.clone(), p1: pos, t0: this.controls.target.clone(), t1: target, z0: this.orthoCam.zoom, z1: zoomTo, fromH, done };
    } else {
      this._anim = { t: 0, dur: animate ? 0.6 : 0, p0: cam.position.clone(), p1: pos, t0: this.controls.target.clone(), t1: target, done };
    }
    if (!animate) this._stepAnim(1);
  }

  _stepAnim(dt) {
    const a = this._anim;
    a.t += dt;
    const k = a.dur ? Math.min(1, a.t / a.dur) : 1;
    const e = 1 - Math.pow(1 - k, 3);
    this.camera.position.lerpVectors(a.p0, a.p1, e);
    this.controls.target.lerpVectors(a.t0, a.t1, e);
    if (a.z0 != null) {
      this.orthoCam.zoom = a.z0 + (a.z1 - a.z0) * e;
      this.orthoCam.updateProjectionMatrix();
    }
    this.camera.lookAt(this.controls.target);
    this.dirty = true;
    if (k >= 1) {
      this._anim = null;
      a.done?.();
      this.controls.update();
    }
  }

  /** Vieno pikselio dydis pasaulio vienetais ties tašku. */
  pixelSizeAt(worldPoint) {
    if (this.isOrtho) return (this.orthoCam.top - this.orthoCam.bottom) / this.orthoCam.zoom / this.height;
    const d = this.camera.position.distanceTo(worldPoint);
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov / 2))) / this.height;
  }

  toScreen(worldPoint) {
    const v = worldPoint.clone().project(this.camera);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height, visible: v.z < 1 && v.z > -1 };
  }

  // -------------------------------------------------------------------------
  // Taško parinkimas
  // -------------------------------------------------------------------------
  /**
   * @returns {{world: THREE.Vector3, local: THREE.Vector3, normal: THREE.Vector3|null, object: THREE.Object3D}|null}
   */
  pick(clientX, clientY, { snap = false } = {}) {
    if (!this.model) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const clipping = this.clip.min != null || this.clip.max != null;
    this.raycaster.firstHitOnly = !clipping;
    let hit = null;
    if (this.meshes.length) {
      const hits = this.raycaster.intersectObjects(this.meshes, false);
      hit = hits.find((h) => this._passesClip(h.point)) || null;
    }
    if (this.pointClouds.length) {
      const px = this.pixelSizeAt(hit ? hit.point : this.controls.target);
      this.raycaster.params.Points.threshold = px * Math.max(4, this.pointSize * 1.5);
      const phits = this.raycaster.intersectObjects(this.pointClouds, false).filter((h) => this._passesClip(h.point));
      if (phits.length) {
        // Pirmenybė arčiausiai spinduliui esančiam taškui tarp artimiausių
        phits.sort((a, b) => a.distance - b.distance);
        const near = phits.slice(0, 30).sort((a, b) => a.distanceToRay - b.distanceToRay)[0];
        if (!hit || near.distance < hit.distance) {
          const pos = near.object.geometry.attributes.position;
          const p = new THREE.Vector3().fromBufferAttribute(pos, near.index).applyMatrix4(near.object.matrixWorld);
          hit = { point: p, object: near.object, face: null };
        }
      }
    }
    if (!hit) return null;
    let world = hit.point.clone();
    let snapped = false;
    if (snap && hit.face) {
      const pos = hit.object.geometry.attributes.position;
      let best = null, bd = Infinity;
      for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
        const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(hit.object.matrixWorld);
        const d = v.distanceTo(world);
        if (d < bd) { bd = d; best = v; }
      }
      if (best && bd < this.pixelSizeAt(world) * 25) {
        world = best;
        snapped = true;
      }
    }
    let normal = null;
    if (hit.face) normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    return { world, local: this.worldToLocal(world), normal, object: hit.object, snapped };
  }

  // -------------------------------------------------------------------------
  // Paviršiaus aukščių ėmimas (tūriams, profiliams, plotams)
  // -------------------------------------------------------------------------
  /** Viršutinio paviršiaus aukštis (pasaulio Y) taške (x, z) arba NaN. */
  topHeightAt(x, z) {
    if (this.meshes.length) {
      const top = this.worldBox.max.y + (this.worldBox.max.y - this.worldBox.min.y + 1) * 0.1;
      this._ray = this._ray || new THREE.Raycaster();
      const rc = this._ray;
      rc.set(new THREE.Vector3(x, top, z), new THREE.Vector3(0, -1, 0));
      const clipping = this.clip.min != null || this.clip.max != null;
      rc.firstHitOnly = !clipping;
      const hits = rc.intersectObjects(this.meshes, false);
      const h = clipping ? hits.find((hh) => this._passesClip(hh.point)) : hits[0];
      return h ? h.point.y : NaN;
    }
    if (this.pointClouds.length) return this._pointGridHeight(x, z);
    return NaN;
  }

  /** Taškų debesiui sukuriamas aukščių tinklelis (maksimalus Y kiekviename langelyje). */
  _buildPointGrid() {
    const box = this.worldBox;
    const size = box.getSize(new THREE.Vector3());
    let total = 0;
    for (const pc of this.pointClouds) total += pc.geometry.attributes.position.count;
    const spacing = Math.sqrt((size.x * size.z) / Math.max(1, total));
    const cell = Math.max(spacing * 1.6, Math.max(size.x, size.z) / 2048);
    const nx = Math.ceil(size.x / cell) + 1, nz = Math.ceil(size.z / cell) + 1;
    const grid = new Float32Array(nx * nz).fill(NaN);
    const v = new THREE.Vector3();
    for (const pc of this.pointClouds) {
      const pos = pc.geometry.attributes.position;
      const m = pc.matrixWorld;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        if (!this._passesClip(v)) continue;
        const ix = Math.floor((v.x - box.min.x) / cell), iz = Math.floor((v.z - box.min.z) / cell);
        const k = iz * nx + ix;
        if (!(grid[k] >= v.y)) grid[k] = v.y;
      }
    }
    this._pointGrid = { grid, nx, nz, cell, minX: box.min.x, minZ: box.min.z, clipKey: `${this.clip.min}|${this.clip.max}` };
  }

  _pointGridHeight(x, z) {
    if (!this._pointGrid || this._pointGrid.clipKey !== `${this.clip.min}|${this.clip.max}`) this._buildPointGrid();
    const g = this._pointGrid;
    const ix = Math.floor((x - g.minX) / g.cell), iz = Math.floor((z - g.minZ) / g.cell);
    if (ix < 0 || iz < 0 || ix >= g.nx || iz >= g.nz) return NaN;
    const h = g.grid[iz * g.nx + ix];
    if (!isNaN(h)) return h;
    // Užpildome nedideles skyles kaimynų vidurkiu
    let s = 0, n = 0;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        const jx = ix + dx, jz = iz + dz;
        if (jx < 0 || jz < 0 || jx >= g.nx || jz >= g.nz) continue;
        const hh = g.grid[jz * g.nx + jx];
        if (!isNaN(hh)) { s += hh; n++; }
      }
    return n ? s / n : NaN;
  }

  // -------------------------------------------------------------------------
  // Modelio statistika
  // -------------------------------------------------------------------------
  /** Viso tinklo paviršiaus plotas ir (uždaro tinklo) tūris, pasaulio vienetais. */
  meshAreaVolume() {
    let area = 0, vol = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), bc = new THREE.Vector3();
    for (const mesh of this.meshes) {
      const g = mesh.geometry;
      const pos = g.attributes.position;
      const idx = g.index;
      const m = mesh.matrixWorld;
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i < n; i += 3) {
        const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(m);
        b.fromBufferAttribute(pos, i1).applyMatrix4(m);
        c.fromBufferAttribute(pos, i2).applyMatrix4(m);
        ab.subVectors(b, a);
        ac.subVectors(c, a);
        area += ab.cross(ac).length() / 2;
        vol += a.dot(bc.crossVectors(b, c)) / 6;
      }
    }
    return { area, volume: Math.abs(vol) };
  }

  /** Ekrano kopija (be etikečių – jas piešia programa). */
  snapshot() {
    this.headlight.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement;
  }
}

export function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * p;
}
