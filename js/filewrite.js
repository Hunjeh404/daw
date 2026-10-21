// 파일 만들기: WAV(16/24비트), MP3(320kbps), 태그, zip 묶기, SRT 읽기
const SR = 44100;

// ---------- WAV ----------
function infoChunk(meta) {
  const enc = new TextEncoder();
  const parts = [];
  for (const [id, text] of [['INAM', meta.title], ['IART', meta.artist]]) {
    if (!text) continue;
    const b = enc.encode(text + '\0');
    const pad = b.length & 1;
    const h = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 4; i++) h.setUint8(i, id.charCodeAt(i));
    h.setUint32(4, b.length, true);
    parts.push(new Uint8Array(h.buffer), b);
    if (pad) parts.push(new Uint8Array(1));
  }
  if (!parts.length) return null;
  const size = 4 + parts.reduce((s, p) => s + p.length, 0);
  const h = new DataView(new ArrayBuffer(12));
  'LIST'.split('').forEach((c, i) => h.setUint8(i, c.charCodeAt(0)));
  h.setUint32(4, size, true);
  'INFO'.split('').forEach((c, i) => h.setUint8(8 + i, c.charCodeAt(0)));
  return [new Uint8Array(h.buffer), ...parts];
}

export class WavWriter {
  constructor(frames, bits, meta) {
    this.bits = bits;
    this.parts = [];
    const bps = bits / 8;
    const dataBytes = frames * 2 * bps;
    const info = infoChunk(meta || {});
    const infoLen = info ? info.reduce((s, p) => s + p.length, 0) : 0;
    const h = new DataView(new ArrayBuffer(36));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); h.setUint32(4, 4 + 24 + infoLen + 8 + dataBytes, true); w(8, 'WAVE');
    w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 2, true);
    h.setUint32(24, SR, true); h.setUint32(28, SR * 2 * bps, true); h.setUint16(32, 2 * bps, true); h.setUint16(34, bits, true);
    this.parts.push(new Uint8Array(h.buffer));
    if (info) this.parts.push(...info);
    const d = new DataView(new ArrayBuffer(8));
    'data'.split('').forEach((c, i) => d.setUint8(i, c.charCodeAt(0)));
    d.setUint32(4, dataBytes, true);
    this.parts.push(new Uint8Array(d.buffer));
    this.clipped = 0;
    this.max = 0;
  }
  push(L, R) {
    const n = L.length;
    for (let i = 0; i < n; i++) { const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (a > this.max) this.max = a; }
    if (this.bits === 16) {
      const out = new Int16Array(n * 2);
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 2; c++) {
          // 삼각 분포 디더: 16비트로 줄일 때 생기는 거친 잡음을 고르게 만든다
          let v = (c ? R[i] : L[i]) * 32767 + (Math.random() - Math.random());
          if (v > 32767) { v = 32767; this.clipped++; } else if (v < -32768) { v = -32768; this.clipped++; }
          out[i * 2 + c] = Math.round(v);
        }
      }
      this.parts.push(new Uint8Array(out.buffer));
    } else {
      const out = new Uint8Array(n * 6);
      let o = 0;
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 2; c++) {
          let v = Math.round((c ? R[i] : L[i]) * 8388607);
          if (v > 8388607) { v = 8388607; this.clipped++; } else if (v < -8388608) { v = -8388608; this.clipped++; }
          out[o++] = v & 255; out[o++] = (v >> 8) & 255; out[o++] = (v >> 16) & 255;
        }
      }
      this.parts.push(out);
    }
  }
  async finish() { return new Blob(this.parts, { type: 'audio/wav' }); }
}

// ---------- MP3 + ID3 ----------
function utf16(text, terminate) {
  const b = new Uint8Array(2 + text.length * 2 + (terminate ? 2 : 0));
  b[0] = 0xff; b[1] = 0xfe;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); b[2 + i * 2] = c & 255; b[3 + i * 2] = c >> 8; }
  return b;
}
function frame(id, body) {
  const h = new Uint8Array(10);
  for (let i = 0; i < 4; i++) h[i] = id.charCodeAt(i);
  const n = body.length;
  h[4] = (n >>> 24) & 255; h[5] = (n >>> 16) & 255; h[6] = (n >>> 8) & 255; h[7] = n & 255;
  const out = new Uint8Array(10 + n);
  out.set(h); out.set(body, 10);
  return out;
}
const cat = (...arr) => { const n = arr.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(n); let p = 0; for (const a of arr) { o.set(a, p); p += a.length; } return o; };

