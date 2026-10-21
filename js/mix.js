// 믹싱 탭: 트랙 믹싱 / 전체 마스터
import { slider, toggle, section, segmented } from './ui.js';
import { Biquad } from './dsp.js';
import { EQF } from './mixgraph.js';
import { measureTracks, suggestTrack, autoMaster, fitVolumes, applySpread } from './analysis.js';

const SR = 44100;
const $ = (id) => document.getElementById(id);
const sgn = (v, d = 1) => (v > 0 ? '+' : '') + v.toFixed(d);
const pct = (v) => Math.round(v * 100) + '';

export function initMix({ engine: E, pushUndo, flash, sub, onChange, setBusy, undo, redo }) {
  const top = $('mixTop'), body = $('mixBody');
  let view = 'track';      // track | master
  let cur = null;          // 선택한 트랙
  let busy = false;
  let meterEls = null;

  const changed = () => { E.applyAll(); onChange && onChange(); };

  // ---------- EQ 곡선 ----------
  function magDb(bq, f) {
    const w = 2 * Math.PI * f / SR;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = bq.b0 + bq.b1 * c1 + bq.b2 * c2, ni = -(bq.b1 * s1 + bq.b2 * s2);
    const dr = 1 + bq.a1 * c1 + bq.a2 * c2, di = -(bq.a1 * s1 + bq.a2 * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  function drawCurve(cv, low, eq) {
    const d = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w) return;
    cv.width = Math.round(w * d); cv.height = Math.round(h * d);
    const g = cv.getContext('2d');
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, w, h);
    const fx = (f) => Math.log(f / 20) / Math.log(1000) * w;
    const y = (db) => h / 2 - db / 12 * (h / 2 - 4);
    g.strokeStyle = '#2c3038'; g.lineWidth = 1; g.fillStyle = '#8a8f99'; g.font = '10px system-ui, sans-serif';
    for (const f of [100, 1000, 10000]) { const x = Math.round(fx(f)) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); g.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 3, h - 4); }
    for (const db of [-6, 0, 6]) { const yy = Math.round(y(db)) + 0.5; g.beginPath(); g.moveTo(0, yy); g.lineTo(w, yy); g.stroke(); }
    const bqs = [];
    if (low && low.on) bqs.push(new Biquad().set('highpass', low.hz, 0.707, 0, SR));
    if (eq.on) {
      bqs.push(new Biquad().set('lowshelf', EQF.low, 0.7, eq.low, SR));
      bqs.push(new Biquad().set('peaking', EQF.mid, 0.8, eq.mid, SR));
      bqs.push(new Biquad().set('highshelf', EQF.high, 0.7, eq.high, SR));
    }
    g.strokeStyle = '#e9a23b'; g.lineWidth = 2; g.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const f = 20 * Math.pow(1000, x / w);
      let db = 0;
      for (const b of bqs) db += magDb(b, f);
      const yy = y(Math.max(-12, Math.min(12, db)));
      x ? g.lineTo(x, yy) : g.moveTo(x, yy);
    }
    g.stroke();
  }
  function eqSection(key, low, eq) {
    const cv = document.createElement('canvas');
    cv.className = 'curve';
    const paintCurve = () => requestAnimationFrame(() => drawCurve(cv, low, eq));
    eqSection.paint = paintCurve;
    new ResizeObserver(paintCurve).observe(cv);   // 접혀 있다 펼쳐질 때 다시 그림
    return section(key, '톤 EQ', { get: () => eq.on, set: (v) => { eq.on = v; changed(); paintCurve(); } }, (b) => {
      b.appendChild(cv);
      for (const [k, label] of [['low', '저음'], ['mid', '중음'], ['high', '고음']]) {
        b.appendChild(slider({ label, min: -6, max: 6, step: 0.5, unit: 'dB', get: () => eq[k], show: (v) => sgn(v), set: (v) => { eq[k] = v; changed(); paintCurve(); } }));
      }
      paintCurve();
    });
  }

  // ---------- 상단 ----------
  function renderTop() {
    top.innerHTML = '';
    const u = document.createElement('button'), r = document.createElement('button');
    u.className = 'undo-btn'; u.setAttribute('aria-label', '되돌리기'); u.innerHTML = '<i class="ic ic-arrow-back-up"></i>'; u.onclick = undo;
    r.className = 'redo-btn'; r.setAttribute('aria-label', '다시 하기'); r.innerHTML = '<i class="ic ic-arrow-forward-up"></i>'; r.onclick = redo;
    u.disabled = document.getElementById('undo').disabled; r.disabled = document.getElementById('redo').disabled;
    top.append(u, r, segmented([['track', '트랙 믹싱'], ['master', '전체 마스터']], view, (v) => { view = v; render(); }));
  }

  function autoRow() {
    const row = document.createElement('div');
    row.className = 'autorow';
    const a = document.createElement('button');
    a.className = 'auto';
    a.innerHTML = `<i class="ic ic-wave-sine"></i>자동 분석`;
    a.disabled = busy || !E.tracks.length;
    a.onclick = () => (view === 'master' ? runMaster() : runTracks([cur]));
    row.appendChild(a);
    if (view === 'track') {
      const all = document.createElement('button');
      all.textContent = '모든 트랙';
      all.disabled = busy || !E.tracks.length;
      all.onclick = () => runTracks(E.tracks.filter((t) => !t.mix.ref));
      row.appendChild(all);
    }
    const sp = document.createElement('div');
    sp.className = 'spread';
    const sl = document.createElement('span'); sl.textContent = '넓이';
    sp.append(sl, segmented([['orig', '원곡 정도'], ['some', '조금 넓게'], ['wide', '넓게']], E.mm.spread, (v) => {
      pushUndo();
      E.mm.spread = v;
      applySpread(E);
      changed(); render();
      flash(E.tracks.some((t) => t.ana) ? '패닝·폭을 다시 배치했습니다' : '자동 분석 때 이 넓이로 배치합니다');
    }));
    if (view === 'track' && E.hasRef) {
      const fb = document.createElement('button');
      fb.textContent = '원곡 밸런스';
      fb.disabled = busy;
      fb.onclick = runFit;
      row.appendChild(fb);
    }
    row._spread = sp;
    return row;
  }

  async function measure(label) {
    sub(`${label}: 트랙 측정 0%`);
    await measureTracks(E, (p) => sub(`${label}: 트랙 측정 ${Math.round(p * 100)}%`));
  }

  async function runTracks(list) {
    if (busy) return;
    busy = true; setBusy(true); render();
    try {
      E.stop(); onChange && onChange('stop');
      await measure('자동 분석');
      pushUndo();
      for (const t of list) suggestTrack(E, t);
      applySpread(E, list);
      E.ana.procLufs = null;     // 트랙이 바뀌면 마스터 음량 맞춤은 다시 해야 함
      changed();
      flash(list.length > 1 ? '모든 트랙에 자동 설정을 넣었습니다' : `${cur.name}에 자동 설정을 넣었습니다`);
    } catch (e) { flash('분석하지 못했습니다: ' + e.message); }
    busy = false; setBusy(false); render();
  }

  // 트랙과 마스터를 한 번에 자동으로 (올릴 때, 원곡 지정할 때)
  async function runAuto(list, why) {
    if (busy || !list.length) return;
    busy = true; setBusy(true); render();
    try {
      E.stop(); onChange && onChange('stop');
      await measure(why);
      pushUndo();
      for (const t of list) suggestTrack(E, t);
      applySpread(E, list);
      await autoMaster(E, (p) => sub(`${why}: 마스터 계산 ${Math.round(p * 100)}%`));
      changed();
      flash(E.hasRef ? '원곡 기준으로 믹싱·마스터를 잡았습니다' : '믹싱·마스터를 자동으로 잡았습니다');
    } catch (e) { flash('자동 설정을 하지 못했습니다: ' + e.message); }
    busy = false; setBusy(false); render();
  }

  async function runFit() {
    if (busy) return;
    busy = true; setBusy(true); render();
    try {
      E.stop(); onChange && onChange('stop');
      await measure('원곡 밸런스');
      if (!E.ana.hasFit) throw new Error('원곡과 비교할 스템이 없습니다');
      pushUndo();
      const quiet = fitVolumes(E);
      E.ana.procLufs = null;
      changed();
      flash(quiet && quiet.length ? `원곡 기준으로 맞췄습니다. 원곡에서 거의 안 들리는 트랙: ${quiet.join(', ')}` : '원곡 기준으로 트랙 볼륨을 맞췄습니다');
    } catch (e) { flash('맞추지 못했습니다: ' + e.message); }
    busy = false; setBusy(false); render();
  }

  async function runMaster() {
    if (busy) return;
    busy = true; setBusy(true); render();
    try {
      E.stop(); onChange && onChange('stop');
      await measure('마스터 분석');
      pushUndo();
      await autoMaster(E, (p) => sub(`마스터 분석: 처리 계산 ${Math.round(p * 100)}%`));
      changed();
      flash(`목표 ${E.mm.lim.target} LUFS에 맞췄습니다`);
    } catch (e) { flash('분석하지 못했습니다: ' + e.message); }
    busy = false; setBusy(false); render();
  }

  // ---------- 트랙 믹싱 ----------
  function renderTrack() {
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const t of E.tracks) {
      const c = document.createElement('button');
      c.className = 'chip' + (t === cur ? ' on' : '');
      c.innerHTML = `<span class="dot"></span><span></span>`;
      c.firstChild.style.background = t.color;
      c.lastChild.textContent = t.name + (t.mix.ref ? ' (원곡)' : '');
      c.onclick = () => { cur = t; render(); };
      chips.appendChild(c);
    }
    body.appendChild(chips);
    { const r = autoRow(); body.append(r, r._spread); }
    const t = cur, m = t.mix;
    body.appendChild(section('t-basic', '기본', null, (b) => {
      b.appendChild(slider({ label: '볼륨', min: -24, max: 12, step: 0.5, unit: 'dB', get: () => t.volumeDb, show: (v) => sgn(v), set: (v) => { t.volumeDb = v; changed(); } }));
      b.appendChild(slider({ label: '패닝', min: -1, max: 1, step: 0.05, get: () => m.pan, show: (v) => (Math.abs(v) < 0.01 ? '가운데' : (v < 0 ? '왼 ' : '오 ') + pct(Math.abs(v))), set: (v) => { m.pan = v; changed(); } }));
      b.appendChild(slider({ label: '리버브', min: 0, max: 1, step: 0.01, unit: '%', get: () => m.send, show: pct, set: (v) => { m.send = v; changed(); } }));
      b.appendChild(slider({ label: '스테레오 폭', min: 0, max: 1, step: 0.05, unit: '%', get: () => m.width ?? 1, show: pct, set: (v) => { m.width = v; changed(); } }));
      const fr = document.createElement('div');
      fr.className = 'row';
      fr.innerHTML = `<span class="grow">좌우 뒤집힘 바로잡기<small>${t.ana && t.ana.corr != null ? '좌우 상관 ' + t.ana.corr.toFixed(2) + (t.ana.corr < -0.3 ? ' · 뒤집혀 있음' : '') : '자동 분석 때 확인합니다'}</small></span>`;
      fr.appendChild(toggle(!!m.flip, (v) => { m.flip = v; changed(); }, '좌우 뒤집힘 바로잡기'));
      b.appendChild(fr);
      const r = document.createElement('div');
      r.className = 'row';
      r.innerHTML = `<span class="grow">원곡(기준)으로 쓰기<small>믹스에서 빼고 비교용으로만 들립니다</small></span>`;
      r.appendChild(toggle(m.ref, (v) => {
        if (v) {
          for (const x of E.tracks) x.mix.ref = false;
          E.tracks.splice(E.tracks.indexOf(t), 1);   // 원곡은 트랙 목록 맨 위로
          E.tracks.unshift(t);
        }
        m.ref = v; E.ana.refLufs = null; E.ana.procLufs = null;
        if (!E.hasRef && E.mode === 'ref') E.mode = 'apply';
        changed(); render();
        if (v) runAuto(E.tracks.filter((x) => !x.mix.ref), '원곡 기준 자동 설정');   // 원곡을 지정하면 원곡 기준으로 다시 잡는다
      }, '원곡으로 쓰기'));
      b.appendChild(r);
    }));
    if (m.ref) return;
    body.appendChild(section('t-low', '저역 정리', { get: () => m.low.on, set: (v) => { m.low.on = v; changed(); eqSection.paint && eqSection.paint(); } }, (b) => {
      b.appendChild(slider({ label: '로우컷', min: 20, max: 300, step: 5, unit: 'Hz', get: () => m.low.hz, show: (v) => v.toFixed(0), set: (v) => { m.low.hz = v; changed(); eqSection.paint && eqSection.paint(); } }));
    }));
    body.appendChild(eqSection('t-eq', m.low, m.eq));
    body.appendChild(section('t-tamer', '거칠음 억제', { get: () => m.tamer.on, set: (v) => { m.tamer.on = v; changed(); } }, (b) => {
      b.appendChild(slider({ label: '2~7kHz', min: 0, max: 1, step: 0.05, unit: '%', get: () => m.tamer.mid, show: pct, set: (v) => { m.tamer.mid = v; changed(); } }));
      b.appendChild(slider({ label: '12kHz 이상', min: 0, max: 1, step: 0.05, unit: '%', get: () => m.tamer.air, show: pct, set: (v) => { m.tamer.air = v; changed(); } }));
      b.appendChild(note('튈 때만 누르고 평소엔 그대로 둡니다'));
    }));
    body.appendChild(section('t-comp', '컴프레서·어택', { get: () => m.comp.on, set: (v) => { m.comp.on = v; changed(); } }, (b) => {
      b.appendChild(slider({ label: '압축', min: 0, max: 1, step: 0.05, unit: '%', get: () => m.comp.amt, show: pct, set: (v) => { m.comp.amt = v; changed(); } }));
      b.appendChild(slider({ label: '어택', min: -1, max: 1, step: 0.05, get: () => m.comp.trans, show: (v) => (Math.abs(v) < 0.01 ? '그대로' : (v < 0 ? '부드럽게 ' : '살리기 ') + pct(Math.abs(v))), set: (v) => { m.comp.trans = v; changed(); } }));
    }));
    body.appendChild(section('t-duck', '베이스 덕킹', { get: () => m.duck.on, set: (v) => { m.duck.on = v; changed(); } }, (b) => {
      b.appendChild(slider({ label: '세기', min: 0, max: 8, step: 0.5, unit: 'dB', get: () => m.duck.depth, show: (v) => v.toFixed(1), set: (v) => { m.duck.depth = v; changed(); } }));
      b.appendChild(note(E.tracks.some((x) => x.cat === 'drums') ? '드럼이 칠 때 이 트랙을 그만큼 살짝 누릅니다' : '이름에 drum(드럼)이 들어간 트랙이 있어야 동작합니다'));
    }));
    body.appendChild(section('t-lim', '트랙 리미터', { get: () => m.lim.on, set: (v) => { m.lim.on = v; changed(); } }, (b) => {
      b.appendChild(slider({ label: '최대 피크', min: -12, max: 0, step: 0.5, unit: 'dB', get: () => m.lim.ceil, show: (v) => v.toFixed(1), set: (v) => { m.lim.ceil = v; changed(); } }));
    }));
  }

  function note(text) {
    const n = document.createElement('div');
    n.className = 'note';
    n.textContent = text;
    return n;
  }

  // ---------- 전체 마스터 ----------
  function renderMaster() {
    const mm = E.mm;
    { const r = autoRow(); body.append(r, r._spread); }
    const card = document.createElement('div');
    card.className = 'meter';
    card.innerHTML = `
      <div class="mv"><span>목표 음량</span><b id="mTarget"></b></div>
      <div class="mv"><span>측정 음량</span><b id="mInt">-</b></div>
      <div class="mv"><span>최대 피크</span><b id="mTp">-</b></div>
      <canvas id="mBars"></canvas>`;
    body.appendChild(card);
    meterEls = { target: card.querySelector('#mTarget'), int: card.querySelector('#mInt'), tp: card.querySelector('#mTp'), bars: card.querySelector('#mBars'), l: -90, r: -90 };
    meterEls.target.textContent = `${mm.lim.target} LUFS`;
    body.appendChild(eqSection('m-eq', mm.low, mm.eq));
    body.appendChild(section('m-space', '공간·스테레오', { get: () => mm.space.on, set: (v) => { mm.space.on = v; changed(); } }, (b) => {
      b.appendChild(slider({ label: '스테레오 폭', min: 0, max: 1.5, step: 0.05, unit: '%', get: () => mm.space.width, show: pct, set: (v) => { mm.space.width = v; changed(); } }));
      b.appendChild(slider({ label: '저역 모노', min: 0, max: 200, step: 10, unit: 'Hz', get: () => mm.space.monoHz, show: (v) => (v ? v.toFixed(0) : '끔'), set: (v) => { mm.space.monoHz = v; changed(); } }));
      b.appendChild(note('넓이는 300Hz~3kHz 대역만 넓힙니다. 높은 대역을 넓히면 AI 잡음이 커집니다'));
    }));
    body.appendChild(section('m-low', '저역 정리', { get: () => mm.low.on, set: (v) => { mm.low.on = v; changed(); eqSection.paint && eqSection.paint(); } }, (b) => {
      b.appendChild(slider({ label: '초저역 컷', min: 10, max: 80, step: 1, unit: 'Hz', get: () => mm.low.hz, show: (v) => v.toFixed(0), set: (v) => { mm.low.hz = v; changed(); eqSection.paint && eqSection.paint(); } }));
    }));
    body.appendChild(section('m-tamer', '고역 거칠음 억제', { get: () => mm.tamer.on, set: (v) => { mm.tamer.on = v; changed(); } }, (b) => {
      b.appendChild(slider({ label: '2~7kHz', min: 0, max: 1, step: 0.05, unit: '%', get: () => mm.tamer.mid, show: pct, set: (v) => { mm.tamer.mid = v; changed(); } }));
      b.appendChild(slider({ label: '12kHz 이상', min: 0, max: 1, step: 0.05, unit: '%', get: () => mm.tamer.air, show: pct, set: (v) => { mm.tamer.air = v; changed(); } }));
    }));
    body.appendChild(section('m-glue', '컴프레서', { get: () => mm.glue.on, set: (v) => { mm.glue.on = v; changed(); } }, (b) => {
      b.appendChild(slider({ label: '붙이기', min: 0, max: 1, step: 0.05, unit: '%', get: () => mm.glue.amt, show: pct, set: (v) => { mm.glue.amt = v; changed(); } }));
      b.appendChild(note('트랙들을 한 덩어리로 살짝 붙이는 정도(1~2dB)로 씁니다'));
    }));
    body.appendChild(section('m-lim', '리미터', { get: () => mm.lim.on, set: (v) => { mm.lim.on = v; changed(); } }, (b) => {
      b.appendChild(slider({ label: '목표 음량', min: -20, max: -8, step: 0.5, unit: 'LUFS', get: () => mm.lim.target, show: (v) => v.toFixed(1), set: (v) => { mm.lim.target = v; E.ana.procLufs = null; meterEls.target.textContent = `${v} LUFS`; changed(); } }));
      b.appendChild(slider({ label: '최대 피크', min: -3, max: 0, step: 0.1, unit: 'dBTP', get: () => mm.lim.ceil, show: (v) => v.toFixed(1), set: (v) => { mm.lim.ceil = v; changed(); } }));
      b.appendChild(slider({ label: '입력 음량', min: -20, max: 24, step: 0.1, unit: 'dB', get: () => mm.lim.gainDb, show: (v) => sgn(v), set: (v) => { mm.lim.gainDb = v; changed(); } }));
      b.appendChild(note('목표 음량을 바꾸면 자동 분석을 다시 눌러 입력 음량을 맞추세요'));
    }));
    body.appendChild(section('m-verb', '리버브 (공용)', null, (b) => {
      b.appendChild(slider({ label: '길이', min: 0.5, max: 4, step: 0.1, unit: '초', get: () => mm.verb.size, show: (v) => v.toFixed(1), set: (v) => { mm.verb.size = v; changed(); } }));
      b.appendChild(slider({ label: '전체 양', min: -24, max: 6, step: 0.5, unit: 'dB', get: () => mm.verb.ret, show: (v) => sgn(v), set: (v) => { mm.verb.ret = v; changed(); } }));
      const r = document.createElement('div');
      r.className = 'row';
      r.innerHTML = `<span class="grow">보컬 나올 때 누르기</span>`;
      r.appendChild(toggle(mm.verb.duck.on, (v) => { mm.verb.duck.on = v; changed(); }, '보컬 나올 때 누르기'));
      b.appendChild(r);
      b.appendChild(slider({ label: '누르는 세기', min: 0, max: 8, step: 0.5, unit: 'dB', get: () => mm.verb.duck.depth, show: (v) => v.toFixed(1), set: (v) => { mm.verb.duck.depth = v; changed(); } }));
      b.appendChild(note('트랙별 보내는 양은 트랙 믹싱 > 기본 > 리버브에서 정합니다'));
    }));
  }

  function render() {
    renderTop();
    const y = body.scrollTop;
    body.innerHTML = '';
    meterEls = null;
    eqSection.paint = null;
    if (!E.tracks.length) { body.innerHTML = '<div class="soon">먼저 편집 탭에서 음원을 불러오세요</div>'; return; }
    if (!cur || !E.tracks.includes(cur)) cur = E.tracks[0];
    if (view === 'track') renderTrack(); else renderMaster();
    body.scrollTop = y;
  }

  // 측정값 표시
  function tickMeters() {
    if (meterEls && E.meter && E.playing) {
      const m = E.meter;
      meterEls.int.textContent = isFinite(m.int) ? `${m.int.toFixed(1)} LUFS` : '-';
      meterEls.tp.textContent = isFinite(m.tp) ? `${m.tp.toFixed(1)} dBTP` : '-';
      const toDb = (x) => (x > 1e-6 ? 20 * Math.log10(x) : -90);
      meterEls.l = Math.max(toDb(m.l), meterEls.l - 1.5);
      meterEls.r = Math.max(toDb(m.r), meterEls.r - 1.5);
    } else if (meterEls) { meterEls.l -= 1.5; meterEls.r -= 1.5; }
    if (meterEls) {
      const cv = meterEls.bars, d = window.devicePixelRatio || 1;
      const w = cv.clientWidth, h = cv.clientHeight;
      if (cv.width !== Math.round(w * d)) { cv.width = Math.round(w * d); cv.height = Math.round(h * d); }
      const g = cv.getContext('2d');
      g.setTransform(d, 0, 0, d, 0, 0);
      g.clearRect(0, 0, w, h);
      const x = (db) => Math.max(0, Math.min(1, (db + 60) / 60)) * (w - 14) + 14;
      g.font = '10px system-ui, sans-serif'; g.fillStyle = '#8a8f99';
      [['L', meterEls.l, 2], ['R', meterEls.r, 14]].forEach(([n, v, yy]) => {
        g.fillStyle = '#8a8f99'; g.fillText(n, 0, yy + 8);
        g.fillStyle = '#2c3038'; g.fillRect(14, yy, w - 14, 8);
        g.fillStyle = v > -3 ? '#d0605e' : v > -12 ? '#e9a23b' : '#5fbf8f';
        g.fillRect(14, yy, x(v) - 14, 8);
      });
      g.fillStyle = '#8a8f99';
      for (const db of [-48, -36, -24, -12, -6, 0]) { const xx = x(db); g.fillRect(xx, 24, 1, 3); g.fillText(db, Math.min(xx - 6, w - 12), 36); }
    }
    requestAnimationFrame(tickMeters);
  }
  requestAnimationFrame(tickMeters);

  return { render, select: (t) => { cur = t; }, autoNew: (list) => runAuto(list, '자동 믹싱') };
}
