import { Engine, SR, PEAK, newClipId } from './engine.js';
import { listZip, readEntry } from './zip.js';
import { colorFor } from './cats.js';
import { slider, setUndoHook, segmented } from './ui.js';
import { initMix } from './mix.js';
import { initExport } from './exportui.js';
import { initProjects } from './projectui.js';
import { matchSource } from './project.js';

const engine = new Engine();
const $ = (id) => document.getElementById(id);
const view = $('view'), content = $('content'), tracksEl = $('tracks'), ruler = $('ruler');
const DPR = () => window.devicePixelRatio || 1;

let loading = false;
let busy = false;              // 자동 분석 중
let pps = 20;                 // 1초당 픽셀
let laneW = 300;              // 파형 칸 너비(CSS px)
let sel = null;               // { t, c }
let curT = null;              // 고른 트랙 (붙여넣기 대상)
let clipBoard = null;         // 복사한 클립 { sid, src, len, fi, fo }
let moveMode = false;
let fadeOpen = false;
let undoStack = [], redoStack = [];
let lastUserScroll = 0;
let progScroll = false;
let dirty = true;

const cleared = engine.prepareStore();

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
function flash(text) { flash.at = Date.now(); $('sub').textContent = text; clearTimeout(flash.t); flash.t = setTimeout(() => { $('sub').textContent = subMsg; showStats(); }, 2500); }
const redraw = () => { dirty = true; };

// ---------- 되돌리기 ----------
function snapshot() {
  return {
    tracks: engine.tracks.map((t) => ({ id: t.id, clips: t.clips.map((c) => ({ ...c })), xfade: t.xfade, volumeDb: t.volumeDb, muted: t.muted, solo: t.solo, mix: structuredClone(t.mix) })),
    mm: structuredClone(engine.mm),
  };
}
function restore(s) {
  engine.tracks.forEach((t) => {
    const x = s.tracks.find((y) => y.id === t.id);
    if (!x) { t.clips = []; engine.updateSegs(t); return; }   // 그 뒤에 만든 빈 트랙
    Object.assign(t,{ clips: x.clips.map((c) => ({ ...c })), xfade: x.xfade, volumeDb: x.volumeDb, muted: x.muted, solo: x.solo, mix: structuredClone(x.mix) });
    engine.updateSegs(t);
  });
  engine.mm = structuredClone(s.mm);
  if (!engine.hasRef && engine.mode === 'ref') engine.mode = 'apply';
  engine.applyAll();
  renderCompare();
  if (document.getElementById('tab-mix').classList.contains('show')) mix.render();
  if (sel) {
    const id = sel.c.id;
    sel = null;
    for (const t of engine.tracks) { const c = t.clips.find((x) => x.id === id); if (c) { sel = { t, c }; curT = t; } }
  }
  afterChange();
}
setUndoHook(() => pushUndo());
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  updateUndoBtns();
}
function updateUndoBtns() {
  for (const b of document.querySelectorAll('#undo, .undo-btn')) b.disabled = !undoStack.length;
  for (const b of document.querySelectorAll('#redo, .redo-btn')) b.disabled = !redoStack.length;
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
$('file').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; loadFiles(f, false); };
$('relinkBtn').onclick = () => $('relinkFile').click();
$('relinkFile').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; loadFiles(f, true); };

