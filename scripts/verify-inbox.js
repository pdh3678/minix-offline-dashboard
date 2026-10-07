/* 드라이브 수신함 자동 반영 — samples 실파일 대조 (2026-10-06). 로컬 확인용(테스트 아님, 데이터 파일은 커밋하지 않는다). 출력은 합계·건수뿐이다.
   ① 실파일 전부를 목 드라이브 수신함에 넣고 [지금 확인](_offInboxRun) — 실제 SheetJS(CDN 대신 로컬 파일, 저장소 SRI로 확인)·GAS에 없는 TextDecoder를 감춘 채
   ② 결과 표: 파일 · 판별 유형 · 결과(반영/오류/건너뜀) · Sheets API 호출 수 · 내용
   ③ 개인정보: ERP 실파일의 개인정보 열(주문자·수취인·연락처·주소·송장번호) 값이 시트·업로드로그·상태·실행 로그 어디에도 없는지(건수만 출력)
   ④ 같은 실파일을 같은 순서로 수동 업로드(브라우저 경로 — node SheetJS + parsers.js → offline_upload)한 시트와 칸 단위 대조
   ⑤ 같은 파일 재투입 → 건너뜀 · 임시 파일 없음

   실행: XLSX_PATH=<SheetJS 모듈 폴더> node scripts/verify-inbox.js [samples 폴더] */
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const PROJ = path.join(__dirname, '..');
const { loadOfflineGas, dataRows, installDrive, installScriptApp } = require(path.join(PROJ, 'tests', 'lib', 'offline-gas.js'));
const P = require(path.join(PROJ, 'src', 'features', 'offline', 'parsers.js'));
let XLSX_DIR;
try { XLSX_DIR = path.dirname(require.resolve(path.join(process.env.XLSX_PATH || 'xlsx', 'package.json'))); } catch (e) { console.error('SheetJS가 없습니다. XLSX_PATH=<xlsx 모듈 폴더> 로 실행하세요.'); process.exit(2); }
const XN = require(XLSX_DIR);
const SAMPLES = process.argv[2] || path.join(PROJ, 'samples');
const TODAY = '2026-10-06', J = JSON.stringify, ok = b => (b ? 'OK' : '불일치');
// '~$'로 시작하는 파일 = 엑셀이 열어 둔 파일의 잠금 파일 — 수신함도 손대지 않는다(실파일로만 대조)
const files = fs.readdirSync(SAMPLES).filter(f => /\.(xlsx|xls)$/i.test(f) && f.indexOf('~$') !== 0).map(f => ({ name: f, bytes: fs.readFileSync(path.join(SAMPLES, f)) }));
const libSrc = fs.readFileSync(path.join(XLSX_DIR, 'dist', 'xlsx.full.min.js'), 'utf8');

// 개인정보 값 모음 — ERP 실파일의 개인정보 열(브라우저처럼 읽되 열을 버리기 전)
const PII_HEAD = ['주문자명', '주문자ID', '주문자 전화번호', '주문자 휴대폰', '수취인명', '수취인 전화번호', '수취인 휴대폰', '우편번호', '주소', '송장번호'];
const pii = new Set();
files.filter(f => /매출이익리스트/.test(f.name)).forEach(f => {
  const rows = P.readWorkbookRows(XN, new Uint8Array(f.bytes)).rows, hi = rows.findIndex(r => r && r.indexOf('주문자명') >= 0);
  if (hi < 0) return;
  const cols = PII_HEAD.map(h => rows[hi].indexOf(h)).filter(c => c >= 0);
  rows.slice(hi + 1).forEach(r => cols.forEach(c => { const v = String(r[c] == null ? '' : r[c]).trim(); if (v.length >= 4) pii.add(v); }));
});

