// 박자 찾기: 음원 파형 요약(PEAK 프레임마다 최댓값)으로 박 간격과 마디 첫 박 위치를 잡는다.
// 빠른 곡은 절반 빠르기로 잡는다 (그래도 마디 경계는 실제 마디 경계와 겹친다).
import { PEAK } from './engine.js';
import { category } from './cats.js';
import { dbToLin } from './dsp.js';
import { readWindow } from './pcm.js';

const SR = 44100, RATE = SR / PEAK;      // 요약 한 칸 = 약 23ms
const RHYTHM = new Set(['drums', 'perc', 'bass']);

function envelope(E, tracks, n) {
  const env = new Float32Array(n);
  for (const t of tracks) {
    const g = dbToLin(t.volumeDb);
    for (const c of t.clips) {
      const src = E.sources.get(c.sid);
      if (!src || src.missing) continue;
      const pk = src.peaks, k = src.scale * g;
      const x0 = Math.floor(c.start / PEAK), x1 = Math.min(n, Math.floor((c.start + c.len) / PEAK));
      for (let x = x0; x < x1; x++) {
        const p = Math.floor((c.src + (x * PEAK - c.start)) / PEAK);
        if (p >= 0 && p < pk.length) env[x] += pk[p] * k;
      }
    }
  }
  return env;
}

// 소리가 커지는 순간만 남긴 곡선
function onsets(env) {
  const n = env.length, o = new Float32Array(n);
  for (let i = 1; i < n; i++) o[i] = Math.max(0, Math.log(env[i] + 1e-4) - Math.log(env[i - 1] + 1e-4));
  // 0.5초 이동평균을 빼서 잔떨림 줄이기
  const W = Math.round(RATE * 0.25);
  const cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + o[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - W), b = Math.min(n, i + W + 1);
    out[i] = Math.max(0, o[i] - (cs[b] - cs[a]) / (b - a));
  }
  return out;
}

// 간격 P(칸)로 접어 쌓았을 때 가장 몰리는 위치와 그 몰림 정도
function fold(o, P, bins) {
  const h = new Float64Array(bins);
  for (let i = 0; i < o.length; i++) if (o[i]) h[Math.floor(((i % P) / P) * bins)] += o[i];
  let best = 0, at = 0, sum = 0;
  for (let b = 0; b < bins; b++) {
    const v = h[b] + 0.5 * (h[(b + 1) % bins] + h[(b + bins - 1) % bins]);
    sum += h[b];
    if (v > best) { best = v; at = b; }
  }
  return { score: sum ? best / sum : 0, phase: ((at + 0.5) / bins) * P };
}

// 곡 전체의 소리 시작 곡선 (요약 파형으로, 마디 첫 박 고를 때 씀). 트랙·클립이 바뀔 때만 다시
export function beatEnv(E, tracks) {
  const n = Math.ceil(E.duration / PEAK);
  return { n, oA: onsets(envelope(E, tracks, n)) };
}

