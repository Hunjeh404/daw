// 공통 신호처리 도구: 오디오 프로세서(worklet), 분석 워커, 메인 스레드에서 함께 쓴다.

export const dbToLin = (db) => Math.pow(10, db / 20);
export const linToDb = (x) => (x > 1e-12 ? 20 * Math.log10(x) : -240);

// RBJ 바이쿼드 필터 (계수는 set으로 바꿀 수 있음)
export class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  set(type, f, q, gainDb, fs) {
    const A = Math.pow(10, (gainDb || 0) / 40);
    const w = 2 * Math.PI * Math.min(f, fs * 0.49) / fs;
    const cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'lowpass': b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'highpass': b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'bandpass': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; break;
      case 'peaking': b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; break;
      case 'lowshelf': {
        const s2 = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) - (A - 1) * cs + s2); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - s2);
        a0 = (A + 1) + (A - 1) * cs + s2; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - s2; break;
      }
      case 'highshelf': {
        const s2 = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) + (A - 1) * cs + s2); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - s2);
        a0 = (A + 1) - (A - 1) * cs + s2; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - s2; break;
      }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  copyFrom(o) { this.b0 = o.b0; this.b1 = o.b1; this.b2 = o.b2; this.a1 = o.a1; this.a2 = o.a2; return this; }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

// 엔벨로프(빠르게 오르고 천천히 내려가는 값 추적)
export const coef = (ms, fs) => Math.exp(-1 / (Math.max(ms, 0.01) * 0.001 * fs));

// K-가중 필터 한 쌍 (BS.1770)
export function kFilters(fs) {
  return [new Biquad().set('highshelf', 1500, Math.SQRT1_2, 4, fs),
          new Biquad().set('highpass', 38, 0.5, 0, fs)];
}

// 통합 음량(LUFS) 계산기: 400ms 블록, 100ms 간격, 절대·상대 게이트
export class Loudness {
  constructor(fs) {
    this.fs = fs;
    this.kL = kFilters(fs); this.kR = kFilters(fs);
    this.hop = Math.round(fs * 0.1);
    this.sub = [];            // 100ms 단위 평균제곱
    this.acc = 0; this.n = 0;
    this.blocks = [];         // 400ms 블록 음량(선형 평균제곱)
  }
  push(l, r) {
    const a = this.kL[1].run(this.kL[0].run(l));
    const b = this.kR[1].run(this.kR[0].run(r));
    this.acc += a * a + b * b;
    if (++this.n === this.hop) {
      this.sub.push(this.acc / this.hop);
      this.acc = 0; this.n = 0;
      if (this.sub.length >= 4) {
        const k = this.sub.length;
        this.blocks.push((this.sub[k - 1] + this.sub[k - 2] + this.sub[k - 3] + this.sub[k - 4]) / 4);
        if (this.sub.length > 40) this.sub.splice(0, this.sub.length - 40);
      }
    }
  }
  // 최근 3초 음량
  shortTerm() {
    const s = this.sub.slice(-30);
    if (s.length < 30) return -Infinity;
    return -0.691 + 10 * Math.log10(s.reduce((x, y) => x + y, 0) / s.length + 1e-15);
  }
  integrated() {
    const lu = (ms) => -0.691 + 10 * Math.log10(ms + 1e-15);
    const abs = this.blocks.filter((m) => lu(m) > -70);
    if (!abs.length) return -Infinity;
    const rel = lu(abs.reduce((x, y) => x + y, 0) / abs.length) - 10;
    const g = abs.filter((m) => lu(m) > rel);
    return lu(g.reduce((x, y) => x + y, 0) / g.length);
  }
}

// 트루피크 측정기: 4배 업샘플(창 씌운 싱크 16탭)로 샘플 사이 피크를 잰다
const TP_TAPS = 16;
const TP_COEF = [0.25, 0.5, 0.75].map((frac) => {
  const c = new Float64Array(TP_TAPS);
  for (let k = 0; k < TP_TAPS; k++) {
    const x = k - (TP_TAPS / 2 - 1) - frac;          // 가운데 두 샘플 사이를 보간
    const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.5 + 0.5 * Math.cos(Math.PI * x / (TP_TAPS / 2 + 0.5));
    c[k] = sinc * w;
  }
  const sum = c.reduce((a, b) => a + b, 0);
  return c.map((v) => v / sum);
});
export class TruePeak {
  constructor() { this.h = new Float64Array(TP_TAPS); this.i = 0; }
  // 새 샘플을 넣고, 가운데(지연 TP_TAPS/2 - 1 샘플) 근처의 최대 크기를 돌려준다
  push(x) {
    const h = this.h;
    h[this.i] = x; this.i = (this.i + 1) % TP_TAPS;
    let m = Math.abs(h[(this.i + TP_TAPS / 2 - 1) % TP_TAPS]);
    for (const c of TP_COEF) {
      let y = 0;
      for (let k = 0; k < TP_TAPS; k++) y += c[k] * h[(this.i + k) % TP_TAPS];
      const a = Math.abs(y);
      if (a > m) m = a;
    }
    return m;
  }
}
export const TP_DELAY = TP_TAPS / 2 - 1;

// 4배 보간으로 샘플 사이 피크(트루피크)를 어림 (가벼운 근사)
export function interPeak(x0, x1, x2, x3) {
  let m = Math.abs(x2);
  const c1 = -x0 + x2, c2 = 2 * x0 - 5 * x1 + 4 * x2 - x3, c3 = -x0 + 3 * x1 - 3 * x2 + x3;
  for (let k = 1; k < 4; k++) {
    const t = k * 0.25;
    const a = Math.abs(0.5 * (2 * x1 + c1 * t + c2 * t * t + c3 * t * t * t));
    if (a > m) m = a;
  }
  return m;
}