// ① 자동 반영
const g = loadOfflineGas({ setup: true, today: TODAY });
let n = 0;
g.ctx.Utilities.getUuid = () => String(++n).padStart(4, '0') + '-uuid';
g.scriptProps.OFFLINE_INBOX_FOLDER_ID = 'INBOX';
const d = installDrive();
installScriptApp();
d.add({ id: 'INBOX', name: '오프라인 수신함', mimeType: d.FOLDER, parents: ['SHARED-ROOT'] });
files.forEach(f => d.add({ name: f.name, mimeType: /\.xls$/i.test(f.name) ? 'application/vnd.ms-excel' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parents: ['INBOX'],
  md5Checksum: crypto.createHash('md5').update(f.bytes).digest('hex'), size: String(f.bytes.length), lastModifyingUser: { emailAddress: 'partner@athomecorp.com' }, bytes: f.bytes }));
global.UrlFetchApp.fetch = () => ({ getResponseCode: () => 200, getContentText: () => libSrc });
const logs = [];
global.Logger.log = s => { logs.push(String(s)); };
const hidden = { TextDecoder: global.TextDecoder, TextEncoder: global.TextEncoder };
delete global.TextDecoder; delete global.TextEncoder;
const before = Object.keys(d.files).length, t0 = Date.now();
g.ctx.OFF_INBOX_API_PER_MIN = 1e9; // 로컬 대조 — 분당 상한 기다림은 테스트(tests/offline-inbox.test.js)가 본다
const st = g.ctx._offInboxRun('manual:verify@local');
const ms = Date.now() - t0;
Object.assign(global, hidden);
global.Logger.log = () => {};

console.log('① 수신함 ' + files.length + '개 → [지금 확인] (' + Math.round(ms / 1000) + '초, 실제 SheetJS ' + (g.ctx._offXlsxLib && g.ctx._offXlsxLib.version) + ' · SRI 확인)');
const typeOf = name => { const r = P.parseRows(P.dropUnusedColumns(P.readWorkbookRows(XN, new Uint8Array(files.find(f => f.name === name).bytes)).rows), { fileName: name, today: TODAY }); return r.ok ? r.type : '판별 불가'; };
console.table(st.files.map(f => ({ 파일: f.name.slice(0, 40), 유형: typeOf(f.name), 결과: f.result, 'Sheets API': f.apiCalls, 내용: String(f.detail).slice(0, 70) })));
console.log('반영 ' + st.counts.success + ' · 오류 ' + st.counts.error + ' · 건너뜀 ' + st.counts.skipped + ' · 다음 실행으로 ' + st.counts.deferred + ' · 실행 전체 Sheets API ' + st.apiCalls + '회' + (st.note ? ' · ' + st.note : ''));

// ③ 개인정보
const everything = J(g.off._order.map(nm => g.tab(nm)._grid)) + J(st) + logs.join('\n') + J(g.scriptProps);
let leaks = 0;
pii.forEach(v => { if (everything.indexOf(v) >= 0) leaks++; });
console.log('\n③ 개인정보 — ERP 개인정보 열 값 ' + pii.size + '종 중 시트·업로드로그·상태·실행 로그·스크립트 속성에 남은 것: ' + leaks + '종 : ' + ok(pii.size > 0 && leaks === 0));

// ⑤ 재투입·임시 파일
const okFile = files.find(f => st.files.some(x => x.name === f.name && x.result === 'success'));
d.add({ name: okFile.name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parents: ['INBOX'], md5Checksum: crypto.createHash('md5').update(okFile.bytes).digest('hex'),
  lastModifyingUser: { emailAddress: 'partner@athomecorp.com' }, bytes: okFile.bytes });
