// 저장해 둔 16비트 원본에서 타임라인 구간 [w0, w1)을 클립·페이드대로 읽어 실수 배열로 만든다.
// 메인 스레드와 분석 워커가 함께 쓴다. t: { file, ch, segs }
const HALF_PI = Math.PI / 2;

export async function readWindow(t, w0, w1) {
  const n = w1 - w0;
  const L = new Float32Array(n), R = new Float32Array(n);
  const bytes = 2 * t.ch;
  for (const s of t.segs) {
    const a = Math.max(w0, s.start), b = Math.min(w1, s.end);
    if (a >= b) continue;
    const src0 = s.src + (a - s.start);
    const ab = await t.file.slice(src0 * bytes, (src0 + (b - a)) * bytes).arrayBuffer();
    const d = new Int16Array(ab);
    const cnt = d.length / t.ch;
    for (let i = 0; i < cnt; i++) {
      const pos = a + i;
      let g = 1;
      const dd = pos - s.start;
      if (dd < s.fi) g *= Math.sin(HALF_PI * dd / s.fi);
      const e = s.end - pos;
      if (e < s.fo) g *= Math.sin(HALF_PI * e / s.fo);
      const l = d[i * t.ch] / 32768 * g;
      L[pos - w0] += l;
      R[pos - w0] += (t.ch === 2 ? d[i * t.ch + 1] / 32768 * g : l);
    }
  }
  return [L, R];
}
