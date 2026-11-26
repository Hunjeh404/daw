// HTDemucs 6s, AudioWeb 3.9 s export. Tensor order is documented in the ONNX graph.
// The model separates both waveform and normalized complex spectrogram branches.
import { fftRadix2InPlace } from './vendor/bs-roformer/fft-radix2.js';

export const mobileLength = 171990;
const fftSize = 4096, bins = fftSize / 2, hop = 1024;
const frames = Math.ceil(mobileLength / hop);
const window = Float32Array.from({ length: fftSize }, (_, n) => .5 - .5 * Math.cos(2*Math.PI*n/fftSize));
const pad = 3*hop/2;
const normalization = Math.sqrt(fftSize);

export function demucsSpectrum(audio) {
  const spec = new Float32Array(2*bins*frames*2);
  const fft = new Float32Array(2*fftSize);
  for (let ch = 0; ch < 2; ch++) {
    for (let t = 0; t < frames; t++) {
      const start = t*hop - pad;
      for (let n = 0; n < fftSize; n++) {
        const i = start+n;
        const reflected = i < 0 ? -i : i >= mobileLength ? 2*mobileLength-2-i : i;
        fft[2*n] = audio[ch*mobileLength+reflected] * window[n];
        fft[2*n+1] = 0;
      }
      fftRadix2InPlace(fft, fftSize);
      for (let k = 0; k < bins; k++) {
        const dest = ((ch*bins+k)*frames+t)*2;
        spec[dest] = fft[2*k]/normalization;
        spec[dest+1] = fft[2*k+1]/normalization;
      }
    }
  }
  return spec;
}

// Output channels are [left-real, left-imag, right-real, right-imag].
// Demucs inserts two silent spectrum frames on each edge before inverse STFT.
// At the retained waveform indices the four squared periodic Hann windows sum to 1.5.
export function addDemucsSpectrum(pcm, freq, channel) {
  const fft = new Float32Array(2*fftSize);
  const base = channel*2*bins*frames;
  for (let t = 0; t < frames; t++) {
    fft[2*bins] = fft[2*bins+1] = 0;
    for (let k = 0; k < bins; k++) {
      const source = base+k*frames+t;
      const re = freq[source], im = freq[source+bins*frames];
      fft[2*k] = re;
      fft[2*k+1] = -im;
      if (k > 0) {
        fft[2*(fftSize-k)] = re;
        fft[2*(fftSize-k)+1] = im;
      }
    }
    fftRadix2InPlace(fft, fftSize);
    const start = t*hop-pad;
    for (let n = Math.max(0,-start); n < Math.min(fftSize,mobileLength-start); n++)
      pcm[start+n] += fft[2*n]*window[n]/(1.5*normalization);
  }
}

export async function predictMobile(ort, session, audio) {
  const mix = new ort.Tensor('float32', audio, [1,2,mobileLength]);
  const spec = new ort.Tensor('float32', demucsSpectrum(audio), [1,2,bins,frames,2]);
  let out;
  try {
    out = await session.run({ mix, spec });
    const freq = out.freq.data, time = out.time.data;
    if (freq.length !== 6*4*bins*frames || time.length !== 6*2*mobileLength)
      throw Error('모바일 분리 모델의 출력 크기가 다릅니다.');
    const result = new Float32Array(time.length);
    // App order starts with bass then drums. HTDemucs emits drums then bass.
    for (const [dest, stem] of [1,0,2,3,4,5].entries()) {
      for (let ch = 0; ch < 2; ch++) {
        const src = (stem*2+ch)*mobileLength, offset = (dest*2+ch)*mobileLength;
        const pcm = result.subarray(offset, offset+mobileLength);
        pcm.set(time.subarray(src, src+mobileLength));
        addDemucsSpectrum(pcm, freq, stem*2+ch);
      }
    }
    return result;
  } finally {
    mix.dispose(); spec.dispose();
    if (out) for (const tensor of Object.values(out)) tensor.dispose();
  }
}
