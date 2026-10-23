// Linijinės SVG ikonos (24x24, stroke = currentColor)
const p = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export const ICONS = {
  open: p('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1"/><path d="M3 7v11a2 2 0 0 0 2 2h13.5a2 2 0 0 0 1.9-1.4L22 12H7.4a2 2 0 0 0-1.9 1.4L3 20"/>'),
  folder: p('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5h5"/>'),
  ruler: p('<path d="M3 17 17 3l4 4L7 21z"/><path d="m7 13 2 2M10 10l2 2M13 7l2 2"/>'),
  camera: p('<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.5"/>'),
  help: p('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  cube: p('<path d="M12 2.5 21 7v10l-9 4.5L3 17V7z"/><path d="M3 7l9 4.5L21 7M12 11.5v10"/>'),
  mountain: p('<path d="m2 20 7-11 4 6 3-4 6 9z"/><circle cx="17" cy="6" r="2"/>'),
  fit: p('<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/><rect x="8.5" y="8.5" width="7" height="7" rx="1"/>'),
  undo: p('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  check: p('<path d="m5 12.5 4.5 4.5L19 7"/>'),
  close: p('<path d="M6 6l12 12M18 6 6 18"/>'),
  table: p('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>'),
  save: p('<path d="M5 3h11l4 4v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>'),
  upload: p('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>'),
  trash: p('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  home: p('<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/><path d="M10 20v-6h4v6"/>'),
  user: p('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>'),
  logout: p('<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>'),
  eye: p('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: p('<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  target: p('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  copy: p('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  live: p('<circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4"/>'),
  record: p('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.6" fill="currentColor"/>'),
  stop: p('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'),
  edit: p('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  play: p('<path d="M7 4.5v15l12-7.5z"/>'),
  fullscreen: p('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
  sound: p('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
  mute: p('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>'),
  refresh: p('<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>'),
  chart: p('<path d="M3 20h18"/><path d="m3 16 5-6 4 3 4-6 5 5"/>'),

  // Įrankiai
  navigate: p('<path d="M5 3l14 7-6 2-2 6z"/>'),
  distance: p('<circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><path d="M6.5 17.5l11-11" stroke-dasharray="2.5 2.5"/>'),
  polyline: p('<circle cx="4" cy="18" r="1.8"/><circle cx="10" cy="8" r="1.8"/><circle cx="15" cy="15" r="1.8"/><circle cx="20" cy="5" r="1.8"/><path d="m5 16.5 4-7M11.3 9.4l2.5 4.2M16 13.4l3.2-6.8"/>'),
  height: p('<path d="M5 20h14"/><path d="M17 4v16M14.5 6.5 17 4l2.5 2.5M14.5 17.5 17 20l2.5-2.5"/><path d="m4 20 6-10 3 4" opacity=".55"/>'),
  angle: p('<path d="M4 20 18 5"/><path d="M4 20h16"/><path d="M11 20a7 7 0 0 0-2.2-5.2"/>'),
  point: p('<path d="M12 21s-7-6.3-7-11.5A7 7 0 0 1 19 9.5C19 14.7 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  area: p('<path d="M4 7l7-4 9 5-2 11-12 2z" fill="currentColor" fill-opacity=".18"/><circle cx="4" cy="7" r="1.3" fill="currentColor"/><circle cx="20" cy="8" r="1.3" fill="currentColor"/><circle cx="6" cy="21" r="1.3" fill="currentColor"/>'),
  volume: p('<path d="M2 19c3-1 4-9 10-10s7 9 10 10z" fill="currentColor" fill-opacity=".18"/><path d="M2 19h20" stroke-dasharray="2 2"/>'),
  profile: p('<path d="M3 20h18"/><path d="M3 15l4-5 4 3 4-7 6 6" /><path d="M3 4v16" opacity=".5"/>'),
  scale: p('<path d="M3 8h18v8H3z"/><path d="M7 8v3M11 8v4M15 8v3M19 8v4"/>'),
  report: p('<path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5M8.5 13h7M8.5 16.5h5"/>'),
  map: p('<path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z"/><path d="M9 4v13.5M15 6.5V20"/>'),
  car: p('<path d="M5 17h14M6 17v2M18 17v2"/><path d="M4 13l2-5a2 2 0 0 1 1.9-1.4h8.2A2 2 0 0 1 18 8l2 5v4H4z"/><circle cx="8" cy="14" r="1" fill="currentColor"/><circle cx="16" cy="14" r="1" fill="currentColor"/>'),
  magic: p('<path d="M4 20 14 10"/><path d="M15 3v3M13.5 4.5h3M19 8v2M18 9h2M18 14v3M16.5 15.5h3"/><path d="m12 8 4 4"/>'),
  level: p('<rect x="2" y="9" width="20" height="6" rx="3"/><circle cx="12" cy="12" r="1.6"/><path d="M9 9v6M15 9v6"/>'),
};

export function icon(name) {
  return ICONS[name] || '';
}

/** Užpildo visus [data-icon] elementus atitinkamomis SVG ikonomis. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (!el.firstElementChild) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  });
}
