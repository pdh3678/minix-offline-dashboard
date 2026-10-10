/**
 * 미닉스 설문 — Google Apps Script
 * apps-script.js 와 **같은 Apps Script 프로젝트의 파일**이다(편집기 파일명 "survey", 전역을 공유한다 —
 * _json · _isAdminEmail · _cachePutJSON · _cacheGetJSON · 오프라인 설정 탭 헬퍼(_offReadRows · _offWriteBlock · OFF_TABS)를 쓴다).
 *
 * ★ 배포 방법
 * 1. 편집기 → 파일 ＋ → 스크립트 → 이름 "survey" → 이 파일 내용 전체 붙여넣기 후 저장
 * 2. 프로젝트 설정 → 스크립트 속성에 SURVEY_FOLDER_ID = 설문 폴더 ID(회사 공유 드라이브 안의 폴더) 추가 — 코드에 넣지 않는다
 * 3. 편집기에서 survey_setup 1회 실행(권한 승인) — 여러 번 실행해도 안전하다
 * 4. 편집기에서 survey_installRetentionTrigger 1회 실행 — 개인정보 보유기간 삭제(매일 새벽 4시)
 * 5. 배포 관리 → 기존 웹앱 배포 편집 → "새 버전"(URL 유지)
 *
 * 저장소: 설문 폴더 안의 스프레드시트 '미닉스 설문 응답'(설문목록 · 응답 · 처리기록 · 다운로드로그) + 하위 폴더 '영수증·첨부'.
 * 판매 데이터 시트와 완전히 분리한다 — 개인정보(이름·연락처·주소·영수증 사진)는 여기에만 저장된다.
 * 시트 입출력은 SpreadsheetApp만 쓴다(Sheets API 아님) — 대시보드가 같이 쓰는 Sheets API 사용자당 분당 한도를 건드리지 않는다.
 * 응답 쓰기는 ScriptLock 안에서 한다. 공구 저장(_withStructLock)도 같은 락을 5초까지 기다리므로 락 안에서는 시트만 만지고,
 * 사진 업로드(Drive)는 락 밖에서 끝낸다 — 락을 잡는 시간이 1초 안쪽이다.
 *
 * 공개(세션 없음) 액션은 둘뿐이다 — survey_getPublic · survey_submit. doPost가 세션 확인 **전에** 이 두 이름만 정확히 비교해 보낸다.
 * 나머지 survey_* (목록·편집·결과·다운로드·이미지·처리상태)는 doPost가 세션을 확인한 뒤 _surveyHandle로 온다.
 * 로그: 응답 내용(이름·연락처·주소·자유 입력)은 Logger에 남기지 않는다 — 실행 기록은 스크립트 편집 권한자 모두가 본다.
 * 영수증 파일은 공유 설정을 바꾸지 않는다(공유 드라이브 구성원만 접근) — 대시보드는 세션 확인 뒤 GAS가 읽어 전달한다(survey_images).
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 설정 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

var SV_FOLDER_PROP = 'SURVEY_FOLDER_ID';        // 설문 폴더(사람이 등록)
var SV_SHEET_PROP = 'SURVEY_SHEET_ID';          // '미닉스 설문 응답' — survey_setup이 기록
var SV_FILES_PROP = 'SURVEY_FILES_FOLDER_ID';   // '영수증·첨부' — survey_setup이 기록
var SV_SECRET_PROP = 'SURVEY_HASH_SECRET';      // 중복키·폼 토큰 HMAC 키 — survey_setup이 만든다
var SV_SS_NAME = '미닉스 설문 응답';
var SV_FILES_NAME = '영수증·첨부';
var SV_MIME_SHEET = 'application/vnd.google-apps.spreadsheet';
var SV_MIME_FOLDER = 'application/vnd.google-apps.folder';
// 오프라인 스프레드시트 설정 탭의 키 — 링크·QR = 이 주소 + /s/{주소}
var SV_BASE_KEY = '설문_공개기본주소';
var SV_BASE_DEFAULT = 'https://minix-offlinepart-dashboard.onrender.com';

var SV_STATUSES = ['초안', '게시', '마감'];
var SV_RESP_STATUSES = ['대기', '승인', '반려', '발송완료'];
var SV_TYPES = ['notice', 'consent', 'file', 'checkbox', 'radio', 'dropdown', 'short', 'long', 'name', 'phone', 'address', 'date', 'scale'];
var SV_CHOICE = { checkbox: true, radio: true, dropdown: true };
var SV_PII = { name: true, phone: true, address: true };             // 결과 화면 기본 마스킹
var SV_KEEP = { consent: true, checkbox: true, radio: true, dropdown: true, scale: true }; // 보유기간이 지나도 남기는 통계용 답변
// 답의 모양이 같은 유형 — 유형을 바꿔도 같은 묶음이면 질문 ID(기존 답변)를 그대로 쓴다
var SV_SHAPE = { checkbox: 'choice', radio: 'choice', dropdown: 'choice', short: 'text', long: 'text' };
var SV_BLOCK_TYPES = { paragraph: true, heading: true, bulletListItem: true, numberedListItem: true };
var SV_COLORS = { 'default': true, gray: true, brown: true, red: true, orange: true, yellow: true, green: true, blue: true, purple: true, pink: true };

var SV_RETENTION_DEFAULT = 90;              // 개인정보 보유기간 기본값(일) — 마감 후
var SV_MIN_FILL_MS = 5000;                  // 페이지 표시 후 이 시간 안의 제출은 거절(사람이 채울 수 없는 속도)
var SV_TOKEN_MAX_AGE_MS = 7 * 86400000;     // 폼 토큰 수명 — 페이지를 열어 둔 채 며칠 뒤 제출해도 되게
var SV_RATE_PER_MIN = 30;                   // 설문별 분당 제출 상한
var SV_LOCK_WAIT_MS = 10000;
var SV_FILE_MB_DEFAULT = 10;                // 파일 한 장 상한 기본값(압축 못 하는 원본 기준) — 질문 설정 1~10
var SV_TOTAL_MAX_BYTES = 30 * 1024 * 1024;  // 한 번 제출의 사진 합계 상한(doPost 본문 한도 50MB 안쪽)
var SV_CELL_MAX = 49000;                    // 시트 셀 5만 자 한도
var SV_CACHE_KEY = 'survey:list';
var SV_CACHE_TTL = 60;
var SV_RETENTION_HANDLER = 'survey_retentionDaily';

// 탭 정의 — headers 순서가 곧 시트 열 순서. 전부 텍스트 서식(@) — 시각·ID·숫자 같은 문자열을 시트가 바꾸지 않게
var SV_TABS = {
  surveys: { name: '설문목록', headers: ['설문ID', '주소', '이전주소', '제목', '상태', '시작일시', '마감일시', '응답수제한', '안내문', '질문목록', '감사문구',
    '개인정보보유기간(일)', '수정일', '수정자', '생성일', '최초게시일', '마감처리일'] },
  responses: { name: '응답', headers: ['응답ID', '설문ID', '제출시각', '답변', '첨부파일ID', '중복키', '처리상태', '메모', '반려사유', '개인정보삭제일'] },
  actions: { name: '처리기록', headers: ['시각', '처리자', '설문ID', '응답ID', '작업', '내용'] },
  downloads: { name: '다운로드로그', headers: ['시각', '다운로드한 사람', '설문ID', '건수', '범위', '파일명'] }
};
var SV_TAB_ORDER = ['surveys', 'responses', 'actions', 'downloads'];
var SV_R = { id: 0, survey: 1, at: 2, answers: 3, files: 4, dup: 5, status: 6, memo: 7, reason: 8, purgedAt: 9 };

// 요청 하나 동안 연 스프레드시트 — 핸들러 입구에서 비운다(Apps Script는 실행마다 전역이 새로 시작하지만 테스트는 한 프로세스에서 여러 번 부른다)
var _svIo = { ss: null };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 공통 헬퍼 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _svProps() { return PropertiesService.getScriptProperties(); }
function _svErr(code, message, extra) { var e = new Error(message); e.svCode = code; e.svExtra = extra || null; return e; }
function _svErrJson(err, action) {
  var o = { error: String((err && err.message) || err), code: (err && err.svCode) || 'ERROR', action: action };
  if (err && err.svExtra) Object.keys(err.svExtra).forEach(function (k) { o[k] = err.svExtra[k]; });
  return o;
}
function _svNowStr(ms) { return Utilities.formatDate(new Date(ms == null ? Date.now() : ms), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'); }
// 'YYYY-MM-DD HH:mm'(또는 T 구분) → 한국 시각으로 본 ms. 형식이 아니면 null
function _svParseKst(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s == null ? '' : s));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5]) : null;
}
function _svNormDt(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s == null ? '' : s).trim());
  return m ? m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] : '';
}
function _svDateOf(ms) { return ms == null ? '' : Utilities.formatDate(new Date(ms), 'Asia/Seoul', 'yyyy-MM-dd'); }
// 시트 셀 → 문자열(시트가 날짜·숫자로 바꿔 둔 값도 원래 모양으로)
function _svStr(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return _svNowStr(v.getTime());
  return v == null ? '' : String(v);
}
// 쓰기 직전 — '='·'+'·'-'·'@'로 시작하는 글자는 수식으로 해석되지 않게 앞에 '를 붙인다(시트는 읽을 때 이 '를 빼고 준다)
function _svCell(v) {
  if (v == null) return '';
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;
  return v;
}
function _svJson(s, fallback) { try { var v = JSON.parse(String(s || '')); return v == null ? fallback : v; } catch (e) { return fallback; } }
function _svText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
function _svPosInt(v) { var n = Number(v); return v !== '' && v != null && isFinite(n) && n >= 1 && n === Math.round(n) ? n : 0; }
function _svSplit(v) { return String(v == null ? '' : v).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; }); }
function _svRand(n) {
  var s = '';
  while (s.length < n) s += Utilities.getUuid().replace(/[^0-9a-z]/gi, '').toLowerCase();
  return s.slice(0, n);
}
function _svHex(bytes) { return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join(''); }
function _svSecret() {
  var s = _svProps().getProperty(SV_SECRET_PROP);
  if (!s) throw new Error('Script Properties에 ' + SV_SECRET_PROP + '가 없습니다 — 편집기에서 survey_setup을 실행하세요.');
  return s;
}
function _svHmac(msg) { return _svHex(Utilities.computeHmacSha256Signature(msg, _svSecret())); }
function _svIsOpen(s, now) {
  if (!s || s.status !== '게시') return false;
  var st = _svParseKst(s.startAt), en = _svParseKst(s.endAt);
  if (st != null && now < st) return false;
  if (en != null && now >= en) return false;
  return true;
}
// 개인정보 삭제 예정 시각 — 마감(마감 처리 시각과 마감일시 중 이른 쪽) + 보유기간. 마감 기준이 없으면 null
function _svPurgeDueMs(s) {
  var en = _svParseKst(s.endAt), cl = s.status === '마감' ? _svParseKst(s.closedAt) : null;
  var base = cl != null && en != null ? Math.min(cl, en) : (cl != null ? cl : en);
  return base == null ? null : base + (s.retentionDays || SV_RETENTION_DEFAULT) * 86400000;
}

// ── 시트 ──
function _svSS() {
  if (_svIo.ss) return _svIo.ss;
  var id = _svProps().getProperty(SV_SHEET_PROP);
  if (!id) throw new Error('설문 저장소가 아직 없습니다 — 편집기에서 survey_setup을 먼저 실행하세요.');
  _svIo.ss = SpreadsheetApp.openById(id);
  return _svIo.ss;
}
function _svSheet(key) {
  var sh = _svSS().getSheetByName(SV_TABS[key].name);
  if (!sh) throw new Error('설문 스프레드시트에 "' + SV_TABS[key].name + '" 탭이 없습니다 — survey_setup을 다시 실행하세요.');
  return sh;
}
function _svRead(key) {
  var sh = _svSheet(key), last = sh.getLastRow(), W = SV_TABS[key].headers.length;
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, W).getValues().map(function (r) { return r.map(_svStr); });
}
function _svWriteRows(key, startRow, rows) {
  if (!rows.length) return;
  var W = SV_TABS[key].headers.length;
  _svSheet(key).getRange(startRow, 1, rows.length, W).setValues(rows.map(function (r) {
    var o = [];
    for (var c = 0; c < W; c++) o.push(_svCell(r[c]));
    return o;
  }));
}
function _svAppend(key, row) { _svSheet(key).appendRow(row.map(_svCell)); }
function _svWithLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(SV_LOCK_WAIT_MS)) throw _svErr('BUSY', '지금 처리 중인 요청이 많습니다. 잠시 후 다시 시도해주세요.');
  try {
    var out = fn();
    SpreadsheetApp.flush();
    return out;
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}
// 처리기록 — 누가 언제 무엇을. 내용에는 건수·상태 같은 요약만(응답 내용은 적지 않는다)
function _svLog(who, surveyId, responseIds, action, detail) {
  _svAppend('actions', [_svNowStr(), String(who || ''), surveyId || '', String(responseIds || '').slice(0, 2000), action, String(detail || '').slice(0, 2000)]);
}

// ── 설문 정의 ──
function _svSurveyObj(r, i) {
  return {
    id: r[0], slug: r[1], oldSlugs: _svSplit(r[2]), title: r[3], status: SV_STATUSES.indexOf(r[4]) >= 0 ? r[4] : '초안',
    startAt: _svNormDt(r[5]), endAt: _svNormDt(r[6]), limit: _svPosInt(r[7]) || '', notice: _svJson(r[8], []), questions: _svJson(r[9], []),
    thanks: r[10], retentionDays: _svPosInt(r[11]) || SV_RETENTION_DEFAULT, updatedAt: r[12], updatedBy: r[13], createdAt: r[14],
    publishedAt: r[15], closedAt: r[16], row: i + 2
  };
}
function _svSurveyRow(s) {
  var notice = JSON.stringify(s.notice || []), qs = JSON.stringify(s.questions || []);
  if (notice.length > SV_CELL_MAX) throw new Error('상단 안내문이 너무 깁니다(' + notice.length + '자) — 줄여주세요.');
  if (qs.length > SV_CELL_MAX) throw new Error('질문 목록이 너무 깁니다(' + qs.length + '자) — 안내문 블록이나 보기를 줄여주세요.');
  return [s.id, s.slug, (s.oldSlugs || []).join(','), s.title, s.status, s.startAt, s.endAt, s.limit || '', notice, qs, s.thanks || '',
    s.retentionDays || SV_RETENTION_DEFAULT, s.updatedAt || '', s.updatedBy || '', s.createdAt || '', s.publishedAt || '', s.closedAt || ''];
}
// 목록 — 공개 페이지가 매번 시트를 읽지 않게 1분 캐시(설문을 저장하면 바로 비운다). fresh = 시트에서 다시
function _svSurveys(fresh) {
  var cache = CacheService.getScriptCache();
  if (!fresh) { var hit = _cacheGetJSON(cache, SV_CACHE_KEY); if (hit) return hit; }
  var list = _svRead('surveys').map(_svSurveyObj);
  _cachePutJSON(cache, SV_CACHE_KEY, list, SV_CACHE_TTL);
  return list;
}
function _svInvalidate() { try { CacheService.getScriptCache().remove(SV_CACHE_KEY + ':meta'); } catch (e) {} }
function _svById(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
function _svFind(id) {
  var s = _svById(_svSurveys(true), String(id || ''));
  if (!s) throw new Error('설문을 찾을 수 없습니다.');
  return s;
}
function _svActive(s) { return (s.questions || []).filter(function (q) { return !q.deleted; }); }
function _svQuestionMap(s) { var m = {}; (s.questions || []).forEach(function (q) { m[q.id] = q; }); return m; }
function _svPublicBase() {
  var cache = CacheService.getScriptCache(), hit = cache.get('survey:base');
  if (hit) return hit;
  var base = SV_BASE_DEFAULT;
  try {
    var id = _svProps().getProperty(OFFLINE_SHEET_ID_PROP);
    var sh = id ? SpreadsheetApp.openById(id).getSheetByName(OFF_TABS.settings.name) : null;
    if (sh) _offReadRows(sh, OFF_TABS.settings).forEach(function (r) {
      var v = String(r[1] == null ? '' : r[1]).trim().replace(/\/+$/, '');
      if (r[0] === SV_BASE_KEY && /^https?:\/\/[^\s/]+/.test(v)) base = v;
    });
  } catch (e) { Logger.log('[설문] 공개 기본 주소를 읽지 못해 기본값 사용: ' + e); }
  try { cache.put('survey:base', base, 300); } catch (e) {}
  return base;
}
function _svPublicUrl(base, slug) { return base + '/s/' + slug; }
function _svAdminView(s, base) {
  var o = {};
  Object.keys(s).forEach(function (k) { if (k !== 'row') o[k] = s[k]; });
  if (base) o.publicUrl = _svPublicUrl(base, s.slug);
  var due = _svPurgeDueMs(s);
  o.purgeDue = due == null ? '' : _svDateOf(due);
  return o;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 저장소 준비 (편집기에서 1회) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/* 편집기에서 직접 실행. 여러 번 실행해도 안전하다(있는 것은 그대로 쓰고 없는 것만 만든다).
   설문 폴더(공유 드라이브) 안에 스프레드시트 '미닉스 설문 응답'(탭 4개)과 하위 폴더 '영수증·첨부'를 만들고 ID를 Script Properties에 적는다.
   HMAC 키(SURVEY_HASH_SECRET), 오프라인 설정 탭의 설문_공개기본주소, 초기 설문(emart-oct, 초안)도 없을 때만 만든다. */
