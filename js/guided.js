// 원곡과 가이드 스템은 항상 보존하고, 다시 만들 수 있는 분리 파일만 별도 보관한다.
import { listZip, readEntry } from './zip.js';
import { parseMidi } from './midi.js';
import { category, colorFor } from './cats.js';
import { newClipId } from './engine.js';

const stemName = name => name.split('/').pop().replace(/\.(wav|midi?)$/i, '').normalize('NFC');
const shortName = name => name.match(/\(([^()]*)\)$/)?.[1] || name;

function runWorker(job, status) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./guided-worker.js', import.meta.url), { type: 'module' });
    worker.onerror = e => { worker.terminate(); reject(Error(e.message || '분리 워커가 중단되었습니다.')); };
    worker.onmessage = ({ data }) => {
      if ('progress' in data) return status('원곡 재분리 ' + Math.round(data.progress * 100) + '%');
      worker.terminate();
      if (data.error) reject(Error(data.error)); else resolve(data.outputs);
    };
    worker.postMessage(job);
  });
}

export async function rebuildGuided(E, status) {
  if (!E.guidedPending || E.missingSources.length) return;
  const sources = E.guidedIds.map(sid => {
    const { file, frames, ch, scale, float } = E.sources.get(sid);
    return { file, frames, ch, scale, float };
  });
  status('원곡과 스템의 길이·파형 정렬 확인 중');
  const { parts } = E.guided;
  const outputs = await runWorker({ root: E.root, sources, parts, automatic: !!E.guided.automatic }, status);
  const staged = [];
  try {
    for (const out of outputs) {
      const parent = E.sources.get(parts[out.j].sid);
      const handle = await E.root.getFileHandle(out.id + '.pcm');
      staged.push({ parent, mode: out.mode, source: {
        sid: out.id, fileId: out.id, file: await handle.getFile(), idx: E.nextIdx++,
        name: parent.name, frames: parent.frames, ch: 2, scale: 1, float: true,
        peaks: out.peaks, changeDb: out.changeDb, derived: true,
      } });
    }
  } catch (err) {
    await Promise.all(outputs.map(o => E.root.removeEntry(o.id + '.pcm').catch(() => {})));
    throw err;
  }
  for (const { parent, mode, source } of staged) {
    E.sources.set(source.sid, source); E.srcIdx.set(source.idx, source);
    (parent.variants ||= {})[mode] = source.sid;
  }
  for (const t of E.tracks) E.updateSegs(t);
  E.applyAll();
}

export async function importGuided(E, reference, zip, status) {
  if (E.tracks.length || E.guided) throw Error('프로젝트 메뉴에서 새 프로젝트를 연 뒤 불러오세요.');
  const entries = (await listZip(zip)).filter(e => !/(^|\/)(__MACOSX\/|\._)/.test(e.name));
  const wavs = entries.filter(e => /\.wav$/i.test(e.name));
  if (wavs.length < 2) throw Error('ZIP 안에 악기별 WAV가 두 개 이상 필요합니다.');
  const names = wavs.map(e => stemName(e.name));
  if (new Set([...names, stemName(reference.name)]).size !== names.length+1)
    throw Error('파일 이름이 겹칩니다. 원곡과 각 스템의 이름을 구분하세요.');
  const mids = new Map(entries.filter(e => /\.midi?$/i.test(e.name)).map(e => [stemName(e.name), e]));
  const created = [], parts = [];
  let stage = false;
  try {
    status('원곡 WAV 읽는 중');
    const ref = await E.addSource(stemName(reference.name), await reference.arrayBuffer(), { float: true });
    created.push(ref);
    const required = ref.frames * 8 * wavs.length * 2;
    const quota = await navigator.storage.estimate();
    if (quota.quota && quota.quota - quota.usage < required) {
      throw Error('이 곡을 처리하려면 브라우저 저장공간 약 ' + ((required + ref.file.size)/1e9).toFixed(1) + ' GB가 필요합니다. 공간을 확보하거나 더 짧은 구간을 선택하세요.');
    }
    for (const [j, entry] of wavs.entries()) {
      const name = names[j], label = shortName(name), cat = category(label);
      status('가이드 스템 ' + (j+1) + '/' + wavs.length + ' · ' + label);
      const s = await E.addSource(name, await readEntry(zip, entry), { float: true });
      created.push(s);
      const part = { sid: s.sid, trackId: crypto.randomUUID(), version: 'auto', label };
      if (mids.has(name) && ['bass','drums','perc'].includes(cat)) {
        try {
          const midi = parseMidi(new Uint8Array(await readEntry(zip, mids.get(name))));
          const duration = ref.frames / E.ctx.sampleRate;
          part.notes = midi.notes.filter(n => n.t >= 0 && n.t < duration && n.end > n.t)
            .map(({ t, end, note }) => ({ t, end, note }));
          part.kind = cat;
        } catch {
          // MIDI는 선택 입력이다. 읽을 수 없는 파트도 WAV를 기반으로 분리한다.
        }
      }
      parts.push(part);
    }
    E.guided = { reference: ref.sid, parts, automatic: true }; stage = true;
    await rebuildGuided(E, status);
    for (const p of parts) {
      const s = E.sources.get(p.sid);
      const t = E.makeTrack(p.label, { id: p.trackId, color: colorFor(p.label) });
      t.mix.version = p.version; t.home = p.sid;
      t.clips = [{ id: newClipId(), sid: p.sid, start: 0, src: 0, len: s.frames, fi: 0, fo: 0 }];
      E.updateSegs(t);
    }
    E.mm.low.on = E.mm.space.on = E.mm.lim.on = false;
    E.applyAll();
  } catch (err) {
    if (stage) await E.clearAll();
    else for (const s of created) await E.removeSource(s);
    throw err;
  }
}
