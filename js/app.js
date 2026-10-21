import { Engine, SR, PEAK, newClipId } from './engine.js';
import { listZip, readEntry } from './zip.js';

const engine = new Engine();
const $ = (id) => document.getElementById(id);
const view = $('view'), content = $('content'), tracksEl = $('tracks'), ruler = $('ruler');
const DPR = () => window.devicePixelRatio || 1;

let loading = false;
let pps = 20;                 // 1초당 픽셀
let laneW = 300;              // 파형 칸 너비(CSS px)
let sel = null;               // { t, c }
let moveMode = false;
let fadeOpen = false;
let undoStack = [], redoStack = [];
let lastUserScroll = 0;
let progScroll = false;
let dirty = true;

const cleared = engine.clearStore();

// ---------- 공통 ----------
const fmt = (frames, tenth) => {
  const s = Math.max(0, frames / SR);
  const m = Math.floor(s / 60), r = s - m * 60;
  return tenth ? `${m}:${r.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(r)).padStart(2, '0')}`;
};
const isAudio = (n) => /\.(mp3|wav)$/i.test(n) && !/(^|\/)(__MACOSX\/|\._)/.test(n);
const baseName = (n) => n.split('/').pop().replace(/\.(mp3|wav)$/i, '');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
let subMsg = '';
function sub(text) { subMsg = text; $('sub').textContent = text; }
function flash(text) { const keep = subMsg; $('sub').textContent = text; setTimeout(() => { $('sub').textContent = keep; }, 1800); }
const redraw = () => { dirty = true; };

// 트랙 이름으로 색 자동 지정
const COLORS = [
  [/back(ing)?[\s_-]*vo|코러스|chorus|harmon/i, '#8fd3a8'],
  [/vo(cal|x)|보컬|lead|sing/i, '#5fbf8f'],
  [/drum|드럼|kick|snare|hat|cymbal/i, '#d0605e'],
  [/perc|퍼커/i, '#e07a4f'],
  [/bass|베이스/i, '#d9a441'],
  [/guitar|기타/i, '#6b86e0'],
  [/piano|피아노|key|건반|organ|rhodes/i, '#a7adb7'],
  [/synth|신스|pad|lead[\s_-]*synth/i, '#b07fd6'],
  [/string|스트링|violin|viola|cello|현악/i, '#57b8c9'],
  [/brass|브라스|trumpet|trombone|horn/i, '#e6c35c'],
  [/wood|flute|sax|clarinet|목관/i, '#9bbf5f'],
  [/fx|effect|효과|sfx/i, '#7d8794'],
];
const SPARE = ['#5f8fbf', '#c27aa8', '#7fb8a0', '#c9925f', '#8c86d9', '#6fa3b5'];
function colorFor(name) {
  for (const [re, c] of COLORS) if (re.test(name)) return c;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SPARE[h % SPARE.length];
}

// ---------- 되돌리기 ----------
function snapshot() {
  return engine.tracks.map((t) => ({ clips: t.clips.map((c) => ({ ...c })), xfade: t.xfade, volumeDb: t.volumeDb, muted: t.muted, solo: t.solo }));
}
function restore(s) {
  engine.tracks.forEach((t, i) => {
    Object.assign(t, { clips: s[i].clips.map((c) => ({ ...c })), xfade: s[i].xfade, volumeDb: s[i].volumeDb, muted: s[i].muted, solo: s[i].solo });
    engine.updateSegs(t);
  });
  engine.applyGains();
  if (sel) {
    const c = sel.t.clips.find((x) => x.id === sel.c.id);
    sel = c ? { t: sel.t, c } : null;
  }
  afterChange();
}
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  updateUndoBtns();
}
function updateUndoBtns() {
  $('undo').disabled = !undoStack.length;
  $('redo').disabled = !redoStack.length;
}
$('undo').onclick = () => { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); updateUndoBtns(); };
$('redo').onclick = () => { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); updateUndoBtns(); };

function afterChange() {
  for (const t of engine.tracks) updateHead(t);
  layout();
  renderPanel();
  redraw();
}

