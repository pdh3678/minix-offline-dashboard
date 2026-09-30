/* ERP 매출이익리스트 실데이터 대조 — 로컬 확인용(테스트 아님, 데이터 파일은 커밋하지 않는다). 출력은 합계·건수뿐이다(개인정보·주문번호는 찍지 않음).
   실파일을 브라우저와 같은 경로(dropUnusedColumns → parseRows → toUploadPayload)로 읽어 GAS 실코드(목 시트)에 두 번 반영한다.

   실행: XLSX_PATH=<SheetJS 모듈 경로> node scripts/verify-erp-sales.js <매출이익리스트.xlsx> [오프라인원장.xlsx]
   ① 파일 행수·금액 합·거래처별 금액 ② 무상 동봉 제외 뒤 채널별 수량·금액 ③ 반영 뒤 9월 채널별 IN·OUT 금액 = 파일 거래처별 금액
   (본품 + 필터 + 기타 + 미매칭) ④ 개인정보 열 값이 페이로드·시트·업로드로그에 없음 ⑤ 두 번 반영해도 행 수 불변
   ⑥ 포털 채널 9월 금액·수량 불변(원장 사본을 주면 그 사본, 없으면 합성 포털 행) ⑦ 파트 홈 특수 채널군 = 폐쇄몰·렌탈 채널 합
   코드 매핑은 확인용으로만 목 시트에 넣는다(상품명의 모델명 → 카탈로그 모델, 필터·타 브랜드는 대분류 제안) — 운영 매핑은 사람이 한다. */
const path = require('path'), fs = require('fs');
const PROJ = path.join(__dirname, '..');
const { loadOfflineGas } = require(path.join(PROJ, 'tests', 'lib', 'offline-gas.js'));
const P = require(path.join(PROJ, 'src', 'features', 'offline', 'parsers.js'));
const R = require(path.join(PROJ, 'src', 'features', 'offline', 'resolver.js'));
let XLSX;
try { XLSX = require(process.env.XLSX_PATH || 'xlsx'); } catch (e) { console.error('SheetJS가 없습니다. XLSX_PATH=<xlsx 모듈 경로> 로 실행하세요.'); process.exit(2); }
const [erpFile, ledgerFile] = process.argv.slice(2);
if (!erpFile) { console.error('매출이익리스트 xlsx 경로를 주세요.'); process.exit(2); }
const AUTH = { email: 'verify@local' }, YM = '2026-09';
const won = v => (v == null ? '—' : Math.round(v).toLocaleString('ko-KR'));
const ok = b => (b ? 'OK' : '불일치');

// 0) 원본 — 개인정보 열 값 모음(대조용, 출력하지 않는다)과 파일 합계
const raw = P.readWorkbookRows(XLSX, fs.readFileSync(erpFile)).rows;
const head = raw[1].map(P.normHeader), col = n => head.indexOf(P.normHeader(n));
const PII_COLS = ['주문자명', '주문자ID', '주문자 전화번호', '주문자 휴대폰', '수취인명', '수취인 전화번호', '수취인 휴대폰', '우편번호', '주소', '송장번호', '주문번호'];
const piiVals = new Set();
raw.slice(2).forEach(r => PII_COLS.forEach(h => { const v = String(r[col(h)] == null ? '' : r[col(h)]).trim(); if (v.length >= 4) piiVals.add(v); }));
// 숫자만 있는 값(우편번호 5자리 등)은 앞뒤가 숫자가 아닐 때만 — 금액 1,234,500 속의 '23450' 같은 우연한 겹침은 세지 않는다
const piiIn = s => { let n = 0; piiVals.forEach(v => { let i = s.indexOf(v); while (i >= 0) { if (!/^\d+$/.test(v) || (!/\d/.test(s[i - 1] || '') && !/\d/.test(s[i + v.length] || ''))) { n++; return; } i = s.indexOf(v, i + 1); } }); return n; };
const rawData = raw.slice(2).filter(r => r.some(v => v !== '' && v != null));
const byCustRaw = {};
rawData.forEach(r => { const k = String(r[col('거래처코드')]); byCustRaw[k] = (byCustRaw[k] || 0) + (Number(r[col('금액')]) || 0); });

