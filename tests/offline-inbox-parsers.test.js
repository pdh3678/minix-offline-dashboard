/* 수신함 자동 반영 — 파서 공유(브라우저 = GAS) (2026-10-06)

   지키려는 성질:
     · GAS는 브라우저 파서 src/features/offline/parsers.js를 **그 파일 그대로** 쓴다(편집기 파일 offline_parsers) — 맨 V8 환경
       (window·document·module·Buffer·TextDecoder 없음)에서 전역 OfflineParsers가 생긴다
     · GAS의 SheetJS = 브라우저와 같은 주소·같은 SRI 해시. 받은 원문의 해시가 다르면 실행하지 않는다. 한 번 받으면 스크립트 캐시에서 쓴다
     · samples/ 모든 실파일을 브라우저 경로(SheetJS + Uint8Array)와 GAS 경로(_offInboxReadRows — Blob.getBytes()의 부호 있는 바이트,
       TextDecoder 없음)로 읽으면 2차원 배열·파싱 결과가 완전히 같다. ERP는 읽자마자 쓰는 열만 남는다(개인정보 열 없음)
       — SheetJS가 있어야 한다: XLSX_PATH=<SheetJS 모듈 폴더> (없으면 이 부분만 건너뜀)

   실행: [XLSX_PATH=…] node tests/offline-inbox-parsers.test.js  (또는 node tests/run-all.js) */
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { loadOfflineGas } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const PROJ = path.join(__dirname, '..');
const PARSERS = path.join(PROJ, 'src', 'features', 'offline', 'parsers.js');

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 700) : '')); }
}
const J = JSON.stringify;
const sri = src => 'sha384-' + crypto.createHash('sha384').update(Buffer.from(src, 'utf8')).digest('base64');
let XLSX_DIR = null;
try { XLSX_DIR = path.dirname(require.resolve(path.join(process.env.XLSX_PATH || 'xlsx', 'package.json'))); } catch (e) {}