// ---------- 불러오기 ----------
$('load').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  await cleared;
  await engine.init();
  engine.stop();
  updatePlayBtn();

  const jobs = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      try {
        const entries = await listZip(f);
        for (const en of entries) if (isAudio(en.name)) jobs.push({ name: baseName(en.name), get: () => readEntry(f, en) });
      } catch (err) { flash(f.name + ': ' + err.message); return; }
    } else if (isAudio(f.name)) {
      jobs.push({ name: baseName(f.name), get: () => f.arrayBuffer() });
    }
  }
  if (!jobs.length) { flash('불러올 MP3·WAV가 없습니다'); return; }
  jobs.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));

  const first = !engine.tracks.length;
  loading = true;
  for (let i = 0; i < jobs.length; i++) {
    sub(`불러오는 중 ${i + 1}/${jobs.length}: ${jobs[i].name}`);
    try {
      const t = await engine.addTrack(jobs[i].name, await jobs[i].get());
      t.color = colorFor(t.name);
      renderTrack(t);
    } catch (err) {
      flash(err.name === 'QuotaExceededError' ? `폰 저장공간이 부족해 ${jobs[i].name}부터 불러오지 못했습니다` : `${jobs[i].name}: 읽지 못했습니다 (${err.message})`);
      console.error(jobs[i].name, err);
      await new Promise((r) => setTimeout(r, 1500));
      if (err.name === 'QuotaExceededError') break;
    }
  }
  loading = false;
  engine.applyGains();
  if (first) fitZoom();
  afterChange();
  showStats();
};

// ---------- 트랙 카드 ----------
function renderTrack(t) {
  if (engine.tracks.length === 1) tracksEl.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'stick trow';
  row.innerHTML = `
    <div class="track">
      <div class="head">
        <span class="dot"></span><div class="name"></div>
        <button class="m" aria-label="음소거">M</button>
        <button class="s" aria-label="솔로">S</button>
      </div>
      <canvas class="lane"></canvas>
    </div>`;
  row.querySelector('.name').textContent = t.name;
  row.querySelector('.dot').style.background = t.color;
  row.querySelector('.m').onclick = () => { pushUndo(); t.muted = !t.muted; engine.applyGains(); afterChange(); };
  row.querySelector('.s').onclick = () => { pushUndo(); t.solo = !t.solo; engine.applyGains(); afterChange(); };
  tracksEl.appendChild(row);
  t.row = row;
  t.lane = row.querySelector('canvas');
  t.lane.classList.toggle('moving', moveMode);
  bindLane(t);
  layout();
}

function updateHead(t) {
  if (!t.row) return;
  t.row.querySelector('.m').classList.toggle('on', t.muted);
  t.row.querySelector('.s').classList.toggle('on', t.solo);
}

// ---------- 배치·확대 ----------
function layout() {
  const vw = view.clientWidth;
  const durS = Math.max(engine.duration / SR, 1);
  content.style.width = Math.max(vw, Math.ceil(durS * pps + vw * 0.5)) + 'px';
  $('rulerBox').style.width = vw + 'px';
  for (const el of tracksEl.children) el.style.width = vw + 'px';
  laneW = ruler.clientWidth || vw - 42;
  const d = DPR();
  const sizeCanvas = (c) => {
    const w = Math.round(c.clientWidth * d), h = Math.round(c.clientHeight * d);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  };
  sizeCanvas(ruler);
  for (const t of engine.tracks) if (t.lane) sizeCanvas(t.lane);
  redraw();
}
window.addEventListener('resize', layout);

function fitZoom() {
  layout();
  pps = laneW / Math.max(engine.duration / SR, 1);
  view.scrollLeft = 0;
  layout();
}
function zoom(f) {
  const center = (view.scrollLeft + laneW / 2) / pps;
  const minPps = laneW / Math.max(engine.duration / SR, 1);
  pps = clamp(pps * f, minPps, 400);
  layout();
  view.scrollLeft = center * pps - laneW / 2;
  redraw();
}
$('zin').onclick = () => zoom(1.6);
$('zout').onclick = () => zoom(1 / 1.6);
view.addEventListener('scroll', () => { if (progScroll) progScroll = false; else lastUserScroll = performance.now(); redraw(); }, { passive: true });

