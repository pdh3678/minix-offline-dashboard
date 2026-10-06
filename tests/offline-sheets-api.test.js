/* Sheets 고급 서비스(Sheets API v4) 입출력 — 대시보드 요청의 시트 읽기·쓰기를 batchGet / batchUpdate로 (2026-10-02).

   지키려는 성질:
     · 결과는 그대로 — 같은 작업(반영 6종·재반영·SKU·매핑·목표·단가·설정·공구 목표 저장)을 Sheets API 경로와 SpreadsheetApp 경로
       (appsscript.json 미반영 = 대체 경로)로 돌리면 모든 탭의 값·텍스트 서식 기록·모든 조회 응답이 같다
     · 왕복 — 조회 액션은 batchGet 한 번, 파트 홈은 같은 탭을 두 번 읽지 않는다, 반영은 batchGet 한 번 + 쓴 탭마다 batchUpdate 한 번,
       SpreadsheetApp 읽기·쓰기는 0
     · 쓰기 — 끝부분만 다시 쓰기, 바뀐 게 없으면 안 씀, 모자란 행만 덧붙임, 텍스트 열 '@', 남는 행 비우기, 같은 파일 재반영 = 행 수 그대로
     · 읽기 — 텍스트 열에 날짜 셀(사람이 서식 없는 칸에 고친 값)이 있으면 그 탭만 SpreadsheetApp으로('yyyy-MM-dd' 그대로),
       없는 탭은 원래 오류(offline_setupSheets 안내), 없어도 되는 탭(설정·거래처매핑)은 []
     · 요청 범위 기억 — 사본을 준다(고쳐도 다음 읽기에 새지 않음), 쓴 탭은 다시 읽는다, 락을 잡으면 비운다
     · appsscript.json — Sheets v4 고급 서비스 추가, 나머지 설정·oauthScopes는 그대로

   실행: node tests/offline-sheets-api.test.js  (또는 node tests/run-all.js) */
const path = require('path'), fs = require('fs'), cp = require('child_process');
const { loadOfflineGas, dataRows, STATS, resetStats } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const P = require(path.join(__dirname, '..', 'src', 'features', 'offline', 'parsers.js'));
const PROJ = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 700) : '')); }
}
const J = JSON.stringify;
const TODAY = '2026-09-04';
const AUTH = { email: 'tester@athomecorp.com' };

// ── 합성 파일(파서 입력 모양) ──
function storeSales(dates, lines) { // 이마트 점포별 일별 매출 — [업태명, 점포코드, 점포명, 상품코드, 날짜별 수량...]
  return [['업태명', '점포코드', '점포명', '상품코드', '상품명', '대분류', '중분류', '소분류', '브랜드'].concat(dates, ['합계', '평균'])]
    .concat(lines.map(l => [l[0], l[1], l[2], l[3], '가상 ' + l[3], '가전', '가전', '가전', '기타'].concat(l.slice(4), [0, 0])));
}
function stockFile(lines) { // 이마트 재고현황_상세 — [점포명, 점포코드, 상품코드, 현재수량, 매출량]
  return [['구분', '전월재고', '매입', '매출', '이관', '현재고'], ['수량', 0, 0, 0, 0, 0], [], [],
    ['조회일자', '점포명', '점포코드', '상품명', '전월수량', '전월금액', '현재수량', '현재금액', '이관량', '이관액', '매입량', '매입액', '상품코드', '매출량']]
    .concat(lines.map(l => ['202609', l[0], l[1], '가상 ' + l[2], 0, 0, l[3], 0, 0, 0, 0, 0, l[2], l[4]]));
}
function etlandSales(lines) { // [판매일자, 지점코드, 모델명, 수량]
  return [['판매내역'], ['거래처코드', '거래처명', '지부', '지점코드', '지점명', '품목', '상품구분', '모델명', '설명', '판매수량', '단가', '금액', '판매일자', '구분']]
    .concat(lines.map(l => ['1', '가상', '충청', l[1], '점' + l[1], '청소기', '매입상품', l[2], '가상 ' + l[2], String(l[3]), '1', '1', l[0], '판매(계약)']));
}
function etlandStock(lines) { // [지점코드, 모델명, 재고, 이동중, 예약]
  return [['현 재고'], ['거래처코드', '거래처명', '지부', '입고지점코드', '입고지점', '품목', '모델명', '설명', '재고수량', '타지점입고 예정수량', '합계', '단가', '재고금액', '판매 예약수량']]
    .concat(lines.map(l => ['1', '가상', '중부', l[0], '점' + l[0], 'KREF', l[1], '가상 ' + l[1], String(l[2]), String(l[3]), '0', '1', '1', String(l[4])]));
}
function himart(entries) { // { 'S1|C1': [당월실판매, 당월판매, 금주판매, 당일판매, 잔여재고] }
  return [['지사명', '인도처코드', '인도처명', '상품코드', '상품명', '당월실판매', '당월판매', '금주판매', '당일판매', '잔여재고', '회전율']]
    .concat(Object.keys(entries).map(k => { const [s, c] = k.split('|'); return ['가상지사', s, s + 'HM', c, '가상 ' + c].concat(entries[k], [0]); }));
}
// ERP 매출이익리스트 — 실파일과 같은 2줄 헤더(열 이름만), 값은 가짜. [날짜, 거래처코드, 상품코드, 수량, 금액, 수수료]
const ERP_HEAD = ['날짜', '주문일', '매장', '매출구분', '주문번호', '전표번호', '거래처코드', '거래처명', '담당자', '자체(연계)코드', '회계(연계)코드', '주문자명', '주문자ID', '주문자 전화번호', '주문자 휴대폰',
  '수취인명', '수취인 전화번호', '수취인 휴대폰', '우편번호', '주소', '브랜드', '브랜드코드', '상품코드', '상품상태', '마켓상품코드', '자체코드', '판매자코드', '카테고리', '로케이션', '창고구분', '창고코드',
  '기본상품명', '기본상품 규격', '주문상품명', '주문상품 규격', '상품명 별칭', '상품비고', '관리비고', '관리코드', '송장번호', '택배사', '수불구분', '수량', '매출단가', '금액', '수수료', '수수료율', '공급액', '물류비',
  '인터넷단가', '인터넷총액', '원가', '원가총액', '이익액', '이익율', '이익액', '이익율'];
