// 정렬된 스테레오 믹스를 스템 가이드로 분배한다. 한 블록의 PCM과 겹침 구간만 메모리에 둔다.
import { fft } from './stats.js';
import { StereoWiener } from './stereo-wiener.js';

const SR = 44100, N = 2048, H = N / 2, BLOCK = 32 * H;
const windowFn = Float64Array.from({ length: N }, (_, i) => Math.sin(Math.PI * (i + 0.5) / N));
const spectrum = () => ({ re: new Float64Array(N), im: new Float64Array(N) });

async function readPCM(s, start, end) {
  const lo = Math.max(0, start), hi = Math.min(s.frames, end);
  const out = new Float32Array((end - start) * s.ch);
  if (hi <= lo) return out;
  const bytes = s.float ? 4 : 2;
  const ab = await s.file.slice(lo * s.ch * bytes, hi * s.ch * bytes).arrayBuffer();
  const data = s.float ? new Float32Array(ab) : new Int16Array(ab);
  const offset = (lo - start) * s.ch;
  if (s.float) out.set(data, offset);
  else for (let i = 0; i < data.length; i++) out[offset + i] = data[i] * s.scale / 32768;
  return out;
}

// 앞·중간·끝 구역마다 실제로 소리가 나는 지점에서 스템 합과 원곡의 시간차를 확인한다.
async function checkAlignment(sources) {
  const frames = sources[0].frames;
  if (sources.some(s => s.frames !== frames)) throw Error('원곡과 스템의 길이가 다릅니다. 같은 버전과 템포의 WAV를 선택하세요.');
  let checked = 0;
  for (let region = 0; region < 3; region++) {
    let best = null;
    for (let i = 0; i < 5; i++) {
      const a = Math.max(0, Math.floor((frames - N) * (region + (i + .5) / 5) / 3));
      const raw = await readPCM(sources[0], a, a + N);
      const energy = raw.reduce((s,x) => s + x*x, 0);
      if (!best || energy > best.energy) best = { a, raw, energy };
    }
    if (best.energy < .0001) continue;
    // 스테레오의 극성이 반대인 구간도 검증할 수 있게 에너지가 큰 채널을 고른다.
    let channel = 0;
    if (sources[0].ch === 2) {
      let left = 0, right = 0;
      for (let i = 0; i < N; i++) {
        left += best.raw[2*i] ** 2;
        right += best.raw[2*i+1] ** 2;
      }
      if (right > left) channel = 1;
    }
    const sample = (x, ch, i) => x[i * ch + Math.min(channel, ch - 1)];
    const sum = new Float64Array(N);
    for (const s of sources.slice(1)) {
      const x = await readPCM(s, best.a, best.a + N);
      for (let i = 0; i < N; i++) sum[i] += sample(x, s.ch, i);
    }
    let peak = 0, zero = 0;
    for (let lag = -96; lag <= 96; lag++) {
      let xx = 0, yy = 0, xy = 0;
      for (let i = 96; i < N-96; i+=2) {
        const x = sample(best.raw, sources[0].ch, i), y = sum[i+lag];
        xx += x*x; yy += y*y; xy += x*y;
      }
      const corr = xy / Math.sqrt(xx*yy || 1);
      peak = Math.max(peak,corr);
      if (!lag) zero = corr;
    }
    if (zero < .45 || zero + .04 < peak) throw Error('원곡과 스템의 파형 정렬을 확인할 수 없습니다. 동일 버전의 원곡과 스템을 선택하세요.');
    checked++;
  }
  if (!checked) throw Error('정렬을 확인할 수 있는 유음 구간이 없습니다.');
}

function forward(data, ch, offset, channel, z) {
  for (let i = 0; i < N; i++) z.re[i] = data[(offset+i)*ch + Math.min(channel,ch-1)] * windowFn[i];
  z.im.fill(0); fft(z.re,z.im);
}
function power(z,c) { return z.re[c]**2 + z.im[c]**2; }

function midiWeights(weights, notes, kind, sec) {
  for (const n of notes) {
    if (kind === 'bass') {
      if (sec < n.t-.025 || sec > n.end+.055) continue;
      const pitch = 440 * 2**((n.note-69)/12);
      for (let h = 1; h <= 8; h++) {
        const bin = pitch*h*N/SR;
        for (let k=Math.max(1,Math.floor(bin)-1); k<=Math.min(H,Math.ceil(bin)+1); k++)
          weights[k]=Math.max(weights[k],Math.exp(-.7*(k-bin)**2)/Math.sqrt(h));
      }
    } else {
      const dt = sec-n.t;
      if (dt < -.025 || dt > .11) continue;
      const band = drumBands[n.note];
      if (!band) continue;
      const env = Math.exp(-Math.abs(dt)/.035);
      for(let k=band[0]; k<=band[1]; k++) weights[k]=Math.max(weights[k],env);
    }
  }
}
const drumBands = {};
for (const [keys,lo,hi] of [[[35,36],35,180],[[37,38,39,40],180,5400],[[42,44,46,49,51,52,53,55,57,59],4300,15500]]) {
  for(const key of keys) drumBands[key]=[Math.ceil(lo*N/SR),Math.floor(hi*N/SR)];
}