function survey_setup() {
  _svIo = { ss: null };
  var props = _svProps();
  var report = { folder: '', spreadsheet: null, filesFolder: null, tabs: { created: [], verified: [], extended: [], mismatched: [] }, secret: '', setting: '', seeded: '' };
  var folderId = props.getProperty(SV_FOLDER_PROP);
  if (!folderId) throw new Error('Script Properties에 ' + SV_FOLDER_PROP + '(설문 폴더 ID)를 먼저 등록하세요.');
  var folder = Drive.Files.get(folderId, { supportsAllDrives: true, fields: 'id,name,driveId,mimeType' });
  if (folder.mimeType !== SV_MIME_FOLDER) throw new Error(SV_FOLDER_PROP + '가 폴더가 아닙니다: ' + folder.name);
  report.folder = folder.name + (folder.driveId ? ' (공유 드라이브)' : ' (내 드라이브)');
  report.spreadsheet = _svEnsureItem(folder, SV_SHEET_PROP, SV_SS_NAME, SV_MIME_SHEET);
  report.filesFolder = _svEnsureItem(folder, SV_FILES_PROP, SV_FILES_NAME, SV_MIME_FOLDER);

  var ss = SpreadsheetApp.openById(report.spreadsheet.id);
  _svIo.ss = ss;
  SV_TAB_ORDER.forEach(function (key) {
    var def = SV_TABS[key], W = def.headers.length, sh = ss.getSheetByName(def.name);
    if (!sh) {
      sh = ss.insertSheet(def.name);
      sh.getRange(1, 1, 1, W).setValues([def.headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
      sh.getRange(1, 1, Math.max(sh.getMaxRows(), 2), W).setNumberFormat('@');
      report.tabs.created.push(def.name);
      return;
    }
    var actual = sh.getRange(1, 1, 1, W).getValues()[0].map(function (v) { return String(v || '').trim(); });
    var n = 0;
    while (n < W && actual[n] === def.headers[n]) n++;
    if (n === W) report.tabs.verified.push(def.name);
    else if (n > 0 && actual.slice(n).every(function (v) { return v === ''; })) {
      sh.getRange(1, n + 1, 1, W - n).setValues([def.headers.slice(n)]).setFontWeight('bold');
      sh.getRange(1, n + 1, Math.max(sh.getMaxRows(), 2), W - n).setNumberFormat('@');
      report.tabs.extended.push({ tab: def.name, added: def.headers.slice(n) });
    } else report.tabs.mismatched.push({ tab: def.name, expected: def.headers, actual: actual });
  });
  // 새 스프레드시트에 딸려 오는 빈 기본 시트(시트1)는 지운다 — 내용이 없을 때만
  ss.getSheets().forEach(function (sh) {
    if (/^(Sheet1|시트1)$/.test(sh.getName()) && sh.getLastRow() === 0 && ss.getSheets().length > SV_TAB_ORDER.length) ss.deleteSheet(sh);
  });
  if (report.tabs.mismatched.length) throw new Error('탭 머리글이 예상과 다릅니다 — ' + JSON.stringify(report.tabs.mismatched));

  if (!props.getProperty(SV_SECRET_PROP)) { props.setProperty(SV_SECRET_PROP, Utilities.getUuid() + Utilities.getUuid()); report.secret = 'created'; }
  else report.secret = 'exists';
  report.setting = _svEnsureBaseSetting();
  report.seeded = _svSeedEmart();
  _svInvalidate();
  Logger.log('[survey_setup] ' + JSON.stringify(report));
  return report;
}

// 폴더 안에서 이름·종류로 찾는다(하위 폴더 속은 아님) — 공유 드라이브면 그 드라이브 안에서
function _svDriveFind(folder, name, mime) {
  var opt = { q: "'" + folder.id + "' in parents and trashed = false and mimeType = '" + mime + "' and name = '" + name.replace(/'/g, "\\'") + "'",
    supportsAllDrives: true, includeItemsFromAllDrives: true, fields: 'files(id,name,mimeType)', pageSize: 10 };
  if (folder.driveId) { opt.corpora = 'drive'; opt.driveId = folder.driveId; } else opt.corpora = 'user';
  return (Drive.Files.list(opt).files || [])[0] || null;
}
// Script Properties에 적힌 ID가 살아 있으면 그대로, 아니면 폴더에서 이름으로 찾고, 그래도 없으면 만든다
function _svEnsureItem(folder, prop, name, mime) {
  var props = _svProps(), id = props.getProperty(prop);
  if (id) {
    try {
      var f = Drive.Files.get(id, { supportsAllDrives: true, fields: 'id,name,mimeType,trashed' });
      if (f && !f.trashed && f.mimeType === mime) return { id: id, status: 'exists' };
    } catch (e) { /* 지워졌거나 권한이 없다 — 아래에서 다시 찾는다 */ }
  }
  var hit = _svDriveFind(folder, name, mime);
  if (hit) { props.setProperty(prop, hit.id); return { id: hit.id, status: 'found' }; }
  var made = Drive.Files.create({ name: name, mimeType: mime, parents: [folder.id] }, null, { supportsAllDrives: true, fields: 'id' });
  props.setProperty(prop, made.id);
  return { id: made.id, status: 'created' };
}
// 오프라인 스프레드시트 설정 탭에 '설문_공개기본주소' — 없을 때만 덧붙인다(사람이 고친 값은 그대로)
function _svEnsureBaseSetting() {
  var id = _svProps().getProperty(OFFLINE_SHEET_ID_PROP);
  if (!id) return 'OFFLINE_SHEET_ID 없음 — 기본값(' + SV_BASE_DEFAULT + ')으로 동작';
  var sh = SpreadsheetApp.openById(id).getSheetByName(OFF_TABS.settings.name);
  if (!sh) return '설정 탭 없음 — offline_setupSheets 실행 뒤 survey_setup을 다시 실행하세요';
  var rows = _offReadRows(sh, OFF_TABS.settings);
  for (var i = 0; i < rows.length; i++) if (rows[i][0] === SV_BASE_KEY) return 'exists';
  _offWriteBlock(sh, OFF_TABS.settings, sh.getLastRow() + 1,
    [[SV_BASE_KEY, SV_BASE_DEFAULT, '설문 응답 페이지 링크·QR의 기본 주소 — 링크 = 이 주소 + /s/{설문 주소}']]);
  try { CacheService.getScriptCache().remove('survey:base'); } catch (e) {}
  return 'added';
}

// ── 초기 설문: [미닉스X이마트] 10월 사은품 이벤트 (초안 — 날짜는 사용자가 확인 후 입력) ──
function _svSeedEmart() {
  var list = _svRead('surveys').map(_svSurveyObj);
  if (list.some(function (s) { return s.slug === 'emart-oct' || s.oldSlugs.indexOf('emart-oct') >= 0; })) return 'exists';
  var now = _svNowStr();
  var s = _svSeedEmartSurvey();
  s.id = _svNewId(); s.createdAt = now; s.updatedAt = now; s.updatedBy = 'survey_setup';
  _svAppend('surveys', _svSurveyRow(s));
  _svLog('survey_setup', s.id, '', '설문 생성', '초기 설문(emart-oct, 초안)');
  return 'created';
}
function _svSeedEmartSurvey() {
  var T = function (text, styles) { return { type: 'text', text: text, styles: styles || {} }; };
  var B = function (type, content, props) { var b = { type: type, content: content }; if (props) b.props = props; return b; };
  var TODO = { bold: true, textColor: 'red', backgroundColor: 'yellow' };
  var notice = [
    B('heading', [T('🎁 미닉스 더 플렌더 구매 고객 사은품 이벤트')], { level: 2 }),
    B('paragraph', [T('이마트·트레이더스에서 '), T('미닉스 더 플렌더', { bold: true }), T('를 구매하고 영수증을 인증해주시면 '),
      T('리필전용 하드락 필터 1개(35,000원 상당)', { bold: true, underline: true }), T('를 보내드립니다.')]),
    B('bulletListItem', [T('대상 매장: 이마트 / 트레이더스 전국 지점')]),
    B('bulletListItem', [T('대상 제품: 더 플렌더 MAX')]),
    B('bulletListItem', [T('트레이더스: 10/1(목) ~ 10/31(토) 기간 한정 (더 플렌더 MAX)')]),
    B('heading', [T('참여 방법')], { level: 3 }),
    B('numberedListItem', [T('구매 영수증 촬영 📸')]),
    B('numberedListItem', [T('영수증 사진 업로드')]),
    B('numberedListItem', [T('성함·연락처·배송지 입력')]),
    B('heading', [T('안내')], { level: 3 }),
    B('bulletListItem', [T('참여 마감일: '), T('〔날짜 입력 필요〕', TODO)]),
    B('bulletListItem', [T('사은품 발송일: '), T('〔날짜 입력 필요〕', TODO)])
  ];
  var q = function (id, type, title, extra) { var o = { id: id, type: type, title: title, desc: '', required: false }; Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; }); return o; };
  return {
    slug: 'emart-oct', oldSlugs: [], title: '[미닉스X이마트] 10월 사은품 이벤트', status: '초안', startAt: '', endAt: '', limit: '',
    notice: notice, thanks: '이벤트에 참여해주셔서 감사합니다 ❤️', retentionDays: SV_RETENTION_DEFAULT, publishedAt: '', closedAt: '',
    questions: [
      q('q_consent', 'consent', '개인정보 수집·이용 동의', _svConsentDefaults()),
      q('q_receipt', 'file', '구매 영수증 사진', { required: true, desc: '구매 제품과 구매일이 보이게 촬영해주세요. (최대 3장)', maxFiles: 3, maxMB: SV_FILE_MB_DEFAULT }),
      q('q_model', 'checkbox', '구매하신 미닉스 제품', { required: true, style: 'list', options: ['더 플렌더 MAX', '더 플렌더 PLUS', '더 플렌더 mini'], allowOther: false }),
      q('q_reason', 'checkbox', '구매 결정 요인', { desc: '해당하는 항목을 모두 선택해주세요.', style: 'chips', allowOther: false,
        options: ['합리적인 가격', '이벤트·사은품', '친숙한 브랜드', '디자인(색상 등 보기에 예뻐서)', "사이즈(가로폭 '한 뼘'으로 공간 활용 좋아서)", "'건조 분쇄형' 방식으로 손쉬운 사용 및 처리"] }),
      q('q_known', 'checkbox', '알고 있는 미닉스 제품', { desc: '해당하는 항목을 모두 선택해주세요.', style: 'chips', allowOther: false,
        options: ['미닉스를 알지 못했다', '미닉스 미니건조기', '미닉스 식기세척기', "미닉스 음식물처리기 '더 플렌더'"] }),
      q('q_age', 'radio', '연령대', { style: 'list', options: ['18-24', '25-34', '35-44', '45-54', '55-64'], allowOther: true }),
      q('q_house', 'radio', '가구 형태', { style: 'list', options: ['1인 가구(학생)', '1인 가구(직장인)', '2인 가구(친구/연인/형제자매)', '3인 가구', '4인 가구 이상'], allowOther: true }),
      q('q_name', 'name', '성함', { required: true }),
      q('q_phone', 'phone', '연락처', { required: true, desc: '사은품 발송 안내에 사용됩니다.' }),
      q('q_addr', 'address', '배송지', { required: true, desc: '사은품을 받으실 주소를 입력해주세요.' })
    ]
  };
}
// 개인정보 수집·이용 동의 기본 문구 — 편집 화면의 [기본 문구]도 같은 값(프론트 survey-common.js SV_CONSENT_DEFAULT와 같게)
function _svConsentDefaults() {
  return { required: true, items: '성함, 연락처, 배송지 주소, 구매 영수증 사진', purpose: '이벤트 참여 확인 및 사은품 발송',
    period: '이벤트 마감 후 90일까지 보관 후 파기', refusal: '동의를 거부할 수 있으며, 거부 시 이벤트 참여 및 사은품 발송이 제한됩니다.',
    agreeLabel: '개인정보 수집·이용에 동의합니다.' };
}
function _svNewId() { return 'sv_' + _svRand(20); }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 공개 액션 (세션 없음) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// apps-script.js doPost가 세션 확인 전에 action === 'survey_getPublic' | 'survey_submit' 일 때만 부른다
function _surveyPublicHandle(action, data) {
  _svIo = { ss: null };
  try {
    if (action === 'survey_getPublic') return _json(_svGetPublic(data || {}));
    if (action === 'survey_submit') return _json(_svSubmit(data || {}));
    throw new Error('알 수 없는 공개 설문 액션');
  } catch (err) {
    // 메시지에는 응답 내용이 들어가지 않는다(검증 메시지는 항목 이름만)
    Logger.log('[설문 공개] action=' + action + ' / ' + ((err && err.svCode) || 'ERROR') + ' ' + (err && err.message));
    return _json(_svErrJson(err, action));
  }
}

// 폼 토큰 = 발급시각.서명 — 제출이 "페이지를 받은 뒤 몇 초 이상 지났는지"를 서버가 판정한다(브라우저가 시간을 속일 수 없다)
function _svFormToken(surveyId, now) { return now + '.' + _svHmac('form|' + surveyId + '|' + now).slice(0, 32); }
function _svCheckToken(surveyId, token, now) {
  var m = /^(\d{10,16})\.([0-9a-f]{32})$/.exec(String(token || ''));
  if (!m || !_constantTimeEquals(_svHmac('form|' + surveyId + '|' + m[1]).slice(0, 32), m[2])) throw _svErr('TOKEN', '페이지 정보가 올바르지 않습니다. 새로고침 후 다시 제출해주세요.');
  var age = now - Number(m[1]);
  if (age < SV_MIN_FILL_MS) throw _svErr('TOO_FAST', '너무 빨리 제출되었습니다. 잠시 후 다시 제출해주세요.');
  if (age > SV_TOKEN_MAX_AGE_MS) throw _svErr('EXPIRED', '페이지를 연 지 오래되었습니다. 새로고침 후 다시 제출해주세요.');
}
function _svPublicView(s) {
  return { id: s.id, slug: s.slug, title: s.title, notice: s.notice || [], questions: _svActive(s), thanks: s.thanks || '' };
}
function _svCount(surveyId) {
  var sh = _svSheet('responses'), last = sh.getLastRow();
  if (last < 2) return 0;
  var n = 0;
  sh.getRange(2, SV_R.survey + 1, last - 1, 1).getValues().forEach(function (r) { if (String(r[0]) === surveyId) n++; });
  return n;
}

/* 주소(slug) 또는 설문ID로 게시 중인 설문의 표시용 정보만 — 응답·관리 정보(상태 이력·수정자·제한 수 등)는 주지 않는다.
   초안·없는 주소·기간 밖·응답 수 초과는 모두 closed(게시했던 설문이면 제목만). 이전 주소로 오면 지금 주소를 slug로 같이 준다. */
function _svGetPublic(d) {
  var slug = String(d.slug || '').trim().toLowerCase(), id = String(d.id || '').trim();
  var list = _svSurveys(false), s = null;
  if (id) s = _svById(list, id);
  else if (/^[a-z0-9-]{3,40}$/.test(slug)) {
    for (var i = 0; i < list.length && !s; i++) if (list[i].slug === slug) s = list[i];
    for (var j = 0; j < list.length && !s; j++) if (list[j].oldSlugs.indexOf(slug) >= 0) s = list[j];
  }
  if (!s || s.status === '초안') return { success: true, closed: true };
  var now = Date.now();
  if (!_svIsOpen(s, now) || (s.limit && _svCount(s.id) >= s.limit)) return { success: true, closed: true, title: s.title, slug: s.slug };
  return { success: true, survey: _svPublicView(s), slug: s.slug, token: _svFormToken(s.id, now) };
}

/* 제출 — 답변 + 브라우저에서 압축한 사진(base64)
   data = { surveyId, token, hp(함정 칸), sid(제출 키 — 재시도해도 한 번만 저장), answers: {질문ID: 값}, files: [{q, data(base64)}] }
   순서: 함정 칸 → 게시·기간 → 토큰(최소 시간) → 이미 저장한 제출 키 → 분당 제한 → 검증 → 사진 저장(락 밖) → 락 안에서 응답 수 확인·행 추가 */
function _svSubmit(d) {
  if (String(d.hp || '').trim()) throw _svErr('REJECTED', '제출할 수 없습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.');
  var now = Date.now();
  var s = _svById(_svSurveys(false), String(d.surveyId || ''));
  if (!s || !_svIsOpen(s, now)) throw _svErr('CLOSED', '마감되었습니다.');
  _svCheckToken(s.id, d.token, now);
  var cache = CacheService.getScriptCache();
  var sid = String(d.sid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  var subKey = sid ? 'survey:sub:' + s.id + ':' + sid : '';
  if (subKey && cache.get(subKey)) return { success: true, thanks: s.thanks || '', duplicate: true };
  var rateKey = 'survey:rate:' + s.id + ':' + Math.floor(now / 60000), sent = Number(cache.get(rateKey) || 0);
  if (sent >= SV_RATE_PER_MIN) throw _svErr('RATE', '지금 제출이 많습니다. 1분 뒤 다시 제출해주세요.');
  cache.put(rateKey, String(sent + 1), 120);

  var qs = _svActive(s);
  var ans = _svCleanAnswers(qs, d.answers && typeof d.answers === 'object' ? d.answers : {});
  var fl = _svCheckFiles(qs, d.files);
  Object.keys(fl.errors).forEach(function (k) { ans.errors[k] = fl.errors[k]; });
  if (Object.keys(ans.errors).length) throw _svErr('INVALID', '입력 내용을 확인해주세요.', { fields: ans.errors });
  Object.keys(fl.counts).forEach(function (k) { ans.clean[k] = fl.counts[k]; });

  var rid = 'r_' + _svRand(16);
  var dup = _svDupKey(s.id, qs, ans.clean);
  var saved = _svSaveFiles(s.id, rid, fl.files);
  try {
    var out = _svWithLock(function () {
      if (subKey && cache.get(subKey)) return { success: true, thanks: s.thanks || '', duplicate: true };
      var cur = _svById(_svSurveys(false), s.id);
      if (!cur || !_svIsOpen(cur, Date.now()) || (cur.limit && _svCount(cur.id) >= cur.limit)) throw _svErr('CLOSED', '마감되었습니다.');
      _svAppend('responses', [rid, s.id, _svNowStr(now), JSON.stringify(ans.clean), JSON.stringify(saved), dup, '대기', '', '', '']);
      if (subKey) cache.put(subKey, rid, 21600);
      return { success: true, thanks: cur.thanks || '' };
    });
    if (out.duplicate) _svDeleteFiles(saved);
    return out;
  } catch (e) {
    _svDeleteFiles(saved);
    throw e;
  }
}

/* 답변 검증·정리 — 알려진 질문만, 유형별 형식. errors = {질문ID: 안내 문구}(값은 담지 않는다)
   값 모양: 동의 true · 선택형 {sel: [보기], other?: '직접 입력'} · 척도 숫자 · 주소 {zip, addr1, addr2} · 나머지 문자열 · 파일은 장수(서버가 채운다) */
function _svCleanAnswers(qs, input) {
  var clean = {}, errors = {};
  qs.forEach(function (q) {
    var t = q.type, v = input[q.id], req = !!q.required;
    if (t === 'notice' || t === 'file') return;
    if (t === 'consent') {
      if (v === true) clean[q.id] = true;
      else if (req) errors[q.id] = '개인정보 수집·이용에 동의해주세요.';
      return;
    }
    if (SV_CHOICE[t]) {
      var o = v && typeof v === 'object' ? v : {}, sel = Array.isArray(o.sel) ? o.sel : [], opts = q.options || [], picked = [];
      sel.forEach(function (x) { var s = String(x); if (opts.indexOf(s) >= 0 && picked.indexOf(s) < 0) picked.push(s); });
      if (picked.length !== sel.length) { errors[q.id] = '보기가 바뀌었습니다. 새로고침 후 다시 선택해주세요.'; return; }
      var other = q.allowOther && o.other != null ? _svText(o.other, 200) : null;
      if (other === '') { errors[q.id] = '기타 내용을 입력해주세요.'; return; }
      if (t !== 'checkbox' && picked.length + (other != null ? 1 : 0) > 1) { errors[q.id] = '하나만 선택해주세요.'; return; }
      if (!picked.length && other == null) { if (req) errors[q.id] = '선택해주세요.'; return; }
      clean[q.id] = other != null ? { sel: picked, other: other } : { sel: picked };
      return;
    }
    if (t === 'scale') {
      if (v === '' || v == null) { if (req) errors[q.id] = '점수를 선택해주세요.'; return; }
      var n = Number(v);
      if (!(n >= 1 && n <= 5 && n === Math.round(n))) { errors[q.id] = '1~5 중에서 선택해주세요.'; return; }
      clean[q.id] = n;
      return;
    }
    if (t === 'address') {
      var a = v && typeof v === 'object' ? v : {}, zip = _svText(a.zip, 10), a1 = _svText(a.addr1, 200), a2 = _svText(a.addr2, 100);
      if (!zip && !a1 && !a2) { if (req) errors[q.id] = '주소를 입력해주세요.'; return; }
      if (!/^\d{5}$/.test(zip) || !a1) { errors[q.id] = '주소 검색으로 우편번호와 기본주소를 입력해주세요.'; return; }
      if (!a2) { errors[q.id] = '상세주소를 입력해주세요.'; return; }
      clean[q.id] = { zip: zip, addr1: a1, addr2: a2 };
      return;
    }
    var max = t === 'long' ? 5000 : t === 'name' ? 50 : 500;
    var s = _svText(v, max + 1);
    if (!s) { if (req) errors[q.id] = t === 'name' ? '성함을 입력해주세요.' : t === 'phone' ? '연락처를 입력해주세요.' : t === 'date' ? '날짜를 선택해주세요.' : '입력해주세요.'; return; }
    if (s.length > max) { errors[q.id] = max + '자 이내로 입력해주세요.'; return; }
    if (t === 'phone') { s = _svFormatPhone(s); if (!s) { errors[q.id] = '010-0000-0000 형식으로 입력해주세요.'; return; } }
    if (t === 'date' && !_svValidDate(s)) { errors[q.id] = '날짜 형식이 올바르지 않습니다.'; return; }
    clean[q.id] = s;
  });
  return { clean: clean, errors: errors };
}
// 숫자만 남겨 010-1234-5678(또는 010-123-4567)로 — 휴대전화 번호가 아니면 ''
function _svFormatPhone(s) {
  var d = String(s || '').replace(/\D/g, '');
  if (!/^01[016789]\d{7,8}$/.test(d)) return '';
  return d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6) : d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
}
function _svValidDate(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  var dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return dt.getUTCFullYear() === +m[1] && dt.getUTCMonth() === +m[2] - 1 && dt.getUTCDate() === +m[3];
}
// 파일 앞 바이트로 형식을 판정(브라우저가 보낸 이름·형식은 믿지 않는다). 이미지가 아니면 null
function _svSniff(bytes) {
  var b = function (i) { return (bytes[i] + 256) % 256; };
  if (bytes.length < 12) return null;
  if (b(0) === 0xFF && b(1) === 0xD8 && b(2) === 0xFF) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4E && b(3) === 0x47) return { mime: 'image/png', ext: 'png' };
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45 && b(10) === 0x42 && b(11) === 0x50) return { mime: 'image/webp', ext: 'webp' };
  if (b(4) === 0x66 && b(5) === 0x74 && b(6) === 0x79 && b(7) === 0x70) {
    var brand = String.fromCharCode(b(8), b(9), b(10), b(11));
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return { mime: 'image/heic', ext: 'heic' };
    if (brand === 'avif') return { mime: 'image/avif', ext: 'avif' };
  }
  return null;
}
// 사진 검증 — 질문별 장수·장당 용량·형식, 제출 합계. 통과한 파일(바이트)과 질문별 장수
function _svCheckFiles(qs, files) {
  var errors = {}, out = [], counts = {}, total = 0, byQ = {}, fq = {};
  qs.forEach(function (q) { if (q.type === 'file') fq[q.id] = q; });
  (Array.isArray(files) ? files : []).slice(0, 40).forEach(function (f) {
    if (f && fq[f.q]) (byQ[f.q] = byQ[f.q] || []).push(f);
  });
  Object.keys(fq).forEach(function (qid) {
    var q = fq[qid], list = byQ[qid] || [], max = _svPosInt(q.maxFiles) || 3, mb = _svPosInt(q.maxMB) || SV_FILE_MB_DEFAULT;
    if (!list.length) { if (q.required) errors[qid] = '사진을 1장 이상 올려주세요.'; return; }
    if (list.length > max) { errors[qid] = '사진은 최대 ' + max + '장까지 올릴 수 있습니다.'; return; }
    var got = [];
    for (var i = 0; i < list.length; i++) {
      var bytes;
      try { bytes = Utilities.base64Decode(String(list[i].data || '')); } catch (e) { bytes = []; }
      if (!bytes.length) { errors[qid] = '사진 파일을 읽지 못했습니다. 다시 선택해주세요.'; return; }
      if (bytes.length > mb * 1048576) { errors[qid] = '사진 한 장은 ' + mb + 'MB 이하만 올릴 수 있습니다.'; return; }
      var kind = _svSniff(bytes);
      if (!kind) { errors[qid] = '이미지 파일(JPG·PNG·HEIC 등)만 올릴 수 있습니다.'; return; }
      got.push({ q: qid, bytes: bytes, mime: kind.mime, ext: kind.ext, size: bytes.length });
    }
    got.forEach(function (g) { total += g.size; out.push(g); });
    counts[qid] = got.length;
  });
  if (total > SV_TOTAL_MAX_BYTES) {
    var first = Object.keys(fq)[0];
    errors[first] = '사진 용량 합계가 너무 큽니다(30MB 이하로 올려주세요).';
  }
  return { files: out, errors: errors, counts: counts };
}
// 중복키 — 첫 전화번호 질문의 숫자만 HMAC(설문마다 다른 값). 번호 자체는 시트에 다시 쓰지 않는다
function _svDupKey(surveyId, qs, clean) {
  for (var i = 0; i < qs.length; i++) {
    if (qs[i].type === 'phone' && clean[qs[i].id]) return _svHmac('dup|' + surveyId + '|' + String(clean[qs[i].id]).replace(/\D/g, '')).slice(0, 32);
  }
  return '';
}
// 영수증·첨부 폴더에 저장 — 공유 설정은 건드리지 않는다(링크 공유 없음). 파일명에 개인정보를 넣지 않는다
function _svSaveFiles(surveyId, rid, files) {
  if (!files.length) return [];
  var folderId = _svProps().getProperty(SV_FILES_PROP);
  if (!folderId) throw _svErr('SETUP', '사진 저장소가 아직 없습니다. 담당자에게 문의해주세요.');
  var out = [];
  try {
    files.forEach(function (f, i) {
      var name = surveyId + '_' + rid + '_' + (i + 1) + '.' + f.ext;
      var made = Drive.Files.create({ name: name, parents: [folderId], mimeType: f.mime }, Utilities.newBlob(f.bytes, f.mime, name),
        { supportsAllDrives: true, fields: 'id' });
      out.push({ q: f.q, id: made.id, type: f.mime, size: f.size });
    });
  } catch (e) {
    Logger.log('[설문] 사진 저장 실패: ' + e);
    _svDeleteFiles(out);
    throw _svErr('UPLOAD', '사진을 저장하지 못했습니다. 잠시 후 다시 제출해주세요.');
  }
  return out;
}
// 파일 삭제 — 영구 삭제, 권한이 없으면(공유 드라이브 관리자 아님) 휴지통. 실패한 파일 ID 목록
function _svDeleteFiles(list) {
  var failed = [];
  (list || []).forEach(function (f) {
    try { Drive.Files.remove(f.id, { supportsAllDrives: true }); }
    catch (e) {
      try { Drive.Files.update({ trashed: true }, f.id, null, { supportsAllDrives: true, fields: 'id' }); }
      catch (e2) { failed.push(f.id); }
    }
  });
  return failed;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 관리 액션 (세션 필수 — doPost가 확인한 뒤 온다) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _surveyHandle(action, data, auth) {
  _svIo = { ss: null };
  try {
    var d = data || {}, out;
    if (action === 'survey_list') out = _svList();
    else if (action === 'survey_get') out = _svGet(d);
    else if (action === 'survey_save') out = _svSave(d, auth);
    else if (action === 'survey_setStatus') out = _svSetStatus(d, auth);
    else if (action === 'survey_duplicate') out = _svDuplicate(d, auth);
    else if (action === 'survey_responses') out = _svResponses(d);
    else if (action === 'survey_revealPii') out = _svRevealPii(d, auth);
    else if (action === 'survey_export') out = _svExport(d, auth);
    else if (action === 'survey_images') out = _svImages(d);
    else if (action === 'survey_updateResponses') out = _svUpdateResponses(d, auth);
    else throw new Error('알 수 없는 설문 액션: ' + action);
    return _json(out);
  } catch (err) {
    Logger.log('[설문 실패] action=' + action + ' / ' + ((err && err.svCode) || '') + ' ' + (err && err.message));
    return _json(_svErrJson(err, action));
  }
}

// 응답 행을 설문별로 — {설문ID: {count, lastAt, purged, rows[]}}
function _svResponseIndex(rows) {
  var by = {};
  rows.forEach(function (r) {
    var x = by[r[SV_R.survey]] = by[r[SV_R.survey]] || { count: 0, lastAt: '', purged: 0, rows: [] };
    x.count++; x.rows.push(r);
    if (r[SV_R.at] > x.lastAt) x.lastAt = r[SV_R.at];
    if (r[SV_R.purgedAt]) x.purged++;
  });
  return by;
}

function _svList() {
  var base = _svPublicBase(), now = Date.now(), by = _svResponseIndex(_svRead('responses'));
  var items = _svSurveys(true).map(function (s) {
    var v = _svAdminView(s, base), st = by[s.id] || { count: 0, lastAt: '', purged: 0 };
    delete v.notice; delete v.questions;
    v.responses = st.count; v.lastAt = st.lastAt; v.purged = st.purged; v.open = _svIsOpen(s, now);
    v.questionCount = _svActive(s).filter(function (q) { return q.type !== 'notice'; }).length;
    return v;
  });
  return { success: true, publicBase: base, items: items };
}

// 질문별 답변 수 — 유형 변경·삭제 경고용
function _svAnswered(rows) {
  var n = {};
  rows.forEach(function (r) {
    var a = _svJson(r[SV_R.answers], {});
    Object.keys(a).forEach(function (k) { n[k] = (n[k] || 0) + 1; });
  });
  return n;
}

function _svGet(d) {
  var s = _svFind(d.id), base = _svPublicBase();
  var rows = _svRead('responses').filter(function (r) { return r[SV_R.survey] === s.id; });
  return { success: true, publicBase: base, survey: _svAdminView(s, base), responses: rows.length, answered: _svAnswered(rows) };
}

// 주소(slug) — 영문 소문자·숫자·하이픈 3~40자, 다른 설문의 지금 주소·이전 주소와 겹치지 않게
function _svCheckSlug(slug, list, selfId) {
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) throw _svErr('SLUG', '설문 주소는 영문 소문자·숫자·하이픈(-) 3~40자로 정해주세요.');
  list.forEach(function (o) {
    if (o.id === selfId) return;
    if (o.slug === slug) throw _svErr('SLUG', "'" + slug + "' 주소는 다른 설문(" + o.title + ')이 쓰고 있습니다.');
    if (o.oldSlugs.indexOf(slug) >= 0) throw _svErr('SLUG', "'" + slug + "' 주소는 다른 설문(" + o.title + ')의 이전 주소라 쓸 수 없습니다(이미 배포한 링크가 그 설문으로 이동합니다).');
  });
}
function _svFreeSlug(list) {
  for (var i = 0; i < 20; i++) {
    var s = _svRand(8);
    if (!list.some(function (o) { return o.slug === s || o.oldSlugs.indexOf(s) >= 0; })) return s;
  }
  throw new Error('빈 주소를 만들지 못했습니다 — 주소를 직접 정해주세요.');
}

