// 트랙 처리(track-fx)와 전체 마스터 처리(master-fx).
// 설정은 port로 받은 객체를 그대로 쓴다. 꺼진 처리는 계산하지 않는다.
import { Biquad, coef, dbToLin, linToDb, Loudness, interPeak, TruePeak, TP_DELAY } from './dsp.js';

const FS = sampleRate;

// 무거운 계산(로그·거듭제곱)은 16샘플마다 한 번만 하고, 사이는 선형으로 잇는다
const K = 16;
const coefK = (ms) => Math.pow(coef(ms, FS), K);

// 튈 때만 누르는 대역 하나 (거칠음 억제)
class DynBand {
  constructor(type, f, q, scType, scF) {
    this.type = type; this.f = f; this.q = q;
    this.sc = new Biquad().set(scType, scF, 0.8, 0, FS);
    this.fL = new Biquad().set(type, f, q, 0, FS);
    this.fR = new Biquad();
    this.fR.copyFrom(this.fL);
    this.fast = 0; this.slowDb = -60; this.cur = 0; this.cnt = 0;
    this.aF = coef(3, FS); this.rF = coef(60, FS); this.aS = coefK(900);
  }
  // 16샘플마다: amt 0~1, maxDb 최대 감쇄, stat 고정 감쇄
  control(amt, maxDb, stat) {
    const fd = linToDb(this.fast);
    this.slowDb = this.aS * this.slowDb + (1 - this.aS) * fd;
    if (++this.cnt < 2) return;
    this.cnt = 0;
    const red = Math.min(Math.max((fd - this.slowDb - 2) * 0.8, 0), maxDb) * amt + stat * amt;
    if (Math.abs(red - this.cur) > 0.05) {
      this.cur += (red - this.cur) * 0.5;
      this.fL.set(this.type, this.f, this.q, -this.cur, FS);
      this.fR.copyFrom(this.fL);
    }
  }
  run(l, r, m) {
    const s = Math.abs(this.sc.run(m));
    this.fast = s > this.fast ? this.aF * this.fast + (1 - this.aF) * s : this.rF * this.fast + (1 - this.rF) * s;
    this.oL = this.fL.run(l); this.oR = this.fR.run(r);
  }
}

class Compressor {
  constructor(atk = 10, rel = 150, gatk = 5, grel = 120) { this.env = 1e-6; this.g = 0; this.a = coef(atk, FS); this.r = coef(rel, FS); this.ga = coefK(gatk); this.gr = coefK(grel); }
  track(m2) { this.env = m2 > this.env ? this.a * this.env + (1 - this.a) * m2 : this.r * this.env + (1 - this.r) * m2; }
  // 16샘플마다: 감쇄 dB(음수)
  control(thr, ratio, knee) {
    const x = 10 * Math.log10(this.env + 1e-12);
    const d = x - thr;
    let y;
    if (2 * d < -knee) y = x;
    else if (2 * Math.abs(d) <= knee) y = x + (1 / ratio - 1) * (d + knee / 2) ** 2 / (2 * knee);
    else y = thr + d / ratio;
    const want = y - x;
    this.g = want < this.g ? this.ga * this.g + (1 - this.ga) * want : this.gr * this.g + (1 - this.gr) * want;
    return this.g;
  }
}

