// 자동 분석: 측정값으로 트랙·마스터 설정을 정한다. 결과는 출발점이고 미세조정은 사람이 한다.
import { renderRange } from './render.js';
import { Stats, integrate } from './stats.js';
import { Loudness } from './dsp.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const half = (v) => Math.round(v * 2) / 2;
const WET_DB = 14, DRY_DB = 24;   // 50ms 크기 분포 폭(dB): 이보다 좁으면 젖음, 넓으면 마름

// 악기별 기준값: 보컬 대비 목표 음량, 저역·고역 비율 목표, 로우컷, 압축, 어택, 패닝, 리버브
const CAT = {
  vocal:   { off: 0,   low: -9, pres: -4,  hp: 90,  comp: 0.35, trans: 0,     pan: 0,     send: 0.15 },
  backing: { off: -7,  low: -9, pres: -5,  hp: 120, comp: 0.3,  trans: 0,     pan: 0,     send: 0.25 },
  drums:   { off: -2,  low: 2,  pres: -6,  hp: 0,   comp: 0.25, trans: -0.35, pan: 0,     send: 0.05 },
  perc:    { off: -9,  low: -6, pres: -5,  hp: 80,  comp: 0.2,  trans: -0.25, pan: 0.1,   send: 0.1 },
  bass:    { off: -3,  low: 8,  pres: -18, hp: 0,   comp: 0.4,  trans: 0,     pan: 0,     send: 0 },
  guitar:  { off: -5,  low: -6, pres: -6,  hp: 80,  comp: 0.2,  trans: 0,     pan: 0.1,   send: 0.15 },
  keys:    { off: -5,  low: -4, pres: -8,  hp: 60,  comp: 0.2,  trans: 0,     pan: -0.1,  send: 0.25 },
  synth:   { off: -6,  low: -5, pres: -7,  hp: 60,  comp: 0.15, trans: 0,     pan: -0.15, send: 0.15 },
  strings: { off: -6,  low: -6, pres: -8,  hp: 70,  comp: 0.15, trans: 0,     pan: 0.1,   send: 0.3 },
  brass:   { off: -6,  low: -8, pres: -5,  hp: 90,  comp: 0.25, trans: 0,     pan: -0.1,  send: 0.2 },
  wood:    { off: -7,  low: -10, pres: -6, hp: 100, comp: 0.2,  trans: 0,     pan: 0.15,  send: 0.25 },
  fx:      { off: -10, low: -5, pres: -7,  hp: 100, comp: 0,    trans: 0,     pan: 0,     send: 0.1 },
  other:   { off: -6,  low: -5, pres: -7,  hp: 50,  comp: 0.2,  trans: 0,     pan: 0,     send: 0.15 },
};

// 모든 트랙 측정 (워커). 결과를 t.ana, E.ana에 넣는다.
export function measureTracks(E, onProgress) {
  return new Promise((ok, fail) => {
    const w = new Worker('js/analyze-worker.js', { type: 'module' });
    const live = E.tracks.filter((t) => !t.mix.ref);
    const anySolo = live.some((t) => t.solo);
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') { onProgress && onProgress(m.done); return; }
      E.tracks.forEach((t, i) => { t.ana = m.tracks[i]; t.ana.fit = m.fit && m.fit[i] != null ? m.fit[i] : null; });
      E.ana.hasFit = !!m.fit;
      E.ana.rawLufs = m.raw.lufs;
      E.ana.refLufs = m.ref ? m.ref.lufs : null;
      w.terminate();
      ok();
    };
    w.onerror = (e) => { w.terminate(); fail(e); };
    w.postMessage({
      dur: E.duration,
      tracks: E.tracks.map((t) => ({
        file: t.file, ch: t.ch, segs: t.segs, scale: t.scale, ref: t.mix.ref,
        live: !t.mix.ref && !t.muted && (!anySolo || t.solo),
      })),
    });
  });
}