// 1) 브라우저와 같은 경로로 파싱
const rows = P.dropUnusedColumns(raw);
const parsed = P.parseRows(rows, { fileName: path.basename(erpFile), today: '2026-09-30' });
if (!parsed.ok) { console.error('파싱 실패: ' + parsed.error); process.exit(1); }
const payload = P.toUploadPayload(parsed, { fileName: path.basename(erpFile) });
const EXPECT = { total: 1845172632, rows: 11342, cust: { '00474': 1575494940, '00261': 113279600, '00260': 37562922, '00604': 14927990 }, shinsegae: 103907180 };
const shinsegaeRaw = ['00476', '00440', '00580', '00608', '00619'].reduce((s, k) => s + (byCustRaw[k] || 0), 0);
console.log('\n① 파일 — 기대값 대조');
console.table([
  { 항목: '전체 행수', 기대: EXPECT.rows, 파일: rawData.length, 파서: parsed.rawRowCount, 결과: ok(rawData.length === EXPECT.rows && parsed.rawRowCount === EXPECT.rows) },
  { 항목: '전체 금액 합', 기대: won(EXPECT.total), 파일: won(parsed.summary.fileAmount), 파서: won(payload.records.sales.reduce((s, x) => s + x.amt, 0)), 결과: ok(parsed.summary.fileAmount === EXPECT.total && payload.records.sales.reduce((s, x) => s + x.amt, 0) === EXPECT.total) },
  { 항목: '디에이블앤 00474', 기대: won(EXPECT.cust['00474']), 파일: won(byCustRaw['00474']), 파서: won(parsed.summary.byCust.find(c => c.code === '00474').amount), 결과: ok(byCustRaw['00474'] === EXPECT.cust['00474']) },
  { 항목: '다파라솔루션 00261', 기대: won(EXPECT.cust['00261']), 파일: won(byCustRaw['00261']), 파서: won(parsed.summary.byCust.find(c => c.code === '00261').amount), 결과: ok(byCustRaw['00261'] === EXPECT.cust['00261']) },
  { 항목: '워크숍에이트 00260', 기대: won(EXPECT.cust['00260']), 파일: won(byCustRaw['00260']), 파서: won(parsed.summary.byCust.find(c => c.code === '00260').amount), 결과: ok(byCustRaw['00260'] === EXPECT.cust['00260']) },
  { 항목: '신세계 5개점', 기대: won(EXPECT.shinsegae), 파일: won(shinsegaeRaw), 파서: won(parsed.summary.byCust.filter(c => ['00476', '00440', '00580', '00608', '00619'].indexOf(c.code) >= 0).reduce((s, c) => s + c.amount, 0)), 결과: ok(shinsegaeRaw === EXPECT.shinsegae) },
  { 항목: '롯데백화점 본점 00604', 기대: won(EXPECT.cust['00604']), 파일: won(byCustRaw['00604']), 파서: won(parsed.summary.byCust.find(c => c.code === '00604').amount), 결과: ok(byCustRaw['00604'] === EXPECT.cust['00604']) }]);
console.log('수불구분', JSON.stringify(parsed.summary.gubun), '· 교체 기간', parsed.period.start + '~' + parsed.period.end, '(' + parsed.periodFrom + ') · day 레코드', payload.records.sales.length, '· 상품코드', parsed.codes.length + '종(무상 동봉만 있는 코드 제외)');

