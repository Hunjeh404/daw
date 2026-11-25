import assert from 'node:assert/strict';
import test from 'node:test';
import { MixMeter } from '../js/master-export.js';
import { Loudness, TruePeak } from '../js/dsp.js';

test('final mix approaches target loudness and keeps headroom for transients', () => {
  const signal = Float32Array.from({ length: 44100 }, (_, i) => .06 * Math.sin(i*2*Math.PI*440/44100));
  const meter = new MixMeter();
  meter.push(signal, signal);
  const gain = meter.gain(), level = new Loudness(44100);
  for (const v of signal) level.push(v*gain, v*gain);
  assert.ok(Math.abs(level.integrated()+14) < .01);
  signal[signal.length-1] = 1;
  const transient = new MixMeter();
  transient.push(signal, signal);
  const atten = transient.gain(), peak = new TruePeak();
  let max = 0;
  for (const v of signal) max = Math.max(max, peak.push(v*atten));
  for (let i=0; i<16; i++) max = Math.max(max, peak.push(0));
  assert.ok(Math.abs(20*Math.log10(max)+1) < .001);
});
test('silence remains silent at unity gain', () => {
  const meter = new MixMeter(), silence = new Float32Array(100);
  meter.push(silence,silence);
  assert.equal(meter.gain(),1);
});
