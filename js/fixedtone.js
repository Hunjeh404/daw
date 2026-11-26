// 고정음 찾기: AI 음원이 소리를 키우는 단계에서 남기는, 늘 같은 높이에 바늘처럼 솟은 소리.
// 곡 여러 군데의 평균 스펙트럼에서 주변보다 솟아 있고, 폭이 아주 좁고(음악 소리는 떨림 때문에 퍼짐),
// 곡의 절반 넘는 시간 동안 계속 솟아 있는 4kHz 이상의 봉우리만 고른다.
import { fft } from './stats.js';
import { readWindow } from './pcm.js';

const SR = 44100, N = 16384, HOP = N / 2;
const WIN = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
export const MAX_TONES = 12;

function median(a, lo, hi) {
  const t = Array.prototype.slice.call(a, Math.max(0, lo), Math.min(a.length, hi)).sort((x, y) => x - y);
  return t[t.length >> 1];
}

// 곡에서 읽을 묶음: 트랙 전체 합, 그리고 원곡이 있으면 원곡. 묶음마다 따로 찾아 합친다
// (스템마다 따로 만들어진 고정음은 스템 합에서, 원곡에 있는 고정음은 원곡에서 더 잘 보인다)
function groups(E) {
  const out = [E.tracks.filter((t) => !t.mix.ref).map((t) => E.srcView(t))];
  if (E.guided && !E.guidedPending) out.push([E.srcView({ segs: E.bedSegments('ref') })]);
  else { const r = E.tracks.find((t) => t.mix.ref); if (r) out.push([E.srcView(r)]); }
  return out.filter((g) => g.length);
}

export async function detectTones(E) {
  const all = [];
  for (const g of groups(E)) {
    for (const t of await detectIn(E, g)) {
      const same = all.find((x) => Math.abs(x.f - t.f) < 4);
      if (!same) all.push(t);
      else if (t.db > same.db) Object.assign(same, t);
    }
  }
  all.sort((x, y) => y.db - x.db);
  return all.slice(0, MAX_TONES).sort((x, y) => x.f - y.f);
}

async function detectIn(E, vs) {
  const dur = E.duration;
  if (!vs.length || dur < SR * 10) return [];
  const K = 16, len = Math.min(SR * 3, Math.floor(dur * 0.9 / K));
  const bins = N / 2 + 1;
  const frames = [];                       // 조각마다 dB 스펙트럼
  const avg = new Float64Array(bins);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k < K; k++) {
    const a = Math.floor(dur * 0.05 + ((dur * 0.9 - len) * k) / (K - 1));
    const M = new Float32Array(len);
    for (const v of vs) {
      const [L, R] = await readWindow(v, a, a + len);
      for (let i = 0; i < len; i++) M[i] += (L[i] + R[i]) * 0.5;
    }
    for (let s = 0; s + N <= len; s += HOP) {
      for (let i = 0; i < N; i++) { re[i] = M[s + i] * WIN[i]; im[i] = 0; }
      fft(re, im);
      const db = new Float32Array(bins);
      for (let b = 0; b < bins; b++) { const p = re[b] * re[b] + im[b] * im[b]; avg[b] += p; db[b] = 10 * Math.log10(p + 1e-20); }
      frames.push(db);
    }
  }
  if (frames.length < 8) return [];
  const A = Float32Array.from(avg, (p) => 10 * Math.log10(p / frames.length + 1e-20));
  const b0 = Math.ceil((4000 / SR) * N), b1 = Math.floor((20500 / SR) * N);
  const W = 30;                            // 주변 기준: 양옆 약 80Hz의 가운데값
  const exc = new Float32Array(bins);
  for (let b = b0 - 8; b <= b1 + 8 && b < bins; b++) exc[b] = A[b] - median(A, b - W, b + W + 1);
  const cand = [];
  for (let b = b0; b <= b1; b++) {
    if (exc[b] < 5 || exc[b] < exc[b - 1] || exc[b] < exc[b + 1]) continue;
    if (exc[b] - Math.max(exc[b - 5], exc[b + 5]) < 4) continue;          // 폭이 좁아야
    let stay = 0;
    for (const db of frames) if (db[b] - median(db, b - W, b + W + 1) > 3) stay++;
    stay /= frames.length;
    if (stay < 0.5) continue;                                              // 곡 내내 있어야
    const y0 = A[b - 1], y1 = A[b], y2 = A[b + 1];
    const d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
    cand.push({ f: +(((b + Math.max(-0.5, Math.min(0.5, d))) * SR) / N).toFixed(1), db: +Math.min(20, exc[b]).toFixed(1), stay: +stay.toFixed(2) });
  }
  cand.sort((x, y) => y.db - x.db);
  return cand.slice(0, MAX_TONES).sort((x, y) => x.f - y.f).map((t) => ({ ...t, on: true }));
}
