// 같은 설정을 실시간 재생과 파일 출력에 사용한다.
import { slider, segmented, toggle } from './ui.js';

export function initMix({ engine: E, pushUndo, onChange, undo, redo, rescanFixed }) {
  const top = document.getElementById('mixTop'), body = document.getElementById('mixBody');
  let selected = null;

  function changed() {
    E.setMode('apply');
    onChange();
  }

  function historyButton(id, label, action) {
    const button = document.createElement('button');
    button.className = id + '-btn';
    button.setAttribute('aria-label', label);
    button.innerHTML = document.getElementById(id).innerHTML;
    button.disabled = document.getElementById(id).disabled;
    button.onclick = action;
    return button;
  }

  function listenButton(t, key, label) {
    const button = document.createElement('button');
    button.textContent = label;
    button.classList.toggle('on', t[key]);
    button.setAttribute('aria-pressed', String(t[key]));
    button.onclick = () => {
      pushUndo(); t[key] = !t[key];
      changed(); render();
    };
    return button;
  }

  function render() {
    top.replaceChildren(historyButton('undo', '되돌리기', undo), historyButton('redo', '다시 하기', redo));
    body.replaceChildren();
    if (E.loading || E.guidedPending || !E.tracks.length) {
      body.textContent = E.loading ? '음원을 준비하고 있습니다.' : E.guidedPending
        ? '편집 탭에서 원곡과 스템을 다시 연결하세요.' : '먼저 원곡과 스템 또는 트랙 음원을 불러오세요.';
      return;
    }
    const tracks = E.tracks.filter(t => !t.mix.ref);
    if (!tracks.length) { body.textContent = '믹싱할 트랙을 추가하세요.'; return; }
    if (!tracks.includes(selected)) selected = tracks[0];
    const t = selected;

    const space = document.createElement('div');
    space.className = 'spread';
    const label = document.createElement('span');
    label.textContent = '전체 공간감';
    space.append(label, segmented([['orig','원곡 그대로'], ['wide','조금 넓게']], E.mm.wider ? 'wide' : 'orig', v => {
      if (!!E.mm.wider === (v === 'wide')) return;
      pushUndo(); E.mm.wider = v === 'wide'; changed();
    }));
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const track of tracks) {
      const button = document.createElement('button');
      button.className = 'chip' + (track === t ? ' on' : '');
      button.setAttribute('aria-pressed', String(track === t));
      const dot = document.createElement('span');
      dot.className = 'dot'; dot.style.background = track.color;
      button.append(dot, track.name);
      button.onclick = () => { selected = track; render(); };
      chips.append(button);
    }
    const card = document.createElement('div');
    card.className = 'xcard';
    const head = document.createElement('div');
    head.className = 'row';
    const name = document.createElement('b');
    name.className = 'grow'; name.textContent = t.name;
    head.append(name, listenButton(t, 'muted', '음소거'), listenButton(t, 'solo', '솔로'));
    card.append(head, slider({
      label:'볼륨', min:-24, max:12, step:.1, unit:'dB', get:() => t.volumeDb,
      show:v => v.toFixed(1), set:v => { t.volumeDb = v; changed(); },
    }), slider({
      label:'리버브', min:0, max:100, step:1, unit:'%', get:() => Math.round(t.mix.send * 100),
      show:String, set:v => { t.mix.send = v / 100; if (v) E.mm.verb.on = true; changed(); },
    }));
    const active = chips.querySelector('.on');
    body.append(space, fixedCard(), chips, card);
    chips.scrollLeft = active.offsetLeft - chips.offsetLeft - (chips.clientWidth - active.offsetWidth) / 2;
  }
  // 고정음 제거: 곡 전체에서 늘 같은 높이로 울리는 고정음을 깎는다. 깎인 소리만 따로 듣고, 음마다 남길 수도 있다
  let listOpen = false;
  function fixedCard() {
    const F = E.mm.fixed;
    const card = document.createElement('div');
    card.className = 'xcard fixed';
    const head = document.createElement('div');
    head.className = 'row';
    const title = document.createElement('b');
    title.className = 'grow'; title.textContent = '고정음 제거';
    head.append(title);
    card.append(head);
    const note = (text) => { const n = document.createElement('div'); n.className = 'note'; n.textContent = text; card.append(n); };
    const listen = (key, label) => {
      const b = document.createElement('button');
      const on = E.fixedListen === key;
      b.textContent = on ? '듣기 끄기' : label;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      b.onclick = () => {
        E.mode = 'apply'; E.monitor = null;
        E.fixedListen = on ? null : key;
        E.applyAll(); onChange(); render();
      };
      return b;
    };
    if (!F || F.busy) { note('고정음을 찾는 중입니다…'); return card; }
    const rescan = document.createElement('button');
    rescan.textContent = '다시 찾기';
    rescan.onclick = () => { E.mm.fixed = null; E.fixedListen = null; E.applyAll(); rescanFixed(); };
    if (!F.tones.length) {
      note('늘 같은 높이로 울리는 고정음을 찾지 못했습니다.');
      const row = document.createElement('div'); row.className = 'xbtns'; row.append(rescan); card.append(row);
      return card;
    }
    head.append(toggle(F.on, (v) => { F.on = v; changed(); render(); }, '고정음 제거 켜기'));
    const removing = F.on ? F.tones.filter((t) => t.on).length : 0;
    note(`고정음 ${F.tones.length}개를 찾아 ${removing}개를 깎고 있습니다. 끈 음은 깎지 않고 그대로 남깁니다.`);
    const btns = document.createElement('div');
    btns.className = 'xbtns';
    const more = document.createElement('button');
    more.textContent = listOpen ? '음 목록 접기' : `음별로 고르기 (${F.tones.length})`;
    more.onclick = () => { listOpen = !listOpen; render(); };
    btns.append(listen('all', '제거된 음만 듣기'), more, rescan);
    card.append(btns);
    if (listOpen) F.tones.forEach((t, i) => {
      const row = document.createElement('div');
      row.className = 'row tone';
      const label = document.createElement('span');
      label.className = 'grow';
      label.textContent = `${Math.round(t.f).toLocaleString()} Hz · ${t.db.toFixed(1)} dB 솟음`;
      const sw = toggle(t.on, (v) => { t.on = v; changed(); render(); }, `${Math.round(t.f)} Hz 제거`);
      sw.disabled = !F.on;
      row.append(label, listen(i, '듣기'), sw);
      card.append(row);
    });
    if (E.fixedListen != null) note('재생하면 깎여 나가는 소리만 4배(+12dB)로 키워서 들려줍니다. 음마다 "듣기"를 누르면 그 음 하나만, 꺼 둔 음도 들어볼 수 있습니다.');
    return card;
  }

  return { render, select: t => { selected = t; } };
}
