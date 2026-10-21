// 내보내기: 전체 믹스 한 파일, 또는 트랙별 파일을 zip 하나로
import { renderRange } from './render.js';
import { WavWriter, Mp3Writer, zip, download } from './filewrite.js';

const safe = (s) => (s || '').replace(/[\\/:*?"<>|]/g, '_').trim();

// 트랙별 파일용 마스터: 마스터 처리는 빼고 입력 음량과 공용 리버브만 남김
function stemMaster(mm) {
  const m = structuredClone(mm);
  m.low.on = false; m.eq.on = false; m.space.on = false; m.tamer.on = false; m.glue.on = false;
  m.lim = { ...m.lim, on: false, gainOnly: true };
  return m;
}

export async function exportAudio(E, opt, onProgress) {
  const { scope, tracks, fmt, bits, meta, srt } = opt;
  const dur = E.duration;
  const ext = fmt === 'mp3' ? 'mp3' : 'wav';
  const base = safe(meta.title) || 'mix';
  const make = (m) => (fmt === 'mp3' ? new Mp3Writer(m) : new WavWriter(dur, bits, m));
  let clipped = 0;
  if (scope === 'mix') {
    const w = make(meta);
    await renderRange(E, 0, dur, (L, R) => w.push(L, R), { only: tracks, onProgress });
    const blob = await w.finish();
    clipped = w.clipped;
    download(blob, `${base}.${ext}`);
    if (srt) setTimeout(() => download(new Blob([srt], { type: 'application/x-subrip' }), `${base}.srt`), 800);
    return { files: 1 + (srt ? 1 : 0), clipped, size: blob.size };
  }
  // 트랙별: 한 번 만들어 보고, 0dB를 넘는 트랙이 있으면 모든 트랙을 같은 만큼 낮춰 다시 만든다(트랙 사이 비율 유지)
  const mm = stemMaster(E.mm);
  let files, lowered = 0;
  for (let pass = 0; pass < 2; pass++) {
    files = []; clipped = 0;
    let peak = 0;
    for (let k = 0; k < tracks.length; k++) {
      const t = tracks[k];
      const w = make({ ...meta, title: meta.title ? `${meta.title} - ${t.name}` : t.name, lyrics: '', art: meta.art });
      await renderRange(E, 0, dur, (L, R) => w.push(L, R), { only: [t], mm, onProgress: (p) => onProgress && onProgress((pass * tracks.length + k + p) / (tracks.length * (pass ? 2 : 1)), pass) });
      files.push({ name: `${String(k + 1).padStart(2, '0')} ${safe(t.name)}.${ext}`, blob: await w.finish() });
      clipped += w.clipped;
      peak = Math.max(peak, w.max);
    }
    if (!clipped || pass) break;
    lowered = Math.ceil((20 * Math.log10(peak) + 0.3) * 10) / 10;
    mm.lim.gainDb -= lowered;
  }
  if (srt) files.push({ name: `${base}.srt`, blob: new Blob([srt]) });
  const z = await zip(files);
  download(z, `${base} 트랙별.zip`);
  return { files: files.length, clipped, size: z.size, lowered };
}
