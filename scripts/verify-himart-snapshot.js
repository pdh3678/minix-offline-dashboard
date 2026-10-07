/* 하이마트 불완전 파일 대응(2026-10-07) 실파일 대조 — 로컬 확인용(테스트 아님, 데이터 파일은 커밋하지 않는다). 출력은 합계·건수뿐이다.
   하이마트 판매재고현황 실파일(당일 날짜로 받은 불완전 파일 포함)과 samples/ 다른 채널 실파일로:

   A. 운영 재현 — 바꾸기 전 GAS(git BEFORE_REF)로 전부 반영(불완전 파일도 그대로 들어간다 — 운영에서 일어난 일) → 시트를 지금 GAS로 옮겨
      불완전 날짜 스냅샷을 최신부터 지운다. 지우기 전후: 스냅샷 기준일별 행 수 · 판매원장 하이마트 기간종료일별(음수) · 10월 합계 ·
      재고_점포최신/재고_채널일별 하이마트 기준일. 확인: 음수 사라짐, 10월 합계 = 마지막 완전한 파일의 당월판매 합계, 다른 채널 불변
      (바꾸기 전 스냅샷은 판매 행만이라 재고_점포최신은 판매 있던 행만 되살아난다 — 그 행 수를 보여 준다)
   B. 지금 GAS로 처음부터 — 불완전 파일은 수동(미리보기 우회 = 서버)·자동 반영(실제 SheetJS·수신함) 모두 차단되는지,
      [그래도 반영]으로 넣은 뒤 지우면 = 그 파일들을 올리지 않은 결과와 칸 단위로 같은지(판매원장·재고 세 탭·다른 채널)

   불완전 파일 = 원본 행 수가 바로 앞 날짜 파일의 절반 미만인 하이마트 파일(급감 규칙과 같은 기준).
   실행: XLSX_PATH=<SheetJS 모듈 폴더> [BEFORE_REF=HEAD] [TODAY=2026-10-07] node scripts/verify-himart-snapshot.js <하이마트 파일 폴더> [다른 채널 파일 폴더(기본 samples)] */
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), crypto = require('crypto');
const PROJ = path.join(__dirname, '..');
const { loadOfflineGas, dataRows, installDrive, installScriptApp } = require(path.join(PROJ, 'tests', 'lib', 'offline-gas.js'));
const P = require(path.join(PROJ, 'src', 'features', 'offline', 'parsers.js'));
let XLSX_DIR;
try { XLSX_DIR = path.dirname(require.resolve(path.join(process.env.XLSX_PATH || 'xlsx', 'package.json'))); } catch (e) { console.error('SheetJS가 없습니다. XLSX_PATH=<xlsx 모듈 폴더> 로 실행하세요.'); process.exit(2); }
const XN = require(XLSX_DIR);
if (!process.argv[2]) { console.error('하이마트 판매재고현황 파일 폴더를 인자로 주세요.'); process.exit(2); }
const HM_DIR = process.argv[2], OTHER_DIR = process.argv[3] || path.join(PROJ, 'samples');
const REF = process.env.BEFORE_REF || 'HEAD', TODAY = process.env.TODAY || '2026-10-07', AUTH = { email: 'verify@local' };
const J = JSON.stringify, ok = b => (b ? 'OK' : '불일치');
const GAS_FILES = ['apps-script.js', 'apps-script-offline.js', 'apps-script-offline-targets.js', 'apps-script-offline-inventory.js', 'apps-script-home.js', 'src/features/offline/parsers.js', 'apps-script-offline-inbox.js'];

const read = (dir, f) => { const bytes = fs.readFileSync(path.join(dir, f)); return { f, bytes, rows: P.dropUnusedColumns(P.readWorkbookRows(XN, bytes).rows) }; };
const parse = (x, edits) => P.parseRows(x.rows, Object.assign({ fileName: x.f, today: TODAY, stockOffsets: { etland: -1, emart: -1, traders: -1 } }, edits || {}));
const hm = fs.readdirSync(HM_DIR).filter(f => /^판매재고현황_\d{8}\.xlsx$/.test(f)).sort().map(f => read(HM_DIR, f)).map(x => Object.assign(x, { p: parse(x) }));
// 다른 채널 — 판별되고 반영 가능한 파일만, 수동 "전체 반영"과 같은 순서(일별상세 → 재고현황_상세 → 나머지)
const rank = n => (/일별상세/.test(n) ? 0 : /재고현황_상세/.test(n) ? 1 : 2);
const others = fs.readdirSync(OTHER_DIR).filter(f => /\.(xlsx|xls)$/i.test(f) && f.indexOf('~$') !== 0 && !/^판매재고현황_/.test(f)).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))
  .map(f => read(OTHER_DIR, f)).map(x => Object.assign(x, { p: parse(x) })).filter(x => x.p.ok && !x.p.blocked);