const xToFrame = (x) => Math.round(((view.scrollLeft + x) / pps) * SR);
const frameToX = (f) => (f / SR) * pps - view.scrollLeft;

// ---------- 그리기 ----------
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function drawRuler() {
  const g = ruler.getContext('2d'), d = DPR();
  const w = ruler.width, h = ruler.height;
  g.setTransform(d, 0, 0, d, 0, 0);
  g.clearRect(0, 0, w, h);
  const cw = w / d, ch = h / d;
  const L = engine.loop;
  if (L.end > L.start) {
    const x0 = frameToX(L.start), x1 = frameToX(L.end);
    g.fillStyle = L.on ? 'rgba(233,162,59,.28)' : 'rgba(138,143,153,.18)';
    g.fillRect(x0, 0, x1 - x0, ch);
  }
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  const step = steps.find((s) => s * pps >= 56) || 120;
  const t0 = Math.floor(view.scrollLeft / pps / step) * step;
  g.fillStyle = '#8a8f99';
  g.strokeStyle = '#3a3f48';
  g.font = '11px system-ui, sans-serif';
  g.textBaseline = 'top';
  for (let s = t0; s * pps - view.scrollLeft < cw; s += step) {
    const x = Math.round(s * pps - view.scrollLeft) + 0.5;
    g.beginPath(); g.moveTo(x, ch - 8); g.lineTo(x, ch); g.stroke();
    const m = Math.floor(s / 60), r = s - m * 60;
    g.fillText(`${m}:${(step < 1 ? r.toFixed(1) : String(Math.round(r))).padStart(step < 1 ? 4 : 2, '0')}`, x + 3, 4);
  }
  const px = frameToX(engine.position);
  g.fillStyle = '#e9a23b';
  g.beginPath(); g.moveTo(px - 5, ch - 9); g.lineTo(px + 5, ch - 9); g.lineTo(px, ch - 2); g.fill();
}

function drawLane(t) {
  const c = t.lane, g = c.getContext('2d'), d = DPR();
  const cw = c.width / d, ch = c.height / d;
  g.setTransform(d, 0, 0, d, 0, 0);
  g.fillStyle = '#181a1f';
  g.fillRect(0, 0, cw, ch);
  const dim = t.muted || (engine.tracks.some((x) => x.solo) && !t.solo);
  const sl = view.scrollLeft;
  const clips = [...t.clips].sort((a, b) => a.start - b.start);
  for (const cl of clips) {
    const x0 = (cl.start / SR) * pps - sl, x1 = ((cl.start + cl.len) / SR) * pps - sl;
    if (x1 < 0 || x0 > cw) continue;
    const isSel = sel && sel.c === cl;
    g.fillStyle = hexA(t.color, dim ? 0.06 : 0.16);
    g.fillRect(x0, 1, x1 - x0, ch - 2);
    g.fillStyle = dim ? hexA(t.color, 0.35) : t.color;
    const mid = ch / 2, amp = ch / 2 - 4;
    const a = Math.max(0, Math.floor(x0)), b = Math.min(cw, Math.ceil(x1));
    for (let x = a; x < b; x++) {
      const f0 = ((sl + x) / pps) * SR - cl.start, f1 = ((sl + x + 1) / pps) * SR - cl.start;
      if (f1 <= 0 || f0 >= cl.len) continue;
      const p0 = Math.floor((cl.src + Math.max(0, f0)) / PEAK), p1 = Math.floor((cl.src + Math.min(cl.len, f1)) / PEAK);
      let m = 0;
      for (let k = p0; k <= p1 && k < t.peaks.length; k++) if (t.peaks[k] > m) m = t.peaks[k];
      const fm = (f0 + f1) / 2;
      let env = 1;
      if (cl.fi > 0 && fm < cl.fi) env *= Math.sin((Math.PI / 2) * Math.max(0, fm) / cl.fi);
      if (cl.fo > 0 && cl.len - fm < cl.fo) env *= Math.sin((Math.PI / 2) * Math.max(0, cl.len - fm) / cl.fo);
      const y = Math.max(0.5, m * env * amp);
      g.fillRect(x, mid - y, 1, y * 2);
    }
    // 페이드 선
    g.strokeStyle = 'rgba(232,233,236,.55)';
    g.lineWidth = 1;
    if (cl.fi > 0) { const fx = x0 + (cl.fi / SR) * pps; g.beginPath(); g.moveTo(x0, ch - 2); g.lineTo(fx, 2); g.stroke(); }
    if (cl.fo > 0) { const fx = x1 - (cl.fo / SR) * pps; g.beginPath(); g.moveTo(fx, 2); g.lineTo(x1, ch - 2); g.stroke(); }
    g.strokeStyle = isSel ? '#e9a23b' : 'rgba(0,0,0,.6)';
    g.lineWidth = isSel ? 2 : 1;
    g.strokeRect(x0 + 1, 1, x1 - x0 - 2, ch - 2);
  }
  const L = engine.loop;
  if (L.on && L.end > L.start) {
    g.fillStyle = 'rgba(233,162,59,.07)';
    g.fillRect(frameToX(L.start), 0, frameToX(L.end) - frameToX(L.start), ch);
  }
  const px = Math.round(frameToX(engine.position));
  g.fillStyle = '#e9a23b';
  g.fillRect(px - 1, 0, 2, ch);
}

