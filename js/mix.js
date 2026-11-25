// 같은 설정을 실시간 재생과 파일 출력에 사용한다.
import { slider, segmented } from './ui.js';

export function initMix({ engine: E, pushUndo, onChange, undo, redo }) {
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
    body.append(space, chips, card);
    chips.scrollLeft = active.offsetLeft - chips.offsetLeft - (chips.clientWidth - active.offsetWidth) / 2;
  }
  return { render, select: t => { selected = t; } };
}
