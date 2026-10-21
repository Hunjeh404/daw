// 압축 파일을 통째로 읽지 않고, 목록만 읽은 뒤 필요한 항목만 하나씩 꺼낸다.

async function view(file, start, end) {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

function decodeName(bytes, utf8) {
  if (utf8) return new TextDecoder('utf-8').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('euc-kr').decode(bytes); }
}

export async function listZip(file) {
  const tailLen = Math.min(file.size, 65557);
  const tailStart = file.size - tailLen;
  const tail = await view(file, tailStart, file.size);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('압축 파일 형식이 아닙니다');
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOff = tail.getUint32(eocd + 16, true);
  if (cdOff === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) throw new Error('압축 파일 목록을 읽지 못했습니다');
    const z64 = Number(tail.getBigUint64(loc + 8, true));
    const z = await view(file, z64, z64 + 56);
    count = Number(z.getBigUint64(32, true));
    cdSize = Number(z.getBigUint64(40, true));
    cdOff = Number(z.getBigUint64(48, true));
  }
  const cd = await view(file, cdOff, cdOff + cdSize);
  const entries = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    let compSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let localOff = cd.getUint32(p + 42, true);
    const name = decodeName(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen), flags & 0x800);
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cd.getUint16(e, true), len = cd.getUint16(e + 2, true);
      if (id === 1) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(cd.getBigUint64(q, true)); q += 8; }
        if (compSize === 0xffffffff) { compSize = Number(cd.getBigUint64(q, true)); q += 8; }
        if (localOff === 0xffffffff) { localOff = Number(cd.getBigUint64(q, true)); }
      }
      e += 4 + len;
    }
    entries.push({ name, method, compSize, size, localOff });
    p = eEnd + commentLen;
  }
  return entries;
}

export async function readEntry(file, entry) {
  const h = await view(file, entry.localOff, entry.localOff + 30);
  const start = entry.localOff + 30 + h.getUint16(26, true) + h.getUint16(28, true);
  const blob = file.slice(start, start + entry.compSize);
  if (entry.method === 0) return blob.arrayBuffer();
  if (entry.method === 8) {
    return new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
  }
  throw new Error('지원하지 않는 압축 방식: ' + entry.name);
}
