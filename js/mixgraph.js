// 트랙·마스터 처리 연결. 실시간 재생과 파일 만들기(오프라인)가 같은 구성을 쓴다.
import { dbToLin } from './dsp.js';
import { toneFir } from './tone.js';

export const trackDefaults = () => ({
  ref: false,
  pan: 0, send: 0, width: 1, flip: false,
  low: { on: false, hz: 80 },
  eq: { on: false, low: 0, mid: 0, high: 0 },
  tamer: { on: false, mid: 0, air: 0 },
  comp: { on: false, amt: 0, trans: 0 },
  duck: { on: false, depth: 4 },
  lim: { on: false, ceil: -1 },
});

export const masterDefaults = () => ({
  low: { on: true, hz: 30 },
  eq: { on: false, low: 0, mid: 0, high: 0 },
  tone: { on: false, amt: 0.7, mid: null, side: null },   // 원곡 음색 맞추기 곡선 (dB, TONE_F 지점마다)
  space: { on: true, width: 1, monoHz: 120 },
  spread: 'some',         // 넓이: orig | some | wide
  tamer: { on: false, mid: 0, air: 0 },
  glue: { on: false, amt: 0 },
  lim: { on: true, target: -14, ceil: -1, gainDb: 0 },
  verb: { on: true, size: 1.8, ret: 0, duck: { on: false, depth: 4 } },
});

export const EQF = { low: 120, mid: 1000, high: 8000 };

function biquad(ctx, type, f, q) {
  const b = ctx.createBiquadFilter();
  b.type = type; b.frequency.value = f; b.Q.value = q;
  return b;
}

export function buildTrackChain(ctx, p0) {
  const trim = ctx.createGain();
  const hp = biquad(ctx, 'highpass', 10, 0.707);
  const ls = biquad(ctx, 'lowshelf', EQF.low, 0.7);
  const pk = biquad(ctx, 'peaking', EQF.mid, 0.8);
  const hs = biquad(ctx, 'highshelf', EQF.high, 0.7);
  const fx = new AudioWorkletNode(ctx, 'track-fx', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { p: p0 } });
  const pan = ctx.createStereoPanner();
  const fader = ctx.createGain();
  const send = ctx.createGain();
  send.gain.value = 0;
  trim.connect(hp).connect(ls).connect(pk).connect(hs).connect(fx, 0, 0);
  fx.connect(pan).connect(fader);
  fader.connect(send);
  return { input: trim, trim, hp, ls, pk, hs, fx, pan, fader, send, out: fader };
}

export function trackFxParams(m, raw, ref) {
  return {
    bypass: raw,
    tamer: m.tamer,
    comp: { on: m.comp.on, amt: m.comp.amt, ref },
    trans: { on: m.comp.on, amt: m.comp.trans },
    duck: { on: m.duck.on, depth: m.duck.depth, key: 'kick' },
    lim: m.lim,
    st: { width: m.width ?? 1, flip: !!m.flip, pan: m.pan || 0 },
  };
}

// 설정을 처리 연결에 반영. raw면 모든 처리를 끈 상태. now가 true면 바로 바꾼다(파일 만들기용).
const setter = (ctx, now) => (param, v) => { if (now) param.value = v; else param.setTargetAtTime(v, ctx.currentTime, 0.015); };

export function applyTrack(ch, m, raw, ctx, ref, now) {
  const set = setter(ctx, now);
  const on = !raw;
  set(ch.hp.frequency, on && m.low.on ? m.low.hz : 10);
  set(ch.ls.gain, on && m.eq.on ? m.eq.low : 0);
  set(ch.pk.gain, on && m.eq.on ? m.eq.mid : 0);
  set(ch.hs.gain, on && m.eq.on ? m.eq.high : 0);
  if (!now) ch.fx.port.postMessage(trackFxParams(m, raw, ref));
  set(ch.pan.pan, 0);   // 패닝은 track-fx 안에서 한다
  set(ch.send.gain, on ? m.send * 0.8 : 0);
}

export function masterFxParams(mm, raw, matchDb = 0) {
  return {
    bypass: raw,
    bypassGainDb: matchDb,
    inGainDb: mm.lim.on || mm.lim.gainOnly ? mm.lim.gainDb : 0,
    ms: mm.space,
    tamer: mm.tamer,
    glue: { on: mm.glue.on, amt: mm.glue.amt, ref: mm.lim.target },
    lim: { on: mm.lim.on, ceil: mm.lim.ceil },
  };
}
const verbDuckParams = (mm) => ({ duck: { on: mm.verb.duck.on, depth: mm.verb.duck.depth, key: 'vocal' } });