// 2) GAS 목 시트 — setup + (원장 사본 | 합성 포털 행) + 확인용 매핑
const g = loadOfflineGas({ setup: true, today: '2026-09-30' });
const T = g.ctx.OFF_TABS, read = k => g.ctx._offReadRows(g.tab(T[k].name), T[k]);
if (ledgerFile) {
  const wb = XLSX.readFile(ledgerFile, { raw: true });
  ['sku', 'mapping', 'store', 'sales', 'stockDaily', 'stockStore', 'uploadLog', 'targets', 'prices'].forEach(key => {
    const ws = wb.Sheets[T[key].name];
    if (!ws) return;
    const rs = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true }).slice(1).filter(r => r.some(v => v !== ''));
    const sh = g.tab(T[key].name);
    if (key !== 'store') sh._grid.length = 1;
    if (rs.length) g.ctx._offWriteBlock(sh, T[key], sh.getLastRow() + 1, rs.map(r => r.slice(0, T[key].headers.length)));
  });
} else {
  g.ctx._offWriteBlock(g.tab('판매원장'), T.sales, 2, [['2026-09-03', '2026-09-03', 'day', 'himart', 'S1', 'MNFD-200G', 8, 8, 'upload', 'U0'], ['2026-09-10', '2026-09-10', 'day', 'etland', '302001', 'MNFD-200G', 3, '', 'upload', 'U0']]);
  g.ctx._offWriteBlock(g.tab('단가마스터'), T.prices, 2, [['himart', '더플렌더', '더 플렌더 MAX', 400000, '2026-01-01', '', '', ''], ['etland', '더플렌더', '더 플렌더 MAX', 390000, '2026-01-01', '', '', '']]);
  g.ctx._offWriteBlock(g.tab('코드매핑'), T.mapping, 2, [['himart', 'MNFD-200G', 'SKU-9001', '정상', '', '', '', ''], ['etland', 'MNFD-200G', 'SKU-9001', '정상', '', '', '', '']]);
  g.ctx._offWriteBlock(g.tab('제품마스터'), T.sku, 2, [['SKU-9001', '더 플렌더 MAX', '더플렌더', '더 플렌더 MAX', '', 'Y', '', '']]);
}
// 확인용 매핑 — 모델명 → 카탈로그 모델, 대분류 제안(필터 모델 없음 = 미매칭으로 남김)
const MODEL = { 'MNFD-200G': ['더플렌더', '더 플렌더 MAX'], 'MNFD-300G': ['더플렌더', '더 플렌더 mini'], 'MNFD-120G': ['더플렌더', '더 플렌더 PRO'], 'MNKR-100G': ['더시프트', '더 시프트'],
  'MNMD-200G': ['더에어드라이', '더 에어드라이'], 'MNMD-120G': ['미니건조기', '미니 건조기 PRO+'], 'MNVC-100G': ['더슬림', '더 슬림'], 'MNDW-110G': ['미니식기세척기', '미니 식기세척기 PRO'],
  'MNDW-110OB': ['미니식기세척기', '미니 식기세척기 PRO'], 'MNDW-110CG': ['미니식기세척기', '미니 식기세척기 PRO'] };