class TrackFx extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.p = opts?.processorOptions?.p || { bypass: false };
    this.mid = new DynBand('peaking', 4000, 0.7, 'bandpass', 4000);
    this.air = new DynBand('highshelf', 11000, 0.7, 'highpass', 10000);
    this.comp = new Compressor();
    this.tf = 0; this.ts = 0; this.tg = 0;
    this.tfa = coef(0.5, FS); this.tfr = coef(30, FS); this.tsa = coef(25, FS); this.tsr = coef(250, FS); this.tgs = coefK(1);
    this.k1 = new Biquad(); this.k2 = new Biquad(); this.keyType = '';
    this.ke = 0; this.kref = 1e-4; this.dg = 0; this.kHold = coefK(3000); this.dgs = coefK(10);
    this.gl = 1;
    this.lg = 1; this.lr = coef(60, FS);
    this.port.onmessage = (e) => { this.p = e.data; };
  }
  setKey(type) {
    this.keyType = type;
    if (type === 'vocal') { this.k1.set('bandpass', 1000, 0.7, 0, FS); this.k2.set('bandpass', 1000, 0.7, 0, FS); this.kr = coef(300, FS); }
    else { this.k1.set('lowpass', 120, 0.707, 0, FS); this.k2.set('lowpass', 120, 0.707, 0, FS); this.kr = coef(120, FS); }
    this.ka = coef(5, FS);
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const oL = out[0], oR = out[1];
    if (!inp.length) { oL.fill(0); oR.fill(0); return true; }
    const iL = inp[0], iR = inp[1] || inp[0];
    const p = this.p;
    const tam = !p.bypass && p.tamer && p.tamer.on && (p.tamer.mid > 0 || p.tamer.air > 0);
    const cmp = !p.bypass && p.comp && p.comp.on && p.comp.amt > 0;
    const trn = !p.bypass && p.trans && p.trans.on && p.trans.amt !== 0;
    const dk = !p.bypass && p.duck && p.duck.on && p.duck.depth > 0;
    const lim = !p.bypass && p.lim && p.lim.on;
    if (!tam && !cmp && !trn && !dk && !lim) { oL.set(iL); oR.set(iR); this.gl = 1; return true; }
    const key = inputs[1] && inputs[1].length ? inputs[1] : null;
    if (dk && this.keyType !== p.duck.key) this.setKey(p.duck.key);
    let thr = 0, ratio = 1;
    if (cmp) { thr = (p.comp.ref ?? -20) + 6 - 16 * p.comp.amt; ratio = 1.5 + 3 * p.comp.amt; }
    const ceil = lim ? dbToLin(p.lim.ceil ?? -1) : 1;
    const useGain = cmp || trn || dk;
    for (let i0 = 0; i0 < iL.length; i0 += K) {
      if (tam) { this.mid.control(p.tamer.mid, 9, 0); this.air.control(p.tamer.air, 8, 1.5); }
      // 이전 16샘플까지의 엔벨로프로 이번 구간 이득을 정한다
      let g1 = 1;
      if (useGain) {
        let gDb = 0;
        if (cmp) gDb += this.comp.control(thr, ratio, 6);
        if (trn) {
          const diff = Math.min(Math.max(linToDb(this.tf + 1e-9) - linToDb(this.ts + 1e-9), 0), 18);
          const want = Math.max(-10, Math.min(10, p.trans.amt * diff * 0.8));
          this.tg = this.tgs * this.tg + (1 - this.tgs) * want;
          gDb += this.tg;
        }
        if (dk) {
          const amt = this.kref > 1e-4 ? Math.min(this.ke / this.kref, 1) : 0;
          this.dg = this.dgs * this.dg + (1 - this.dgs) * (-p.duck.depth * amt);
          this.kref = Math.max(this.ke, this.kHold * this.kref);
          gDb += this.dg;
        }
        g1 = dbToLin(gDb);
      }
      const g0 = this.gl, dg = (g1 - g0) / K;
      for (let j = 0; j < K; j++) {
        const i = i0 + j;
        let l = iL[i], r = iR[i];
        if (tam) {
          const m = (l + r) * 0.5;
          this.mid.run(l, r, m); l = this.mid.oL; r = this.mid.oR;
          this.air.run(l, r, m); l = this.air.oL; r = this.air.oR;
        }
        if (cmp) this.comp.track((l * l + r * r) * 0.5);
        if (trn) {
          const a = Math.abs(l) + Math.abs(r);
          this.tf = a > this.tf ? this.tfa * this.tf + (1 - this.tfa) * a : this.tfr * this.tf + (1 - this.tfr) * a;
          this.ts = a > this.ts ? this.tsa * this.ts + (1 - this.tsa) * a : this.tsr * this.ts + (1 - this.tsr) * a;
        }
        if (dk) {
          let k = 0;
          if (key) { const kL = key[0][i], kR = (key[1] || key[0])[i]; k = Math.abs(this.k2.run(this.k1.run((kL + kR) * 0.5))); }
          this.ke = k > this.ke ? this.ka * this.ke + (1 - this.ka) * k : this.kr * this.ke + (1 - this.kr) * k;
        }
        if (useGain) { const g = g0 + dg * (j + 1); l *= g; r *= g; }
        if (lim) {
          const pk = Math.max(Math.abs(l), Math.abs(r));
          const want = pk > ceil ? ceil / pk : 1;
          this.lg = want < this.lg ? want : this.lr * this.lg + (1 - this.lr) * want;
          l *= this.lg; r *= this.lg;
          if (l > ceil) l = ceil; else if (l < -ceil) l = -ceil;
          if (r > ceil) r = ceil; else if (r < -ceil) r = -ceil;
        }
        oL[i] = l; oR[i] = r;
      }
      this.gl = g1;
    }
    return true;
  }
}
registerProcessor('track-fx', TrackFx);

