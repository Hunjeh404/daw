// 재생 엔진: 음원을 한 곡씩 풀어 폰 저장공간(OPFS)에 16비트로 담고,
// 재생 위치 앞쪽에 필요한 원본 블록만 조금씩 읽어 트랙별 프로세서로 보낸다.
// 편집은 원본을 건드리지 않고 클립(어느 음원의 어디를 타임라인 어디에 놓을지)만 바꾼다.
// 음원(sources)과 트랙은 따로다. 트랙은 여러 음원의 조각을 담을 수 있고, 빈 트랙도 있다.

import { buildTrackChain, applyTrack, buildMaster, applyMaster, trackDefaults, masterDefaults } from './mixgraph.js';
import { category } from './cats.js';
import { dbToLin } from './dsp.js';

export const SR = 44100;
export const BLOCK = 32768;      // 프레임 (약 0.74초)
export const PEAK = 1024;        // 파형 한 칸이 맡는 프레임 수
const AHEAD = 10 * SR;           // 약 10초 앞까지 미리 보냄
const TINY = 64;                 // 잘린 자리 딸깍 소리 방지용 짧은 페이드
const KEY = 65536;               // 블록 이름: 음원 번호 * KEY + 블록 번호

let clipSeq = 0;
export const newClipId = () => 'c' + (++clipSeq);

export class Engine {
  constructor() {
    this.ctx = null;
    this.tracks = [];
    this.playing = false;
    this.startPos = 0;
    this.startCtxFrame = 0;
    this.pausedPos = 0;
    this.loop = { on: false, start: 0, end: 0 };
    this.onEnd = null;
    this.mm = masterDefaults();
    this.mode = 'apply';         // apply | raw | ref
    this.sources = new Map();    // sid → { sid, idx, name, file, frames, ch, scale, peaks, missing }
    this.srcIdx = new Map();     // idx → source
    this.nextIdx = 1;
    this.ana = {};               // 자동 분석 결과 (음량 맞춤용)
    this.meter = null;
    this.prev = null;            // 내보내기 미리듣기 { a, b, fi, fo, off } (프레임) — 구간·페이드·포함 트랙대로 재생
  }

  async init() {
    if (this.ctx) return;
    await this.prepareStore();
    this.ctx = new AudioContext({ sampleRate: SR, latencyHint: 'playback' });
    await this.ctx.audioWorklet.addModule('js/track-worklet.js');
    await this.ctx.audioWorklet.addModule('js/fx-worklet.js');
    this.out = this.ctx.createGain();   // 미리듣기 페이드
    this.out.connect(this.ctx.destination);
    this.M = buildMaster(this.ctx, this.out);
    this.master = this.M.match;
    this.M.mfx.port.onmessage = (e) => { if (e.data.type === 'meter') this.meter = e.data; };
    this.applyAll();
    setInterval(() => this.feed(), 300);
  }

  // 탭마다 자기 폴더(s-<id>)를 쓰고, 그 탭이 열려 있는 동안 잠금을 쥔다.
  // 시작할 때는 잠금이 풀린(닫힌 탭의) 폴더만 지운다.
  prepareStore() {
    if (!this.storeReady) {
      this.storeReady = (async () => {
        const root = await navigator.storage.getDirectory();
        const sid = 's-' + crypto.randomUUID();
        await new Promise((ok) => navigator.locks.request('daw-' + sid, () => { ok(); return new Promise(() => {}); }));
        const held = new Set((await navigator.locks.query()).held.map((l) => l.name));
        const stale = [];
        for await (const [name, h] of root.entries()) {
          if (h.kind === 'directory' && name.startsWith('s-') && !held.has('daw-' + name)) stale.push(name);
          else if (h.kind === 'file' && name.endsWith('.pcm')) stale.push(name);
        }
        for (const name of stale) await root.removeEntry(name, { recursive: true }).catch(() => {});
        this.root = await root.getDirectoryHandle(sid, { create: true });
      })();
    }
    return this.storeReady;
  }

  get duration() {
    let d = 0;
    for (const t of this.tracks) for (const c of t.clips) d = Math.max(d, c.start + c.len);
    return d;
  }