export function buildMaster(ctx, dest, mm) {
  const sum = ctx.createGain();
  const hp = biquad(ctx, 'highpass', 30, 0.707);
  const ls = biquad(ctx, 'lowshelf', EQF.low, 0.7);
  const pk = biquad(ctx, 'peaking', EQF.mid, 0.8);
  const hs = biquad(ctx, 'highshelf', EQF.high, 0.7);
  const mfx = new AudioWorkletNode(ctx, 'master-fx', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { p: mm ? masterFxParams(mm, false) : undefined } });
  const match = ctx.createGain();
  sum.connect(hp).connect(ls).connect(pk).connect(hs);
  // 원곡 음색 맞추기: 미드·사이드로 나눠 각각 FIR을 거친 뒤 다시 좌우로. 꺼져 있으면 dry로만
  const mono = (g = 1) => { const n = ctx.createGain(); n.gain.value = g; n.channelCount = 1; n.channelCountMode = 'explicit'; return n; };
  const split = ctx.createChannelSplitter(2);
  const mIn = mono(), sIn = mono(), rNeg = mono(-1);
  hs.connect(split);
  split.connect(mIn, 0); split.connect(mIn, 1);
  split.connect(sIn, 0); split.connect(rNeg, 1); rNeg.connect(sIn);
  mIn.gain.value = 0.5; sIn.gain.value = 0.5;
  const mkConv = () => { const c = ctx.createConvolver(); c.normalize = false; c.channelCount = 1; c.channelCountMode = 'explicit'; return c; };
  const cM = mkConv(), cS = mkConv();
  mIn.connect(cM); sIn.connect(cS);
  const outL = mono(), outR = mono(), sNeg = mono(-1);
  cM.connect(outL); cS.connect(outL);
  cM.connect(outR); cS.connect(sNeg).connect(outR);
  const merge = ctx.createChannelMerger(2);
  outL.connect(merge, 0, 0); outR.connect(merge, 0, 1);
  const toneWet = ctx.createGain(), toneDry = ctx.createGain();
  toneWet.gain.value = 0;
  merge.connect(toneWet).connect(mfx);
  hs.connect(toneDry).connect(mfx);
  mfx.connect(match).connect(dest);
  // 공용 리버브: 저역·고역을 잘라 넣고, 보컬이 나올 때 살짝 누를 수 있게 track-fx를 하나 거친다
  const vin = ctx.createGain();
  const vhp = biquad(ctx, 'highpass', 300, 0.707);
  const vlp = biquad(ctx, 'lowpass', 5000, 0.707);
  const conv = ctx.createConvolver();
  const vduck = new AudioWorkletNode(ctx, 'track-fx', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { p: mm ? verbDuckParams(mm) : undefined } });
  const vret = ctx.createGain();
  vin.connect(vhp).connect(vlp).connect(conv).connect(vduck, 0, 0);
  vduck.connect(vret).connect(sum);
  const vocalKey = ctx.createGain();
  vocalKey.connect(vduck, 0, 1);
  const drumKey = ctx.createGain();
  return { sum, hp, ls, pk, hs, mfx, match, vin, conv, vduck, vret, vocalKey, drumKey, verbSize: 0, cM, cS, toneWet, toneDry, toneKey: '' };
}

export function makeIR(ctx, seconds) {
  const fs = ctx.sampleRate, n = Math.round(seconds * fs), pre = Math.round(0.012 * fs);
  const buf = ctx.createBuffer(2, n + pre, fs);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    let seed = c ? 987654321 : 123456789;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = seed / 4294967296 * 2 - 1;
      const t = i / fs;
      lp += (noise - lp) * Math.max(0.15, 0.9 - t / seconds * 0.7);   // 꼬리로 갈수록 어둡게
      d[pre + i] = lp * Math.exp(-6.9 * t / seconds);
    }
  }
  return buf;
}

export function applyMaster(M, mm, raw, ctx, matchDb, now) {
  const set = setter(ctx, now);
  const on = !raw;
  set(M.hp.frequency, on && mm.low.on ? mm.low.hz : 10);
  set(M.ls.gain, on && mm.eq.on ? mm.eq.low : 0);
  set(M.pk.gain, on && mm.eq.on ? mm.eq.mid : 0);
  set(M.hs.gain, on && mm.eq.on ? mm.eq.high : 0);
  if (!now) {
    M.mfx.port.postMessage(masterFxParams(mm, raw, isFinite(matchDb) ? matchDb : 0));
    M.vduck.port.postMessage(verbDuckParams(mm));
  }
  if (M.verbSize !== mm.verb.size) { M.verbSize = mm.verb.size; M.conv.buffer = makeIR(ctx, mm.verb.size); }
  set(M.vret.gain, on && mm.verb.on !== false ? dbToLin(mm.verb.ret) : 0);
  set(M.match.gain, isFinite(matchDb) ? 1 : 0);   // 원곡 비교 때는 믹스를 끈다
  const T = mm.tone || {};
  const toneOn = on && T.on && T.mid && T.side;
  if (toneOn) {
    const key = `${T.amt}|${T.mid}|${T.side}`;
    if (M.toneKey !== key) {
      M.toneKey = key;
      const buf = (c) => { const h = toneFir(c, T.amt); const b = ctx.createBuffer(1, h.length, ctx.sampleRate); b.copyToChannel(h, 0); return b; };
      M.cM.buffer = buf(T.mid); M.cS.buffer = buf(T.side);
    }
  }
  set(M.toneWet.gain, toneOn ? 1 : 0);
  set(M.toneDry.gain, toneOn ? 0 : 1);
}
