// 재생 엔진: 음원을 한 곡씩 풀어 폰 저장공간(OPFS)에 16비트로 담고,
// 재생 위치 앞쪽만 조금씩 읽어 트랙별 프로세서로 보낸다.

export const SR = 44100;
export const BLOCK = 32768;      // 프레임 (약 0.74초)
export const PEAK = 1024;        // 파형 한 칸이 맡는 프레임 수
const AHEAD = Math.ceil((10 * SR) / BLOCK); // 약 10초 앞까지 미리 보냄

export class Engine {
  constructor() {
    this.ctx = null;
    this.tracks = [];
    this.playing = false;
    this.startPos = 0;
    this.startCtxFrame = 0;
    this.pausedPos = 0;
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
    return this.tracks.reduce((m, t) => Math.max(m, t.frames), 0);
  }

  async addTrack(name, arrayBuffer) {
    const buf = await this.ctx.decodeAudioData(arrayBuffer);
    const ch = Math.min(buf.numberOfChannels, 2);
    const frames = buf.length;
    const id = crypto.randomUUID();
    const fh = await this.root.getFileHandle(id + '.pcm', { create: true });
    const w = await fh.createWritable();
    const L = buf.getChannelData(0);
    const R = ch === 2 ? buf.getChannelData(1) : null;
    const peaks = new Float32Array(Math.ceil(frames / PEAK));
    const STEP = BLOCK;
    for (let s = 0; s < frames; s += STEP) {
      const n = Math.min(STEP, frames - s);
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

    const node = new AudioWorkletNode(this.ctx, 'track-player', {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: { channels: ch, frames },
    });
    const gain = this.ctx.createGain();
    node.connect(gain).connect(this.master);
    const t = {
      id, name, frames, ch, peaks,
      file: await fh.getFile(),
      node, gain, sent: new Set(),
      volume: 1, muted: false, under: 0,
    };
    node.port.onmessage = (e) => {
      if (e.data.type === 'pos') { t.under = e.data.under; this.feed(); }
    };
    this.tracks.push(t);
    return t;
  }

  setVolume(t, v) { t.volume = v; this.applyGain(t); }
  setMute(t, m) { t.muted = m; this.applyGain(t); }
  applyGain(t) { t.gain.gain.setTargetAtTime(t.muted ? 0 : t.volume, this.ctx.currentTime, 0.01); }

  get position() {
    if (!this.playing) return this.pausedPos;
    return Math.max(0, this.startPos + (Math.round(this.ctx.currentTime * SR) - this.startCtxFrame));
  }

  async sendBlock(t, b) {
    if (t.sent.has(b)) return;
    const first = b * BLOCK;
    if (first >= t.frames) return;
    t.sent.add(b);
    const n = Math.min(BLOCK, t.frames - first);
    const bytes = 2 * t.ch;
    const ab = await t.file.slice(first * bytes, (first + n) * bytes).arrayBuffer();
    const data = new Int16Array(ab);
    t.node.port.postMessage({ type: 'block', b, data }, [ab]);
  }

  feed() {
    if (!this.playing) return;
    const pos = this.position;
    if (pos >= this.duration) { this.stop(); this.pausedPos = 0; this.onEnd && this.onEnd(); return; }
    const b0 = Math.floor(pos / BLOCK);
    for (const t of this.tracks) {
      for (const b of t.sent) if (b < b0 - 1) t.sent.delete(b);
      for (let b = b0; b <= b0 + AHEAD; b++) this.sendBlock(t, b);
    }
  }

  async play() {
    if (this.playing || !this.tracks.length) return;
    await this.ctx.resume();
    const pos = this.pausedPos;
    const b0 = Math.floor(pos / BLOCK);
    // 시작 전 앞부분 3블록은 모든 트랙에 확실히 넣어 둔다
    await Promise.all(this.tracks.flatMap((t) => [0, 1, 2].map((k) => this.sendBlock(t, b0 + k))));
    const ctxFrame = Math.round((this.ctx.currentTime + 0.1) * SR);
    this.startPos = pos;
    this.startCtxFrame = ctxFrame;
    for (const t of this.tracks) t.node.port.postMessage({ type: 'play', ctxFrame, pos });
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

  async storedBytes() {
    const est = await navigator.storage.estimate();
    return est.usage || 0;
  }
}
