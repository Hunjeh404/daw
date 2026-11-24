// 미디 → 소리: 키트 샘플(세기별·번갈아 치기)이나 코드 합성으로 OfflineAudioContext에서 한 번에 굽는다.
import { parseMidi, dropDoubles } from './midi.js';

export const KITS = {
  drums: [['drum-909', '909 계열'], ['drum-acoustic', '어쿠스틱'], ['drum-lofi', '로파이']],
  bass: [['bass-finger', '핑거'], ['bass-synth', '신스'], ['bass-808', '808 서브']],
};
export const defaultKit = (kind, m) => {
  if (kind === 'drums') return 'drum-909';
  const prog = m.programs.find((x) => x.ch !== 9)?.prog;
  return prog === 38 || prog === 39 ? 'bass-synth' : 'bass-finger';
};
export const kitName = (id) => Object.values(KITS).flat().find((k) => k[0] === id)?.[1] || id;

const TAIL = 2.5;                 // 마지막 음 뒤로 남기는 시간(초) — 키트를 바꿔도 길이가 같게 미디로만 정한다
const cache = new Map();

async function loadKit(ctx, id) {
  if (cache.has(id)) return cache.get(id);
  const job = (async () => {
    const base = `kits/${id}/`;
    const res = await fetch(base + 'kit.json');
    if (!res.ok) throw new Error('키트를 받지 못했습니다');
    const kit = await res.json();
    const lists = kit.type === 'drums' ? Object.values(kit.pieces) : kit.zones;
    await Promise.all(lists.map(async (pc) => {
      pc.buf = await Promise.all(pc.layers.map((row) => Promise.all(row.map(async (f) => {
        const r = await fetch(base + f);
        if (!r.ok) throw new Error('키트 샘플을 받지 못했습니다');
        return ctx.decodeAudioData(await r.arrayBuffer());
      }))));
    }));
    return kit;
  })();
  cache.set(id, job);
  job.catch(() => cache.delete(id));
  return job;
}

// 세기 → 층 번호와 층 안에서의 크기
function layerOf(vel, n) {
  if (n === 1) return [0, 0.2 + 0.8 * (vel / 127) ** 2];
  const li = Math.min(n - 1, Math.floor(vel * n / 128));
  const lo = li * 128 / n, hi = (li + 1) * 128 / n;
  return [li, 0.72 + 0.28 * (vel - lo) / (hi - lo)];
}

// 각 함수는 음 하나를 받아 소리를 거는 함수를 돌려준다 (돌려준 값이 false면 못 낸 음)
function drums(ctx, kit) {
  const out = ctx.destination;
  const rr = new Map();
  const ringing = new Map();      // 끊길 수 있는 조각 → 울리고 있는 소리들
  return (n) => {
    const map = kit.notes[n.note];
    const pc = map && kit.pieces[map[0]];
    if (!pc) return false;
    const name = map[0];
    // 닫힌 하이햇·페달이 나오면 열린 하이햇을 끊는다
    for (const [open, by] of Object.entries(kit.choke || {})) {
      if (!by.includes(name)) continue;
      for (const v of ringing.get(open) || []) {
        if (v.end <= n.t) continue;
        v.g.gain.setTargetAtTime(0, n.t, 0.012);
        v.s.stop(n.t + 0.1);
        v.end = n.t;
      }
      ringing.set(open, []);
    }
    const [li, g] = layerOf(n.vel, pc.buf.length);
    const row = pc.buf[li];
    const k = name + li;
    const i = rr.get(k) || 0;
    rr.set(k, i + 1);
    const buf = row[i % row.length];
    const s = ctx.createBufferSource();
    s.buffer = buf;
    if (map[1]) s.playbackRate.value = 2 ** (map[1] / 12);
    const gn = ctx.createGain();
    gn.gain.value = g * pc.gain;
    s.connect(gn).connect(out);
    s.start(n.t);
    if (kit.choke && kit.choke[name]) {
      if (!ringing.has(name)) ringing.set(name, []);
      ringing.get(name).push({ s, g: gn, end: n.t + buf.duration });
    }
    return true;
  };
}

function finger(ctx, kit) {
  const rel = kit.release || 0.08;
  const rr = new Map();
  return (n) => {
    let z = kit.zones[0];
    for (const x of kit.zones) if (Math.abs(x.note - n.note) < Math.abs(z.note - n.note)) z = x;
    const [li, g] = layerOf(n.vel, z.buf.length);
    const k = z.note * 8 + li, i = rr.get(k) || 0;
    rr.set(k, i + 1);
    const s = ctx.createBufferSource();
    s.buffer = z.buf[li][i % z.buf[li].length];
    s.playbackRate.value = 2 ** ((n.note - z.note) / 12);
    const gn = ctx.createGain();
    const v = g * kit.gain;
    gn.gain.setValueAtTime(v, n.t);
    gn.gain.setValueAtTime(v, n.end);
    gn.gain.linearRampToValueAtTime(0, n.end + rel);
    s.connect(gn).connect(ctx.destination);
    s.start(n.t);
    s.stop(n.end + rel + 0.01);
    return true;
  };
}

