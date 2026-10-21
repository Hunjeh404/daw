// 재생 엔진: 음원을 한 곡씩 풀어 폰 저장공간(OPFS)에 16비트로 담고,
// 재생 위치 앞쪽에 필요한 원본 블록만 조금씩 읽어 트랙별 프로세서로 보낸다.
// 편집은 원본을 건드리지 않고 클립(원본의 어디를 타임라인 어디에 놓을지)만 바꾼다.

export const SR = 44100;
export const BLOCK = 32768;      // 프레임 (약 0.74초)
export const PEAK = 1024;        // 파형 한 칸이 맡는 프레임 수
const AHEAD = 10 * SR;           // 약 10초 앞까지 미리 보냄
const TINY = 64;                 // 잘린 자리 딸깍 소리 방지용 짧은 페이드

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
  }

  async init() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ sampleRate: SR, latencyHint: 'playback' });
    await this.ctx.audioWorklet.addModule('js/track-worklet.js');
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.root = await navigator.storage.getDirectory();
    setInterval(() => this.feed(), 300);
  }

  // 이전 세션이 남긴 임시 음원 정리
  async clearStore() {
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) {
      if (name.endsWith('.pcm')) await root.removeEntry(name).catch(() => {});
    }
  }

  get duration() {
    let d = 0;
    for (const t of this.tracks) for (const c of t.clips) d = Math.max(d, c.start + c.len);
    return d;
  }

  async addTrack(name, arrayBuffer) {
    const buf = await this.ctx.decodeAudioData(arrayBuffer);
    const ch = Math.min(buf.numberOfChannels, 2);
    const frames = buf.length;
    const id = crypto.randomUUID();
    const fh = await this.root.getFileHandle(id + '.pcm', { create: true });
    const peaks = new Float32Array(Math.ceil(frames / PEAK));
    let w;
    try {
      w = await fh.createWritable();
      await this.writePcm(w, buf, ch, frames, peaks);
    } catch (err) {
      try { await w?.abort(); } catch {}
      await this.root.removeEntry(id + '.pcm').catch(() => {});
      throw err;
    }

    const node = new AudioWorkletNode(this.ctx, 'track-player', {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: { channels: ch },
    });
    const gain = this.ctx.createGain();
    node.connect(gain).connect(this.master);
    const t = {
      id, name, frames, ch, peaks,
      file: await fh.getFile(),
      node, gain, sent: new Set(),
      clips: [{ id: newClipId(), start: 0, src: 0, len: frames, fi: 0, fo: 0 }],
      xfade: true, volumeDb: 0, muted: false, solo: false, under: 0,
      segs: [],
    };
    node.port.onmessage = (e) => {
      if (e.data.type === 'tick') { t.under = e.data.under; this.feed(); }
    };
    this.tracks.push(t);
    this.updateSegs(t);
    return t;
  }

  async writePcm(w, buf, ch, frames, peaks) {
    const L = buf.getChannelData(0);
    const R = ch === 2 ? buf.getChannelData(1) : null;
    for (let s = 0; s < frames; s += BLOCK) {
      const n = Math.min(BLOCK, frames - s);
      const out = new Int16Array(n * ch);
      for (let i = 0; i < n; i++) {
        const f = s + i;
        let l = L[f];
        l = l > 1 ? 1 : l < -1 ? -1 : l;
        out[i * ch] = l * 32767;
        let a = l < 0 ? -l : l;
        if (R) {
          let r = R[f];
          r = r > 1 ? 1 : r < -1 ? -1 : r;
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
      const b = { start: c.start, end: c.start + c.len, src: c.src, fi: c.fi, fo: c.fo };
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
          next.push({ start: b.end, end: a.end, src: a.src + cut, fi: TINY, fo: a.fo });
        }
      }
      next.push(b);
      segs = next;
    }
    for (const s of segs) {
      const len = s.end - s.start;
      s.fi = Math.min(s.fi, len);
      s.fo = Math.min(s.fo, len);
    }
    return segs.filter((s) => s.end > s.start);
  }

  updateSegs(t) {
    t.segs = this.buildSegs(t);
    t.node.port.postMessage({ type: 'segs', segs: t.segs });
    this.feed();
  }

  applyGains() {
    const anySolo = this.tracks.some((t) => t.solo);
    for (const t of this.tracks) {
      const on = !t.muted && (!anySolo || t.solo);
      const g = on ? Math.pow(10, t.volumeDb / 20) : 0;
      t.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01);
    }
  }

  mapPos(raw) {
    const L = this.loop;
    if (L.on && this.startPos < L.end && raw >= L.end) return L.start + ((raw - L.end) % (L.end - L.start));
    return raw;
  }

  get position() {
    if (!this.playing) return this.pausedPos;
    return this.mapPos(this.startPos + Math.max(0, Math.round(this.ctx.currentTime * SR) - this.startCtxFrame));
  }

  // 지금부터 AHEAD 동안 재생될 타임라인 구간들 (구간 반복이면 처음으로 돌아간 부분까지)
  windows(pos, ahead) {
    const L = this.loop;
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
        for (let k = Math.floor(s0 / BLOCK); k <= Math.floor(s1 / BLOCK); k++) need.add(k);
      }
    }
    return need;
  }

  async sendBlock(t, b) {
    if (t.sent.has(b)) return;
    const first = b * BLOCK;
    if (first >= t.frames || b < 0) return;
    t.sent.add(b);
    const n = Math.min(BLOCK, t.frames - first);
    const bytes = 2 * t.ch;
    const ab = await t.file.slice(first * bytes, (first + n) * bytes).arrayBuffer();
    if (!t.sent.has(b)) return; // 그새 정지·이동으로 필요 없어짐
    t.node.port.postMessage({ type: 'block', b, data: new Int16Array(ab) }, [ab]);
  }

  feed() {
    if (!this.playing) return;
    const pos = this.position;
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
    if (!this.loop.on && pos >= this.duration) pos = 0;
    this.startPos = pos;
    // 시작 직후 3초 분량은 모든 트랙에 확실히 넣어 둔다
    const wins = this.windows(pos, 3 * SR);
    await Promise.all(this.tracks.flatMap((t) => [...this.neededBlocks(t, wins)].map((b) => this.sendBlock(t, b))));
    const ctxFrame = Math.round((this.ctx.currentTime + 0.1) * SR);
    this.startCtxFrame = ctxFrame;
    const loop = this.loop.on ? { start: this.loop.start, end: this.loop.end } : null;
    for (const t of this.tracks) t.node.port.postMessage({ type: 'play', ctxFrame, pos, loop });
    this.playing = true;
    this.feed();
  }

  stop() {
    if (!this.playing) return;
    this.pausedPos = this.position;
    this.playing = false;
    for (const t of this.tracks) {
      t.node.port.postMessage({ type: 'stop' });
      t.node.port.postMessage({ type: 'clear' });
      t.sent.clear();
    }
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

  async storedBytes() {
    const est = await navigator.storage.estimate();
    return est.usage || 0;
  }
}