function draw() {
  drawRuler();
  for (const t of engine.tracks) if (t.lane) drawLane(t);
}

// ---------- 터치: 파형 칸 ----------
function clipAt(t, f) {
  const hits = t.clips.filter((c) => f >= c.start && f < c.start + c.len).sort((a, b) => a.start - b.start);
  return hits[hits.length - 1] || null;
}

function bindLane(t) {
  const lane = t.lane;
  let st = null;
  lane.addEventListener('pointerdown', (e) => {
    const r = lane.getBoundingClientRect();
    const x = e.clientX - r.left;
    const f = xToFrame(x);
    st = { x0: e.clientX, y0: e.clientY, moved: false, f };
    if (moveMode) {
      const hit = clipAt(t, f);
      if (sel && sel.t === t && hit === sel.c) {
        pushUndo();
        st.drag = { orig: sel.c.start };
      } else {
        st.scroll = view.scrollLeft;
      }
      lane.setPointerCapture(e.pointerId);
    }
  });
  lane.addEventListener('pointermove', (e) => {
    if (!st) return;
    const dx = e.clientX - st.x0;
    if (Math.abs(dx) > 8 || Math.abs(e.clientY - st.y0) > 8) st.moved = true;
    if (st.drag) {
      sel.c.start = Math.max(0, Math.round(st.drag.orig + (dx / pps) * SR));
      redraw();
    } else if (st.scroll !== undefined && Math.abs(dx) > 4) {
      view.scrollLeft = st.scroll - dx;
    }
  });
  const end = (e, cancel) => {
    if (!st) return;
    const s = st; st = null;
    if (s.drag) {
      if (sel.c.start === s.drag.orig) undoStack.pop(), updateUndoBtns();
      else { engine.updateSegs(t); afterChange(); }
      return;
    }
    if (cancel || s.moved) return;
    const hit = clipAt(t, s.f);
    sel = hit ? { t, c: hit } : null;
    engine.seek(clamp(s.f, 0, engine.duration));
    renderPanel();
    redraw();
  };
  lane.addEventListener('pointerup', (e) => end(e, false));
  lane.addEventListener('pointercancel', (e) => end(e, true));
}

