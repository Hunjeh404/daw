// 오프라인 렌더링: 실시간과 같은 처리 연결로 구간을 계산한다.
// 메모리를 아끼려고 12초씩 나눠 계산하고, 각 조각 앞의 소리를 미리 돌려 컴프·리버브 상태를 이어 붙인다.
import { buildTrackChain, applyTrack, trackFxParams, spatialMix, spreadShift, buildMaster, applyMaster, sendAmt } from './mixgraph.js';
import { fadeBuffer } from './fades.js';
import { readWindow } from './pcm.js';
import { dbToLin } from './dsp.js';

const SR = 44100;
const PRE_DEFAULT = 2 * SR, CHUNK = 12 * SR;

export async function renderRange(E, a, b, onChunk, opt = {}) {
  if (E.guidedPending) throw Error('원곡과 스템을 다시 연결하세요.');
  const mm = opt.mm || E.mm;
  const live = E.tracks.filter((t) => !t.mix.ref);
  const anySolo = live.some((t) => t.solo);
  // only가 있으면 그 트랙들만(음소거·솔로 무시), 없으면 지금 들리는 트랙들
  const use = opt.only ? live.filter((t) => opt.only.includes(t)) : live.filter((t) => !t.muted && (!anySolo || t.solo));
  const tail = opt.tail || 0;
  const wet = mm.verb.on !== false && use.some((t) => sendAmt(t.mix) > 0);
  // 긴 리버브도 조각 경계 너머까지 이어지도록 실제 임펄스 응답 길이를 포함한다.
  const pre = opt.pre ?? Math.max(PRE_DEFAULT, wet ? Math.ceil((mm.verb.size + 0.012) * SR) : 0);
  for (let c0 = a; c0 < b; c0 += CHUNK) {
    const c1 = Math.min(b, c0 + CHUNK);
    const w0 = Math.max(tail ? a : 0, c0 - pre);
    // 마지막 조각에서만 입력이 끝난 뒤에도 같은 효과 연결을 계속 돌린다.
    const len = c1 - w0 + (c1 === b ? tail : 0);
    const ctx = new OfflineAudioContext(2, len, SR);
    await ctx.audioWorklet.addModule('js/fx-worklet.js');
    const M = buildMaster(ctx, ctx.destination, mm);
    applyMaster(M, mm, false, ctx, 0, true);
    const fullMix = !opt.isolated && (opt.only ? use.length === live.length : !anySolo && use.length > 0);
    if (E.guided && !E.guided.automatic && fullMix) {
      const view = E.srcView({ segs: E.bedSegments() });
      const [l, r] = await readWindow(view, w0, c1);
      if (opt.inputFade) fadeBuffer(l, r, w0, opt.inputFade);
      const buffer = ctx.createBuffer(2, l.length, SR);
      buffer.copyToChannel(l, 0); buffer.copyToChannel(r, 1);
      const bed = ctx.createBufferSource();
      bed.buffer = buffer; bed.connect(M.sum); bed.start();
    }
    for (const t of use) {
      const ref = t.ana?.lufs ?? -20;
      const mix = spatialMix(t, mm, spreadShift(E, mm));
      const fxc = buildTrackChain(ctx, trackFxParams(mix, false, ref));
      applyTrack(fxc, mix, false, ctx, ref, true);
      fxc.fader.gain.value = dbToLin(t.volumeDb);
      const [L, R] = await readWindow(E.srcView(t), w0, c1);
      if (opt.inputFade) fadeBuffer(L, R, w0, opt.inputFade);
      const buf = ctx.createBuffer(2, L.length, SR);
      buf.copyToChannel(L, 0); buf.copyToChannel(R, 1);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(fxc.input);
      src.start(0);
      fxc.out.connect(M.sum);
      fxc.send.connect(M.vin);
      if (t.cat === 'drums') fxc.out.connect(M.drumKey);
      else M.drumKey.connect(fxc.fx, 0, 1);
      if (t.cat === 'vocal') fxc.out.connect(M.vocalKey);
    }
    const out = await ctx.startRendering();
    const skip = c0 - w0;
    await onChunk(out.getChannelData(0).subarray(skip), out.getChannelData(1).subarray(skip), c0);
    if (opt.onProgress) opt.onProgress((c1 - a) / (b - a));
  }
}
