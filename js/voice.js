// 목소리 서버(vocal-studio, Modal GPU): 보컬 트랙 잔향 제거와 목소리 변환.
// 잔향 제거는 보컬·백보컬 트랙이 젖어 있을 때 자동으로 돌고, 음원 자리는 그대로 둔 채 소리만 바꾼다.
// 결과는 프로젝트에 저장하지 않는다. 프로젝트를 열고 음원을 연결하면 다시 돌린다.
// 목소리 변환 트랙은 어떤 보컬을 어떤 모델로 바꿨는지만 저장하고, 열 때 다시 만든다.
import { SR, newClipId } from './engine.js';
import { readWindow } from './pcm.js';
import { Stats } from './stats.js';
import { colorFor } from './cats.js';

// 50ms 크기 분포 폭(dB). analysis.js의 젖음(14)·마름(24) 기준 사이에서 이보다 좁으면 잔향을 뺀다
const WET_SPREAD = 19;
const POLL_MS = 3000, JOB_LIMIT_MS = 25 * 60 * 1000;
const WIN = SR * 10;

const store = (key, v) => { try { if (v === undefined) return localStorage.getItem(key) || ''; localStorage.setItem(key, v); } catch { return ''; } };
export const server = {
  get url() { return store('daw-voice-url'); },
  set url(v) { store('daw-voice-url', v.trim().replace(/\/+$/, '')); },
  get pin() { return store('daw-voice-pin'); },
  set pin(v) { store('daw-voice-pin', v.trim()); },
};

// 음원 객체별 상태 { state: 'off'|'measure'|'run'|'done'|'dry'|'err', msg }
const status = new WeakMap();
export const statusOf = (src) => (src && status.get(src)) || null;
const isVocal = (t) => t.cat === 'vocal' || t.cat === 'backing';
export const trackSource = (E, t) => (t.home ? E.sources.get(E.versionSid(t.home)) : null);
export const canDereverb = (E, t) => !E.guided && isVocal(t) && !t.mix.ref && !trackSource(E, t)?.vc;

async function api(path, init = {}) {
  if (!server.url) throw new Error('목소리 서버 주소가 없습니다.');
  let res;
  try { res = await fetch(server.url + path, { ...init, headers: { ...(init.headers || {}), 'X-App-Pin': server.pin } }); }
  catch { throw new Error('서버에 닿지 않습니다. 주소와 인터넷 연결을 확인하세요.'); }
  if (res.status === 401) throw new Error('PIN이 틀렸습니다.');
  if (!res.ok) {
    let msg = '';
    try { const j = await res.json(); msg = j.detail || j.message || ''; } catch {}
    throw new Error(msg || `서버 오류 (${res.status})`);
  }
  return res;
}

export async function listModels() {
  return (await (await api('/api/models')).json()).models || [];
}
export async function uploadModel(name, pth, index) {
  const fd = new FormData();
  fd.append('model_name', name);
  fd.append('pth_file', pth);
  if (index) fd.append('index_file', index);
  return (await (await api('/api/models/upload', { method: 'POST', body: fd })).json()).model;
}
export async function deleteModel(name) {
  await api('/api/models/' + encodeURIComponent(name), { method: 'DELETE' });
}

const wholeView = (src) => ({
  segs: [{ start: 0, end: src.frames, src: 0, fi: 0, fo: 0, sid: src.sid }],
  srcs: { [src.sid]: { file: src.file, ch: src.ch, scale: src.scale, float: !!src.float } },
});

// 잔향 정도 (analyze-worker와 같은 Stats.spread). 클수록 마른 소리
async function spreadOf(src) {
  const v = wholeView(src), st = new Stats();
  for (let w0 = 0; w0 < src.frames; w0 += WIN) {
    const [L, R] = await readWindow(v, w0, Math.min(src.frames, w0 + WIN));
    st.push(L, R, 1);
  }
  return st.result().spread;
}