// 후보 스템들이 서로 상쇄되는 경우에는 원곡에서 약하게 보이더라도 보존한다.
function repairWeight(partEnergy, mixEnergy, totalEnergy, bins, k) {
  if (partEnergy < 1e-18) return 0;
  const ratio = mixEnergy / partEnergy;
  const others = Math.max(0, totalEnergy - partEnergy) / partEnergy;
  if (ratio >= .063 || others >= .25) return 0;
  let combined = 0;
  for (let ch = 0; ch < 2; ch++) {
    let real = 0, imag = 0;
    for (let i = 1; i < bins.length; i++) {
      real += bins[i][ch].re[k];
      imag += bins[i][ch].im[k];
    }
    combined += real * real + imag * imag;
  }
  const cancellation = Math.min(1, Math.max(0, (combined / partEnergy - .1) / .4));
  return Math.min(1, (.063 - ratio) / .059) * (1 - 4 * others) * Math.min(1, partEnergy / .0001) * cancellation;
}

function writeFrame(output, bins, energies, total, denominator, midi, scratch, pos, rhythmShare, spatial) {
  const part = output.j + 1;
  const count = bins.length - 1;
  for (let k = 0; k <= H; k++) {
    const energy = energies[part][k];
    if (output.mode === 'auto') {
      const base = total[k] > 1e-20 ? energy / total[k] : 1 / count;
      output.weight[k] = output.guided && total[k] > 1e-20
        ? base * (1 + midi[output.j][k]) * rhythmShare[k] : base;
    } else if (output.mode === 'repair') {
      output.weight[k] = repairWeight(energy, energies[0][k], total[k], bins, k);
    } else if (output.mode === 'midi') {
      output.weight[k] = denominator[k] > 1e-20 ? energy * (1 + midi[output.j][k]) / denominator[k] : 1 / count;
    } else {
      output.weight[k] = total[k] > 1e-20 ? energy / total[k] : 1 / count;
    }
  }
  for (let ch = 0; ch < 2; ch++) {
    const mix = bins[0][ch], stem = bins[part][ch];
    for (let k = 0; k <= H; k++) {
      const w = output.weight[k];
      let mixGain = w, stemGain = 0;
      if (output.mode === 'repair') {
        mixGain *= energies[part][k] / (total[k] || 1);
        stemGain = 1 - w;
      }
      scratch.re[k] = mix.re[k] * mixGain + stem.re[k] * stemGain;
      scratch.im[k] = mix.im[k] * mixGain + stem.im[k] * stemGain;
    }
    if (spatial) spatial.addCorrection(output.j, ch, energies[part], total, scratch);
    // Complete the Hermitian spectrum and conjugate for the inverse FFT.
    for (let k = 0; k <= H; k++) {
      scratch.im[k] = -scratch.im[k];
      if (k > 0 && k < H) {
        scratch.re[N-k] = scratch.re[k];
        scratch.im[N-k] = -scratch.im[k];
      }
    }
    fft(scratch.re, scratch.im);
    for (let i = 0; i < H; i++) {
      const n = 2 * i + ch;
      if (pos >= 0) output.chunk[2 * pos + n] = output.overlap[n] + scratch.re[i] * windowFn[i] / N;
      output.overlap[n] = scratch.re[H+i] * windowFn[H+i] / N;
    }
  }
}

function writeChunk(output, raw, channels, start, count) {
  const data = output.chunk.subarray(0, count * 2);
  for (let i = 0; i < count; i++) {
    const peakIndex = Math.floor((start + i) / H);
    for (let ch = 0; ch < 2; ch++) {
      const sample = data[2*i+ch], original = raw[(i+H)*channels + Math.min(ch, channels-1)];
      if (output.mode !== 'auto') {
        output.delta += (sample - original) ** 2;
        output.originalEnergy += original ** 2;
      }
      output.peaks[peakIndex] = Math.max(output.peaks[peakIndex], Math.abs(sample));
    }
  }
  if (output.writer.write(data, { at:start * 8 }) !== data.byteLength) throw Error('분리 음원 저장 공간이 부족합니다.');
}