// ---------- 터치: 눈금자 (누르면 이동, 끌면 반복 구간) ----------
{
  let st = null;
  ruler.addEventListener('pointerdown', (e) => {
    const r = ruler.getBoundingClientRect();
    st = { x0: e.clientX, f0: xToFrame(e.clientX - r.left), drag: false };
    ruler.setPointerCapture(e.pointerId);
  });
  ruler.addEventListener('pointermove', (e) => {
    if (!st) return;
    if (!st.drag && Math.abs(e.clientX - st.x0) > 8) st.drag = true;
    if (st.drag) {
      const r = ruler.getBoundingClientRect();
      const f1 = clamp(xToFrame(e.clientX - r.left), 0, engine.duration);
      const a = clamp(st.f0, 0, engine.duration);
      engine.loop = { ...engine.loop, start: Math.min(a, f1), end: Math.max(a, f1) };
      redraw();
    }
  });
  const end = async (cancel) => {
    if (!st) return;
    const s = st; st = null;
    if (s.drag) {
      await engine.setLoop(true, engine.loop.start, engine.loop.end);
      updateLoopBtn();
    } else if (!cancel) {
      await engine.seek(clamp(s.f0, 0, engine.duration));
    }
    redraw();
  };
  ruler.addEventListener('pointerup', () => end(false));
  ruler.addEventListener('pointercancel', () => end(true));
}