// 음원을 16비트 WAV로. 0dB를 넘는 음원은 줄여 보내고 받은 뒤 되돌린다
async function toWav(src) {
  let peak = 0;
  for (const p of src.peaks) if (p > peak) peak = p;
  peak *= src.float ? 1 : src.scale;
  const gain = peak > 0.999 ? 0.999 / peak : 1;
  const ch = src.ch, n = src.frames, bytes = n * ch * 2;
  const buf = new ArrayBuffer(44 + bytes), dv = new DataView(buf);
  const text = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); text(8, 'WAVE'); text(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
  text(36, 'data'); dv.setUint32(40, bytes, true);
  const pcm = new Int16Array(buf, 44), v = wholeView(src);
  for (let w0 = 0; w0 < n; w0 += WIN) {
    const [L, R] = await readWindow(v, w0, Math.min(n, w0 + WIN));
    for (let i = 0; i < L.length; i++) {
      const o = (w0 + i) * ch;
      pcm[o] = Math.max(-32768, Math.min(32767, Math.round(L[i] * gain * 32767)));
      if (ch === 2) pcm[o + 1] = Math.max(-32768, Math.min(32767, Math.round(R[i] * gain * 32767)));
    }
  }
  return { blob: new Blob([buf], { type: 'audio/wav' }), gain };
}

async function runJob(path, src, fields, onMsg) {
  const { blob, gain } = await toWav(src);
  const fd = new FormData();
  fd.append('file', blob, 'track.wav');
  for (const [k, v] of Object.entries(fields || {})) fd.append(k, String(v));
  onMsg('서버로 보내는 중');
  const { job_id } = await (await api(path, { method: 'POST', body: fd })).json();
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const j = await (await api('/api/jobs/' + job_id)).json();
    if (j.status === 'done') break;
    if (j.status === 'failed') throw new Error(j.message || '서버 작업이 실패했습니다.');
    if (Date.now() - t0 > JOB_LIMIT_MS) throw new Error('서버 응답이 너무 오래 걸립니다.');
    onMsg(j.message || '서버에서 처리 중');
  }
  onMsg('결과 받는 중');
  const out = await (await api(`/api/jobs/${job_id}/audio`)).blob();
  return { out, gain };
}

// 받은 WAV를 원래 음원과 같은 길이·채널로 맞춘 AudioBuffer로
async function fitBuffer(E, blob, src, gain) {
  const dec = await E.ctx.decodeAudioData(await blob.arrayBuffer());
  const buf = E.ctx.createBuffer(src.ch, src.frames, SR);
  const k = 1 / gain;
  for (let c = 0; c < src.ch; c++) {
    const from = dec.getChannelData(Math.min(c, dec.numberOfChannels - 1)), to = buf.getChannelData(c);
    const n = Math.min(from.length, to.length);
    for (let i = 0; i < n; i++) to[i] = from[i] * k;
  }
  return buf;
}

// 음원 자리(sid)는 그대로 두고 소리만 바꾼다. idx를 새로 줘서 재생기에 남은 옛 블록을 쓰지 않게 한다
const SOUND = ['file', 'peaks', 'scale', 'fileId', 'float', 'idx'];
function useSound(E, src, sound) {
  E.srcIdx.delete(src.idx);
  for (const k of SOUND) src[k] = sound[k];
  E.srcIdx.set(src.idx, src);
  for (const t of E.tracks) if (t.clips.some((c) => E.versionSid(c.sid) === src.sid)) E.updateSegs(t);
}
const pick = (s) => Object.fromEntries(SOUND.map((k) => [k, s[k]]));

// 잔향 제거 켬/끔 (끄면 원래 소리)
export function setDry(E, src, on) {
  if (!src?.sounds || src.dryOn === on) return;
  src.dryOn = on;
  useSound(E, src, on ? src.sounds.dry : src.sounds.wet);
}

