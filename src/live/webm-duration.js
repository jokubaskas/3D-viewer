// MediaRecorder WebM įrašuose nėra trukmės (Duration), todėl naršyklės rodo „∞“, nebuferizuoja iki galo ir neleidžia
// sukti. Trukmė įrašoma į Segment → Info antraštę (keičiama tik failo pradžia, likusi dalis – ta pati Blob).
const ID = { EBML: 0x1a45dfa3, Segment: 0x18538067, Info: 0x1549a966, SeekHead: 0x114d9b74, Cluster: 0x1f43b675, TimecodeScale: 0x2ad7b1, Duration: 0x4489 };

function vlen(x) {
  for (let len = 1, mask = 0x80; len <= 8; len++, mask >>= 1) if (x & mask) return [len, mask];
  return [0, 0];
}

/** EBML elementas pozicijoje p: { id, start (duomenų pradžia), size, unknown } arba null. */
function el(b, p) {
  if (p >= b.length) return null;
  const [il] = vlen(b[p]);
  if (!il || p + il > b.length) return null;
  let id = 0;
  for (let i = 0; i < il; i++) id = id * 256 + b[p + i];
  const s = p + il;
  if (s >= b.length) return null;
  const [sl, mask] = vlen(b[s]);
  if (!sl || s + sl > b.length) return null;
  let size = b[s] & (mask - 1);
  let ones = size === mask - 1;
  for (let i = 1; i < sl; i++) {
    size = size * 256 + b[s + i];
    ones &&= b[s + i] === 0xff;
  }
  return { id, start: s + sl, size, unknown: ones };
}

export async function fixWebmDuration(blob, ms) {
  try {
    if (!(ms > 0)) return blob;
    const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1 << 16)).arrayBuffer());
    let e = el(head, 0);
    if (e?.id !== ID.EBML) return blob;
    const seg = el(head, e.start + e.size);
    if (seg?.id !== ID.Segment || !seg.unknown) return blob; // žinomo dydžio segmentą tektų perskaičiuoti – paliekama
    let p = seg.start;
    for (;;) {
      e = el(head, p);
      if (!e || e.unknown || e.id === ID.SeekHead || e.id === ID.Cluster) return blob; // SeekHead pozicijos pasislinktų
      if (e.id === ID.Info) break;
      p = e.start + e.size;
    }
    const end = e.start + e.size;
    if (end > head.length) return blob;
    const body = head.subarray(e.start, end);
    const parts = [];
    let scale = 1e6;
    let len = 0;
    for (let q = 0; q < body.length; ) {
      const c = el(body, q);
      if (!c || c.start + c.size > body.length) return blob;
      if (c.id === ID.TimecodeScale) scale = body.subarray(c.start, c.start + c.size).reduce((a, x) => a * 256 + x, 0) || 1e6;
      if (c.id !== ID.Duration) {
        parts.push(body.subarray(q, c.start + c.size));
        len += c.start + c.size - q;
      }
      q = c.start + c.size;
    }
    const dur = new Uint8Array(11);
    dur.set([0x44, 0x89, 0x88]);
    new DataView(dur.buffer).setFloat64(3, (ms * 1e6) / scale);
    len += dur.length;
    const hdr = new Uint8Array(12); // Info ID + dydis 8 baitais (0x01 + 7)
    hdr.set([0x15, 0x49, 0xa9, 0x66, 0x01]);
    for (let i = 11, v = len; i > 4; i--, v = Math.floor(v / 256)) hdr[i] = v & 0xff;
    return new Blob([head.subarray(0, p), hdr, ...parts, dur, blob.slice(end)], { type: blob.type });
  } catch {
    return blob;
  }
}