// ---------- 편집 패널 ----------
function slider({ label, min, max, step, get, set, show, unit }) {
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<label></label><input type="range"><span class="val"></span>`;
  row.querySelector('label').textContent = label;
  const r = row.querySelector('input'), v = row.querySelector('.val');
  Object.assign(r, { min, max, step });
  r.value = get();
  const paint = () => { v.textContent = show(+r.value) + (unit ? ' ' + unit : ''); };
  paint();
  r.addEventListener('pointerdown', pushUndo);
  r.addEventListener('keydown', pushUndo);
  r.oninput = () => { set(+r.value); paint(); };
  v.onclick = () => {
    if (v.querySelector('input')) return;
    const box = document.createElement('input');
    box.type = 'number'; box.inputMode = 'decimal'; box.step = step; box.value = show(+r.value);
    v.textContent = ''; v.appendChild(box); box.focus(); box.select();
    const done = (ok) => {
      if (!box.isConnected) return;
      const n = parseFloat(box.value);
      if (ok && isFinite(n)) { pushUndo(); r.value = clamp(n, +min, +max); set(+r.value); }
      paint();
    };
    box.onkeydown = (ev) => { if (ev.key === 'Enter') box.blur(); if (ev.key === 'Escape') { box.value = 'x'; box.blur(); } };
    box.onblur = () => done(true);
  };
  return row;
}

function renderPanel() {
  const p = $('panel');
  if (!sel || !engine.tracks.includes(sel.t) || !sel.t.clips.includes(sel.c)) { sel = null; p.hidden = true; return; }
  p.hidden = false;
  const { t, c } = sel;
  const idx = [...t.clips].sort((a, b) => a.start - b.start).indexOf(c);
  $('pTitle').textContent = `${t.name} · 클립 ${idx + 1}`;
  $('aFade').classList.toggle('on', fadeOpen);
  $('aMove').classList.toggle('on', moveMode);
  $('xfade').classList.toggle('on', t.xfade);
  const fb = $('fadeBox');
  fb.hidden = !fadeOpen;
  fb.innerHTML = '';
  if (fadeOpen) {
    const maxS = Math.min(10, c.len / SR);
    const mk = (label, key) => slider({
      label, min: 0, max: maxS.toFixed(2), step: 0.05, unit: '초',
      get: () => c[key] / SR, show: (v) => v.toFixed(2),
      set: (v) => { c[key] = Math.round(v * SR); if (c.fi + c.fo > c.len) c[key] = c.len - (key === 'fi' ? c.fo : c.fi); engine.updateSegs(t); redraw(); },
    });
    fb.append(mk('페이드 인', 'fi'), mk('페이드 아웃', 'fo'));
  }
  const vb = $('volBox');
  vb.innerHTML = '';
  vb.append(slider({
    label: '트랙 볼륨', min: -24, max: 6, step: 0.1, unit: 'dB',
    get: () => t.volumeDb, show: (v) => (v > 0 ? '+' : '') + v.toFixed(1),
    set: (v) => { t.volumeDb = v; engine.applyGains(); },
  }));
}

$('pFold').onclick = () => {
  const p = $('panel');
  p.classList.toggle('fold');
  $('pFold').innerHTML = `<i class="ic ${p.classList.contains('fold') ? 'ic-chevron-up' : 'ic-chevron-down'}"></i>`;
  layout();
};

$('aCut').onclick = () => {
  if (!sel) return;
  const { t, c } = sel;
  const p = engine.position;
  if (p <= c.start + SR / 100 || p >= c.start + c.len - SR / 100) { flash('재생 위치를 클립 안에 두고 자르세요'); return; }
  pushUndo();
  const left = p - c.start;
  const c2 = { id: newClipId(), start: p, src: c.src + left, len: c.len - left, fi: 0, fo: c.fo };
  c.len = left; c.fo = 0;
  if (c.fi > c.len) c.fi = c.len;
  if (c2.fo > c2.len) c2.fo = c2.len;
  t.clips.push(c2);
  engine.updateSegs(t);
  sel = { t, c: c2 };
  afterChange();
};
$('aDel').onclick = () => {
  if (!sel) return;
  pushUndo();
  const { t, c } = sel;
  t.clips = t.clips.filter((x) => x !== c);
  sel = null;
  engine.updateSegs(t);
  afterChange();
};
$('aFade').onclick = () => { fadeOpen = !fadeOpen; renderPanel(); layout(); };
$('aMove').onclick = () => {
  moveMode = !moveMode;
  for (const t of engine.tracks) t.lane && t.lane.classList.toggle('moving', moveMode);
  renderPanel();
};
$('xfade').onclick = () => {
  if (!sel) return;
  pushUndo();
  sel.t.xfade = !sel.t.xfade;
  engine.updateSegs(sel.t);
  renderPanel();
};

// ---------- 재생 ----------
function updatePlayBtn() {
  $('play').innerHTML = `<i class="ic ${engine.playing ? 'ic-player-pause' : 'ic-player-play'}"></i>`;
}
function updateLoopBtn() { $('loop').classList.toggle('on', engine.loop.on); }

$('play').onclick = async () => {
  if (!engine.tracks.length) return;
  if (engine.playing) engine.stop(); else await engine.play();
  updatePlayBtn();
};
$('home').onclick = async () => { await engine.seek(engine.loop.on ? engine.loop.start : 0); redraw(); };
$('loop').onclick = async () => {
  if (!engine.tracks.length) return;
  const L = engine.loop;
  if (!L.on && L.end - L.start < SR / 10) {
    if (sel) await engine.setLoop(true, sel.c.start, sel.c.start + sel.c.len);
    else await engine.setLoop(true, 0, engine.duration);
  } else {
    await engine.setLoop(!L.on, L.start, L.end);
  }
  updateLoopBtn();
  redraw();
};
engine.onEnd = () => { updatePlayBtn(); redraw(); };

// ---------- 탭 ----------
for (const b of document.querySelectorAll('nav button')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('nav button')) x.classList.toggle('on', x === b);
    for (const s of document.querySelectorAll('.tab')) s.classList.toggle('show', s.id === 'tab-' + b.dataset.tab);
    layout();
  };
}

// ---------- 상태 ----------
function showStats() {
  if (!engine.tracks.length || loading) return;
  const under = engine.tracks.reduce((s, t) => s + t.under, 0);
  sub(`${engine.tracks.length}트랙 · 끊김 ${under}회`);
}
setInterval(showStats, 2000);

(function loop() {
  if (engine.ctx) {
    const pos = engine.position;
    $('time').innerHTML = `<b>${fmt(pos, true)}</b> / ${fmt(engine.duration)}`;
    if (engine.playing) {
      // 사용자가 직접 넘겨 보는 중이 아니면 재생 위치를 따라감
      const x = frameToX(pos);
      if (performance.now() - lastUserScroll > 1500 && (x < 0 || x > laneW * 0.9)) {
        progScroll = true;
        view.scrollLeft = (pos / SR) * pps - laneW * 0.1;
      }
      dirty = true;
    }
    if (dirty) { dirty = false; draw(); }
  }
  requestAnimationFrame(loop);
})();