// ── 안내문 블록(BlockNote JSON) 정리 — 허용한 블록·서식만 남긴다(응답 페이지 렌더러와 같은 목록) ──
function _svCleanBlocks(blocks, depth) {
  depth = depth || 0;
  if (!Array.isArray(blocks) || depth > 3) return [];
  var out = [];
  blocks.slice(0, 300).forEach(function (b) {
    if (!b || !SV_BLOCK_TYPES[b.type]) return;
    var o = { type: b.type, content: _svCleanInline(b.content) };
    var p = b.props || {}, props = {};
    if (b.type === 'heading') props.level = [1, 2, 3].indexOf(Number(p.level)) >= 0 ? Number(p.level) : 2;
    if (p.textColor && p.textColor !== 'default' && SV_COLORS[p.textColor]) props.textColor = p.textColor;
    if (p.backgroundColor && p.backgroundColor !== 'default' && SV_COLORS[p.backgroundColor]) props.backgroundColor = p.backgroundColor;
    if (p.textAlignment === 'center' || p.textAlignment === 'right') props.textAlignment = p.textAlignment;
    if (Object.keys(props).length) o.props = props;
    var kids = _svCleanBlocks(b.children, depth + 1);
    if (kids.length) o.children = kids;
    out.push(o);
  });
  return out;
}
function _svCleanInline(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content.slice(0, 5000), styles: {} }] : [];
  if (!Array.isArray(content)) return [];
  var out = [];
  content.slice(0, 500).forEach(function (c) {
    if (!c) return;
    if (c.type === 'text' && typeof c.text === 'string' && c.text) out.push({ type: 'text', text: c.text.slice(0, 5000), styles: _svCleanStyles(c.styles) });
    else if (c.type === 'link' && /^https?:\/\//i.test(String(c.href || ''))) {
      var inner = _svCleanInline(c.content);
      if (inner.length) out.push({ type: 'link', href: String(c.href).slice(0, 1000), content: inner });
    }
  });
  return out;
}
function _svCleanStyles(st) {
  var o = {};
  if (!st) return o;
  ['bold', 'italic', 'underline', 'strike', 'code'].forEach(function (k) { if (st[k] === true) o[k] = true; });
  if (st.textColor && st.textColor !== 'default' && SV_COLORS[st.textColor]) o.textColor = st.textColor;
  if (st.backgroundColor && st.backgroundColor !== 'default' && SV_COLORS[st.backgroundColor]) o.backgroundColor = st.backgroundColor;
  return o;
}