console.log('\n[1] 파서 파일 하나 — GAS 맨 환경에서 그대로 동작');
{
  const src = fs.readFileSync(PARSERS, 'utf8');
  const bare = vm.createContext({});
  vm.runInContext(src, bare, { filename: 'offline_parsers' });
  check('맨 V8 컨텍스트(window·module·Buffer·TextDecoder 없음)에 전역 OfflineParsers', typeof bare.OfflineParsers === 'object' &&
    ['parseRows', 'readWorkbookRows', 'dropUnusedColumns', 'toUploadPayload', 'detect'].every(k => typeof bare.OfflineParsers[k] === 'function'));
  check('  ↳ 브라우저·node 전용 API에 기대지 않는다(window·document·TextDecoder·localStorage 없음, Buffer는 있을 때만)',
    !/\b(window|document|TextDecoder|localStorage)\b/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')) && /typeof Buffer !== 'undefined'/.test(src));
  const g = loadOfflineGas({ setup: true, today: '2026-10-06' });
  check('GAS 하네스도 같은 파일을 편집기 파일로 올린다 — 전역 OfflineParsers', typeof g.ctx.OfflineParsers.parseRows === 'function' && typeof g.ctx._offInboxReadRows === 'function');
}

console.log('\n[2] SheetJS — 브라우저와 같은 주소·같은 SRI, 해시가 다르면 실행하지 않음, 캐시');
{
  const front = fs.readFileSync(path.join(PROJ, 'src', 'features', 'offline', 'sheetjs.js'), 'utf8');
  const g = loadOfflineGas({ today: '2026-10-06' });
  check('주소·SRI가 브라우저(src/features/offline/sheetjs.js)와 같다', front.indexOf("SHEETJS_SRC='" + g.ctx.OFF_SHEETJS.url + "'") >= 0 && front.indexOf("SHEETJS_SRI='" + g.ctx.OFF_SHEETJS.sri + "'") >= 0,
    g.ctx.OFF_SHEETJS);
  const fake = "/*! 가짜 */var XLSX = { version: '0.20.3', fake: true, 한글: '코드페이지' };";
  const realSri = g.ctx.OFF_SHEETJS.sri;
  g.ctx.OFF_SHEETJS.sri = sri(fake);
  let fetched = 0, body = fake;
  global.UrlFetchApp.fetch = (url, o) => { fetched++; return { getResponseCode: () => 200, getContentText: () => body, url, o }; };
  const x1 = g.ctx._offXlsx();
  check('처음 — CDN에서 받아 해시 확인 후 실행(전역 XLSX)', fetched === 1 && x1.fake === true && g.ctx.XLSX === x1);
  g.ctx._offXlsxLib = null; delete g.ctx.XLSX;
  const x2 = g.ctx._offXlsx();
  check('다음 실행 — 스크립트 캐시에서(다시 받지 않음, 청크로 저장)', fetched === 1 && x2.fake === true &&
    Object.keys(g.cacheStore).filter(k => k.indexOf('offline:sheetjs:0.20.3:') === 0).length >= 2);
  g.ctx._offXlsxLib = null; delete g.ctx.XLSX;
  Object.keys(g.cacheStore).forEach(k => { if (/^offline:sheetjs:0\.20\.3:0$/.test(k)) g.cacheStore[k] = g.cacheStore[k].replace('fake', 'evil'); });
  const x3 = g.ctx._offXlsx();
  check('캐시가 바뀌어 해시가 안 맞으면 다시 받는다', fetched === 2 && x3.fake === true);
  g.ctx._offXlsxLib = null; delete g.ctx.XLSX;
  Object.keys(g.cacheStore).forEach(k => { if (k.indexOf('offline:sheetjs:') === 0) delete g.cacheStore[k]; });
  body = fake.replace('fake: true', 'fake: true, evil: 1');
  let err = '';
  try { g.ctx._offXlsx(); } catch (e) { err = e.message; }
  check('받은 원문의 해시가 브라우저와 다르면 실행하지 않는다', /무결성 해시/.test(err) && typeof g.ctx.XLSX === 'undefined', err);
  body = fake; global.UrlFetchApp.fetch = () => ({ getResponseCode: () => 503, getContentText: () => '' });
  err = '';
  try { g.ctx._offXlsx(); } catch (e) { err = e.message; }
  check('CDN이 응답하지 않으면 분명한 오류(다음 실행에서 다시)', /HTTP 503/.test(err), err);
  g.ctx.OFF_SHEETJS.sri = realSri;
}

console.log('\n[3] samples 실파일 — 브라우저 경로 = GAS 경로(행·파싱 결과 완전 일치)');
if (!XLSX_DIR) {
  console.log('  SKIP  SheetJS가 없어 건너뜀 (XLSX_PATH=<SheetJS 모듈 폴더> 로 실행하면 검사)');
} else {
  const libFile = path.join(XLSX_DIR, 'dist', 'xlsx.full.min.js');
  const XN = require(XLSX_DIR), PN = require(PARSERS);
  const g = loadOfflineGas({ today: '2026-10-06' });
  // GAS 흉내 — 실제 라이브러리를 CDN 대신 내려 주고, GAS에 없는 TextDecoder·TextEncoder를 감춘 채 로드·읽기
  const libSrc = fs.readFileSync(libFile, 'utf8');
  global.UrlFetchApp.fetch = () => ({ getResponseCode: () => 200, getContentText: () => libSrc });
  const hidden = { TextDecoder: global.TextDecoder, TextEncoder: global.TextEncoder };
  delete global.TextDecoder; delete global.TextEncoder;
  try {
    const x = g.ctx._offXlsx();
    check('실제 SheetJS ' + x.version + ' — 저장소의 SRI 값으로 무결성 확인 통과(= 브라우저가 쓰는 그 파일)', x.version === '0.20.3' && x !== XN);
    const SAMPLES = path.join(PROJ, 'samples');
    const files = fs.existsSync(SAMPLES) ? fs.readdirSync(SAMPLES).filter(f => /\.(xlsx|xls)$/i.test(f)) : [];
    if (!files.length) console.log('  SKIP  samples/ 에 파일이 없음');
    const opts = f => ({ fileName: f, today: '2026-10-06', stockOffsets: { etland: -1, emart: -1, traders: -1 } });
    const PII = ['주문자명', '주문자ID', '주문자 전화번호', '주문자 휴대폰', '수취인명', '수취인 전화번호', '수취인 휴대폰', '우편번호', '주소', '송장번호'];
    files.forEach(f => {
      const buf = fs.readFileSync(path.join(SAMPLES, f));
      const browserRows = PN.dropUnusedColumns(PN.readWorkbookRows(XN, new Uint8Array(buf)).rows);
      const signed = Array.from(buf, b => (b > 127 ? b - 256 : b)); // Blob.getBytes()
      const gasRows = g.ctx._offInboxReadRows(signed);
      const a = PN.parseRows(browserRows, opts(f)), b = g.ctx.OfflineParsers.parseRows(gasRows, opts(f));
      const piiLeft = /매출이익리스트/.test(f) ? PII.filter(h => J(gasRows).indexOf(h) >= 0) : [];
      check(f + ' — 행 ' + browserRows.length + ' · ' + (a.ok ? a.type : '판별 불가') + ' · 2차원 배열·파싱 결과 같음' + (piiLeft.length ? '' : (/매출이익리스트/.test(f) ? ' · 개인정보 열 없음' : '')),
        J(browserRows) === J(gasRows) && J(a) === J(b) && !piiLeft.length, { rows: J(browserRows) === J(gasRows), parse: J(a) === J(b), piiLeft });
    });
  } finally {
    Object.assign(global, hidden);
  }
}

console.log('\n' + '─'.repeat(50));
console.log('통과 ' + pass + ' / 실패 ' + fail);
process.exit(fail ? 1 : 0);
