// Bendri programos objektai: nustatymai, 3D peržiūra, matavimų sąrašas, pranešimai ir būsena.
// Moduliai (src/app/*.js) juos importuoja iš čia; main.js – sąsajos „klijai“.
// Funkcijos, kurios lieka main.js ir reikalingos moduliams (pvz. setLoading, addMeasurement), registruojamos
// objekte `app` (main.js pradžioje) – taip išvengiama ciklinių importų.
import { Viewer } from '../viewer.js';
import { Gizmo } from '../gizmo.js';
import { Basemap } from '../geo/basemap.js';
import { CompareModel } from '../compare.js';
import { ProfileChart } from '../profile.js';
import { units } from '../units.js';
import { t as tr } from '../i18n.js';

export const $ = (s) => document.querySelector(s);
export const $$ = (s) => [...document.querySelectorAll(s)];

// ---------------------------------------------------------------------------
// Nustatymai
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'atea3d.settings.v1';
export const settings = {
  aiUrl: '', aiClasses: ['car', 'truck', 'bus', 'motorcycle'], aiThreshold: 0.5, aiOutlineKind: 'volume',
  coordOrder: 'ne', unit: 'm', precision: 2, snap: false, resolution: 250, density: 1.6, labelSize: 'md', labels: true,
  background: 'atea', pointSize: 2.5, viewMode: 'texture', grid: false,
  mapOn: false, mapSource: 'satellite', mapUrl: '', mapOpacity: 1,
};
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
} catch { /* privatus režimas */ }
export const saveSettings = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* ignoruojame */ }
};
units.display = settings.unit;
units.precision = settings.precision;
if (!['atea', 'graphite', 'light', 'white'].includes(settings.background)) settings.background = 'atea';

// ---------------------------------------------------------------------------
// Pagrindiniai objektai
// ---------------------------------------------------------------------------
export const viewport = $('#viewport');
export const viewer = new Viewer(viewport);
export const gizmo = new Gizmo($('#gizmo'), viewer);
export const basemap = new Basemap(viewer);
viewer.basemap = basemap;
export const cmp = new CompareModel(viewer);
export const profile = new ProfileChart($('#profile-chart'), viewer, units);

/** @type {{m: import('../measurements.js').Measurement, visual: import('../measurements.js').MeasurementVisual}[]} */
export const items = [];

/** Kintanti būsena: pasirinktas matavimas, atidarytas modelis, ODM projektas, palyginimas. */
export const state = {
  selectedId: null,
  /** @type {{name:string, format:string}|null} */
  modelInfo: null,
  odmProject: null, // projektas, iš kurio atidarytas dabartinis modelis
  compareState: null,
};

/** main.js funkcijos moduliams (užpildoma paleidžiant). */
export const app = {};

// ---------------------------------------------------------------------------
// Pranešimai ir failai
// ---------------------------------------------------------------------------
export function toast(msg, type = 'info', ms = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = tr(msg);
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

export function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export const baseName = () => (state.modelInfo?.name || 'modelis').replace(/\.[^.]+$/, '');
export const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Metrai → modelio vienetai. */
export const metersToWorld = (m) => m / units.metersPerUnit;