// ── 질문 정리 — 알려진 유형·설정만. 삭제(보관)된 질문은 여기로 오지 않는다(_svSave가 이전 정의에서 다시 붙인다) ──
function _svCleanQuestions(list) {
  if (!Array.isArray(list)) throw new Error('질문 목록 형식이 올바르지 않습니다.');
  if (list.length > 100) throw new Error('질문은 100개까지 만들 수 있습니다.');
  var seen = {}, out = [];
  list.forEach(function (q, i) {
    if (!q || q.deleted) return;
    var no = (i + 1) + '번째 질문';
    if (SV_TYPES.indexOf(q.type) < 0) throw new Error(no + ': 알 수 없는 유형입니다(' + q.type + ').');
    var id = String(q.id || '');
    if (!/^q_[a-z0-9_]{2,30}$/.test(id)) throw new Error(no + ': 질문 ID 형식이 올바르지 않습니다.');
    if (seen[id]) throw new Error(no + ': 질문 ID가 겹칩니다(' + id + ').');
    seen[id] = true;
    var o = { id: id, type: q.type, title: _svText(q.title, 300), desc: _svText(q.desc, 1000), required: q.required === true };
    if (q.type !== 'notice' && !o.title) throw new Error(no + ': 질문 제목을 입력해주세요.');
    if (q.type === 'notice') { o.blocks = _svCleanBlocks(q.blocks); o.required = false; }
    else if (q.type === 'consent') {
      var dft = _svConsentDefaults();
      ['items', 'purpose', 'period', 'refusal'].forEach(function (k) { o[k] = _svText(q[k] != null ? q[k] : dft[k], 1000); });
      o.agreeLabel = _svText(q.agreeLabel, 200) || dft.agreeLabel;
      o.required = true; // 동의는 항상 필수
    } else if (q.type === 'file') {
      o.maxFiles = Math.min(10, _svPosInt(q.maxFiles) || 3);
      o.maxMB = Math.min(10, _svPosInt(q.maxMB) || SV_FILE_MB_DEFAULT);
    } else if (SV_CHOICE[q.type]) {
      var opts = [];
      (Array.isArray(q.options) ? q.options : []).forEach(function (x) {
        var t = _svText(x, 200);
        if (!t) return;
        if (opts.indexOf(t) >= 0) throw new Error(no + ' (' + o.title + "): 보기 '" + t + "'가 두 번 있습니다.");
        opts.push(t);
      });
      if (!opts.length) throw new Error(no + ' (' + o.title + '): 보기를 하나 이상 입력해주세요.');
      if (opts.length > 50) throw new Error(no + ' (' + o.title + '): 보기는 50개까지입니다.');
      o.options = opts;
      o.allowOther = q.allowOther === true;
      if (q.type !== 'dropdown') o.style = q.style === 'chips' ? 'chips' : 'list';
    } else if (q.type === 'scale') {
      o.minLabel = _svText(q.minLabel, 50); o.maxLabel = _svText(q.maxLabel, 50);
    }
    out.push(o);
  });
  return out;
}
function _svNewQid(taken) {
  for (;;) { var id = 'q_' + _svRand(8); if (!taken[id]) { taken[id] = true; return id; } }
}

