// MP3 인코딩은 화면이 멈추지 않게 워커에서 한다.
import { Mp3Encoder } from './vendor/lamejs.js';

let enc = null;
onmessage = (e) => {
  const m = e.data;
  if (m.type === 'start') { enc = new Mp3Encoder(2, m.sr, m.kbps); return; }
  if (m.type === 'data') {
    const out = enc.encodeBuffer(m.l, m.r);
    postMessage({ type: 'out', id: m.id, bytes: out.length ? new Uint8Array(out) : null });
    return;
  }
  if (m.type === 'end') {
    const out = enc.flush();
    postMessage({ type: 'end', bytes: out.length ? new Uint8Array(out) : null });
  }
};
