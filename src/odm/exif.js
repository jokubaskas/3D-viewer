// Drono nuotraukų metaduomenų (EXIF + DJI / Anzu XMP) skaitymas naršyklėje.
// Skaitoma tik failo pradžia (iki ~1 MB), todėl 1000 nuotraukų apdorojama per kelias sekundes.

const RTK_LABELS = { 50: 'FIX', 34: 'FLOAT', 16: 'SINGLE', 0: 'NĖRA' };
export const rtkLabel = (flag) => (flag == null ? '—' : RTK_LABELS[flag] || String(flag));

/** Mavic 3T / 3E ir kitų DJI kamerų failų tipas pagal pavadinimą. */
export function djiChannel(name) {
  const m = name.match(/_([A-Z])\.(jpe?g)$/i);
  const c = m ? m[1].toUpperCase() : '';
  if (c === 'T') return 'thermal';
  if (c === 'Z') return 'zoom';
  if (c === 'W' || c === 'V') return 'wide';
  return 'wide';
}

/**
 * @returns {Promise<PhotoMeta>}
 * @typedef {{name:string,size:number,file:File,make?:string,model?:string,width?:number,height?:number,
 *   date?:Date,lat?:number,lon?:number,alt?:number,absAlt?:number,relAlt?:number,f?:number,f35?:number,
 *   rtkFlag?:number,stdLat?:number,stdLon?:number,stdHgt?:number,gimbalPitch?:number,yaw?:number,xmpVersion?:string,
 *   channel:string, error?:string}} PhotoMeta
 */
export async function readPhotoMeta(file) {
  const meta = { name: file.name, size: file.size, file, channel: djiChannel(file.name) };
  try {
    let buf = await file.slice(0, 1 << 19).arrayBuffer();
    let res = parseJpeg(new DataView(buf), meta);
    if (!res.xmp && file.size > buf.byteLength) {
      buf = await file.slice(0, 1 << 21).arrayBuffer();
      res = parseJpeg(new DataView(buf), meta);
    }
    if (res.xmp) parseDjiXmp(res.xmp, meta);
    if (meta.channel === 'wide' && meta.width === 640 && meta.height === 512) meta.channel = 'thermal';
  } catch (e) {
    meta.error = e.message;
  }
  return meta;
}

function parseJpeg(dv, meta) {
  if (dv.getUint16(0) !== 0xffd8) throw new Error('Ne JPEG failas');
  let p = 2;
  let xmp = null;
  while (p + 4 <= dv.byteLength) {
    if (dv.getUint8(p) !== 0xff) break;
    const marker = dv.getUint8(p + 1);
    if (marker === 0xd9 || marker === 0xda) break; // EOI / SOS
    const len = dv.getUint16(p + 2);
    const start = p + 4;
    if (marker === 0xe1) {
      const hdr = ascii(dv, start, Math.min(29, dv.byteLength - start));
      if (hdr.startsWith('Exif\0\0')) parseTiff(dv, start + 6, meta);
      else if (hdr.startsWith('http://ns.adobe.com/xap/1.0/')) {
        const s = start + 29;
        const e = Math.min(start + len - 2, dv.byteLength);
        xmp = new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset + s, Math.max(0, e - s)));
      }
    } else if (marker >= 0xc0 && marker <= 0xc3 && start + 5 <= dv.byteLength) {
      meta.height = meta.height || dv.getUint16(start + 1);
      meta.width = meta.width || dv.getUint16(start + 3);
    }
    p = start + len - 2;
  }
  return { xmp };
}

function ascii(dv, off, len) {
  let s = '';
  for (let i = 0; i < len && off + i < dv.byteLength; i++) s += String.fromCharCode(dv.getUint8(off + i));
  return s;
}