function _svApplyStatus(s, status, nowStr) {
  if (SV_STATUSES.indexOf(status) < 0) throw new Error('상태는 초안·게시·마감 중 하나입니다.');
  if (status === '게시' && !_svActive(s).some(function (q) { return q.type !== 'notice'; })) throw new Error('질문이 하나도 없는 설문은 게시할 수 없습니다.');
  if (status === '게시' && !s.publishedAt) s.publishedAt = nowStr;
  if (status === '마감' && s.status !== '마감') s.closedAt = nowStr;
  if (status !== '마감') s.closedAt = '';
  s.status = status;
}

/* 저장(새로 만들기·수정) — data = { survey, baseUpdatedAt(열 때 받은 수정일), force(다른 사람 수정을 덮어씀) }
   · 게시한 적 있는 설문의 주소를 바꾸면 옛 주소를 이전주소에 남긴다(배포한 링크·QR이 새 주소로 이동)
   · 질문 ID는 그대로 — 문구·보기를 바꿔도 기존 답변이 그 질문에 남는다
   · 빠진 질문 중 답변이 있는 것과 이미 보관된 질문은 deleted로 뒤에 남긴다 → 결과·엑셀에 '(삭제된 질문)' 열
   · 답이 있는 질문의 유형을 답 모양이 다른 유형으로 바꾸면 새 ID로 바꾸고 옛 질문은 보관한다(옛 답변이 새 형식으로 잘못 읽히지 않게) */
