/**
 * 미닉스 오프라인 — 드라이브 수신함 자동 반영 (Google Apps Script)
 * apps-script.js 와 같은 Apps Script 프로젝트의 파일이다(전역을 공유한다). 편집기 파일 이름 "offline_inbox".
 *
 * 수동 업로드와 결과가 같아야 한다 — 그래서 읽기·파싱을 브라우저와 **같은 코드**로 한다:
 * · 파서 = src/features/offline/parsers.js 그 파일 그대로(편집기 파일 "offline_parsers"로 붙여넣는다 — 전역 OfflineParsers)
 * · 엑셀 읽기 = 브라우저와 같은 SheetJS(같은 버전·같은 SRI 해시)를 GAS에서 직접 돌린다. 구글 시트로 변환하지 않는다 —
 *   전자랜드 .xls는 실제로 HTML 표라 드라이브가 시트로 변환하지 못하고, 변환하면 '2026-09-02'가 날짜로·'0012'가 12로 바뀐다
 *   (브라우저가 raw:true로 막아 둔 문제). 변환용 임시 파일도 생기지 않는다(ERP 개인정보가 디스크에 남지 않는다).
 * SheetJS는 브라우저와 같은 CDN 주소에서 받아 SRI 해시(src/features/offline/sheetjs.js SHEETJS_SRI와 같은 값)를 확인한 뒤
 * 스크립트 캐시에 6시간 둔다(약 950KB — 편집기에 붙여넣지 않는다).
 */

var OFF_SHEETJS = {
  version: '0.20.3',
  url: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
  sri: 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT'
};
var OFF_SHEETJS_CACHE_SEC = 21600;
var _offXlsxLib = null;

// SheetJS 원문의 SHA-384(UTF-8 바이트)가 브라우저 SRI와 같은지
function _offSheetJsOk(src) {
  var d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_384, src, Utilities.Charset.UTF_8);
  return 'sha384-' + Utilities.base64Encode(d) === OFF_SHEETJS.sri;
}

