// ATEA žodinis ženklas (perpieštas pagal atea.lt; jei turite oficialų SVG – pakeiskite LOGO_PATHS).
// viewBox 0 0 156 40, linijos storis 4.6, spalva = currentColor
export const LOGO_VIEWBOX = [156, 40];
export const LOGO_STROKE = 4.6;
export const LOGO_PATHS = [
  'M2.5 38 L22 2.5 H38 V38', // A (be kairės kojos viršaus – ATEA stilius)
  'M12.5 21 H38', //            A skersinis
  'M46 2.5 H74 M60 2.5 V38', // T
  'M106 6.5 A16.5 16.5 0 1 0 106 33.5', // E (apvali „C“ forma)
  'M90 20.2 H112', //            E vidurinis brūkšnys
  'M120 38 V2.5 H134 L153.5 38', // A (veidrodinis)
  'M120 21 H143',
];

export function logoSvg(cls = '') {
  const [w, h] = LOGO_VIEWBOX;
  return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" fill="none" stroke="currentColor" stroke-width="${LOGO_STROKE}" stroke-linejoin="miter" aria-label="ATEA" role="img">${LOGO_PATHS.map((d) => `<path d="${d}"/>`).join('')}</svg>`;
}

/** Nupiešia logotipą ant 2D drobės. */
export function drawLogo(g, x, y, height, color) {
  const [, h] = LOGO_VIEWBOX;
  const s = height / h;
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.strokeStyle = color;
  g.lineWidth = LOGO_STROKE;
  g.lineJoin = 'miter';
  for (const d of LOGO_PATHS) g.stroke(new Path2D(d));
  g.restore();
  return (LOGO_VIEWBOX[0] / h) * height;
}