// 끝 지점 end(초) 바로 앞 30초를 실제 소리로 촘촘히 읽어 박을 잡는다
// (곡 안에서 빠르기가 조금씩 바뀌어도 끝 부분에 맞게). 결과: { beat, bar, bar0, bpm } (초) 또는 null
const HOP = 256, HR = SR / HOP;          // 약 5.8ms
export async function gridAt(E, tracks, env, end) {
  if (!env || !tracks.length) return null;
  const rhythm = tracks.filter((t) => RHYTHM.has(t.cat || category(t.name)));
  const use = rhythm.length ? rhythm : tracks;
  for (const win of [30, 60]) {
    const a = Math.max(0, Math.round((end - win) * SR)), b = Math.min(E.duration, Math.round(end * SR));
    if (b - a < SR * 8) return null;
    // 소리 세기 → 커지는 순간
    const m = Math.floor((b - a) / HOP);
    const en = new Float64Array(m);
    for (const t of use) {
      const g = dbToLin(t.volumeDb) ** 2;
      const [L, R] = await readWindow(E.srcView(t), a, b);
      for (let i = 0; i < m; i++) {
        let s2 = 0;
        for (let j = i * HOP, e = j + HOP; j < e; j++) s2 += L[j] * L[j] + R[j] * R[j];
        en[i] += s2 * g;
      }
    }
    const raw = new Float32Array(m);
    // 세기 차이(로그가 아니라 크기 그대로): 킥·스네어처럼 큰 소리가 앞서고, 하이햇 같은 작은 소리는 덜 친다
    for (let i = 1; i < m; i++) raw[i] = Math.max(0, Math.sqrt(en[i]) - Math.sqrt(en[i - 1]));
    const o = new Float32Array(m);
    const W = Math.round(HR * 0.1);
    for (let i = 0; i < m; i++) {
      let s2 = 0, c = 0;
      for (let k = Math.max(0, i - W); k < Math.min(m, i + W + 1); k++) { s2 += raw[k]; c++; }
      o[i] = Math.max(0, raw[i] - s2 / c);
    }
    // 빠르기·위치: 접어서 몰리는 곳
    const tryBpm = (bpm) => { const P = (60 / bpm) * HR; return { bpm, P, ...fold(o, P, 48) }; };
    const coarse = [];
    for (let bpm = 60; bpm <= 120; bpm += 0.25) coarse.push(tryBpm(bpm));
    coarse.sort((x, y) => y.score - x.score);
    let best = null;
    for (const c of coarse.slice(0, 5)) {
      for (let bpm = c.bpm - 0.3; bpm <= c.bpm + 0.3; bpm += 0.02) {
        const f = tryBpm(bpm);
        if (!best || f.score > best.score) best = f;
      }
    }
    if (!best || best.score < 0.08) continue;
    // 박마다 가장 가까운 소리 시작점을 찾아 직선으로 맞춰 간격·위치를 다듬는다 (끝 쪽 빠르기에 맞게)
    let P = best.P, ph = best.phase;
    for (let it = 0; it < 3; it++) {
      const ks = [], ts = [], ws = [];
      for (let k = 0; ph + k * P < m; k++) {
        const c = ph + k * P, r = P * 0.15;
        let bi = -1, bv = 0;
        for (let i = Math.max(0, Math.ceil(c - r)); i <= Math.min(m - 1, Math.floor(c + r)); i++) if (o[i] > bv) { bv = o[i]; bi = i; }
        if (bi >= 0) { ks.push(k); ts.push(bi); ws.push(bv); }
      }
      if (ks.length < 6) break;
      let sw = 0, sk = 0, st = 0, skk = 0, skt = 0;
      for (let q = 0; q < ks.length; q++) { const w = ws[q]; sw += w; sk += w * ks[q]; st += w * ts[q]; skk += w * ks[q] * ks[q]; skt += w * ks[q] * ts[q]; }
      const den = sw * skk - sk * sk;
      if (!den) break;
      const P2 = (sw * skt - sk * st) / den, ph2 = (st - P2 * sk) / sw;
      if (!(P2 > P * 0.95 && P2 < P * 1.05)) break;
      P = P2; ph = ph2;
    }
    // 위치는 끝 바로 앞 8초로 다시 잡는다 (곡 안에서 빠르기가 조금씩 흔들려도 끝에 맞게)
    {
      const L8 = Math.min(m, Math.round(HR * 8)), base = m - L8;
      const f = fold(o.subarray(base), P, 48);
      if (f.score > 0) {
        const p8 = base + f.phase;                         // 끝 8초 안의 박 위치
        const k = Math.round((p8 - ph) / P);
        ph = p8 - k * P;
      }
    }
    // 마디 첫 박: 곡 전체 소리(요약)를 이 구간에서 4박마다 접어 가장 센 박
    const s0 = a / SR, beat = P / HR, phase = s0 + ph / HR, bar = beat * 4;
    let bar0 = phase, top = -1;
    for (let k = 0; k < 4; k++) {
      const p0 = phase + k * beat;
      let sc = 0;
      for (let tt = p0; tt < b / SR; tt += bar) {
        const i = Math.round(tt * RATE);
        for (let d = -1; d <= 1; d++) if (env.oA[i + d]) sc += env.oA[i + d] * (d ? 0.5 : 1);
      }
      if (sc > top) { top = sc; bar0 = p0; }
    }
    return { beat, bar, bar0, bpm: 60 / beat };
  }
  return null;
}

// 끝 지점 end(초) 뒤로 최소 minGap초를 두고, 그다음 마디 시작에서 끝나는 무음 길이(0.01초 단위)
export function tailFor(grid, end, minGap = 1) {
  if (!grid) return minGap;
  const T = grid.bar0 + Math.ceil((end + minGap - grid.bar0) / grid.bar) * grid.bar;
  return Math.round((T - end) * 100) / 100;
}