export function id3(meta) {
  const frames = [];
  if (meta.title) frames.push(frame('TIT2', cat(new Uint8Array([1]), utf16(meta.title))));
  if (meta.artist) frames.push(frame('TPE1', cat(new Uint8Array([1]), utf16(meta.artist))));
  if (meta.lyrics) frames.push(frame('USLT', cat(new Uint8Array([1]), new TextEncoder().encode('kor'), utf16('', true), utf16(meta.lyrics))));
  if (meta.art) {
    const mime = new TextEncoder().encode(meta.art.mime + '\0');
    frames.push(frame('APIC', cat(new Uint8Array([0]), mime, new Uint8Array([3, 0]), meta.art.bytes)));
  }
  const body = cat(...frames);
  const n = body.length;
  const h = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
  return cat(h, body);
}

export class Mp3Writer {
  constructor(meta) {
    this.parts = [id3(meta || {})];
    this.w = new Worker('js/mp3-worker.js', { type: 'module' });
    this.w.postMessage({ type: 'start', sr: SR, kbps: 320 });
    this.pending = 0;
    this.waiters = [];
    this.w.onmessage = (e) => {
      const m = e.data;
      if (m.bytes) this.parts.push(m.bytes);
      if (m.type === 'out') { this.pending--; this.waiters.splice(0).forEach((f) => f()); }
      if (m.type === 'end') this.onEnd();
    };
    this.clipped = 0;
    this.max = 0;
  }
  async push(L, R) {
    const n = L.length;
    const l = new Int16Array(n), r = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      let a = L[i], b = R[i];
      const m = Math.max(Math.abs(a), Math.abs(b));
      if (m > this.max) this.max = m;
      if (a > 1 || a < -1) { a = a > 0 ? 1 : -1; this.clipped++; }
      if (b > 1 || b < -1) { b = b > 0 ? 1 : -1; this.clipped++; }
      l[i] = a * 32767; r[i] = b * 32767;
    }
    this.pending++;
    this.w.postMessage({ type: 'data', l, r }, [l.buffer, r.buffer]);
    while (this.pending > 4) await new Promise((ok) => this.waiters.push(ok));   // 인코더가 밀리면 잠깐 기다림
  }
  finish() {
    return new Promise((ok) => {
      this.onEnd = () => { this.w.terminate(); ok(new Blob(this.parts, { type: 'audio/mpeg' })); };
      this.w.postMessage({ type: 'end' });
    });
  }
}

// ---------- zip (압축 없이 묶기) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
async function crcOf(blob) {
  let c = 0xffffffff;
  const step = 8 << 20;
  for (let p = 0; p < blob.size; p += step) {
    const b = new Uint8Array(await blob.slice(p, p + step).arrayBuffer());
    for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export async function zip(files) {
  const enc = new TextEncoder();
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = await crcOf(f.blob);
    const size = f.blob.size;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x800, true); lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, f.blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x800, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), name);
    off += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ---------- SRT에서 가사 글만 ----------
export function srtText(srt) {
  return srt.replace(/\r/g, '').split(/\n\s*\n/).map((b) => b.split('\n').filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !l.includes('-->')).join('\n')).filter(Boolean).join('\n');
}

// ---------- 앨범아트: 긴 변 1000px JPEG로 ----------
export async function prepareArt(file) {
  const img = await createImageBitmap(file);
  const k = Math.min(1, 1000 / Math.max(img.width, img.height));
  const c = new OffscreenCanvas(Math.round(img.width * k), Math.round(img.height * k));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  return { mime: 'image/jpeg', bytes: new Uint8Array(await blob.arrayBuffer()), url: URL.createObjectURL(blob) };
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
}
