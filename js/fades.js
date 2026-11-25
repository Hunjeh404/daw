// 구간 안의 페이드 배율. 위치와 길이는 모두 샘플 프레임 단위다.
export function fadeGain(pos, { a, b, fi, fo }) {
  let g = 1;
  if (fi && pos - a < fi) g *= Math.sin(Math.PI / 2 * Math.max(0, pos - a) / fi);
  if (fo && b - pos < fo) g *= Math.sin(Math.PI / 2 * Math.max(0, b - pos) / fo);
  return g;
}

export function fadeBuffer(L, R, start, range) {
  if (!range.fi && !range.fo) return;
  for (let i = 0; i < L.length; i++) {
    const g = fadeGain(start + i, range);
    L[i] *= g;
    R[i] *= g;
  }
}
