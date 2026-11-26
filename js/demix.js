import { colorFor } from './cats.js';
import { newClipId } from './engine.js';

import { preferredModel } from './demix-models.js';
const labels = ['Bass', 'Drums', 'Other', 'Vocals', 'Guitar', 'Piano'];

function run(job, status, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./demix-worker.js', import.meta.url), { type: 'module' });
    const stop = () => { worker.terminate(); signal?.removeEventListener('abort', cancel); };
    const cancel = () => { stop(); reject(signal.reason); };
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onerror = err => { stop(); reject(Error(err.message || '자동 분리가 중단되었습니다.')); };
    worker.onmessage = ({ data }) => {
      if (data.status) { status(data.status); return; }
      stop();
      if (data.error) reject(Object.assign(new Error(data.error), { name: data.name || 'Error', retryCPU: data.retryCPU }));
      else resolve(data.peaks);
    };
    worker.postMessage(job);
  });
}

// Terminating an inference worker is asynchronous. Chromium can briefly hold
// its sync access handles after terminate() returns.
async function removePartial(root, id) {
  for (let attempt = 0; ; attempt++) {
    try { await root.removeEntry(id + '.pcm'); return; }
    catch (err) {
      if (err.name === 'NotFoundError') return;
      if (err.name !== 'NoModificationAllowedError' || attempt === 7) throw err;
      await new Promise(resolve => setTimeout(resolve, 40*(attempt+1)));
    }
  }
}

export async function rebuildDemix(E, status, signal) {
  const { reference, parts } = E.guided;
  const ref = E.sources.get(reference);
  const ids = parts.map(p => p.sid);
  try {
    const job = { model: E.guided.separation, root: E.root, ref: { file: ref.file, frames: ref.frames, ch: ref.ch }, ids };
    let peaks;
    try { peaks = await run(job, status, signal); }
    catch (err) {
      if (!err.retryCPU) throw err;
      status('GPU 작업을 종료했습니다. CPU로 분리를 다시 시작합니다.');
      peaks = await run({ ...job, cpuOnly: true }, status, signal);
    }
    const files = await Promise.all(ids.map(async id => (await E.root.getFileHandle(id + '.pcm')).getFile()));
    for (const [j,id] of ids.entries()) {
      Object.assign(E.sources.get(id), { fileId: id, file: files[j], peaks: peaks[j], missing: false });
    }
    for (const t of E.tracks) E.updateSegs(t);
    E.applyAll();
  } catch (err) {
    await Promise.all(ids.map(id => removePartial(E.root, id)));
    throw err;
  }
}

export async function importDemix(E, file, status, signal) {
  if (E.guided || E.tracks.length) throw Error('새 프로젝트에서 원곡을 불러오세요.');
  status('원곡 WAV 읽는 중');
  const ref = await E.addSource(file.name.replace(/\.wav$/i, '').normalize('NFC'), file, { float: true }, signal);
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (quota && quota - usage < ref.frames * 8 * labels.length)
      throw Error('6개 스템을 저장할 공간이 부족합니다.');
    const parts = labels.map(label => {
      const sid = crypto.randomUUID();
      E.addMissingSource({ sid, name: label, frames: ref.frames, ch: 2, scale: 1, float: true });
      return { sid, label, trackId: crypto.randomUUID() };
    });
    E.guided = { reference: ref.sid, parts, automatic: true, separation: preferredModel(navigator) };
    await rebuildDemix(E, status, signal);
    for (const p of parts) {
      const t = E.makeTrack(p.label, { id: p.trackId, color: colorFor(p.label) });
      t.home = p.sid;
      t.clips = [{ id: newClipId(), sid: p.sid, start: 0, src: 0, len: ref.frames, fi: 0, fo: 0 }];
      E.updateSegs(t);
    }
    E.applyAll();
  } catch (err) {
    await E.clearAll();
    throw err;
  }
}
