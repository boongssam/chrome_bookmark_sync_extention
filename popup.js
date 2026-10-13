const $ = (id) => document.getElementById(id);

async function render() {
  const s = await chrome.storage.local.get(['url', 'token', 'lastSync', 'lastError', 'lastTry', 'count']);
  $('url').value = s.url || '';
  $('token').value = s.token || '';
  const st = $('status');
  if (s.lastError) {
    st.className = 'err';
    st.textContent = '⚠ ' + s.lastError;
  } else if (s.lastSync) {
    st.className = '';
    st.textContent = `마지막 동기화: ${new Date(s.lastSync).toLocaleString('ko-KR')}\n동기화 중인 북마크: ${s.count ?? 0}개`;
  } else {
    st.className = '';
    st.textContent = '아직 동기화하지 않았습니다.';
  }
}

async function run(type, label) {
  $('status').className = '';
  $('status').textContent = label;
  await chrome.runtime.sendMessage({ type });
  render();
}

$('save').onclick = async () => {
  await chrome.storage.local.set({ url: $('url').value.trim(), token: $('token').value.trim() });
  run('sync-now', '저장했습니다. 동기화 중…');
};
$('sync').onclick = () => run('sync-now', '동기화 중…');
$('force').onclick = () => run('force-sync', '강제 동기화 중…');
$('reset').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'reset' });
  run('sync-now', '기록을 초기화하고 다시 합치는 중…');
};

render();