// 불완전 = 앞의 마지막 완전한 파일 원본 행 수의 절반 미만(불완전 파일이 이어져도 — 10/6 12행 다음 10/7 22행)
let lastRows = 0;
hm.forEach(x => { x.partial = lastRows > 0 && x.p.rawRowCount < lastRows * 0.5; if (!x.partial) lastRows = x.p.rawRowCount; });
const lastFull = hm.filter(x => !x.partial).pop(), partials = hm.filter(x => x.partial);
const monthSaleOf = x => x.p.records.himart.reduce((s, h) => s + h.sale, 0);
console.log('[하이마트 파일] ' + hm.map(x => x.p.baseDate + ' ' + x.p.rawRowCount + '행' + (x.partial ? '(불완전)' : '')).join(' · '));
console.log('[다른 채널 파일] ' + others.map(x => x.f.slice(0, 28)).join(' · '));
if (!partials.length) console.log('⚠ 불완전 파일이 없습니다 — 삭제 대조는 건너뜁니다');

function mk(dir) {
  const g = loadOfflineGas({ setup: true, today: TODAY, dir });
  let n = 0;
  g.ctx.Utilities.getUuid = () => String(++n).padStart(4, '0') + '-uuid';
  g.rows = nm => dataRows(g.tab(nm));
  return g;
}
function upload(g, x, opts) {
  const pl = P.toUploadPayload(x.p, { fileName: x.f, customers: [] });
  if (opts && opts.force) pl.meta.allowShrink = true;
  try { return g.ctx._offUpload(pl, AUTH, opts && opts.server); } catch (e) { return { error: String(e.message || e) }; }
}
const loadAll = (g, list, force) => list.forEach(x => { const r = upload(g, x, { force }); if (r.error) console.log('  (반영 안 됨: ' + x.f + ' — ' + r.error.slice(0, 80) + ')'); });
const hmSales = g => g.rows('판매원장').filter(r => r[3] === 'himart');
const oct = g => hmSales(g).filter(r => r[1] >= TODAY.slice(0, 8) + '01').reduce((s, r) => s + (Number(r[6]) || 0), 0);
const notHm = (g, nm, c) => J(g.rows(nm).filter(r => r[c] !== 'himart'));
// 다른 환경끼리 비교할 때 — upload_id(반영 시각이 들어 있다)를 뺀다
const otherNoId = g => J(noId(g.rows('판매원장').filter(r => r[3] !== 'himart'), 9)) + J(noId(g.rows('재고_채널일별').filter(r => r[1] !== 'himart'), 6)) + J(noId(g.rows('재고_점포최신').filter(r => r[1] !== 'himart'), 9));
const noId = (rows, c) => rows.map(r => J(r.filter((v, i) => i !== c))).sort();
function picture(g, label) {
  const snap = {}, led = {};
  g.rows('하이마트_누적스냅샷').forEach(r => { if (r[0] >= '2026-09-28') snap[r[0]] = (snap[r[0]] || 0) + (r[2] ? 1 : 0); });
  hmSales(g).forEach(r => { if (r[1] < '2026-09-28') return; const o = led[r[1]] || (led[r[1]] = { 단위: r[2] === 'day' ? 'day' : r[0] + '~', 레코드: 0, 수량: 0, 음수: 0, 음수합: 0 }); o.레코드++; o.수량 += r[6]; if (r[6] < 0) { o.음수++; o.음수합 += r[6]; } });
  const ss = g.rows('재고_점포최신').filter(r => r[1] === 'himart'), sd = g.rows('재고_채널일별').filter(r => r[1] === 'himart');
  const sdDate = sd.reduce((m, r) => (r[0] > m ? r[0] : m), '');
  console.log('\n── ' + label + ' ──');
  console.log('하이마트_누적스냅샷 기준일별 행 수: ' + Object.keys(snap).sort().map(d => d.slice(5) + ' ' + snap[d]).join(' · '));
  console.table(Object.keys(led).sort().map(d => Object.assign({ 기간종료: d }, led[d])));
  console.log('10월 판매원장 합계 ' + oct(g) + ' · 재고_점포최신 하이마트 ' + (ss[0] ? ss[0][0] : '—') + ' ' + ss.length + '행(재고 ' + ss.reduce((s, r) => s + r[4], 0) + ') · 재고_채널일별 하이마트 최신 ' + sdDate +
    '(재고 ' + sd.filter(r => r[0] === sdDate).reduce((s, r) => s + r[3], 0) + ')');
}

