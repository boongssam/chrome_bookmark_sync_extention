// 동기화 핵심 로직 (크롬 API를 쓰지 않는 순수 함수들)
// - flatten : 북마크 트리 → 평평한 목록
// - merge   : 지난번 동기화 상태(base) + 내 컴퓨터(local) + 서버(server)를 3자 병합
// - buildTree : 평평한 목록 → 북마크 트리

const SEP = '\u001f';

// 북마크 트리를 [{k, t, path, title, url, o}] 목록으로 변환
// k: 고유 키, t: 'f'(폴더) | 'b'(북마크), path: 상위 폴더 이름 배열, o: 폴더 안 순서
export function flatten(nodes, path = [], out = []) {
  (nodes || []).forEach((n, i) => {
    if (n.url) {
      out.push({ k: 'b|' + path.join(SEP) + '\u001e' + n.url, t: 'b', path: [...path], title: n.title, url: n.url, o: i, id: n.id });
    } else {
      const full = [...path, n.title];
      out.push({ k: 'f|' + full.join(SEP), t: 'f', path: [...path], title: n.title, o: i, id: n.id });
      flatten(n.children, full, out);
    }
  });
  return out;
}

const toMap = (items) => new Map((items || []).map((i) => [i.k, i]));

// 3자 병합 규칙
// - 양쪽(내 컴퓨터, 서버)에 모두 있으면 → 유지
// - 지난번에 없던 항목이 한쪽에 새로 생겼으면 → 추가로 보고 유지
// - 지난번엔 있었는데 한쪽에서 사라졌으면 → 삭제로 보고 제거
export function merge(base, local, server) {
  const B = toMap(base), L = toMap(local), S = toMap(server);
  const keys = new Set([...B.keys(), ...L.keys(), ...S.keys()]);
  const out = [];
  for (const k of keys) {
    const b = B.get(k), l = L.get(k), s = S.get(k);
    const keep = (l && s) || (!b && (l || s));
    if (!keep) continue;
    let item;
    if (l && s) {
      // 순서도 제목처럼: 지난번과 달라진 쪽(내 컴퓨터) 우선
      item = { ...s, o: b && l.o !== b.o ? l.o : s.o, id: l.id };
      // 제목은 지난번과 달라진 쪽(=이번에 수정한 쪽)을 우선
      if (b && l.title !== b.title) item.title = l.title;
    } else {
      item = { ...(l || s) };
    }
    out.push(item);
  }
  return normalize(out);
}

// 같은 폴더 안의 순서를 0,1,2… 로 다시 매김 (어느 컴퓨터에서나 같은 결과가 나오도록 키로 동점 처리)
export function normalize(items) {
  const groups = new Map();
  for (const it of items) {
    const p = it.path.join(SEP);
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(it);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.o - b.o || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    list.forEach((it, i) => { it.o = i; });
  }
  return items;
}

// 평평한 목록을 다시 트리로. 상위 폴더가 지워졌는데 안쪽 북마크가 살아남은 경우 폴더를 되살림
export function buildTree(items) {
  const root = { children: [] };
  const folders = new Map([['', root]]);
  const ensure = (path) => {
    const key = path.join(SEP);
    if (folders.has(key)) return folders.get(key);
    const parent = ensure(path.slice(0, -1));
    const node = { t: 'f', title: path[path.length - 1], o: Infinity, children: [] };
    parent.children.push(node);
    folders.set(key, node);
    return node;
  };
  const sorted = [...(items || [])].sort((a, b) => a.path.length - b.path.length);
  for (const it of sorted) {
    if (it.t === 'f') {
      const key = [...it.path, it.title].join(SEP);
      if (folders.has(key)) { folders.get(key).o = it.o; continue; }
      const node = { t: 'f', title: it.title, o: it.o, children: [] };
      ensure(it.path).children.push(node);
      folders.set(key, node);
    } else {
      ensure(it.path).children.push({ t: 'b', title: it.title, url: it.url, o: it.o });
    }
  }
  const sortRec = (n) => {
    n.children.sort((a, b) => a.o - b.o);
    n.children.forEach((c) => c.children && sortRec(c));
  };
  sortRec(root);
  return root.children;
}

// 두 목록이 같은지 비교하기 위한 서명
export function sig(items) {
  return (items || []).map((i) => `${i.k}\u0002${i.title}\u0002${i.o}`).sort().join('\n');
}

// 내 컴퓨터에서 직접 지운 개수 (지난번엔 있었고 서버에도 있는데 내 쪽에서만 사라진 것)
export function localDeletions(base, local, server) {
  const L = toMap(local), S = toMap(server);
  return (base || []).filter((b) => b.t === 'b' && !L.has(b.k) && S.has(b.k)).length;
}

// 서버에 올릴 때는 로컬 전용 값(id)을 뺌
export function strip(items) {
  return (items || []).map(({ id, ...rest }) => rest);
}

// 내 컴퓨터(local)를 병합 결과(merged)로 맞추기 위한 작업 목록
export function plan(local, merged) {
  const L = toMap(local), M = toMap(merged);
  const remove = local.filter((i) => !M.has(i.k));
  const rename = merged.filter((i) => i.t === 'b' && L.has(i.k) && L.get(i.k).title !== i.title)
    .map((i) => ({ id: L.get(i.k).id, title: i.title }));
  const add = merged.filter((i) => !L.has(i.k)).sort((a, b) => a.path.length - b.path.length || a.o - b.o);
  return { remove, rename, add };
}