function _svSave(d, auth) {
  var input = d.survey || {};
  return _svWithLock(function () {
    var list = _svRead('surveys').map(_svSurveyObj);
    var cur = input.id ? _svById(list, String(input.id)) : null;
    if (input.id && !cur) throw new Error('설문을 찾을 수 없습니다(삭제되었을 수 있습니다).');
    if (cur && d.baseUpdatedAt != null && d.baseUpdatedAt !== cur.updatedAt && !d.force) {
      throw _svErr('CONFLICT', (cur.updatedBy || '다른 사람') + '님이 ' + cur.updatedAt + '에 이 설문을 먼저 수정했습니다.', { updatedBy: cur.updatedBy, updatedAt: cur.updatedAt });
    }
    var nowStr = _svNowStr();
    var s = cur ? JSON.parse(JSON.stringify(cur)) : { id: _svNewId(), oldSlugs: [], status: '초안', createdAt: nowStr, publishedAt: '', closedAt: '' };
    s.title = _svText(input.title, 200);
    if (!s.title) throw new Error('설문 제목을 입력해주세요.');
    var slug = String(input.slug == null ? '' : input.slug).trim().toLowerCase() || (cur ? cur.slug : _svFreeSlug(list));
    _svCheckSlug(slug, list, s.id);
    var moved = '';
    if (cur && cur.slug !== slug && cur.publishedAt) {
      if (s.oldSlugs.indexOf(cur.slug) < 0) s.oldSlugs.push(cur.slug);
      moved = cur.slug;
    }
    s.oldSlugs = s.oldSlugs.filter(function (x) { return x !== slug; });
    s.slug = slug;
    s.startAt = _svNormDt(input.startAt); s.endAt = _svNormDt(input.endAt);
    if (String(input.startAt || '').trim() && !s.startAt) throw new Error('시작일시 형식이 올바르지 않습니다.');
    if (String(input.endAt || '').trim() && !s.endAt) throw new Error('마감일시 형식이 올바르지 않습니다.');
    if (s.startAt && s.endAt && _svParseKst(s.endAt) <= _svParseKst(s.startAt)) throw new Error('마감일시는 시작일시보다 뒤여야 합니다.');
    if (input.limit === '' || input.limit == null) s.limit = '';
    else { s.limit = _svPosInt(input.limit); if (!s.limit || s.limit > 100000) throw new Error('응답 수 제한은 1 이상의 정수로 입력해주세요(비우면 제한 없음).'); }
    var keep = input.retentionDays === '' || input.retentionDays == null ? SV_RETENTION_DEFAULT : _svPosInt(input.retentionDays);
    if (!keep || keep > 3650) throw new Error('개인정보 보유기간은 1~3650일로 입력해주세요.');
    s.retentionDays = keep;
    s.thanks = _svText(input.thanks, 500);
    s.notice = _svCleanBlocks(input.notice);

    var qs = _svCleanQuestions(input.questions || []);
    var answered = cur ? _svAnswered(_svRead('responses').filter(function (r) { return r[SV_R.survey] === cur.id; })) : {};
    if (cur) {
      var old = _svQuestionMap(cur), taken = {};
      cur.questions.forEach(function (q) { taken[q.id] = true; });
      qs.forEach(function (q) { taken[q.id] = true; });
      qs = qs.map(function (q) {
        var o = old[q.id];
        if (o && !o.deleted && o.type !== q.type && answered[q.id] && (!SV_SHAPE[o.type] || SV_SHAPE[o.type] !== SV_SHAPE[q.type])) {
          var n = JSON.parse(JSON.stringify(q)); n.id = _svNewQid(taken); return n;
        }
        return q;
      });
      var active = {};
      qs.forEach(function (q) { active[q.id] = true; });
      cur.questions.forEach(function (q) {
        if (active[q.id]) return;
        if (q.deleted || answered[q.id]) { var a = JSON.parse(JSON.stringify(q)); a.deleted = true; qs.push(a); active[q.id] = true; }
      });
    }
    s.questions = qs;
    _svApplyStatus(s, input.status == null ? s.status : String(input.status), nowStr);
    s.updatedAt = nowStr; s.updatedBy = (auth && auth.email) || '';
    var row = _svSurveyRow(s);
    if (cur) _svWriteRows('surveys', cur.row, [row]); else _svAppend('surveys', row);
    _svLog(s.updatedBy, s.id, '', cur ? '설문 수정' : '설문 생성',
      '상태 ' + s.status + ' · 주소 ' + s.slug + (moved ? ' (이전 주소 ' + moved + ')' : '') + ' · 질문 ' + _svActive(s).length + '개');
    _svInvalidate();
    var base = _svPublicBase();
    return { success: true, survey: _svAdminView(s, base), movedFrom: moved, answered: answered };
  });
}