// 원곡 기준 볼륨: 스템 합이 원곡의 대역별·시간별 크기에 가장 가까워지는 값. 가운데 값이 0dB이 되게 옮긴다.
// 반환: 원곡에서 거의 들리지 않는다고 나온 트랙 이름들
export function fitVolumes(E, only) {
  const live = E.tracks.filter((t) => !t.mix.ref && t.ana && t.ana.fit != null);
  if (!live.length) return null;
  const db = live.map((t) => (t.ana.fit > 1e-6 ? 10 * Math.log10(t.ana.fit) : -Infinity));
  const fin = db.filter(isFinite).sort((a, b) => a - b);
  const mid = fin.length ? fin[Math.floor(fin.length / 2)] : 0;
  const quiet = [];
  live.forEach((t, i) => {
    if (only && t !== only) return;
    const v = db[i] - mid;
    if (!isFinite(v) || v < -24) quiet.push(t.name);
    t.volumeDb = half(clamp(isFinite(v) ? v : -24, -24, 12));
  });
  return quiet;
}

// 트랙 하나의 설정 제안
export function suggestTrack(E, t) {
  const a = t.ana;
  if (!a || !isFinite(a.lufs)) return false;
  const c = CAT[t.cat] || CAT.other;
  const m = t.mix;
  // 볼륨: 다른 트랙들로 추정한 보컬 기준 음량에 맞추되 절반만, ±4dB 안에서 (원래 밸런스를 크게 해치지 않게)
  const implied = E.tracks.filter((x) => !x.mix.ref && x.ana && isFinite(x.ana.lufs)).map((x) => x.ana.lufs - (CAT[x.cat] || CAT.other).off).sort((p, q) => p - q);
  const refV = implied[Math.floor(implied.length / 2)];
  if (a.fit != null) fitVolumes(E, t);   // 원곡이 있으면 원곡 속 크기를 따른다 (이 트랙만)
  else t.volumeDb = half(clamp((refV + c.off - a.lufs) * 0.5, -4, 4));
  m.low = { on: c.hp > 0, hz: c.hp || 80 };
  const b = a.bands;
  const lowRel = b.low - b.mid, presRel = b.pres - b.mid, airRel = b.air - b.pres;
  const lowG = half(clamp((c.low - lowRel) * 0.35, -3, 3));
  const highG = half(clamp((c.pres - presRel) * 0.35, -3, 3));
  m.eq = { on: Math.abs(lowG) >= 0.5 || Math.abs(highG) >= 0.5, low: lowG, mid: 0, high: highG };
  const harsh = ['vocal', 'backing', 'synth', 'keys', 'strings', 'guitar', 'brass', 'wood', 'other'].includes(t.cat);
  m.tamer = {
    on: t.cat !== 'bass',
    mid: harsh ? +clamp(0.2 + (presRel - (c.pres + 3)) * 0.1, 0, 0.6).toFixed(2) : 0.1,
    air: t.cat === 'bass' ? 0 : +clamp(0.2 + (airRel + 15) * 0.03, 0, 0.6).toFixed(2),
  };
  m.comp = { on: c.comp > 0 || c.trans !== 0, amt: +clamp(c.comp + (a.crest > 18 ? 0.1 : 0), 0, 1).toFixed(2), trans: c.trans };
  // 좌우 뒤집힘 바로잡기, 좌우가 따로 노는 넓음은 좁히기 (넓히지는 않음)
  setWidth(E, t);
  // 잔향이 이미 많이 들어간 스템(크기 변화 폭이 좁음)은 공용 리버브를 줄이거나 보내지 않는다
  const sp = a.spread;
  const wet = sp == null ? 0 : sp < WET_DB ? 1 : sp < DRY_DB ? (DRY_DB - sp) / (DRY_DB - WET_DB) : 0;
  m.send = +(c.send * (1 - wet)).toFixed(2);
  t.ana.wet = wet;
  return true;
}

