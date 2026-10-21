import { Engine, SR, PEAK } from './engine.js';
import { listZip, readEntry } from './zip.js';

const engine = new Engine();
const $ = (id) => document.getElementById(id);
const tracksEl = $('tracks');
let dragging = false;
let loading = false;

engine.clearStore();

const fmt = (frames) => {
  const s = Math.floor(frames / SR);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
const isAudio = (n) => /\.(mp3|wav)$/i.test(n) && !/(^|\/)(__MACOSX\/|\._)/.test(n);
const baseName = (n) => n.split('/').pop().replace(/\.(mp3|wav)$/i, '');

function status(text) { $('status').textContent = text; }

$('load').onclick = () => $('file').click();

$('file').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  await engine.init();
  engine.stop();
  updatePlayBtn();

  // 불러올 목록 만들기 (압축 파일은 안의 음원만)
  const jobs = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      try {
        const entries = await listZip(f);
        for (const en of entries) if (isAudio(en.name)) jobs.push({ name: baseName(en.name), get: () => readEntry(f, en) });
      } catch (err) { status(f.name + ': ' + err.message); return; }
    } else if (isAudio(f.name)) {
      jobs.push({ name: baseName(f.name), get: () => f.arrayBuffer() });
    }
  }
  if (!jobs.length) { status('불러올 MP3·WAV가 없습니다'); return; }
  jobs.sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));

  loading = true;
  for (let i = 0; i < jobs.length; i++) {
    status(`불러오는 중 ${i + 1}/${jobs.length}: ${jobs[i].name}`);
    try {
      const t = await engine.addTrack(jobs[i].name, await jobs[i].get());
      renderTrack(t);
    } catch (err) {
      status(`${jobs[i].name}: 읽지 못했습니다 (${err.message})`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  loading = false;
  $('seek').max = engine.duration;
  updateTime();
  showStats();
};

function renderTrack(t) {
  if (engine.tracks.length === 1) tracksEl.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'track';
  el.innerHTML = `
    <div class="head">
      <div class="name"></div>
      <button class="mute" aria-label="음소거"><i class="ic ic-volume"></i></button>
      <input type="range" min="0" max="1.5" step="0.01" value="1" aria-label="볼륨">
    </div>
    <div class="wavebox"><canvas class="wave"></canvas><div class="ph"></div></div>`;
  el.querySelector('.name').textContent = t.name;
  const btn = el.querySelector('.mute');
  btn.onclick = () => {
    engine.setMute(t, !t.muted);
    el.classList.toggle('muted', t.muted);
    btn.classList.toggle('on', t.muted);
    btn.innerHTML = `<i class="ic ${t.muted ? 'ic-volume-off' : 'ic-volume'}"></i>`;
  };
  el.querySelector('input').oninput = (e) => engine.setVolume(t, +e.target.value);
  tracksEl.appendChild(el);
  t.el = el;
  t.ph = el.querySelector('.ph');
  drawWave(t);
}

function drawWave(t) {
  const c = t.el.querySelector('canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.round(44 * dpr);
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--wave');
  const total = engine.duration || t.frames;
  const perPx = total / PEAK / w;
  for (let x = 0; x < w; x++) {
    const a = Math.floor(x * perPx), b = Math.floor((x + 1) * perPx);
    let m = 0;
    for (let k = a; k <= b && k < t.peaks.length; k++) if (t.peaks[k] > m) m = t.peaks[k];
    const y = m * h * 0.5;
    g.fillRect(x, h / 2 - y, 1, Math.max(1, y * 2));
  }
}

// 가장 긴 트랙 기준으로 파형 가로 비율을 맞추기 위해 크기 바뀌면 다시 그림
let lastDur = 0;
function redrawAllIfNeeded() {
  if (engine.duration !== lastDur) { lastDur = engine.duration; engine.tracks.forEach(drawWave); }
}
window.addEventListener('resize', () => engine.tracks.forEach(drawWave));

function updatePlayBtn() {
  $('play').innerHTML = `<i class="ic ${engine.playing ? 'ic-player-pause' : 'ic-player-play'}"></i>`;
}

function updateTime() {
  const pos = engine.position, dur = engine.duration;
  $('time').innerHTML = `<b>${fmt(pos)}</b> / ${fmt(dur)}`;
  if (!dragging) $('seek').value = pos;
  const pct = dur ? (pos / dur) * 100 : 0;
  for (const t of engine.tracks) if (t.ph) t.ph.style.left = pct + '%';
}

$('play').onclick = async () => {
  if (!engine.tracks.length) return;
  if (engine.playing) engine.stop(); else await engine.play();
  updatePlayBtn();
};
$('home').onclick = () => engine.seek(0).then(updateTime);
engine.onEnd = () => { updatePlayBtn(); updateTime(); };

$('seek').oninput = () => {
  dragging = true;
  $('time').innerHTML = `<b>${fmt(+$('seek').value)}</b> / ${fmt(engine.duration)}`;
};
$('seek').onchange = async () => {
  dragging = false;
  await engine.seek(+$('seek').value);
  updateTime();
};

async function showStats() {
  if (!engine.tracks.length || loading) return;
  const mb = (await engine.storedBytes()) / 1048576;
  const under = engine.tracks.reduce((s, t) => s + t.under, 0);
  status(`트랙 ${engine.tracks.length}개 · 저장공간 ${mb.toFixed(0)}MB · 끊김 ${under}회`);
}

(function loop() {
  if (engine.ctx) { updateTime(); redrawAllIfNeeded(); }
  requestAnimationFrame(loop);
})();
setInterval(showStats, 2000);