const ERP_GROUP = ERP_HEAD.map((h, i) => ({ 0: '주문정보', 6: '거래처정보', 11: '주문자명', 12: '주문자정보', 15: '수령자정보', 20: '상품정보', 39: '배송정보', 41: '수불구분', 42: '수량', 43: '총액' })[i] || '');
function erpFile(lines) {
  return [ERP_GROUP, ERP_HEAD].concat(lines.map(l => ERP_HEAD.map(h => ({ 날짜: l[0], 주문일: l[0], 매출구분: '앳홈', 거래처코드: l[1], 거래처명: '거래처 ' + l[1], 브랜드: '미닉스 더 플렌더',
    상품코드: l[2], 카테고리: '본품', 창고구분: '토마스', 기본상품명: '미닉스 더 플렌더 MAX (MNFD-200G)', 수불구분: '매출출고', 수량: l[3], 금액: l[4], 수수료: l[5], 매출단가: l[4] / l[3] })[h] ?? '')));
}

// 업로드·저장 시각과 upload_id를 고정한다 — 두 경로의 시트를 칸 단위로 비교하려고
function deterministic(g) {
  let n = 0;
  g.ctx.Utilities.getUuid = () => String(++n).padStart(4, '0') + '-uuid';
  const fmt = g.ctx.Utilities.formatDate;
  g.ctx.Utilities.formatDate = (d, tz, f) => (Math.abs(d.getTime() - Date.now()) < 3600000 ? fmt(new Date('2026-09-04T10:20:30+09:00'), tz, f) : fmt(d, tz, f));
  return g;
}
const ADMIN = { email: 'p_dh_3678@athomecorp.com' }; // 설정 저장은 관리자(ADMIN_EMAILS)만
const call = (g, action, data, auth) => {
  const o = JSON.parse(g.ctx._offlineHandle(action, data || {}, auth || AUTH));
  delete o.execMs; delete o.version;
  return o;
};
// 브라우저가 하는 일(파일 → 업로드 페이로드) — 채널마스터 재고기준일오프셋은 테스트가 시트에서 직접 읽는다(왕복 수에 넣지 않게 따로)
function payload(g, rows, fileName) {
  const offsets = {};
  g.ctx._offReadRows(g.tab('채널마스터'), g.ctx.OFF_TABS.channel).forEach(r => { const o = g.ctx._offStockOffsetOf(r); if (r[0] && o) offsets[r[0]] = o; });
  const r = P.parseRows(P.dropUnusedColumns(rows), { fileName, today: TODAY, stockOffsets: offsets });
  if (!r.ok) throw new Error('픽스처 파싱 실패: ' + fileName + ' ' + r.error);
  return P.toUploadPayload(r, { fileName, baseDate: r.baseDate });
}
const upload = (g, rows, fileName) => call(g, 'offline_upload', payload(g, rows, fileName));
const EMART_DAILY = ['기간별매출(상품별)_일별상세_20260903101010.xlsx', storeSales(['09월01일', '09월02일'], [
  ['이마트', '1003', 'EM 성수', '8800000000001', 2, 1], ['트레이더스', '2001', 'TR 월계', '8800000000001', 1, 0], ['이마트', '1004', 'EM 은평', '8800000000002', 0, 3]])];