async function loadFiles(files, relink) {
  if (!files.length || loading) return;
  await cleared;
  await engine.init();
  engine.stop();
  updatePlayBtn();

  const jobs = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      try {
        const entries = await listZip(f);
        for (const en of entries) if (isAudio(en.name)) jobs.push({ name: baseName(en.name), wav: /\.wav$/i.test(en.name), get: () => readEntry(f, en) });
      } catch (err) { flash(f.name + ': ' + err.message); return; }
    } else if (isAudio(f.name)) {
      jobs.push({ name: baseName(f.name), wav: /\.wav$/i.test(f.name), get: () => f.arrayBuffer() });
    }
  }
  if (!jobs.length) { flash('불러올 MP3·WAV가 없습니다'); return; }
  // 같은 이름이 여러 번 들어 있으면 (zip 안에 WAV·MP3가 함께 있거나 폴더가 겹칠 때) 하나만, WAV를 먼저
  {
    const pick = new Map();
    for (const j of jobs) { const o = pick.get(j.name); if (!o || (j.wav && !o.wav)) pick.set(j.name, j); }
    jobs.splice(0, jobs.length, ...pick.values());
  }
  jobs.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
  // 연결할 때는 빈 자리 이름과 같은 파일을 먼저
  const holes0 = engine.missingSources;
  if (holes0.length) {
    const names = new Set(holes0.map((m) => m.name));
    jobs.sort((a, b) => (names.has(b.name) ? 1 : 0) - (names.has(a.name) ? 1 : 0));
  }

  const first = !engine.tracks.length;
  const added = [], wrong = [];
  let linked = 0;
  loading = true; engine.loading = true; refreshTabs();
  for (let i = 0; i < jobs.length; i++) {
    if (relink && !engine.missingSources.length) break;
    sub(`${relink ? '연결하는' : '불러오는'} 중 ${i + 1}/${jobs.length}: ${jobs[i].name}`);
    try {
      const src = await engine.addSource(jobs[i].name, await jobs[i].get());
      const hole = matchSource(engine, src);
      if (hole) {
        engine.fillSource(hole, src);
        linked++;
      } else if (relink) {
        wrong.push(jobs[i].name);
        await engine.removeSource(src);
      } else {
        const t = engine.makeTrack(src.name);
        t.home = src.sid;
        t.clips = [{ id: newClipId(), sid: src.sid, start: 0, src: 0, len: src.frames, fi: 0, fo: 0 }];
        t.color = colorFor(t.name);
        engine.updateSegs(t);
        renderTrack(t);
        added.push(t);
      }
      await new Promise((r) => setTimeout(r, 50));   // 다음 파일 전에 메모리 정리할 틈
    } catch (err) {
      flash(err.name === 'QuotaExceededError' ? `폰 저장공간이 부족해 ${jobs[i].name}부터 불러오지 못했습니다` : `${jobs[i].name}: 읽지 못했습니다 (${err.message})`);
      console.error(jobs[i].name, err);
      await new Promise((r) => setTimeout(r, 1500));
      if (err.name === 'QuotaExceededError') break;
    }
  }
  loading = false; engine.loading = false;
  orderRows();
  engine.applyAll();
  if (first || linked) fitZoom();
  afterChange();
  renderCompare();
  refreshTabs();
  paintRelink();
  if (linked || wrong.length) {
    const left = engine.missingSources.length;
    flash(`음원 ${linked}개 연결` + (wrong.length ? ` · 프로젝트에 없는 음원: ${wrong.join(', ')}` : '') + (left ? ` · 아직 연결 안 된 음원 ${left}개` : ''));
  }
  // 처음 올릴 때, 또는 원곡이 있는 상태에서 스템을 더 올릴 때 자동으로 믹싱·마스터를 잡는다 (연결은 저장된 설정 그대로)
  if (added.length && (first || engine.hasRef)) await mix.autoNew(added);
  showStats();
}

function orderRows() {
  for (const t of engine.tracks) if (t.row) tracksEl.appendChild(t.row);
}
function paintRelink() {
  const n = engine.missingSources.length;
  $('relinkBar').hidden = !n;
  $('relinkText').textContent = `연결 안 된 음원 ${n}개 · zip이나 파일을 고르면 이름과 길이로 맞춰 연결합니다`;
  layout();
}