// ━━ A. 운영 재현 ━━
console.log('\n━━ A. 운영 재현 — 바꾸기 전 GAS(' + REF + ')로 반영 → 지금 GAS로 불완전 스냅샷 삭제 ━━');
const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'himart-before-'));
GAS_FILES.forEach(f => { const to = path.join(oldDir, f); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, cp.execFileSync('git', ['show', REF + ':' + f], { cwd: PROJ, maxBuffer: 64 << 20 })); });
const go = mk(oldDir);
loadAll(go, others); loadAll(go, hm);
const grids = {};
go.off._order.forEach(nm => { grids[nm] = go.off._sheets[nm]._grid.map(r => r.slice()); });
const ga = mk(); // 지금 GAS — 같은 시트로
Object.keys(grids).forEach(nm => { if (ga.off._sheets[nm]) ga.off._sheets[nm]._grid = grids[nm].map(r => r.slice()); });
picture(ga, '지우기 전(운영과 같은 상태)');
const keepA = { s: notHm(ga, '판매원장', 3), d: notHm(ga, '재고_채널일별', 1), t: notHm(ga, '재고_점포최신', 1) };
const resA = partials.slice().reverse().map(x => {
  const id = (ga.rows('업로드로그').filter(r => r[4] === 'HIMART_SALES_STOCK' && r[6] === x.p.baseDate && r[11] === '성공').pop() || [])[0];
  return Object.assign({ 날짜: x.p.baseDate }, JSON.parse(ga.ctx._offlineHandle('offline_deleteHimartSnapshot', { date: x.p.baseDate, uploadId: id }, AUTH)));
});
console.table(resA.map(r => ({ 삭제: r.날짜, 결과: r.error ? '실패: ' + r.error : '성공', 스냅샷행: r.snapshotRows, 판매원장지움: r.salesRemoved, 재계산: r.recomputed ? r.recomputed.date + ' ' + r.recomputed.unit : '—',
  점포재고복원: r.stockStore ? (r.stockStore.from || '비움') + ' ' + r.stockStore.rows + '행/파일 ' + r.stockStore.fileRows + '행' : '그대로', 채널재고지움: r.stockDailyRemoved })));
picture(ga, '지운 뒤');
// 불완전 날짜에 남은 판매 레코드(그 날 음수의 출처) — 0이어야 한다. 그 밖의 음수는 원래 파일의 반품(당월판매가 줄어든 점포·상품)이라 그대로
const pDates = {}; partials.forEach(x => { pDates[x.p.baseDate] = true; });
const leftA = hmSales(ga).filter(r => pDates[r[1]]).length, negA = hmSales(ga).filter(r => r[6] < 0 && r[1] >= TODAY.slice(0, 8) + '01');
console.table([
  { 확인: '불완전 날짜(' + Object.keys(pDates).join('·') + ') 하이마트 판매 레코드 없음(대량 음수 사라짐)', 결과: ok(!leftA), 값: leftA },
  { 확인: '남은 10월 음수 = 원래 파일의 반품만', 결과: '참고', 값: negA.length + '건(' + negA.map(r => r[1].slice(5) + ' ' + r[6]).join(', ') + ')' },
  { 확인: '10월 판매 합계 = 마지막 완전한 파일(' + lastFull.p.baseDate + ') 당월판매 합계', 결과: ok(oct(ga) === monthSaleOf(lastFull)), 값: oct(ga) + ' / ' + monthSaleOf(lastFull) },
  { 확인: '재고_점포최신 하이마트 기준일 = ' + lastFull.p.baseDate, 결과: ok(ga.rows('재고_점포최신').filter(r => r[1] === 'himart').every(r => r[0] === lastFull.p.baseDate)), 값: '' },
  { 확인: '다른 채널 판매원장·재고 두 탭 불변', 결과: ok(notHm(ga, '판매원장', 3) === keepA.s && notHm(ga, '재고_채널일별', 1) === keepA.d && notHm(ga, '재고_점포최신', 1) === keepA.t), 값: '' }]);
const chk = ga.ctx.offline_himartCheck('2026-09-28');
console.log('offline_himartCheck 월 누적 대조: ' + (chk.ok ? '모두 같음' : '⚠ 다름') + ' — ' + chk.monthCheck.map(x => x.date.slice(5) + ' ' + x.ledger + '/' + x.monthSale).join(' · '));