/* 시나리오 — 반영 6종 + 재반영 + 저장 7종 + 조회 14종. 반환: { res: {이름: 응답}, tabs: {탭: grid}, formats: {탭: 서식 기록} } */
function scenario(g) {
  deterministic(g);
  const res = {};
  res.upEmart = upload(g, EMART_DAILY[1], EMART_DAILY[0]);
  res.upEmartStock = upload(g, stockFile([['EM 성수', '1003', '8800000000001', 5, 0], ['TR 월계', '2001', '8800000000001', 3, 0], ['EM 신규', '1009', '8800000000002', 2, 0]]), '재고현황_상세_20260903101010.xlsx');
  res.upEtland = upload(g, etlandSales([['2026-09-01', '302001', 'MNFD-200G', 2], ['2026-09-02', '302002', 'MNVC-100G', 1]]), '판매내역_2026-09-03_101010.xls');
  res.upEtlandStock = upload(g, etlandStock([['302001', 'MNFD-200G', 4, 1, 0], ['302002', 'MNVC-100G', 2, 0, 1]]), '현재고_2026-09-03_101010.xls');
  res.upHimart1 = upload(g, himart({ 'S1|C1': [1, 2, 1, 1, 5], 'S2|C2': [0, 1, 1, 1, 3] }), '판매재고현황_20260902.xlsx');
  res.upHimart2 = upload(g, himart({ 'S1|C1': [2, 4, 3, 2, 4], 'S2|C2': [1, 1, 1, 0, 3], 'S3|C1': [0, 1, 1, 1, 1] }), '판매재고현황_20260903.xlsx');
  res.upErp = upload(g, erpFile([['2026-09-02', '00476', '9812365001397', 2, 660000, 0], ['2026-09-03', '00474', '9812365001397', 1, 330000, 30000]]), '백화점, 폐쇄몰, 렌탈 매출이익리스트(2026-09-01~2026-09-30).xlsx');
  res.upEmartAgain = upload(g, EMART_DAILY[1], EMART_DAILY[0]);
  res.saveSku = call(g, 'offline_saveSku', { sku: { name: '더 플렌더 MAX 그레이지', line: '더플렌더', model: '더 플렌더 MAX', option: '그레이지' } });
  const sku = res.saveSku.sku.skuId;
  res.saveMapping = call(g, 'offline_saveMapping', { items: [{ op: 'upsert', channelId: 'emart', code: '8800000000001', skuId: sku, stockType: '정상', name: '가상' },
    { op: 'upsert', channelId: 'etland', code: 'MNFD-200G', skuId: sku, stockType: '정상' }, { op: 'upsert', channelId: 'himart', code: 'C1', skuId: sku, stockType: '정상' }] });
  res.saveTargets = call(g, 'offline_saveTargets', { items: [{ ym: '2026-09', channelId: 'emart', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 10, actual: 7 },
    { ym: '2026-09', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'OUT', target: 9 }] });
  res.savePrices = call(g, 'offline_savePrices', { items: [{ channelId: 'emart', line: '더플렌더', model: '더 플렌더 MAX', price: 250000, startDate: '2026-01-01' },
    { channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', price: 240000, startDate: '2026-01-01' }, { channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', price: 245000, startDate: '2026-09-01' }] });
  res.deletePrice = call(g, 'offline_deletePrice', { channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', startDate: '2026-09-01' });
  res.saveSettings = call(g, 'offline_saveSettings', { settings: { '재고경보_과다일수': 60 } }, ADMIN);
  res.saveGongu = call(g, 'offline_saveGonguTargets', { items: [{ ym: '2026-09', vendor: '가상벤더', line: '더플렌더', model: '더 플렌더 MAX', qty: 30, amount: 9000000 }] });
  // 조회 — 쓰기 뒤라 캐시 세대가 바뀌어 전부 시트를 읽는다
  res.masters = call(g, 'offline_getMasters');
  res.unmatched = call(g, 'offline_getUnmatched');
  res.uploadLog = call(g, 'offline_getUploadLog');
  res.status = call(g, 'offline_getStatus');
  res.monthly = call(g, 'offline_getMonthly', { from: '2026-01', to: '2026-12' });
  res.monthlyTotals = call(g, 'offline_getMonthly', { from: '2026-01', to: '2026-12', totalsOnly: true });
  res.inventory = call(g, 'offline_getInventory', {});
  res.inventoryHimart = call(g, 'offline_getInventory', { channelId: 'himart' });
  res.daily = call(g, 'offline_getDailySales', { from: '2026-09-01', to: '2026-09-30', level: 'model' });
  res.trend = call(g, 'offline_getInventoryTrend', { from: '2026-09-01', to: '2026-09-30' });
  res.breakdown = call(g, 'offline_getSalesBreakdown', { channelId: 'emart', from: '2026-09', to: '2026-09' });
  res.prices = call(g, 'offline_getPrices');
  res.gongu = call(g, 'offline_getGonguTargets', { year: '2026' });
  res.home = call(g, 'home_getSummary', { ym: '2026-09', mode: 'month' });
  const tabs = {}, formats = {};
  g.off._order.forEach(n => { tabs[n] = g.tab(n)._grid; formats[n] = g.tab(n)._formats; });
  return { res, tabs, formats };
}

(function main() {
  console.log('\n[1] 결과 그대로 — Sheets API 경로 = SpreadsheetApp 경로(같은 작업, 같은 시트·서식·응답)');
  const ga = loadOfflineGas({ setup: true, today: TODAY });
  const A = scenario(ga);
  const apiCalls = ga.api.calls.length;
  const salesRowsA = dataRows(ga.tab('판매원장')).length;
  const gb = loadOfflineGas({ setup: true, today: TODAY, noSheetsApi: true }); // ga는 여기서 끝 — 같은 전역을 쓴다(tests/lib/offline-gas.js)
  const B = scenario(gb);
  check('Sheets API 경로가 실제로 쓰였다(호출 ' + apiCalls + '번) · 대체 경로는 Sheets 없이', apiCalls > 30 && gb.api === null && typeof gb.ctx.Sheets === 'undefined');
  const errs = Object.keys(A.res).filter(k => A.res[k].error);
  check('시나리오의 모든 반영·저장·조회가 성공', !errs.length, errs.map(k => k + ': ' + A.res[k].error));
  const tabDiff = Object.keys(B.tabs).filter(n => J(A.tabs[n]) !== J(B.tabs[n]));
  check('모든 탭의 값이 칸 단위로 같다(' + Object.keys(B.tabs).length + '개 탭)', !tabDiff.length && J(Object.keys(A.tabs)) === J(Object.keys(B.tabs)), tabDiff.map(n => [n, A.tabs[n], B.tabs[n]]));
  const fmtDiff = Object.keys(B.formats).filter(n => J(A.formats[n]) !== J(B.formats[n]));
  check('텍스트 서식(@)을 건 범위가 같다', !fmtDiff.length, fmtDiff.map(n => [n, A.formats[n].slice(-3), B.formats[n].slice(-3)]));
  const resDiff = Object.keys(B.res).filter(k => J(A.res[k]) !== J(B.res[k]));
  check('반영·저장·조회 응답 ' + Object.keys(B.res).length + '개가 모두 같다', !resDiff.length, resDiff.map(k => [k, A.res[k], B.res[k]]));
  check('같은 파일 재반영 — 판매원장 행 수 그대로 · 지운 행 = 넣은 행', A.res.upEmartAgain.applied.sales === A.res.upEmartAgain.applied.salesRemoved &&
    A.res.upEmartAgain.applied.sales === A.res.upEmart.applied.sales && salesRowsA === dataRows(gb.tab('판매원장')).length, [A.res.upEmart.applied, A.res.upEmartAgain.applied]);
  check('  ↳ 판매원장에 이마트·트레이더스·전자랜드·하이마트·ERP 행이 다 있다(빈 시나리오가 아님)', ['emart', 'traders', 'etland', 'himart', 'shinsegae', 'theablen'].every(c => B.tabs['판매원장'].some(r => r[3] === c)), B.tabs['판매원장'].map(r => r[3]));
  // 사용자당 분당 한도(읽기·쓰기 60회)를 넘는 순간이 섞여도 — Sheets API 호출 3번에 1번이 한도 초과
  const gc = loadOfflineGas({ setup: true, today: TODAY, sheetsApiFailEvery: 3 });
  const Cq = scenario(gc);
  const failed = gc.api.calls.filter(c => c.failed);
  check('한도 초과가 섞여도(API 호출 ' + gc.api.calls.length + '번 중 ' + failed.length + '번 실패 — 읽기·쓰기 모두) 모든 탭·서식·응답이 SpreadsheetApp 경로와 같다',
    failed.some(c => c.op === 'batchGet') && failed.some(c => c.op === 'batchUpdate') && !Object.keys(Cq.res).some(k => Cq.res[k].error) &&
    Object.keys(B.tabs).every(n => J(Cq.tabs[n]) === J(B.tabs[n])) && Object.keys(B.formats).every(n => J(Cq.formats[n]) === J(B.formats[n])) &&
    Object.keys(B.res).every(k => J(Cq.res[k]) === J(B.res[k])), Object.keys(B.res).filter(k => J(Cq.res[k]) !== J(B.res[k])).concat(Object.keys(B.tabs).filter(n => J(Cq.tabs[n]) !== J(B.tabs[n]))));

  console.log('\n[2] 왕복 — 조회는 batchGet 한 번, 반영은 batchGet 한 번 + 쓴 탭마다 batchUpdate 한 번, SpreadsheetApp 0');
  {
    const g = loadOfflineGas({ setup: true, today: TODAY });
    deterministic(g);
    upload(g, EMART_DAILY[1], EMART_DAILY[0]);
    upload(g, himart({ 'S1|C1': [1, 2, 1, 1, 5] }), '판매재고현황_20260902.xlsx');
    const measure = (fn) => {
      g.api.reset(); resetStats();
      const r = fn();
      return { r, batchGet: g.api.count('batchGet'), get: g.api.count('get'), batchUpdate: g.api.count('batchUpdate'), legacy: STATS.reads + STATS.writes,
        ranges: [].concat(...g.api.calls.filter(c => c.op === 'batchGet').map(c => c.ranges)), updates: g.api.calls.filter(c => c.op === 'batchUpdate').map(c => c.requests) };
    };
    const reads = [['offline_getMonthly', { from: '2026-01', to: '2026-12' }, 6], ['offline_getInventory', { channelId: 'himart' }, 10], ['offline_getSalesBreakdown', { channelId: 'emart', from: '2026-09', to: '2026-09' }, 6],
      ['offline_getDailySales', { from: '2026-09-01', to: '2026-09-30' }, 4], ['offline_getInventoryTrend', { from: '2026-09-01', to: '2026-09-30' }, 4], ['offline_getMasters', {}, 6],
      ['offline_getStatus', {}, 2], ['offline_getUnmatched', {}, 3], ['offline_getUploadLog', {}, 1], ['offline_getPrices', {}, 2], ['offline_getGonguTargets', { year: '2026' }, 1]];
    reads.forEach(([a, d, tabs]) => {
      const m = measure(() => call(g, a, d));
      check(a + ' — batchGet 1번(탭 ' + tabs + '개), 메타·쓰기·SpreadsheetApp 0', !m.r.error && m.batchGet === 1 && m.ranges.length === tabs && m.get === 0 && m.batchUpdate === 0 && m.legacy === 0, m);
    });
    g.ctx._offInvalidateCache();
    const h = measure(() => call(g, 'home_getSummary', { ym: '2026-09', mode: 'ytd' }));
    const dup = h.ranges.filter((x, i) => h.ranges.indexOf(x) !== i);
    check('home_getSummary(캐시 없음) — batchGet 3번(월별 · 재고에 더 필요한 탭 · 공구목표), 같은 탭 두 번 읽지 않음(판매원장 1번)',
      !h.r.error && h.batchGet === 3 && !dup.length && h.ranges.filter(x => /판매원장/.test(x)).length === 1 && h.legacy === 0, h);
    const pE = payload(g, EMART_DAILY[1], EMART_DAILY[0]), pH = payload(g, himart({ 'S1|C1': [2, 4, 3, 2, 4] }), '판매재고현황_20260903.xlsx');
    const u = measure(() => call(g, 'offline_upload', pE));
    check('offline_upload(이마트 점포별 일별) — batchGet 1번 + 메타 1번 + batchUpdate 4번(판매원장·점포마스터·미매칭코드·업로드로그), SpreadsheetApp 0',
      u.r.success && u.batchGet === 1 && u.get === 1 && u.batchUpdate === 4 && u.legacy === 0, u);
    check('  ↳ 탭 하나 = batchUpdate 하나(텍스트 서식 + 값 + 남는 행 비우기)', u.updates.every(r => r[r.length - 1] === 'updateCells' && r.filter(x => x === 'updateCells').length === 1), u.updates);
    const hm = measure(() => call(g, 'offline_upload', pH));
    check('offline_upload(하이마트) — batchGet 1번, 쓰기는 재고 2탭·판매원장·스냅샷·점포·미매칭·로그', hm.r.success && hm.batchGet === 1 && hm.get === 1 && hm.batchUpdate === 7 && hm.legacy === 0, hm);
    const sku = call(g, 'offline_saveSku', { sku: { name: '더 플렌더 MAX', line: '더플렌더', model: '더 플렌더 MAX' } }).sku.skuId;
    const s = measure(() => call(g, 'offline_saveMapping', { items: [{ op: 'upsert', channelId: 'emart', code: '8800000000002', skuId: sku, stockType: '정상' }] }));
    check('offline_saveMapping — 읽기 batchGet 1번 + 코드매핑·미매칭코드 batchUpdate', s.r.success && s.batchGet === 1 && s.batchUpdate === 2 && s.legacy === 0, s);
  }

  console.log('\n[3] 쓰기 — 끝부분만·안 바뀌면 안 씀·모자란 행만 덧붙임·텍스트 서식·남는 행 비우기');
  {
    const g = loadOfflineGas({ setup: true, today: TODAY }), T = g.ctx.OFF_TABS, sh = g.tab('재고_채널일별');
    const row = (d, ch, code, n) => [d, ch, code, n, '', '', 'U1'];
    const base = [row('2026-09-01', 'himart', '0012', 1), row('2026-09-01', 'etland', 'A', 2), row('2026-09-02', 'himart', '0012', 3), row('2026-09-02', 'etland', 'A', 4)];
    g.ctx._offRewrite('stockDaily', base, 0);
    check('텍스트 열 값은 문자열 그대로(앞자리 0·날짜), 숫자 열은 숫자, 빈칸은 빈칸', J(dataRows(sh)) === J(base) && typeof sh._grid[1][3] === 'number' && sh._grid[1][2] === '0012');
    check('  ↳ 쓴 행에 텍스트 서식 — 기준일~원본코드(1~3열)·upload_id(7열)', sh._formats.some(f => f.r === 2 && f.c === 1 && f.nc === 3 && f.nr === 4 && f.f === '@') &&
      sh._formats.some(f => f.r === 2 && f.c === 7 && f.nc === 1 && f.nr === 4 && f.f === '@'), sh._formats.slice(-2));
    g.api.reset();
    let r = g.ctx._offReplace('stockDaily', g.ctx._offRead('stockDaily'), () => true, []);
    check('바뀌는 게 없으면 쓰지 않는다', r.removed === 0 && g.api.count('batchUpdate') === 0);
    g.api.reset();
    r = g.ctx._offReplace('stockDaily', g.ctx._offRead('stockDaily'), x => !(x[0] === '2026-09-02' && x[1] === 'himart'), [row('2026-09-02', 'himart', '0012', 9)]);
    const up = g.api.calls.find(c => c.op === 'batchUpdate');
    check('지워지는 첫 행(4행)부터 끝까지만 다시 쓴다 — 결과 = 남은 행(원래 순서) + 새 행', r.removed === 1 && r.added === 1 &&
      J(dataRows(sh)) === J([base[0], base[1], base[3], row('2026-09-02', 'himart', '0012', 9)]) && J(up.requests) === J(['repeatCell', 'repeatCell', 'updateCells']), [r, dataRows(sh), up]);
    const before = sh._grid.length;
    g.api.reset();
    g.ctx._offAppend('stockDaily', [row('2026-09-03', 'himart', '7', 1), row('2026-09-03', 'etland', 'B', 1)]);
    const ap = g.api.calls.find(c => c.op === 'batchUpdate');
    check('덧붙이기 — 마지막 데이터 행 다음부터, 모자란 2행만 appendDimension', dataRows(sh).length === 6 && sh._grid.length === before + 2 && ap.requests[0] === 'appendDimension', ap);
    g.ctx._offRewrite('stockDaily', [base[0]], 6);
    check('전체 다시 쓰기가 짧아지면 남는 5행은 비운다(행은 지우지 않음 — clearContent와 같다)', J(dataRows(sh)) === J([base[0]]) && sh._grid.length === before + 2 &&
      sh._grid.slice(2).every(x => x.every(v => v === '')), sh._grid.slice(0, 4));
    g.api.reset(); resetStats();
    g.api.failNext('batchUpdate', 1);
    g.ctx._offRewrite('stockDaily', base, 1);
    check('batchUpdate가 한도 초과로 실패하면 같은 내용을 SpreadsheetApp으로 다시 쓴다(값·텍스트 서식)', J(dataRows(sh)) === J(base) && g.api.calls[g.api.calls.length - 1].failed && STATS.writes > 0 &&
      sh._formats.slice(-2).every(f => f.r === 2 && f.nr === 4 && f.f === '@'), [dataRows(sh), STATS.writes]);
    check('값 변환 — 텍스트 열은 문자열, 숫자·참거짓은 그대로, NaN·Infinity는 문자열, \'\'·null은 빈칸', J([g.ctx._offCell(12, true), g.ctx._offCell(12, false), g.ctx._offCell(true, false), g.ctx._offCell(NaN, false), g.ctx._offCell('', false), g.ctx._offCell(null, true)]) ===
      J([{ userEnteredValue: { stringValue: '12' } }, { userEnteredValue: { numberValue: 12 } }, { userEnteredValue: { boolValue: true } }, { userEnteredValue: { stringValue: 'NaN' } }, {}, {}]));
    check('범위 이름 — 탭 이름의 작은따옴표는 두 번(A1 표기)', g.ctx._offA1({ name: "가'나", headers: [1, 2, 3] }) === "'가''나'!A2:C" && g.ctx._offA1(T.sales) === "'판매원장'!A2:L");
    // 요청 크기 제한 — 칸이 상한을 넘으면 나눠 보낸다(목에서는 상한을 작게: 7열 × 2행 = 14칸 ≤ 20)
    const big = Array.from({ length: 9 }, (_, i) => row('2026-09-1' + i, 'etland', 'C' + i, i));
    g.ctx._offRewrite('stockDaily', big.concat(big), 0);
    g.ctx.OFF_API_CELLS_PER_CALL = 20;
    g.api.reset();
    g.ctx._offRewrite('stockDaily', big, 18);
    const parts = g.api.calls.filter(c => c.op === 'batchUpdate');
    check('큰 쓰기는 나눠 보낸다 — 9행 → 2행씩 5번, 행 늘리기·서식은 첫 요청에만, 남는 9행 비우기는 마지막 요청에', parts.length === 5 && J(parts[0].requests) === J(['repeatCell', 'repeatCell', 'updateCells']) &&
      parts.slice(1).every(p => J(p.requests) === J(['updateCells'])) && J(dataRows(sh)) === J(big) && sh._grid.slice(11, 20).every(x => x.every(v => v === '')), parts.map(p => p.requests));
    const big2 = big.map(r => r.slice(0, 3).concat([r[3] + 100], r.slice(4)));
    g.ctx._offRewrite('stockDaily', big.concat(big), 9);
    g.api.reset(); g.api.failNext('batchUpdate', 1, 2); // 2번째까지 쓰고 3번째에서 한도 초과
    g.ctx._offRewrite('stockDaily', big2, 18);
    check('  ↳ 나눠 쓰다 중간에 실패해도 SpreadsheetApp으로 전체를 다시 써서 결과가 같다', J(dataRows(sh)) === J(big2) && g.api.calls.filter(c => c.failed).length === 1, dataRows(sh));
    g.ctx.OFF_API_CELLS_PER_CALL = 50000;
    g.ctx._offWriteRows('readme', 2, [['탭', '설명 (sheetId 0 탭)']], 0);
    check('sheetId 0인 첫 탭(README)에도 쓴다 — 응답에서 0이 빠져도', g.off._order[0] === 'README' && J(g.tab('README')._grid[1].slice(0, 2)) === J(['탭', '설명 (sheetId 0 탭)']));
  }

  console.log('\n[4] 읽기 — 날짜 셀은 그 탭만 SpreadsheetApp으로, 없는 탭');
  {
    const g = loadOfflineGas({ setup: true, today: TODAY }), T = g.ctx.OFF_TABS;
    g.ctx._offWriteBlock(g.tab('단가마스터'), T.prices, 2, [['emart', '더플렌더', '더 플렌더 MAX', 250000, '2026-01-01', '', '2026-09-01', 'a'], ['himart', '더플렌더', '더 플렌더 MAX', 240000, '2026-01-01', '', '2026-09-01', 'a']]);
    // 사람이 서식 없는 칸에 날짜를 고쳐 넣었다 → getValues는 Date, Sheets API는 일련번호(숫자)
    g.tab('단가마스터')._grid[2][4] = new Date('2026-10-01T00:00:00+09:00');
    const legacy = g.ctx._offReadRows(g.tab('단가마스터'), T.prices);
    g.api.reset(); resetStats();
    const t = g.ctx._offReadTabs(['prices', 'channel']);
    check('텍스트 열의 날짜 셀 → 단가마스터만 SpreadsheetApp으로 다시 읽어 "2026-10-01"(이전과 같은 값)', J(t.prices) === J(legacy) && t.prices[1][4] === '2026-10-01' && STATS.reads === 1 && g.api.count('batchGet') === 1, [t.prices, STATS.reads]);
    check('  ↳ 같은 batchGet의 다른 탭(채널마스터)은 API 값 그대로', J(t.channel) === J(g.ctx._offReadRows(g.tab('채널마스터'), T.channel)));
    const all = Object.keys(T).filter(k => g.tab(T[k].name));
    const same = all.filter(k => J(g.ctx._offReadTabs([k])[k]) === J(g.ctx._offReadRows(g.tab(T[k].name), T[k])));
    check('setup 직후 모든 탭 — API 읽기 = SpreadsheetApp 읽기 (' + same.length + '/' + all.length + ')', same.length === all.length, all.filter(k => same.indexOf(k) < 0));
    // 없어도 되는 탭 / 꼭 있어야 하는 탭
    delete g.off._sheets['설정']; delete g.off._sheets['거래처매핑'];
    const m = call(g, 'offline_getMasters');
    check('설정·거래처매핑 탭이 없어도(setup 재실행 전) 마스터 = 기본 설정 · 거래처 없음', !m.error && m.settings['재고경보_과다일수'] === 90 && J(m.customers) === '[]', m.error);
    check('  ↳ _offReadSettings도 기본값', g.ctx._offReadSettings()['재고일수_판매기준일수'] === 28);
    g.ctx._offInvalidateCache();
    check('  ↳ 재고 현황도 기본 설정으로', !call(g, 'offline_getInventory', {}).error);
    delete g.off._sheets['점포마스터'];
    g.ctx._offInvalidateCache();
    check('꼭 있어야 하는 탭(점포마스터)이 없으면 원래 안내 그대로', /점포마스터.*offline_setupSheets/.test(call(g, 'offline_getMasters').error || ''));
  }

  console.log('\n[5] 요청 범위 기억 — 사본·쓰면 다시 읽기·락');
  {
    const g = loadOfflineGas({ setup: true, today: TODAY }), C = g.ctx;
    g.api.reset();
    C._offWithIo(() => {
      const a = C._offRead('channel');
      a[0][1] = '바꾼 이름';
      const b = C._offRead('channel');
      check('같은 범위에서 다시 읽으면 batchGet 없이 사본 — 받은 행을 고쳐도 다음 읽기에 새지 않는다', g.api.count('batchGet') === 1 && b[0][1] === '하이마트');
      const rows = C._offRead('channel'); rows[0][1] = '하이마트(저장)';
      C._offRewrite('channel', rows, rows.length);
      const c = C._offRead('channel');
      check('쓴 탭은 다시 읽어 새 값', g.api.count('batchGet') === 2 && c[0][1] === '하이마트(저장)');
      C._offRead('sku');
      C._offWithLock(() => { C._offRead('sku'); });
      check('락을 잡으면 기억을 비운다(기다리는 사이 다른 반영이 썼을 수 있다)', g.api.count('batchGet') === 4);
    });
    g.api.reset();
    C._offRead('channel'); C._offRead('channel');
    check('범위 밖(편집기·직접 호출)에서는 기억하지 않는다', g.api.count('batchGet') === 2 && C._offIo === null);
    g.api.reset(); resetStats();
    g.api.failNext('batchGet', 1);
    C._offWithIo(() => {
      const ch = C._offRead('channel'), st = C._offRead('store'); // 점포마스터 = 거래처 초기값 9행
      C._offRewrite('store', st, st.length);
      check('한도 초과가 한 번 나면 그 요청의 나머지 읽기·쓰기는 API를 부르지 않고 SpreadsheetApp으로', ch.length === 10 && st.length === 9 && g.api.calls.length === 1 && g.api.calls[0].failed &&
        STATS.reads === 2 && STATS.writes > 0, [g.api.calls, STATS.reads, STATS.writes]);
    });
    g.api.reset();
    C._offWithIo(() => { C._offRead('channel'); });
    check('  ↳ 다음 요청은 다시 API부터', g.api.count('batchGet') === 1 && !g.api.calls[0].failed);
  }

  console.log('\n[6] offline_benchmarkReads — 편집기 점검(운영 시트에 쓰지 않는다)');
  {
    const g = loadOfflineGas({ setup: true, today: TODAY });
    deterministic(g);
    upload(g, EMART_DAILY[1], EMART_DAILY[0]);
    upload(g, himart({ 'S1|C1': [1, 2, 1, 1, 5] }), '판매재고현황_20260902.xlsx');
    g.tab('판매원장')._grid.push(new Array(12).fill('').concat(['헤더 폭 밖 메모'])); // getLastRow만 세는 뒤쪽 행
    const grids = J(g.off._order.map(n => g.tab(n)._grid)), cache = J(g.cacheStore);
    g.api.reset();
    const b = g.ctx.offline_benchmarkReads();
    check('탭 ' + b.tabs.length + '개 모두 "읽은 행 같음", 액션 4개(월별·재고·판매 분석·파트 홈) 시간 기록', b.sheetsApi && b.tabs.length === 13 && b.tabs.every(t => t.same === true) &&
      J(b.actions.map(a => a.action)) === J(['offline_getMonthly', 'offline_getInventory', 'offline_getSalesBreakdown', 'home_getSummary']) && b.actions.every(a => a.oldMs != null && a.newMs != null), b.tabs.filter(t => !t.same));
    check('  ↳ 헤더 폭 밖 열에만 값이 있는 뒤쪽 행은 "뒤쪽 빈 행만 다름"으로 알려 준다', /뒤쪽 빈 행 1개/.test(b.tabs.find(t => t.tab === '판매원장').note), b.tabs.find(t => t.tab === '판매원장'));
    check('  ↳ 파트 홈: 이전 openById 4번·탭 읽기 21번 → 지금 batchGet 3번', b.actions[3].oldCalls === '4 openById · 탭 읽기 21번' && b.actions[3].newCalls === 'batchGet 3번', b.actions[3]);
    check('  ↳ 시트·캐시에 아무것도 쓰지 않았다(batchUpdate 0)', J(g.off._order.map(n => g.tab(n)._grid)) === grids && J(g.cacheStore) === cache && g.api.count('batchUpdate') === 0);
    check('  ↳ Sheets API 읽기 31번(탭 13 + 액션 18) — 사용자당 분당 한도 60회 아래', g.api.count('batchGet') === 31, g.api.count('batchGet'));
    g.api.reset(); g.api.failNext('batchGet', 1, 14); // 탭 13번 + 월별 첫 회는 통과, 그다음 한 번 한도 초과
    const bq = g.ctx.offline_benchmarkReads();
    check('  ↳ 한도 초과가 섞이면 그 액션 줄에 "1분 뒤 다시" 표시(결과는 같음)', bq.actions[0].fellBack === 1 && /한도 초과로 SpreadsheetApp이 섞임/.test(bq.log.find(l => /offline_getMonthly/.test(l))) && bq.tabs.every(t => t.same), bq.log);
    const g2 = loadOfflineGas({ setup: true, today: TODAY, noSheetsApi: true });
    const b2 = g2.ctx.offline_benchmarkReads();
    check('Sheets 고급 서비스가 꺼져 있으면 첫 줄에 안내하고 이전 방식만 잰다', b2.sheetsApi === false && /꺼져 있다/.test(b2.log[0]) && b2.tabs.every(t => t.apiMs === null && t.oldMs != null), b2.log[0]);
  }

  console.log('\n[7] appsscript.json — Sheets v4 고급 서비스를 더하고 기존 설정·스코프는 그대로(뒤 단계는 덧붙이기만)');
  {
    const now = JSON.parse(fs.readFileSync(path.join(PROJ, 'appsscript.json'), 'utf8'));
    let base = null;
    try { base = JSON.parse(cp.execFileSync('git', ['show', '39f94f1:appsscript.json'], { cwd: PROJ, encoding: 'utf8' })); } catch (e) {}
    check('enabledAdvancedServices에 Sheets(v4, sheets)', now.dependencies.enabledAdvancedServices.some(s => J(s) === J({ userSymbol: 'Sheets', version: 'v4', serviceId: 'sheets' })));
    const BASE_SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/script.external_request'];
    check('oauthScopes — 기존 3개(spreadsheets: Sheets API가 쓰는 스코프·drive·external_request)가 그대로 앞에', J(now.oauthScopes.slice(0, 3)) === J(BASE_SCOPES));
    if (base) {
      const strip = o => { const c = JSON.parse(J(o)); delete c.dependencies; delete c.oauthScopes; return c; };
      check('timeZone·webapp·exceptionLogging·runtimeVersion이 바꾸기 전(39f94f1)과 같고, 그때 스코프는 전부 남아 있다', J(strip(now)) === J(strip(base)) && J(base.dependencies) === '{}' &&
        base.oauthScopes.every(s => now.oauthScopes.indexOf(s) >= 0));
    } else check('git 기록에서 바꾸기 전 appsscript.json을 읽지 못함(얕은 클론?) — 건너뜀', true);
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})();
