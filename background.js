import { flatten, merge, plan, sig, strip, localDeletions } from './sync-core.js';

const OLD_FOLDER_TITLE = '🔄 동기화';   // v0.1에서 쓰던 폴더 (자동 이전용)
const ALARM = 'periodic-sync';
let applying = false;   // 확장 프로그램이 직접 북마크를 바꾸는 중이면 이벤트 무시
let running = false;
let again = false;
let timer = null;

// ---------- 동기화 대상: 북마크바 전체 ----------
async function getBar() {
  const [root] = await chrome.bookmarks.getTree();
  const kids = root.children || [];
  return kids.find((n) => n.folderType === 'bookmarks-bar' && n.syncing)
    || kids.find((n) => n.folderType === 'bookmarks-bar')
    || kids.find((n) => n.id === '1')
    || kids[0];
}

// v0.1(🔄 폴더 방식) → v0.2(북마크바 전체) 이전:
// 🔄 폴더 안의 북마크를 북마크바로 꺼내고 빈 폴더를 지움.
// 서버에 저장된 목록도 "폴더 기준 경로"였으므로, 꺼낸 뒤에는 "북마크바 기준 경로"와 그대로 일치함.
async function migrate(bar) {
  const { mode } = await chrome.storage.local.get('mode');
  if (mode === 'bar') return;
  const kids = await chrome.bookmarks.getChildren(bar.id);
  const old = kids.find((n) => !n.url && n.title === OLD_FOLDER_TITLE);
  if (old) {
    applying = true;
    try {
      for (const c of await chrome.bookmarks.getChildren(old.id)) {
        await chrome.bookmarks.move(c.id, { parentId: bar.id });
      }
      await chrome.bookmarks.remove(old.id);
    } finally {
      setTimeout(() => { applying = false; }, 1000);
    }
  }
  await chrome.storage.local.set({ mode: 'bar' });
}

async function getFolder() {
  const bar = await getBar();
  await migrate(bar);
  await chrome.storage.local.set({ folderId: bar.id });
  return bar;
}

async function readLocal(folderId) {
  const [sub] = await chrome.bookmarks.getSubTree(folderId);
  return flatten(sub.children || []);
}

// ---------- 서버 통신 ----------
async function api(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error('서버 응답을 읽지 못했습니다. 웹 앱 URL과 배포 설정(액세스: 모든 사용자)을 확인해 주세요.');
  }
  if (data.error === 'unauthorized') throw new Error('토큰이 맞지 않습니다. 설정을 확인해 주세요.');
  if (data.error && data.error !== 'conflict') throw new Error('서버 오류: ' + data.error);
  return data;
}

// ---------- 내 컴퓨터에 반영 ----------
async function applyLocal(folderId, local, merged) {
  const { remove, rename, add } = plan(local, merged);
  applying = true;
  try {
    for (const it of remove) {
      try {
        if (it.t === 'b') await chrome.bookmarks.remove(it.id);
        else await chrome.bookmarks.removeTree(it.id);
      } catch (e) { /* 상위 폴더와 함께 이미 지워진 경우 */ }
    }
    for (const r of rename) await chrome.bookmarks.update(r.id, { title: r.title });

    // 폴더 경로 → 북마크 id
    const SEP = '\u001f';
    const ids = new Map([['', folderId]]);
    for (const it of await readLocal(folderId)) {
      if (it.t === 'f') ids.set([...it.path, it.title].join(SEP), it.id);
    }
    const ensure = async (path) => {
      const key = path.join(SEP);
      if (ids.has(key)) return ids.get(key);
      const parentId = await ensure(path.slice(0, -1));
      const f = await chrome.bookmarks.create({ parentId, title: path[path.length - 1] });
      ids.set(key, f.id);
      return f.id;
    };
    for (const it of add) {
      const parentId = await ensure(it.path);
      const count = (await chrome.bookmarks.getChildren(parentId)).length;
      const index = Math.min(it.o ?? count, count);
      if (it.t === 'f') {
        const key = [...it.path, it.title].join(SEP);
        if (!ids.has(key)) {
          const f = await chrome.bookmarks.create({ parentId, title: it.title, index });
          ids.set(key, f.id);
        }
      } else {
        await chrome.bookmarks.create({ parentId, title: it.title, url: it.url, index });
      }
    }

    // 순서 맞추기
    const now = new Map((await readLocal(folderId)).map((i) => [i.k, i]));
    const byParent = new Map();
    for (const it of merged) {
      const p = it.path.join(SEP);
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(it);
    }
    for (const [p, list] of byParent) {
      const parentId = ids.get(p);
      if (!parentId) continue;
      list.sort((a, b) => a.o - b.o);
      for (let i = 0; i < list.length; i++) {
        const cur = now.get(list[i].k);
        if (!cur) continue;
        const kids = await chrome.bookmarks.getChildren(parentId);
        if (kids[i] && kids[i].id === cur.id) continue;
        await chrome.bookmarks.move(cur.id, { parentId, index: i });
      }
    }
  } finally {
    setTimeout(() => { applying = false; }, 1000);
  }
}