let running = null;
// 보컬 트랙을 훑어 젖은 것만 잔향을 뺀다. 그다음 저장된 목소리 변환 트랙을 다시 만든다
export function autoVoice(E, changed) {
  if (running) { running.again = true; return running.p; }
  const job = { again: false };
  job.p = (async () => {
    do {
      job.again = false;
      for (const t of E.tracks.filter((x) => canDereverb(E, x))) {
        const src = trackSource(E, t);
        if (!src || src.missing || src.sounds) continue;
        const s = status.get(src);
        if (s && s.state !== 'off') continue;
        if (!server.url) { status.set(src, { state: 'off', msg: '목소리 서버 주소를 넣으면 자동으로 잔향을 뺍니다.' }); changed(); continue; }
        await dereverb(E, src, changed);
      }
      for (const hole of [...E.sources.values()].filter((s) => s.vc && s.missing)) {
        const from = E.sources.get(E.versionSid(hole.vc.from));
        if (!from || from.missing || ['measure', 'run'].includes(status.get(from)?.state)) continue;
        const s = status.get(hole);
        if (s && s.state !== 'off') continue;
        if (!server.url) { status.set(hole, { state: 'off', msg: '목소리 서버 주소를 넣으면 다시 만듭니다.' }); changed(); continue; }
        await remakeVoice(E, hole, from, changed);
      }
    } while (job.again);
  })().finally(() => { running = null; });
  running = job;
  return job.p;
}

// 실패했거나 서버 주소를 새로 넣었을 때 다시 시도
export function retryVoice(E, changed) {
  for (const src of E.sources.values()) {
    const s = status.get(src);
    if (s && (s.state === 'err' || s.state === 'off')) status.delete(src);
  }
  return autoVoice(E, changed);
}

async function dereverb(E, src, changed) {
  const say = (state, msg) => { status.set(src, { state, msg }); changed(); };
  try {
    say('measure', '잔향 정도를 재는 중');
    const sp = await spreadOf(src);
    if (sp == null || sp >= WET_SPREAD) { say('dry', '잔향이 적어 그대로 둡니다.'); return; }
    say('run', '잔향 제거 준비 중');
    const { out, gain } = await runJob('/api/dereverb', src, null, (m) => say('run', m));
    if (src.missing || !E.sources.has(src.sid)) return;          // 그사이 새 프로젝트
    const fresh = await E.addBuffer(src.name, await fitBuffer(E, out, src, gain));
    E.sources.delete(fresh.sid);
    src.sounds = { wet: pick(src), dry: pick(fresh) };
    src.dryOn = true;
    useSound(E, src, src.sounds.dry);
    say('done', '잔향을 뺐습니다.');
  } catch (err) {
    say('err', err.message);
  }
}

async function remakeVoice(E, hole, from, changed) {
  const say = (state, msg) => { status.set(hole, { state, msg }); changed(); };
  try {
    say('run', '목소리 다시 만드는 중');
    const { out, gain } = await runJob('/api/convert', from, convertFields(hole.vc), (m) => say('run', m));
    if (!E.sources.has(hole.sid)) return;
    const buf = await fitBuffer(E, out, hole, gain);
    E.fillSource(hole, await E.addBuffer(hole.name, buf, { vc: hole.vc }));
    say('done', '');
  } catch (err) {
    say('err', err.message);
  }
}

const convertFields = (vc) => ({ model_name: vc.model, pitch_shift: vc.pitch });

// 보컬 트랙 t를 목소리 모델로 바꿔 새 트랙으로 넣는다. 원래 트랙은 음소거
export async function convertTrack(E, t, model, pitch, onMsg) {
  const src = trackSource(E, t);
  if (!src || src.missing) throw new Error('이 트랙의 음원이 연결되지 않았습니다.');
  const vc = { from: t.home, model, pitch };
  const { out, gain } = await runJob('/api/convert', src, convertFields(vc), onMsg);
  const name = `${t.name} · ${model}`;
  const fresh = await E.addBuffer(name, await fitBuffer(E, out, src, gain), { vc });
  const nt = E.makeTrack(name, { cat: t.cat, color: t.color || colorFor(t.name) });
  nt.home = fresh.sid;
  nt.clips = t.clips.filter((c) => c.sid === t.home).map((c) => ({ ...c, id: newClipId(), sid: fresh.sid }));
  nt.volumeDb = t.volumeDb;
  nt.mix = structuredClone(t.mix);
  t.muted = true;
  E.updateSegs(nt);
  E.applyAll();
  return nt;
}
