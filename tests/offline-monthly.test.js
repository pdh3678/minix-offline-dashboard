/* 월별 실적 해석(apps-script-offline-targets.js의 _offMonthlyCompute / _offGetMonthly) — 2-B 화면도 이 결과를 쓴다.

   지키려는 성질:
     · IN 목표·IN 실적·OUT 목표 = 목표실적_월
     · OUT 실적: 연월 ≥ 업로드시작월이면 판매원장 집계(그 달 목표실적_월 OUT 실적은 무시), 그 외는 목표실적_월
       — 원천(upload/manual/migration)을 함께 준다
     · 원장 집계: 원본코드 → 활성 코드매핑 → sku → 품목군·모델. day는 그 날, period는 기간종료일의 달.
       재고구분과 무관하게 합산하되 구분별 소계, 매핑 없는 코드는 '미매칭'으로 따로(합계에 빠졌다고 경고)
     · 모델 표기는 카탈로그 label로 맞춘다('더플렌더 MAX'·'MAX' → '더 플렌더 MAX', 빈 모델 → 기본 모델)
     · 금액 = 수량 × 그 달 1일 기준 가장 최근 적용시작일의 공급가, 없으면 null + 경고
     · 달성률 = 실적 / 목표(목표 0·빈칸이면 null), 채널×월·월 합계
     · 캐시는 쓰기(무효화) 뒤 새로 계산

   실행: node tests/offline-monthly.test.js  (또는 node tests/run-all.js) */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { loadOfflineGas, PROJ } = require(path.join(__dirname, 'lib', 'offline-gas.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const J = JSON.stringify;

// ── 픽스처(각 탭 _offReadRows 모양) ──
const CHANNELS = [
  ['himart', '하이마트', '전문점', 'Y', 1, '2026-09'],
  ['traders', '트레이더스', '창고형', 'N', 4, ''],
  ['emart', '이마트', '할인점', 'Y', 3, '2026-09']
];
const SKUS = [
  ['SKU-0001', '더 플렌더 MAX', '더플렌더', '더 플렌더 MAX', '', 'Y', '', ''],
  ['SKU-0002', '더 슬림', '더슬림', '', '', 'Y', '', ''],
  ['SKU-0003', '더 플렌더 PRO', '더플렌더', 'PRO', '', 'Y', '', '']
];
const MAPPINGS = [
  ['himart', 'MNFD-200G', 'SKU-0001', '정상', '', '', '', ''],
  ['himart', '(J)MNFD-200G', 'SKU-0001', '전시', '', '', '', ''],
  ['himart', 'MNVC-100G', 'SKU-0002', '정상', '', '', '', ''],
  ['himart', 'MNFD-120G', 'SKU-0003', '리퍼', '', '', '', ''],
  ['himart', 'OLD-CODE', '', '정상', '', '', '', '비활성화']
];
const T = (ym, ch, line, model, type, target, actual, src) => [ym, ch, line, model, type, target, actual, src || 'input', '2026-09-27', 'x@a', ''];
const TARGETS = [
  T('2026-08', 'himart', '더플렌더', '더 플렌더 MAX', 'IN', 100, 90),
  T('2026-08', 'himart', '더플렌더', '더 플렌더 MAX', 'OUT', 80, 70, 'migration'),
  T('2026-09', 'himart', '더플렌더', '더플렌더 MAX', 'IN', 100, 110),
  T('2026-09', 'himart', '더플렌더', '더 플렌더 MAX', 'OUT', 90, 999, 'migration'), // 업로드 달 — 실적 999는 무시돼야 함
  T('2026-09', 'traders', '더시프트', '더시프트', 'IN', 10, 5),
  T('2026-09', 'traders', '더시프트', '더시프트', 'OUT', 8, 6),
  T('2026-09', 'traders', '더슬림', '더 슬림', 'IN', 0, 3),
  T('2026-09', 'emart', '더플렌더', '더 플렌더 mini', 'OUT', 20, '')
];
const S = (a, b, ch, code, qty) => [a, b, a === b ? 'day' : 'period', ch, 'ST1', code, qty, '', 'upload', 'U1'];
const SALES = [
  S('2026-09-02', '2026-09-02', 'himart', 'MNFD-200G', 3),
  S('2026-09-03', '2026-09-03', 'himart', '(J)MNFD-200G', 1),
  S('2026-08-25', '2026-09-01', 'himart', 'MNFD-200G', 2),      // period → 기간종료일(9/1)의 달
  S('2026-07-30', '2026-08-31', 'himart', 'MNFD-200G', 5),      // 8월 = 업로드 전 → 원장 무시
  S('2026-09-04', '2026-09-04', 'himart', 'MNFD-RF3', 4),       // 매핑 없음
  S('2026-09-05', '2026-09-05', 'himart', 'OLD-CODE', 1),       // 비활성 매핑
  S('2026-09-05', '2026-09-05', 'himart', 'MNVC-100G', 2),      // 모델 빈 SKU → 더 슬림
  S('2026-09-06', '2026-09-06', 'himart', 'MNFD-120G', -1),     // 반품, 리퍼
  S('2026-10-01', '2026-10-01', 'himart', 'MNFD-200G', 7)       // 범위 밖
];
const PRICES = [
  ['himart', '더플렌더', 'MAX', 300000, '2026-01-01', '', '', ''],
  ['himart', '더플렌더', '더 플렌더 MAX', 320000, '2026-09-01', '', '', ''],
  ['himart', '더플렌더', '더 플렌더 MAX', 350000, '2026-09-15', '', '', ''],
  ['traders', '더시프트', '더 시프트', 270000, '2026-04-09', '', '', '']
];
const base = () => ({ from: '2026-08', to: '2026-09', channels: CHANNELS, targets: TARGETS, prices: PRICES, sales: SALES, mappings: MAPPINGS, skus: SKUS });

(function main() {
  const { ctx } = loadOfflineGas({ setup: true, today: '2026-09-27' });

  console.log('\n[1] GAS 모델 카탈로그 = 프론트 PRODUCT_CATALOG');
  {
    const box = {};
    vm.runInContext(fs.readFileSync(path.join(PROJ, 'src', 'shared', 'constants', 'products.js'), 'utf8') + '\n;globalThis.__C = PRODUCT_CATALOG;', vm.createContext(box));
    const front = {}; box.__C.forEach(l => { front[l.key] = l.models.map(m => m.label); });
    check('품목군·모델 label·순서가 같다', J(ctx.OFFLINE_PRODUCT_MODELS) === J(front), { gas: ctx.OFFLINE_PRODUCT_MODELS, front });
    check('품목군 목록 = OFFLINE_PRODUCT_LINES', J(Object.keys(ctx.OFFLINE_PRODUCT_MODELS)) === J(ctx.OFFLINE_PRODUCT_LINES));
    const frontCat = box.__C.map(l => ({ line: l.key, category: l.category, models: l.models.map(m => m.label) }));
    check('GAS OFFLINE_CATALOG(품목군·대분류·모델) = 프론트 PRODUCT_CATALOG', J(ctx.OFFLINE_CATALOG) === J(frontCat), { gas: ctx.OFFLINE_CATALOG, front: frontCat });
    check('대분류: 더 에어드라이·미니 건조기 → 건조기(품목군은 따로)', ctx.OFFLINE_LINE_CATEGORY['더에어드라이'] === '건조기' && ctx.OFFLINE_LINE_CATEGORY['미니건조기'] === '건조기' && J(ctx.OFFLINE_CATEGORIES) === J(['음식물처리기', '김치냉장고', '청소기', '건조기', '식세기']));
  }

  console.log('\n[2] 모델 표기 정규화');
  [
    ['더플렌더', '더플렌더 MAX', '더 플렌더 MAX', true], ['더플렌더', 'MAX', '더 플렌더 MAX', true], ['더플렌더', 'max', '더 플렌더 MAX', true],
    ['더플렌더', '더플렌더 MINI', '더 플렌더 mini', true], ['더플렌더', 'BASIC', '더 플렌더 Basic', true],
    ['더슬림', '', '더 슬림', true], ['더시프트', '더시프트', '더 시프트', true], ['미니건조기', '미니 건조기 PRO+', '미니 건조기 PRO+', true],
    ['미니건조기', 'PRO', '미니 건조기 PRO', true], ['더플렌더', '', '', false], ['더플렌더', 'XYZ', 'XYZ', false], ['모르는품목', 'A', 'A', false]
  ].forEach(([line, m, want, known]) => {
    const r = ctx._offCanonModel(line, m);
    check(`${line} / "${m}" → "${want}"${known ? '' : ' (카탈로그 밖)'}`, r.model === want && r.known === known, r);
  });

  console.log('\n[3] 월별 해석 — 업로드 전후, 원천, 원장 집계');
  const res = ctx._offMonthlyCompute(base());
  const find = (ym, ch, model) => res.rows.find(r => r.ym === ym && r.channelId === ch && r.model === model);
  {
    const a8 = find('2026-08', 'himart', '더 플렌더 MAX');
    check('8월(업로드 전) OUT 실적 = 목표실적_월 값 70, 원천 migration', a8 && a8.out.actual === 70 && a8.out.source === 'migration', a8 && a8.out);
    check('  ↳ 8월 원장 period(7/30~8/31, 5개)는 무시', a8.out.actual === 70);
    check('  ↳ IN 목표 100 / 실적 90, 달성률 0.9', a8['in'].target === 100 && a8['in'].actual === 90 && a8['in'].rate === 0.9, a8['in']);
    const a9 = find('2026-09', 'himart', '더 플렌더 MAX');
    check('9월(업로드 달) OUT 실적 = 원장 3+1+2 = 6, 원천 upload', a9 && a9.out.actual === 6 && a9.out.source === 'upload', a9 && a9.out);
    check('  ↳ 목표실적_월의 9월 OUT 실적(999)은 쓰지 않음', a9.out.actual !== 999);
    check('  ↳ period(8/25~9/1)는 기간종료일의 달(9월)', a9.out.actual === 6);
    check('  ↳ 재고구분별 소계 정상 5 · 전시 1', a9.out.byType['정상'] === 5 && a9.out.byType['전시'] === 1 && a9.out.byType['리퍼'] === 0, a9.out.byType);
    check('  ↳ IN 행의 "더플렌더 MAX" 표기가 같은 행으로 합쳐짐', a9['in'].target === 100 && a9['in'].actual === 110 && res.rows.filter(r => r.ym === '2026-09' && r.channelId === 'himart' && r.line === '더플렌더' && /MAX/i.test(r.model)).length === 1);
    const slim = find('2026-09', 'himart', '더 슬림');
    check('모델 빈 SKU → 더 슬림 행, 원장 2', slim && slim.out.actual === 2 && slim.out.source === 'upload', slim && slim.out);
    const pro = find('2026-09', 'himart', '더 플렌더 PRO');
    check('반품 음수·리퍼도 합산(PRO −1, 리퍼 소계 −1)', pro && pro.out.actual === -1 && pro.out.byType['리퍼'] === -1, pro && pro.out);
    check('범위 밖(10월) 원장은 빠짐', !res.rows.some(r => r.ym === '2026-10'));
    const tr = find('2026-09', 'traders', '더 시프트');
    check('업로드 없는 채널: OUT 실적 = 입력값 6, 원천 manual', tr && tr.out.actual === 6 && tr.out.source === 'manual', tr && tr.out);
    const em = find('2026-09', 'emart', '더 플렌더 mini');
    check('업로드 달인데 판매가 없으면 OUT 실적 0(원천 upload)', em && em.out.actual === 0 && em.out.source === 'upload' && em.out.target === 20, em && em.out);
    const trSlim = find('2026-09', 'traders', '더 슬림');
    check('목표 0이면 달성률 null', trSlim && trSlim['in'].rate === null && trSlim['in'].actual === 3, trSlim && trSlim['in']);
    check('IN만 있는 행(업로드 없는 채널)은 OUT 실적 null·원천 빈칸', trSlim.out.actual === null && trSlim.out.source === '');
  }

  console.log('\n[4] 미매칭 — 합계에 넣지 않고 따로 + 경고');
  {
    check('미매칭 2건(매핑 없음 MNFD-RF3 4, 비활성 매핑 OLD-CODE 1)', J(res.unmatched) === J([
      { ym: '2026-09', channelId: 'himart', code: 'MNFD-RF3', qty: 4 }, { ym: '2026-09', channelId: 'himart', code: 'OLD-CODE', qty: 1 }]), res.unmatched);
    const t = res.totals.byChannelMonth.find(x => x.ym === '2026-09' && x.channelId === 'himart');
    check('채널 합계 OUT 실적 = 6+2−1 = 7(미매칭 제외), 미매칭 수량 5 따로', t.out.actual === 7 && t.out.unmatchedQty === 5, t.out);
    check('경고 문구에 건수·수량', res.warnings.some(w => /매핑 안 된 코드 2건\(수량 5\)/.test(w)), res.warnings);
    const sumLedger9 = SALES.filter(s => s[3] === 'himart' && s[1].slice(0, 7) === '2026-09').reduce((a, s) => a + s[6], 0);
    check('원장 9월 합계 = 집계 합계 + 미매칭 (누락 없음)', sumLedger9 === t.out.actual + t.out.unmatchedQty, { sumLedger9, got: t.out.actual + t.out.unmatchedQty });
  }

  console.log('\n[5] 금액 — 그 달 1일 기준 가장 최근 적용시작일의 공급가');
  {
    const a8 = find('2026-08', 'himart', '더 플렌더 MAX'), a9 = find('2026-09', 'himart', '더 플렌더 MAX');
    check('8월 단가 300,000 (단가 행의 "MAX" 표기도 인식)', a8.price === 300000 && a8.out.actualAmount === 70 * 300000, a8.price);
    check('9월 단가 320,000 (9/1 적용분 — 9/15 적용분은 10월부터)', a9.price === 320000 && a9['in'].actualAmount === 110 * 320000 && a9.out.targetAmount === 90 * 320000, a9.price);
    const slim = find('2026-09', 'himart', '더 슬림');
    check('단가 없으면 금액 null + 경고', slim.price === null && slim.out.actualAmount === null && res.warnings.some(w => /단가 없음.*더 슬림/.test(w)), res.warnings);
    const tr = find('2026-09', 'traders', '더 시프트');
    check('업로드 없는 채널도 입력 수량 × 단가', tr.out.actualAmount === 6 * 270000);
    const t = res.totals.byChannelMonth.find(x => x.ym === '2026-09' && x.channelId === 'himart');
    check('단가 없는 행이 섞인 합계 금액은 incomplete 표시', t.out.amountIncomplete === true && t.out.actualAmount === 6 * 320000, t.out);
  }

  console.log('\n[6] 합계·달성률·정렬·채널 필터');
  {
    const m9 = res.totals.byMonth.find(x => x.ym === '2026-09');
    check('9월 전체 IN 목표 = 100+10+0 = 110, 실적 118', m9['in'].target === 110 && m9['in'].actual === 118, m9['in']);
    check('9월 전체 OUT 실적 = 7+6+0 = 13, 달성률 = 13/118', m9.out.actual === 13 && m9.out.target === 118 && Math.abs(m9.out.rate - 13 / 118) < 1e-12, m9.out);
    const order = res.rows.filter(r => r.ym === '2026-09').map(r => r.channelId + ':' + r.model);
    check('정렬: 채널 정렬순서 → 품목군 → 모델(카탈로그 순)', J(order) === J(['himart:더 플렌더 PRO', 'himart:더 플렌더 MAX', 'himart:더 슬림', 'emart:더 플렌더 mini', 'traders:더 시프트', 'traders:더 슬림']), order);
    const only = ctx._offMonthlyCompute(Object.assign(base(), { channelId: 'traders' }));
    check('채널 필터: 트레이더스만', only.rows.length && only.rows.every(r => r.channelId === 'traders') && only.unmatched.length === 0 && only.channels.length === 1);
    check('월 목록', J(res.months) === J(['2026-08', '2026-09']));
  }

  console.log('\n[7] 시트에서 읽기 + 캐시(쓰기 후 새로 계산)');
  {
    const g = loadOfflineGas({ setup: true, today: '2026-09-27' });
    const w = (tab, key, rows) => g.ctx._offWriteBlock(g.tab(tab), g.ctx.OFF_TABS[key], 2, rows);
    w('제품마스터', 'sku', SKUS); w('코드매핑', 'mapping', MAPPINGS); w('목표실적_월', 'targets', TARGETS);
    w('단가마스터', 'prices', PRICES); w('판매원장', 'sales', SALES);
    const r1 = g.ctx._offGetMonthly({ from: '2026-08', to: '2026-09' });
    const pure = g.ctx._offMonthlyCompute(Object.assign(base(), { channels: g.ctx._offReadRows(g.tab('채널마스터'), g.ctx.OFF_TABS.channel) }));
    check('시트 경유 결과 = 순수 계산 결과', J(r1.rows) === J(pure.rows) && J(r1.totals) === J(pure.totals), r1.rows.length);
    check('두 번째 조회는 캐시', g.ctx._offGetMonthly({ from: '2026-08', to: '2026-09' }).cached === true);
    g.ctx._offInvalidateCache();
    check('무효화 뒤에는 새로 계산', !g.ctx._offGetMonthly({ from: '2026-08', to: '2026-09' }).cached);
    check('조건이 다르면 다른 캐시(채널 필터)', !g.ctx._offGetMonthly({ from: '2026-08', to: '2026-09', channelId: 'himart' }).cached);
    const bad = (d, re) => { let e = null; try { g.ctx._offGetMonthly(d); } catch (x) { e = x; } return e && re.test(e.message); };
    check('연월 형식 오류 거절', bad({ from: '2026-9', to: '2026-09' }, /연월 범위/));
    check('시작 > 끝 거절', bad({ from: '2026-10', to: '2026-09' }, /연월 범위/));
    check('36개월 초과 거절', bad({ from: '2023-01', to: '2026-09' }, /36개월/));
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})();
