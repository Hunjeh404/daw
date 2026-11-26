// Four-second model windows. Only one window and its overlap are resident per stem.
import { stftStereo, istftBatch } from './vendor/bs-roformer/stft.js';

import { mobileModel } from './demix-models.js';
import { mobileLength, predictMobile } from './demucs-mobile.js';

const desktop = {
  repo: 'elicwhite/bs-roformer-sw-6stem-onnx', rev: 'a744f80957374e1735ad70fa122670b7961da8cc',
  file: 'bs_roformer_sw_6stem_fp16.onnx', size: 352778874,
};
const mobile = {
  repo: 'Andremi/audioweb-models', rev: '953d0a9e46fd364860c9413ee4c7a9aa4fbcae4b',
  file: 'demucs_htdemucs_6s_s39_fp16w_ca.onnx', size: 56835345,
};
const desktopLength = 176400, overlap = 44100;
const transform = { nFft: 2048, winLength: 2048, hopLength: 512 };
const status = message => self.postMessage({ status: message });

async function modelBytes({ repo, rev, file, size }) {
  const root = await navigator.storage.getDirectory();
  const cache = await root.getDirectoryHandle('roformer-models', { create: true });
  return navigator.locks.request('daw-' + rev, async () => {
    const handle = await cache.getFileHandle(rev + '.onnx', { create: true });
    if ((await handle.getFile()).size !== size) {
      status('분리 모델 다운로드 준비 중 · '+Math.round(size/1048576)+' MiB');
      const res = await fetch('https://huggingface.co/'+repo+'/resolve/'+rev+'/'+file);
      if (!res.ok) throw Error('분리 모델 다운로드 실패 (' + res.status + '). 다시 시도하세요.');
      const writer = await handle.createWritable(), reader = res.body.getReader();
      let loaded = 0, last = -1;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
          loaded += value.length;
          const percent = Math.floor(loaded / size * 100);
          if (percent !== last) status('분리 모델 다운로드 ' + percent + '%');
          last = percent;
        }
        if (loaded !== size) throw Error('분리 모델 다운로드가 중단되었습니다. 다시 시도하세요.');
        await writer.close();
      } catch (err) {
        await writer.abort().catch(() => {});
        throw err;
      }
    }
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  });
}

async function predict(ort, session, planar) {
  const { real, imag, F, T } = stftStereo(planar, transform);
  const dims = [1, 2, F, T];
  const re = new ort.Tensor('float32', real, dims), im = new ort.Tensor('float32', imag, dims);
  let out;
  try {
    out = await session.run({ spec_real: re, spec_imag: im });
    const expected = 6*2*F*T;
    const r = out.out_spec_real.data, i = out.out_spec_imag.data;
    if (r.length !== expected || i.length !== expected) throw Error('분리 모델 출력 형식을 확인하세요.');
    // ORT can return a view with a nonzero offset in its own heap.
    const result = istftBatch({ realBuf: r, imagBuf: i, numStems: 6, numChannels: 2,
      F, T, length: desktopLength, ...transform });
    return new Float32Array(result.audioBuf);
  } finally {
    re.dispose(); im.dispose();
    if (out) for (const tensor of Object.values(out)) tensor.dispose();
  }
}