function parseTiff(dv, t0, meta) {
  const le = dv.getUint16(t0) === 0x4949;
  const u16 = (o) => dv.getUint16(t0 + o, le);
  const u32 = (o) => dv.getUint32(t0 + o, le);
  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  const readIfd = (off) => {
    const tags = {};
    if (off <= 0 || t0 + off + 2 > dv.byteLength) return tags;
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (t0 + e + 12 > dv.byteLength) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = (SIZES[type] || 1) * count;
      const vo = size > 4 ? u32(e + 8) : e + 8;
      if (t0 + vo + size > dv.byteLength) continue;
      tags[tag] = readVal(type, count, vo);
    }
    return tags;
  };
  const readVal = (type, count, o) => {
    switch (type) {
      case 2: return ascii(dv, t0 + o, count).replace(/\0+$/, '').trim();
      case 3: return count === 1 ? u16(o) : Array.from({ length: count }, (_, i) => u16(o + i * 2));
      case 4: return count === 1 ? u32(o) : Array.from({ length: count }, (_, i) => u32(o + i * 4));
      case 5: {
        const r = (k) => u32(o + k * 8) / (u32(o + k * 8 + 4) || 1);
        return count === 1 ? r(0) : Array.from({ length: count }, (_, k) => r(k));
      }
      case 10: {
        const r = (k) => dv.getInt32(t0 + o + k * 8, le) / (dv.getInt32(t0 + o + k * 8 + 4, le) || 1);
        return count === 1 ? r(0) : Array.from({ length: count }, (_, k) => r(k));
      }
      case 1: case 7: return count === 1 ? dv.getUint8(t0 + o) : Array.from({ length: Math.min(count, 64) }, (_, i) => dv.getUint8(t0 + o + i));
      default: return null;
    }
  };

  const ifd0 = readIfd(u32(4));
  meta.make = ifd0[0x010f];
  meta.model = ifd0[0x0110];
  if (ifd0[0x8769]) {
    const ex = readIfd(ifd0[0x8769]);
    if (ex[0x9003]) {
      const m = String(ex[0x9003]).match(/(\d+):(\d+):(\d+) (\d+):(\d+):(\d+)/);
      if (m) meta.date = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    }
    meta.f = ex[0x920a];
    meta.f35 = ex[0xa405];
    meta.width = ex[0xa002] || meta.width;
    meta.height = ex[0xa003] || meta.height;
  }
  if (ifd0[0x8825]) {
    const g = readIfd(ifd0[0x8825]);
    const dms = (v) => (Array.isArray(v) ? v[0] + v[1] / 60 + v[2] / 3600 : v);
    if (g[2] != null && g[4] != null) {
      meta.lat = dms(g[2]) * (g[1] === 'S' ? -1 : 1);
      meta.lon = dms(g[4]) * (g[3] === 'W' ? -1 : 1);
    }
    if (g[6] != null) meta.alt = g[6] * (g[5] === 1 || (Array.isArray(g[5]) && g[5][0] === 1) ? -1 : 1);
  }
}

function parseDjiXmp(xmp, meta) {
  const get = (k) => {
    // DJI rašo „drone-dji:“, Anzu (Raptor T ir kt.) ir kai kurie kiti gamintojai – „drone:“
    const m = xmp.match(new RegExp(`(?:drone-dji|drone):${k}="([^"]*)"`)) || xmp.match(new RegExp(`<(?:drone-dji|drone):${k}>([^<]*)<`));
    return m ? m[1].trim() : null;
  };
  const num = (k) => {
    const v = get(k);
    return v != null && v !== '' && isFinite(+v) ? +v : undefined;
  };
  meta.absAlt = num('AbsoluteAltitude');
  meta.relAlt = num('RelativeAltitude');
  meta.rtkFlag = num('RtkFlag');
  meta.stdLat = num('RtkStdLat');
  meta.stdLon = num('RtkStdLon');
  meta.stdHgt = num('RtkStdHgt');
  meta.gimbalPitch = num('GimbalPitchDegree');
  meta.yaw = num('FlightYawDegree');
  meta.gimbalYaw = num('GimbalYawDegree');
  meta.xmpVersion = get('Version');
  const src = (get('ImageSource') || '').toLowerCase();
  if (/infrared|thermal|^ir/.test(src)) meta.channel = 'thermal';
  else if (/zoom/.test(src)) meta.channel = 'zoom';
  // DJI XMP koordinatės tikslesnės už EXIF (daugiau skaitmenų)
  const lat = num('GpsLatitude') ?? num('Latitude');
  const lon = num('GpsLongitude') ?? num('GpsLongtitude') ?? num('Longitude');
  if (lat != null && lon != null && Math.abs(lat) > 0.0001) {
    meta.lat = lat;
    meta.lon = lon;
  }
  if (!meta.model) {
    const m = xmp.match(/tiff:Model="([^"]*)"/);
    if (m) meta.model = m[1];
  }
}

/** Skaito daug failų lygiagrečiai. */
export async function readAllMeta(files, onProgress, concurrency = 8) {
  const out = new Array(files.length);
  let i = 0, done = 0;
  const worker = async () => {
    while (i < files.length) {
      const k = i++;
      out[k] = await readPhotoMeta(files[k]);
      done++;
      if (done % 10 === 0 || done === files.length) onProgress?.(done / files.length);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}