// 전체 마스터: 입력 음량 → M/S(저역 모노, 중역 넓이) → 거칠음 억제 → 글루 압축 → 트루피크 리미터 → 측정
class MasterFx extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this.p = opts?.processorOptions?.p || { bypass: false };
    this.mid = new DynBand('peaking', 4000, 0.7, 'bandpass', 4000);
    this.air = new DynBand('highshelf', 11000, 0.7, 'highpass', 10000);
    this.comp = new Compressor(30, 250, 30, 250);
    this.cg = 1; this.cg0 = 1;
    this.sHP = new Biquad(); this.sHP2 = new Biquad(); this.monoHz = 0;
    this.sLo = new Biquad().set('lowpass', 3000, 0.707, 0, FS);
    this.LA = Math.round(FS * 0.004) + TP_DELAY;
    this.tpL = new TruePeak(); this.tpR = new TruePeak(); this.oL = new TruePeak(); this.oR = new TruePeak();
    this.dL = new Float32Array(this.LA); this.dR = new Float32Array(this.LA); this.req = new Float32Array(this.LA).fill(1); this.di = 0;
    this.hL = [0, 0, 0, 0]; this.hR = [0, 0, 0, 0];
    this.g = 1; this.ga = coef(0.8, FS); this.gr = coef(100, FS);
    this.resetMeters();
    this.n = 0;
    this.port.onmessage = (e) => { if (e.data.type === 'reset') this.resetMeters(); else this.p = e.data; };
  }
  resetMeters() { this.loud = new Loudness(FS); this.tp = 0; this.pl = 0; this.pr = 0; this.grMin = 0; }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const oL = out[0], oR = out[1];
    const p = this.p;
    if (!inp.length) { oL.fill(0); oR.fill(0); }
    else {
      const iL = inp[0], iR = inp[1] || inp[0];
      const byp = p.bypass;
      const ig = dbToLin(byp ? (p.bypassGainDb || 0) : (p.inGainDb || 0));
      const ms = !byp && p.ms && p.ms.on;
      if (ms && p.ms.monoHz !== this.monoHz) {
        this.monoHz = p.ms.monoHz;
        this.sHP.set('lowpass', Math.max(20, this.monoHz), 0.707, 0, FS); this.sHP2.copyFrom(this.sHP);
      }
      const w = ms ? p.ms.width : 1;
      const tam = !byp && p.tamer && p.tamer.on && (p.tamer.mid > 0 || p.tamer.air > 0);
      const glue = !byp && p.glue && p.glue.on && p.glue.amt > 0;
      const thr = glue ? (p.glue.ref ?? -14) + 6 - 10 * p.glue.amt : 0;
      const lim = !byp && p.lim && p.lim.on;
      const ceil = lim ? dbToLin(p.lim.ceil ?? -1) : 1;
      for (let i = 0; i < iL.length; i++) {
        let l = iL[i] * ig, r = iR[i] * ig;
        if (ms) {
          const m = (l + r) * 0.5;
          let s = (l - r) * 0.5;
          // 사이드에서 저역만 빼서 모노로: 높은 대역은 위상이 그대로 남는다
          if (this.monoHz > 0) s -= this.sHP2.run(this.sHP.run(s));
          const hi = s - this.sLo.run(s);
          s = (s - hi) * w + hi * Math.min(w, 1);
          l = m + s; r = m - s;
        }
        if ((i & (K - 1)) === 0) {
          if (tam) { this.mid.control(p.tamer.mid, 6, 0); this.air.control(p.tamer.air, 6, 1); }
          if (glue) { this.cg0 = this.cg; this.cg = dbToLin(this.comp.control(thr, 2, 8)); }
        }
        if (tam) {
          const m = (l + r) * 0.5;
          this.mid.run(l, r, m); l = this.mid.oL; r = this.mid.oR;
          this.air.run(l, r, m); l = this.air.oL; r = this.air.oR;
        }
        if (glue) {
          this.comp.track((l * l + r * r) * 0.5);
          const g = this.cg0 + (this.cg - this.cg0) * (((i & (K - 1)) + 1) / K);
          l *= g; r *= g;
        }
        if (lim) {
          const tpk = Math.max(this.tpL.push(l), this.tpR.push(r));
          const j = this.di;
          const dl = this.dL[j], dr = this.dR[j];
          this.dL[j] = l; this.dR[j] = r; this.req[j] = tpk > ceil ? ceil / tpk : 1;
          this.di = (j + 1) % this.LA;
          let tgt = 1;
          for (let k = 0; k < this.LA; k++) if (this.req[k] < tgt) tgt = this.req[k];
          this.g = tgt < this.g ? this.ga * this.g + (1 - this.ga) * tgt : this.gr * this.g + (1 - this.gr) * tgt;
          l = dl * this.g; r = dr * this.g;
          const c = ceil;
          if (l > c) l = c; else if (l < -c) l = -c;
          if (r > c) r = c; else if (r < -c) r = -c;
          const grDb = linToDb(this.g);
          if (grDb < this.grMin) this.grMin = grDb;
        }
        oL[i] = l; oR[i] = r;
      }
    }
    // 측정
    for (let i = 0; i < oL.length; i++) {
      const l = oL[i], r = oR[i];
      this.loud.push(l, r);
      const al = Math.abs(l), ar = Math.abs(r);
      if (al > this.pl) this.pl = al;
      if (ar > this.pr) this.pr = ar;
    }
    // 출력 트루피크
    for (let i = 0; i < oL.length; i++) {
      const t = Math.max(this.oL.push(oL[i]), this.oR.push(oR[i]));
      if (t > this.tp) this.tp = t;
    }
    if (++this.n % 32 === 0) {
      this.port.postMessage({ type: 'meter', st: this.loud.shortTerm(), int: this.loud.integrated(), tp: linToDb(this.tp), l: this.pl, r: this.pr, gr: this.grMin });
      this.pl = 0; this.pr = 0; this.grMin = 0;
    }
    return true;
  }
}
registerProcessor('master-fx', MasterFx);