// 실행마다 한 번 — 캐시(6시간) → 없으면 CDN. 해시가 다르면 실행하지 않는다
function _offXlsx() {
  if (_offXlsxLib) return _offXlsxLib;
  var cache = CacheService.getScriptCache(), key = 'offline:sheetjs:' + OFF_SHEETJS.version;
  var src = _cacheGetJSON(cache, key);
  if (typeof src !== 'string' || !_offSheetJsOk(src)) {
    var res = UrlFetchApp.fetch(OFF_SHEETJS.url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('엑셀 읽기 라이브러리(SheetJS)를 받지 못했습니다: HTTP ' + res.getResponseCode());
    src = res.getContentText('UTF-8');
    if (!_offSheetJsOk(src)) throw new Error('받은 SheetJS의 무결성 해시가 브라우저(SHEETJS_SRI)와 다릅니다 — 실행하지 않습니다.');
    _cachePutJSON(cache, key, src, OFF_SHEETJS_CACHE_SEC);
  }
  (0, eval)(src); // 간접 eval = 전역 실행 → 전역 XLSX (브라우저 <script>와 같다)
  if (typeof XLSX === 'undefined' || XLSX.version !== OFF_SHEETJS.version) throw new Error('SheetJS를 실행했지만 XLSX ' + OFF_SHEETJS.version + '이(가) 없습니다.');
  _offXlsxLib = XLSX;
  return _offXlsxLib;
}

/* 파일 바이트 → 파서 입력(2차원 배열) — 브라우저 src/features/admin/upload.js _upReadFile과 같은 순서·같은 함수.
   bytes = Blob.getBytes()(부호 있는 바이트 -128~127) → Uint8Array(브라우저 new Uint8Array(arrayBuffer)와 같은 값).
   개인정보 열이 있는 양식(ERP 매출이익리스트)은 읽자마자 쓰는 열만 남긴다 — 원본 행은 이 함수 밖으로 나가지 않는다. */
function _offInboxReadRows(bytes) {
  return OfflineParsers.dropUnusedColumns(OfflineParsers.readWorkbookRows(_offXlsx(), new Uint8Array(bytes)).rows);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 수신함 처리 (offline_processInbox) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/* 수신함 폴더(회사 공유 드라이브)의 엑셀을 수동 업로드와 같은 규칙으로 반영한다.
   · 파일 → SheetJS → 공유 파서 → _offUpload(수동 업로드와 같은 함수, strict: 모르는 업태명·매핑 안 된 거래처면 쓰기 전에 실패)
   · 성공 → 하위 폴더 '처리완료', 파일 문제(판별 불가·반영 불가 양식·모르는 업태·매핑 안 된 거래처·날짜 없음 등) → '오류'.
     미매칭 상품코드는 실패가 아니다(수동처럼 반영하고 미매칭 목록에 쌓는다)
   · 일시적인 문제(SheetJS를 못 받음·다른 반영이 락을 잡고 있음)는 파일을 그대로 두고 다음 실행으로 넘긴다 — 멀쩡한 파일을 '오류'로 보내지 않게
   · 이미 반영한 파일은 건너뛴다 — 업로드로그의 원본MD5(같은 내용)·원본파일ID+원본수정시각으로 판단. 실패한 파일을 고쳐(또는 매핑을 고친 뒤)
     다시 넣으면 다시 처리한다. 단, 지난번 실패 뒤 '오류'로 옮기지 못해 수신함에 남은 파일은 매 실행 실패 로그가 쌓이지 않게 건너뛴다
   · 한 번 실행 = 최대 자동반영_회당최대파일수개, 5분이 지나면 남은 파일은 다음 실행으로(6분 실행 제한)
   · Sheets API 사용자당 분당 한도(읽기·쓰기 각 60회)는 웹앱 사용자 전원과 같이 쓴다 — 이 작업은 1분에 OFF_INBOX_API_PER_MIN회까지만
     쓰도록 파일 사이에서 기다린다. 한도 초과로 SpreadsheetApp 대체가 생기면 횟수를 업로드로그 경고와 상태에 남긴다
   · 공유 드라이브: Drive v3 supportsAllDrives·includeItemsFromAllDrives·corpora drive(driveId는 수신함 폴더 정보에서). 업로더 = 파일을
     마지막으로 고친 사람(lastModifyingUser — 공유 드라이브 파일은 소유자가 조직이다). 이동·휴지통은 실행 계정에 콘텐츠 관리자 이상 권한이
     있어야 한다 — 실패해도 반영은 그대로 두고 사유를 업로드로그 수신함처리 열과 상태에 남긴다 */
var OFF_INBOX_FOLDER_PROP = 'OFFLINE_INBOX_FOLDER_ID';
var OFF_INBOX_STATUS_PROP = 'OFFLINE_INBOX_LAST';
var OFF_INBOX_DONE = '처리완료', OFF_INBOX_ERROR = '오류';
var OFF_INBOX_TIME_BUDGET_MS = 5 * 60 * 1000;
var OFF_INBOX_API_PER_MIN = 30;   // 이 작업의 분당 Sheets API 호출 상한 — 사용자당 한도 60의 절반(나머지는 대시보드 몫)
var OFF_INBOX_API_PER_FILE = 10;  // 파일 하나 반영의 호출 어림(읽기 2 + 쓰기 최대 7 + 여유)
var OFF_INBOX_GAP_MS = 2000;      // 파일 사이 최소 간격
var OFF_INBOX_RUNNING_KEY = 'offline:inbox:running';
var OFF_FOLDER_MIME = 'application/vnd.google-apps.folder';
var OFF_INBOX_FILE_FIELDS = 'id,name,mimeType,modifiedTime,md5Checksum,size,lastModifyingUser(emailAddress,displayName),appProperties';

/* 설정 탭의 자동 반영 키 → 값(없거나 잘못되면 기본값). 탭이 없어도(setup 재실행 전) 기본값 */
function _offInboxSettings() {
  var got = {};
  _offReadTabs(['settings'], { optional: ['settings'] }).settings.forEach(function (r) { if (r[0]) got[r[0]] = r[1]; });
  var def = {};
  OFF_INBOX_SETTINGS_DEFAULT.forEach(function (d) { def[d[0]] = d[1]; });
  var int = function (k, lo, hi) {
    var v = Number(got[k]);
    return got[k] !== '' && got[k] != null && isFinite(v) && v === Math.round(v) && v >= lo && v <= hi ? v : def[k];
  };
  var start = int('자동반영_시작시각', 0, 23), end = int('자동반영_종료시각', 1, 24);
  if (end <= start) { start = def['자동반영_시작시각']; end = def['자동반영_종료시각']; }
  return { enabled: String(got['자동반영_사용'] == null ? '' : got['자동반영_사용']).trim().toUpperCase() !== 'N',
    startHour: start, endHour: end, keepDays: int('처리완료_보관일수', 1, 3650), maxFiles: int('자동반영_회당최대파일수', 1, 50) };
}

function _offInboxFolderId() { return PropertiesService.getScriptProperties().getProperty(OFF_INBOX_FOLDER_PROP) || ''; }

// 폴더 안 파일 목록(하위 폴더 속은 아님) — 공유 드라이브면 그 드라이브 안에서
function _offDriveList(folder, extraQ) {
  var out = [], token = null;
  do {
    var opt = { q: "'" + folder.id + "' in parents and trashed = false" + (extraQ ? ' and ' + extraQ : ''), supportsAllDrives: true, includeItemsFromAllDrives: true,
      fields: 'nextPageToken,files(' + OFF_INBOX_FILE_FIELDS + ')', pageSize: 200 };
    if (folder.driveId) { opt.corpora = 'drive'; opt.driveId = folder.driveId; } else opt.corpora = 'user';
    if (token) opt.pageToken = token;
    var res = Drive.Files.list(opt);
    out = out.concat(res.files || []);
    token = res.nextPageToken;
  } while (token);
  return out;
}
// 하위 폴더 '처리완료'·'오류' — 없으면 만든다(같은 공유 드라이브 안)
function _offInboxSubfolder(folder, name) {
  var hit = _offDriveList(folder, "mimeType = '" + OFF_FOLDER_MIME + "' and name = '" + name + "'")[0];
  if (hit) return hit.id;
  return Drive.Files.create({ name: name, mimeType: OFF_FOLDER_MIME, parents: [folder.id] }, null, { supportsAllDrives: true, fields: 'id' }).id;
}
// 파일을 다른 폴더로 — parents 변경. 처리한 시각을 appProperties에 남긴다(보관일수 계산용). 실패하면 사유 문자열, 성공하면 ''
function _offInboxMove(fileId, fromId, toId, at) {
  try {
    Drive.Files.update({ appProperties: { offlineInboxAt: at } }, fileId, null, { addParents: toId, removeParents: fromId, supportsAllDrives: true, fields: 'id' });
    return '';
  } catch (e) { return String((e && e.message) || e); }
}

// 수동 업로드 "전체 반영"과 같은 순서 — 이마트 일별상세(업태명으로 점포 → 채널을 먼저 익힌다) → 이마트 재고현황_상세 → 나머지(파일명 순)
// → 하이마트(누적 차이 계산이라 기준일 = 파일명 날짜 오름차순으로 맨 뒤)
function _offInboxOrder(files) {
  var rank = function (n) { return /일별상세/.test(n) ? 0 : /재고현황_상세/.test(n) ? 1 : /판매재고현황/.test(n) ? 3 : 2; };
  return files.slice().sort(function (a, b) { return (rank(a.name) - rank(b.name)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
}

/* 업로드로그 → 자동 반영 기록. okMd5{md5: upload_id}(성공한 내용), byFile{파일ID+수정시각: {ok, stuck}} — stuck = 실패했는데 '오류'로 옮기지 못해 수신함에 남은 파일 */
function _offInboxHistory() {
  var okMd5 = {}, byFile = {};
  _offRead('uploadLog').forEach(function (r) {
    if (r[12] !== '자동 반영') return;
    var ok = r[11] === '성공', k = r[13] + OFF_KEY_SEP + r[14], h = byFile[k] || (byFile[k] = { ok: false, stuck: false });
    if (ok) { h.ok = true; if (r[15]) okMd5[r[15]] = r[0]; }
    else h.stuck = r[16].indexOf('오류 폴더로 옮기지 못함') >= 0;
  });
  return { okMd5: okMd5, byFile: byFile };
}

// 업로드로그 한 행의 수신함처리 열에 사유를 남긴다(이동·휴지통 실패) — 락 안에서 그 행만 다시 쓴다
function _offInboxNote(uploadId, note) {
  if (!uploadId) return;
  _offWithLock(function () {
    var rows = _offRead('uploadLog');
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i][0] !== uploadId) continue;
      rows[i][16] = (rows[i][16] ? rows[i][16] + ' / ' : '') + note;
      _offWriteRows('uploadLog', 2 + i, [rows[i]], 0);
      return;
    }
  });
}

// 반영 전에 실패한 파일(판별 불가 등)의 업로드로그 '실패' 행 — 반영 중 실패는 _offUpload가 남긴다
function _offInboxLogFailure(f, parsed, uploader, msg) {
  var id = 'U' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 4);
  var p = parsed && parsed.ok ? parsed : null;
  var range = !p ? '' : p.kind === 'period' ? ((p.period && p.period.start) || '') + '~' + ((p.period && p.period.end) || '') : (p.baseDate || '');
  _offWithLock(function () {
    _offAppend('uploadLog', [[id, Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'), uploader, String(f.name || '').slice(0, 200),
      p ? p.type : '', p ? p.channelId : '', range, p ? (Number(p.rawRowCount) || 0) : 0, 0, 0, '', '실패: ' + String(msg).slice(0, 300)]
      .concat(_offLogSource({ fileId: f.id, modifiedTime: f.modifiedTime || '', md5: f.md5Checksum || '' }))]);
  });
  return id;
}

// 파일 하나 — { name, result: 'success'|'error'|'deferred', detail, uploadId, apiCalls, apiFallbacks }
function _offInboxFile(f, run) {
  var out = { name: f.name, result: '', detail: '', uploadId: '' };
  var uploader = (f.lastModifyingUser && (f.lastModifyingUser.emailAddress || f.lastModifyingUser.displayName)) || '';
  var calls0 = _offApiTimes.length, fb0 = _offApiFallbacks, parsed = null;
  try {
    var rows = _offInboxReadRows(DriveApp.getFileById(f.id).getBlob().getBytes());
    parsed = OfflineParsers.parseRows(rows, { fileName: f.name, today: run.today, stockOffsets: run.offsets });
    rows = null;
    if (!parsed.ok) throw new Error('판별 불가 — ' + parsed.error);
    if (parsed.blocked) throw new Error('반영할 수 없는 양식 — ' + parsed.blocked);
    var res = _offUpload(OfflineParsers.toUploadPayload(parsed, { fileName: f.name }), { email: uploader },
      { strict: true, auto: { fileId: f.id, modifiedTime: f.modifiedTime || '', md5: f.md5Checksum || '' } });
    out.result = 'success'; out.uploadId = res.uploadId;
    var a = res.applied || {};
    out.detail = [a.sales != null ? '판매 ' + a.sales + '행' : '', a.stockDaily != null ? '채널 재고 ' + a.stockDaily : '', a.stockStore != null ? '점포 재고 ' + a.stockStore : '',
      res.unmatched && res.unmatched.length ? '미매칭 ' + res.unmatched.length + '개' : '', res.warnings && res.warnings.length ? '경고 ' + res.warnings.length + '건' : '']
      .filter(function (x) { return x; }).join(' · ');
  } catch (e) {
    var msg = String((e && e.message) || e);
    if (/다른 오프라인 반영이 진행 중/.test(msg)) { out.result = 'deferred'; out.detail = '다른 반영이 진행 중 — 다음 실행에서'; return out; }
    out.result = 'error'; out.detail = msg.slice(0, 300);
    try { out.uploadId = e && e.offLogged ? e.offUploadId : _offInboxLogFailure(f, parsed, uploader, msg); }
    catch (e2) { out.result = 'deferred'; out.detail = '실패 기록을 남기지 못해 다음 실행에서 다시 — ' + String((e2 && e2.message) || e2).slice(0, 120); }
  } finally {
    out.apiCalls = _offApiTimes.length - calls0;
    out.apiFallbacks = _offApiFallbacks - fb0;
  }
  return out;
}

// 다음 파일 전에 기다리기 — 파일 사이 최소 간격 + 이 작업의 분당 Sheets API 호출 상한. 시간 예산을 넘기면 false(다음 실행으로)
function _offInboxPace(run) {
  var now = Date.now(), wait = Math.max(0, run.lastEnd + OFF_INBOX_GAP_MS - now);
  var recent = _offApiTimes.filter(function (t) { return t > now - 60000; }).sort(function (a, b) { return a - b; });
  var over = recent.length + OFF_INBOX_API_PER_FILE - OFF_INBOX_API_PER_MIN;
  if (over > 0) wait = Math.max(wait, recent[over - 1] + 60000 - now + 50);
  if (now + wait - run.t0 > run.budgetMs) return false;
  if (wait > 0) { Utilities.sleep(wait); run.waitedMs += wait; }
  return true;
}

/* 한 번 실행 — by = 'trigger' | 'editor' | 'manual:이메일'([지금 확인]). 결과는 스크립트 속성에 남겨 상태 패널이 읽는다 */
function _offInboxRun(by) {
  var cache = CacheService.getScriptCache();
  if (cache.get(OFF_INBOX_RUNNING_KEY)) return { success: true, busy: true, message: '다른 수신함 확인이 진행 중입니다 — 잠시 후 다시 보세요.' };
  cache.put(OFF_INBOX_RUNNING_KEY, String(Date.now()), 360);
  var run = { t0: Date.now(), lastEnd: 0, waitedMs: 0, budgetMs: OFF_INBOX_TIME_BUDGET_MS, today: _offToday(), at: Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss') };
  var status = { at: run.at, by: by, counts: { success: 0, error: 0, skipped: 0, deferred: 0 }, files: [], warnings: [], note: '', apiCalls: 0, apiFallbacks: 0, ignored: 0 };
  var calls0 = _offApiTimes.length, fb0 = _offApiFallbacks;
  try {
    _offWithIo(function () {
      var folderId = _offInboxFolderId();
      if (!folderId) { status.note = 'Script Properties에 ' + OFF_INBOX_FOLDER_PROP + '(수신함 폴더 ID)가 없습니다.'; return; }
      var folder = Drive.Files.get(folderId, { supportsAllDrives: true, fields: 'id,name,driveId,mimeType' });
      if (folder.mimeType !== OFF_FOLDER_MIME) { status.note = OFF_INBOX_FOLDER_PROP + '가 폴더가 아닙니다: ' + folder.name; return; }
      var settings = _offInboxSettings();
      var doneId = _offInboxSubfolder(folder, OFF_INBOX_DONE), errId = _offInboxSubfolder(folder, OFF_INBOX_ERROR);
      var all = _offDriveList(folder, "mimeType != '" + OFF_FOLDER_MIME + "'");
      // 엑셀만 — '~$'로 시작하는 파일은 엑셀이 열어 둔 파일의 잠금 파일(드라이브 데스크톱 동기화로 올라올 수 있다)이라 손대지 않는다
      var files = _offInboxOrder(all.filter(function (f) { var nm = String(f.name || ''); return /\.(xlsx|xls)$/i.test(nm) && nm.indexOf('~$') !== 0; }));
      status.ignored = all.length - files.length;
      if (files.length) {
        try { _offXlsx(); } catch (e) { // 라이브러리를 못 받으면 파일은 그대로 두고 다음 실행으로
          status.note = String((e && e.message) || e); status.counts.deferred = files.length; files = [];
        }
      }
      var hist = files.length ? _offInboxHistory() : null;
      run.offsets = {};
      if (files.length) _offRead('channel').forEach(function (r) { var o = _offStockOffsetOf(r); if (r[0] && o) run.offsets[r[0]] = o; });
      var processed = 0;
      for (var i = 0; i < files.length; i++) {
        var f = files[i], h = hist.byFile[f.id + OFF_KEY_SEP + (f.modifiedTime || '')];
        if ((f.md5Checksum && hist.okMd5[f.md5Checksum]) || (h && h.ok)) {
          var mv = _offInboxMove(f.id, folder.id, doneId, run.at);
          status.counts.skipped++;
          status.files.push({ name: f.name, result: 'skipped', detail: '이미 반영한 파일' + (mv ? ' — 처리완료 폴더로 옮기지 못함: ' + mv : ' — 처리완료 폴더로 옮김') });
          if (mv) status.warnings.push(f.name + ' — 처리완료 폴더로 옮기지 못함: ' + mv);
          continue;
        }
        if (h && h.stuck) { status.counts.skipped++; status.files.push({ name: f.name, result: 'skipped', detail: '지난번 실패 — 오류 폴더로 옮기지 못해 수신함에 남은 파일(권한 확인)' }); continue; }
        if (processed >= settings.maxFiles || (processed && !_offInboxPace(run)) || Date.now() - run.t0 > run.budgetMs) {
          status.counts.deferred += files.length - i; status.note = status.note || (processed >= settings.maxFiles ? '회당 최대 ' + settings.maxFiles + '개 — 남은 파일은 다음 실행에서' : '실행 시간 5분 — 남은 파일은 다음 실행에서');
          break;
        }
        var r = _offInboxFile(f, run);
        run.lastEnd = Date.now();
        if (r.result === 'deferred') { status.counts.deferred++; status.files.push(r); continue; }
        processed++;
        var to = r.result === 'success' ? doneId : errId, toName = r.result === 'success' ? OFF_INBOX_DONE : OFF_INBOX_ERROR;
        var moveErr = _offInboxMove(f.id, folder.id, to, run.at);
        if (moveErr) {
          var note = toName + ' 폴더로 옮기지 못함(콘텐츠 관리자 권한 필요): ' + moveErr.slice(0, 200);
          status.warnings.push(f.name + ' — ' + note);
          try { _offInboxNote(r.uploadId, note); } catch (e) { status.warnings.push('업로드로그에 이동 실패를 적지 못함: ' + e); }
        }
        if (r.apiFallbacks) {
          var fbNote = 'Sheets API 한도 초과로 SpreadsheetApp 대체 ' + r.apiFallbacks + '회';
          try { _offInboxNote(r.uploadId, fbNote); } catch (e) {}
        }
        status.counts[r.result === 'success' ? 'success' : 'error']++;
        status.files.push(r);
      }
      // 처리완료 폴더 — 보관일수 지난 파일(이 작업이 옮긴 것만 — appProperties.offlineInboxAt)은 휴지통으로
      var cutoff = Utilities.formatDate(new Date(Date.now() - settings.keepDays * 86400000), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
      _offDriveList({ id: doneId, driveId: folder.driveId }, "mimeType != '" + OFF_FOLDER_MIME + "'").forEach(function (f) {
        var at = f.appProperties && f.appProperties.offlineInboxAt;
        if (!at || at >= cutoff) return;
        try { Drive.Files.update({ trashed: true }, f.id, null, { supportsAllDrives: true, fields: 'id' }); status.trashed = (status.trashed || 0) + 1; }
        catch (e) { status.warnings.push(f.name + ' — 보관일수(' + settings.keepDays + '일)가 지났지만 휴지통으로 보내지 못함(콘텐츠 관리자 권한 필요): ' + String((e && e.message) || e).slice(0, 200)); }
      });
    });
  } catch (e) {
    status.note = '실행 오류: ' + String((e && e.message) || e).slice(0, 300);
    Logger.log('[수신함] ' + status.note + '\n' + (e && e.stack));
  } finally {
    cache.remove(OFF_INBOX_RUNNING_KEY);
    status.apiCalls = _offApiTimes.length - calls0;
    status.apiFallbacks = _offApiFallbacks - fb0;
    status.durationMs = Date.now() - run.t0;
    status.waitedMs = run.waitedMs;
    _offInboxSaveStatus(status);
  }
  status.success = true;
  return status;
}

// 마지막 실행 결과 — 스크립트 속성(값 하나 9KB 아래로: 파일은 최근 30개, 문구는 줄여서)
function _offInboxSaveStatus(st) {
  var s = JSON.parse(JSON.stringify(st));
  s.files = s.files.slice(0, 30).map(function (f) { return { name: String(f.name).slice(0, 80), result: f.result, detail: String(f.detail || '').slice(0, 160), apiCalls: f.apiCalls, apiFallbacks: f.apiFallbacks }; });
  s.warnings = s.warnings.slice(0, 10).map(function (w) { return String(w).slice(0, 240); });
  var text = JSON.stringify(s);
  while (text.length > 8500 && s.files.length) { s.files.pop(); text = JSON.stringify(s); }
  try { PropertiesService.getScriptProperties().setProperty(OFF_INBOX_STATUS_PROP, text); } catch (e) { Logger.log('[수신함] 상태 저장 실패: ' + e); }
}

/* 편집기에서 직접 실행 — 수신함을 지금 확인한다(사용 여부·시각 범위와 관계없이) */
function offline_processInbox() {
  var st = _offInboxRun('editor');
  Logger.log('[offline_processInbox] ' + JSON.stringify(st));
  return st;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 트리거 · 상태 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
var OFF_INBOX_HANDLER = 'offline_inboxTick';

/* 편집기에서 1회 실행 — 1시간마다 offline_inboxTick을 부르는 시간 트리거. 이미 있으면 지우고 하나만 다시 만든다(중복 설치 방지).
   트리거는 실행한 계정으로 돈다 — 그 계정에 수신함 공유 드라이브 콘텐츠 관리자 이상 권한이 있어야 파일을 옮기고 휴지통으로 보낼 수 있다 */
function offline_installInboxTrigger() {
  var removed = _offInboxRemoveTriggers();
  ScriptApp.newTrigger(OFF_INBOX_HANDLER).timeBased().everyHours(1).create();
  var out = { installed: true, removedBefore: removed, handler: OFF_INBOX_HANDLER, everyHours: 1, folderSet: !!_offInboxFolderId() };
  Logger.log('[offline_installInboxTrigger] ' + JSON.stringify(out) + (out.folderSet ? '' : ' — ⚠ Script Properties에 ' + OFF_INBOX_FOLDER_PROP + '를 등록하세요'));
  return out;
}
function offline_removeInboxTrigger() {
  var out = { removed: _offInboxRemoveTriggers() };
  Logger.log('[offline_removeInboxTrigger] ' + JSON.stringify(out));
  return out;
}
function _offInboxRemoveTriggers() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === OFF_INBOX_HANDLER) { ScriptApp.deleteTrigger(t); n++; } });
  return n;
}

