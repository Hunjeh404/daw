// Measure the edited render, including its fades and reverb, before encoding.
import { Loudness, TruePeak, dbToLin } from './dsp.js';

export class MixMeter {
  constructor() {
    this.loudness = new Loudness(44100);
    this.left = new TruePeak();
    this.right = new TruePeak();
    this.peak = 0;
    this.frames = 0;
  }
  push(L, R) {
    for (let i = 0; i < L.length; i++) {
      this.loudness.push(L[i], R[i]);
      this.peak = Math.max(this.peak, this.left.push(L[i]), this.right.push(R[i]));
    }
    this.frames += L.length;
  }
  gain() {
    for (let i = 0; i < 16; i++) this.peak = Math.max(this.peak, this.left.push(0), this.right.push(0));
    // Pad a short excerpt to one 400 ms measurement window.
    for (let i = this.frames; i < 17640; i++) this.loudness.push(0, 0);
    const lufs = this.loudness.integrated();
    const levelGain = Number.isFinite(lufs) ? dbToLin(-14 - lufs) : 1;
    return Math.min(levelGain, dbToLin(-1) / (this.peak || 1e-12));
  }
}
