// 트랙별 음량·대역 분포·잔향 정도, 원본 합(믹스 처리 전) 음량, 원곡 음량을 계산한다.
// 원곡이 있으면 스템 합이 원곡의 대역별·시간별 크기와 가장 비슷해지는 트랙별 볼륨도 구한다.
import { readWindow } from './pcm.js';
import { Stats, fft, HANN } from './stats.js';

const FS = 44100;
const CH = FS * 10;             // 10초씩 읽음
const N = 2048, FHOP = Math.round(FS * 0.5);
const EDGES = [60, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000];
const NB = EDGES.length - 1;
const bin = (f) => Math.round(f / FS * N);

function bandsAt(L, R, p, scale, re, im, out, o) {
  for (let i = 0; i < N; i++) { re[i] = (L[p + i] + R[p + i]) * 0.5 * scale * HANN[i]; im[i] = 0; }
  fft(re, im);
  for (let k = 0; k < NB; k++) {
    let s = 0;
    for (let q = bin(EDGES[k]); q < bin(EDGES[k + 1]); q++) s += re[q] * re[q] + im[q] * im[q];
    out[o + k] = s;
  }
}

// 음이 아닌 최소제곱 (작은 문제라 좌표 하강으로 충분)
function nnls(A, b, n) {
  const x = new Float64Array(n).fill(1);
  for (let it = 0; it < 500; it++) {
    for (let i = 0; i < n; i++) {
      if (A[i * n + i] <= 0) { x[i] = 0; continue; }
      let s = b[i];
      for (let j = 0; j < n; j++) if (j !== i) s -= A[i * n + j] * x[j];
      x[i] = Math.max(0, s / A[i * n + i]);
    }
  }
  return x;
}

onmessage = async (e) => {
  const { tracks, dur } = e.data;
  const per = tracks.map(() => new Stats());
  const raw = new Stats();
  const ref = new Stats();
  const refIdx = tracks.findIndex((t) => t.ref);
  const fitIdx = tracks.map((t, i) => (t.live ? i : -1)).filter((i) => i >= 0);
  const doFit = refIdx >= 0 && fitIdx.length > 0;
  const frames = [];             // [원곡 NB개, 트랙1 NB개, ...]
  const re = new Float32Array(N), im = new Float32Array(N);
  for (let w0 = 0; w0 < dur; w0 += CH) {
    const w1 = Math.min(dur, w0 + CH);
    const sumL = new Float32Array(w1 - w0), sumR = new Float32Array(w1 - w0);
    const win = [];
    for (let k = 0; k < tracks.length; k++) {
      const t = tracks[k];
      const [L, R] = await readWindow(t, w0, w1);
      per[k].push(L, R, 1);
      if (t.ref) ref.push(L, R, 1);
      else if (t.live) for (let i = 0; i < L.length; i++) { sumL[i] += L[i]; sumR[i] += R[i]; }
      win.push(doFit && (t.ref || t.live) ? [L, R] : null);
    }
    raw.push(sumL, sumR, 1);
    if (doFit) {
      for (let p = 0; p + N <= w1 - w0; p += FHOP) {
        const f = new Float64Array(NB * (fitIdx.length + 1));
        const [rL, rR] = win[refIdx];
        bandsAt(rL, rR, p, 1, re, im, f, 0);
        let e = 0;
        for (let k = 0; k < NB; k++) e += f[k];
        if (e < 1e-6) continue;   // 원곡이 조용한 곳은 건너뜀
        fitIdx.forEach((ti, j) => { const [L, R] = win[ti]; bandsAt(L, R, p, 1, re, im, f, NB * (j + 1)); });
        frames.push(f);
      }
    }
    postMessage({ type: 'progress', done: w1 / dur });
  }
  let fit = null;
  if (doFit && frames.length > 4) {
    // 대역마다 원곡 평균으로 나눠 모든 대역이 고르게 반영되게 한다
    const n = fitIdx.length;
    const mean = new Float64Array(NB);
    for (const f of frames) for (let k = 0; k < NB; k++) mean[k] += f[k] / frames.length;
    const A = new Float64Array(n * n), b = new Float64Array(n);
    for (const f of frames) {
      for (let k = 0; k < NB; k++) {
        if (mean[k] <= 0) continue;
        const w = 1 / (mean[k] * mean[k]);
        const r = f[k];
        for (let i = 0; i < n; i++) {
          const si = f[NB * (i + 1) + k];
          b[i] += w * si * r;
          for (let j = 0; j < n; j++) A[i * n + j] += w * si * f[NB * (j + 1) + k];
        }
      }
    }
    const x = nnls(A, b, n);
    fit = {};
    fitIdx.forEach((ti, j) => { fit[ti] = x[j]; });
  }
  postMessage({ type: 'done', tracks: per.map((s) => s.result()), raw: raw.result(), ref: refIdx >= 0 ? ref.result() : null, fit });
};
