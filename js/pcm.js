// 저장해 둔 16비트 원본에서 타임라인 구간 [w0, w1)을 클립·페이드대로 읽어 실수 배열로 만든다.
// 메인 스레드와 분석 워커가 함께 쓴다. v: { segs, srcs: { sid: { file, ch, scale } } }
// 음원별 배율(0dB 넘는 부분 보존용)까지 되돌린 실제 크기로 돌려준다.
const HALF_PI = Math.PI / 2;

export async function readWindow(v, w0, w1) {
  const n = w1 - w0;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (const s of v.segs) {
    const src = v.srcs[s.sid];
    if (!src) continue;
    const ch = src.ch, bytes = 2 * ch, k = src.scale / 32768;
    const a = Math.max(w0, s.start), b = Math.min(w1, s.end);
    if (a >= b) continue;
    const src0 = s.src + (a - s.start);
    const ab = await src.file.slice(src0 * bytes, (src0 + (b - a)) * bytes).arrayBuffer();
    const d = new Int16Array(ab);
    const cnt = d.length / ch;
    for (let i = 0; i < cnt; i++) {
      const pos = a + i;
      let g = 1;
      const dd = pos - s.start;
      if (dd < s.fi) g *= Math.sin(HALF_PI * dd / s.fi);
      const e = s.end - pos;
      if (e < s.fo) g *= Math.sin(HALF_PI * e / s.fo);
      const l = d[i * ch] * k * g;
      L[pos - w0] += l;
      R[pos - w0] += (ch === 2 ? d[i * ch + 1] * k * g : l);
    }
  }
  return [L, R];
}
