// 음량·피크·대역 분포 누적 계산 (분석 워커와 메인 스레드가 함께 씀)
// 계산을 줄이려고 1.2초마다 0.4초 블록 하나씩만 음량을 잰다(앞 50ms는 필터 안정용).
import { kFilters, linToDb } from './dsp.js';

const FS = 44100;
const N = 2048;
const STRIDE = Math.round(FS * 1.2), WARM = Math.round(FS * 0.05), BLK = Math.round(FS * 0.4);
const FHOP = Math.round(FS * 0.5);
export const BANDS = [['sub', 20, 60], ['low', 60, 250], ['lowmid', 250, 500], ['mid', 500, 2000], ['pres', 2000, 7000], ['high', 7000, 12000], ['air', 12000, 20000]];

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
const HANN = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
const binOf = (f) => Math.round(f / FS * N);
const lu = (ms) => -0.691 + 10 * Math.log10(ms + 1e-15);

// 블록 음량 목록으로 통합 음량 (BS.1770 게이트)
export function integrate(blocks) {
  const abs = blocks.filter((m) => lu(m) > -70);
  if (!abs.length) return -Infinity;
  const rel = lu(abs.reduce((x, y) => x + y, 0) / abs.length) - 10;
  const g = abs.filter((m) => lu(m) > rel);
  return lu(g.reduce((x, y) => x + y, 0) / g.length);
}

export class Stats {
  constructor() {
    this.kL = kFilters(FS); this.kR = kFilters(FS);
    this.pos = 0; this.acc = 0;
    this.blocks = []; this.times = [];
    this.peak = 0; this.band = new Float64Array(BANDS.length); this.frames = 0;
  }
  // 연속된 조각을 차례로 넣는다. 새 구간을 시작하려면 restart()
  restart() { this.pos = 0; this.acc = 0; this.kL = kFilters(FS); this.kR = kFilters(FS); }
  push(L, R, scale) {
    const n = L.length;
    for (let i = 0; i < n; i++) {
      const ph = (this.pos + i) % STRIDE;
      const l = L[i] * scale, r = R[i] * scale;
      const a = l < 0 ? -l : l, b = r < 0 ? -r : r;
      if (a > this.peak) this.peak = a;
      if (b > this.peak) this.peak = b;
      if (ph >= WARM + BLK) continue;
      const x = this.kL[1].run(this.kL[0].run(l)), y = this.kR[1].run(this.kR[0].run(r));
      if (ph < WARM) continue;
      this.acc += x * x + y * y;
      if (ph === WARM + BLK - 1) { this.blocks.push(this.acc / BLK); this.times.push((this.pos + i) / FS); this.acc = 0; }
    }
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let p = (FHOP - (this.pos % FHOP)) % FHOP; p + N <= n; p += FHOP) {
      let e = 0;
      for (let i = 0; i < N; i++) { const v = (L[p + i] + R[p + i]) * 0.5 * scale; re[i] = v * HANN[i]; im[i] = 0; e += v * v; }
      if (e / N < 1e-7) continue;      // 거의 무음인 창은 건너뜀
      fft(re, im);
      for (let k = 0; k < BANDS.length; k++) {
        let s = 0;
        for (let q = binOf(BANDS[k][1]); q < Math.min(binOf(BANDS[k][2]), N / 2); q++) s += re[q] * re[q] + im[q] * im[q];
        this.band[k] += s;
      }
      this.frames++;
    }
    this.pos += n;
  }
  result() {
    const tot = this.band.reduce((a, b) => a + b, 0) || 1e-20;
    const bands = {};
    BANDS.forEach(([name], k) => { bands[name] = 10 * Math.log10(this.band[k] / tot + 1e-20); });
    const lufs = integrate(this.blocks);
    return { lufs, peak: linToDb(this.peak), crest: linToDb(this.peak) - lufs, bands, blocks: this.blocks, active: this.frames > 0 };
  }
}
