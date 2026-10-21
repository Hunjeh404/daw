// 오프라인 렌더링: 실시간과 같은 처리 연결로 구간을 계산한다.
// 메모리를 아끼려고 12초씩 나눠 계산하고, 각 조각 앞 2초를 미리 돌려 컴프·리버브 상태를 이어 붙인다.
import { buildTrackChain, applyTrack, trackFxParams, buildMaster, applyMaster } from './mixgraph.js';
import { readWindow } from './pcm.js';
import { dbToLin } from './dsp.js';

const SR = 44100;
const PRE_DEFAULT = 2 * SR, CHUNK = 12 * SR;

export async function renderRange(E, a, b, onChunk, opt = {}) {
  const mm = opt.mm || E.mm;
  const live = E.tracks.filter((t) => !t.mix.ref);
  const anySolo = live.some((t) => t.solo);
  const use = live.filter((t) => !t.muted && (!anySolo || t.solo) && (!opt.only || opt.only.includes(t)));
  for (let c0 = a; c0 < b; c0 += CHUNK) {
    const c1 = Math.min(b, c0 + CHUNK);
    const w0 = Math.max(0, c0 - (opt.pre ?? PRE_DEFAULT));
    const len = c1 - w0;
    const ctx = new OfflineAudioContext(2, len, SR);
    await ctx.audioWorklet.addModule('js/fx-worklet.js');
    const M = buildMaster(ctx, ctx.destination, mm);
    applyMaster(M, mm, false, ctx, 0, true);
    for (const t of use) {
      const ref = t.ana?.lufs ?? -20;
      const fxc = buildTrackChain(ctx, trackFxParams(t.mix, false, ref));
      fxc.trim.gain.value = t.scale;
      applyTrack(fxc, t.mix, false, ctx, ref, true);
      fxc.fader.gain.value = dbToLin(t.volumeDb);
      const [L, R] = await readWindow(t, w0, c1);
      const buf = ctx.createBuffer(2, len, SR);
      buf.copyToChannel(L, 0); buf.copyToChannel(R, 1);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(fxc.input);
      src.start(0);
      fxc.out.connect(M.sum);
      fxc.send.connect(M.vin);
      M.drumKey.connect(fxc.fx, 0, 1);
      if (t.cat === 'drums') fxc.out.connect(M.drumKey);
      if (t.cat === 'vocal') fxc.out.connect(M.vocalKey);
    }
    const out = await ctx.startRendering();
    const skip = c0 - w0;
    await onChunk(out.getChannelData(0).subarray(skip), out.getChannelData(1).subarray(skip), c0);
    if (opt.onProgress) opt.onProgress((c1 - a) / (b - a));
  }
}
