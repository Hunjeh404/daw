// 프로젝트: 음원은 빼고 작업 결과만 저장한다. 앱 안(IndexedDB) 목록과 .json 파일 둘 다.
const DB = 'daw4', STORE = 'projects';

function db() {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((ok, fail) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { ok(req && req.result); d.close(); };
    t.onerror = () => { fail(t.error); d.close(); };
  });
}
export const listProjects = async () => ((await tx('readonly', (s) => s.getAll())) || [])
  .map((p) => ({ id: p.id, name: p.name, savedAt: p.savedAt, n: p.tracks.length }))
  .sort((a, b) => b.savedAt - a.savedAt);
export const getProject = (id) => tx('readonly', (s) => s.get(id));
export const putProject = (p) => tx('readwrite', (s) => s.put(p));
export const deleteProject = (id) => tx('readwrite', (s) => s.delete(id));

const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// 트랙 상태 (음원 빼고)
function trackState(t, slot) {
  const ana = t.ana ? { ...t.ana } : null;
  if (ana) delete ana.blocks;
  return {
    id: t.id, name: t.name, slot, frames: t.frames, ch: t.ch, scale: t.scale, color: t.color, cat: t.cat,
    clips: t.clips.map((c) => ({ ...c })), xfade: t.xfade, volumeDb: t.volumeDb, muted: t.muted, solo: t.solo,
    mix: structuredClone(t.mix), ana,
  };
}

// 화면 순서: 트랙마다 slot(저장 때 자리), 새로 들어온 트랙은 뒤로
export function ordered(E) {
  const all = [...E.tracks.map((t, i) => ({ t, k: t.slot ?? 1000 + i })), ...E.missing.map((m) => ({ t: m, k: m.slot }))];
  return all.sort((a, b) => a.k - b.k).map((x) => x.t);
}

export function serialize(E, name, id) {
  const meta = E.meta || {};
  const exp = E.exp || {};
  return {
    app: 'DAW4', v: 1, id, name, savedAt: Date.now(),
    tracks: ordered(E).map((t, i) => (E.missing.includes(t) ? { ...t, slot: i } : trackState(t, i))),
    mm: structuredClone(E.mm), mode: E.mode, loop: { ...E.loop },
    ana: { rawLufs: E.ana.rawLufs ?? null, procLufs: E.ana.procLufs ?? null, refLufs: E.ana.refLufs ?? null, hasFit: !!E.ana.hasFit },
    exp: { scope: exp.scope, fmt: exp.fmt, bits: exp.bits, off: [...(exp.off || [])], a: exp.a, b: exp.b, fi: exp.fi, fo: exp.fo },
    meta: {
      title: meta.title || '', artist: meta.artist || '', lyrics: meta.lyrics || '', srt: meta.srt || null, srtName: meta.srtName || '', saveSrt: meta.saveSrt !== false,
      art: meta.art ? { mime: meta.art.mime, b64: b64(meta.art.bytes) } : null,
    },
  };
}

// 저장된 값을 엔진에 넣는다 (트랙은 모두 음원 없는 자리로)
export function applyProject(E, p) {
  E.missing = p.tracks.map((t) => ({ ...t }));
  Object.assign(E.mm, structuredClone(p.mm));
  E.mode = p.mode === 'ref' && !p.tracks.some((t) => t.mix.ref) ? 'apply' : p.mode || 'apply';
  E.loop = { ...p.loop };
  E.ana = { ...p.ana };
  if (E.exp) Object.assign(E.exp, { ...p.exp, off: new Set(p.exp.off || []), b: p.exp.b ?? null });
  if (E.meta) {
    const m = p.meta || {};
    let art = null;
    if (m.art) { const bytes = unb64(m.art.b64); art = { mime: m.art.mime, bytes, url: URL.createObjectURL(new Blob([bytes], { type: m.art.mime })) }; }
    Object.assign(E.meta, { title: m.title || '', artist: m.artist || '', lyrics: m.lyrics || '', srt: m.srt || null, srtName: m.srtName || '', saveSrt: m.saveSrt !== false, art });
  }
}

// 새로 풀어 둔 트랙 t를 음원 없는 자리 중 하나에 맞춘다. 맞는 자리가 없으면 null
export function matchMissing(E, t) {
  const same = E.missing.filter((m) => m.frames === t.frames && m.ch === t.ch);
  if (!same.length) return null;
  return same.find((m) => m.name === t.name) || same[0];
}

// 맞춘 자리의 저장값을 트랙에 입힌다
export function adopt(E, t, m) {
  Object.assign(t, {
    id: m.id, name: m.name, slot: m.slot, color: m.color, cat: m.cat,
    clips: m.clips.map((c) => ({ ...c })), xfade: m.xfade, volumeDb: m.volumeDb, muted: m.muted, solo: m.solo,
    mix: structuredClone(m.mix), ana: m.ana,
  });
  E.missing = E.missing.filter((x) => x !== m);
  E.updateSegs(t);
}

export function parseProjectFile(text) {
  const p = JSON.parse(text);
  if (p.app !== 'DAW4' || !Array.isArray(p.tracks)) throw new Error('DAW 4 Hoon-jay 프로젝트 파일이 아닙니다');
  return p;
}
