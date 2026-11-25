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

async function run(sources, parts) {
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
  await self.onmessage({ data:{ root, sources:sources.map(source), parts } });
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
  await assert.rejects(run([mix.subarray(0,-2),...guides], [{},{}]), /길이/);
});
