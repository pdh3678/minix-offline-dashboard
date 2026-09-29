/* 파트 홈 GAS(apps-script-home.js) — 공구 목표 저장 구조, 공구 목표 이관, 파트 통합 집계(home_getSummary). GAS 실코드 + 목 시트.

   지키려는 성질:
     · offline_setupSheets가 '공구목표_월' 탭을 만든다(멱등) — 키 (연월, 벤더, 품목군, 모델), 출처 input/migration
     · 채널군: 전문점·할인점·창고형·백화점 = 오프라인 / 폐쇄몰·특판 = 폐쇄몰·특판 / 공동구매는 채널이 아니다
     · 원본 '공동구매 26년 목표' 파싱 — 행 번호가 아니라 제목 글자('매출 계획'·'마감 매출')와 머리글(구분/채널/상품명/수량/매출)로
       블록을 찾고, 병합 셀(벤더·월 머리글)을 채워 읽는다. 2025년 '매출 현황' 블록은 이관 대상이 아니다
     · 이관 대상은 벤더별 상품 행만(소계·채널 합계 행 제외), 값이 있는 월만. 금액은 원본 값 그대로(수량 × 매출금액 아님)
     · 상품명 제안: '더플렌더 MAX/PRO/mini/MINI' → 더 플렌더 해당 모델, '더시프트' → 더 시프트, '더 에어드라이' → 더 에어드라이, 모호하면 빈칸
     · 대조: 이관 예정 합계 vs 원본 채널 합계 행(월·연)·벤더 소계·'26년 목표'·'1~4분기 목표', 마감 매출 월별 합계
     · 반영 2회 = 행 수 불변(migration만 교체), input 행 보존, 이관로그, 원본은 읽기만
     · home_getSummary: 채널군별 IN 목표·실적 금액(본품), 오프라인 + 폐쇄몰·특판 = 채널 현황의 IN 금액(byChannelMonth 합),
       공구 목표 금액, 필터 IN 금액 따로, 대분류별 그 달 OUT, 오늘 챙길 것(지연 채널·미매칭·경보 = 재고 현황과 같은 정의), 캐시·무효화

   실행: node tests/home-gas.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadOfflineGas, dataRows } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const FX = require(path.join(__dirname, 'lib', 'offline-2b-fixture.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 700) : '')); }
}
const J = JSON.stringify;

/* ── 원본 탭 목(숫자는 가짜, 모양은 실제 탭과 같다) ──
   1행 비움 · 2025년 '매출 현황' 블록(이관 대상 아님) · "2. … 사업 계획" / "ㄴ 월별 품목 매출 계획" / 머리글 두 줄(구분+월 날짜 병합 | 채널·상품명·매출금액·수량·매출…)
   · 모엔즈(벤더 칸 병합) 5행 + 소계 · 기타 4행 + 소계 · 채널 합계(병합) + 소계 · 1~4분기 목표 · 26년 목표
   · "3. … 마감 내역" / "ㄴ 월별 품목 마감 매출" 블록 + 1~4분기 마감 · 26년 마감 */
const COLS = 30; // A..AD
const col = c => c.charCodeAt(0) - 64; // 'A' → 1
function monthCols(m) { return { q: 4 + (m - 1) * 2, a: 5 + (m - 1) * 2 }; } // 1-based: 1월 수량 D(4)·매출 E(5)
const TOTQ = 28, TOTA = 29; // AB·AC
// 상품 행 데이터: { 월: [수량, 매출] }
const PLAN = {
  '모엔즈': [
    ['더 에어드라이', 359000, { 1: [0, 0], 2: [0, 0] }], // 0만 있는 달 → 이관 안 함
    ['더시프트', 300000, { 1: [10, 3000000], 2: [5, 1400000] }], // 2월 매출 ≠ 5 × 300,000 — 원본 값 그대로
    ['더플렌더 mini', 250000, { 8: [20, 5000000] }],
    ['더플렌더 PRO', 375000, { 1: [8, 3000000], 4: [4, 1500000] }],
    ['더플렌더 MAX', 430000, { 3: [30, 13000000], 7: [0, 0], 10: [12, 5000000] }]],
  '기타': [
    ['더시프트', 300000, { 1: [2, 600000] }],
    ['더플렌더 mini', 250000, {}], // 값 없는 행
    ['더플렌더 PRO', 375000, { 2: [3, 1100000] }],
    ['특가세트', 400000, { 11: [5, 2000000] }]] // 모호한 상품명 → 제안 빈칸(미매핑)
};
const CLOSE = { '모엔즈': [['더플렌더 MAX', 430000, { 1: [9, 3800000], 3: [25, 10500000] }], ['더플렌더 MINI', 250000, { 8: [4, 1000000] }]] };

