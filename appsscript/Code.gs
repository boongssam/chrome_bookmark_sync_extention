/**
 * 북마크 동기화 서버 (구글 앱스 스크립트)
 * - 구글 계정 하나(주 계정)에만 설치하면 됩니다.
 * - 데이터는 그 계정의 구글 드라이브에 "bookmark-sync-data.json" 파일로 저장됩니다.
 * - 처음 한 번 setup() 을 실행해 토큰(비밀번호 역할)을 만듭니다.
 */
const FILE_NAME = 'bookmark-sync-data.json';

// ① 처음 한 번만 실행: 토큰 생성 → [실행 로그]에 표시된 토큰을 확장 프로그램 설정에 붙여넣기
function setup() {
  const token = Utilities.getUuid();
  PropertiesService.getScriptProperties().setProperty('TOKEN', token);
  file_();
  Logger.log('토큰: ' + token);
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad_request' }); }
  const saved = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!saved || body.token !== saved) return json_({ error: 'unauthorized' });

  if (body.action === 'get') return json_(read_());

  if (body.action === 'put') {
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const cur = read_();
      // 다른 컴퓨터가 먼저 저장했다면 거절 → 확장 프로그램이 다시 받아서 병합 후 재시도
      if (body.baseVersion !== cur.version) return json_({ error: 'conflict', version: cur.version, items: cur.items });
      const next = { version: cur.version + 1, items: body.items || [], updatedAt: new Date().toISOString() };
      file_().setContent(JSON.stringify(next));
      return json_({ ok: true, version: next.version });
    } finally {
      lock.releaseLock();
    }
  }
  return json_({ error: 'unknown_action' });
}

function doGet() {
  return json_({ ok: true, message: '북마크 동기화 서버가 동작 중입니다.' });
}

function read_() {
  return JSON.parse(file_().getBlob().getDataAsString());
}

function file_() {
  const it = DriveApp.getFilesByName(FILE_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFile(FILE_NAME, JSON.stringify({ version: 0, items: [] }), MimeType.PLAIN_TEXT);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