// ---------- 동기화 본체 ----------
async function syncOnce(force = false) {
  const s = await chrome.storage.local.get(['url', 'token', 'base', 'version']);
  if (!s.url || !s.token) throw new Error('설정에서 웹 앱 URL과 토큰을 먼저 입력해 주세요.');

  const folder = await getFolder();
  const local = await readLocal(folder.id);
  let server = await api(s.url, { action: 'get', token: s.token });

  for (let attempt = 0; attempt < 3; attempt++) {
    const base = s.base || [];
    const merged = merge(base, local, server.items || []);

    // 안전장치: 내 컴퓨터에서 한 번에 너무 많이 지워졌으면 멈춤 (폴더 통째 삭제 사고 방지)
    const total = base.filter((i) => i.t === 'b').length;
    const lost = localDeletions(base, local, server.items || []);
    if (!force && s.base && total >= 10 && lost > total * 0.5) {
      throw new Error(`이 컴퓨터에서 북마크 ${lost}개가 한꺼번에 삭제되어 동기화를 멈췄습니다. 의도한 삭제라면 팝업의 "강제 동기화"를 눌러 주세요.`);
    }

    let version = server.version;
    if (sig(merged) !== sig(server.items)) {
      const res = await api(s.url, { action: 'put', token: s.token, baseVersion: server.version, items: strip(merged) });
      if (res.error === 'conflict') { server = res; continue; }  // 다른 컴퓨터가 먼저 저장 → 다시 병합
      version = res.version;
    }
    if (sig(merged) !== sig(local)) await applyLocal(folder.id, local, merged);

    await chrome.storage.local.set({
      base: strip(await readLocal(folder.id)),
      version,
      lastSync: new Date().toISOString(),
      lastError: '',
      count: merged.filter((i) => i.t === 'b').length,
    });
    return;
  }
  throw new Error('다른 컴퓨터와 동시에 저장되어 잠시 뒤 다시 시도합니다.');
}

async function sync(force = false) {
  if (running) { again = true; return; }
  running = true;
  try {
    await syncOnce(force);
    chrome.action.setBadgeText({ text: '' });
  } catch (e) {
    await chrome.storage.local.set({ lastError: e.message, lastTry: new Date().toISOString() });
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  } finally {
    running = false;
    if (again) { again = false; sync(); }
  }
}

function schedule() {
  if (applying) return;
  clearTimeout(timer);
  timer = setTimeout(sync, 3000);  // 연달아 고칠 때는 3초 기다렸다가 한 번에
}

// ---------- 이벤트 연결 ----------
['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered'].forEach((ev) => {
  chrome.bookmarks[ev].addListener(schedule);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 5 });
  sync();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 5 });
  sync();
});
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) sync(); });

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'sync-now') {
    sync().then(() => reply({ done: true }));
    return true;
  }
  if (msg.type === 'force-sync') {
    // 대량 삭제 안전장치만 건너뛰고 한 번 동기화
    sync(true).then(() => reply({ done: true }));
    return true;
  }
  if (msg.type === 'reset') {
    chrome.storage.local.remove(['base', 'version', 'lastSync', 'lastError']).then(() => reply({ done: true }));
    return true;
  }
});
