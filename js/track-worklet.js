// 트랙 하나를 재생하는 프로세서. 메인 스레드가 보내 준 블록(Int16)만 들고 있다.
const BLOCK = 32768;

class TrackPlayer extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.ch = opts.processorOptions.channels;
    this.frames = opts.processorOptions.frames;
    this.blocks = new Map();
    this.playing = false;
    this.startCtx = 0;
    this.startPos = 0;
    this.lastBlock = -1;
    this.under = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'block') this.blocks.set(m.b, m.data);
      else if (m.type === 'play') { this.playing = true; this.startCtx = m.ctxFrame; this.startPos = m.pos; this.lastBlock = -1; }
      else if (m.type === 'stop') this.playing = false;
      else if (m.type === 'clear') this.blocks.clear();
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1];
    if (!this.playing) return true;
    const n = L.length;
    let pos = this.startPos + (currentFrame - this.startCtx);
    const ch = this.ch;
    let missing = false;
    let curB = -1, data = null;
    for (let i = 0; i < n; i++, pos++) {
      if (pos < 0 || pos >= this.frames) { L[i] = 0; R[i] = 0; continue; }
      const b = (pos / BLOCK) | 0;
      if (b !== curB) { curB = b; data = this.blocks.get(b); }
      if (!data) { L[i] = 0; R[i] = 0; missing = true; continue; }
      const k = (pos - b * BLOCK) * ch;
      const l = data[k] / 32768;
      L[i] = l;
      R[i] = ch === 2 ? data[k + 1] / 32768 : l;
    }
    if (missing) this.under++;
    if (curB !== this.lastBlock && curB >= 0) {
      this.lastBlock = curB;
      for (const key of this.blocks.keys()) if (key < curB - 1) this.blocks.delete(key);
      this.port.postMessage({ type: 'pos', b: curB, under: this.under });
    }
    return true;
  }
}

registerProcessor('track-player', TrackPlayer);