// ━━ B. 지금 GAS로 처음부터 ━━
console.log('\n━━ B. 지금 GAS — 불완전 파일 차단(수동·자동), [그래도 반영] 뒤 삭제 = 올리지 않은 것 ━━');
const full = hm.filter(x => !x.partial);
const ref = (() => { const g = mk(); loadAll(g, others); loadAll(g, full);
  return { s: noId(hmSales(g), 9), t: noId(g.rows('재고_점포최신').filter(r => r[1] === 'himart'), 9), d: noId(g.rows('재고_채널일별').filter(r => r[1] === 'himart'), 6),
    o: otherNoId(g) }; })();
const gb = mk();
loadAll(gb, others); loadAll(gb, full);
const before = ['판매원장', '하이마트_누적스냅샷', '재고_점포최신', '재고_채널일별'].map(nm => J(gb.rows(nm))).join('|');
const blocked = partials.map(x => {
  const man = upload(gb, x), auto = upload(gb, x, { force: true, server: { strict: true, auto: { fileId: 'F-' + x.f, modifiedTime: 't', md5: 'm' } } });
  return { 파일: x.f, 원본행: x.p.rawRowCount, 수동: man.error ? '차단' : '⚠ 반영됨', '자동(allowShrink여도)': auto.error ? '차단' : '⚠ 반영됨', 사유: (man.error || '').slice(0, 60) };
});
console.table(blocked);
// 실제 수신함 경로 — 실제 SheetJS(GAS처럼 TextDecoder 없이)로 읽어 반영 → 오류 폴더
gb.scriptProps.OFFLINE_INBOX_FOLDER_ID = 'INBOX';
const d = installDrive(); installScriptApp();
d.add({ id: 'INBOX', name: '오프라인 수신함', mimeType: d.FOLDER, parents: ['SHARED-ROOT'] });
partials.forEach(x => d.add({ name: x.f, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parents: ['INBOX'], md5Checksum: crypto.createHash('md5').update(x.bytes).digest('hex'),
  size: String(x.bytes.length), lastModifyingUser: { emailAddress: 'partner@athomecorp.com' }, bytes: x.bytes }));
const libSrc = fs.readFileSync(path.join(XLSX_DIR, 'dist', 'xlsx.full.min.js'), 'utf8');
global.UrlFetchApp.fetch = () => ({ getResponseCode: () => 200, getContentText: () => libSrc });
const hidden = { TextDecoder: global.TextDecoder, TextEncoder: global.TextEncoder };
delete global.TextDecoder; delete global.TextEncoder;
gb.ctx.OFF_INBOX_API_PER_MIN = 1e9;
const st = gb.ctx._offInboxRun('manual:verify@local');
Object.assign(global, hidden);
const errFolder = (Object.values(d.files).find(f => f.name === '오류' && f.mimeType === d.FOLDER) || {}).id;
console.table(st.files.map(f => ({ 파일: f.name, 결과: f.result, '오류 폴더': d.in(errFolder).some(x => x.name === f.name) ? '예' : '아니오', 사유: String(f.detail).slice(0, 70) })));
const untouched = ['판매원장', '하이마트_누적스냅샷', '재고_점포최신', '재고_채널일별'].map(nm => J(gb.rows(nm))).join('|') === before;
// [그래도 반영] 뒤 삭제
loadAll(gb, partials, true);
partials.slice().reverse().forEach(x => gb.ctx._offlineHandle('offline_deleteHimartSnapshot', { date: x.p.baseDate }, AUTH));
console.table([
  { 확인: '자동 반영 — 불완전 파일 ' + partials.length + '개 모두 오류(수동과 같은 사유)', 결과: ok(st.counts.error === partials.length && st.files.every(f => /^직전 대비 행 수 급감/.test(f.detail))) },
  { 확인: '차단(수동·자동) 동안 판매원장·스냅샷·재고 두 탭 그대로', 결과: ok(untouched) },
  { 확인: '[그래도 반영] 뒤 삭제 — 판매원장 하이마트 = 올리지 않은 결과', 결과: ok(J(noId(hmSales(gb), 9)) === J(ref.s)) },
  { 확인: '  재고_점포최신 하이마트 = 올리지 않은 결과(전 행 복원)', 결과: ok(J(noId(gb.rows('재고_점포최신').filter(r => r[1] === 'himart'), 9)) === J(ref.t)) },
  { 확인: '  재고_채널일별 하이마트 = 올리지 않은 결과', 결과: ok(J(noId(gb.rows('재고_채널일별').filter(r => r[1] === 'himart'), 6)) === J(ref.d)) },
  { 확인: '  다른 채널 판매원장·재고 두 탭 = 같음', 결과: ok(otherNoId(gb) === ref.o) }]);