function _svSetStatus(d, auth) {
  return _svWithLock(function () {
    var list = _svRead('surveys').map(_svSurveyObj), s = _svById(list, String(d.id || ''));
    if (!s) throw new Error('설문을 찾을 수 없습니다.');
    var before = s.status, nowStr = _svNowStr();
    _svApplyStatus(s, String(d.status || ''), nowStr);
    s.updatedAt = nowStr; s.updatedBy = (auth && auth.email) || '';
    _svWriteRows('surveys', s.row, [_svSurveyRow(s)]);
    _svLog(s.updatedBy, s.id, '', '상태 변경', before + ' → ' + s.status);
    _svInvalidate();
    return { success: true, survey: _svAdminView(s, _svPublicBase()) };
  });
}

// 복제 — 다음 달 이벤트 재사용. 질문·안내문·감사 문구·보유기간·응답 수 제한은 그대로, 기간·응답은 비우고 초안으로. 주소는 새로(비우면 무작위)
function _svDuplicate(d, auth) {
  return _svWithLock(function () {
    var list = _svRead('surveys').map(_svSurveyObj), src = _svById(list, String(d.id || ''));
    if (!src) throw new Error('설문을 찾을 수 없습니다.');
    var slug = String(d.slug || '').trim().toLowerCase() || _svFreeSlug(list);
    var nowStr = _svNowStr(), s = {
      id: _svNewId(), slug: '', oldSlugs: [], title: ('(복사) ' + src.title).slice(0, 200), status: '초안', startAt: '', endAt: '', limit: src.limit,
      notice: src.notice, questions: _svActive(src), thanks: src.thanks, retentionDays: src.retentionDays,
      updatedAt: nowStr, updatedBy: (auth && auth.email) || '', createdAt: nowStr, publishedAt: '', closedAt: ''
    };
    _svCheckSlug(slug, list, s.id);
    s.slug = slug;
    _svAppend('surveys', _svSurveyRow(s));
    _svLog(s.updatedBy, s.id, '', '설문 복제', '원본 ' + src.id + ' (' + src.slug + ')');
    _svInvalidate();
    return { success: true, survey: _svAdminView(s, _svPublicBase()) };
  });
}

// ── 결과 ──
function _svMaskName(v) {
  var s = String(v || '');
  if (s.length <= 1) return s ? '*' : '';
  if (s.length === 2) return s.charAt(0) + '*';
  return s.charAt(0) + new Array(s.length - 1).join('*') + s.charAt(s.length - 1);
}
function _svMaskPhone(v) {
  var p = String(v || '').split('-');
  return p.length === 3 ? p[0] + '-' + p[1].replace(/./g, '*') + '-' + p[2] : String(v || '').replace(/\d(?=\d{4})/g, '*');
}
function _svMaskAddr(v) {
  var a = v || {}, parts = String(a.addr1 || '').split(/\s+/).filter(function (x) { return x; });
  return { zip: a.zip ? '*****' : '', addr1: parts.slice(0, 2).join(' ') + (parts.length > 2 ? ' ***' : ''), addr2: a.addr2 ? '***' : '' };
}
function _svMaskAnswers(qmap, a) {
  var o = {};
  Object.keys(a).forEach(function (k) {
    var q = qmap[k], t = q && q.type;
    o[k] = t === 'name' ? _svMaskName(a[k]) : t === 'phone' ? _svMaskPhone(a[k]) : t === 'address' ? _svMaskAddr(a[k]) : a[k];
  });
  return o;
}
function _svRespItem(r, qmap, dupCount, raw) {
  var a = _svJson(r[SV_R.answers], {}), dk = r[SV_R.dup];
  return {
    id: r[SV_R.id], at: r[SV_R.at], answers: raw ? a : _svMaskAnswers(qmap, a),
    files: _svJson(r[SV_R.files], []).map(function (f) { return { id: f.id, q: f.q, type: f.type, size: f.size }; }),
    dup: !!(dk && dupCount[dk] > 1), status: SV_RESP_STATUSES.indexOf(r[SV_R.status]) >= 0 ? r[SV_R.status] : '대기',
    memo: r[SV_R.memo], reason: r[SV_R.reason], purgedAt: r[SV_R.purgedAt]
  };
}
function _svSurveyRows(surveyId) {
  var rows = _svRead('responses').filter(function (r) { return r[SV_R.survey] === surveyId; }), dupCount = {};
  rows.forEach(function (r) { if (r[SV_R.dup]) dupCount[r[SV_R.dup]] = (dupCount[r[SV_R.dup]] || 0) + 1; });
  return { rows: rows, dupCount: dupCount };
}
// 응답 목록 — 이름·연락처·주소는 마스킹해서 준다(전체 값은 survey_revealPii · survey_export로만, 기록이 남는다)
function _svResponses(d) {
  var s = _svFind(d.id), base = _svPublicBase(), x = _svSurveyRows(s.id), qmap = _svQuestionMap(s);
  return { success: true, publicBase: base, survey: _svAdminView(s, base), items: x.rows.map(function (r) { return _svRespItem(r, qmap, x.dupCount, false); }) };
}
function _svPickRows(x, ids) {
  if (!Array.isArray(ids)) return x.rows;
  var want = {};
  ids.forEach(function (id) { want[String(id)] = true; });
  return x.rows.filter(function (r) { return want[r[SV_R.id]]; });
}
// [개인정보 보기] — 개인정보 질문(이름·연락처·주소)의 전체 값. 처리기록에 누가·언제·몇 건
function _svRevealPii(d, auth) {
  var s = _svFind(d.id), x = _svSurveyRows(s.id), qmap = _svQuestionMap(s), rows = _svPickRows(x, d.responseIds), out = {};
  rows.forEach(function (r) {
    var a = _svJson(r[SV_R.answers], {}), o = {};
    Object.keys(a).forEach(function (k) { if (qmap[k] && SV_PII[qmap[k].type]) o[k] = a[k]; });
    out[r[SV_R.id]] = o;
  });
  _svWithLock(function () { _svLog((auth && auth.email) || '', s.id, rows.length <= 20 ? rows.map(function (r) { return r[SV_R.id]; }).join(',') : '', '개인정보 보기', rows.length + '건'); });
  return { success: true, items: out };
}
// [엑셀 다운로드] — 지정한 응답(없으면 전체)의 전체 값. 다운로드로그에 누가·언제·몇 건·범위
function _svExport(d, auth) {
  var s = _svFind(d.id), base = _svPublicBase(), x = _svSurveyRows(s.id), qmap = _svQuestionMap(s), rows = _svPickRows(x, d.responseIds);
  var scope = d.scope === '필터' ? '필터' : '전체';
  _svWithLock(function () { _svAppend('downloads', [_svNowStr(), (auth && auth.email) || '', s.id, rows.length, scope + (d.filterDesc ? ' — ' + _svText(d.filterDesc, 300) : ''), _svText(d.fileName, 200)]); });
  return { success: true, publicBase: base, survey: _svAdminView(s, base), items: rows.map(function (r) { return _svRespItem(r, qmap, x.dupCount, true); }) };
}

