// 화면 부품: 슬라이더(값을 누르면 숫자 입력), 켜기 스위치, 접고 펴는 묶음
let undoHook = () => {};
export const setUndoHook = (fn) => { undoHook = fn; };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function slider({ label, min, max, step, get, set, show, unit }) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label></label><input type="range"><span class="val"></span>`;
  row.querySelector('label').textContent = label;
  const r = row.querySelector('input'), v = row.querySelector('.val');
  Object.assign(r, { min, max, step });
  r.value = get();
  const paint = () => { v.textContent = show(+r.value) + (unit ? ' ' + unit : ''); };
  paint();
  r.addEventListener('pointerdown', () => undoHook());
  r.addEventListener('keydown', () => undoHook());
  r.oninput = () => { set(+r.value); paint(); };
  v.onclick = () => {
    if (v.querySelector('input')) return;
    const box = document.createElement('input');
    box.type = 'number'; box.inputMode = 'decimal'; box.step = step; box.value = show(+r.value).replace('+', '');
    v.textContent = ''; v.appendChild(box); box.focus(); box.select();
    const done = (ok) => {
      if (!box.isConnected) return;
      const n = parseFloat(box.value);
      if (ok && isFinite(n)) { undoHook(); r.value = clamp(n, +min, +max); set(+r.value); }
      paint();
    };
    box.onkeydown = (ev) => { if (ev.key === 'Enter') box.blur(); if (ev.key === 'Escape') { box.value = 'x'; box.blur(); } };
    box.onblur = () => done(true);
  };
  return row;
}

export function toggle(on, onChange, label) {
  const b = document.createElement('button');
  b.className = 'sw' + (on ? ' on' : '');
  b.setAttribute('aria-label', label || '켜기');
  b.onclick = (e) => { e.stopPropagation(); undoHook(); const v = !b.classList.contains('on'); b.classList.toggle('on', v); onChange(v); };
  return b;
}

// 접고 펴는 묶음. sw: { get, set } 이면 제목 줄에 켜기 스위치
const openState = {};
export function section(key, title, sw, body) {
  const box = document.createElement('div');
  box.className = 'sec';
  const head = document.createElement('div');
  head.className = 'sec-h';
  head.innerHTML = `<i class="ic ic-chevron-down"></i><b></b>`;
  head.querySelector('b').textContent = title;
  if (sw) head.appendChild(toggle(sw.get(), sw.set, title + ' 켜기'));
  const inner = document.createElement('div');
  inner.className = 'sec-b';
  body(inner);
  const paint = () => { box.classList.toggle('open', !!openState[key]); };
  head.onclick = () => { openState[key] = !openState[key]; paint(); };
  box.append(head, inner);
  paint();
  return box;
}

export function segmented(options, value, onPick) {
  const g = document.createElement('div');
  g.className = 'seg';
  for (const [v, label] of options) {
    const b = document.createElement('button');
    b.textContent = label;
    b.classList.toggle('on', v === value);
    b.onclick = () => { for (const x of g.children) x.classList.toggle('on', x === b); onPick(v); };
    g.appendChild(b);
  }
  return g;
}
