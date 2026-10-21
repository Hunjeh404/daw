// 원곡 음색 맞추기 (Matchering 방식을 참고해 새로 짠 것)
// 미드(가운데)와 사이드(양옆)를 따로, 같은 시간대의 원곡과 믹스의 주파수 모양을 비교해
// 차이를 1/6옥타브로 고르게 다듬은 곡선을 만들고, 그 곡선대로 최소 위상 FIR을 만든다.
import { fft } from './stats.js';

const N = 4096, HOP = 2048, SR = 44100;
const WIN = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));

// 곡선이 놓이는 주파수 (25Hz~20kHz, 1/6옥타브)
export const TONE_F = [];
for (let f = 25; f <= 20000; f *= 2 ** (1 / 6)) TONE_F.push(f);
const EDGES = TONE_F.map((f) => [f * 2 ** (-1 / 12), f * 2 ** (1 / 12)]);

// 미드·사이드 평균 파워 스펙트럼 쌓기
export class ToneSpec {
  constructor() {
    this.mid = new Float64Array(N / 2 + 1);
    this.side = new Float64Array(N / 2 + 1);
    this.n = 0;
    this.bufM = new Float32Array(N); this.bufS = new Float32Array(N); this.fill = 0;
    this.re = new Float64Array(N); this.im = new Float64Array(N);
  }
  push(L, R) {
    for (let i = 0; i < L.length; i++) {
      this.bufM[this.fill] = (L[i] + R[i]) * 0.5;
      this.bufS[this.fill] = (L[i] - R[i]) * 0.5;
      if (++this.fill === N) {
        this.frame();
        this.bufM.copyWithin(0, HOP); this.bufS.copyWithin(0, HOP);
        this.fill = N - HOP;
      }
    }
  }
  // 조각이 바뀔 때 (이어지지 않는 구간)
  restart() { this.fill = 0; }
  frame() {
    for (const [buf, acc] of [[this.bufM, this.mid], [this.bufS, this.side]]) {
      const re = this.re, im = this.im;
      for (let i = 0; i < N; i++) { re[i] = buf[i] * WIN[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k <= N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    }
    this.n++;
  }
  // 대역별 dB
  bands() {
    const out = (acc) => EDGES.map(([lo, hi]) => {
      const k0 = Math.max(1, Math.floor((lo / SR) * N)), k1 = Math.max(k0, Math.ceil((hi / SR) * N));
      let s = 0;
      for (let k = k0; k <= k1 && k <= N / 2; k++) s += acc[k];
      return 10 * Math.log10(s / (k1 - k0 + 1) / Math.max(1, this.n) + 1e-20);
    });
    return { mid: out(this.mid), side: out(this.side) };
  }
}

const smooth = (a) => a.map((v, i) => (a[Math.max(0, i - 1)] + 2 * v + a[Math.min(a.length - 1, i + 1)]) / 4);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mean = (a, f0, f1) => { let s = 0, n = 0; TONE_F.forEach((f, i) => { if (f >= f0 && f <= f1) { s += a[i]; n++; } }); return n ? s / n : 0; };

// 믹스(mix)를 원곡(ref)에 맞추는 곡선 (dB). keepWidth면 사이드는 모양만 맞추고 넓이(전체 크기)는 지금 믹스대로
export function toneCurve(mix, ref, keepWidth) {
  let dm = ref.mid.map((v, i) => v - mix.mid[i]);
  let ds = ref.side.map((v, i) => v - mix.side[i]);
  const off = mean(dm, 100, 8000);           // 전체 음량 차이는 리미터가 맞추므로 뺀다
  dm = dm.map((v) => v - off);
  ds = ds.map((v) => v - off);
  if (keepWidth) { const o = mean(ds, 200, 8000); ds = ds.map((v) => v - o); }
  for (let k = 0; k < 2; k++) { dm = smooth(dm); ds = smooth(ds); }
  const mid = dm.map((v, i) => {
    const f = TONE_F[i];
    let x = clamp(v, -8, 8);
    if (f < 35 || f > 16000) x = Math.min(x, 0);     // 초저역·초고역은 올리지 않음 (잡음만 커짐)
    return +x.toFixed(1);
  });
  const side = ds.map((v, i) => {
    const f = TONE_F[i];
    let x = clamp(v, -12, 6);
    if (f < 150 || f > 16000) x = Math.min(x, 0);    // 저역 사이드는 어차피 모노로 모음
    return +x.toFixed(1);
  });
  return { mid, side };
}

// 곡선 → 최소 위상 FIR (길이 N). amt: 0~1 세기
export function toneFir(curve, amt) {
  const M = N * 2;                          // 켑스트럼 계산은 두 배 길이로 (시간 겹침 줄이기)
  const re = new Float64Array(M), im = new Float64Array(M);
  const lf = TONE_F.map(Math.log);
  const at = (f) => {
    const x = Math.log(Math.max(f, 1));
    if (x <= lf[0]) return curve[0];
    if (x >= lf[lf.length - 1]) return curve[curve.length - 1];
    let i = 1;
    while (lf[i] < x) i++;
    const t = (x - lf[i - 1]) / (lf[i] - lf[i - 1]);
    return curve[i - 1] + (curve[i] - curve[i - 1]) * t;
  };
  // 로그 크기 (dB → 자연로그)
  for (let k = 0; k <= M / 2; k++) {
    const v = (amt * at((k / M) * SR) * Math.LN10) / 20;
    re[k] = v; if (k > 0 && k < M / 2) re[M - k] = v;
  }
  // 켑스트럼
  ifft(re, im);
  for (let n = 1; n < M / 2; n++) { re[n] *= 2; re[M - n] = 0; im[n] = 0; im[M - n] = 0; }
  im[0] = 0; im[M / 2] = 0;
  fft(re, im);
  // exp(복소)
  for (let k = 0; k < M; k++) {
    const m = Math.exp(re[k]);
    const c = m * Math.cos(im[k]), s = m * Math.sin(im[k]);
    re[k] = c; im[k] = s;
  }
  ifft(re, im);
  const h = new Float32Array(N);
  const tail = N / 8;
  for (let n = 0; n < N; n++) {
    const w = n < N - tail ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (n - (N - tail))) / tail);
    h[n] = re[n] * w;
  }
  return h;
}

function ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
}
