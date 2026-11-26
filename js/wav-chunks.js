// Read standard PCM/float WAVs in short windows using the same browser decoder
// as the regular import. Compressed, extensible and multichannel WAVs fall back.
const fourCC = (v, i) => String.fromCharCode(...new Uint8Array(v.buffer, v.byteOffset+i, 4));

export async function wavLayout(file) {
  if (file.size < 44) return null;
  const head = new DataView(await file.slice(0,12).arrayBuffer());
  if (fourCC(head,0) !== 'RIFF' || fourCC(head,8) !== 'WAVE') return null;
  let format;
  for (let pos = 12; pos+8 <= file.size;) {
    const chunk = new DataView(await file.slice(pos,pos+24).arrayBuffer());
    const id = fourCC(chunk,0), size = chunk.getUint32(4,true), start = pos+8;
    if (start+size > file.size) return null;
    if (id === 'fmt ' && size >= 16) {
      const type = chunk.getUint16(8,true), channels = chunk.getUint16(10,true);
      const rate = chunk.getUint32(12,true), stride = chunk.getUint16(20,true), bits = chunk.getUint16(22,true);
      if (!(type === 1 && [8,16,24,32].includes(bits) || type === 3 && bits === 32)
          || ![1,2].includes(channels) || stride !== channels*bits/8 || rate < 8000 || rate > 192000) return null;
      format = { channels, rate, stride, bits, fmt: chunk.buffer.slice(8,24) };
    } else if (id === 'data') {
      if (!format || !size || size % format.stride) return null;
      return { ...format, start, frames: size/format.stride };
    }
    pos = start+size+(size%2);
  }
  return null;
}

export async function* decodedWavChunks(ctx, file, layout, signal) {
  const { rate, stride, start, frames, bits, fmt } = layout, target = ctx.sampleRate;
  // Integer-second boundaries align input and output sample grids at every rate.
  // One second of context on either side keeps resampling away from chunk edges.
  const block = rate*8, guard = rate;
  for (let pos = 0; pos < frames; pos += block) {
    signal?.throwIfAborted();
    const lo = Math.max(0,pos-guard), end = Math.min(pos+block,frames), hi = Math.min(end+guard,frames);
    // A separately rounded final window can be one frame short. Give the
    // resampler its zero extension explicitly, then trim on the song's grid.
    const extend = rate !== target && pos > 0 && end === frames;
    const silence = new Uint8Array(extend ? 128*stride : 0);
    if (bits === 8) silence.fill(128);
    const bytes = (hi-lo)*stride + silence.length;
    const header = new DataView(new ArrayBuffer(44));
    header.setUint32(0,0x52494646); header.setUint32(4,36+bytes+(bytes%2),true);
    header.setUint32(8,0x57415645); header.setUint32(12,0x666d7420);
    header.setUint32(16,16,true); new Uint8Array(header.buffer,20,16).set(new Uint8Array(fmt));
    header.setUint32(36,0x64617461); header.setUint32(40,bytes,true);
    const blob = new Blob([header, file.slice(start+lo*stride,start+hi*stride), silence, new Uint8Array(bytes%2)]);
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const skip = (pos-lo)/rate*target;
    const count = end !== frames ? (end-pos)/rate*target :
      extend ? Math.floor(frames/(rate/target)) - pos/rate*target : buf.length-skip;
    if (count <= 0 || count+skip > buf.length) throw Error('WAV 구간의 길이를 읽지 못했습니다.');
    yield { buf, skip, count };
  }
}