function buildLegacy() {
  const g = [], merges = [];
  const row = n => { while (g.length < n) g.push(new Array(COLS).fill('')); return g[n - 1]; };
  const put = (n, c, v) => { row(n)[c - 1] = v; };
  const header = (n, year) => {
    put(n, 1, '구분'); merges.push([n, 1, 1, 3]);
    for (let m = 1; m <= 12; m++) { put(n, monthCols(m).q, new Date(Date.UTC(year, m - 1, 1))); merges.push([n, monthCols(m).q, 1, 2]); }
    put(n, TOTQ, '총 합계'); merges.push([n, TOTQ, 1, 3]);
    put(n + 1, 1, '채널'); put(n + 1, 2, '상품명'); put(n + 1, 3, '매출금액');
    for (let m = 1; m <= 12; m++) { put(n + 1, monthCols(m).q, '수량'); put(n + 1, monthCols(m).a, '매출'); }
    put(n + 1, TOTQ, '수량'); put(n + 1, TOTA, '매출'); put(n + 1, 30, '비중');
  };
  const sumInto = (acc, data) => { Object.keys(data).forEach(m => { const a = acc[m] || (acc[m] = [0, 0]); a[0] += data[m][0]; a[1] += data[m][1]; }); };
  const writeVals = (n, data) => {
    let tq = 0, ta = 0;
    Object.keys(data).forEach(m => { put(n, monthCols(+m).q, data[m][0]); put(n, monthCols(+m).a, data[m][1]); tq += data[m][0]; ta += data[m][1]; });
    put(n, TOTQ, tq); put(n, TOTA, ta);
  };
  // 블록: 벤더별 행 + 소계, 채널 합계 + 소계. 반환 { next, grand }
  const block = (start, vendors) => {
    let n = start;
    const byProduct = {}, grand = {};
    Object.keys(vendors).forEach(v => {
      const first = n, sub = {};
      vendors[v].forEach(([name, unit, data]) => {
        if (n === first) put(n, 1, v);
        put(n, 2, name); put(n, 3, unit); writeVals(n, data);
        sumInto(sub, data); sumInto(byProduct[name.toLowerCase()] = byProduct[name.toLowerCase()] || {}, data); n++;
      });
      merges.push([first, 1, vendors[v].length, 1]);
      put(n, 1, '소계'); merges.push([n, 1, 1, 3]); writeVals(n, sub); sumInto(grand, sub); n++;
    });
    const first = n, names = Object.keys(byProduct);
    names.forEach(k => { if (n === first) put(n, 1, '채널 합계'); put(n, 2, k); writeVals(n, byProduct[k]); n++; });
    merges.push([first, 1, names.length, 1]);
    put(n, 1, '소계'); merges.push([n, 1, 1, 3]); writeVals(n, grand);
    return { next: n + 1, grand };
  };
  // 2025 블록(이관 대상 아님)
  put(2, 1, '1. 공동구매 _ 2025년 운영 결과');
  put(3, 1, 'ㄴ 월별 품목 매출 현황'); header(4, 2025);
  put(6, 1, '에이버스'); put(6, 2, '더 플렌더'); writeVals(6, { 1: [999, 99900000] });
  put(7, 1, '소계'); writeVals(7, { 1: [999, 99900000] });
  // 2026 계획
  put(9, 1, '2. 공동구매 _ 2026년 사업 계획');
  put(10, 1, 'ㄴ 월별 품목 매출 계획'); put(10, TOTQ, '(단위 : 대, 원, VAT+)');
  header(11, 2026);
  const p = block(13, PLAN);
  const q = [0, 0, 0, 0];
  Object.keys(p.grand).forEach(m => { q[Math.floor((+m - 1) / 3)] += p.grand[m][1]; });
  let n = p.next + 1;
  ['1분기 목표', '2분기 목표', '3분기 목표', '4분기 목표'].forEach((lb, i) => { put(n, 4, lb); put(n, 5, q[i]); n++; });
  put(n, 4, '26년 목표'); put(n, 5, q.reduce((a, b) => a + b, 0)); n += 2;
  // 마감
  put(n, 1, '3. 공동구매 _ 2026년 마감 내역'); n += 2;
  put(n, 1, 'ㄴ 월별 품목 마감 매출'); header(n + 1, 2026);
  const c = block(n + 3, CLOSE);
  const cq = [0, 0, 0, 0];
  Object.keys(c.grand).forEach(m => { cq[Math.floor((+m - 1) / 3)] += c.grand[m][1]; });
  n = c.next + 2;
  ['1분기 마감', '2분기 마감', '3분기 마감', '4분기 마감'].forEach((lb, i) => { put(n, 4, lb); put(n, 5, cq[i]); n++; });
  put(n, 4, '26년 마감'); put(n, 5, cq[2]); // 원본처럼 3분기 값만 들어간 셀
  // 병합 셀은 왼쪽 위만 값이 있다 — 목은 그대로 두고 _offLegacyGrid가 채운다
  return { grid: g, merges, planGrand: p.grand, quarters: q, closeGrand: c.grand };
}