// 넓이 단계별: 패닝을 얼마나 벌릴지, 트랙 좌우 상관 목표를 얼마나 너그럽게 둘지, 마스터 폭
const SPREAD = { orig: { pan: 0.4, corr: 0.03, width: 1 }, some: { pan: 0.8, corr: -0.1, width: 1.15 }, wide: { pan: 1.15, corr: -0.2, width: 1.3 } };
// 넓게 벌릴 때의 악기별 자리 (부호는 먼저 가려는 쪽, 0은 가운데 고정)
const PAN_WIDE = { vocal: 0, backing: 0, drums: 0, bass: 0, perc: 0.35, guitar: 0.45, keys: -0.4, synth: -0.5, strings: 0.35, brass: -0.35, wood: 0.4, fx: 0, other: -0.25 };
// 좌우 상관 목표 (1이면 모노). 이보다 넓게 퍼진 스템만 좁힌다
const CORR = { vocal: 0.95, backing: 0.5, drums: 0.9, perc: 0.6, bass: 0.98, guitar: 0.6, keys: 0.6, synth: 0.5, strings: 0.5, brass: 0.6, wood: 0.6, fx: 0.4, other: 0.6 };

export function setWidth(E, t) {
  const a = t.ana;
  if (!a || a.corr == null) return;
  const sp = SPREAD[E.mm.spread] || SPREAD.some;
  let corr = a.corr, q = a.msRatio;
  t.mix.flip = corr < -0.3;
  if (t.mix.flip) { corr = -corr; q = q > 0 ? 1 / q : 0; }
  const ct = Math.min(0.99, (CORR[t.cat] ?? 0.6) + sp.corr);
  const w = q > 0 ? Math.sqrt((1 - ct) / ((1 + ct) * q)) : 1;
  t.mix.width = +Math.min(1, w).toFixed(2);
}

// 볼륨까지 반영한 트랙 크기
const lev = (t) => (t.ana?.lufs ?? -30) + (t.volumeDb || 0);

// 패닝 자리 나누기: 가운데가 아닌 트랙을 큰 소리부터 좌우 번갈아 놓아 양쪽 무게를 맞춘다
export function applySpread(E, list) {
  const sp = SPREAD[E.mm.spread] || SPREAD.some;
  const live = E.tracks.filter((t) => !t.mix.ref);
  const side = live.filter((t) => (PAN_WIDE[t.cat] ?? PAN_WIDE.other) !== 0)
    .sort((x, y) => lev(y) - lev(x));
  let bal = 0;   // 지금까지 왼쪽(-)·오른쪽(+) 무게
  for (const t of side) {
    const base = PAN_WIDE[t.cat] ?? PAN_WIDE.other;
    const want = Math.sign(base);
    const dir = bal === 0 ? want : bal > 0 ? -1 : 1;
    const pan = +(dir * Math.min(0.6, Math.abs(base) * sp.pan)).toFixed(2);
    bal += dir * Math.pow(10, lev(t) / 10);
    if (!list || list.includes(t)) t.mix.pan = pan;
  }
  for (const t of live) if ((PAN_WIDE[t.cat] ?? PAN_WIDE.other) === 0 && (!list || list.includes(t))) t.mix.pan = 0;
  balancePans(live);
  for (const t of live) if (!list || list.includes(t)) setWidth(E, t);
  E.mm.space.width = sp.width;
}

// 패닝 후 좌우 크기를 어림해(패너는 스테레오 소리를 한쪽으로 밀어 넣는다) 무거운 쪽 패닝을 줄여 ±0.5dB 안으로
function balancePans(live) {
  const lr = (k) => {
    let L = 0, R = 0;
    for (const t of live) {
      const e = Math.pow(10, lev(t) / 10);
      // 폭을 줄인 뒤의 가운데·옆 에너지
      let q = t.ana?.msRatio ?? 0;
      if (t.mix.flip && q > 0) q = 1 / q;
      q *= (t.mix.width ?? 1) ** 2;
      const mid = e / (1 + q), side = e * q / (1 + q);
      let p = t.mix.pan;
      if ((p > 0 && k > 0) || (p < 0 && k < 0)) p *= 1 - Math.abs(k);
      const a = (p + 1) * Math.PI / 4;
      L += mid * Math.cos(a) ** 2 + side / 2;
      R += mid * Math.sin(a) ** 2 + side / 2;
    }
    return 10 * Math.log10(L / R);
  };
  const d0 = lr(0);
  if (Math.abs(d0) <= 0.5) return;
  const heavy = d0 < 0 ? 1 : -1;            // 오른쪽이 무거우면 오른쪽(+) 패닝을 줄임
  let lo = 0, hi = 1;
  for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (Math.abs(lr(heavy * mid)) > 0.5 && Math.sign(lr(heavy * mid)) === Math.sign(d0)) lo = mid; else hi = mid; }
  const k = hi;
  for (const t of live) if (Math.sign(t.mix.pan) === heavy) t.mix.pan = +(t.mix.pan * (1 - k)).toFixed(2);
}

