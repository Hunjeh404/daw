// 미디 파일(SMF) 읽기: 템포 변화를 그대로 따라 음마다 시작·길이(초)를 구한다.
export function parseMidi(bytes) {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (p, n) => String.fromCharCode(...bytes.subarray(p, p + n));
  if (str(0, 4) !== 'MThd') throw new Error('미디 파일이 아닙니다');
  const ntrk = d.getUint16(10), div = d.getUint16(12);
  if (div & 0x8000) throw new Error('SMPTE 시간 단위 미디는 지원하지 않습니다');
  let p = 8 + d.getUint32(4);
  const tempos = [], raw = [], names = [], programs = [];
  for (let k = 0; k < ntrk && p + 8 <= bytes.length; k++) {
    const len = d.getUint32(p + 4), end = p + 8 + len;
    if (str(p, 4) !== 'MTrk') { p = end; continue; }
    p += 8;
    let tick = 0, status = 0;
    const vlq = () => { let v = 0, b; do { b = bytes[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && p < end); return v; };
    while (p < end) {
      tick += vlq();
      let s = bytes[p];
      if (s & 0x80) p++; else s = status;      // 이어지는 상태 바이트
      if (s === 0xff) {
        const type = bytes[p++], n = vlq();
        if (type === 0x51) tempos.push({ tick, us: (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2] });
        if (type === 0x03) names.push(new TextDecoder().decode(bytes.subarray(p, p + n)));
        p += n;
      } else if (s === 0xf0 || s === 0xf7) {
        p += vlq();
      } else {
        status = s;
        const hi = s & 0xf0, ch = s & 0x0f;
        const a = bytes[p++];
        const b = hi === 0xc0 || hi === 0xd0 ? 0 : bytes[p++];
        if (hi === 0x90 || hi === 0x80) raw.push({ tick, ch, note: a, vel: hi === 0x90 ? b : 0 });
        else if (hi === 0xc0) programs.push({ ch, prog: a });
      }
    }
    p = end;
  }
  // 틱 → 초 (템포 맵)
  tempos.sort((x, y) => x.tick - y.tick);
  const map = [{ tick: 0, sec: 0, us: 500000 }];
  for (const t of tempos) {
    const m = map[map.length - 1];
    const sec = m.sec + (t.tick - m.tick) * m.us / div / 1e6;
    if (t.tick === m.tick) m.us = t.us; else map.push({ tick: t.tick, sec, us: t.us });
  }
  let mi = 0;
  const toSec = (tick) => {
    while (mi + 1 < map.length && map[mi + 1].tick <= tick) mi++;
    while (mi > 0 && map[mi].tick > tick) mi--;
    const m = map[mi];
    return m.sec + (tick - m.tick) * m.us / div / 1e6;
  };
  // 켜기·끄기 짝 맞추기 (같은 채널·음은 먼저 켠 것부터)
  raw.sort((x, y) => x.tick - y.tick || x.vel - y.vel);
  const open = new Map(), notes = [];
  for (const e of raw) {
    const key = e.ch * 128 + e.note;
    if (e.vel > 0) {
      const n = { t: toSec(e.tick), end: null, note: e.note, vel: e.vel, ch: e.ch };
      notes.push(n);
      if (!open.has(key)) open.set(key, []);
      open.get(key).push(n);
    } else {
      const q = open.get(key);
      const n = q && q.shift();
      if (n) n.end = toSec(e.tick);
    }
  }
  for (const n of notes) if (n.end == null || n.end <= n.t) n.end = n.t + 0.25;
  notes.sort((x, y) => x.t - y.t);
  return { notes, names, programs };
}

// 드럼인지 베이스인지: 파일 이름 → 10번 채널 → 악기 번호(32~39 베이스)
export function midiKind(fileName, m) {
  if (/drum|perc|드럼|퍼커/i.test(fileName)) return 'drums';
  if (/bass|베이스/i.test(fileName)) return 'bass';
  if (m.notes.length && m.notes.every((n) => n.ch === 9)) return 'drums';
  if (m.programs.some((x) => x.ch !== 9 && x.prog >= 32 && x.prog <= 39)) return 'bass';
  return null;
}

// 같은 음이 아주 짧은 간격(기본 15ms)으로 다시 나오면 뒤의 것을 지운다
export function dropDoubles(notes, gap = 0.015) {
  const last = new Map(), out = [];
  let dropped = 0;
  for (const n of notes) {
    const prev = last.get(n.note);
    if (prev != null && n.t - prev < gap) { dropped++; continue; }
    last.set(n.note, n.t);
    out.push(n);
  }
  return { notes: out, dropped };
}