/* 트리거가 1시간마다 부른다 — 설정 탭 자동반영_사용이 N이거나 시각 범위(시작 이상 종료 미만, 한국 시각) 밖이면 아무것도 하지 않는다 */
function offline_inboxTick() {
  var s = _offInboxSettings(), hour = Number(Utilities.formatDate(new Date(), 'Asia/Seoul', 'HH'));
  if (!s.enabled) return { skipped: '자동반영_사용 = N' };
  if (hour < s.startHour || hour >= s.endHour) return { skipped: '시각 범위 밖(' + s.startHour + '~' + s.endHour + '시, 지금 ' + hour + '시)' };
  return _offInboxRun('trigger');
}

/* offline_getInboxStatus — 데이터 업로드 화면 상단 "자동 반영" 패널 */
function _offInboxStatus() {
  var id = _offInboxFolderId(), triggers = null, last = null;
  try { triggers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === OFF_INBOX_HANDLER; }).length; } catch (e) { triggers = null; }
  try { last = JSON.parse(PropertiesService.getScriptProperties().getProperty(OFF_INBOX_STATUS_PROP) || 'null'); } catch (e) { last = null; }
  return { success: true, folderId: id, folderUrl: id ? 'https://drive.google.com/drive/folders/' + id : '', settings: _offInboxSettings(),
    triggerInstalled: triggers == null ? null : triggers > 0, last: last, apiPerMin: OFF_INBOX_API_PER_MIN };
}
