// 트랙 하나를 재생하는 프로세서. 메인 스레드가 보내 준 원본 블록(Int16)과
// 재생 구간 목록(segments)만 들고, 구간마다 페이드를 곱해 더한다.
const BLOCK = 32768;
const HALF_PI = Math.PI / 2;

class TrackPlayer extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.ch = opts.processorOptions.channels;
    this.blocks = new Map();
    this.segs = [];
    this.loop = null;
    this.playing = false;
    this.startCtx = 0;
    this.startPos = 0;
    this.under = 0;
    this.tick = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'block') this.blocks.set(m.b, m.data);
      else if (m.type === 'drop') for (const b of m.list) this.blocks.delete(b);
      else if (m.type === 'segs') this.segs = m.segs;
      else if (m.type === 'play') { this.playing = true; this.startCtx = m.ctxFrame; this.startPos = m.pos; this.loop = m.loop; }
      else if (m.type === 'stop') this.playing = false;
      else if (m.type === 'clear') this.blocks.clear();
    };
  }

  mapPos(raw) {
    const L = this.loop;
    if (L && this.startPos < L.end && raw >= L.end) return L.start + ((raw - L.end) % (L.end - L.start));
    return raw;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const Lo = out[0], Ro = out[1];
    if (!this.playing) return true;
    const n = Lo.length;
    const ch = this.ch;
    const rel0 = currentFrame - this.startCtx;
    let missing = false;
    for (let i = 0; i < n; i++) {
      const rel = rel0 + i;
      let l = 0, r = 0;
      if (rel >= 0) {
        const pos = this.mapPos(this.startPos + rel);
        for (const s of this.segs) {
          if (pos < s.start || pos >= s.end) continue;
          const src = s.src + (pos - s.start);
          const b = (src / BLOCK) | 0;
          const data = this.blocks.get(b);
          if (!data) { missing = true; continue; }
          let g = 1;
          const d = pos - s.start;
          if (d < s.fi) g *= Math.sin(HALF_PI * d / s.fi);
          const e = s.end - pos;
          if (e < s.fo) g *= Math.sin(HALF_PI * e / s.fo);
          const k = (src - b * BLOCK) * ch;
          const vl = data[k] / 32768;
          l += vl * g;
          r += (ch === 2 ? data[k + 1] / 32768 : vl) * g;
        }
      }
      Lo[i] = l; Ro[i] = r;
    }
    if (missing) this.under++;
    if (++this.tick % 64 === 0) this.port.postMessage({ type: 'tick', under: this.under });
    return true;
  }
}

registerProcessor('track-player', TrackPlayer);