(function main() {
  console.log('\n[1] 공구목표_월 탭 · 채널군');
  {
    const g = loadOfflineGas({ setup: true, today: FX.TODAY });
    const sh = g.tab('공구목표_월');
    check('setup이 공구목표_월 탭을 만든다(헤더)', sh && J(sh._grid[0].slice(0, 10)) === J(['연월', '벤더', '대분류', '품목군', '모델', '목표수량', '목표금액', '출처', '수정일', '수정자']), sh && sh._grid[0]);
    const rep = g.ctx.offline_setupSheets();
    check('다시 실행해도 새로 만들지 않고 확인만(멱등)', rep.created.length === 0 && rep.verified.indexOf('공구목표_월') >= 0, rep);
    const G = g.ctx._offChannelGroup;
    check('채널군 — 전문점·할인점·창고형·백화점 = 오프라인', ['전문점', '할인점', '창고형', '백화점'].every(t => G(t) === 'offline'));
    check('채널군 — 폐쇄몰·특판 = 폐쇄몰·특판', G('폐쇄몰') === 'closed' && G('특판') === 'closed' && G(' 특판 ') === 'closed');
    check('모르는 유형은 빈칸', G('온라인') === '' && G('') === '');
    check('채널군 목록 순서 = 오프라인 → 폐쇄몰·특판 → 공동구매', J(g.ctx.OFF_CHANNEL_GROUPS.map(x => x.label)) === J(['오프라인', '폐쇄몰·특판', '공동구매']));
  }

  console.log('\n[2] 공구 목표 저장·조회');
  {
    const g = FX.env();
    const save = items => g.call('offline_saveGonguTargets', { items }, 'admin');
    let r = save([{ ym: '2026-09', vendor: '모엔즈', line: '더플렌더', model: '더플렌더 MAX', qty: 100, amount: 44900000 },
      { ym: '2026-09', vendor: ' 기타 ', line: '더시프트', model: '더 시프트', qty: 10, amount: '' }]);
    check('저장 성공', r.success && r.saved === 2, r);
    const rows = dataRows(g.tab('공구목표_월'));
    check('모델 표기를 카탈로그 label로 맞추고 대분류를 채움, 출처 input·수정자',
      J(rows[0].slice(0, 8)) === J(['2026-09', '모엔즈', '음식물처리기', '더플렌더', '더 플렌더 MAX', 100, 44900000, 'input']) && rows[0][9] === FX.ADMIN, rows[0]);
    check('벤더 앞뒤 공백 정리, 빈칸 금액은 빈칸', rows[1][1] === '기타' && rows[1][6] === '', rows[1]);
    r = save([{ ym: '2026-09', vendor: '모엔즈', line: '더플렌더', model: '더 플렌더 MAX', amount: 40000000 }]);
    const again = dataRows(g.tab('공구목표_월'));
    check('같은 키면 덮어쓰기(행 수 그대로) · 보내지 않은 수량은 그대로', again.length === 2 && again[0][5] === 100 && again[0][6] === 40000000, again);
    const bad = save([{ ym: '2026-09', vendor: '모엔즈', line: '더플렌더', model: '더 플렌더 MAX', qty: 1 }, { ym: '2026-9', vendor: '모엔즈', line: '더플렌더', model: '더 플렌더 MAX' }]);
    check('한 건이라도 틀리면(연월) 아무것도 쓰지 않는다', /연월이 올바르지 않습니다/.test(bad.error || '') && dataRows(g.tab('공구목표_월'))[0][5] === 100, bad);
    check('모르는 모델·빈 벤더 거절', /모델이 품목 상수에 없습니다/.test(save([{ ym: '2026-09', vendor: 'x', line: '더플렌더', model: '없는모델' }]).error || '') &&
      /벤더가 비었습니다/.test(save([{ ym: '2026-09', vendor: ' ', line: '더슬림', model: '더 슬림' }]).error || ''));
    save([{ ym: '2025-12', vendor: 'KLJ', line: '더슬림', model: '더 슬림', qty: 3 }]);
    const got = g.call('offline_getGonguTargets', { year: '2026' });
    check('조회 — 그 해 행만, 벤더 목록은 모든 해(처음 나온 순)', got.items.length === 2 && J(got.vendors) === J(['모엔즈', '기타', 'KLJ']) &&
      J(got.items[0]) === J({ ym: '2026-09', vendor: '모엔즈', category: '음식물처리기', line: '더플렌더', model: '더 플렌더 MAX', qty: 100, amount: 40000000, source: 'input', updatedAt: FX.TODAY, updatedBy: FX.ADMIN }), got);
    check('연도 형식 오류', /연도가 올바르지 않습니다/.test(g.call('offline_getGonguTargets', { year: '26' }).error || ''));
    check('이관: LEGACY_PROGRESS_SHEET_ID가 없으면 무엇을 넣을지 알려줌', /LEGACY_PROGRESS_SHEET_ID/.test(g.call('offline_migrateGonguTargets', { mode: 'preview' }).error || ''));
  }

  console.log('\n[3] 원본 파싱 — 블록 찾기·병합 채움·합계 행 구분');
  const L = buildLegacy();
  {
    const g = loadOfflineGas({ setup: true, today: FX.TODAY, legacy: { '공동구매 26년 목표': { grid: L.grid, merges: L.merges } } });
    const M = g.ctx._gtMonthOf;
    check('월 머리글 — 날짜·엑셀 일련번호·문자열', M(new Date(Date.UTC(2026, 0, 1)), '2026') === '2026-01' && M(46023) === '2026-01' && M('2026-03') === '2026-03' &&
      M('2026. 4') === '2026-04' && M('26년 5월') === '2026-05' && M('6월', '2026') === '2026-06' && M('구분', '2026') === '' && M('총 합계', '2026') === '');
    const parsed = g.ctx._gtParseLegacy(g.ctx._offLegacyGrid(g.legacy, '공동구매 26년 목표'));
    const P = parsed.plan;
    check('계획 블록 = "매출 계획" 블록(2025 "매출 현황" 블록이 아님) · 1~12월', P.months.length === 12 && P.months[0].ym === '2026-01' && P.months[11].ym === '2026-12', P.months.map(m => m.ym));
    check('벤더 = 모엔즈 → 기타(채널 합계는 벤더가 아님)', J(P.vendorOrder) === J(['모엔즈', '기타']), P.vendorOrder);
    check('벤더 상품 행 9개(병합된 벤더 칸을 채워 읽음, 소계·채널 합계 제외)', P.rows.length === 9 && P.rows.every(r => r.vendor === '모엔즈' || r.vendor === '기타'), P.rows.map(r => r.vendor + '/' + r.product));
    check('상품명 원문·매출금액', J(P.rows.slice(0, 5).map(r => r.product)) === J(['더 에어드라이', '더시프트', '더플렌더 mini', '더플렌더 PRO', '더플렌더 MAX']) && P.rows[1].unitPrice === 300000);
    check('월 값 읽기(병합된 월 머리글 → 수량·매출 열)', J(P.rows[1].values['2026-02']) === J({ qty: 5, amt: 1400000 }) && P.rows[4].values['2026-10'].amt === 5000000, P.rows[1].values['2026-02']);
    check('벤더 소계 · 채널 합계 뒤 소계(전체 합계)', P.vendorTotals['모엔즈'].total.amt === 31900000 && P.vendorTotals['기타'].total.amt === 3700000 && P.grand.total.amt === 35600000 && P.channelTotalRows.length > 0,
      { m: P.vendorTotals['모엔즈'] && P.vendorTotals['모엔즈'].total, g: P.grand && P.grand.total });
    check('1~4분기 목표 · 26년 목표', J(parsed.quarters) === J({ 1: L.quarters[0], 2: L.quarters[1], 3: L.quarters[2], 4: L.quarters[3] }) && parsed.yearTarget === 35600000, parsed.quarters);
    check('마감 블록 — 모엔즈 2행("더플렌더 MINI" 대문자) · 전체 합계', parsed.close && parsed.close.rows.length === 2 && parsed.close.grand.values['2026-03'].amt === 10500000, parsed.close && parsed.close.rows);
    check('26년 마감 셀 값 그대로(원본 수식 값 — 3분기만 들어간 셀)', parsed.yearClose === 1000000, parsed.yearClose);
  }

  console.log('\n[4] 이관 미리보기 — 제안·미매핑·대조');
  {
    // 목 GAS는 전역을 공유한다 — 한 블록에서 한 벌만 띄운다
    const g2 = loadOfflineGas({ setup: true, today: FX.TODAY, legacy: { '공동구매 26년 목표': { grid: L.grid, merges: L.merges } } });
    const tokens = { admin: FX.session(g2.ctx, FX.ADMIN) };
    const call = (action, data) => JSON.parse(g2.ctx.doPost({ postData: { contents: J({ action, session: tokens.admin, data }) }, parameter: {} }));
    const pv = call('offline_migrateGonguTargets', { mode: 'preview' });
    check('미리보기 성공(쓰기 없음)', pv.success && pv.mode === 'preview' && dataRows(g2.tab('공구목표_월')).length === 0, pv.error || pv);
    const sug = {};
    pv.products.forEach(p => { sug[p.legacy] = p.suggest.line + '/' + p.suggest.model; });
    check('제안: 더플렌더 mini/PRO/MAX → 더 플렌더 해당 모델, 더시프트 → 더 시프트, 더 에어드라이 → 더 에어드라이',
      sug['더플렌더 mini'] === '더플렌더/더 플렌더 mini' && sug['더플렌더 PRO'] === '더플렌더/더 플렌더 PRO' && sug['더플렌더 MAX'] === '더플렌더/더 플렌더 MAX' &&
      sug['더시프트'] === '더시프트/더 시프트' && sug['더 에어드라이'] === '더에어드라이/더 에어드라이', sug);
    check('모호한 상품명은 빈칸 → 미매핑', sug['특가세트'] === '/' && pv.unmapped.indexOf('기타 특가세트') >= 0, pv.unmapped);
    check('"더플렌더 MINI"(대문자)도 mini로', g2.ctx._offSuggestProduct('더플렌더 MINI', true).model === '더 플렌더 mini');
    // 이관 대상: 0만 있는 달·값 없는 행 제외 → 모엔즈 시프트 2 + mini 1 + PRO 2 + MAX 2(3월·10월) + 기타 시프트 1 + PRO 1 = 9
    check('반영 예정 9행(0·빈 달 제외, 미매핑 제외)', pv.planRows === 9, pv.planRows);
    const cmp = pv.compare;
    check('대조 — 11월만 다름(미매핑 2,000,000) · 나머지 월 일치', cmp.months.filter(m => !m.ok).map(m => m.ym).join() === '2026-11' &&
      cmp.months.find(m => m.ym === '2026-11').legacyAmt === 2000000 && cmp.months.find(m => m.ym === '2026-11').planAmt == null, cmp.months);
    check('대조 — 연 합계·26년 목표·4분기·기타 소계가 다르다고 표시', !cmp.total.ok && !cmp.year.ok && !cmp.quarters[3].ok && cmp.quarters[0].ok &&
      cmp.vendors.find(v => v.vendor === '모엔즈').ok && !cmp.vendors.find(v => v.vendor === '기타').ok, { t: cmp.total, q: cmp.quarters, v: cmp.vendors });
    check('마감 매출 월별 합계를 같이 준다(이관하지 않음)', cmp.close.found && J(cmp.close.months.find(m => m.ym === '2026-01')) === J({ ym: '2026-01', qty: 9, amt: 3800000 }), cmp.close);

    console.log('\n[5] 매핑을 고쳐 다시 계산 → 반영(멱등, input 보존, 원본 읽기만)');
    const mapping = { products: {} };
    pv.products.forEach(p => { mapping.products[p.legacy] = { line: p.suggest.line, model: p.suggest.model }; });
    mapping.products['특가세트'] = { line: '더플렌더', model: '더 플렌더 MAX' };
    const pv2 = call('offline_migrateGonguTargets', { mode: 'preview', mapping });
    check('모두 매핑하면 대조 전부 일치(월·연·분기·벤더)', pv2.compare.months.every(m => m.ok) && pv2.compare.total.ok && pv2.compare.year.ok && pv2.compare.quarters.every(q => q.ok) && pv2.compare.vendors.every(v => v.ok),
      pv2.compare);
    // 사람이 입력한 값 하나(이관 키와 같은 키) — 이관이 덮어쓰면 안 된다
    call('offline_saveGonguTargets', { items: [{ ym: '2026-01', vendor: '모엔즈', line: '더시프트', model: '더 시프트', qty: 11, amount: 3300000 }] });
    const a1 = call('offline_migrateGonguTargets', { mode: 'apply', mapping });
    const rows1 = dataRows(g2.tab('공구목표_월'));
    check('반영 — 9행 중 input과 겹치는 1행은 건너뜀, input 보존', a1.success && a1.written === 9 && a1.skippedInput === 1 &&
      rows1.length === 10 && rows1.filter(r => r[7] === 'input').length === 1 && rows1.find(r => r[7] === 'input')[5] === 11, { a1: a1.error || [a1.written, a1.skippedInput], rows1 });
    const mig = rows1.find(r => r[7] === 'migration' && r[1] === '모엔즈' && r[4] === '더 시프트' && r[0] === '2026-02');
    check('금액은 원본 값 그대로(5 × 300,000이 아니라 1,400,000)', mig && mig[5] === 5 && mig[6] === 1400000 && mig[2] === '김치냉장고', mig);
    const a2 = call('offline_migrateGonguTargets', { mode: 'apply', mapping });
    const rows2 = dataRows(g2.tab('공구목표_월'));
    check('두 번 반영해도 행 수 불변(migration만 교체)', a2.success && rows2.length === rows1.length && a2.removed === 9, { n1: rows1.length, n2: rows2.length, removed: a2.removed });
    check('이관로그 기록(대상 공구 목표 · 월 범위)', a2.recentLog.length >= 2 && a2.recentLog[0].target === '공구 목표' && a2.recentLog[0].range === '2026-01~2026-12' && /입력값 보존 1건/.test(a2.recentLog[0].status), a2.recentLog[0]);
    check('원본 스프레드시트는 읽기 메서드만 호출', g2.legacy._calls.every(c => ['getSheetByName', 'getLastRow', 'getLastColumn', 'getValues', 'getMergedRanges'].indexOf(c) >= 0), [...new Set(g2.legacy._calls)]);
  }

  console.log('\n[6] home_getSummary — 채널군 금액·공구 목표·필터·대분류 판매·오늘 챙길 것');
  {
    const g = FX.env();
    const T = g.ctx.OFF_TABS;
    const append = (key, rows) => { const sh = g.tab(T[key].name); g.ctx._offWriteBlock(sh, T[key], sh.getLastRow() + 1, rows); };
    // 폐쇄몰 채널 + 유형 모르는 채널, 필터 SKU
    append('channel', [['theablen', '디에이블앤', '폐쇄몰', 'N', 6, '', '', '', 'theablen'], ['odd', '이상한 채널', '온라인', 'N', 9, '', '', '', 'odd']]);
    append('sku', [['SKU-0009', '필터 하드락필터', '필터', '하드락필터', '', 'Y', '', '']]);
    const TG = (ym, ch, line, model, type, t, a) => [ym, ch, line, model, type, t, a, 'input', FX.TODAY, 'a', '', ''];
    append('targets', [TG('2026-09', 'himart', '더플렌더', '더 플렌더 MAX', 'IN', 100, 80), TG('2026-09', 'emart', '더플렌더', '더 플렌더 MAX', 'IN', 50, 60),
      TG('2026-08', 'himart', '더플렌더', '더 플렌더 MAX', 'IN', 40, 40), TG('2026-09', 'theablen', '더슬림', '더 슬림', 'IN', 10, 5),
      TG('2026-09', 'odd', '더슬림', '더 슬림', 'IN', 2, 1), TG('2026-09', 'himart', '필터', '하드락필터', 'IN', '', 30),
      TG('2026-09', 'himart', '미니건조기', '미니 건조기 PRO', 'IN', 20, '')]); // 미니 건조기 PRO는 단가 없음 → 금액 미완
    const PR = (ch, line, model, p) => [ch, line, model, p, '2026-01-01', '', '', ''];
    append('prices', [PR('himart', '더플렌더', '더 플렌더 MAX', 400000), PR('emart', '더플렌더', '더 플렌더 MAX', 390000), PR('theablen', '더슬림', '더 슬림', 200000),
      PR('odd', '더슬림', '더 슬림', 100000), PR('himart', '필터', '하드락필터', 20000)]);
    g.call('offline_saveGonguTargets', { items: [{ ym: '2026-09', vendor: '모엔즈', line: '더플렌더', model: '더 플렌더 MAX', qty: 100, amount: 44900000 },
      { ym: '2026-09', vendor: '기타', line: '더에어드라이', model: '더 에어드라이', qty: 10, amount: 3590000 },
      { ym: '2026-08', vendor: '모엔즈', line: '더시프트', model: '더 시프트', qty: 5, amount: 1795000 }] }, 'admin');
    const s = g.call('home_getSummary', { ym: '2026-09', mode: 'month' });
    check('성공 · 1~12월 · 범위 = 그 달', s.success && s.months.length === 12 && J(s.range) === J(['2026-09']), s.error || s.range);
    const S = (grp, ym) => s.series[grp][ym];
    check('오프라인 9월 IN 실적 = 하이마트 80×400,000 + 이마트 60×390,000 + 유형 모르는 채널 1×100,000(오프라인으로)',
      S('offline', '2026-09').actual === 80 * 400000 + 60 * 390000 + 100000, S('offline', '2026-09'));
    check('오프라인 9월 IN 목표 금액', S('offline', '2026-09').target === 100 * 400000 + 50 * 390000 + 2 * 100000, S('offline', '2026-09'));
    check('단가 없는 모델이 섞이면 금액 미완 표시', S('offline', '2026-09').incomplete === true);
    check('폐쇄몰·특판 = 디에이블앤 5 × 200,000', S('closed', '2026-09').actual === 1000000 && S('closed', '2026-09').target === 2000000, S('closed', '2026-09'));
    check('필터는 본품 합계에서 빠지고 따로(9월 IN 30개 × 20,000)', s.filter.amount === 600000 && s.filter.qty === 30 && S('offline', '2026-09').actual < 60000000, s.filter);
    check('공동구매 목표 = 공구목표_월 목표금액(본품)', S('gongu', '2026-09').target === 44900000 + 3590000 && S('gongu', '2026-09').targetQty === 110 && S('gongu', '2026-08').target === 1795000 && S('gongu', '2026-09').actual == null, S('gongu', '2026-09'));
    check('유형 모르는 채널 경고', s.warnings.some(w => /이상한 채널\(온라인\)/.test(w)), s.warnings);
    // 채널 현황의 IN 금액(= offline_getMonthly byChannelMonth 합)과 같다
    const mon = g.call('offline_getMonthly', { from: '2026-01', to: '2026-12', totalsOnly: true });
    ['2026-08', '2026-09'].forEach(ym => {
      const want = mon.totals.byChannelMonth.filter(x => x.ym === ym).reduce((a, x) => a + (x.in.actualAmount || 0), 0);
      check(ym + ' 오프라인 + 폐쇄몰·특판 = 채널 현황 IN 금액(' + want + ')', (S('offline', ym).actual || 0) + (S('closed', ym).actual || 0) === want, [S('offline', ym), S('closed', ym)]);
    });
    const ytd = g.call('home_getSummary', { ym: '2026-09', mode: 'ytd' });
    check('연 누적 범위 = 1~9월, 필터 누적', ytd.range.length === 9 && ytd.range[8] === '2026-09' && ytd.filter.amount === 600000, ytd.range);
    // 대분류별 그 달 판매 — OUT(원장): 하이마트 더 플렌더 MAX 9월 28 + 전자랜드 4 = 32 · 미니 건조기 PRO 28 · 더 슬림 28
    const cs = {}; s.categorySales.forEach(c => { cs[c.category] = c; });
    check('대분류별 판매 = 본품 대분류(필터·기타 없음)', J(s.categorySales.map(c => c.category)) === J(['음식물처리기', '김치냉장고', '청소기', '건조기', '식세기']), s.categorySales.map(c => c.category));
    const mon9 = g.call('offline_getMonthly', { from: '2026-09', to: '2026-09', totalsOnly: true });
    const outOf = c => mon9.totals.byCategory.filter(x => x.category === c).reduce((a, x) => a + (x.out.actual || 0), 0);
    const q = c => (cs[c].offline.qty || 0) + (cs[c].closed.qty || 0);
    check('대분류별 OUT 수량(오프라인 + 폐쇄몰·특판) = 월별 해석 byCategory 합', q('음식물처리기') === outOf('음식물처리기') && q('건조기') === outOf('건조기') && q('청소기') === outOf('청소기') && outOf('음식물처리기') > 0,
      { got: s.categorySales, want: [outOf('음식물처리기'), outOf('건조기'), outOf('청소기')] });
    // 오늘 챙길 것 — 재고 현황 경보(채널 × SKU)·점포 결품, 미매칭(코드 매핑 목록 수), 데이터 지연
    const inv = g.call('offline_getInventory', {});
    const alerts = { over: 0, risk: 0, storeOut: inv.storeOuts.length };
    inv.groups.forEach(x => { if (x.level === 'sku' && x.channelId !== '*' && x.alert) alerts[x.alert]++; });
    check('재고 경보 = 재고 현황 경보 탭 건수', J(s.today.alerts) === J(alerts), { got: s.today.alerts, want: alerts });
    check('미매칭 = 코드 매핑 미매칭 목록 수', s.today.unmatched === g.call('offline_getUnmatched').items.length && s.today.unmatched > 0, s.today.unmatched);
    const stale = inv.channels.filter(c => c.staleSales || c.staleStock).map(c => c.channelId);
    check('업로드 지연 채널 = 재고 지표의 지연 경고 채널', J(s.today.delayed.map(c => c.channelId)) === J(stale) && stale.length > 0, { got: s.today.delayed, stale });
    check('데이터 기준일 요약 = 업로드 데이터가 있는 채널', s.freshness.length === inv.channels.filter(c => c.hasStock || c.hasSales).length && s.staleDays === 3, s.freshness);

    console.log('\n[7] 대분류 필터 · 캐시·무효화 · 입력 검증');
    const f = g.call('home_getSummary', { ym: '2026-09', mode: 'month', category: '청소기' });
    check('대분류 필터(청소기) — 오프라인·폐쇄몰은 그 대분류 byCategory, 공구 목표도 그 대분류만, 필터 줄 없음',
      f.series.closed['2026-09'].actual === 1000000 && f.series.offline['2026-09'].actual === 100000 && f.series.gongu['2026-09'].target == null && f.filter.amount == null && J(f.categorySales.map(c => c.category)) === J(['청소기']),
      { off: f.series.offline['2026-09'], cl: f.series.closed['2026-09'], gg: f.series.gongu['2026-09'] });
    const f2 = g.call('home_getSummary', { ym: '2026-09', mode: 'month', category: '건조기' });
    check('대분류 필터(건조기) — 공구 목표 더 에어드라이만', f2.series.gongu['2026-09'].target === 3590000, f2.series.gongu['2026-09']);
    const c1 = g.call('home_getSummary', { ym: '2026-09', mode: 'month' });
    check('같은 조회는 캐시(5분)', c1.cached === true);
    g.call('offline_saveGonguTargets', { items: [{ ym: '2026-09', vendor: '모엔즈', line: '더플렌더', model: '더 플렌더 MAX', amount: 50000000 }] }, 'admin');
    const c2 = g.call('home_getSummary', { ym: '2026-09', mode: 'month' });
    check('공구 목표를 저장하면 캐시 무효 → 새 값', !c2.cached && c2.series.gongu['2026-09'].target === 50000000 + 3590000, c2.series.gongu['2026-09']);
    g.call('offline_saveTargets', { items: [{ ym: '2026-09', channelId: 'emart', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 50, actual: 70 }] }, 'admin');
    const c3 = g.call('home_getSummary', { ym: '2026-09', mode: 'month' });
    check('오프라인 목표·실적을 저장해도 무효 → 새 값', !c3.cached && c3.series.offline['2026-09'].actual === 80 * 400000 + 70 * 390000 + 100000, c3.series.offline['2026-09']);
    check('연월·대분류 검증', /연월이 올바르지 않습니다/.test(g.call('home_getSummary', { ym: '2026-9' }).error || '') && /대분류가 올바르지 않습니다/.test(g.call('home_getSummary', { ym: '2026-09', category: '없음' }).error || ''));
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})();
