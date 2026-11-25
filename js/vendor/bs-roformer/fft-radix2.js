/**
 * In-place Cooley-Tukey radix-2 complex FFT with pre-computed twiddle table.
 *
 * Buffer is interleaved [re0, im0, re1, im1, ...] of length 2*n where n is a
 * power of 2. Forward transform only — iFFT is computed via FFT(conj(X)) / N.
 *
 * The previous implementation recomputed Math.cos/sin for every butterfly
 * (~22 K trig calls per FFT of size 2048). For BS-Roformer's iSTFT path the
 * worker does ~4 K FFTs per chunk — that's 90 M trig calls per chunk in pure
 * JS, which cost ~2.2 s in the Web Worker. Caching twiddles drops the trig
 * cost to log2(N) × N/2 = 11 K trig per *unique-N* prepare, amortized over
 * every FFT of that size.
 */

const _twiddleCache = new Map(); // n -> { wr: Float64Array, wi: Float64Array }

function getTwiddles(n) {
  let entry = _twiddleCache.get(n);
  if (entry) return entry;
  // Flat arrays of length n/2 per stage, stored end-to-end. For stage with
  // butterfly span `size`, we need n/size twiddles wr[k], wi[k] = cos/sin of
  // -2πk/size. Concatenate across stages so the inner loop reads sequentially.
  const stages = Math.log2(n) | 0;
  const wr = new Float64Array(n);
  const wi = new Float64Array(n);
  let off = 0;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let k = 0; k < half; k++) {
      wr[off + k] = Math.cos(step * k);
      wi[off + k] = Math.sin(step * k);
    }
    off += half;
  }
  entry = { wr, wi, stages };
  _twiddleCache.set(n, entry);
  return entry;
}

export function fftRadix2InPlace(buf, n) {
  // Bit reversal
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (i < j) {
      const a = i << 1, b = j << 1;
      let tr = buf[a]; buf[a] = buf[b]; buf[b] = tr;
      tr = buf[a + 1]; buf[a + 1] = buf[b + 1]; buf[b + 1] = tr;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  // Butterflies — twiddles read from precomputed table.
  const { wr, wi } = getTwiddles(n);
  let off = 0;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const wrk = wr[off + k], wik = wi[off + k];
        const aIdx = (i + k) << 1;
        const bIdx = (i + k + half) << 1;
        const tr = buf[bIdx] * wrk - buf[bIdx + 1] * wik;
        const ti = buf[bIdx] * wik + buf[bIdx + 1] * wrk;
        buf[bIdx]     = buf[aIdx]     - tr;
        buf[bIdx + 1] = buf[aIdx + 1] - ti;
        buf[aIdx]     = buf[aIdx]     + tr;
        buf[aIdx + 1] = buf[aIdx + 1] + ti;
      }
    }
    off += half;
  }
}
