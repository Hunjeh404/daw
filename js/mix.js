// 같은 설정을 실시간 재생과 파일 출력에 사용한다.
import { slider, segmented, toggle, section } from './ui.js';
import { server, statusOf, trackSource, canDereverb, setDry, retryVoice, listModels, uploadModel, deleteModel, convertTrack } from './voice.js';

export function initMix({ engine: E, pushUndo, onChange, undo, redo, rescanFixed, voice }) {
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
    const level = E.mm.wider === 2 ? 'wide' : E.mm.wider ? 'some' : 'orig';
    space.append(label, segmented([['orig','원곡 그대로'], ['some','조금 넓게'], ['wide','넓게']], level, v => {
      if (v === level) return;
      pushUndo(); E.mm.wider = v === 'wide' ? 2 : v === 'some'; changed(); render();
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
    // 거리감: 마이크에 붙은 소리를 뒤로 물린다 (로우컷·250Hz 줄이기·치찰음 누르기·리버브 프리딜레이)
    const dist = document.createElement('div');
    dist.className = 'row';
    const distLabel = document.createElement('label');
    distLabel.textContent = '거리감';
    const dv = String(t.mix.dist || 0);
    dist.append(distLabel, segmented([['0','끔'], ['1','조금'], ['2','멀리']], dv, v => {
      if (v === dv) return;
      pushUndo(); t.mix.dist = +v; if (+v) E.mm.verb.on = true; changed(); render();
    }));
    card.append(dist);
    voiceRows(t, card);
    const active = chips.querySelector('.on');
    body.append(space, fixedCard(), chips, card, serverCard());
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

  // ---------- 목소리 서버: 잔향 제거 상태, 보컬 교체 ----------
  const shown = new Map();           // 상태 글자 요소 → { src, state }
  let models = null, modelsErr = '', modelsBusy = false;
  const pitchOf = new Map(), modelOf = new Map(), converting = new Map();
  const vocalish = (t) => (t.cat === 'vocal' || t.cat === 'backing') && !t.mix.ref;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const runVoice = () => retryVoice(E, voicePaint);

  function statusLine(src, prefix) {
    const n = el('div', 'note');
    const s = statusOf(src);
    n.textContent = (prefix || '') + (s ? s.msg : '');
    shown.set(n, { src, state: s?.state, prefix });
    return n;
  }

  function loadModels() {
    if (modelsBusy || !server.url) return;
    modelsBusy = true; modelsErr = '';
    listModels().then((m) => { models = m; }, (err) => { models = null; modelsErr = err.message; })
      .finally(() => { modelsBusy = false; render(); });
  }

  function voiceRows(t, card) {
    const src = trackSource(E, t);
    if (canDereverb(E, t)) {
      const row = el('div', 'row');
      row.append(el('label', null, '잔향 제거'));
      const s = statusOf(src);
      if (s?.state === 'done' && src.sounds) {
        row.append(segmented([['on', '켬'], ['off', '끔']], src.dryOn ? 'on' : 'off', (v) => { setDry(E, src, v === 'on'); changed(); render(); }));
        card.append(row);
      } else {
        const st = statusLine(src);
        st.classList.add('grow');
        if (!src || src.missing) st.textContent = '음원을 연결하면 자동으로 확인합니다.';
        else if (!s) st.textContent = '확인 대기 중';
        row.append(st);
        if (s && (s.state === 'err' || s.state === 'off') && server.url) {
          const b = el('button', null, '다시 시도');
          b.onclick = runVoice;
          row.append(b);
        }
        card.append(row);
      }
    }
    if (src?.vc) {
      card.append(el('div', 'note', `${src.vc.model} 모델로 바꾼 트랙 · 음 높이 ${src.vc.pitch > 0 ? '+' : ''}${src.vc.pitch}`));
      if (src.missing) card.append(statusLine(src));
      return;
    }
    if (!vocalish(t)) return;
    const box = el('div', 'vbox');
    box.append(el('b', 'xh', '보컬 교체'));
    if (!server.url) { box.append(el('div', 'note', '아래 목소리 서버 칸에 주소와 PIN을 넣으면 쓸 수 있습니다.')); card.append(box); return; }
    if (!models && !modelsErr) { box.append(el('div', 'note', '모델 목록을 불러오는 중')); loadModels(); card.append(box); return; }
    if (modelsErr) {
      const row = el('div', 'row');
      const n = el('div', 'note grow', modelsErr);
      const b = el('button', null, '다시 불러오기');
      b.onclick = () => { modelsErr = ''; loadModels(); render(); };
      row.append(n, b); box.append(row); card.append(box); return;
    }
    if (!models.length) { box.append(el('div', 'note', '서버에 목소리 모델이 없습니다. 아래 목소리 서버 칸에서 .pth 파일을 올리세요.')); card.append(box); return; }
    const pickRow = el('label', 'xfield');
    pickRow.append(el('span', null, '목소리 모델'));
    const sel = document.createElement('select');
    for (const m of models) { const o = el('option', null, m.name); o.value = m.name; sel.append(o); }
    if (!models.some((m) => m.name === modelOf.get(t.id))) modelOf.set(t.id, models[0].name);
    sel.value = modelOf.get(t.id);
    sel.onchange = () => modelOf.set(t.id, sel.value);
    pickRow.append(sel);
    box.append(pickRow, slider({
      label: '음 높이', min: -12, max: 12, step: 1, unit: '반음', noUndo: true,
      get: () => pitchOf.get(t.id) || 0, show: (v) => (v > 0 ? '+' : '') + v, set: (v) => pitchOf.set(t.id, v),
    }));
    const go = el('button', 'xgo', '새 트랙으로 바꾸기');
    const msg = el('div', 'note', converting.get(t.id) || '원래 트랙은 남기고 음소거합니다. 4분 곡 기준 몇 분 걸립니다.');
    go.disabled = converting.has(t.id) || !src || src.missing || ['measure', 'run'].includes(statusOf(src)?.state);
    go.onclick = async () => {
      const model = modelOf.get(t.id), pitch = pitchOf.get(t.id) || 0;
      converting.set(t.id, '보내는 중'); render();
      const say = (m) => { converting.set(t.id, m); msg.textContent = m; };
      try {
        pushUndo();
        const nt = await convertTrack(E, t, model, pitch, say);
        converting.delete(t.id);
        selected = nt;
        voice.addTrack(nt);
        changed(); render();
      } catch (err) {
        converting.delete(t.id);
        render();
        alertNote(t, err.message);
      }
    };
    box.append(go, msg);
    if (errOf.has(t.id)) box.append(el('div', 'note err', errOf.get(t.id)));
    card.append(box);
  }
  const errOf = new Map();
  function alertNote(t, text) { errOf.set(t.id, '바꾸지 못했습니다: ' + text); render(); setTimeout(() => { errOf.delete(t.id); }, 8000); }

  // 상태 글자만 바꾸고, 상태 자체가 바뀌었으면 (입력 중이 아닐 때) 다시 그린다
  function voicePaint() {
    onChange();
    let redraw = false;
    for (const [n, v] of shown) {
      if (!n.isConnected) { shown.delete(n); continue; }
      const s = statusOf(v.src);
      if (s?.state !== v.state) redraw = true;
      else if (s) n.textContent = (v.prefix || '') + s.msg;
    }
    const typing = body.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName);
    if (redraw && !typing && document.getElementById('tab-mix').classList.contains('show')) render();
  }

  function serverCard() {
    return section('voiceServer', '목소리 서버', null, (outer) => {
      const b = el('div', 'vlist');
      outer.append(b);
      const field = (label, value, type, ph) => {
        const f = el('label', 'xfield');
        const i = document.createElement('input');
        i.type = type; i.value = value; i.placeholder = ph; i.autocomplete = 'off';
        f.append(el('span', null, label), i);
        b.append(f);
        return i;
      };
      b.append(el('div', 'note', '보컬 잔향 제거와 보컬 교체를 하는 vocal-studio 서버입니다. 배포 때 나온 주소와 PIN을 넣으세요.'));
      const url = field('주소', server.url, 'url', 'https://…modal.run');
      const pin = field('PIN', server.pin, 'password', '배포 때 정한 숫자');
      const btns = el('div', 'xbtns');
      const save = el('button', null, '저장');
      save.onclick = () => { server.url = url.value; server.pin = pin.value; models = null; modelsErr = ''; runVoice(); render(); };
      btns.append(save);
      b.append(btns);
      if (!server.url) return;
      if (!models && !modelsErr) loadModels();
      b.append(el('b', 'xh', '등록된 모델'));
      if (modelsErr) b.append(el('div', 'note err', modelsErr));
      else if (!models) b.append(el('div', 'note', '불러오는 중'));
      else if (!models.length) b.append(el('div', 'note', '아직 없습니다.'));
      else for (const m of models) {
        const row = el('div', 'row');
        row.append(el('span', 'grow', m.name + (m.has_index ? '' : ' (index 없음)')));
        const del = el('button', null, '지우기');
        del.onclick = async () => {
          if (!confirm(`${m.name} 모델을 서버에서 지울까요?`)) return;
          del.disabled = true;
          try { await deleteModel(m.name); } catch (err) { modelsErr = err.message; }
          models = null; loadModels();
        };
        row.append(del);
        b.append(row);
      }
      b.append(el('b', 'xh', '모델 올리기'));
      b.append(el('div', 'note', '노트북 Applio에서 학습해 나온 .pth와 .index 파일을 올립니다.'));
      const name = field('모델 이름', '', 'text', '예: hoonjay_v1');
      const pth = field('.pth 파일', '', 'file', ''); pth.accept = '.pth';
      const idx = field('.index 파일 (선택)', '', 'file', ''); idx.accept = '.index';
      const up = el('button', null, '올리기');
      const upMsg = el('div', 'note');
      up.onclick = async () => {
        if (!name.value.trim() || !pth.files[0]) { upMsg.textContent = '모델 이름과 .pth 파일을 고르세요.'; return; }
        up.disabled = true; upMsg.textContent = '올리는 중';
        try { await uploadModel(name.value.trim(), pth.files[0], idx.files[0]); models = null; loadModels(); }
        catch (err) { up.disabled = false; upMsg.textContent = '올리지 못했습니다: ' + err.message; }
      };
      const ub = el('div', 'xbtns'); ub.append(up);
      b.append(ub, upMsg);
    });
  }

  return { render, select: t => { selected = t; }, voicePaint };
}
