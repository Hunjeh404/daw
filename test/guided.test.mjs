// node --test test/guided.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';

const rate = 44100, frames = 2 * rate + 317;
const tone = (hz, t) => Math.sin(2 * Math.PI * hz * t);
function signal(fn) {
  return Float32Array.from({ length: frames * 2 }, (_, i) => fn(Math.floor(i/2)/rate, i%2));
}
const a = signal((t,ch) => .15*tone(110,t) + .08*tone(244,t+.001*ch));
const b = signal((t,ch) => .13*tone(345,t+.0003*ch) + .11*tone(196,t));
const extra = signal(t => .07*tone(7300,t));
const cancel = signal(t => .09*tone(6200,t));
const mix = a.map((x,i) => x + b[i]);
const guides = [a.map((x,i) => x+extra[i]+cancel[i]), b.map((x,i) => x-cancel[i])];
const source = samples => ({ file:new Blob([samples]), frames:samples.length/2, ch:2, float:true, scale:1 });

async function run(sources, parts, automatic = false, stereoWiener = automatic) {
  const files = new Map();
  // Same worker entry and byte offsets as OPFS, with in-memory file handles for the test.
  const root = {
    async getFileHandle(name) {
      const data = new Float32Array(frames*2);
      files.set(name, data);
      return { async createSyncAccessHandle() { return {
        write(samples, { at }) { data.set(samples, at/4); return samples.byteLength; },
        flush() {}, close() {},
      }; } };
    },
    async removeEntry(name) { files.delete(name); },
  };
  let result;
  globalThis.self = {};
  globalThis.postMessage = msg => { if (!('progress' in msg)) result = msg; };
  await import('../js/guided-worker.js?test='+Math.random());
  await self.onmessage({ data:{ root, sources:sources.map(source), parts, automatic, stereoWiener } });
  if (result.error) throw Error(result.error);
  return result.outputs.map(o => ({ ...o, data:files.get(o.id+'.pcm') }));
}

function amplitude(samples, hz) {
  let real = 0, imag = 0;
  for (let i = 0; i < rate; i++) {
    const phase = 2*Math.PI*hz*i/rate, v = samples[2*i];
    real += v*Math.cos(phase); imag += v*Math.sin(phase);
  }
  return 2*Math.hypot(real,imag)/rate;
}

test('stereo re-sum includes first/last samples; repair attenuates an extra tone and preserves a cancelling tone', async () => {
  const parts = [{ kind:'bass', notes:[{ t:0, end:2, note:45 }] }, {}];
  const out = await run([mix,...guides], parts);
  for (const mode of ['wav','midi']) {
    const pair = out.filter(o => o.mode === mode);
    let peakError = 0;
    for (let i = 0; i < mix.length; i++)
      peakError = Math.max(peakError, Math.abs(pair[0].data[i]+pair[1].data[i]-mix[i]));
    assert.ok(peakError < 1e-6, mode+' peak error '+peakError);
  }
  const repair = out.find(o => o.j === 0 && o.mode === 'repair').data;
  assert.ok(amplitude(repair,7300) < .01*amplitude(guides[0],7300));
  assert.ok(amplitude(repair,6200) > .98*amplitude(guides[0],6200));
});

test('different audio with the same duration is rejected', async () => {
  await assert.rejects(run([signal(t => .15*tone(1317,t)),...guides], [{},{}]), /정렬/);
});

test('unequal duration is rejected', async () => {
  await assert.rejects(run([mix.subarray(0,-2*Math.round(rate*.1)),...guides], [{},{}]), /길이/);
});

test('stems one sample longer than the reference are accepted at reference length', async () => {
  const longer = guides.map(g => { const x = new Float32Array(g.length+2); x.set(g); return x; });
  const out = await run([mix,...longer], [{},{}]);
  assert.ok(out.length);
  for (const o of out) assert.equal(o.data.length, frames*2);
});


test('automatic MIDI redistributes only the eligible rhythm group and keeps the stereo sum', async () => {
  const sources = [mix, a, a, b];
  const baseline = await run(sources, [{},{},{}], true);
  const parts = [{ kind:'bass', notes:[{ t:0, end:2, note:45 }] },
    { kind:'drums', notes:[{ t:0, end:.1, note:36 }] }, { kind:'vocal', notes:[{ t:0, end:2, note:45 }] }];
  const out = await run(sources, parts, true);
  assert.equal(out.length, 3);
  assert.deepEqual(out[2].data, baseline[2].data);
  let change = 0, error = 0;
  for (let i = 0; i < mix.length; i++) {
    change = Math.max(change, Math.abs(out[0].data[i] - baseline[0].data[i]));
    error = Math.max(error, Math.abs(out[0].data[i] + out[1].data[i] + out[2].data[i] - mix[i]));
  }
  assert.ok(change > .0001);
  assert.ok(error < 1e-6);
  const missingMidi = await run(sources, [parts[0], { kind:'drums' }, {}], true);
  assert.deepEqual(missingMidi[1].data, baseline[1].data);
});

test('global width preserves lead, bass and drums and is reversible for accompaniment', async () => {
  const { spatialMix, trackDefaults } = await import('../js/mixgraph.js');
  const mix = trackDefaults();
  for (const cat of ['vocal','bass','drums']) assert.equal(spatialMix({ cat, mix }, { wider:true }), mix);
  const track = { cat:'guitar', mix };
  assert.ok(spatialMix(track, { wider:true }).width > 1);
  assert.equal(spatialMix(track, {}).pan, 0);
  assert.equal(mix.width, 1);
});

test('stereo guidance separates overlapping sources with distinct panning and phase', async t => {
  // Overlapping high-frequency chirps, with different inter-channel levels and delays.
  const sourceA = signal((t, ch) => .2 * Math.sin(2*Math.PI*(5400*t + 130*t*t)));
  const sourceB = signal((t, ch) => {
    const time = t - ch * 2 / rate;
    return (ch ? .23 : .065) * Math.sin(2*Math.PI*(5450*time + 105*time*time));
  });
  const reference = sourceA.map((v,i) => v + sourceB[i]);
  const inputs = [reference, sourceA.map((v,i) => v + .12*sourceB[i]),
    sourceB.map((v,i) => v + .12*sourceA[i])];
  const old = await run(inputs, [{},{}], true, false);
  const next = await run(inputs, [{},{}], true);
  for (const [j, truth] of [sourceA, sourceB].entries()) {
    let originalError = 0, newError = 0;
    for (let i = 0; i < truth.length; i++) {
      originalError += (old[j].data[i] - truth[i]) ** 2;
      newError += (next[j].data[i] - truth[i]) ** 2;
      assert.ok(Math.abs(next[0].data[i] + next[1].data[i] - reference[i]) < 1e-6);
    }
    const improvement = 10*Math.log10(originalError/newError);
    t.diagnostic('source '+(j+1)+' relative error improvement: '+improvement.toFixed(2)+' dB');
    assert.ok(improvement > 3);
  }
});

test('coincident centered sources retain scalar estimates, including silent guide bins', async () => {
  const centered = [a,b].map(data => data.map((_,i) => i < rate ? 0 : data[i - i%2]));
  const reference = centered[0].map((v,i) => v + centered[1][i]);
  const inputs = [reference, ...centered];
  const scalar = await run(inputs, [{},{}], true, false);
  const stereo = await run(inputs, [{},{}], true);
  for (const [j, out] of stereo.entries()) {
    for (let i = 0; i < out.data.length; i++) assert.ok(Math.abs(out.data[i] - scalar[j].data[i]) < 1e-6);
  }
});
