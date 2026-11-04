// Žemėlapis po modeliu (palydovas / topografinis / savas WMTS).
import { $, settings, saveSettings, viewer, basemap, toast } from './core.js';
import { t as tr } from '../i18n.js';
import { BASEMAPS } from '../geo/basemap.js';

// ---------------------------------------------------------------------------
// Žemėlapis po modeliu
// ---------------------------------------------------------------------------
const mapSource = () =>
  settings.mapSource === 'custom' ? { url: settings.mapUrl.trim(), maxZoom: 20, attribution: '' } : BASEMAPS[settings.mapSource] || BASEMAPS.satellite;
let mapBusy = null;

/** Parodo / paslepia žemėlapį pagal settings.mapOn. quiet – be klaidų pranešimų (pvz. įkeliant modelį). */
export async function refreshMap(quiet = false) {
  syncMapUi();
  if (!settings.mapOn) return basemap.hide();
  if (!viewer.hasModel) return;
  const why = basemap.reason;
  if (why) {
    basemap.hide();
    if (!quiet) toast(why, 'info', 7000);
    return;
  }
  const src = mapSource();
  if (!src.url || !/\{z\}/.test(src.url) || !/\{x\}/.test(src.url) || !/\{y\}/.test(src.url)) {
    basemap.hide();
    return toast(tr('Įveskite žemėlapio adresą su {z}, {x} ir {y}.'), 'error', 7000);
  }
  const run = (mapBusy = basemap.show({ ...src, axis: viewer.upAxis }));
  try {
    const r = await run;
    if (r && r.failed) toast(tr('Dalies žemėlapio plytelių nepavyko atsisiųsti ({n}).', { n: r.failed }), 'info', 6000);
  } catch (e) {
    if (mapBusy === run) toast(e.message, 'error', 8000);
  }
}

function syncMapUi() {
  $('#btn-map').classList.toggle('active', settings.mapOn);
  $('#map-on').checked = settings.mapOn;
  $('#map-source').value = settings.mapSource;
  $('#row-map-url').hidden = settings.mapSource !== 'custom';
  const a = $('#map-attrib');
  a.hidden = !settings.mapOn || !viewer.hasModel;
  a.textContent = mapSource().attribution || '';
}

export function toggleMap(on = !settings.mapOn) {
  settings.mapOn = on;
  saveSettings();
  refreshMap();
}

$('#btn-map').addEventListener('click', () => toggleMap());
$('#map-on').addEventListener('change', (e) => toggleMap(e.target.checked));
$('#map-source').addEventListener('change', (e) => {
  settings.mapSource = e.target.value;
  saveSettings();
  syncMapUi();
  if (settings.mapOn && (settings.mapSource !== 'custom' || settings.mapUrl)) refreshMap();
});
$('#map-url').value = settings.mapUrl;
$('#map-url').addEventListener('change', (e) => {
  settings.mapUrl = e.target.value.trim();
  saveSettings();
  if (settings.mapOn) refreshMap();
});
$('#map-opacity').value = settings.mapOpacity;
basemap.setOpacity(settings.mapOpacity);
$('#map-opacity').addEventListener('input', (e) => {
  settings.mapOpacity = +e.target.value;
  basemap.setOpacity(settings.mapOpacity);
  saveSettings();
});
syncMapUi();

