/* 목표 관리 화면(#admin/targets) — index.html이 싣는 실코드 그대로, 서버 호출(_offlineCall)만 가짜로.

   지키려는 성질:
     · 들어오면 마스터·월별·단가를 받아 채널 × 품목군 × 모델(품목 상수) 표를 그린다 — 활성 채널 + 데이터 있는 채널
     · 업로드 채널의 업로드시작월 이후 OUT 실적은 원장 값 읽기 전용(upload), 그 외는 입력
     · 칸을 고치면 표를 다시 그리지 않고 그 줄 달성률·금액과 합계만 갱신(키보드 연속 입력), 고친 칸 강조
     · 저장은 고친 줄만, 전월 목표 복사는 빈 목표만, 엑셀 범위(탭 구분) 붙여넣기
     · 미매칭 수량 경고 + 코드 매핑 링크 / 저장 안 한 변경이 있으면 월 이동 전에 확인
     · 단가: 현재 적용 표시, 추가·수정(적용시작일 옮기기) / 이관: 미리보기 → 매핑 확인·수정 → 두 번 눌러 반영

   실행: node tests/offline-targets-ui.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadFrontend } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
const PROJ = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const J = JSON.stringify;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };
const SHIM = 'get TG(){return _TG;}, get PAGE_MOUNTS(){return PAGE_MOUNTS;}';

const MASTERS = { success: true, skus: [], mappings: [], stores: [], channels: [
  { channelId: 'himart', name: '하이마트', active: 'Y', order: 1, uploadStartMonth: '2026-09' },
  { channelId: 'traders', name: '트레이더스', active: 'N', order: 4, uploadStartMonth: '' },
  { channelId: 'shinsegae', name: '신세계', active: 'N', order: 5, uploadStartMonth: '' }] };
const R = (ch, line, model, inT, inA, outT, outA, src, byType) => ({ ym: '2026-09', channelId: ch, line, model,
  in: { target: inT, actual: inA }, out: { target: outT, actual: outA, source: src, byType: byType || null } });
const MONTHLY = { success: true, months: ['2026-09'], rows: [
  R('himart', '더플렌더', '더 플렌더 MAX', 100, 110, 90, 97, 'upload', { '정상': 90, '전시': 7, '리퍼': 0 }),
  R('traders', '더시프트', '더 시프트', 10, 5, 8, 6, 'migration')],
  unmatched: [{ ym: '2026-09', channelId: 'himart', code: 'MNFD-RF5', qty: 45 }], warnings: ['단가 없음(금액 미계산): traders / 더 시프트 (2026-09~)'] };
const PREV = { success: true, rows: [R('himart', '더플렌더', '더 플렌더 MAX', 80, 70, 60, 50, 'migration'), R('himart', '더플렌더', '더 플렌더 mini', 5, 4, 3, 2, 'migration')] };
const PRICES = { success: true, items: [
  { channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', price: 300000, startDate: '2026-01-01', note: '', updatedAt: '2026-09-27', updatedBy: 'a' },
  { channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', price: 374220, startDate: '2026-04-09', note: '이관', updatedAt: '2026-09-27', updatedBy: 'a' }] };

function setup() {
  const { ctx, X } = loadFrontend(PROJ, SHIM);
  const box = {};
  const el = id => (box[id] = box[id] || { id, innerHTML: '', value: '', textContent: '', dataset: {}, style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } } });
  ctx.document.getElementById = el;
  // 붙여넣기가 "화면에 보이는 모델 줄" 순서를 DOM에서 읽는다 — 그린 HTML에서 같은 순서를 뽑아 준다
  ctx.document.querySelectorAll = sel => {
    if (sel !== '.tg-tbl tr.tg-row') return { length: 0, forEach() {}, map: () => [] };
    const html = el('page-admin-targets').innerHTML, out = [];
    html.split('<tr class="tg-row">').slice(1).forEach(chunk => { const m = /data-r="(\d+)"/.exec(chunk.split('</tr>')[0]); out.push({ querySelector: () => m ? { dataset: { r: m[1] } } : null }); });
    return out;
  };
  const calls = [];
  const replies = {
    offline_getMasters: () => JSON.parse(J(MASTERS)),
    offline_getMonthly: d => JSON.parse(J(d.from === '2026-08' ? PREV : MONTHLY)),
    offline_getPrices: () => JSON.parse(J(PRICES)),
    offline_saveTargets: () => ({ success: true }), offline_savePrices: () => ({ success: true }),
    offline_migrateProgress: d => ({ success: true, mode: d.mode, sheetName: '26년 진행현황', year: 2026, months: ['2026-01', '2026-09'], legacyRows: 3, planRows: 12, skippedInput: 0,
      outSkippedUploadMonths: 1, badCells: 0, unmapped: d.mapping && d.mapping.products['건조기'].model ? [] : ['품목 건조기(하이마트)'], written: 12, removed: 0,
      channels: [{ legacy: '하이마트', group: '오프라인', rows: 2, suggest: 'himart', channelId: d.mapping ? d.mapping.channels['하이마트'] : 'himart' }],
      products: [{ legacy: '더플렌더 MAX', channels: ['하이마트'], ambiguous: false, line: '더플렌더', model: '더 플렌더 MAX', suggest: {} },
        { legacy: '건조기', channels: ['하이마트'], ambiguous: true, line: d.mapping ? d.mapping.products['건조기'].line : '미니건조기', model: d.mapping ? d.mapping.products['건조기'].model : '', suggest: {} }],
      compare: [{ ym: '2026-09', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', legacy: 99, ledger: 97, diff: -2 },
        { ym: '2026-09', channelId: 'himart', line: '', model: '(채널 합계)', legacy: 99, ledger: 97, diff: -2, unmatchedQty: 45, total: true }], recentLog: [] }),
    offline_migratePrices: d => ({ success: true, mode: d.mode, sheetName: '납품가 수수료', baseDate: '2026-04-09', written: 2, unmapped: [], recentLog: [{ at: '2026-09-27 10:00:00', by: 'a', target: '단가', range: '2026-01-01', count: 2, unmapped: '', status: '성공' }],
      rows: [{ rowNo: 3, legacyChannel: '하이마트', product: '미니건조기', modelCode: 'MNMD-120G', supplyPrice: 265300, suggest: { channelId: 'himart', line: '미니건조기', model: '미니 건조기 PRO+', from: 'model-code', ambiguous: false } },
        { rowNo: 4, legacyChannel: '하이마트', product: '식기세척기', modelCode: 'MNDW-110G', supplyPrice: 271320, suggest: { channelId: 'himart', line: '미니식기세척기', model: '', from: 'name', ambiguous: true } }] })
  };
  ctx._offlineCall = async (action, data) => { calls.push({ action, data }); return replies[action](data || {}); };
  return { ctx, X, el, calls, replies, page: () => el('page-admin-targets').innerHTML };
}

(async function main() {
  console.log('\n[1] 진입 — 마스터·월별·단가, 표 구성');
  {
    const { ctx, X, el, calls, page } = setup();
    check('PAGE_MOUNTS에 목표 관리', typeof X.PAGE_MOUNTS['admin-targets'] === 'function');
    ctx.navPage('admin-targets', null);
    await settle();
    check('들어오면 마스터·월별(이번 달)·단가를 받는다', ['offline_getMasters', 'offline_getMonthly', 'offline_getPrices'].every(a => calls.some(c => c.action === a)));
    X.TG.ym = '2026-09'; await ctx._tgLoad(); await settle();
    const h = page();
    check('탭 3개', h.indexOf('월별 입력') >= 0 && h.indexOf('>단가<') >= 0 && h.indexOf('>이관<') >= 0);
    check('활성 채널 + 데이터 있는 비활성 채널(트레이더스), 데이터 없는 비활성(신세계)은 숨김', h.indexOf('하이마트 <span') >= 0 && h.indexOf('트레이더스 <span') >= 0 && h.indexOf('신세계 <span') < 0);
    check('업로드 채널 표시: OUT 실적 = 업로드 원장(2026-09~)', h.indexOf('OUT 실적 = 업로드 원장(2026-09~)') >= 0);
    check('업로드 없는 채널 표시', h.indexOf('업로드 없는 채널 — OUT 실적 입력') >= 0);
    check('데이터 없는 품목군은 접힘(더 슬림 모델 줄 안 보임), 있는 품목군은 펼침(MAX 보임)', h.indexOf('>더 슬림</td>') < 0 && h.indexOf('>더 플렌더 MAX</td>') >= 0);
    check('펼친 품목군엔 품목 상수의 모델 전부(Basic~PLUS)', ['더 플렌더 Basic', '더 플렌더 PRO', '더 플렌더 mini', '더 플렌더 NEXT', '더 플렌더 PLUS'].every(m => h.indexOf('>' + m + '</td>') >= 0));
    check('하이마트 9월 OUT 실적은 읽기 전용 + upload 표시(재고구분 소계 툴팁)', /tg-ro" title="판매원장 집계 — 정상 90 · 전시 7">97 <span class="tg-src">upload/.test(h), h.slice(h.indexOf('tg-ro'), h.indexOf('tg-ro') + 120));
    check('트레이더스 OUT 실적은 입력칸 + 원천 migration 표시', /data-f="outA" value="6"[^>]*><span class="tg-src">migration/.test(h));
    check('미매칭 경고 + 코드 매핑 링크', h.indexOf('매핑 안 된 코드 1건(수량 45)') >= 0 && h.indexOf('href="#admin/code-mapping"') >= 0);
    check('단가 없는 모델 경고(접이식)', h.indexOf('단가 없는 모델 1개') >= 0);
    const i = X.TG.view.findIndex(r => r.ch === 'himart' && r.model === '더 플렌더 MAX');
    check('달성률 IN 110%, OUT 107.8%', h.indexOf('id="tgRi' + i + '">110%') >= 0 && h.indexOf('id="tgRo' + i + '">107.8%') >= 0);
    check('금액 = 실적 × 9월 적용 단가(4/9 적용분 374,220)', h.indexOf('id="tgAm' + i + '"><span title="공급가 374,220">IN ₩41,164,200<br>OUT ₩36,299,340') >= 0);
    const id = (scope, f) => ctx._tgTotalId(scope, f);
    check('채널 합계·전체 합계', el(id('ch:himart', 'inT')).innerHTML === '100' && el(id('all', 'inA')).innerHTML === '115' && el(id('all', 'outA')).innerHTML === '103', [el(id('all', 'inA')).innerHTML, el(id('all', 'outA')).innerHTML]);
  }

  console.log('\n[2] 입력 — 다시 그리지 않고 숫자만 갱신, 고친 칸 강조, 저장은 고친 줄만');
  {
    const { ctx, X, el, calls, page } = setup();
    X.TG.ym = '2026-09'; await ctx._tgLoad(); await settle();
    const i = X.TG.view.findIndex(r => r.ch === 'himart' && r.model === '더 플렌더 MAX');
    const before = page();
    const inp = { dataset: { r: String(i), f: 'inT' }, value: '220', classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); } } };
    ctx._tgInput(inp);
    check('표를 다시 그리지 않음(입력칸 유지)', page() === before);
    check('고친 칸 강조', inp.classList._s.has('changed'));
    check('그 줄 달성률 갱신(110/220 = 50%)', el('tgRi' + i).innerHTML === '50%');
    check('합계 갱신(채널 IN 목표 220), 고친 칸 수 표시', el(ctx._tgTotalId('ch:himart', 'inT')).innerHTML === '220' && /고친 칸 1개/.test(el('tgDirty').innerHTML));
    const bad = { dataset: { r: String(i), f: 'outT' }, value: '12x', classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); } } };
    ctx._tgInput(bad);
    check('숫자 아닌 입력은 빨간 칸 + 저장 막음', bad.classList._s.has('bad') && (await ctx._tgSave(), !calls.some(c => c.action === 'offline_saveTargets')));
    bad.value = '95'; ctx._tgInput(bad);
    const t = X.TG.view.findIndex(r => r.ch === 'traders' && r.model === '더 시프트');
    ctx._tgInput({ dataset: { r: String(t), f: 'outA' }, value: '7', classList: { toggle() {} } });
    ctx._tgInput({ dataset: { r: String(i), f: 'outT' }, value: '1,000', classList: { toggle() {} } });
    await ctx._tgSave(); await settle();
    const sv = calls.find(c => c.action === 'offline_saveTargets');
    check('저장 = 고친 줄만 3건', sv && sv.data.items.length === 3, sv && sv.data.items);
    const it = k => sv.data.items.find(x => x.channelId === k[0] && x.type === k[1]);
    check('IN: 목표만 고쳐도 실적은 원래 값(110)과 함께', J(it(['himart', 'IN'])) === J({ type: 'IN', target: 220, actual: 110, ym: '2026-09', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX' }), it(['himart', 'IN']));
    check("OUT(업로드 달): 실적은 보내지 않음(''), 쉼표 제거 1000", it(['himart', 'OUT']).target === 1000 && it(['himart', 'OUT']).actual === '');
    check('업로드 없는 채널 OUT 실적 7', it(['traders', 'OUT']).actual === 7 && it(['traders', 'OUT']).target === 8);
    check('저장 뒤 다시 불러옴(고친 값 초기화)', calls.filter(c => c.action === 'offline_getMonthly').length === 2 && Object.keys(X.TG.edits).length === 0);
  }

  console.log('\n[3] 전월 목표 복사 · 붙여넣기 · 되돌리기');
  {
    const { ctx, X, el, calls, page } = setup();
    X.TG.ym = '2026-09'; await ctx._tgLoad(); await settle();
    await ctx._tgCopyPrev(); await settle();
    check('전월(2026-08) 조회', calls.some(c => c.action === 'offline_getMonthly' && c.data.from === '2026-08'));
    const mini = X.TG.view.find(r => r.ch === 'himart' && r.model === '더 플렌더 mini');
    const max = X.TG.view.find(r => r.ch === 'himart' && r.model === '더 플렌더 MAX');
    check('빈 목표만 채움(mini IN 5·OUT 3), 이미 있는 목표(MAX 100)는 그대로', ctx._tgVal(mini, 'inT') === 5 && ctx._tgVal(mini, 'outT') === 3 && ctx._tgVal(max, 'inT') === 100);
    check('실적은 복사하지 않음', ctx._tgVal(mini, 'inA') === '');
    ctx._tgRevert();
    check('되돌리기 = 고친 값 전부 버림', Object.keys(X.TG.edits).length === 0);
    const start = X.TG.view.findIndex(r => r.ch === 'himart' && r.model === '더 플렌더 PRO');
    let prevented = false;
    ctx._tgPaste({ clipboardData: { getData: () => '1\t2\t3\t4\r\n5\t6\t7\t8\r\n' }, preventDefault() { prevented = true; } }, { dataset: { r: String(start), f: 'inT' } });
    const pro = X.TG.view[start], maxRow = X.TG.view.find(r => r.ch === 'himart' && r.model === '더 플렌더 MAX');
    check('엑셀 2×4 붙여넣기: 기본 붙여넣기 막음', prevented);
    check('  ↳ PRO 줄 IN 1/2 · OUT 목표 3, OUT 실적(업로드 원장)은 건너뜀', ctx._tgVal(pro, 'inT') === 1 && ctx._tgVal(pro, 'inA') === 2 && ctx._tgVal(pro, 'outT') === 3 && !(X.TG.edits[pro.key] || {}).hasOwnProperty('outA'));
    check('  ↳ 다음 보이는 줄(MAX)에 5/6/7', ctx._tgVal(maxRow, 'inT') === 5 && ctx._tgVal(maxRow, 'inA') === 6 && ctx._tgVal(maxRow, 'outT') === 7);
    let prevented2 = false;
    ctx._tgPaste({ clipboardData: { getData: () => '42' }, preventDefault() { prevented2 = true; } }, { dataset: { r: String(start), f: 'inT' } });
    check('한 칸짜리는 브라우저 기본 붙여넣기에 맡김', !prevented2);
    ctx._tgSetYm('2026-10');
    check('저장 안 한 변경이 있으면 월 이동 전에 확인', X.TG.ym === '2026-09' && page().indexOf('저장하지 않은 변경이 있습니다') >= 0);
    ctx._tgDiscardAndGo(); await settle();
    check('버리고 이동하면 새 달 조회', X.TG.ym === '2026-10' && calls.some(c => c.action === 'offline_getMonthly' && c.data.from === '2026-10'));
  }

  console.log('\n[4] 단가 탭 — 현재 적용 표시, 추가, 적용시작일 수정');
  {
    const { ctx, X, calls, page } = setup();
    X.TG.ym = '2026-09'; await ctx._tgLoad(); await settle();
    ctx._tgSetTab('prices'); await settle();
    const h = page();
    check('단가 이력 2건, 최근 적용분에 "현재 적용"', (h.match(/현재 적용/g) || []).length === 1 && h.indexOf('374,220') >= 0 && /cm-off/.test(h));
    Object.assign(X.TG.priceForm, { channelId: 'traders', line: '더시프트', model: '더 시프트', price: '290,950', startDate: '2026-01-01', note: '연초' });
    await ctx._tgPriceAdd(); await settle();
    const sp = calls.find(c => c.action === 'offline_savePrices');
    check('추가 요청(쉼표 제거)', sp && J(sp.data.items) === J([{ channelId: 'traders', line: '더시프트', model: '더 시프트', price: '290950', startDate: '2026-01-01', note: '연초' }]), sp && sp.data);
    check('  ↳ 성공하면 입력칸 비움, 월별 데이터는 다시 받도록 비움', X.TG.priceForm.price === '' && X.TG.data === null);
    const p0 = PRICES.items[0], k = [p0.channelId, p0.line, p0.model, p0.startDate].join('');
    ctx._tgPriceStartEdit(k);
    X.TG.priceEdit.startDate = '2026-02-01';
    await ctx._tgPriceSaveEdit(); await settle();
    const sp2 = calls.filter(c => c.action === 'offline_savePrices')[1];
    check('수정 = origStartDate 포함(적용시작일 옮기기)', sp2 && sp2.data.items[0].origStartDate === '2026-01-01' && sp2.data.items[0].startDate === '2026-02-01');
    ctx._tgSetTab('monthly'); await settle();
    check('월별 탭으로 돌아오면 다시 조회', calls.filter(c => c.action === 'offline_getMonthly').length >= 2 && X.TG.data);
  }

  console.log('\n[5] 이관 탭 — 미리보기 → 매핑 수정 → 다시 계산 → 두 번 눌러 반영');
  {
    const { ctx, X, calls, page } = setup();
    ctx._tgSetTab('migrate');
    await ctx._tgProgPreview(false); await settle();
    let h = page();
    check('미리보기: 월 범위·행 수·미매핑·대조 리포트', h.indexOf('2026-01 ~ 2026-09') >= 0 && h.indexOf('반영 예정 <b>12</b>행') >= 0 && h.indexOf('미매핑(이관하지 않음): 품목 건조기(하이마트)') >= 0 && h.indexOf('미매칭 45') >= 0);
    check('모델 모호 표시 + 선택 필요 줄 강조', h.indexOf('모델 선택 필요') >= 0 && /tg-miss/.test(h));
    check('대조 차이 강조(−2)', /tg-diff">-2/.test(h));
    ctx._tgProgSetModel('건조기', '미니 건조기 PRO');
    await ctx._tgProgPreview(true); await settle();
    const pv2 = calls.filter(c => c.action === 'offline_migrateProgress')[1];
    check('다시 계산은 고친 매핑을 보냄', pv2.data.mapping.products['건조기'].model === '미니 건조기 PRO' && pv2.data.mapping.channels['하이마트'] === 'himart');
    check('  ↳ 고친 매핑 유지', X.TG.mig.progMap.products['건조기'].model === '미니 건조기 PRO');
    await ctx._tgProgApply();
    check('첫 클릭은 확인 버튼으로만(요청 없음)', !calls.some(c => c.action === 'offline_migrateProgress' && c.data.mode === 'apply') && page().indexOf('반영 확인 — 12행 쓰기') >= 0);
    await ctx._tgProgApply(); await settle();
    const ap = calls.find(c => c.action === 'offline_migrateProgress' && c.data.mode === 'apply');
    check('두 번째 클릭에 반영(매핑 포함)', ap && ap.data.mapping.products['건조기'].model === '미니 건조기 PRO');
    check('반영 결과 표시', page().indexOf('✓ 반영 완료 — 12행 쓰기') >= 0);
    ctx._tgProgSetLine('건조기', '미니식기세척기');
    check('품목군을 바꾸면 모델 초기화', X.TG.mig.progMap.products['건조기'].model === '' && X.TG.mig.progMap.products['건조기'].line === '미니식기세척기');

    await ctx._tgPricePreview(); await settle();
    h = page();
    check('단가 미리보기: 기준일·행, MN 코드 제안 표시, 모호 행 강조', h.indexOf('기준일 2026-04-09') >= 0 && h.indexOf('MN 코드') >= 0 && h.indexOf('모델 선택 필요') >= 0);
    check('적용시작일이 1일이 아니면 다음 달부터 계산된다는 안내', h.indexOf('다음 달 1일부터') >= 0);
    ctx._tgPriceRowSet(4, 'model', '미니 식기세척기 PRO');
    X.TG.mig.priceStart = '2026-01-01';
    await ctx._tgPriceApply(); await ctx._tgPriceApply(); await settle();
    const pa = calls.find(c => c.action === 'offline_migratePrices' && c.data.mode === 'apply');
    check('단가 반영: 적용시작일·행별 매핑', pa && pa.data.startDate === '2026-01-01' && J(pa.data.rows) === J([
      { rowNo: 3, channelId: 'himart', line: '미니건조기', model: '미니 건조기 PRO+' }, { rowNo: 4, channelId: 'himart', line: '미니식기세척기', model: '미니 식기세척기 PRO' }]), pa && pa.data);
    check('이관로그 표시', page().indexOf('이관로그') >= 0 && page().indexOf('2026-09-27 10:00:00') >= 0);
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL  예외: ' + (e && e.stack)); process.exit(1); });
