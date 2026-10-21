// 프로젝트: 음원은 빼고 작업 결과만 저장한다. 앱 안(IndexedDB) 목록과 .json 파일 둘 다.
// v2: 음원 목록(sources)과 트랙(클립마다 어느 음원인지)을 따로 저장. v1(트랙 하나 = 음원 하나)도 열 수 있다.
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

function trackState(t) {
  const ana = t.ana ? { ...t.ana } : null;
  if (ana) delete ana.blocks;
  return {
    id: t.id, name: t.name, color: t.color, cat: t.cat, home: t.home || null,
    clips: t.clips.map((c) => ({ ...c })), xfade: t.xfade, volumeDb: t.volumeDb, muted: t.muted, solo: t.solo,
    mix: structuredClone(t.mix), ana,
  };
}

export function serialize(E, name, id) {
  const meta = E.meta || {};
  const exp = E.exp || {};
  const used = new Set(E.tracks.flatMap((t) => t.clips.map((c) => c.sid)));
  return {
    app: 'DAW4', v: 2, id, name, savedAt: Date.now(),
    sources: [...E.sources.values()].filter((s) => used.has(s.sid)).map((s) => ({ sid: s.sid, name: s.name, frames: s.frames, ch: s.ch, scale: s.scale })),
    tracks: E.tracks.map(trackState),
    mm: structuredClone(E.mm), mode: E.mode, loop: { ...E.loop },
    ana: { rawLufs: E.ana.rawLufs ?? null, procLufs: E.ana.procLufs ?? null, refLufs: E.ana.refLufs ?? null, hasFit: !!E.ana.hasFit },
    exp: { scope: exp.scope, fmt: exp.fmt, bits: exp.bits, off: [...(exp.off || [])], a: exp.a, b: exp.b, fi: exp.fi, fo: exp.fo },
    meta: {
      title: meta.title || '', artist: meta.artist || '', lyrics: meta.lyrics || '', srt: meta.srt || null, srtName: meta.srtName || '', saveSrt: meta.saveSrt !== false,
      art: meta.art ? { mime: meta.art.mime, b64: b64(meta.art.bytes) } : null,
    },
  };
}

// v1(트랙마다 자기 음원 하나)을 v2 모양으로
function upgrade(p) {
  if (p.v >= 2) return p;
  return {
    ...p, v: 2,
    sources: p.tracks.map((t) => ({ sid: t.id, name: t.name, frames: t.frames, ch: t.ch, scale: t.scale })),
    tracks: [...p.tracks].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0)).map((t) => ({ ...t, home: t.id, clips: t.clips.map((c) => ({ ...c, sid: t.id })) })),
  };
}

// 저장된 값을 엔진에 넣는다. 트랙은 모두 만들고, 음원은 모두 "아직 없음"으로
export function applyProject(E, p0) {
  const p = upgrade(p0);
  for (const s of p.sources) E.addMissingSource(s);
  for (const st of p.tracks) {
    const t = E.makeTrack(st.name, { id: st.id, cat: st.cat, color: st.color });
    Object.assign(t, {
      home: st.home, clips: st.clips.map((c) => ({ ...c })), xfade: st.xfade, volumeDb: st.volumeDb, muted: st.muted, solo: st.solo,
      mix: { ...t.mix, ...structuredClone(st.mix) }, ana: st.ana,
    });
    E.updateSegs(t);
  }
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
  E.applyAll();
}

// 새로 푼 음원 src를 채울 빈 자리 (길이·채널이 같고, 이름이 같으면 우선). 없으면 null
export function matchSource(E, src) {
  const holes = [...E.sources.values()].filter((s) => s.missing && s.frames === src.frames && s.ch === src.ch);
  if (!holes.length) return null;
  return holes.find((s) => s.name === src.name) || holes[0];
}

export function parseProjectFile(text) {
  const p = JSON.parse(text);
  if (p.app !== 'DAW4' || !Array.isArray(p.tracks)) throw new Error('DAW 4 Hoon-jay 프로젝트 파일이 아닙니다');
  return p;
}
