// 프로젝트 창: 저장, 다른 이름으로 저장, 새 프로젝트, 목록(열기·파일로·삭제), 파일에서 가져오기
import { listProjects, getProject, putProject, deleteProject, serialize, applyProject, parseProjectFile } from './project.js';
import { download } from './filewrite.js';

const $ = (id) => document.getElementById(id);
const safe = (s) => (s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'project';
const when = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

export function initProjects({ engine: E, flash, clearAll, opened, isBusy }) {
  const sheet = $('sheet'), box = $('sheetBody');
  const close = () => { sheet.hidden = true; };
  $('sheetClose').onclick = close;
  sheet.onclick = (e) => { if (e.target === sheet) close(); };

  const curName = () => E.projectName || (E.meta && E.meta.title) || '새 프로젝트';

  async function render() {
    box.innerHTML = '';
    const top = document.createElement('div');
    top.className = 'xcard';
    top.innerHTML = `<b class="xh">지금 프로젝트</b><label class="xfield"><span>이름</span><input type="text" id="projName"></label><div class="xbtns"></div>`;
    top.querySelector('input').value = curName();
    const btns = top.querySelector('.xbtns');
    const mk = (label, fn, cls) => { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; btns.appendChild(b); return b; };
    const nameNow = () => top.querySelector('input').value.trim() || '새 프로젝트';
    mk('저장', () => save(false), 'xgo');
    mk('다른 이름으로 저장', () => save(true));
    mk('파일로 내보내기', () => {
      if (!E.tracks.length) { flash('저장할 트랙이 없습니다'); return; }
      const p = serialize(E, nameNow(), E.projectId || crypto.randomUUID());
      download(new Blob([JSON.stringify(p)], { type: 'application/json' }), `${safe(p.name)}.daw4.json`);
    });
    mk('새 프로젝트', async () => {
      if (E.tracks.length && !confirm('지금 작업 중인 내용은 저장하지 않으면 사라집니다. 새로 시작할까요?')) return;
      await clearAll();
      E.projectId = null; E.projectName = '';
      close();
      flash('새 프로젝트를 시작했습니다');
    });
    box.appendChild(top);

    async function save(asNew) {
      if (isBusy()) { flash('분석·파일 만들기가 끝난 뒤에 저장하세요'); return; }
      if (!E.tracks.length) { flash('저장할 트랙이 없습니다'); return; }
      const id = asNew || !E.projectId ? crypto.randomUUID() : E.projectId;
      const p = serialize(E, nameNow(), id);
      try {
        await putProject(p);
        E.projectId = id; E.projectName = p.name;
        flash(`"${p.name}" 저장했습니다`);
        render();
      } catch (e) { flash('저장하지 못했습니다: ' + e.message); }
    }

    const list = document.createElement('div');
    list.className = 'xcard';
    list.innerHTML = '<b class="xh">저장된 프로젝트</b>';
    let items = [];
    try { items = await listProjects(); } catch (e) { flash('목록을 읽지 못했습니다: ' + e.message); }
    if (!items.length) {
      const n = document.createElement('div'); n.className = 'note'; n.textContent = '아직 저장한 프로젝트가 없습니다'; list.appendChild(n);
    }
    for (const it of items) {
      const r = document.createElement('div');
      r.className = 'pitem' + (it.id === E.projectId ? ' on' : '');
      r.innerHTML = `<div class="pname"><b></b><small></small></div><div class="xbtns"></div>`;
      r.querySelector('b').textContent = it.name;
      r.querySelector('small').textContent = `${when(it.savedAt)} · ${it.n}트랙`;
      const bb = r.querySelector('.xbtns');
      const add = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; bb.appendChild(b); };
      add('열기', () => openProject(it.id));
      add('파일로', async () => { const p = await getProject(it.id); download(new Blob([JSON.stringify(p)], { type: 'application/json' }), `${safe(p.name)}.daw4.json`); });
      add('삭제', async () => { if (!confirm(`"${it.name}"을 지울까요?`)) return; await deleteProject(it.id); if (E.projectId === it.id) E.projectId = null; render(); });
      list.appendChild(r);
    }
    const imp = document.createElement('button');
    imp.textContent = '파일에서 가져오기';
    imp.onclick = () => $('projFile').click();
    list.appendChild(imp);
    box.appendChild(list);
  }

  async function load(p) {
    if (isBusy()) { flash('분석·파일 만들기가 끝난 뒤에 여세요'); return; }
    if (E.tracks.length && !confirm('지금 작업 중인 내용은 저장하지 않으면 사라집니다. 열까요?')) return;
    await clearAll();
    applyProject(E, p);
    E.projectId = p.id; E.projectName = p.name;
    close();
    opened();
  }
  async function openProject(id) {
    try { await load(await getProject(id)); } catch (e) { flash('열지 못했습니다: ' + e.message); }
  }

  $('projFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const p = parseProjectFile(await f.text());
      if (await getProject(p.id)) p.id = crypto.randomUUID();   // 이미 있는 프로젝트를 덮지 않게
      await putProject(p);
      await load(p);
    } catch (err) { flash('가져오지 못했습니다: ' + err.message); }
  };

  return { open: () => { sheet.hidden = false; render(); } };
}