  // 음원 하나를 풀어 저장 (트랙은 만들지 않음)
  async addSource(name, arrayBuffer) {
    const buf = await this.ctx.decodeAudioData(arrayBuffer);
    const ch = Math.min(buf.numberOfChannels, 2);
    const frames = buf.length;
    let peak = 0;
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < frames; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > peak) peak = a; }
    }
    const scale = peak > 1 ? peak : 1;
    const sid = crypto.randomUUID();
    const fh = await this.root.getFileHandle(sid + '.pcm', { create: true });
    const peaks = new Float32Array(Math.ceil(frames / PEAK));
    let w;
    try {
      w = await fh.createWritable();
      await this.writePcm(w, buf, ch, frames, peaks, scale);
    } catch (err) {
      try { await w?.abort(); } catch {}
      await this.root.removeEntry(sid + '.pcm').catch(() => {});
      throw err;
    }
    const src = { sid, idx: this.nextIdx++, name, frames, ch, scale, peaks, file: await fh.getFile(), fileId: sid, missing: false };
    this.sources.set(sid, src);
    this.srcIdx.set(src.idx, src);
    return src;
  }

  // 아직 음원이 없는 자리 (프로젝트에서 열었을 때)
  addMissingSource(info) {
    const src = { sid: info.sid, idx: this.nextIdx++, name: info.name, frames: info.frames, ch: info.ch, scale: info.scale || 1, peaks: null, file: null, missing: true };
    this.sources.set(src.sid, src);
    this.srcIdx.set(src.idx, src);
    return src;
  }

  // 빈 자리에 새로 푼 음원을 채운다 (새 음원 항목은 없앰)
  fillSource(hole, src) {
    Object.assign(hole, { file: src.file, peaks: src.peaks, scale: src.scale, fileId: src.fileId, missing: false });
    this.sources.delete(src.sid);
    this.srcIdx.delete(src.idx);
    for (const t of this.tracks) if (t.clips.some((c) => c.sid === hole.sid)) this.updateSegs(t);
  }

  async removeSource(src) {
    this.sources.delete(src.sid);
    this.srcIdx.delete(src.idx);
    if (src.fileId) await this.root.removeEntry(src.fileId + '.pcm').catch(() => {});
  }

  get missingSources() { return [...this.sources.values()].filter((s) => s.missing && this.tracks.some((t) => t.clips.some((c) => c.sid === s.sid))); }

  // 트랙 만들기 (처리 연결 포함). opts: { cat, color }
  makeTrack(name, opts = {}) {
    const node = new AudioWorkletNode(this.ctx, 'track-player', { numberOfInputs: 0, outputChannelCount: [2] });
    const fxc = buildTrackChain(this.ctx);
    node.connect(fxc.input);
    const toSum = this.ctx.createGain();
    const refGain = this.ctx.createGain();
    refGain.gain.value = 0;
    fxc.out.connect(toSum).connect(this.M.sum);
    fxc.send.connect(this.M.vin);
    fxc.trim.connect(refGain).connect(this.out);
    this.M.drumKey.connect(fxc.fx, 0, 1);
    const cat = opts.cat || category(name);
    if (cat === 'drums') toSum.connect(this.M.drumKey);
    if (cat === 'vocal') toSum.connect(this.M.vocalKey);
    const t = {
      id: opts.id || crypto.randomUUID(), name, color: opts.color,
      node, fxc, toSum, refGain, cat, sent: new Set(), mix: trackDefaults(),
      clips: [], xfade: true, volumeDb: 0, muted: false, solo: false, under: 0,
      segs: [],
    };
    node.port.onmessage = (e) => {
      if (e.data.type === 'tick') { t.under = e.data.under; this.feed(); }
    };
    this.tracks.push(t);
    return t;
  }

  // 음원 하나로 트랙 하나 (불러오기)
  async addTrack(name, arrayBuffer) {
    const src = await this.addSource(name, arrayBuffer);
    const t = this.makeTrack(name);
    t.home = src.sid;
    t.clips = [{ id: newClipId(), sid: src.sid, start: 0, src: 0, len: src.frames, fi: 0, fo: 0 }];
    this.updateSegs(t);
    this.applyAll();
    return t;
  }

  addEmptyTrack(name) {
    const t = this.makeTrack(name, { cat: 'other', color: '#7d8794' });
    this.updateSegs(t);
    this.applyAll();
    return t;
  }

  // 트랙이 쓰는 음원 정보 (분석·렌더용: 워커로도 보낼 수 있는 값만)
  srcView(t) {
    const srcs = {};
    for (const s of t.segs) { const src = this.sources.get(s.sid); if (src && !src.missing) srcs[s.sid] = { file: src.file, ch: src.ch, scale: src.scale }; }
    return { segs: t.segs, srcs };
  }

  async writePcm(w, buf, ch, frames, peaks, scale) {
    const k = 1 / scale;
    const L = buf.getChannelData(0);
    const R = ch === 2 ? buf.getChannelData(1) : null;
    for (let s = 0; s < frames; s += BLOCK) {
      const n = Math.min(BLOCK, frames - s);
      const out = new Int16Array(n * ch);
      for (let i = 0; i < n; i++) {
        const f = s + i;
        const l = L[f] * k;
        out[i * ch] = l * 32767;
        let a = l < 0 ? -l : l;
        if (R) {
          const r = R[f] * k;
          out[i * ch + 1] = r * 32767;
          const ar = r < 0 ? -r : r;
          if (ar > a) a = ar;
        }
        const pk = (f / PEAK) | 0;
        if (a > peaks[pk]) peaks[pk] = a;
      }
      await w.write(out);
    }
    await w.close();
  }

  // 클립 목록 → 실제 재생 구간. 나중에 시작하는 클립이 위에 놓인다.
  // 겹친 곳은 자동 크로스페이드가 켜져 있으면 서로 페이드로 넘기고, 꺼져 있으면 위 클립이 덮는다.
  buildSegs(t) {
    const clips = t.clips.map((c, i) => ({ c, i })).sort((a, b) => a.c.start - b.c.start || a.i - b.i).map((x) => x.c);
    let segs = [];
    for (const c of clips) {
      const b = { start: c.start, end: c.start + c.len, src: c.src, fi: c.fi, fo: c.fo, sid: c.sid };
      const next = [];
      for (const a of segs) {
        if (a.end <= b.start || a.start >= b.end) { next.push(a); continue; }
        if (t.xfade && b.start > a.start && b.end >= a.end) {
          const ov = a.end - b.start;
          next.push({ ...a, fo: Math.max(a.fo, ov) });
          b.fi = Math.max(b.fi, ov);
          continue;
        }
        if (a.start < b.start) next.push({ ...a, end: b.start, fo: Math.min(TINY, b.start - a.start) });
        if (a.end > b.end) {
          const cut = b.end - a.start;
          next.push({ start: b.end, end: a.end, src: a.src + cut, fi: TINY, fo: a.fo, sid: a.sid });
        }
      }
      next.push(b);
      segs = next;
    }
    for (const s of segs) {
      const len = s.end - s.start;
      s.fi = Math.min(s.fi, len);
      s.fo = Math.min(s.fo, len);
      const src = this.sources.get(s.sid);
      s.idx = src ? src.idx : 0; s.ch = src ? src.ch : 2; s.k = src ? src.scale : 1;
    }
    // 음원이 없는 조각은 소리 내지 않음
    return segs.filter((s) => s.end > s.start && this.sources.get(s.sid) && !this.sources.get(s.sid).missing);
  }

  updateSegs(t) {
    t.segs = this.buildSegs(t);
    t.node.port.postMessage({ type: 'segs', segs: t.segs });
    this.feed();
  }

  // 볼륨·음소거·솔로·처리 설정·비교 모드를 모두 반영
  applyAll() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const set = (param, v) => param.setTargetAtTime(v, now, 0.015);
    const raw = this.mode === 'raw', refMode = this.mode === 'ref';
    const live = this.tracks.filter((t) => !t.mix.ref);
    const anySolo = live.some((t) => t.solo);
    const P = this.prev;
    for (const t of this.tracks) {
      const on = P ? !P.off.has(t.id) : !t.muted && (!anySolo || t.solo || t.mix.ref);
      const isRef = t.mix.ref;
      set(t.fxc.fader.gain, on && !isRef ? (raw ? 1 : dbToLin(t.volumeDb)) : 0);
      set(t.toSum.gain, isRef ? 0 : 1);
      set(t.refGain.gain, refMode && isRef && on ? dbToLin(this.refMatchDb()) : 0);
      applyTrack(t.fxc, t.mix, raw || isRef, this.ctx, t.ana?.lufs ?? -20);
    }
    applyMaster(this.M, this.mm, raw, this.ctx, refMode ? -Infinity : raw ? this.rawMatchDb() : 0);
  }
  applyGains() { this.applyAll(); }
  get hasRef() { return this.tracks.some((t) => t.mix.ref); }
  rawMatchDb() { const a = this.ana; return a.procLufs != null && a.rawLufs != null ? a.procLufs - a.rawLufs : 0; }
  refMatchDb() { const a = this.ana; return a.procLufs != null && a.refLufs != null ? a.procLufs - a.refLufs : 0; }
  setMode(m) { this.mode = m; this.applyAll(); }

  get effLoop() { return this.prev ? { on: false, start: 0, end: 0 } : this.loop; }

  mapPos(raw) {
    const L = this.effLoop;
    if (L.on && this.startPos < L.end && raw >= L.end) return L.start + ((raw - L.end) % (L.end - L.start));
    return raw;
  }

  get position() {
    if (!this.playing) return this.pausedPos;
    return this.mapPos(this.startPos + Math.max(0, Math.round(this.ctx.currentTime * SR) - this.startCtxFrame));
  }

  // 지금부터 AHEAD 동안 재생될 타임라인 구간들 (구간 반복이면 처음으로 돌아간 부분까지)
  windows(pos, ahead) {
    const L = this.effLoop;
    if (L.on && this.startPos < L.end && pos < L.end && pos + ahead > L.end) {
      const rest = Math.min(pos + ahead - L.end, L.end - L.start);
      return [[pos, L.end], [L.start, L.start + rest]];
    }
    return [[pos, pos + ahead]];
  }

  neededBlocks(t, wins) {
    const need = new Set();
    for (const [a, b] of wins) {
      for (const s of t.segs) {
        const lo = Math.max(a, s.start), hi = Math.min(b, s.end);
        if (lo >= hi) continue;
        const s0 = s.src + (lo - s.start), s1 = s.src + (hi - s.start) - 1;
        for (let k = Math.floor(s0 / BLOCK); k <= Math.floor(s1 / BLOCK); k++) need.add(s.idx * KEY + k);
      }
    }
    return need;
  }

  async sendBlock(t, key) {
    if (t.sent.has(key)) return;
    const src = this.srcIdx.get(Math.floor(key / KEY));
    const b = key % KEY;
    if (!src || src.missing) return;
    const first = b * BLOCK;
    if (first >= src.frames || b < 0) return;
    t.sent.add(key);
    const n = Math.min(BLOCK, src.frames - first);
    const bytes = 2 * src.ch;
    const ab = await src.file.slice(first * bytes, (first + n) * bytes).arrayBuffer();
    if (!t.sent.has(key)) return; // 그새 정지·이동으로 필요 없어짐
    t.node.port.postMessage({ type: 'block', b: key, data: new Int16Array(ab) }, [ab]);
  }

  feed() {
    if (!this.playing) return;
    const pos = this.position;
    const P = this.prev;
    if (P && pos >= P.b) { this.stop(); this.pausedPos = P.a; this.onEnd && this.onEnd(); return; }
    if (!this.loop.on && pos >= this.duration) { this.stop(); this.pausedPos = 0; this.onEnd && this.onEnd(); return; }
    const wins = this.windows(Math.max(0, pos - BLOCK), AHEAD + BLOCK);
    for (const t of this.tracks) {
      const need = this.neededBlocks(t, wins);
      const drop = [];
      for (const b of t.sent) if (!need.has(b)) drop.push(b);
      if (drop.length) {
        for (const b of drop) t.sent.delete(b);
        t.node.port.postMessage({ type: 'drop', list: drop });
      }
      for (const b of need) this.sendBlock(t, b);
    }
  }

  async play() {
    if (this.playing || !this.tracks.length) return;
    await this.ctx.resume();
    let pos = this.pausedPos;
    const P = this.prev;
    if (P && (pos < P.a || pos >= P.b)) pos = P.a;
    if (!P && !this.loop.on && pos >= this.duration) pos = 0;
    this.startPos = pos;
    // 시작 직후 3초 분량은 모든 트랙에 확실히 넣어 둔다
    const wins = this.windows(pos, 3 * SR);
    await Promise.all(this.tracks.flatMap((t) => [...this.neededBlocks(t, wins)].map((b) => this.sendBlock(t, b))));
    const ctxFrame = Math.round((this.ctx.currentTime + 0.1) * SR);
    this.startCtxFrame = ctxFrame;
    const EL = this.effLoop;
    const loop = EL.on ? { start: EL.start, end: EL.end } : null;
    this.schedFade(pos, ctxFrame / SR);
    for (const t of this.tracks) t.node.port.postMessage({ type: 'play', ctxFrame, pos, loop });
    this.M.mfx.port.postMessage({ type: 'reset' });
    this.playing = true;
    this.feed();
  }

  stop() {
    if (!this.playing) return;
    this.pausedPos = this.position;
    this.playing = false;
    this.schedFade();
    for (const t of this.tracks) {
      t.node.port.postMessage({ type: 'stop' });
      t.node.port.postMessage({ type: 'clear' });
      t.sent.clear();
    }
  }

  // 미리듣기 페이드를 재생 시작 시각에 맞춰 미리 그려 둔다. 인자 없으면 원래대로(1)
  schedFade(pos, at) {
    const g = this.out.gain, now = this.ctx.currentTime;
    g.cancelScheduledValues(0);
    g.setValueAtTime(g.value, now);
    const P = this.prev;
    if (pos == null || !P) { g.setTargetAtTime(1, now, 0.01); return; }
    const STEP = SR / 200, n = Math.max(2, Math.ceil((P.b - pos) / STEP) + 1);
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f = pos + i * STEP;
      let v = 1;
      if (P.fi && f - P.a < P.fi) v *= Math.sin(Math.PI / 2 * Math.max(0, f - P.a) / P.fi);
      if (P.fo && P.b - f < P.fo) v *= Math.sin(Math.PI / 2 * Math.max(0, P.b - f) / P.fo);
      curve[i] = v;
    }
    const dur = (n - 1) * STEP / SR;
    g.setValueCurveAtTime(curve, at, dur);
    g.setValueAtTime(0, at + dur + 0.001);   // 끝 지점 뒤는 조용히 (정지 확인 전 잠깐 새는 소리 막기)
  }

  // 내보내기 탭: p = { a, b, fi, fo, off } (프레임) 또는 null
  async setPreview(p) {
    this.prev = p;
    if (!this.ctx) return;
    this.applyAll();
    if (this.playing) await this.seek(this.position);
  }

  async seek(frame) {
    const was = this.playing;
    this.stop();
    this.pausedPos = Math.max(0, Math.min(frame, this.duration));
    if (was) await this.play();
  }

  async setLoop(on, start, end) {
    this.loop = { on: on && end - start > SR / 10, start, end };
    if (this.playing) await this.seek(this.position);
  }

  // 트랙 하나 빼기 (연결 끊고, 아무 트랙도 안 쓰는 음원은 지움)
  // keep: 음원은 남긴다 (되돌리기·붙여넣기에서 아직 쓸 수 있으므로)
  async removeTrack(t, keep) {
    try { t.node.port.postMessage({ type: 'stop' }); } catch {}
    for (const n of [t.node, t.fxc.out, t.fxc.send, t.toSum, t.refGain]) { try { n.disconnect(); } catch {} }
    this.tracks = this.tracks.filter((x) => x !== t);
    if (!keep) await this.pruneSources();
    this.applyAll();
  }
  async pruneSources() {
    for (const src of [...this.sources.values()]) {
      if (!this.tracks.some((t) => t.clips.some((c) => c.sid === src.sid))) await this.removeSource(src);
    }
  }

  // 모두 비우기 (새 프로젝트, 프로젝트 열기 전)
  async clearAll() {
    this.stop();
    for (const t of [...this.tracks]) await this.removeTrack(t);
    for (const src of [...this.sources.values()]) await this.removeSource(src);
    this.mm = masterDefaults();
    this.mode = 'apply';
    this.ana = {};
    this.loop = { on: false, start: 0, end: 0 };
    this.pausedPos = 0;
    this.applyAll();
  }

  async storedBytes() {
    const est = await navigator.storage.estimate();
    return est.usage || 0;
  }
}