const suggest = [], skuRows = [], mapRows = [];
let n = 9100;
parsed.codes.forEach(code => {
  const name = parsed.records.names[code] || '', info = parsed.summary.products[code] || {};
  const mc = R.extractModel(name), cs = R.suggestCategory({ name, brand: info.brand, cat: info.category });
  let line = '', model = '', how = '';
  if (MODEL[mc]) { line = MODEL[mc][0]; model = MODEL[mc][1]; how = '모델명 ' + mc; }
  else if (cs && cs.line === '기타') { line = '기타'; model = '기타'; how = '대분류 기타(' + cs.reason + ')'; }
  else if (cs && cs.line === '필터') { line = cs.model ? '필터' : ''; model = cs.model; how = '대분류 필터' + (cs.model ? ' ' + cs.model : ' — 모델 없음(새 모델 필요)'); }
  const q = payload.records.sales.filter(x => x.code === code);
  suggest.push({ 상품코드: code, 상품명: name.slice(0, 34), 브랜드: info.brand, 카테고리: info.category, 제안: how || '제안 없음', 수량: q.reduce((s, x) => s + x.qty, 0), 금액: won(q.reduce((s, x) => s + x.amt, 0)) });
  if (!line) return;
  const id = 'SKU-' + (++n);
  skuRows.push([id, model + (line === '기타' ? ' ' + name.slice(0, 20) : ''), line, model, line === '기타' ? name.slice(0, 20) : '', 'Y', '', '확인용']);
  mapRows.push(['erp', code, id, '정상', name, '', '', '확인용']);
});
g.ctx._offWriteBlock(g.tab('제품마스터'), T.sku, g.tab('제품마스터').getLastRow() + 1, skuRows);
g.ctx._offWriteBlock(g.tab('코드매핑'), T.mapping, g.tab('코드매핑').getLastRow() + 1, mapRows);
g.ctx._offInvalidateCache();
console.log('\n미매칭 상품코드(반영 전 = 전부) · 자동 제안(모델명 → 카탈로그 모델은 확인용 표기 — 운영에서는 같은 모델명이 매핑된 SKU가 제안된다)');
console.table(suggest);

const portalOf = mon => mon.totals.byChannelMonth.filter(x => x.ym === YM && ['himart', 'etland', 'emart', 'traders'].indexOf(x.channelId) >= 0)
  .map(x => J([x.channelId, x.in.actual, x.in.actualAmount, x.out.actual, x.out.actualAmount])).join('|');
const J = JSON.stringify;
const monthly = () => g.ctx._offMonthlyCompute({ from: YM, to: YM, channels: read('channel'), targets: read('targets'), prices: read('prices'), sales: read('sales'), mappings: read('mapping'), skus: read('sku') });
const portalBefore = portalOf(monthly());

