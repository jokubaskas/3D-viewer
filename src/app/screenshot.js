// Ekrano kopija su matavimų etiketėmis ir Atea žyma (PNG).
import { $, settings, viewport, viewer, state, toast, download, baseName, stamp } from './core.js';
import { LOGO_VIEWBOX, drawLogo } from '../logo.js';
import { locale } from '../i18n.js';

// Ekrano kopija su etiketėmis ir Atea žyma
export async function screenshot() {
  if (!viewer.hasModel) return toast('Nėra ką fotografuoti');
  const src = viewer.snapshot();
  const w = src.width, h = src.height;
  const pr = w / viewer.width;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d');
  const bgs = { atea: ['#1d4629', '#102d21', '#1f2326'], graphite: ['#30363a', '#1f2326', '#141719'], light: ['#f4f7f6', '#d9e2df', '#c6d2ce'], white: ['#ffffff', '#ffffff', '#ffffff'] };
  const [c0, c1, c2] = bgs[settings.background] || bgs.atea;
  const grad = g.createRadialGradient(w * 0.3, h * 0.4, 0, w * 0.3, h * 0.4, Math.max(w, h) * 0.85);
  grad.addColorStop(0, c0);
  grad.addColorStop(0.6, c1);
  grad.addColorStop(1, c2);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.drawImage(src, 0, 0);
  // Etiketės
  if (settings.labels) {
    const vr = viewport.getBoundingClientRect();
    document.querySelectorAll('.label-layer .m-label').forEach((el) => {
      if (el.style.display === 'none' || el.closest('[style*="display: none"]')) return;
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const cs = getComputedStyle(el);
      const x = (r.left - vr.left) * pr, y = (r.top - vr.top) * pr, bw = r.width * pr, bh = r.height * pr;
      g.fillStyle = cs.backgroundColor;
      roundRect(g, x, y, bw, bh, 6 * pr);
      g.fill();
      g.fillStyle = cs.getPropertyValue('--c') || '#fff';
      g.fillRect(x, y + 2 * pr, 3 * pr, bh - 4 * pr);
      g.fillStyle = '#fff';
      g.font = `${cs.fontWeight} ${parseFloat(cs.fontSize) * pr}px ${cs.fontFamily}`;
      g.textBaseline = 'middle';
      const lines = el.innerText.split('\n');
      lines.forEach((t, i) => g.fillText(t, x + parseFloat(cs.paddingLeft) * pr + 2 * pr, y + (bh / lines.length) * (i + 0.5)));
    });
  }
  // Žyma: ATEA logotipas + failas ir data
  const pad = 14 * pr, bh = 40 * pr;
  g.font = `600 ${12 * pr}px Inter, Segoe UI, Arial, sans-serif`;
  const caption = `${state.modelInfo?.name || ''}  •  ${new Date().toLocaleString(locale())}`;
  const logoW = (LOGO_VIEWBOX[0] / LOGO_VIEWBOX[1]) * 16 * pr;
  const boxW = 14 * pr + logoW + 14 * pr + g.measureText(caption).width + 14 * pr;
  g.fillStyle = 'rgba(31,35,38,0.92)';
  roundRect(g, pad, h - pad - bh, boxW, bh, 4 * pr);
  g.fill();
  g.fillStyle = '#008b01';
  g.fillRect(pad, h - pad - bh, 4 * pr, bh);
  drawLogo(g, pad + 14 * pr, h - pad - bh / 2 - 8 * pr, 16 * pr, '#ffffff');
  g.fillStyle = '#c3cac6';
  g.textBaseline = 'middle';
  g.fillText(caption, pad + 28 * pr + logoW, h - pad - bh / 2);
  out.toBlob((blob) => download(`${baseName()}_${stamp()}.png`, blob));
  toast('Ekrano kopija išsaugota');
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
$('#btn-screenshot').addEventListener('click', screenshot);

