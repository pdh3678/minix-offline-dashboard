/* 2-A GAS API — 목표 저장, 단가, 진행현황·납품가 이관(apps-script-offline-targets.js).

   지키려는 성질:
     · 목표 저장: 출처 input·수정자 = 세션 이메일, 카탈로그 모델만, 업로드시작월 이후 OUT 실적은 입력 거절
     · 단가: (채널·품목군·모델·적용시작일) upsert, 적용시작일 옮기기, 월별 금액에 반영
     · 진행현황 이관: 3·4행 헤더로 월별 열을 동적으로 찾고(블록 폭이 다름, 1월은 IN만, 헤더 없는 참조 열 무시),
       병합 셀 채널을 채워 읽고, 소계·TIP 행은 뺀다. 품목명 제안(대소문자·띄어쓰기 무시, 건조기·식세기는 모델 빈칸)
       · 대상: 모든 월 IN 목표·실적·OUT 목표 + OUT 실적은 업로드시작월 이전 달만(업로드 없는 채널은 전부)
       · 미리보기는 아무것도 쓰지 않는다 / 반영은 migration 행만 교체 — 두 번 해도 같고, input 행은 보존
       · 업로드시작월 대조: 진행현황 OUT 실적 vs 원장 집계(이관하지 않음), 채널 합계 + 미매칭
     · 납품가 이관: 제목의 기준일, MN 코드 → 이미 매핑된 SKU로 모델 제안, 반영은 upsert(멱등)
     · 원본 스프레드시트에는 읽기 호출만 한다(목에 쓰기 메서드가 없음)

   실행: node tests/offline-targets.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadOfflineGas, dataRows } = require(path.join(__dirname, 'lib', 'offline-gas.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const J = JSON.stringify;
const AUTH = { email: 'planner@athomecorp.com' };
const TODAY = '2026-09-27';

// ── 합성 원본: '26년 진행현황' (A1 기준 0-based 열) ──
function progressGrid() {
  const W = 26, g = [];
  const row = cells => { const r = new Array(W).fill(''); Object.keys(cells).forEach(k => { r[k] = cells[k]; }); return r; };
  g.push(row({}));
  g.push(row({ 1: '26년 매출 목표 / 진행현황' }));
  g.push(row({ 1: '구분', 2: '채널', 3: '품목', 4: 'TOTAL 성 과 (2월~)', 5: '1월', 9: '2월', 17: '9월' }));
  g.push(row({ 5: '목표 (IN)', 6: '실적 (IN)', 7: '달성률(IN)', 9: '목표 (IN)', 10: '실적 (IN)', 11: '달성률(IN)', 13: '목표(OUT)', 14: '실적(OUT)', 15: '달성률(OUT)',
    17: '목표 (IN)', 18: '실적 (IN)', 19: '달성률(IN)', 21: '목표(OUT)', 22: '실적(OUT)', 24: '전월동기간(OUT)', 25: '달성률(OUT)' }));
  // 1월 F·G / 2월 J·K·N·O / 9월 R·S·V·W (X는 헤더 없는 전월 참조 — 무시돼야 함)
  const d = (b, c, prod, v) => row(Object.assign({ 1: b, 2: c, 3: prod }, v));
  g.push(d('오프라인', '하이마트', '더플렌더 MAX', { 4: 1234, 5: 300, 6: 544, 9: 300, 10: 524, 13: 500, 14: 399, 17: 100, 18: 216, 21: 300, 22: 99, 23: 393, 24: -0.74 }));
  g.push(d('', '', '더플렌더 mini', { 6: 10, 9: 20, 13: 30, 14: 25, 17: 40, 18: 42, 21: 50, 22: '#REF!' }));
  g.push(d('', '', '더플렌더 Mini', { 5: 5, 6: 1, 17: 1, 18: 1, 21: 2, 22: 3 }));
  g.push(d('', '', '건조기', { 9: 10, 10: 12, 13: 8, 14: 9, 21: 7, 22: 6 }));
  g.push(d('', '', '소계', { 5: 305, 6: 555, 9: 330, 10: 536 }));
  g.push(d('', '트레이더스', '더플렌더 MAX', { 17: 50, 18: 60, 21: 40, 22: 35 }));
  g.push(d('', '', '에어드라이', { 9: 5, 10: 5, 13: 5, 14: 4 }));
  g.push(d('', '이마트할인점', '더플렌더 MINI', { 17: 30, 18: 31, 21: 20, 22: 18 }));
  g.push(d('', '', '더플렌더 PLUS', { 21: 70, 22: 65 }));
  g.push(d('기타', '특판', '식세기', { 9: 3, 10: 2 }));
  g.push(row({ 2: 'TIP) 목표/실적만 입력하면 달성률이 자동 계산됩니다.' }));
  g.push(row({ 4: 'abc', 5: 123 }));
  // 실제 원본처럼 월 라벨(3행)이 블록 폭만큼, 구분·채널·품목 헤더가 3~4행으로 병합돼 있다
  return { grid: g, merges: [[5, 2, 9, 1], [5, 3, 5, 1], [10, 3, 2, 1], [12, 3, 2, 1], [3, 6, 1, 4], [3, 10, 1, 8], [3, 18, 1, 9], [3, 2, 2, 1], [3, 3, 2, 1], [3, 4, 2, 1]] };
}
// ── 합성 원본: '납품가 수수료' ──
function priceGrid() {
  const W = 11, g = [];
  const row = cells => { const r = new Array(W).fill(''); Object.keys(cells).forEach(k => { r[k] = cells[k]; }); return r; };
  g.push(row({ 1: '2026. 4. 9일자 업데이트', 8: '(원, 부가세포함 기준)' }));
  g.push(row({ 1: '채널', 2: '품목', 3: '모델명', 4: '판매가', 5: '공급가', 6: '공급수수료', 7: '마진금액(판매가-공급가)', 8: '비고' }));
  g.push(row({ 1: '하이마트', 2: '미니건조기', 3: 'MNMD-120G', 4: 379000, 5: 265300, 6: 0.3 }));
  g.push(row({ 2: '식기세척기', 3: 'MNDW-110G', 4: 399000, 5: 271320 }));
  g.push(row({ 2: '더플렌더 MAX', 3: 'MNFD-200G', 4: 499000, 5: 374220 }));
  g.push(row({ 1: '이마트', 2: '더플렌더 BASIC', 3: 'MNFD-100G', 4: 468000, 5: 327591, 9: '전시단가', 10: 299519 }));
  g.push(row({ 2: '더플렌더 PLUS', 3: 'MNFD-110CV', 4: 328000, 5: 245960 }));
  g.push(row({}));
  g.push(row({ 5: 329000, 6: 246750 }));
  return { grid: g, merges: [[3, 2, 3, 1], [6, 2, 2, 1]] };
}
const LEGACY = () => ({ '26년 진행현황': progressGrid(), '납품가 수수료': priceGrid() });

function env() {
  const g = loadOfflineGas({ setup: true, today: TODAY, legacy: LEGACY() });
  // 2-A 시점의 채널마스터 — 트레이더스는 업로드 없는 채널이었다(이 테스트가 "업로드 없는 채널" 예시로 쓴다).
  // 트레이더스 분리(2026-09-28) 이후 초기값은 활성·업로드시작월 2026-09라 여기서 되돌린다.
  const tr = g.tab('채널마스터')._grid.find(r => r[0] === 'traders'); tr[3] = 'N'; tr[5] = '';
  const w = (tab, key, rows) => g.ctx._offWriteBlock(g.tab(tab), g.ctx.OFF_TABS[key], g.tab(tab).getLastRow() + 1, rows);
  w('제품마스터', 'sku', [['SKU-0001', '더 플렌더 MAX', '더플렌더', '더 플렌더 MAX', '', 'Y', '', ''], ['SKU-0002', '더 플렌더 mini', '더플렌더', '더 플렌더 mini', '', 'Y', '', ''],
    ['SKU-0003', '미니 건조기 PRO+', '미니건조기', '미니 건조기 PRO+', '', 'Y', '', '']]);
  w('코드매핑', 'mapping', [['himart', 'MNFD-200G', 'SKU-0001', '정상', '', '', '', ''], ['himart', 'MNFD-300G', 'SKU-0002', '정상', '', '', '', ''],
    ['himart', 'MNMD-120G', 'SKU-0003', '정상', '', '', '', '']]);
  const S = (d, code, q) => [d, d, 'day', 'himart', 'S1', code, q, q, 'upload', 'U1'];
  w('판매원장', 'sales', [S('2026-09-03', 'MNFD-200G', 90), S('2026-09-10', 'MNFD-200G', 7), S('2026-09-11', 'MNFD-300G', 4), S('2026-09-12', 'MNFD-RF5', 2)]);
  g.targets = () => dataRows(g.tab('목표실적_월'));
  return g;
}
const MAPPING = {
  channels: { '하이마트': 'himart', '트레이더스': 'traders', '이마트할인점': 'emart', '특판': 'special' },
  products: {
    '더플렌더 MAX': { line: '더플렌더', model: '더 플렌더 MAX' }, '더플렌더 mini': { line: '더플렌더', model: '더 플렌더 mini' },
    '더플렌더 Mini': { line: '더플렌더', model: '더 플렌더 mini' }, '건조기': { line: '미니건조기', model: '미니 건조기 PRO' },
    '에어드라이': { line: '더에어드라이', model: '더 에어드라이' }, '더플렌더 MINI': { line: '더플렌더', model: 'mini' },
    '더플렌더 PLUS': { line: '더플렌더', model: '더 플렌더 PLUS' }, '식세기': { line: '미니식기세척기', model: '미니 식기세척기' }
  }
};
// 목표실적_월 행 → 'ym ch model type target/actual source' 문자열(비교용)
const fmt = r => [r[0], r[1], r[3], r[4], r[5] + '/' + r[6], r[7]].join(' ');

(function main() {
  console.log('\n[1] 진행현황 파싱 — 월 블록 동적 탐색, 병합 셀, 소계·TIP 제외');
  {
    const g = env();
    const p = g.ctx._offParseLegacyProgress(g.ctx._offLegacyGrid(g.legacy, '26년 진행현황'));
    check('연도 = 탭 이름(26년) → 2026', p.year === 2026);
    check('월 3개(1·2·9월)', J(p.months.map(m => m.ym)) === J(['2026-01', '2026-02', '2026-09']), p.months);
    check('1월은 IN 목표·실적만', J(p.months[0].cols) === J({ inT: 5, inA: 6 }), p.months[0].cols);
    check('9월은 IN·OUT, 헤더 없는 전월 참조 열(X) 무시', J(p.months[2].cols) === J({ inT: 17, inA: 18, outT: 21, outA: 22 }), p.months[2].cols);
    check('품목 행 9개(소계·TIP·아래 잡표 제외)', p.rows.length === 9, p.rows.map(r => r.product));
    check('병합 셀 채널을 채워 읽음(3번째 하이마트 행, 트레이더스 2번째 행)', p.rows[2].channel === '하이마트' && p.rows[5].channel === '트레이더스' && p.rows[1].group === '오프라인', p.rows.map(r => r.channel));
    check('값: 하이마트 MAX 2월 OUT 500/399, 9월 OUT 실적 99', J(p.rows[0].values['2026-02']) === J({ inT: 300, inA: 524, outT: 500, outA: 399 }) && p.rows[0].values['2026-09'].outA === 99);
    check("'#REF!' 같은 오류 값은 빈칸 처리 + 개수", p.badCells === 1 && p.rows[1].values['2026-09'].outA === null, p.badCells);
  }

  console.log('\n[2] 제안 — 채널명·품목명(대소문자·띄어쓰기 무시, 모호하면 모델 빈칸)');
  {
    const g = env();
    const chRows = g.ctx._offChannelRows(g.ctx._offSS());
    [['하이마트', 'himart'], ['트레이더스', 'traders'], ['이마트할인점', 'emart'], ['특판', 'special'], ['디에이블앤', 'theablen'], ['신세계', 'shinsegae'], ['쿠팡', '']]
      .forEach(([n, want]) => check(`채널 "${n}" → "${want}"`, g.ctx._offSuggestChannel(n, chRows) === want, g.ctx._offSuggestChannel(n, chRows)));
    [['더플렌더 MAX', '더플렌더', '더 플렌더 MAX', false], ['더플렌더 MINI', '더플렌더', '더 플렌더 mini', false], ['더플렌더 BASIC', '더플렌더', '더 플렌더 Basic', false],
      ['더시프트', '더시프트', '더 시프트', false], ['더슬림', '더슬림', '더 슬림', false], ['에어드라이', '더에어드라이', '더 에어드라이', false], ['더에어드라이', '더에어드라이', '더 에어드라이', false],
      ['PRO', '', '', true], ['모르는품목', '', '', true]]
      .forEach(([n, line, model, amb]) => {
        const s = g.ctx._offSuggestProduct(n);
        check(`품목 "${n}" → ${line || '(없음)'} / ${model || '(빈칸)'}${amb ? ' · 모호' : ''}`, s.line === line && s.model === model && s.ambiguous === amb && (amb || s.level === 'model'), s);
      });
    // 여러 모델을 합친 품목명 → 대분류 단위(모델 구분 없음)
    [['건조기', '건조기'], ['식세기', '식세기'], ['식기세척기', '식세기']].forEach(([n, cat]) => {
      const s = g.ctx._offSuggestProduct(n);
      check(`품목 "${n}" → 대분류 ${cat} 합계(모델 구분 없음)`, s.level === 'category' && s.category === cat && !s.line && !s.model && !s.ambiguous, s);
    });
    check('에어드라이는 대분류가 아니라 모델(더 에어드라이, 대분류 건조기)', (s => s.level === 'model' && s.model === '더 에어드라이' && s.category === '건조기')(g.ctx._offSuggestProduct('에어드라이')));
    check('단가용(모델 단위만): 식기세척기 → 미니식기세척기 품목군만·모호, 건조기 → 모호', (a => a.line === '미니식기세척기' && a.model === '' && a.ambiguous)(g.ctx._offSuggestProduct('식기세척기', true)) &&
      (b => b.ambiguous && !b.level)(g.ctx._offSuggestProduct('건조기', true)));
  }

  console.log('\n[3] 미리보기 — 아무것도 쓰지 않고 계획·미매핑·대조만');
  {
    const g = env();
    const pv = g.ctx._offMigrateProgress({ mode: 'preview' }, AUTH);
    check('미리보기: 목표실적_월·이관로그에 쓰지 않음', g.targets().length === 0 && dataRows(g.tab('이관로그')).length === 0);
    check('월·채널·품목 목록', J(pv.months) === J(['2026-01', '2026-02', '2026-09']) && J(pv.channels.map(c => c.legacy + '=' + c.channelId)) === J(['하이마트=himart', '트레이더스=traders', '이마트할인점=emart', '특판=special']), pv.channels);
    check('품목 원문 목록(원문 그대로, 등장 순)', J(pv.products.map(p => p.legacy)) === J(['더플렌더 MAX', '더플렌더 mini', '더플렌더 Mini', '건조기', '에어드라이', '더플렌더 MINI', '더플렌더 PLUS', '식세기']), pv.products.map(p => p.legacy));
    check('건조기·식세기는 대분류로 연결 → 미매핑 0건', J(pv.products.filter(p => p.level === 'category').map(p => p.legacy + '=' + p.category)) === J(['건조기=건조기', '식세기=식세기']) &&
      pv.unmapped.length === 0, { unmapped: pv.unmapped, products: pv.products.map(p => [p.legacy, p.level, p.category]) });
    check('원본 행 수·오류 칸 수', pv.legacyRows === 9 && pv.badCells === 1);
  }

  console.log('\n[4] 반영 — IN 전부·OUT 목표 전부, OUT 실적은 업로드시작월 이전 달만');
  {
    const g = env();
    const r = g.ctx._offMigrateProgress({ mode: 'apply', mapping: MAPPING }, AUTH);
    const t = g.targets(), by = {};
    t.forEach(x => { by[[x[0], x[1], x[3], x[4]].join('|')] = x; });
    const v = (ym, ch, model, type) => { const x = by[[ym, ch, model, type].join('|')]; return x ? x[5] + '/' + x[6] : null; };
    check('21행 반영, 출처 migration·비고 진행현황 이관', r.written === 21 && t.length === 21 && t.every(x => x[7] === 'migration' && x[10] === '진행현황 이관'), t.map(fmt));
    check('하이마트 MAX: 1월 IN 300/544, 2월 IN 300/524, 2월 OUT 500/399', v('2026-01', 'himart', '더 플렌더 MAX', 'IN') === '300/544' && v('2026-02', 'himart', '더 플렌더 MAX', 'IN') === '300/524' && v('2026-02', 'himart', '더 플렌더 MAX', 'OUT') === '500/399');
    check('  ↳ 9월(업로드시작월) OUT은 목표만(실적 99는 이관 안 함)', v('2026-09', 'himart', '더 플렌더 MAX', 'OUT') === '300/', v('2026-09', 'himart', '더 플렌더 MAX', 'OUT'));
    check('  ↳ 1월엔 OUT 블록이 없어 OUT 행 없음', v('2026-01', 'himart', '더 플렌더 MAX', 'OUT') === null);
    check("같은 모델로 모이는 원문 행 합산('더플렌더 mini'+'더플렌더 Mini'): 1월 IN 5/11, 9월 IN 41/43·OUT 목표 52", v('2026-01', 'himart', '더 플렌더 mini', 'IN') === '5/11' &&
      v('2026-09', 'himart', '더 플렌더 mini', 'IN') === '41/43' && v('2026-09', 'himart', '더 플렌더 mini', 'OUT') === '52/', [v('2026-01', 'himart', '더 플렌더 mini', 'IN'), v('2026-09', 'himart', '더 플렌더 mini', 'IN')]);
    check('  ↳ 한쪽만 빈칸이면 빈칸은 더하지 않음(2월 IN 목표 20, 실적 빈칸)', v('2026-02', 'himart', '더 플렌더 mini', 'IN') === '20/');
    check('사용자가 고른 모델로 반영(건조기 → 미니 건조기 PRO)', v('2026-02', 'himart', '미니 건조기 PRO', 'OUT') === '8/9' && v('2026-09', 'himart', '미니 건조기 PRO', 'OUT') === '7/');
    check('업로드 없는 채널(트레이더스)은 9월 OUT 실적도 이관 35', v('2026-09', 'traders', '더 플렌더 MAX', 'OUT') === '40/35');
    check("모델 표기 'mini'도 카탈로그 label로 저장(이마트 mini)", v('2026-09', 'emart', '더 플렌더 mini', 'IN') === '30/31');
    check('업로드 달이라 빠진 OUT 실적 칸 수 = 5', r.outSkippedUploadMonths === 5, r.outSkippedUploadMonths);
    check('이관로그 1행(진행현황, 2026-01~2026-09, 21행)', J(dataRows(g.tab('이관로그')).map(x => [x[1], x[2], x[3], x[4], x[6]])) === J([[AUTH.email, '진행현황', '2026-01~2026-09', 21, '성공']]), dataRows(g.tab('이관로그')));
    check('원본에는 읽기 호출만', g.legacy._calls.every(c => ['getSheetByName', 'getLastRow', 'getLastColumn', 'getValues', 'getMergedRanges'].indexOf(c) >= 0), [...new Set(g.legacy._calls)]);

    console.log('\n[5] 표본 대조 — 이관 후 채널×월 합계 = 원본 칸 합');
    const sum = (ym, ch, type, i) => t.filter(x => x[0] === ym && x[1] === ch && x[4] === type).reduce((a, x) => a + (Number(x[i]) || 0), 0);
    [['2026-01', 'himart', 'IN', 5, 305], ['2026-01', 'himart', 'IN', 6, 555], ['2026-02', 'himart', 'IN', 6, 536], ['2026-02', 'himart', 'OUT', 5, 538],
      ['2026-09', 'traders', 'IN', 6, 60], ['2026-09', 'emart', 'OUT', 5, 90]].forEach(([ym, ch, type, i, want]) =>
      check(`${ym} ${ch} ${type} ${i === 5 ? '목표' : '실적'} 합 = ${want}`, sum(ym, ch, type, i) === want, sum(ym, ch, type, i)));

    console.log('\n[6] 두 번 반영해도 같음 · input 행은 보존');
    const once = J(g.targets());
    const r2 = g.ctx._offMigrateProgress({ mode: 'apply', mapping: MAPPING }, AUTH);
    check('두 번째 반영 후 행·값 동일(행 21)', J(g.targets()) === once && r2.removed === 21, r2.removed);
    g.ctx._offSaveTargets({ items: [{ ym: '2026-02', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 999, actual: 888 }] }, AUTH);
    const r3 = g.ctx._offMigrateProgress({ mode: 'apply', mapping: MAPPING }, AUTH);
    const kept = g.targets().find(x => x[0] === '2026-02' && x[1] === 'himart' && x[3] === '더 플렌더 MAX' && x[4] === 'IN');
    check('사용자가 입력한 값(999/888, input)은 이관이 덮어쓰지 않음', kept && kept[5] === 999 && kept[6] === 888 && kept[7] === 'input', kept);
    check('  ↳ 건너뛴 키 1개 보고, 행 수 그대로', r3.skippedInput === 1 && g.targets().length === 21, [r3.skippedInput, g.targets().length]);
    check('  ↳ 이관로그 상태에 입력값 보존 표기', /입력값 보존 1건/.test(dataRows(g.tab('이관로그')).pop()[6]));
  }

  console.log('\n[7] 업로드시작월 대조 리포트(9월, 이관 안 함)');
  {
    const g = env();
    const pv = g.ctx._offMigrateProgress({ mode: 'preview', mapping: MAPPING }, AUTH);
    const c = pv.compare.map(x => [x.channelId, x.model, x.legacy, x.ledger, x.diff].join(' '));
    check('하이마트: MAX 99 vs 97(−2), mini 3 vs 4(+1), PRO 6 vs 0(−6), 합계 108 vs 101(−7)', J(c.filter(x => x.indexOf('himart') === 0)) === J([
      'himart 더 플렌더 MAX 99 97 -2', 'himart 더 플렌더 mini 3 4 1', 'himart 미니 건조기 PRO 6 0 -6', 'himart (채널 합계) 108 101 -7']), c);
    check('원본·원장 모두 없는 업로드 채널(전자랜드)은 대조표에 없음', !pv.compare.some(x => x.channelId === 'etland'));
    check('  ↳ 채널 합계 행에 미매칭 수량(2)', pv.compare.find(x => x.channelId === 'himart' && x.total).unmatchedQty === 2);
    check('이마트(원장 비어 있음): mini 18 vs 0, PLUS 65 vs 0', c.indexOf('emart 더 플렌더 mini 18 0 -18') >= 0 && c.indexOf('emart 더 플렌더 PLUS 65 0 -65') >= 0, c);
    check('업로드 없는 채널은 대조하지 않음', !pv.compare.some(x => x.channelId === 'traders' || x.channelId === 'special'));
    check('미리보기라 목표실적_월은 비어 있음', g.targets().length === 0);
  }

  console.log('\n[8] 납품가 수수료 이관 — 기준일, MN 코드 제안, upsert');
  {
    const g = env();
    const pv = g.ctx._offMigratePrices({ mode: 'preview' }, AUTH);
    check('기준일 = 제목의 2026. 4. 9 → 2026-04-09', pv.baseDate === '2026-04-09');
    check('5행(떠 있는 값 행 제외), 병합 채널 채움', pv.rows.length === 5 && J(pv.rows.map(r => r.legacyChannel)) === J(['하이마트', '하이마트', '하이마트', '이마트', '이마트']), pv.rows.map(r => r.legacyChannel));
    const s = pv.rows.map(r => r.suggest);
    check('MN 코드로 제안: MNMD-120G → 미니 건조기 PRO+ (이미 매핑된 SKU)', s[0].line === '미니건조기' && s[0].model === '미니 건조기 PRO+' && s[0].from === 'model-code', s[0]);
    check('매핑 없는 식기세척기(MNDW-110G) → 품목군만, 모호', s[1].line === '미니식기세척기' && s[1].model === '' && s[1].ambiguous, s[1]);
    check('이름 제안: BASIC → 더 플렌더 Basic, PLUS', s[3].model === '더 플렌더 Basic' && s[4].model === '더 플렌더 PLUS');
    check('채널 제안: 하이마트 → himart, 이마트 → emart', s[0].channelId === 'himart' && s[3].channelId === 'emart');
    check('미리보기는 단가마스터에 쓰지 않음', dataRows(g.tab('단가마스터')).length === 0);
    const rows = pv.rows.map(r => ({ rowNo: r.rowNo, channelId: r.suggest.channelId, line: r.suggest.line, model: r.suggest.model || (r.product === '식기세척기' ? '미니 식기세척기 PRO' : '') }));
    const a = g.ctx._offMigratePrices({ mode: 'apply', startDate: '2026-01-01', rows }, AUTH);
    const pr = dataRows(g.tab('단가마스터'));
    check('5행 반영, 적용시작일 2026-01-01, 공급가', a.written === 5 && pr.length === 5 && pr.every(x => x[4] === '2026-01-01') && pr.find(x => x[2] === '미니 건조기 PRO+')[3] === 265300, pr);
    check('비고에 원본 모델명·판매가·부가세포함', /모델명 MNMD-120G · 판매가 379000 · 부가세포함/.test(pr[0][5]), pr[0][5]);
    g.ctx._offMigratePrices({ mode: 'apply', startDate: '2026-01-01', rows }, AUTH);
    check('다시 반영해도 5행(upsert)', dataRows(g.tab('단가마스터')).length === 5);
    const a3 = g.ctx._offMigratePrices({ mode: 'apply', startDate: '2026-01-01', rows: rows.slice(1) }, AUTH);
    check('고르지 않은 행은 미매핑으로 기록', a3.unmapped.length === 1 && /미니건조기\(MNMD-120G\)/.test(a3.unmapped[0]) && /미니건조기/.test(dataRows(g.tab('이관로그')).pop()[5]), a3.unmapped);
    const mon = g.ctx._offGetMonthly({ from: '2026-09', to: '2026-09', channelId: 'himart' });
    const max = mon.rows.find(x => x.model === '더 플렌더 MAX');
    check('이관한 단가가 월별 금액에 반영(하이마트 MAX 9월 OUT 97 × 374,220)', max && max.price === 374220 && max.out.actualAmount === 97 * 374220, max && max.price);
    check('원본에는 읽기 호출만', g.legacy._calls.every(c => ['getSheetByName', 'getLastRow', 'getLastColumn', 'getValues', 'getMergedRanges'].indexOf(c) >= 0));
  }

  console.log('\n[9] offline_saveTargets');
  {
    const g = env();
    const save = items => { try { return g.ctx._offSaveTargets({ items }, AUTH); } catch (e) { return { error: e.message }; } };
    const ok = save([{ ym: '2026-10', channelId: 'himart', line: '더플렌더', model: 'MAX', type: 'IN', target: 120, actual: '' },
      { ym: '2026-08', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'OUT', target: 80, actual: 75 },
      { ym: '2026-10', channelId: 'traders', line: '더시프트', model: '더 시프트', type: 'OUT', target: 5, actual: 4, note: '수기' }]);
    const t = g.targets();
    check('3건 저장, 출처 input·수정일·수정자(세션)', ok.saved === 3 && t.length === 3 && t.every(x => x[7] === 'input' && x[8] === TODAY && x[9] === AUTH.email), t);
    check("모델 표기는 카탈로그 label로('MAX' → '더 플렌더 MAX'), 빈 실적은 빈칸", t[0][3] === '더 플렌더 MAX' && t[0][6] === '', t[0]);
    check('업로드시작월 이전(8월) OUT 실적은 입력 가능', t[1][6] === 75);
    check('업로드 없는 채널 OUT 실적 입력 + 비고', t[2][6] === 4 && t[2][10] === '수기');
    save([{ ym: '2026-10', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 130, actual: 10 }]);
    check('같은 키는 수정(행 수 그대로)', g.targets().length === 3 && g.targets()[0][5] === 130 && g.targets()[0][6] === 10);
    const bad = [
      [{ ym: '2026-09', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'OUT', target: 1, actual: 5 }, /판매원장에서 집계/],
      [{ ym: '2026-9', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 1 }, /연월/],
      [{ ym: '2026-09', channelId: 'coupang', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 1 }, /채널마스터/],
      [{ ym: '2026-09', channelId: 'himart', line: '더플렌더', model: '더 플렌더 ULTRA', type: 'IN', target: 1 }, /품목 상수에 없습니다/],
      [{ ym: '2026-09', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'SELL', target: 1 }, /IN 또는 OUT/],
      [{ ym: '2026-09', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 'abc' }, /숫자/]
    ];
    bad.forEach(([it, re]) => { const r = save([it]); check('거절: ' + re, r.error && re.test(r.error), r); });
    check('거절된 요청은 아무것도 쓰지 않음', g.targets().length === 3);
    g.ctx._offGetMonthly({ from: '2026-10', to: '2026-10' });
    save([{ ym: '2026-10', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 140, actual: 10 }]);
    const m = g.ctx._offGetMonthly({ from: '2026-10', to: '2026-10' });
    check('저장 후 월별 조회는 캐시가 아니라 새 값', !m.cached && m.rows.find(x => x.channelId === 'himart').in.target === 140);
  }

  console.log('\n[10] offline_getPrices / offline_savePrices');
  {
    const g = env();
    const sp = items => { try { return g.ctx._offSavePrices({ items }, AUTH); } catch (e) { return { error: e.message }; } };
    sp([{ channelId: 'himart', line: '더플렌더', model: 'MAX', price: 370000, startDate: '2026-01-01', note: '연초' },
      { channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', price: 380000, startDate: '2026-10-01' }]);
    let items = g.ctx._offGetPrices().items;
    check('2건, 모델 표기 정규화, 적용시작일 순', items.length === 2 && items.every(x => x.model === '더 플렌더 MAX') && items[0].startDate === '2026-01-01' && items[0].note === '연초' && items[0].updatedBy === AUTH.email, items);
    sp([{ channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', price: 375000, startDate: '2026-01-01' }]);
    check('같은 키는 공급가 수정(행 수 그대로)', g.ctx._offGetPrices().items.length === 2 && g.ctx._offGetPrices().items[0].price === 375000);
    sp([{ channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', price: 375000, startDate: '2026-02-01', origStartDate: '2026-01-01' }]);
    items = g.ctx._offGetPrices().items;
    check('적용시작일 옮기기(1/1 → 2/1)', items.length === 2 && items[0].startDate === '2026-02-01', items.map(x => x.startDate));
    g.ctx._offSaveTargets({ items: ['2026-01', '2026-02'].map(ym => ({ ym, channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 10, actual: 2 })) }, AUTH);
    const m1 = g.ctx._offGetMonthly({ from: '2026-01', to: '2026-02', channelId: 'himart' });
    const p1 = m1.rows.find(x => x.ym === '2026-01'), p2 = m1.rows.find(x => x.ym === '2026-02');
    check('옮긴 뒤 1월은 단가 없음(금액 null), 2월부터 375,000', p1.price === null && p1['in'].actualAmount === null && p2.price === 375000 && p2['in'].actualAmount === 2 * 375000, [p1.price, p2.price]);
    [[{ channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', price: -1, startDate: '2026-01-01' }, /0 이상/],
      [{ channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', price: 1, startDate: '2026-1-1' }, /적용시작일/],
      [{ channelId: 'nope', line: '더플렌더', model: '더 플렌더 MAX', price: 1, startDate: '2026-01-01' }, /채널마스터/],
      [{ channelId: 'himart', line: '더플렌더', model: '없는모델', price: 1, startDate: '2026-01-01' }, /품목 상수/]]
      .forEach(([it, re]) => { const r = sp([it]); check('거절: ' + re, r.error && re.test(r.error), r); });
    const partial = sp([{ channelId: 'himart', line: '더시프트', model: '더 시프트', price: 1, startDate: '2026-01-01' }, { channelId: 'nope', line: '더시프트', model: '더 시프트', price: 1, startDate: '2026-01-01' }]);
    check('한 건이라도 틀리면 아무것도 쓰지 않음', partial.error && g.ctx._offGetPrices().items.length === 2);
  }

  console.log('\n[12] 대분류 단위 이관 — "건조기"·"식세기"는 모델 구분 없는 대분류 행, 에어드라이는 모델 행');
  {
    const g = env();
    const r = g.ctx._offMigrateProgress({ mode: 'apply' }, AUTH); // 제안 그대로(건조기·식세기 → 대분류)
    const t = g.targets();
    const cat = t.filter(x => x[11] && !x[2]);
    check('미매핑 0건', r.unmapped.length === 0, r.unmapped);
    check('대분류 행: 품목군·모델 빈칸, 대분류만, 비고 "모델 구분 없음"', cat.length > 0 && cat.every(x => x[2] === '' && x[3] === '' && ['건조기', '식세기'].indexOf(x[11]) >= 0 && /모델 구분 없음/.test(x[10])), cat.map(fmt));
    const cv = (ym, ch, c, type) => { const x = t.find(y => y[0] === ym && y[1] === ch && !y[2] && y[11] === c && y[4] === type); return x ? x[5] + '/' + x[6] : null; };
    check('하이마트 건조기(대분류): 2월 IN 10/12 · OUT 8/9, 9월 OUT 목표 7(실적은 업로드 달이라 제외)', cv('2026-02', 'himart', '건조기', 'IN') === '10/12' && cv('2026-02', 'himart', '건조기', 'OUT') === '8/9' && cv('2026-09', 'himart', '건조기', 'OUT') === '7/');
    check('특판 식세기(대분류): 2월 IN 3/2', cv('2026-02', 'special', '식세기', 'IN') === '3/2');
    const air = t.find(x => x[1] === 'traders' && x[3] === '더 에어드라이' && x[0] === '2026-02' && x[4] === 'IN');
    check('에어드라이는 모델 행(품목군 더에어드라이, 대분류 건조기)', air && air[2] === '더에어드라이' && air[11] === '건조기' && air[5] === 5);
    check('모델 행에도 대분류가 채워짐', t.filter(x => x[2]).every(x => x[11] === { '더플렌더': '음식물처리기', '더에어드라이': '건조기', '미니건조기': '건조기' }[x[2]]));
    const n = t.length, once = J(t);
    g.ctx._offMigrateProgress({ mode: 'apply' }, AUTH);
    check('두 번 반영해도 행·값 동일(대분류 행 포함)', g.targets().length === n && J(g.targets()) === once);

    // 월별 해석 — 대분류 합계 = 대분류 행 + 그 대분류 모델 행(+ 원장), 모델 행 목록에는 대분류 행이 없음
    const m2 = g.ctx._offGetMonthly({ from: '2026-02', to: '2026-02' });
    check('모델 행 목록에 대분류 행 없음(모두 품목군·모델 있음)', m2.rows.every(x => x.line && x.model));
    check('대분류 행은 categoryRows로 따로', J(m2.categoryRows.map(x => x.channelId + ':' + x.category)) === J(['himart:건조기', 'special:식세기']), m2.categoryRows.map(x => [x.channelId, x.category]));
    const ct = (ch, c) => m2.totals.byCategory.find(x => x.channelId === ch && x.category === c);
    check('하이마트 2월 건조기 합계 = 대분류 행(IN 10/12)', ct('himart', '건조기').in.target === 10 && ct('himart', '건조기').in.actual === 12 && ct('himart', '건조기').hasCategoryRow);
    check('트레이더스 2월 건조기 합계 = 에어드라이 모델 행(IN 5/5)', ct('traders', '건조기').in.target === 5 && !ct('traders', '건조기').hasCategoryRow);
    const chT = m2.totals.byChannelMonth.find(x => x.channelId === 'himart');
    check('채널 합계에는 대분류 행도 포함 + "대분류 합계로만 있는 수치" 표시', chT.categoryOnly.join() === '건조기' && chT.in.actual === 524 + 0 + 12, chT);
    check('대분류 행은 금액 미계산 경고', m2.warnings.some(w => /대분류 단위 행.*금액이 계산되지 않습니다/.test(w)));

    const mixed = g.ctx._offMonthlyCompute({ from: '2026-02', to: '2026-02', channels: g.ctx._offChannelRows(g.ctx._offSS()), prices: [], sales: [], mappings: [], skus: [],
      targets: [['2026-02', 'theablen', '', '', 'IN', 7, 6, 'migration', '', '', '', '건조기'], ['2026-02', 'theablen', '더에어드라이', '더 에어드라이', 'IN', 2, 1, 'migration', '', '', '', '건조기']] });
    check('대분류 행 + 이관된 다른 모델 행(원본의 건조기 행 + 더에어드라이 행)은 중복 경고 없음, 합계는 더함(9/7)', !mixed.warnings.some(w => /중복 가능/.test(w)) &&
      (x => x.in.target === 9 && x.in.actual === 7)(mixed.totals.byCategory.find(x => x.category === '건조기')), mixed.warnings);

    console.log('\n[13] 같은 달·채널·대분류에 대분류 행(이관)과 모델 행(입력)이 함께 있으면 경고');
    g.ctx._offSaveTargets({ items: [{ ym: '2026-02', channelId: 'himart', line: '미니건조기', model: '미니 건조기 PRO', type: 'IN', target: 4, actual: 3 }] }, AUTH);
    const m3 = g.ctx._offGetMonthly({ from: '2026-02', to: '2026-02' });
    check('중복 경고(IN 목표·IN 실적)', m3.warnings.some(w => /중복 가능: himart 2026-02 건조기.*IN 목표·IN 실적/.test(w)), m3.warnings);
    check('  ↳ 대분류 합계에는 둘 다 더해짐(10+4 / 12+3)', (x => x.in.target === 14 && x.in.actual === 15)(m3.totals.byCategory.find(x => x.channelId === 'himart' && x.category === '건조기')));
    check('  ↳ 대분류 행에 중복 항목 표시', J(m3.categoryRows.find(x => x.channelId === 'himart').duplicateFields) === J(['IN 목표', 'IN 실적']));
    const saved = g.targets().find(x => x[3] === '미니 건조기 PRO' && x[7] === 'input');
    check('입력(input) 행에도 대분류 채움', saved && saved[11] === '건조기');
    g.ctx._offMigrateProgress({ mode: 'apply' }, AUTH);
    check('다시 이관해도 input 행 보존(키가 달라 건너뛸 것 없음)', g.targets().some(x => x[3] === '미니 건조기 PRO' && x[7] === 'input' && x[5] === 4));

    console.log('\n[14] 9월 대조 — 대분류로 이관한 품목은 대분류 합계 한 줄로 비교');
    const pv = g.ctx._offMigrateProgress({ mode: 'preview' }, AUTH);
    const row = pv.compare.find(x => x.channelId === 'himart' && x.level === 'category' && x.category === '건조기');
    check('하이마트 "(대분류) 건조기 합계": 진행현황 6 vs 원장 0', row && row.model === '(대분류) 건조기 합계' && row.legacy === 6 && row.ledger === 0 && row.diff === -6, row);
    check('  ↳ 같은 대분류의 모델 줄은 따로 나오지 않음', !pv.compare.some(x => x.channelId === 'himart' && x.category === '건조기' && x.level === 'model'));
    check('  ↳ 채널 합계는 그대로(108 vs 101)', (x => x.legacy === 108 && x.ledger === 101)(pv.compare.find(x => x.channelId === 'himart' && x.total)));
  }

  console.log('\n[11] doPost 라우팅 — 새 액션도 세션 필수');
  {
    const g = env();
    const sheet = g.ctx._sessionSheet(g.ctx.SpreadsheetApp.getActiveSpreadsheet());
    const now = Date.now();
    sheet.appendRow(['sid-t', AUTH.email, 'p', now, now + 36e5, now]);
    const token = g.ctx._signSessionToken({ sid: 'sid-t', email: AUTH.email, name: 'p', exp: now + 36e5, iat: now, kv: 1 });
    const post = body => JSON.parse(g.ctx.doPost({ postData: { contents: JSON.stringify(body) }, parameter: {} }));
    ['offline_getMonthly', 'offline_saveTargets', 'offline_getPrices', 'offline_savePrices', 'offline_migrateProgress', 'offline_migratePrices'].forEach(a =>
      check(a + ' 세션 없으면 AUTH_REQUIRED', post({ action: a }).error === 'AUTH_REQUIRED'));
    const m = post({ action: 'offline_getMonthly', session: token, data: { from: '2026-09', to: '2026-09' } });
    check('세션 있으면 offline_getMonthly 응답', m.success && Array.isArray(m.rows) && m.version === g.ctx.SCRIPT_VERSION, m.error);
    const pv = post({ action: 'offline_migrateProgress', session: token, data: { mode: 'preview' } });
    check('offline_migrateProgress 미리보기 응답', pv.success && pv.months.length === 3, pv.error);
    const s = post({ action: 'offline_saveTargets', session: token, data: { items: [{ ym: '2026-10', channelId: 'himart', line: '더슬림', model: '', type: 'IN', target: 3, actual: '' }] } });
    check('saveTargets 수정자 = 세션 이메일, 빈 모델 → 기본 모델', s.success && g.targets()[0][9] === AUTH.email && g.targets()[0][3] === '더 슬림', g.targets()[0]);
    const noLegacy = loadOfflineGas({ setup: true, today: TODAY });
    let e = null; try { noLegacy.ctx._offMigrateProgress({ mode: 'preview' }, AUTH); } catch (x) { e = x; }
    check('LEGACY_PROGRESS_SHEET_ID 없으면 무엇을 넣을지 알려줌', e && /LEGACY_PROGRESS_SHEET_ID/.test(e.message), e && e.message);
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})();
