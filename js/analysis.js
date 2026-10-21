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
  m.pan = c.pan;
  // 잔향이 이미 많이 들어간 스템(크기 변화 폭이 좁음)은 공용 리버브를 줄이거나 보내지 않는다
  const sp = a.spread;
  const wet = sp == null ? 0 : sp < WET_DB ? 1 : sp < DRY_DB ? (DRY_DB - sp) / (DRY_DB - WET_DB) : 0;
  m.send = +(c.send * (1 - wet)).toFixed(2);
  t.ana.wet = wet;
  return true;
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
  mm.space = { on: true, width: 1, monoHz: 120 };
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