async function separate({ root, sources, parts, automatic = false, stereoWiener = automatic }) {
  await checkAlignment(sources);
  const frames = sources[0].frames, width = H + 1;
  const bins = sources.map(() => [spectrum(), spectrum()]);
  const energies = sources.map(() => new Float64Array(width));
  const total = new Float64Array(width), scratch = spectrum();
  const denominator = new Float64Array(width), previous = new Float64Array(width);
  const midi = parts.map(() => new Float64Array(width));
  // MIDI가 있는 리듬 악기들의 기존 총 몫만 재분배한다. 보컬과 나머지 악기의 마스크는 고정한다.
  const guided = parts.map(p => !!p.notes?.length && ['bass', 'drums', 'perc'].includes(p.kind));
  const rhythmShare = new Float64Array(width);
  const spatial = automatic && stereoWiener && sources[0].ch === 2 && sources.slice(1).some(s => s.ch === 2)
    ? new StereoWiener(sources, width) : null;
  const modes = automatic ? ['auto'] : parts.some(p => p.notes?.length) ? ['wav','repair','midi'] : ['wav','repair'];
  const outputs = [], created = [];
  try {
    for (let j = 0; j < parts.length; j++) {
      for (const mode of modes) {
        const id = crypto.randomUUID(), filename = id + '.pcm';
        const file = await root.getFileHandle(filename, { create:true });
        created.push(filename);
        const writer = await file.createSyncAccessHandle();
        outputs.push({
          j, mode, id, guided:guided[j], writer, delta:0, originalEnergy:0,
          peaks:new Float32Array(Math.ceil(frames/H)), overlap:new Float32Array(H*2),
          chunk:new Float32Array(BLOCK*2), weight:new Float64Array(width),
        });
      }
    }
    for (let start = 0; start < frames; start += BLOCK) {
      const count = Math.min(BLOCK, frames-start);
      const input = await Promise.all(sources.map(s => readPCM(s, start-H, start+BLOCK+H)));
      for (let pos = start === 0 ? -H : 0; pos < count; pos += H) {
        total.fill(0);
        for (let j = 0; j < sources.length; j++) {
          const [left, right] = bins[j], channels = sources[j].ch;
          forward(input[j], channels, pos+H, 0, left);
          if (channels === 1) {
            right.re.set(left.re); right.im.set(left.im);
          } else forward(input[j], channels, pos+H, 1, right);
          for (let k = 0; k < width; k++) {
            energies[j][k] = power(left,k) + power(right,k);
            if (j) total[k] += energies[j][k];
          }
        }
        if (automatic) {
          denominator.fill(0);
          rhythmShare.fill(0);
        } else denominator.set(total);
        const sec = (start+pos+H)/SR, mix = energies[0];
        for (const [j, part] of parts.entries()) {
          if (!guided[j]) continue;
          const hint = midi[j];
          hint.fill(0);
          midiWeights(hint, part.notes, part.kind, sec);
          for (let k = 0; k < width; k++) {
            const base = part.kind === 'bass'
              ? .5 * (mix[Math.max(0,k-2)] + mix[Math.min(H,k+2)]) : previous[k];
            hint[k] *= Math.max(0, Math.min(1, (mix[k]-base)/(mix[k]+1e-16)));
            const energy = energies[j+1][k];
            if (automatic) rhythmShare[k] += energy;
            denominator[k] += energy * hint[k];
          }
        }
        if (automatic) for (let k = 0; k < width; k++) {
          const group = rhythmShare[k];
          rhythmShare[k] = group > 0 ? group / (group + denominator[k]) : 1;
        }
        spatial?.prepare(bins, energies, total);
        previous.set(mix);
        for (const output of outputs) writeFrame(output, bins, energies, total, denominator, midi, scratch, pos, rhythmShare, spatial);
      }
      for (const output of outputs) writeChunk(output, input[output.j+1], sources[output.j+1].ch, start, count);
      postMessage({ progress:(start+count)/frames });
    }
    for (const out of outputs) { out.writer.flush(); out.writer.close(); out.writer = null; }
    return outputs.map(({ j, mode, id, peaks, delta, originalEnergy }) => ({
      j, mode, id, peaks, changeDb:originalEnergy ? 10*Math.log10(delta/originalEnergy) : null,
    }));
  } catch (err) {
    for (const out of outputs) { try { out.writer?.close(); } catch {} }
    for (const name of created) await root.removeEntry(name).catch(() => {});
    throw err;
  }
}
self.onmessage = async ({ data }) => {
  try { postMessage({ outputs: await separate(data) }); }
  catch (err) { postMessage({ error: err.message }); }
};