async function demix({ root, ref, ids, model, cpuOnly }) {
  const light = model === mobileModel;
  const length = light ? mobileLength : desktopLength, step = length-overlap;
  const runtime = light ? 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/'
    : 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.0-dev.20251116-b39e144322/dist/';
  const ort = await import(runtime + (light ? 'ort.wasm.min.mjs' : 'ort.all.min.mjs'));
  ort.env.wasm.wasmPaths = runtime;
  ort.env.wasm.numThreads = 1;
  const adapter = !light && !cpuOnly && await navigator.gpu?.requestAdapter().catch(() => null);
  const create = async providers => {
    const bytes = await modelBytes(light ? mobile : desktop);
    status((light ? '모바일 ' : '') + '6스템 분리 모델 준비 중');
    try {
      return await ort.InferenceSession.create(bytes, {
        executionProviders: providers, graphOptimizationLevel: light ? 'basic' : 'disabled',
        ...(light ? { enableCpuMemArena: false, enableMemPattern: false } : {}),
      });
    } catch (err) {
      if (adapter) throw Object.assign(new Error(String(err.message || err)), { retryCPU: true });
      throw err;
    }
  };
  const session = await create(adapter ? ['webgpu','wasm'] : ['wasm']);
  const infer = light ? predictMobile : predict;
  const files = [], names = [];
  const peaks = ids.map(() => new Float32Array(Math.ceil(ref.frames / 1024)));
  const tails = ids.map(() => new Float32Array(overlap * 2));
  try {
    for (const id of ids) {
      const name = id + '.pcm';
      const handle = await root.getFileHandle(name, { create: true });
      names.push(name);
      files.push(handle);
    }
    for (let pos = 0; pos < ref.frames; pos += step) {
      const count = Math.min(length, ref.frames - pos);
      const raw = new Float32Array(await ref.file.slice(pos*ref.ch*4, (pos+count)*ref.ch*4).arrayBuffer());
      const planar = new Float32Array(2*length);
      for (let i = 0; i < count; i++) {
        planar[i] = raw[i*ref.ch];
        planar[length+i] = raw[i*ref.ch+ref.ch-1];
      }
      status('보컬·악기 분리 중 · ' + (Math.floor(pos/step)+1) + '/' + Math.max(1, Math.ceil((ref.frames-overlap)/step)) + ' 구간');
      let result;
      try { result = await infer(ort, session, planar); }
      catch (err) {
        if (adapter) throw Object.assign(new Error(String(err.message || err)), { retryCPU: true });
        throw err;
      }
      const last = pos + count === ref.frames;
      const commit = last ? count : step;
      const sum = new Float32Array(commit*2);
      // The six network estimates need not sum exactly to the mix. Put the
      // unassigned difference in Other, preserving the original stereo baseline.
      for (const stem of [0,1,3,4,5,2]) {
        const pcm = new Float32Array(commit*2), tail = tails[stem];
        for (let i = 0; i < count; i++) {
          for (let ch = 0; ch < 2; ch++) {
            const v = result[(stem*2+ch)*length+i];
            if (!Number.isFinite(v)) throw Error('분리 모델에서 유효한 음원을 얻지 못했습니다.');
            const ix = 2*i+ch;
            if (i >= commit) { tail[2*(i-commit)+ch] = v; continue; }
            const weight = pos && i < overlap ? i / overlap : 1;
            const sample = stem === 2 ? raw[i*ref.ch+Math.min(ch,ref.ch-1)] - sum[ix]
              : weight < 1 ? tail[ix]*(1-weight) + v*weight : v;
            pcm[ix] = sample;
            sum[ix] += sample;
            const pk = (pos+i) >> 10;
            peaks[stem][pk] = Math.max(peaks[stem][pk], Math.abs(sample));
          }
        }
        // Release file locks before the next inference. A cancelled WASM call
        // may take seconds to terminate on a phone.
        const writer = await files[stem].createSyncAccessHandle();
        try {
          if (writer.write(pcm, { at: pos*8 }) !== pcm.byteLength) throw Error('분리 음원 저장 공간이 부족합니다.');
        } finally { writer.close(); }
      }
      if (last) break;
    }
    return peaks;
  } catch (err) {
    await Promise.all(names.map(n => root.removeEntry(n).catch(() => {})));
    throw err;
  } finally { await session.release(); }
}
self.onmessage = async ({ data }) => {
  try { self.postMessage({ peaks: await demix(data) }); }
  catch (err) { self.postMessage({ error: String(err?.message || err), name: err.name, retryCPU: !!err.retryCPU }); }
};