const salesBefore = J(dataRows(g.tab('판매원장'))), logBefore = dataRows(g.tab('업로드로그')).length;
const st2 = g.ctx._offInboxRun('manual:verify@local');
const newFiles = Object.values(d.files).filter(f => f.mimeType !== d.FOLDER).length - files.length - 1;
console.log('⑤ 같은 파일 재투입(' + okFile.name.slice(0, 30) + ') → 건너뜀 ' + st2.counts.skipped + ' · 판매원장·업로드로그 그대로: ' + ok(st2.counts.skipped === 1 && J(dataRows(g.tab('판매원장'))) === salesBefore && dataRows(g.tab('업로드로그')).length === logBefore) +
  ' · 임시 파일 ' + newFiles + '개 · 새로 생긴 드라이브 항목 = 하위 폴더 ' + (Object.keys(d.files).length - before - 1) + '개(처리완료·오류) : ' + ok(newFiles === 0));
const auto = {};
g.off._order.forEach(nm => { auto[nm] = dataRows(g.tab(nm)); });
const autoLog = auto['업로드로그'];

// ④ 같은 순서로 수동 업로드(브라우저 경로)
const gm = loadOfflineGas({ setup: true, today: TODAY }); // g는 여기서 끝 — 같은 전역을 쓴다
let m = 0;
gm.ctx.Utilities.getUuid = () => String(++m).padStart(4, '0') + '-uuid';
const offsets = {};
gm.ctx._offReadRows(gm.tab('채널마스터'), gm.ctx.OFF_TABS.channel).forEach(r => { const o = gm.ctx._offStockOffsetOf(r); if (r[0] && o) offsets[r[0]] = o; });
st.files.filter(f => f.result === 'success').forEach(f => {
  const bytes = files.find(x => x.name === f.name).bytes;
  const p = P.parseRows(P.dropUnusedColumns(P.readWorkbookRows(XN, new Uint8Array(bytes)).rows), { fileName: f.name, today: TODAY, stockOffsets: offsets });
  gm.ctx._offUpload(P.toUploadPayload(p, { fileName: f.name }), { email: 'verify@local' });
});
// upload_id(반영 시각 + 일련번호)는 실행마다 다르다 — 그 업로드의 파일명으로 바꿔 놓고 비교한다
const byId = log => { const o = {}; log.forEach(r => { o[r[0]] = 'ID:' + r[3]; }); return o; };
const norm = (rows, ids) => J(rows.map(r => r.map(v => (ids[v] || v))));
const mlog = dataRows(gm.tab('업로드로그')), aIds = byId(autoLog), mIds = byId(mlog);
// 제외코드 등록자 = 반영한 사람(자동 반영은 파일 마지막 수정자) — 업로드로그 업로더처럼 빼고 비교한다
const who = (nm, rows) => (nm === '제외코드' ? rows.map(r => r.slice(0, 5)) : rows);
const same = nm => norm(who(nm, dataRows(gm.tab(nm))), mIds) === norm(who(nm, auto[nm]), aIds);
const tabDiff = gm.off._order.filter(nm => nm !== '업로드로그' && !same(nm));
const aOk = autoLog.filter(r => r[11] === '성공');
const logSame = aOk.length === mlog.length && aOk.every((r, i) => J(r.slice(3, 12)) === J(mlog[i].slice(3, 12)));
console.log('\n④ 같은 실파일을 같은 순서로 수동 업로드한 결과와 대조 (upload_id는 그 업로드의 파일명으로 바꿔 비교)');
console.table(gm.off._order.filter(nm => nm !== 'README').map(nm => ({ 탭: nm, '자동 행': (auto[nm] || []).length, '수동 행': dataRows(gm.tab(nm)).length,
  결과: nm === '업로드로그' ? ok(logSame) + '(성공 행의 파일명~상태, 반영방식만 다름)' : nm === '제외코드' ? ok(same(nm)) + '(등록자만 다름)' : ok(same(nm)) })));
const all = !tabDiff.length && logSame && leaks === 0 && st2.counts.skipped === 1 && newFiles === 0;
console.log(all ? '모두 같음 — 자동 반영 = 수동 업로드' : '⚠ 다른 곳: ' + tabDiff.join(', '));
process.exit(all ? 0 : 1);