const hz = (note) => 440 * 2 ** ((note - 69) / 12);

function synth(ctx) {
  const bus = ctx.createGain();
  bus.gain.value = 0.32;
  bus.connect(ctx.destination);
  return (n) => {
    const v = n.vel / 127, f = hz(n.note), end = n.end + 0.06;
    const a = ctx.createOscillator(), b = ctx.createOscillator();
    a.type = 'sawtooth'; b.type = 'square';
    a.frequency.value = f; b.frequency.value = f; b.detune.value = 7;
    const mixB = ctx.createGain(); mixB.gain.value = 0.5;
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass'; flt.Q.value = 5;
    const top = 250 + 2600 * v, rest = 180 + 500 * v;
    flt.frequency.setValueAtTime(top, n.t);
    flt.frequency.setTargetAtTime(rest, n.t + 0.005, 0.09);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, n.t);
    amp.gain.linearRampToValueAtTime(0.4 + 0.6 * v, n.t + 0.004);
    amp.gain.setTargetAtTime((0.4 + 0.6 * v) * 0.7, n.t + 0.004, 0.15);
    amp.gain.setTargetAtTime(0, n.end, 0.018);
    a.connect(flt); b.connect(mixB).connect(flt);
    flt.connect(amp).connect(bus);
    a.start(n.t); b.start(n.t); a.stop(end + 0.1); b.stop(end + 0.1);
    return true;
  };
}

function sub808(ctx) {
  const drive = ctx.createWaveShaper();
  const c = new Float32Array(1024);
  for (let i = 0; i < c.length; i++) { const x = i / 511.5 - 1; c[i] = Math.tanh(2.2 * x) / Math.tanh(2.2); }
  drive.curve = c;
  const bus = ctx.createGain();
  bus.gain.value = 0.6;
  drive.connect(bus).connect(ctx.destination);
  return (n) => {
    const v = n.vel / 127, f = hz(n.note);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f * 2 ** (5 / 12), n.t);
    o.frequency.exponentialRampToValueAtTime(f, n.t + 0.045);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, n.t);
    amp.gain.linearRampToValueAtTime(0.35 + 0.65 * v, n.t + 0.003);
    amp.gain.setTargetAtTime(0.1 + 0.2 * v, n.t + 0.003, 1.1);
    amp.gain.setTargetAtTime(0, n.end, 0.02);
    o.connect(amp).connect(drive);
    o.start(n.t); o.stop(n.end + 0.15);
    return true;
  };
}

// 음을 한꺼번에 걸면 아직 안 울린 소리까지 매 순간 계산해 느려진다.
// 그래서 굽는 도중 WIN초마다 멈춰 그다음 구간 음만 건다.
const WIN = 2;
function schedule(ctx, notes, play) {
  let i = 0, skipped = 0;
  const upTo = (t) => { while (i < notes.length && notes[i].t < t) { if (!play(notes[i])) skipped++; i++; } };
  upTo(WIN);
  for (let k = 1; k * WIN < ctx.length / ctx.sampleRate; k++) {
    ctx.suspend(k * WIN).then(() => { upTo((k + 1) * WIN); ctx.resume(); });
  }
  return () => skipped;
}

// bytes: 미디 파일, kind: 'drums'|'bass', kitId. 돌려주는 값: { buf, notes, dropped, skipped }
export async function renderMidi(liveCtx, bytes, kind, kitId, sr) {
  const m = parseMidi(bytes);
  const { notes, dropped } = dropDoubles(m.notes);
  const lastEnd = notes.reduce((a, n) => Math.max(a, n.end), 0);
  const frames = Math.ceil((lastEnd + TAIL) * sr);
  const ch = kind === 'drums' ? 2 : 1;
  const ctx = new OfflineAudioContext(ch, frames, sr);
  let play;
  if (kitId === 'bass-synth') play = synth(ctx);
  else if (kitId === 'bass-808') play = sub808(ctx);
  else {
    const kit = await loadKit(liveCtx, kitId);
    play = kit.type === 'drums' ? drums(ctx, kit) : finger(ctx, kit);
  }
  const skipped = schedule(ctx, notes, play);
  const buf = await ctx.startRendering();
  return { buf, notes: notes.length, dropped, skipped: skipped() };
}