// ---------- 트랙 카드 ----------
function renderTrack(t) {
  tracksEl.querySelector('.empty')?.remove();
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
  t.row.querySelector('.name').textContent = t.name + (t.mix.ref ? ' (원곡)' : '');
  t.row.querySelector('.m').classList.toggle('on', t.muted);
  t.row.querySelector('.s').classList.toggle('on', t.solo);
  t.row.classList.toggle('cur', t === curT);
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
// 두 손가락으로 벌리고 모으기: 손가락 사이 지점을 기준으로 확대·축소
let pinching = false;
{
  let p0 = null;
  const two = (e) => {
    const [a, b] = e.touches;
    const rl = ruler.getBoundingClientRect().left;
    return { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx: (a.clientX + b.clientX) / 2 - rl };
  };
  view.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    pinching = true;
    const t = two(e);
    p0 = { d: Math.max(t.d, 10), pps, sec: (view.scrollLeft + t.cx) / pps };
  }, { passive: true });
  view.addEventListener('touchmove', (e) => {
    if (!p0 || e.touches.length !== 2) return;
    if (e.cancelable) e.preventDefault();
    const t = two(e);
    const minPps = laneW / Math.max(engine.duration / SR, 1);
    pps = clamp(p0.pps * (t.d / p0.d), minPps, 400);
    layout();
    view.scrollLeft = p0.sec * pps - t.cx;
    lastUserScroll = performance.now();
    redraw();
  }, { passive: false });
  const end = (e) => {
    if (e.touches.length >= 2) return;
    p0 = null;
    if (pinching && !e.touches.length) setTimeout(() => { pinching = false; }, 0);
  };
  view.addEventListener('touchend', end);
  view.addEventListener('touchcancel', end);
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
    const srcObj = engine.sources.get(cl.sid);
    if (!srcObj || srcObj.missing) {
      // 음원이 아직 없는 조각
      g.fillStyle = 'rgba(138,143,153,.12)';
      g.fillRect(x0, 1, x1 - x0, ch - 2);
      g.strokeStyle = isSel ? '#e9a23b' : 'rgba(138,143,153,.6)';
      g.setLineDash([4, 4]); g.lineWidth = isSel ? 2 : 1; g.strokeRect(x0 + 1, 1, x1 - x0 - 2, ch - 2); g.setLineDash([]);
      g.fillStyle = '#8a8f99'; g.font = '12px system-ui, sans-serif'; g.textBaseline = 'middle';
      g.fillText('음원 없음', Math.max(x0, 0) + 8, ch / 2);
      continue;
    }
    const pk = srcObj.peaks, sc = srcObj.scale;
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
      for (let k = p0; k <= p1 && k < pk.length; k++) if (pk[k] > m) m = pk[k];
      const fm = (f0 + f1) / 2;
      let env = 1;
      if (cl.fi > 0 && fm < cl.fi) env *= Math.sin((Math.PI / 2) * Math.max(0, fm) / cl.fi);
      if (cl.fo > 0 && cl.len - fm < cl.fo) env *= Math.sin((Math.PI / 2) * Math.max(0, cl.len - fm) / cl.fo);
      const y = Math.max(0.5, Math.min(1, m * sc) * env * amp);
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
    if (pinching) { st.pinched = true; return; }
    const dx = e.clientX - st.x0;
    if (Math.abs(dx) > 8 || Math.abs(e.clientY - st.y0) > 8) st.moved = true;
    if (st.drag) {
      sel.c.start = Math.max(0, Math.round(st.drag.orig + (dx / pps) * SR));
      // 위아래로 끌면 다른 트랙에 놓을 수 있다. 화면 끝 가까이면 위아래로 넘긴다
      const vr = view.getBoundingClientRect(), top = $('rulerBox').getBoundingClientRect().bottom;
      if (e.clientY < top + 20) view.scrollTop -= 12;
      else if (e.clientY > vr.bottom - 40) view.scrollTop += 12;
      const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('.trow');
      const to = engine.tracks.find((x) => x.row === row && x !== t) || null;
      if (st.drop !== to) {
        st.drop?.row.classList.remove('drop');
        to?.row.classList.add('drop');
        st.drop = to;
      }
      redraw();
    } else if (st.scroll !== undefined && Math.abs(dx) > 4) {
      view.scrollLeft = st.scroll - dx;
    }
  });
  const end = (e, cancel) => {
    if (!st) return;
    const s = st; st = null;
    if (s.pinched || pinching) {
      // 확대·축소하던 손가락이면 고르기·이동은 하지 않는다
      s.drop?.row.classList.remove('drop');
      if (s.drag) { sel.c.start = s.drag.orig; undoStack.pop(); updateUndoBtns(); redraw(); }
      return;
    }
    if (s.drag) {
      const to = cancel ? null : s.drop;
      to?.row.classList.remove('drop');
      if (to) {
        const c = sel.c;
        t.clips = t.clips.filter((x) => x !== c);
        to.clips.push(c);
        engine.updateSegs(to);
        sel = { t: to, c }; curT = to;
      }
      if (!to && sel.c.start === s.drag.orig) undoStack.pop(), updateUndoBtns();
      else { engine.updateSegs(t); afterChange(); }
      return;
    }
    if (cancel || s.moved) return;
    const hit = clipAt(t, s.f);
    sel = hit ? { t, c: hit } : null;
    curT = t;
    for (const x of engine.tracks) updateHead(x);
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
function renderPanel() {
  const p = $('panel');
  if (sel && (!engine.tracks.includes(sel.t) || !sel.t.clips.includes(sel.c))) sel = null;
  if (curT && !engine.tracks.includes(curT)) curT = null;
  if (!curT) { p.hidden = true; return; }
  p.hidden = false;
  const t = curT, c = sel && sel.t === t ? sel.c : null;
  for (const id of ['aCut', 'aCutX', 'aCopy', 'aDel', 'aFade']) $(id).disabled = !c;
  $('aPaste').disabled = !clipBoard;
  if (!c) {
    $('pTitle').textContent = `${t.name} · 클립 없음`;
    $('aMove').classList.toggle('on', moveMode);
    $('xfade').classList.toggle('on', t.xfade);
    $('fadeBox').hidden = true;
    renderVol(t);
    return;
  }
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
  renderVol(t);
}
function renderVol(t) {
  const vb = $('volBox');
  vb.innerHTML = '';
  vb.append(slider({
    label: '트랙 볼륨', min: -24, max: 12, step: 0.1, unit: 'dB',
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
  const c2 = { id: newClipId(), sid: c.sid, start: p, src: c.src + left, len: c.len - left, fi: 0, fo: c.fo };
  c.len = left; c.fo = 0;
  if (c.fi > c.len) c.fi = c.len;
  if (c2.fo > c2.len) c2.fo = c2.len;
  t.clips.push(c2);
  engine.updateSegs(t);
  sel = { t, c: c2 };
  afterChange();
};
function delSel() {
  const { t, c } = sel;
  t.clips = t.clips.filter((x) => x !== c);
  sel = null;
  engine.updateSegs(t);
  afterChange();
}
const copySel = () => { const c = sel.c; clipBoard = { sid: c.sid, src: c.src, len: c.len, fi: c.fi, fo: c.fo }; };
$('aDel').onclick = () => { if (!sel) return; pushUndo(); delSel(); };
$('aCopy').onclick = () => { if (!sel) return; copySel(); renderPanel(); flash('복사했습니다 · 트랙을 고르고 재생 위치에 붙여넣으세요'); };
$('aCutX').onclick = () => { if (!sel) return; copySel(); pushUndo(); delSel(); flash('잘라냈습니다 · 트랙을 고르고 재생 위치에 붙여넣으세요'); };
$('aPaste').onclick = () => {
  if (!clipBoard || !curT) return;
  if (!engine.sources.has(clipBoard.sid)) { flash('복사한 음원이 더는 없습니다'); clipBoard = null; renderPanel(); return; }
  pushUndo();
  const c = { id: newClipId(), ...clipBoard, start: engine.position };
  curT.clips.push(c);
  engine.updateSegs(curT);
  sel = { t: curT, c };
  afterChange();
};
$('addTrack').onclick = async () => {
  if (loading) return;
  await cleared;
  await engine.init();
  let n = 1;
  while (engine.tracks.some((x) => x.name === `새 트랙 ${n}`)) n++;
  const t = engine.addEmptyTrack(`새 트랙 ${n}`);
  renderTrack(t);
  curT = t; sel = null;
  afterChange();
  t.row.scrollIntoView({ block: 'nearest' });
  refreshTabs();
};
$('aDelTrack').onclick = async () => {
  const t = curT;
  if (!t || loading || busy) return;
  if (!confirm(`"${t.name}" 트랙을 지울까요? 되돌릴 수 없습니다.`)) return;
  const wasRef = t.mix.ref;
  engine.stop(); updatePlayBtn();
  await engine.removeTrack(t, true);
  t.row.remove();
  engine.exp?.off.delete(t.id);
  if (sel && sel.t === t) sel = null;
  curT = null;
  if (wasRef && engine.mode === 'ref') engine.mode = 'apply';
  if (!engine.tracks.length) tracksEl.innerHTML = '<div class="empty stick">MP3, WAV 또는 압축 파일(zip)을 불러오세요</div>';
  mix.select(null);
  engine.applyAll();
  afterChange(); renderCompare(); paintRelink(); refreshTabs();
  flash(`"${t.name}" 트랙을 지웠습니다`);
};
$('aFade').onclick = () => { fadeOpen = !fadeOpen; renderPanel(); layout(); };
$('aMove').onclick = () => {
  moveMode = !moveMode;
  for (const t of engine.tracks) t.lane && t.lane.classList.toggle('moving', moveMode);
  renderPanel();
};
$('xfade').onclick = () => {
  if (!curT) return;
  pushUndo();
  curT.xfade = !curT.xfade;
  engine.updateSegs(curT);
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
$('home').onclick = async () => { await engine.seek(engine.prev ? engine.prev.a : engine.loop.on ? engine.loop.start : 0); redraw(); };
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

// ---------- 믹싱 탭 ----------
const mix = initMix({
  engine, pushUndo, flash, sub,
  setBusy: (b) => { busy = b; if (!b) showStats(); },
  undo: () => $('undo').click(), redo: () => $('redo').click(),
  onChange: (what) => { if (what === 'stop') updatePlayBtn(); renderCompare(); for (const t of engine.tracks) updateHead(t); orderRows(); redraw(); },
});

// ---------- 내보내기 탭 ----------
const exp = initExport({ engine, flash, sub, setBusy: (b) => { busy = b; if (!b) showStats(); }, onStop: updatePlayBtn });

// ---------- 프로젝트 ----------
async function clearAllUI() {
  await cleared;
  await engine.init();
  await engine.clearAll();
  tracksEl.innerHTML = '<div class="empty stick">MP3, WAV 또는 압축 파일(zip)을 불러오세요</div>';
  sel = null; curT = null; clipBoard = null; undoStack = []; redoStack = []; updateUndoBtns();
  mix.select(null);
  updatePlayBtn(); renderPanel(); renderCompare(); paintRelink(); layout(); refreshTabs();
  sub('음원을 불러오세요');
}
const proj = initProjects({
  engine, flash,
  clearAll: clearAllUI,
  isBusy: () => busy || loading,
  opened: () => {
    for (const t of engine.tracks) { if (!t.color) t.color = colorFor(t.name); renderTrack(t); }
    orderRows(); fitZoom(); afterChange(); paintRelink(); renderCompare(); refreshTabs();
    flash(`"${engine.projectName}" 열었습니다 · 음원을 연결하세요`);
  },
});
$('proj').onclick = () => proj.open();

// ---------- 아래 재생바와 비교 전환 ----------
let seekDrag = false;
function paintSeek(f) {
  const p = clamp(f, 0, 1) * 100;
  $('seekFill').style.width = p + '%';
  $('seekKnob').style.left = p + '%';
}
{
  const bar = $('seek');
  const at = (e) => { const r = bar.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
  bar.addEventListener('pointerdown', (e) => {
    if (!engine.tracks.length) return;
    seekDrag = true; bar.setPointerCapture(e.pointerId);
    const f = at(e); paintSeek(f); $('tCur').textContent = fmt(f * engine.duration, true);
  });
  bar.addEventListener('pointermove', (e) => {
    if (!seekDrag) return;
    const f = at(e); paintSeek(f); $('tCur').textContent = fmt(f * engine.duration, true);
  });
  const end = async (e, cancel) => {
    if (!seekDrag) return;
    const f = at(e);
    if (!cancel) await engine.seek(Math.round(f * engine.duration));
    seekDrag = false;
    redraw();
  };
  bar.addEventListener('pointerup', (e) => end(e, false));
  bar.addEventListener('pointercancel', (e) => end(e, true));
}

function renderCompare() {
  const box = $('compare');
  box.innerHTML = '';
  if (!engine.tracks.length) return;
  const opts = [['raw', '원본'], ['apply', '적용']];
  if (engine.hasRef) opts.push(['ref', '원곡']);
  box.appendChild(segmented(opts, engine.mode, (m) => {
    engine.setMode(m);
    if (m !== 'apply' && engine.ana.procLufs == null) flash('마스터 자동 분석 전이라 비교 음량이 맞춰지지 않았습니다');
  }));
}

// ---------- 탭 ----------
// 불러오는 동안에는 믹싱·내보내기 탭이 아무 작업도 시작하지 않게 안내만 보인다
function refreshTabs() {
  const on = document.querySelector('nav button.on')?.dataset.tab;
  if (on === 'mix') mix.render();
  if (on === 'export') exp.render();
}
for (const b of document.querySelectorAll('nav button')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('nav button')) x.classList.toggle('on', x === b);
    for (const s of document.querySelectorAll('.tab')) s.classList.toggle('show', s.id === 'tab-' + b.dataset.tab);
    if (b.dataset.tab === 'mix') { if (sel) mix.select(sel.t); mix.render(); }
    if (b.dataset.tab === 'export') exp.render();
    exp.setActive(b.dataset.tab === 'export');
    layout();
  };
}

// ---------- 상태 ----------
function showStats() {
  if (!engine.tracks.length || loading || busy || flash.t && Date.now() - (flash.at || 0) < 2500) return;
  const under = engine.tracks.reduce((s, t) => s + t.under, 0);
  sub(`${engine.tracks.length}트랙 · 끊김 ${under}회`);
}
setInterval(showStats, 2000);

(function loop() {
  if (engine.ctx) {
    const pos = engine.position;
    const dur = engine.duration;
    if (!seekDrag) { $('tCur').textContent = fmt(pos, true); paintSeek(dur ? pos / dur : 0); }
    $('tDur').textContent = fmt(dur);
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
    exp.tick();
  }
  requestAnimationFrame(loop);
})();
