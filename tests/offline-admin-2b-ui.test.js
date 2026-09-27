/* 2-B 잔여 관리 기능 — 코드 매핑 [제품마스터] 탭, 목표 관리 [단가] 행 삭제, 목표 관리 [연간 보기] 탭.
   프론트 실코드 + GAS 실코드(목 시트)를 HTTP만 빼고 직결한다(_gasFetch → doPost).

   지키려는 성질:
     · 제품마스터: SKU 목록·연결 코드 수, 수정 저장, 품목군을 바꾸는데 연결 코드가 있으면 한 번 더 확인(첫 클릭은 저장 안 함),
       비활성화는 두 번·활성화는 한 번, 비활성 SKU는 새 매핑 드롭다운에서 숨김(고른 값이면 보임)
     · 단가 삭제: 두 번 눌러야 삭제, 서버가 이관로그에 삭제자·값 기록, 목록 다시 받음
     · 연간 보기: 그 해 1~12월 월별 해석, 월 합계 = 월별 입력 탭 합계, 목표 보기에서만 편집, 저장은 바뀐 목표 칸만
       (actual 키 없음 → 실적 보존), 대분류 단위 이관 행 읽기 전용, 엑셀 범위 붙여넣기(달 방향), 변경 중 연도 이동 막음

   실행: node tests/offline-admin-2b-ui.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadFrontend } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
const FX = require(path.join(__dirname, 'lib', 'offline-2b-fixture.js'));
const { dataRows } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const PROJ = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 600) : '')); }
}
const J = JSON.stringify;
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0)); };
const SHIM = 'get TG(){return _TG;}, get TGA(){return _TGA;}, get SKM(){return _SKM;}, get CM(){return _CM;}';
const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function setup() {
  const g = FX.env();
  g.call('offline_saveTargets', { items: [
    { ym: '2026-09', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 100, actual: 90 },
    { ym: '2026-08', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 80, actual: 80 },
    { ym: '2026-09', channelId: 'etland', line: '더시프트', model: '더 시프트', type: 'IN', target: 10, actual: 4 }] });
  const T = g.ctx.OFF_TABS, tg = g.tab(T.targets.name);
  g.ctx._offWriteBlock(tg, T.targets, tg.getLastRow() + 1, [['2026-08', 'himart', '', '', 'IN', 20, 15, 'migration', '2026-09-27', 'a', '진행현황 이관(모델 구분 없음)', '건조기']]);
  g.call('offline_savePrices', { items: [{ channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', price: 300000, startDate: '2026-01-01' },
    { channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', price: 374220, startDate: '2026-04-09' }] });
  const { ctx, X } = loadFrontend(PROJ, SHIM);
  const box = {};
  const el = id => (box[id] = box[id] || { id, innerHTML: '', value: '', textContent: '', dataset: {}, style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } } });
  ctx.document.getElementById = el;
  // 붙여넣기가 "화면에 보이는 모델 줄" 순서를 DOM에서 읽는다 — 그린 HTML에서 같은 순서를 뽑아 준다
  ctx.document.querySelectorAll = sel => {
    if (sel !== '.tga-tbl tr.tg-row') return { length: 0, forEach() {}, map: () => [] };
    const out = [];
    el('page-admin-targets').innerHTML.split('<tr class="tg-row">').slice(1).forEach(chunk => { const m = /data-r="(\d+)"/.exec(chunk.split('</tr>')[0]); out.push({ querySelector: () => m ? { dataset: { r: m[1] } } : null }); });
    return out;
  };
  const calls = [];
  ctx._getToken = () => 'T';
  ctx._gasFetch = async (url, opts) => { const b = JSON.parse(opts.body); calls.push({ action: b.action, data: b.data }); return g.call(b.action, b.data, 'user'); };
  return { g, ctx, X, el, calls, page: id => el('page-' + id).innerHTML };
}

(async function main() {
  console.log('\n[1] 코드 매핑 [제품마스터] 탭');
  {
    const { g, ctx, X, calls, page, el } = setup();
    // 표는 입력 포커스를 지키려고 #skmTable만 다시 그린다
    const tbl = () => el('skmTable').innerHTML || page('admin-code-mapping');
    ctx.navPage('admin-code-mapping', null);
    await settle();
    check('탭 [코드 매핑 | 제품마스터], 기본은 코드 매핑', /_cmSetTab\('skus'\)/.test(page('admin-code-mapping')) && /미매칭 코드/.test(page('admin-code-mapping')));
    ctx._cmSetTab('skus');
    let h = page('admin-code-mapping'), t = text(h);
    check('SKU 목록 — 연결 코드 수(SKU-0001: 하이마트 3 + 전자랜드 2 = 5), 비활성 표시', /SKU-0001 더 플렌더 MAX 더 플렌더 더 플렌더 MAX 활성 5/.test(t) && /SKU-0003 더 슬림 더 슬림 비활성/.test(t), t.slice(0, 500));
    ctx._skmStartEdit('SKU-0002');
    ctx._skmEditSet('name', '미니 건조기 PRO 그레이지 3kg'); ctx._skmEditSet('option', '그레이지(3kg)'); ctx._skmEditSet('order', '2');
    const n0 = calls.length;
    await ctx._skmSave();
    await settle();
    const save = calls.slice(n0).find(c => c.action === 'offline_saveSku');
    check('수정 저장 — 표준명·옵션·정렬순서 + 전체 필드(수정 모드: skuId)', save && save.data.sku.skuId === 'SKU-0002' && save.data.sku.name === '미니 건조기 PRO 그레이지 3kg' && save.data.sku.order === '2', save && save.data);
    const row2 = dataRows(g.tab('제품마스터')).find(r => r[0] === 'SKU-0002');
    check('  ↳ 시트 반영 + 마스터 다시 받음', row2[1] === '미니 건조기 PRO 그레이지 3kg' && row2[4] === '그레이지(3kg)' && row2[6] === 2 && calls.slice(n0).some(c => c.action === 'offline_getMasters'), row2);
    ctx._skmStartEdit('SKU-0001');
    ctx._skmEditSet('line', '더슬림', true);
    t = text(tbl());
    check('품목군 변경 — "이 SKU에 연결된 코드 5개의 집계가 바뀝니다" 경고', /이 SKU에 연결된 코드 5개의 집계가 바뀝니다 \(더 플렌더 → 더 슬림\)/.test(t), t.slice(0, 800));
    const n1 = calls.length;
    await ctx._skmSave();
    check('  ↳ 첫 클릭은 저장하지 않고 "변경 확인"', calls.length === n1 && /변경 확인/.test(tbl()));
    await ctx._skmSave();
    await settle();
    check('  ↳ 두 번째 클릭에 저장(품목군 더슬림)', calls.slice(n1).some(c => c.action === 'offline_saveSku' && c.data.sku.line === '더슬림') && dataRows(g.tab('제품마스터')).find(r => r[0] === 'SKU-0001')[2] === '더슬림');
    const n2 = calls.length;
    await ctx._skmToggleActive('SKU-0002');
    check('비활성화 — 첫 클릭은 확인만', calls.length === n2 && /비활성화 확인/.test(tbl()));
    await ctx._skmToggleActive('SKU-0002');
    await settle();
    const off = calls.slice(n2).find(c => c.action === 'offline_saveSku');
    check('  ↳ 두 번째에 활성 N 저장(다른 필드는 안 보냄 → 서버가 보존)', off && off.data.sku.active === 'N' && off.data.sku.option === undefined &&
      dataRows(g.tab('제품마스터')).find(r => r[0] === 'SKU-0002')[4] === '그레이지(3kg)', off && off.data);
    check('비활성 SKU는 새 매핑 드롭다운에서 숨김, 이미 고른 값이면 보임', ctx._mpSkuOptions('').indexOf('SKU-0002') < 0 && ctx._mpSkuOptions('SKU-0002').indexOf('SKU-0002 (비활성)') > 0);
    const n3 = calls.length;
    await ctx._skmToggleActive('SKU-0003');
    await settle();
    check('활성화는 한 번에', calls.slice(n3).some(c => c.action === 'offline_saveSku' && c.data.sku.active === 'Y' && c.data.sku.skuId === 'SKU-0003'));
    ctx._skmSetFilter('active', 'N');
    check('필터: 비활성만', /SKU-0002/.test(page('admin-code-mapping')) && !/SKU-0003/.test(text(page('admin-code-mapping'))));
  }

  console.log('\n[2] 목표 관리 [단가] 행 삭제');
  {
    const { g, ctx, X, calls, page } = setup();
    X.TG.ym = '2026-09';
    ctx.navPage('admin-targets', null);
    await settle();
    ctx._tgSetTab('prices');
    await settle();
    const k = ['himart', '더플렌더', '더 플렌더 MAX', '2026-04-09'].join('\u0001');
    check('단가 행마다 삭제 버튼', (page('admin-targets').match(/_tgPriceDelete\(/g) || []).length === 2);
    const n0 = calls.length;
    await ctx._tgPriceDelete(k);
    check('첫 클릭은 "삭제 확인"만', calls.length === n0 && /삭제 확인/.test(page('admin-targets')) && /이관로그에 삭제자·값이 남습니다/.test(page('admin-targets')));
    await ctx._tgPriceDelete(k);
    await settle();
    const del = calls.slice(n0).find(c => c.action === 'offline_deletePrice');
    check('두 번째에 offline_deletePrice(채널·품목군·모델·적용시작일) → 목록 다시 받음', del && J(del.data) === J({ channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', startDate: '2026-04-09' }) &&
      calls.slice(n0).some(c => c.action === 'offline_getPrices') && X.TG.prices.length === 1, del && del.data);
    const log = dataRows(g.tab('이관로그')).pop();
    check('  ↳ 이관로그: 삭제자(세션)·단가 삭제·원래 공급가', log[1] === FX.USER && log[2] === '단가 삭제' && /374220/.test(log[5]), log);
    check('  ↳ 월별 금액이 바뀌므로 월별 입력은 다시 받게 비움', X.TG.data === null);
  }

  console.log('\n[3] 목표 관리 [연간 보기]');
  {
    const { g, ctx, X, calls, page, el } = setup();
    X.TG.ym = '2026-09';
    ctx.navPage('admin-targets', null);
    await settle();
    const monthlyAll = ctx._tgTotals().all;
    ctx._tgSetTab('annual');
    await settle();
    const q = calls.filter(c => c.action === 'offline_getMonthly').pop();
    check('그 해 1~12월 월별 해석을 받음', q && q.data.from === '2026-01' && q.data.to === '2026-12' && X.TGA.year === '2026', q && q.data);
    const T = ctx._tgaTotals();
    check('9월 IN 목표·실적 합계 = 월별 입력 탭 합계(110 / 94)', T.all['2026-09'].t === monthlyAll.inT && T.all['2026-09'].a === monthlyAll.inA && monthlyAll.inT === 110 && monthlyAll.inA === 94, [T.all['2026-09'], monthlyAll]);
    check('8월 = 모델 80 + 대분류 이관 20 = 100 · 연 합계 210', T.all['2026-08'].t === 100 && T.all.Y.t === 210 && T['cat:himart|건조기']['2026-08'].t === 20, [T.all['2026-08'], T.all.Y]);
    let h = page('admin-targets');
    check('대분류 단위 이관 줄은 읽기 전용(입력칸 없음)', /이관\(모델 구분 없음\)/.test(h) && !/<tr class="tg-catrow">[^]*?<input/.test(h.split('<tr class="tg-catrow">')[1].split('</tr>')[0]));
    const idx = X.TGA.rows.findIndex(r => r.key === 'himart|더플렌더|더 플렌더 MAX');
    check('모델 줄은 목표 보기에서 1~12월 입력칸', (h.split(`data-r="${idx}"`).length - 1) === 12);
    ctx._tgaInput({ dataset: { r: String(idx), m: '9' }, value: '120', classList: { toggle() {} } });
    check('칸 수정 → 고친 칸 1 · 합계 즉시 반영(10월 120, 연 330)', /고친 칸 1개/.test(el('tgaDirty').innerHTML) && ctx._tgaTotals().all.Y.t === 330);
    // 붙여넣기: 11월부터 두 달, 두 줄(MAX, mini)
    const ev = { clipboardData: { getData: () => '130\t140\n5\t6\n' }, preventDefault() {} };
    ctx._tgaPaste(ev, { dataset: { r: String(idx), m: '10' } });
    const mini = X.TGA.rows.findIndex(r => r.key === 'himart|더플렌더|더 플렌더 mini');
    check('엑셀 붙여넣기 — 오른쪽(달)·아래(보이는 모델 줄)로 채움', ctx._tgaTarget(X.TGA.rows[idx], '2026-11') === 130 && ctx._tgaTarget(X.TGA.rows[idx], '2026-12') === 140 &&
      ctx._tgaTarget(X.TGA.rows[mini], '2026-11') === 5 && ctx._tgaTarget(X.TGA.rows[mini], '2026-12') === 6, [mini]);
    ctx._tgaSet('side', 'OUT');
    ctx._tgaInput({ dataset: { r: String(idx), m: '9' }, value: '70', classList: { toggle() {} } });
    ctx._tgaSet('side', 'IN');
    check('IN/OUT을 오가도 고친 값 유지(IN 4칸 + mini 2칸 + OUT 1칸 = 6... 칸 수)', ctx._tgaChangedCount() === 6 && ctx._tgaTarget(X.TGA.rows[idx], '2026-10') === 120, ctx._tgaChangedCount());
    ctx._tgaSetYear('2027');
    check('저장 안 한 변경이 있으면 연도 이동 막음', X.TGA.year === '2026');
    ctx._tgaSet('view', 'actual');
    h = page('admin-targets');
    check('실적 보기 — 입력칸 없음, 저장 버튼 없음', h.indexOf('tga-inp') < 0 && h.indexOf('_tgaSave()') < 0);
    ctx._tgaSet('view', 'rate');
    check('달성률 보기 — 9월 MAX 90%', /90%/.test(page('admin-targets')));
    ctx._tgaSet('view', 'target');
    const n0 = calls.length;
    await ctx._tgaSave();
    await settle();
    const save = calls.slice(n0).find(c => c.action === 'offline_saveTargets');
    check('저장: 바뀐 칸만 6건, 목표만(actual 키 없음), IN/OUT 구분', save && save.data.items.length === 6 && save.data.items.every(i => !('actual' in i)) &&
      save.data.items.filter(i => i.type === 'OUT').length === 1, save && save.data.items);
    const rows = dataRows(g.tab('목표실적_월'));
    check('  ↳ 시트: 10월 IN 목표 120 · OUT 목표 70, 9월 IN 실적 90은 그대로', rows.some(r => r[0] === '2026-10' && r[4] === 'IN' && r[5] === 120) && rows.some(r => r[0] === '2026-10' && r[4] === 'OUT' && r[5] === 70) &&
      rows.find(r => r[0] === '2026-09' && r[1] === 'himart' && r[4] === 'IN')[6] === 90);
    check('  ↳ 다시 받아 변경 없음, 월별 입력 탭은 다시 받게 비움', ctx._tgaChangedCount() === 0 && ctx._tgaTotals().all.Y.t === 330 + 130 + 140 + 5 + 6 && X.TG.data === null);
    ctx._tgaSetYear('2027');
    await settle();
    check('변경이 없으면 연도 이동', X.TGA.year === '2027' && calls.some(c => c.action === 'offline_getMonthly' && c.data.from === '2027-01'));
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL  예외: ' + e.stack); process.exit(1); });
