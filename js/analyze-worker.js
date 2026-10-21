// 트랙별 음량·대역 분포, 원본 합(믹스 처리 전) 음량, 원곡 음량을 계산한다.
import { readWindow } from './pcm.js';
import { Stats } from './stats.js';

const CH = 44100 * 10;          // 10초씩 읽음

onmessage = async (e) => {
  const { tracks, dur } = e.data;
  const per = tracks.map(() => new Stats());
  const raw = new Stats();
  const ref = new Stats();
  const hasRef = tracks.some((t) => t.ref);
  for (let w0 = 0; w0 < dur; w0 += CH) {
    const w1 = Math.min(dur, w0 + CH);
    const sumL = new Float32Array(w1 - w0), sumR = new Float32Array(w1 - w0);
    for (let k = 0; k < tracks.length; k++) {
      const t = tracks[k];
      const [L, R] = await readWindow(t, w0, w1);
      per[k].push(L, R, t.scale);
      if (t.ref) ref.push(L, R, t.scale);
      else if (t.live) for (let i = 0; i < L.length; i++) { sumL[i] += L[i] * t.scale; sumR[i] += R[i] * t.scale; }
    }
    raw.push(sumL, sumR, 1);
    postMessage({ type: 'progress', done: w1 / dur });
  }
  postMessage({ type: 'done', tracks: per.map((s) => s.result()), raw: raw.result(), ref: hasRef ? ref.result() : null });
};
