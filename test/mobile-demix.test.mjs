import test from 'node:test';
import { wavLayout, decodedWavChunks } from '../js/wav-chunks.js';
import assert from 'node:assert/strict';
import { preferredModel, mobileModel, desktopModel } from '../js/demix-models.js';
import { demucsSpectrum, addDemucsSpectrum, mobileLength } from '../js/demucs-mobile.js';

test('mobile and low-memory devices use the short 6-source model', () => {
  for (const device of [{userAgent:'Android'}, {userAgentData:{mobile:true}},
    {platform:'MacIntel',maxTouchPoints:5}, {deviceMemory:4}])
    assert.equal(preferredModel(device),mobileModel);
  assert.equal(preferredModel({userAgent:'Linux x86_64',deviceMemory:8}),desktopModel);
});

test('Demucs complex spectrum reconstructs both channels at sample alignment', () => {
  const n = mobileLength, bins = 2048, frames = 168;
  const audio = Float32Array.from({length:2*n}, (_,i) =>
    Math.sin((i % n) * (i < n ? .041 : .13))*.25);
  const spectrum = demucsSpectrum(audio);
  const freq = new Float32Array(spectrum.length);
  for (let ch=0; ch<2; ch++) for (let i=0; i<bins*frames; i++) {
    const j=(ch*bins*frames+i)*2;
    freq[2*ch*bins*frames+i]=spectrum[j];
    freq[(2*ch+1)*bins*frames+i]=spectrum[j+1];
  }
  for (let ch=0; ch<2; ch++) {
    const result=new Float32Array(n);
    addDemucsSpectrum(result,freq,ch);
    let err=0;
    for(let i=4096;i<n-4096;i++) err=Math.max(err,Math.abs(result[i]-audio[ch*n+i]));
    assert.ok(err < 2e-6, 'STFT alignment/level error '+err);
  }
});


test('48 kHz import preserves the full-song frame count across decoder windows', async () => {
  const rate=48000, target=44100, seconds=16;
  const header=new DataView(new ArrayBuffer(44)), bytes=seconds*rate*4;
  header.setUint32(0,0x52494646); header.setUint32(4,36+bytes,true);
  header.setUint32(8,0x57415645); header.setUint32(12,0x666d7420); header.setUint32(16,16,true);
  header.setUint16(20,1,true); header.setUint16(22,2,true); header.setUint32(24,rate,true);
  header.setUint32(28,rate*4,true); header.setUint16(32,4,true); header.setUint16(34,16,true);
  header.setUint32(36,0x64617461); header.setUint32(40,bytes,true);
  const file=new Blob([header,new Uint8Array(bytes)]);
  const layout=await wavLayout(file);
  const ctx={ sampleRate:target, async decodeAudioData(raw) {
    const bytes=new DataView(raw).getUint32(40,true);
    return {length:Math.floor(bytes/4/(rate/target))};
  }};
  let total=0;
  for await (const {count} of decodedWavChunks(ctx,file,layout)) total+=count;
  assert.equal(total,Math.floor(seconds*rate/(rate/target)));
});
