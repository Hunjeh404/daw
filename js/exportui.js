// 내보내기 탭: 출력 범위 → 파일 형식 → 곡 정보, 아래 "파일 만들기" 고정
import { segmented, toggle, slider } from './ui.js';
import { srtText, prepareArt } from './filewrite.js';
import { exportAudio } from './export.js';

const $ = (id) => document.getElementById(id);
const mb = (n) => (n / 1048576).toFixed(1) + 'MB';

export function initExport({ engine: E, flash, sub, setBusy, onStop }) {
  const body = $('expBody'), foot = $('expFoot');
  const st = E.exp = { scope: 'mix', fmt: 'wav', bits: 24, off: new Set(), listOpen: false, a: 0, b: null, fi: 0, fo: 0 };
  const SR = 44100;
  const tfmt = (sec) => { const m = Math.floor(sec / 60), r = sec - m * 60; return `${m}:${r.toFixed(1).padStart(4, '0')}`; };
  const meta = E.meta = { title: '', artist: '', lyrics: '', art: null, srt: null, srtName: '', saveSrt: true };
  let busy = false;

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
    const timeSlider = (label, key, lo) => slider({ label, min: 0, max: dur.toFixed(1), step: 0.1, noUndo: true, get: () => st[key], show: tfmt, edit: (v) => v.toFixed(1),
      set: (v) => { st[key] = key === 'a' ? Math.min(v, st.b - 1) : Math.max(v, st.a + 1); paintSum(); } });
    cR.append(timeSlider('시작', 'a'), timeSlider('끝', 'b'));
    const btns = document.createElement('div');
    btns.className = 'xbtns';
    const mk = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { fn(); render(); }; btns.appendChild(b); };
    mk('재생 위치를 시작으로', () => { st.a = Math.min(E.position / SR, st.b - 1); });
    mk('재생 위치를 끝으로', () => { st.b = Math.max(E.position / SR, st.a + 1); });
    mk('처음~끝 전체', () => { st.a = 0; st.b = dur; });
    cR.appendChild(btns);
    cR.append(
      slider({ label: '페이드 인', min: 0, max: 10, step: 0.1, unit: '초', noUndo: true, get: () => st.fi, show: (v) => v.toFixed(1), set: (v) => { st.fi = v; } }),
      slider({ label: '페이드 아웃', min: 0, max: 20, step: 0.1, unit: '초', noUndo: true, get: () => st.fo, show: (v) => v.toFixed(1), set: (v) => { st.fo = v; } }),
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

  return { render };
}
