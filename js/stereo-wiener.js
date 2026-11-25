// Regularized two-channel Wiener filter. Store the traceless part of each
// Hermitian covariance as [diagonal difference, real cross term, imaginary cross term].
// Each source's trace is fixed by its guide power at this bin.
const spatialStrength = 0.8; // Reserve 20% isotropic power for uncertain stereo cues.
const floor = 1e-20;
const vector = width => new Float64Array(width);
const covariance = width => ({ pan: vector(width), real: vector(width), imag: vector(width) });

export class StereoWiener {
  constructor(sources, width) {
    this.sources = sources.slice(1);
    this.parts = this.sources.map(() => covariance(width));
    this.raw = covariance(width);
    this.sum = covariance(width);
    this.inverseMix = Array.from({ length: 2 }, () => ({ re: vector(width), im: vector(width) }));
  }

  prepare(bins, energies, total) {
    const width = total.length, raw = this.raw, sum = this.sum;
    sum.pan.fill(0); sum.real.fill(0); sum.imag.fill(0);
    for (let j = 0; j < this.parts.length; j++) {
      // A mono file has no recorded stereo direction.
      if (this.sources[j].ch === 1) continue;
      const [left, right] = bins[j + 1], energy = energies[j + 1], part = this.parts[j];
      for (let k = 0; k < width; k++) {
        const lr = left.re[k], li = left.im[k], rr = right.re[k], ri = right.im[k];
        raw.pan[k] = lr*lr + li*li - rr*rr - ri*ri;
        raw.real[k] = 2 * (lr*rr + li*ri);
        raw.imag[k] = 2 * (li*rr - lr*ri);
      }
      // Smooth direction across adjacent bins without spreading energy into empty bins.
      for (let k = 0; k < width; k++) {
        const lo = Math.max(0,k-1), hi = Math.min(width-1,k+1);
        const trace = energy[lo] + 2*energy[k] + energy[hi];
        const scale = trace > floor && total[k] > floor
          ? spatialStrength * (energy[k] / total[k]) / trace : 0;
        part.pan[k] = scale * (raw.pan[lo] + 2*raw.pan[k] + raw.pan[hi]);
        part.real[k] = scale * (raw.real[lo] + 2*raw.real[k] + raw.real[hi]);
        part.imag[k] = scale * (raw.imag[lo] + 2*raw.imag[k] + raw.imag[hi]);
        sum.pan[k] += part.pan[k];
        sum.real[k] += part.real[k];
        sum.imag[k] += part.imag[k];
      }
    }
    // Solve the mixture's 2x2 system once per bin; the diagonal loading bounds the inverse.
    const [left, right] = bins[0], [u, v] = this.inverseMix;
    for (let k = 0; k < width; k++) {
      const p = sum.pan[k], r = sum.real[k], i = sum.imag[k];
      const inv = 1 / (1 - p*p - r*r - i*i);
      u.re[k] = ((1-p)*left.re[k] - r*right.re[k] + i*right.im[k]) * inv;
      u.im[k] = ((1-p)*left.im[k] - r*right.im[k] - i*right.re[k]) * inv;
      v.re[k] = ((1+p)*right.re[k] - r*left.re[k] - i*left.im[k]) * inv;
      v.im[k] = ((1+p)*right.im[k] - r*left.im[k] + i*left.re[k]) * inv;
    }
  }

  // Add (C_part - share*C_sum) * inv(C_sum) * mix to the scalar estimate.
  // These corrections sum to zero, and MIDI still affects only its rhythm group.
  addCorrection(j, ch, energy, total, out) {
    const part = this.parts[j], sum = this.sum;
    const own = this.inverseMix[ch], other = this.inverseMix[1-ch];
    const sign = ch === 0 ? 1 : -1;
    for (let k = 0; k < total.length; k++) {
      if (total[k] <= floor || energy[k] === 0) continue;
      const share = energy[k] / total[k];
      const p = sign * (part.pan[k] - share*sum.pan[k]);
      const r = part.real[k] - share*sum.real[k];
      const i = sign * (part.imag[k] - share*sum.imag[k]);
      out.re[k] += p*own.re[k] + r*other.re[k] - i*other.im[k];
      out.im[k] += p*own.im[k] + r*other.im[k] + i*other.re[k];
    }
  }
}
