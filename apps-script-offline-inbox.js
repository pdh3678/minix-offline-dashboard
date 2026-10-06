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
