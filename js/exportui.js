// 내보내기 탭: 출력 범위 → 파일 형식 → 곡 정보, 아래 "파일 만들기" 고정
import { segmented, toggle, slider } from './ui.js';
import { srtText, prepareArt } from './filewrite.js';
import { exportAudio } from './export.js';
import { PEAK } from './engine.js';
import { dbToLin } from './dsp.js';

const $ = (id) => document.getElementById(id);
const mb = (n) => (n / 1048576).toFixed(1) + 'MB';

export function initExport({ engine: E, flash, sub, setBusy, onStop }) {
  const body = $('expBody'), foot = $('expFoot');
  const st = E.exp = { scope: 'mix', fmt: 'wav', bits: 24, off: new Set(), listOpen: false, a: 0, b: null, fi: 0, fo: 0 };
  const SR = 44100;
  const tfmt = (sec) => { const m = Math.floor(sec / 60), r = sec - m * 60; return `${m}:${r.toFixed(1).padStart(4, '0')}`; };
  const meta = E.meta = { title: '', artist: '', lyrics: '', art: null, srt: null, srtName: '', saveSrt: true };
  let busy = false;
  let active = false;          // 내보내기 탭이 열려 있는지 (열려 있으면 재생에 구간·페이드·포함 트랙 반영)
  let wave = null;             // 구간 파형 { cv, env, draw }
  let zv = null;               // 파형 보기 범위 { v0, v1 } (초) — 두 손가락으로 확대·축소

  const live = () => E.tracks.filter((t) => !t.mix.ref);
  const included = () => live().filter((t) => !st.off.has(t.id));

  function card(title) {
    const c = document.createElement('div');
    c.className = 'xcard';
    if (title) { const h = document.createElement('b'); h.className = 'xh'; h.textContent = title; c.appendChild(h); }
    body.appendChild(c);
    return c;
  }

  function render() {
    if (E.loading) { foot.hidden = true; body.innerHTML = '<div class="soon">음원을 불러오는 중입니다. 다 불러온 뒤에 열립니다</div>'; return; }
    const y = body.scrollTop;
    body.innerHTML = '';
    if (!E.tracks.length) { body.innerHTML = '<div class="soon">먼저 편집 탭에서 음원을 불러오세요</div>'; foot.hidden = true; return; }
    foot.hidden = false;

    // 출력 범위
    const c1 = card('출력 범위');
    c1.appendChild(segmented([['mix', '전체 믹스'], ['stems', '트랙별']], st.scope, (v) => { st.scope = v; render(); }));
    const inc = included();
    const pick = document.createElement('button');
    pick.className = 'xrow';
    pick.innerHTML = `<span>포함할 트랙</span><span class="xv">${inc.length} / ${live().length} 선택</span><i class="ic ${st.listOpen ? 'ic-chevron-up' : 'ic-chevron-down'}"></i>`;
    pick.onclick = () => { st.listOpen = !st.listOpen; render(); };
    c1.appendChild(pick);
    if (st.listOpen) {
      for (const t of live()) {
        const r = document.createElement('div');
        r.className = 'row xtrack';
        r.innerHTML = `<span class="dot"></span><span class="grow"></span>`;
        r.firstChild.style.background = t.color;
        r.children[1].textContent = t.name + (t.muted ? ' (음소거 중)' : '');
        r.appendChild(toggle(!st.off.has(t.id), (v) => { if (v) st.off.delete(t.id); else st.off.add(t.id); render(); }, t.name));
        c1.appendChild(r);
      }
    }
    if (E.missingSources.length) note(c1, `연결 안 된 음원 ${E.missingSources.length}개의 조각은 빠집니다.`);
    if (st.scope === 'stems') note(c1, '트랙마다 트랙 믹싱 설정과 그 트랙의 리버브까지 넣고, 마스터는 입력 음량만 적용합니다. 0dB를 넘으면 모든 트랙을 같은 만큼 낮춥니다. 파일들은 zip 하나로 묶습니다.');

    // 구간: 앞뒤 자르기와 전체 페이드
    const dur = E.duration / SR;
    if (st.b == null || st.b > dur) st.b = dur;
    if (st.a > st.b - 1) st.a = Math.max(0, st.b - 1);
    const cR = card('구간');
    const sum = document.createElement('div');
    sum.className = 'xv';
    const paintSum = () => { sum.textContent = `${tfmt(st.a)} ~ ${tfmt(st.b)} (길이 ${tfmt(st.b - st.a)})`; };
    paintSum();
    cR.appendChild(sum);
    cR.appendChild(waveBox(dur, paintSum));
    const timeSlider = (label, key, lo) => slider({ label, min: 0, max: dur.toFixed(1), step: 0.1, noUndo: true, get: () => st[key], show: tfmt, edit: (v) => v.toFixed(1),
      set: (v) => { st[key] = key === 'a' ? Math.min(v, st.b - 1) : Math.max(v, st.a + 1); paintSum(); wave?.draw(); syncPrev(); } });
    cR.append(timeSlider('시작', 'a'), timeSlider('끝', 'b'));
    const btns = document.createElement('div');
    btns.className = 'xbtns';
    const mk = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { fn(); render(); }; btns.appendChild(b); };
    mk('재생 위치를 시작으로', () => { st.a = Math.min(E.position / SR, st.b - 1); });
    mk('재생 위치를 끝으로', () => { st.b = Math.max(E.position / SR, st.a + 1); });
    mk('처음~끝 전체', () => { st.a = 0; st.b = dur; });
    cR.appendChild(btns);
    cR.append(
      slider({ label: '페이드 인', min: 0, max: 10, step: 0.1, unit: '초', noUndo: true, get: () => st.fi, show: (v) => v.toFixed(1), set: (v) => { st.fi = v; wave?.draw(); syncPrev(); } }),
      slider({ label: '페이드 아웃', min: 0, max: 20, step: 0.1, unit: '초', noUndo: true, get: () => st.fo, show: (v) => v.toFixed(1), set: (v) => { st.fo = v; wave?.draw(); syncPrev(); } }),
    );

    // 파일 형식
    const c2 = card('파일 형식');
    c2.appendChild(segmented([['wav', 'WAV'], ['mp3', 'MP3']], st.fmt, (v) => { st.fmt = v; render(); }));
    if (st.fmt === 'wav') {
      const r = document.createElement('div'); r.className = 'xsub';
      r.appendChild(segmented([[16, '16비트'], [24, '24비트']], st.bits, (v) => { st.bits = v; paintFoot(); }));
      const sr = document.createElement('span'); sr.className = 'xv'; sr.textContent = '44.1 kHz';
      r.appendChild(sr);
      c2.appendChild(r);
    } else note(c2, '320 kbps · 44.1 kHz');

    // 곡 정보
    const c3 = card('곡 정보');
    const top = document.createElement('div');
    top.className = 'xinfo';
    const art = document.createElement('button');
    art.className = 'xart';
    art.innerHTML = meta.art ? `<img alt="">` : `<span class="plus">+</span><span>앨범아트</span>`;
    if (meta.art) art.querySelector('img').src = meta.art.url;
    art.onclick = () => $('artFile').click();
    const fields = document.createElement('div');
    fields.className = 'xfields';
    fields.append(field('곡 제목', 'title', '제목 입력'), field('아티스트', 'artist', '아티스트 입력'));
    top.append(art, fields);
    c3.appendChild(top);
    if (meta.art) {
      const rm = document.createElement('button'); rm.className = 'xlink'; rm.textContent = '앨범아트 빼기';
      rm.onclick = () => { meta.art = null; render(); };
      c3.appendChild(rm);
    }
    const lh = document.createElement('div'); lh.className = 'xlabel'; lh.textContent = '가사';
    const ta = document.createElement('textarea');
    ta.maxLength = 5000; ta.placeholder = '가사를 입력하세요 (MP3에 들어갑니다)'; ta.value = meta.lyrics;
    const cnt = document.createElement('div'); cnt.className = 'xcount'; cnt.textContent = `${meta.lyrics.length} / 5000`;
    ta.oninput = () => { meta.lyrics = ta.value; cnt.textContent = `${ta.value.length} / 5000`; };
    c3.append(lh, ta, cnt);
    const sr = document.createElement('div');
    sr.className = 'row';
    sr.innerHTML = `<span class="grow">SRT<small></small></span>`;
    sr.querySelector('small').textContent = meta.srt ? meta.srtName : '불러오면 가사가 비어 있을 때 글만 뽑아 채웁니다';
    const sb = document.createElement('button');
    sb.textContent = meta.srt ? '빼기' : 'SRT 불러오기';
    sb.onclick = () => { if (meta.srt) { meta.srt = null; meta.srtName = ''; render(); } else $('srtFile').click(); };
    sr.appendChild(sb);
    c3.appendChild(sr);
    if (meta.srt) {
      const r = document.createElement('div');
      r.className = 'row';
      r.innerHTML = `<span class="grow">SRT 함께 저장<small>음원과 같은 이름의 .srt 파일로 저장합니다</small></span>`;
      r.appendChild(toggle(meta.saveSrt, (v) => { meta.saveSrt = v; }, 'SRT 함께 저장'));
      c3.appendChild(r);
    }
    if (st.fmt === 'wav') note(c3, 'WAV에는 제목과 아티스트만 들어갑니다. 앨범아트와 가사는 MP3에 들어갑니다.');
    if (E.tracks.some((t) => t.mix.ref)) note(c3, '원곡(기준) 트랙은 파일에 들어가지 않습니다.');

    paintFoot();
    body.scrollTop = y;
    syncPrev();
  }

  // 미리듣기: 탭이 열려 있으면 파일과 같게 (구간·전체 페이드·포함 트랙) 재생. 연달아 바뀌면 잠깐 모았다가 한 번에
  let prevT = 0;
  function syncPrev() {
    clearTimeout(prevT);
    prevT = setTimeout(() => {
      const on = active && E.tracks.length && !E.loading && st.b != null;
      E.setPreview(on ? { a: Math.round(st.a * SR), b: Math.round(st.b * SR), fi: Math.round(st.fi * SR), fo: Math.round(st.fo * SR), off: new Set(st.off) } : null);
    }, 120);
  }
  function setActive(v) {
    active = v;
    if (!v) wave = null;
    syncPrev();
  }

  // 구간 파형: 포함 트랙을 합친 모양. 아래 손잡이로 시작·끝, 위 동그라미로 페이드 인·아웃, 누르면 그 위치로 이동
  function waveBox(dur, paintSum) {
    const cv = document.createElement('canvas');
    cv.className = 'xwave';
    const H = 96;
    let env = null, W = 0, envKey = '', norm = 0;
    if (!zv || zv.dur !== dur) zv = { v0: 0, v1: dur, dur };
    const d = () => window.devicePixelRatio || 1;
    const span = () => zv.v1 - zv.v0;
    const fx = (sec) => ((sec - zv.v0) / span()) * W;
    const xs = (x) => zv.v0 + (x / W) * span();
    // 보기 범위 [v0, v1)의 칸별 크기
    function envelope(v0, v1, W) {
      const out = new Float32Array(W);
      const fpp = ((v1 - v0) * SR) / W, base = v0 * SR;   // 한 칸이 맡는 프레임
      for (const t of included()) {
        const g = dbToLin(t.volumeDb);
        for (const c of t.clips) {
          const src = E.sources.get(c.sid);
          if (!src || src.missing) continue;
          const pk = src.peaks, sc = src.scale * g;
          const x0 = Math.max(0, Math.floor((c.start - base) / fpp)), x1 = Math.min(W, Math.ceil((c.start + c.len - base) / fpp));
          for (let x = x0; x < x1; x++) {
            const f0 = Math.max(0, base + x * fpp - c.start), f1 = Math.min(c.len, base + (x + 1) * fpp - c.start);
            if (f1 <= f0) continue;
            let m = 0;
            for (let k = Math.floor((c.src + f0) / PEAK), e = Math.floor((c.src + f1) / PEAK); k <= e && k < pk.length; k++) if (pk[k] > m) m = pk[k];
            out[x] += m * sc;
          }
        }
      }
      return out;
    }
    function build() {
      W = cv.clientWidth;
      if (!W) return;
      const key = `${W}|${zv.v0}|${zv.v1}`;
      if (key === envKey && env) return;
      cv.width = Math.round(W * d()); cv.height = Math.round(H * d());
      if (!norm) { for (const v of envelope(0, dur, W)) if (v > norm) norm = v; norm = norm || 1; }   // 곡 전체 기준 크기
      env = envelope(zv.v0, zv.v1, W);
      for (let i = 0; i < W; i++) env[i] = Math.min(1, env[i] / norm);
      envKey = key;
    }
    function gainAt(sec) {
      let v = 1;
      if (sec < st.a || sec > st.b) return 0;
      if (st.fi && sec - st.a < st.fi) v *= Math.sin(Math.PI / 2 * (sec - st.a) / st.fi);
      if (st.fo && st.b - sec < st.fo) v *= Math.sin(Math.PI / 2 * (st.b - sec) / st.fo);
      return v;
    }
    function draw() {
      if (!cv.isConnected) return;
      build();
      if (!env) return;
      const g = cv.getContext('2d');
      g.setTransform(d(), 0, 0, d(), 0, 0);
      g.fillStyle = '#181a1f'; g.fillRect(0, 0, W, H);
      const mid = H / 2, amp = H / 2 - 14;
      const xa = fx(st.a), xb = fx(st.b);
      for (let x = 0; x < W; x++) {
        const y = Math.max(0.5, env[x] * amp);
        const sec = xs(x + 0.5);
        const k = gainAt(sec);
        g.fillStyle = 'rgba(138,143,153,.28)';
        g.fillRect(x, mid - y, 1, y * 2);
        if (k > 0) { g.fillStyle = '#e9a23b'; const yy = Math.max(0.5, y * k); g.fillRect(x, mid - yy, 1, yy * 2); }
      }
      // 페이드 선
      g.strokeStyle = 'rgba(232,233,236,.8)'; g.lineWidth = 1.5;
      const curve = (s0, s1) => {
        g.beginPath();
        for (let i = 0; i <= 40; i++) { const sec = s0 + ((s1 - s0) * i) / 40; const x = fx(sec), y = H - 6 - gainAt(sec) * (H - 18); i ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.stroke();
      };
      if (st.fi > 0) curve(st.a, st.a + st.fi);
      if (st.fo > 0) curve(st.b - st.fo, st.b);
      // 시작·끝 막대와 아래 손잡이
      g.fillStyle = '#e9a23b';
      for (const x of [xa, xb]) { g.fillRect(x - 1, 0, 2, H); g.fillRect(x - 7, H - 18, 14, 18); }
      // 페이드 손잡이 (위)
      g.fillStyle = '#e8e9ec';
      for (const x of [fx(st.a + st.fi), fx(st.b - st.fo)]) { g.beginPath(); g.arc(x, 9, 6, 0, Math.PI * 2); g.fill(); }
      // 재생 위치
      const px = fx(E.position / SR);
      g.fillStyle = '#ffffff'; g.fillRect(px - 1, 0, 2, H);
      // 확대 중이면 맨 아래에 곡 전체 중 어디를 보고 있는지
      if (span() < dur - 0.01) {
        g.fillStyle = 'rgba(232,233,236,.18)'; g.fillRect(0, H - 3, W, 3);
        g.fillStyle = 'rgba(232,233,236,.7)'; g.fillRect((zv.v0 / dur) * W, H - 3, Math.max(4, (span() / dur) * W), 3);
      }
    }
    // 끌기: 손잡이는 옮기고, 빈 곳을 끌면 옆으로 넘기고, 두 손가락이면 확대·축소, 누르기만 하면 그 위치로
    let drag = null, pinch = null;
    const pts = new Map();
    const pt = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const setView = (v0, sp) => {
      sp = Math.max(Math.min(2, dur), Math.min(dur, sp));
      v0 = Math.max(0, Math.min(dur - sp, v0));
      zv = { v0, v1: v0 + sp, dur };
    };
    const pinchInfo = () => { const [a, b] = [...pts.values()]; return { d: Math.max(10, Math.abs(a[0] - b[0])), cx: (a[0] + b[0]) / 2 }; };
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, pt(e));
      if (pts.size === 2) {
        drag = null;
        const p = pinchInfo();
        pinch = { d: p.d, span: span(), sec: xs(p.cx) };
        return;
      }
      if (pts.size > 2 || pinch) return;
      const [x, y] = pt(e);
      const hs = [['a', fx(st.a), H - 9], ['b', fx(st.b), H - 9], ['fi', fx(st.a + st.fi), 9], ['fo', fx(st.b - st.fo), 9]];
      let best = null, bd = 30;
      for (const h of hs) { const dd = Math.hypot(x - h[1], (y - h[2]) * 0.6); if (dd < bd) { bd = dd; best = h[0]; } }
      drag = { key: best, x0: x, v0: zv.v0, moved: false, changed: false };
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, pt(e));
      if (pinch) {
        if (pts.size < 2) return;
        const p = pinchInfo();
        const sp = pinch.span * (pinch.d / p.d);
        const spc = Math.max(Math.min(2, dur), Math.min(dur, sp));
        setView(pinch.sec - (p.cx / W) * spc, spc);
        draw();
        return;
      }
      if (!drag) return;
      const [x] = pt(e);
      if (Math.abs(x - drag.x0) > 4) drag.moved = true;
      if (!drag.moved) return;
      if (!drag.key) { setView(drag.v0 - ((x - drag.x0) / W) * span(), span()); draw(); return; }
      const sec = Math.max(0, Math.min(dur, xs(x)));
      const r1 = (v) => Math.round(v * 10) / 10;
      if (drag.key === 'a') st.a = r1(Math.min(sec, st.b - 1));
      if (drag.key === 'b') st.b = r1(Math.max(sec, st.a + 1));
      if (drag.key === 'fi') st.fi = r1(Math.max(0, Math.min(sec - st.a, 10)));
      if (drag.key === 'fo') st.fo = r1(Math.max(0, Math.min(st.b - sec, 20)));
      const room = st.b - st.a;
      if (st.fi + st.fo > room) { if (drag.key === 'fo') st.fo = r1(room - st.fi); else st.fi = r1(Math.max(0, room - st.fo)); }
      drag.changed = true;
      paintSum(); draw();
    });
    const end = (e, cancel) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pinch) { if (!pts.size) pinch = null; return; }
      if (!drag) return;
      const dd = drag; drag = null;
      if (cancel) return;
      if (dd.key && dd.changed) { render(); return; }
      if (!dd.moved) { const [x] = pt(e); E.seek(Math.round(Math.max(0, Math.min(dur, xs(x))) * SR)); }
    };
    cv.addEventListener('pointerup', (e) => end(e, false));
    cv.addEventListener('pointercancel', (e) => end(e, true));
    wave = { cv, draw };
    requestAnimationFrame(draw);
    return cv;
  }

  function field(label, key, ph) {
    const w = document.createElement('label');
    w.className = 'xfield';
    w.innerHTML = `<span></span><input type="text">`;
    w.firstChild.textContent = label;
    const i = w.querySelector('input');
    i.placeholder = ph; i.value = meta[key];
    i.oninput = () => { meta[key] = i.value; };
    return w;
  }
  function note(parent, text) {
    const n = document.createElement('div'); n.className = 'note'; n.textContent = text; parent.appendChild(n);
  }

  function paintFoot() {
    foot.innerHTML = '';
    const s = document.createElement('span');
    s.className = 'xsum';
    s.textContent = st.fmt === 'wav' ? `WAV · ${st.bits}-bit · 44.1 kHz` : 'MP3 · 320 kbps · 44.1 kHz';
    const b = document.createElement('button');
    b.className = 'xgo';
    b.textContent = busy ? '만드는 중…' : '파일 만들기';
    b.disabled = busy || !included().length;
    b.onclick = run;
    foot.append(s, b);
  }

  async function run() {
    if (busy) return;
    const tracks = included();
    if (!tracks.length) return;
    busy = true; setBusy(true); paintFoot();
    E.stop(); onStop && onStop();
    const label = st.scope === 'mix' ? '전체 믹스' : `트랙 ${tracks.length}개`;
    sub(`${label} 만드는 중 0%`);
    try {
      const r = await exportAudio(E, {
        scope: st.scope, tracks, fmt: st.fmt, bits: st.bits,
        range: { a: Math.round(st.a * SR), b: Math.round(st.b * SR), fi: Math.round(st.fi * SR), fo: Math.round(st.fo * SR) },
        meta: { title: meta.title.trim(), artist: meta.artist.trim(), lyrics: st.fmt === 'mp3' ? meta.lyrics : '', art: st.fmt === 'mp3' ? meta.art : null },
        srt: meta.srt && meta.saveSrt ? meta.srt : null,
      }, (p, pass) => sub(`${label} ${pass ? '다시 ' : ''}만드는 중 ${Math.round(p * 100)}%`));
      busy = false; setBusy(false);
      flash(`파일을 만들었습니다 (${mb(r.size)})` + (r.lowered ? ` · 잘림 방지로 모든 트랙 -${r.lowered}dB` : '') + (r.clipped ? ' · 일부 피크가 잘렸습니다' : ''));
    } catch (e) {
      busy = false; setBusy(false);
      flash('파일을 만들지 못했습니다: ' + e.message);
    }
    paintFoot();
  }

  $('artFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { meta.art = await prepareArt(f); } catch { flash('그림을 읽지 못했습니다'); }
    render();
  };
  $('srtFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    meta.srt = await f.text(); meta.srtName = f.name;
    if (!meta.lyrics.trim()) meta.lyrics = srtText(meta.srt).slice(0, 5000);
    render();
  };

  // 화면 갱신 때마다: 재생 중이면 파형의 재생 위치를 다시 그림
  let lastPos = -1;
  function tick() {
    if (!wave || !wave.cv.isConnected) return;
    const p = E.position;
    if (p !== lastPos) { lastPos = p; wave.draw(); }
  }

  return { render, setActive, tick };
}
