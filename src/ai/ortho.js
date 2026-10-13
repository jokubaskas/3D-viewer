// Ortografinis vaizdas iš viršaus (kaip ortofoto), nupieštas iš 3D modelio – AI modeliams.
// Grąžina JPEG ir funkciją, kuri pikselio koordinates paverčia pasaulio X/Z.
import * as THREE from 'three';

/**
 * @param {import('../viewer.js').Viewer} viewer
 * @param {{minX:number, maxX:number, minZ:number, maxZ:number, gsd:number, maxPx?:number}} region – pasaulio koordinatėmis
 */
export async function renderTopDown(viewer, { minX, maxX, minZ, maxZ, gsd, maxPx = 6144 }) {
  const r = viewer.renderer;
  const limit = Math.min(maxPx, r.capabilities.maxTextureSize || 4096);
  const spanX = Math.max(maxX - minX, 1e-3), spanZ = Math.max(maxZ - minZ, 1e-3);
  let g = gsd;
  if (spanX / g > limit || spanZ / g > limit) g = Math.max(spanX, spanZ) / limit;
  const W = Math.max(16, Math.round(spanX / g)), H = Math.max(16, Math.round(spanZ / g));

  const box = viewer.worldBox;
  const cam = new THREE.OrthographicCamera(-spanX / 2, spanX / 2, spanZ / 2, -spanZ / 2, 0.01, box.max.y - box.min.y + 1000);
  cam.up.set(0, 0, -1); // vaizdo viršus – šiaurė (−Z)
  cam.position.set((minX + maxX) / 2, box.max.y + 100, (minZ + maxZ) / 2);
  cam.lookAt((minX + maxX) / 2, box.min.y, (minZ + maxZ) / 2);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();

  const rt = new THREE.WebGLRenderTarget(W, H, { samples: 4 });
  rt.texture.colorSpace = THREE.SRGBColorSpace;

  // Laikinai: originalios spalvos be šešėlių, be matavimų ir pagalbinių objektų
  const prevMode = viewer.viewMode, prevWire = viewer.wireframe;
  const hidden = [];
  viewer.scene.children.forEach((o) => {
    if (o !== viewer.modelRoot && o.visible && !o.isLight) {
      hidden.push(o);
      o.visible = false;
    }
  });
  const overlayVis = viewer.overlay.visible;
  viewer.overlay.visible = false;
  if (prevMode !== 'texture' || prevWire) {
    viewer.wireframe = false;
    viewer.setViewMode('texture');
  }
  const prevClear = r.getClearAlpha();
  r.setClearColor(0x000000, 1);
  try {
    r.setRenderTarget(rt);
    r.clear();
    r.render(viewer.scene, cam);
    const buf = new Uint8Array(W * H * 4);
    r.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    // WebGL eilutės – iš apačios į viršų
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    const row = W * 4;
    for (let y = 0; y < H; y++) img.data.set(buf.subarray((H - 1 - y) * row, (H - y) * row), y * row);
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
    return {
      blob,
      canvas,
      width: W,
      height: H,
      gsd: spanX / W,
      /** Pikselio koordinatės (x – į dešinę, y – žemyn) -> pasaulio [x, z] */
      toWorld: (px, py) => [minX + (px / W) * spanX, minZ + (py / H) * spanZ],
      /** Pasaulio x, z -> pikseliai */
      toPixel: (wx, wz) => [((wx - minX) / spanX) * W, ((wz - minZ) / spanZ) * H],
    };
  } finally {
    r.setRenderTarget(null);
    r.setClearColor(0x000000, prevClear);
    rt.dispose();
    hidden.forEach((o) => (o.visible = true));
    viewer.overlay.visible = overlayVis;
    if (prevMode !== 'texture' || prevWire) {
      viewer.wireframe = prevWire;
      viewer.setViewMode(prevMode);
    }
    viewer.requestRender();
  }
}