// 전체 마스터: 곡 곳곳 네 군데(각 5초)를 실제 처리로 계산해 목표 음량에 맞춘다
export async function autoMaster(E, onProgress) {
  const mm = E.mm;
  const SR = 44100;
  const dur = E.duration;
  const SL = Math.min(5 * SR, dur), NS = dur > 30 * SR ? 4 : 1;
  const starts = [];
  for (let k = 0; k < NS; k++) starts.push(Math.round(NS === 1 ? 0 : (dur * (0.08 + 0.84 * k / (NS - 1))) - SL / 2));

  mm.low = { on: true, hz: 30 };
  mm.space = { on: true, width: (SPREAD[mm.spread] || SPREAD.some).width, monoHz: 120 };
  mm.tamer = { on: true, mid: 0.2, air: 0.3 };
  mm.glue = { on: true, amt: 0.3 };
  mm.eq = { on: false, low: 0, mid: 0, high: 0 };
  mm.lim = { ...mm.lim, on: true, gainDb: 0 };

  const PASSES = 4;
  const measure = async (pass) => {
    const s = new Stats();
    const blocks = [];
    for (let k = 0; k < starts.length; k++) {
      const a = Math.max(0, starts[k]), b = Math.min(dur, a + SL);
      const L = new Loudness(SR);
      s.restart();
      await renderRange(E, a, b, (l, r) => { s.push(l, r, 1); for (let i = 0; i < l.length; i++) L.push(l[i], r[i]); }, { mm, pre: SR });
      blocks.push(...L.blocks);
      onProgress && onProgress((pass * starts.length + k + 1) / (PASSES * starts.length));
    }
    const res = s.result();
    res.lufs = integrate(blocks);
    return res;
  };
  // 1차: 처리 결과의 음색과 음량을 보고 마스터 EQ와 입력 음량을 정한다
  const r1 = await measure(0);
  const bb = r1.bands;
  const lowG = half(clamp((2 - (bb.low - bb.mid)) * 0.3, -2, 2));
  const highG = half(clamp((-3 - (bb.pres - bb.mid)) * 0.3, -2, 2));
  mm.eq = { on: Math.abs(lowG) >= 0.5 || Math.abs(highG) >= 0.5, low: lowG, mid: 0, high: highG };
  // 이후: 리미터 때문에 입력을 바꾼 만큼 결과가 바뀌지 않으므로, 두 측정 사이 기울기로 다음 값을 정한다
  let gPrev = 0, rPrev = r1.lufs, r = r1;
  mm.lim.gainDb = +clamp(mm.lim.target - r1.lufs, -20, 24).toFixed(1);
  for (let k = 1; k < PASSES; k++) {
    r = await measure(k);
    const err = mm.lim.target - r.lufs;
    if (Math.abs(err) < 0.3) { onProgress && onProgress(1); break; }
    const g = mm.lim.gainDb;
    const slope = g !== gPrev ? clamp((r.lufs - rPrev) / (g - gPrev), 0.2, 1) : 1;
    gPrev = g; rPrev = r.lufs;
    mm.lim.gainDb = +clamp(g + err / slope, -20, 24).toFixed(1);
  }
  E.ana.procLufs = mm.lim.target;
  E.ana.masterCheck = { est: r.lufs, tp: r.peak };
}