// 3) 반영 두 번
const r1 = g.ctx._offUpload(payload, AUTH);
const n1 = read('sales').length, s1 = J(read('sales').map(r => r.slice(0, 9).concat(r.slice(10))));
const r2 = g.ctx._offUpload(P.toUploadPayload(parsed, { fileName: path.basename(erpFile) }), AUTH);
const n2 = read('sales').length, s2 = J(read('sales').map(r => r.slice(0, 9).concat(r.slice(10))));
const mon = monthly();
const chName = {}; read('channel').forEach(r => { chName[r[0]] = r[1]; });
const ERP = ['shinsegae', 'lotte_dept', 'theablen', 'workshop8', 'dapara'];
const custOf = { shinsegae: ['00476', '00440', '00580', '00608', '00619'], lotte_dept: ['00604'], theablen: ['00474'], workshop8: ['00260'], dapara: ['00261'] };
console.log('\n② 무상 동봉 제외 뒤 채널별 · ③ 반영 뒤 9월 IN·OUT 금액 = 파일 거래처 금액(본품 + 필터 + 기타 + 미매칭)');
console.table(ERP.map(ch => {
  const bc = mon.totals.byCategory.filter(x => x.ym === YM && x.channelId === ch), cm = mon.totals.byChannelMonth.find(x => x.ym === YM && x.channelId === ch) || { in: {}, out: {} };
  const um = mon.unmatched.filter(u => u.channelId === ch).reduce((s, u) => ({ q: s.q + u.qty, a: s.a + (u.amount || 0) }), { q: 0, a: 0 });
  const sumIn = bc.reduce((s, x) => s + (x.in.actualAmount || 0), 0) + um.a, sumOut = bc.reduce((s, x) => s + (x.out.actualAmount || 0), 0) + um.a;
  const file = custOf[ch].reduce((s, k) => s + (byCustRaw[k] || 0), 0);
  const ex = parsed.summary.byCust.filter(c => custOf[ch].indexOf(c.code) >= 0).reduce((s, c) => s + c.excludedQty, 0);
  const qty = bc.reduce((s, x) => s + (x.out.actual || 0), 0) + um.q;
  return { 채널: chName[ch], 판매수량: qty, '무상 동봉 제외 수량': ex, 'IN 금액(전 대분류+미매칭)': won(sumIn), 'OUT 금액': won(sumOut), '파일 금액': won(file), 결과: ok(sumIn === file && sumOut === file),
    '본품 IN 금액': won(cm.in.actualAmount), '필터': won((bc.find(x => x.category === '필터') || { in: {} }).in.actualAmount), '기타': won((bc.find(x => x.category === '기타') || { in: {} }).in.actualAmount), 미매칭금액: won(um.a) };
}));
const all = J(g.off.getSheets().map(s => s._grid));
const log = g.tab('업로드로그')._grid.slice(1).filter(r => r[4] === 'ERP_SALES_PROFIT');
console.log('\n④~⑦');
console.table([
  { 항목: '④ 개인정보 — 브라우저에 남긴 행(열 수)', 값: rows[0].length + '열 · 개인정보 값 ' + piiIn(J(rows)) + '건', 결과: ok(!piiIn(J(rows)) && rows[0].length === 11) },
  { 항목: '④ 개인정보 — 전송 페이로드', 값: (J(payload).length / 1024).toFixed(1) + 'KB · 개인정보 값 ' + piiIn(J(payload)) + '건', 결과: ok(!piiIn(J(payload))) },
  { 항목: '④ 개인정보 — 시트 전체(업로드로그 포함)', 값: '개인정보 값 ' + piiIn(all) + '건 · 업로드로그 ' + log.length + '행', 결과: ok(!piiIn(all)) },
  { 항목: '⑤ 같은 파일 2번 반영 — 판매원장 행 수', 값: n1 + ' → ' + n2 + (s1 === s2 ? ' (내용 동일)' : ' (내용 다름)'), 결과: ok(n1 === n2 && s1 === s2) },
  { 항목: '⑥ 포털 채널 9월 IN·OUT 수량·금액', 값: portalBefore === portalOf(mon) ? '반영 전과 같음' : '다름', 결과: ok(portalBefore === portalOf(mon)) },
  { 항목: '업로드 결과', 값: '판매 ' + r1.applied.sales + '행 · 교체 ' + r2.applied.salesRemoved + '행 · 미매칭 ' + r2.unmatched.length + '개 · 채널 ' + r1.channels.join(','), 결과: '' }]);
const home = g.ctx._homeSummaryCompute({ ym: YM, mode: 'month', category: '', monthly: mon, inventory: { channels: [], groups: [], storeOuts: [] }, channels: read('channel'), gonguTargets: [], unmatchedCount: 0 });
const bcm = ch => (mon.totals.byChannelMonth.find(x => x.ym === YM && x.channelId === ch) || { in: {} }).in.actualAmount || 0;
const closedWant = ['theablen', 'workshop8', 'dapara'].reduce((s, ch) => s + bcm(ch), 0) + mon.totals.byChannelMonth.filter(x => x.ym === YM && x.channelId === 'special').reduce((s, x) => s + (x.in.actualAmount || 0), 0);
console.table([{ 항목: '⑦ 파트 홈 특수(폐쇄몰·특판·렌탈) 9월 IN 금액(본품)', 값: won(home.series.closed[YM].actual), '디에이블앤+워크숍에이트+다파라': won(closedWant), 결과: ok(home.series.closed[YM].actual === closedWant) },
  { 항목: '⑦ 파트 홈 오프라인 9월 IN 금액(본품, 신세계·롯데백화점 포함)', 값: won(home.series.offline[YM].actual), '신세계+롯데백화점': won(bcm('shinsegae') + bcm('lotte_dept')), 결과: '' }]);
console.log('브랜드별(무상 동봉 제외 뒤):', parsed.summary.brands.map(b => b.brand + (b.minix ? '' : '(미닉스 외)') + ' ' + b.qty + '대 ₩' + won(b.amount)).join(' · '));