/* 영수증 보기 — 그 설문 응답에 첨부된 파일만(스크립트 소유자 권한이라 제한이 없으면 공유 드라이브 파일을 아무거나 읽게 된다).
   size 'thumb'(최대 12장, 긴 변 240px) | 'full'(1장, 1600px). Drive 미리보기 이미지(HEIC도 JPEG로 나온다)를 우선 쓰고,
   미리보기가 아직 없으면 브라우저가 그릴 수 있는 형식(JPG·PNG·WebP)만 원본으로 */
function _svImages(d) {
  var s = _svFind(d.id), x = _svSurveyRows(s.id), allowed = {};
  x.rows.forEach(function (r) { _svJson(r[SV_R.files], []).forEach(function (f) { allowed[f.id] = f; }); });
  var full = d.size === 'full', ids = (Array.isArray(d.files) ? d.files : []).slice(0, full ? 1 : 12), out = {};
  ids.forEach(function (id) {
    id = String(id);
    if (!allowed[id]) { out[id] = { error: 'FORBIDDEN' }; return; }
    try { out[id] = _svImageData(id, full ? 1600 : 240, full ? 9 * 1048576 : 1.5 * 1048576); }
    catch (e) { out[id] = { error: 'READ_FAILED' }; Logger.log('[설문] 영수증 읽기 실패: ' + e); }
  });
  return { success: true, images: out };
}
function _svImageData(fileId, px, rawMax) {
  var meta = Drive.Files.get(fileId, { supportsAllDrives: true, fields: 'id,mimeType,size,thumbnailLink,trashed' });
  if (!meta || meta.trashed) return { error: 'NOT_FOUND' };
  if (meta.thumbnailLink) {
    try {
      var url = String(meta.thumbnailLink).replace(/=s\d+[^/]*$/, '') + '=s' + px;
      var res = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
      if (res.getResponseCode() === 200) {
        var b = res.getBlob();
        return { mime: b.getContentType() || 'image/jpeg', data: Utilities.base64Encode(b.getBytes()) };
      }
    } catch (e) { /* 아래 원본으로 */ }
  }
  if (/^image\/(jpeg|png|webp)$/.test(meta.mimeType) && Number(meta.size || 0) <= rawMax) {
    return { mime: meta.mimeType, data: Utilities.base64Encode(DriveApp.getFileById(fileId).getBlob().getBytes()) };
  }
  return { error: 'NO_PREVIEW' };
}

/* 처리상태·메모 — data = { id, responseIds, status?, reason?, memo? }
   반려는 사유가 필요하다. 반려가 아닌 상태로 바꾸면 사유를 지운다. 메모는 한 건씩. 처리기록에 남긴다 */
function _svUpdateResponses(d, auth) {
  var s = _svFind(d.id), ids = Array.isArray(d.responseIds) ? d.responseIds.map(String) : [];
  if (!ids.length) throw new Error('바꿀 응답을 선택해주세요.');
  var hasStatus = d.status != null, hasMemo = d.memo != null;
  if (!hasStatus && !hasMemo) throw new Error('바꿀 내용이 없습니다.');
  var status = hasStatus ? String(d.status) : '', reason = _svText(d.reason, 300), memo = hasMemo ? _svText(d.memo, 1000) : '';
  if (hasStatus && SV_RESP_STATUSES.indexOf(status) < 0) throw new Error('처리상태는 대기·승인·반려·발송완료 중 하나입니다.');
  if (status === '반려' && !reason) throw new Error('반려 사유를 입력해주세요.');
  if (hasMemo && ids.length !== 1) throw new Error('메모는 한 건씩 저장합니다.');
  var who = (auth && auth.email) || '';
  return _svWithLock(function () {
    var rows = _svRead('responses'), want = {}, hit = [];
    ids.forEach(function (id) { want[id] = true; });
    rows.forEach(function (r) {
      if (r[SV_R.survey] !== s.id || !want[r[SV_R.id]]) return;
      if (hasStatus) { r[SV_R.status] = status; r[SV_R.reason] = status === '반려' ? reason : ''; }
      if (hasMemo) r[SV_R.memo] = memo;
      hit.push(r[SV_R.id]);
    });
    if (!hit.length) throw new Error('선택한 응답을 찾을 수 없습니다.');
    var col = SV_R.status + 1;
    _svSheet('responses').getRange(2, col, rows.length, 3).setValues(rows.map(function (r) { return [_svCell(r[SV_R.status]), _svCell(r[SV_R.memo]), _svCell(r[SV_R.reason])]; }));
    _svLog(who, s.id, hit.length <= 50 ? hit.join(',') : '', hasStatus ? '처리상태 변경' : '메모',
      hasStatus ? status + (status === '반려' ? ' (사유: ' + reason + ')' : '') + ' · ' + hit.length + '건' : '1건');
    return { success: true, updated: hit };
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 개인정보 보유기간 (매일 트리거) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/* 편집기에서 1회 실행 — 매일 새벽 4시 survey_retentionDaily. 다시 실행하면 기존 것을 지우고 하나만 둔다 */
function survey_installRetentionTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === SV_RETENTION_HANDLER) { ScriptApp.deleteTrigger(t); removed++; } });
  ScriptApp.newTrigger(SV_RETENTION_HANDLER).timeBased().everyDays(1).atHour(4).inTimezone('Asia/Seoul').create();
  Logger.log('[설문] 보유기간 삭제 트리거 설치(매일 4시)' + (removed ? ' — 기존 ' + removed + '개 교체' : ''));
  return { installed: true, replaced: removed };
}
// 트리거 진입점(편집기에서 직접 실행해도 같다)
function survey_retentionDaily() {
  _svIo = { ss: null };
  var r = _svRunRetention(Date.now(), 'trigger');
  Logger.log('[설문 보유기간] ' + JSON.stringify(r));
  return r;
}
/* 삭제 예정일(마감 + 보유기간)이 지난 설문의 응답에서 이름·연락처·주소·자유 입력·날짜 답변, 중복키, 메모·반려사유, 영수증 파일을 지우고
   통계용 선택형 답변(동의·체크박스·객관식·드롭다운·척도 — '기타' 직접 입력 글은 지움)만 남긴다. 처리한 응답은 개인정보삭제일을 적고 다시 건드리지 않는다 */
function _svRunRetention(now, by) {
  var due = {};
  _svSurveys(true).forEach(function (s) { var t = _svPurgeDueMs(s); if (t != null && t <= now) due[s.id] = s; });
  var report = { surveys: [], responses: 0, files: 0, failedFiles: [] };
  if (!Object.keys(due).length) return report;
  var files = [], per = {};
  _svWithLock(function () {
    var rows = _svRead('responses'), nowStr = _svNowStr(now), changed = false;
    rows.forEach(function (r) {
      var s = due[r[SV_R.survey]];
      if (!s || r[SV_R.purgedAt]) return;
      var qmap = _svQuestionMap(s), a = _svJson(r[SV_R.answers], {}), keep = {};
      Object.keys(a).forEach(function (k) {
        var t = qmap[k] && qmap[k].type;
        if (!SV_KEEP[t]) return;
        keep[k] = SV_CHOICE[t] && a[k] && a[k].other != null ? { sel: a[k].sel || [], other: '(삭제됨)' } : a[k];
      });
      var fl = _svJson(r[SV_R.files], []);
      fl.forEach(function (f) { files.push({ id: f.id, survey: s.id }); });
      r[SV_R.answers] = JSON.stringify(keep); r[SV_R.files] = '[]'; r[SV_R.dup] = ''; r[SV_R.memo] = ''; r[SV_R.reason] = ''; r[SV_R.purgedAt] = nowStr;
      per[s.id] = per[s.id] || { responses: 0, files: 0 };
      per[s.id].responses++; per[s.id].files += fl.length;
      changed = true;
    });
    if (changed) _svWriteRows('responses', 2, rows);
  });
  var failed = _svDeleteFiles(files);
  _svWithLock(function () {
    Object.keys(per).forEach(function (id) {
      var bad = files.filter(function (f) { return f.survey === id && failed.indexOf(f.id) >= 0; }).map(function (f) { return f.id; });
      _svLog(by, id, '', '개인정보 삭제', '보유기간 ' + due[id].retentionDays + '일 경과 — 응답 ' + per[id].responses + '건 · 영수증 ' + per[id].files + '개 삭제' +
        (bad.length ? ' · 파일 삭제 실패 ' + bad.length + '개(직접 지워주세요): ' + bad.join(',') : ''));
      report.surveys.push(id); report.responses += per[id].responses; report.files += per[id].files;
    });
  });
  report.failedFiles = failed;
  return report;
}
