/* 트레이더스 분리(2026-09-28) — 이마트 포털의 점포별 일별 매출·재고 파일로 이마트·트레이더스를 나눈다.

   지키려는 성질:
     [2] 코드 매핑 공유 — 트레이더스는 코드체계채널(emart) 매핑으로 해석한다(월별 해석·재고 지표·프론트 해석기),
         미매칭코드·매핑 저장은 emart 한 벌(같은 코드가 두 번 뜨지 않음), 코드 매핑 화면에는 트레이더스가 따로 없고 안내가 뜬다
     [4] 점포별 일별 매출: 업태명 → 원천업태명으로 채널, 파일 속 채널마다 교체 기간 교체(점포 빈칸 합계 행 정리), 모르는 업태명 보류,
         점포마스터에 점포 채널 기록(코드체계 안에서 이동), 로그 channel_id 'emart,traders', 재업로드 불변, 미리보기 채널별
     [5] 기존 합계 양식: 판별은 유지, 반영 버튼 비활성 + 안내, 전체 반영에서 제외, 서버도 거절
     [6] 이마트 재고: 점포마스터 → 점포명접두어 → 기본 이마트(경고)로 채널, 채널일별·점포최신 채널별 교체, 이마트 + 트레이더스 = 파일 합계,
         재업로드 불변, 과거 파일은 점포최신을 건드리지 않음, 미리보기도 같은 규칙

   실행: node tests/offline-traders.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadOfflineGas, dataRows } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const { loadFrontend } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
const PROJ = path.join(__dirname, '..');
const P = require(path.join(PROJ, 'src', 'features', 'offline', 'parsers.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 600) : '')); }
}
const J = JSON.stringify;
const TODAY = '2026-09-28';
const AUTH = { email: 'tester@athomecorp.com' };
const MAX = '8809770080968', MAX_DISPLAY = '2790198885265', NEW = '8809999999999';

// setup(초기값 = 트레이더스 활성·코드체계 emart) + SKU 1개 + 이마트 매핑 2개
function env() {
  const g = loadOfflineGas({ setup: true, today: TODAY });
  g.ctx._offWriteBlock(g.tab('제품마스터'), g.ctx.OFF_TABS.sku, 2, [['SKU-0001', '더 플렌더 MAX', '더플렌더', '더 플렌더 MAX', '', 'Y', '', '']]);
  g.ctx._offWriteBlock(g.tab('코드매핑'), g.ctx.OFF_TABS.mapping, 2, [['emart', MAX, 'SKU-0001', '정상', '미닉스 더플렌더 MAX(그레이지)', '', '', ''],
    ['emart', MAX_DISPLAY, 'SKU-0001', '전시', '미닉스 더플렌더 MAX(그레이지)', '', '', '']]);
  g.rows = name => dataRows(g.tab(name));
  return g;
}

(function main() {
  console.log('\n[2] 코드 매핑 공유 — 트레이더스는 이마트 매핑으로');
  {
    const g = env(), T = g.ctx.OFF_TABS, read = k => g.ctx._offReadRows(g.tab(T[k].name), T[k]);
    const SL = (d, ch, store, code, q) => [d, d, 'day', ch, store, code, q, '', 'upload', 'U'];
    const sales = [SL('2026-09-03', 'traders', '2001', MAX, 3), SL('2026-09-04', 'emart', '1003', MAX, 2), SL('2026-09-05', 'traders', '2002', NEW, 1)];
    const mon = g.ctx._offMonthlyCompute({ from: '2026-09', to: '2026-09', channels: read('channel'), targets: [], prices: [], sales, mappings: read('mapping'), skus: read('sku') });
    const tr = mon.rows.find(r => r.channelId === 'traders' && r.model === '더 플렌더 MAX');
    check('월별 해석: 트레이더스 판매가 이마트 매핑으로 더 플렌더 MAX 3', tr && tr.out.actual === 3 && tr.out.source === 'upload', mon.rows);
    check('  ↳ 이마트는 따로 2, 미매칭은 트레이더스 채널에 1', mon.rows.find(r => r.channelId === 'emart').out.actual === 2 &&
      J(mon.unmatched.map(u => [u.channelId, u.code, u.qty])) === J([['traders', NEW, 1]]), mon.unmatched);
    const R = g.ctx._offCodeResolver(read('sku'), read('mapping'), read('channel'));
    check('재고 지표 해석기: 트레이더스 전시 코드 → SKU-0001 전시', R.resolve('traders', MAX_DISPLAY).sku.skuId === 'SKU-0001' && R.resolve('traders', MAX_DISPLAY).stockType === '전시');
    check('  ↳ 채널 행 없이 부르면 예전처럼 자기 채널만', g.ctx._offCodeResolver(read('sku'), read('mapping')).resolve('traders', MAX) === null);
    // 미매칭 — 트레이더스에서 나온 코드도 emart 이름으로 한 번만
    const ctx = { ss: g.off, today: TODAY };
    g.ctx._offUpdateUnmatched(ctx, 'traders', { [NEW]: '새 상품', [MAX]: '매핑됨' });
    g.ctx._offUpdateUnmatched(ctx, 'emart', { [NEW]: '새 상품' });
    const um = g.rows('미매칭코드');
    check('미매칭: 트레이더스·이마트에서 두 번 나온 새 코드 = emart 1행, 발견 2회 (매핑된 코드는 안 쌓임)', J(um.map(r => [r[0], r[1], r[5]])) === J([['emart', NEW, 2]]), um);
    const call = (a, d) => JSON.parse(g.ctx._offlineHandle(a, d, AUTH));
    const saved = call('offline_saveMapping', { items: [{ op: 'upsert', channelId: 'traders', code: NEW, skuId: 'SKU-0001', stockType: '정상', name: '새 상품' }] });
    const mp = g.rows('코드매핑');
    check('트레이더스로 저장해도 emart 매핑 한 벌(행 수 3, 채널 emart)', saved.success && mp.length === 3 && mp[2][0] === 'emart' && mp[2][1] === NEW, mp);
    check('  ↳ 미매칭에서 빠짐', g.rows('미매칭코드').length === 0 && call('offline_getUnmatched', {}).items.length === 0);
    call('offline_saveMapping', { items: [{ op: 'deactivate', channelId: 'traders', code: NEW }] });
    check('비활성화도 emart 행으로 → 미매칭 emart로 복귀', g.rows('코드매핑')[2][2] === '' && J(g.rows('미매칭코드').map(r => [r[0], r[1]])) === J([['emart', NEW]]));
  }

  console.log('\n[2-화면] 코드 매핑 화면 — 트레이더스는 채널 필터에 없고 안내');
  {
    const { ctx } = loadFrontend(PROJ, 'get CM(){return _CM;}');
    const box = {};
    ctx.document.getElementById = id => (box[id] = box[id] || { innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
    ctx.OFFLINE_MASTERS = null;
    ctx._offlineLoadMasters = async () => ctx.OFFLINE_MASTERS;
    vmSet(ctx, { skus: [], mappings: [], stores: [], channels: [
      { channelId: 'himart', name: '하이마트', codeSystem: 'himart' }, { channelId: 'emart', name: '이마트', codeSystem: 'emart' },
      { channelId: 'traders', name: '트레이더스', codeSystem: 'emart' }] });
    ctx._offlineCall = async () => ({ success: true, items: [] });
    ctx._cmRender();
    const h = box['page-admin-code-mapping'].innerHTML;
    const opts = [...h.matchAll(/onchange="_cmSetFilter\('ch',this.value\)">([\s\S]*?)<\/select>/g)][0][1];
    check('채널 필터: 하이마트·이마트만(트레이더스 없음)', /하이마트/.test(opts) && /이마트/.test(opts) && !/트레이더스/.test(opts), opts);
    check('안내: 트레이더스는 이마트 코드 매핑을 그대로', /<b>트레이더스<\/b>는 <b>이마트<\/b> 코드 매핑을 그대로 씁니다/.test(h), h.slice(0, 300));
  }

  console.log('\n[4] 이마트 점포별 일별 매출(EMART_DAILY_SALES_STORE) — 업태명으로 이마트·트레이더스');
  {
    const g = env(), T = g.ctx.OFF_TABS;
    // 분리 전 원장: 점포 빈칸 이마트 합계 행(9/1 5, 8/31 7) + 하이마트 행, 점포마스터에 이마트로 잡혀 있던 TR 점포
    g.ctx._offWriteBlock(g.tab('판매원장'), T.sales, 2, [['2026-09-01', '2026-09-01', 'day', 'emart', '', MAX, 5, '', 'upload', 'OLD'],
      ['2026-08-31', '2026-08-31', 'day', 'emart', '', MAX, 7, '', 'upload', 'OLD'], ['2026-09-01', '2026-09-01', 'day', 'himart', 'S1', 'MNFD-200G', 4, 4, 'upload', 'H']]);
    g.ctx._offWriteBlock(g.tab('점포마스터'), T.store, 2, [['emart', '2001', 'TR구성점', '', '2026-09-25', '2026-09-25']]);
    const file = storeSales(['09월01일', '09월02일'], [
      ['이마트', '1003', 'EM분당점', MAX, 2, -1], ['트레이더스', '2001', 'TR구성점', MAX, 3, 0], ['트레이더스', '2002', 'TR송림점', NEW, 0, 1],
      ['SSG', '9001', '가상점', MAX, 1, 0]]);
    const pr = P.parseRows(file, { fileName: '기간별매출(상품별)_일별상세_20260928101437.xlsx', today: TODAY });
    check('판별: 점포별 일별 매출(합계 양식보다 먼저), split biz, 기간 9/1~9/2', pr.ok && pr.type === 'EMART_DAILY_SALES_STORE' && pr.split === 'biz' && J(pr.period) === J({ start: '2026-09-01', end: '2026-09-02' }), pr);
    check('파서: 점포 단위 day 레코드 5개(0 제외·음수 유지), 레코드·점포에 업태명', pr.records.sales.length === 5 && pr.records.sales.every(x => x.store && x.biz) &&
      pr.records.sales.some(x => x.store === '1003' && x.qty === -1) && pr.records.stores.find(x => x.code === '2002').biz === '트레이더스', pr.records);
    check('  ↳ 업태명별 요약(미리보기용)', J(pr.summary.byBiz) === J([{ biz: '이마트', rows: 2, stores: 1, qty: 1 }, { biz: '트레이더스', rows: 2, stores: 2, qty: 4 }, { biz: 'SSG', rows: 1, stores: 1, qty: 1 }]), pr.summary.byBiz);
    const up = () => g.ctx._offUpload(P.toUploadPayload(pr, { fileName: '기간별매출(상품별)_일별상세_20260928101437.xlsx' }), AUTH);
    const r1 = up();
    const L = () => g.rows('판매원장').map(r => [r[0], r[3], r[4], r[5], r[6]].join('|')).sort();
    check('반영: 이마트 2행 · 트레이더스 2행, 예전 점포 빈칸 이마트 9/1 합계 행은 교체로 사라짐, 8/31·하이마트는 그대로', J(L()) === J([
      '2026-08-31|emart||' + MAX + '|7', '2026-09-01|emart|1003|' + MAX + '|2', '2026-09-01|himart|S1|MNFD-200G|4', '2026-09-01|traders|2001|' + MAX + '|3', '2026-09-02|emart|1003|' + MAX + '|-1', '2026-09-02|traders|2002|' + NEW + '|1']), L());
    check('  ↳ 채널별 반영 수·응답 채널', J(r1.applied.byChannel) === J({ emart: { rows: 2, qty: 1 }, traders: { rows: 2, qty: 4 } }) && J(r1.channels) === J(['emart', 'traders']), r1.applied);
    check('  ↳ 모르는 업태명(SSG)은 보류 + 경고', !g.rows('판매원장').some(r => r[4] === '9001') && r1.warnings.some(w => /"SSG" 1건/.test(w) && /보류/.test(w)), r1.warnings);
    const st = g.rows('점포마스터').map(r => r[0] + ':' + r[1]).sort();
    check('점포마스터: 1003 이마트, 2001은 이마트 → 트레이더스로 옮김(한 행), 2002 트레이더스, SSG 점포 없음', J(st) === J(['emart:1003', 'traders:2001', 'traders:2002']) && r1.applied.storesMoved === 1, st);
    check('  ↳ 옮긴 점포의 최초등록일 유지', g.rows('점포마스터').find(r => r[1] === '2001')[4] === '2026-09-25');
    const log = g.rows('업로드로그').pop();
    check('업로드로그 channel_id = emart,traders', log[5] === 'emart,traders' && log[4] === 'EMART_DAILY_SALES_STORE', log);
    const stt = JSON.parse(g.ctx._offlineHandle('offline_getStatus', {}, AUTH));
    const sc = id => stt.channels.find(c => c.channelId === id);
    check('데이터 현황: 이마트·트레이더스 둘 다 판매 9/2까지', sc('emart').salesLast === '2026-09-02' && sc('traders').salesLast === '2026-09-02', stt.channels);
    check('미매칭: 트레이더스 새 코드도 emart로 한 번', J(g.rows('미매칭코드').map(r => r[0] + ':' + r[1])) === J(['emart:' + NEW]), g.rows('미매칭코드'));
    const before = { l: L(), s: g.rows('점포마스터').length, u: g.rows('미매칭코드').length };
    up();
    check('같은 파일 재반영 → 판매원장·점포마스터·미매칭 행 수·내용 불변', J(L()) === J(before.l) && g.rows('점포마스터').length === before.s && g.rows('미매칭코드').length === before.u);
    // 트레이더스 판매가 이마트 매핑으로 월별 OUT에
    const mon = JSON.parse(g.ctx._offlineHandle('offline_getMonthly', { from: '2026-09', to: '2026-09' }, AUTH));
    const m = id => mon.totals.byChannelMonth.find(t => t.channelId === id);
    check('월별 해석: 이마트 OUT 1 · 트레이더스 OUT 3(이마트 매핑) + 미매칭 1', m('emart').out.actual === 1 && m('traders').out.actual === 3 && m('traders').out.unmatchedQty === 1, [m('emart'), m('traders')]);
  }

  console.log('\n[4-화면] 업로드 카드 — 채널별 미리보기, 매출 파일을 재고 파일보다 먼저');
  {
    const { ctx } = loadFrontend(PROJ, 'get UP(){return _UP;}');
    vmSet(ctx, { skus: [], mappings: [], stores: [], channels: [{ channelId: 'emart', name: '이마트', bizNames: '이마트', codeSystem: 'emart' },
      { channelId: 'traders', name: '트레이더스', bizNames: '트레이더스', codeSystem: 'emart' }] });
    const pr = P.parseRows(storeSales(['09월01일'], [['이마트', '1003', 'EM분당점', MAX, 2], ['트레이더스', '2001', 'TR구성점', MAX, 3], ['SSG', '9001', '가상점', MAX, 1]]),
      { fileName: 'x_20260928101437.xlsx', today: TODAY });
    const h = ctx._upSplitHtml(pr);
    check('채널별 줄: 이마트 · 트레이더스 · 채널 없음(보류)', /이마트<\/span> 업태명 "이마트" · 레코드 <b>1<\/b> · 점포 <b>1<\/b> · 판매 <b>2<\/b>/.test(h) &&
      /트레이더스<\/span> 업태명 "트레이더스"[^<]*<b>1<\/b>[^<]*<b>1<\/b>[^<]*<b>3<\/b>/.test(h) && /채널 없음<\/span> 업태명 "SSG".*보류/.test(h), h);
    const X = ctx.__X__;
    const mk = (id, parse) => ({ id, status: 'ready', parse, edits: {}, name: 'f' + id });
    const stock = P.parseRows([['구분'], ['조회일자', '점포명', '점포코드', '상품명', '현재수량', '매입량', '상품코드', '매출량'], ['202609', 'EM분당점', '1003', '가상', 1, 0, MAX, 0]],
      { fileName: '재고현황_상세_20260928101559.xlsx', today: TODAY });
    X.UP.files.push(mk(1, stock), mk(2, pr));
    check('전체 반영 순서: 점포별 매출 → 재고', ctx._upApplyOrder().map(f => f.parse.type).join() === 'EMART_DAILY_SALES_STORE,EMART_STOCK', ctx._upApplyOrder().map(f => f.parse.type));
  }

  console.log('\n[6] 이마트 재고(EMART_STOCK) — 점포마스터 → 점포명접두어 → 기본 이마트로 채널을 나눈다');
  {
    const g = env(), T = g.ctx.OFF_TABS;
    const D = '2026-09-28';
    // 점포마스터: 1003 이마트, 2001 트레이더스(점포별 매출 파일에서 익힌 상태) / 분리 전 이마트 합계 재고
    g.ctx._offWriteBlock(g.tab('점포마스터'), T.store, 2, [['emart', '1003', 'EM분당점', '', '2026-09-25', '2026-09-28'], ['traders', '2001', 'TR구성점', '', '2026-09-25', '2026-09-28']]);
    g.ctx._offWriteBlock(g.tab('재고_채널일별'), T.stockDaily, 2, [[D, 'emart', MAX, 99, '', '', 'OLD'], ['2026-09-25', 'emart', MAX, 50, '', '', 'OLD']]);
    g.ctx._offWriteBlock(g.tab('재고_점포최신'), T.stockStore, 2, [['2026-09-25', 'emart', '2001', MAX, 9, '', '', 0, 0, 'OLD'], ['2026-09-25', 'emart', '1003', MAX, 9, '', '', 0, 0, 'OLD']]);
    const file = stockFile([['EM분당점', '1003', MAX, 2, 1], ['TR구성점', '2001', MAX, 5, 0], ['TR송림점', '2002', MAX, 3, 1], ['SFM군산점', '1025', MAX, 1, 0], ['EM창동점', '1001', MAX_DISPLAY, 4, 0]]);
    const pr = P.parseRows(file, { fileName: '재고현황_상세_20260928101559.xlsx', today: TODAY });
    check('판별: 이마트 재고, split store, 기준일(14자리 파일명) 2026-09-28', pr.ok && pr.type === 'EMART_STOCK' && pr.split === 'store' && pr.baseDate === D, pr);
    const up = name => g.ctx._offUpload(P.toUploadPayload(pr, { fileName: name || '재고현황_상세_20260928101559.xlsx' }), AUTH);
    const r1 = up();
    const daily = () => g.rows('재고_채널일별').map(r => [r[0], r[1], r[2], r[3]].join('|')).sort();
    check('재고_채널일별: 9/28은 이마트(1003 2 + 1025 1 = MAX 3, 전시 4)·트레이더스(5 + 3 = MAX 8)로 교체, 9/25 이마트 합계는 그대로', J(daily()) === J([
      '2026-09-25|emart|' + MAX + '|50', D + '|emart|' + MAX_DISPLAY + '|4', D + '|emart|' + MAX + '|3', D + '|traders|' + MAX + '|8']), daily());
    const store = () => g.rows('재고_점포최신').map(r => [r[0], r[1], r[2], r[4]].join('|')).sort();
    check('재고_점포최신: 이마트 3점포 · 트레이더스 2점포(분리 전 이마트 행은 교체)', J(store()) === J([D + '|emart|1001|4', D + '|emart|1003|2', D + '|emart|1025|1', D + '|traders|2001|5', D + '|traders|2002|3']), store());
    const total = pr.records.storeStock.reduce((s, x) => s + x.stock, 0);
    check('이마트 7 + 트레이더스 8 = 파일 재고 합계 15', J(r1.applied.byChannel) === J({ emart: { stores: 3, stock: 7 }, traders: { stores: 2, stock: 8 } }) && total === 15, r1.applied.byChannel);
    check('판별 경로: 점포마스터 2 · 접두어 2(TR송림·EM창동) · 기본 1(SFM군산) + 경고', J(r1.applied.channelVia) === J({ master: 2, prefix: 2, fallback: 1 }) &&
      r1.warnings.some(w => /1곳은 이마트로/.test(w) && /1025 SFM군산점/.test(w)), [r1.applied.channelVia, r1.warnings]);
    const sm = g.rows('점포마스터').map(r => r[0] + ':' + r[1]).sort();
    check('점포마스터: 2002 트레이더스(접두어), 1025·1001 이마트', J(sm) === J(['emart:1001', 'emart:1003', 'emart:1025', 'traders:2001', 'traders:2002']), sm);
    check('업로드로그 channel_id = emart,traders · 응답 채널', g.rows('업로드로그').pop()[5] === 'emart,traders' && J(r1.channels) === J(['emart', 'traders']));
    const snap = { d: daily(), s: store(), m: g.rows('점포마스터').length };
    up();
    check('같은 파일 재반영 → 재고 두 탭·점포마스터 불변', J(daily()) === J(snap.d) && J(store()) === J(snap.s) && g.rows('점포마스터').length === snap.m);
    const older = P.parseRows(stockFile([['TR구성점', '2001', MAX, 1, 0], ['EM분당점', '1003', MAX, 1, 0]]), { fileName: '재고현황_상세_20260920101559.xlsx', today: TODAY });
    const r3 = g.ctx._offUpload(P.toUploadPayload(older, { fileName: '재고현황_상세_20260920101559.xlsx' }), AUTH);
    check('더 과거 파일 → 채널일별에 9/20 채널별 추가, 점포최신은 두 채널 모두 그대로 + 경고', daily().some(x => x === '2026-09-20|traders|' + MAX + '|1') && daily().some(x => x === '2026-09-20|emart|' + MAX + '|1') &&
      J(store()) === J(snap.s) && r3.warnings.filter(w => /더 최신 기준일/.test(w)).length === 2, r3.warnings);
    // 재고 지표 — 트레이더스 재고가 이마트 매핑으로 SKU에
    const inv = JSON.parse(g.ctx._offlineHandle('offline_getInventory', { channelId: 'traders' }, AUTH));
    const tg = inv.groups.find(x => x.channelId === 'traders' && x.level === 'sku' && x.key === 'SKU-0001');
    check('재고 지표: 트레이더스 SKU-0001 정상 8(이마트 매핑), 기준일 9/28, 점포 표 2점포', tg && tg.stock['정상'] === 8 && inv.channels.find(c => c.channelId === 'traders').stockDate === D && inv.stores.length === 2, tg);
  }

  console.log('\n[6-화면] 재고 파일 미리보기 — 채널별 점포 수·재고 합계, 판별 경로');
  {
    const { ctx } = loadFrontend(PROJ, '');
    vmSet(ctx, { skus: [], mappings: [], stores: [{ channelId: 'emart', code: '1003' }, { channelId: 'traders', code: '2001' }, { channelId: 'himart', code: '2002' }],
      channels: [{ channelId: 'emart', name: '이마트', storePrefix: 'EM', codeSystem: 'emart' }, { channelId: 'traders', name: '트레이더스', storePrefix: 'TR', codeSystem: 'emart' },
        { channelId: 'himart', name: '하이마트', codeSystem: 'himart' }] });
    const pr = P.parseRows(stockFile([['EM분당점', '1003', MAX, 2, 1], ['TR구성점', '2001', MAX, 5, 0], ['TR송림점', '2002', MAX, 3, 1], ['SFM군산점', '1025', MAX, 1, 0]]),
      { fileName: '재고현황_상세_20260928101559.xlsx', today: TODAY });
    const sp = ctx._upStoreSplit(pr);
    check('미리보기 = 서버와 같은 규칙(다른 코드체계 점포마스터 무시 → 2002는 접두어로 트레이더스)', J(sp.byCh) === J({ emart: { stores: 2, stock: 3 }, traders: { stores: 2, stock: 8 } }) &&
      J(sp.via) === J({ master: 2, prefix: 1, fallback: 1 }), sp);
    const h = ctx._upSplitHtml(pr);
    check('채널별 줄 + 못 정한 점포 안내', /이마트<\/span> 점포 <b>2<\/b> · 재고 <b>3<\/b>/.test(h) && /트레이더스<\/span> 점포 <b>2<\/b> · 재고 <b>8<\/b>/.test(h) && /못 정해 이마트로 1곳/.test(h), h);
  }

  console.log('\n[5] 기존 EMART_DAILY_SALES(합계) 양식 차단 — 판별은 유지, 반영 버튼 비활성·안내');
  {
    const { ctx } = loadFrontend(PROJ, 'get UP(){return _UP;}');
    const box = {};
    ctx.document.getElementById = id => (box[id] = box[id] || { innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
    vmSet(ctx, { skus: [], mappings: [], stores: [], channels: [{ channelId: 'emart', name: '이마트', bizNames: '이마트', codeSystem: 'emart' }] });
    const calls = [];
    ctx._offlineCall = async (a, d) => { calls.push(a); return { success: true, applied: {}, replaceRange: {}, unmatched: [], warnings: [] }; };
    const old = [['상품 코드', '상품명', '9월 1일', '합계', '평균'], [MAX, '가상', 2, 2, 0]];
    const pr = P.parseRows(old, { fileName: '기간별매출(상품별)_일별요약_20260925104853.xlsx', today: TODAY });
    ctx.__X__.UP.files.push({ id: 9, name: '기간별매출(상품별)_일별요약_20260925104853.xlsx', status: 'ready', parse: pr, edits: {}, rows: old });
    const html = ctx._upCardHtml(ctx.__X__.UP.files[0]);
    check('판별은 합계 양식으로', pr.type === 'EMART_DAILY_SALES' && pr.ok);
    check('카드: 반영 버튼 disabled + "트레이더스가 합쳐진 합계 파일이라 반영할 수 없습니다" 안내', /<button[^>]*disabled[^>]*onclick="_upApply\(9\)"/.test(html) &&
      /⛔ 트레이더스가 합쳐진 합계 파일이라 반영할 수 없습니다\. '기간별매출\(상품별\)_일별상세' 파일을 사용하세요/.test(html), html.slice(0, 1500));
    check('전체 반영 목록에서 빠짐', ctx._upApplyOrder().length === 0);
    (async () => {
      const ok = await ctx._upApply(9);
      check('직접 불러도 서버에 보내지 않음', ok === false && calls.indexOf('offline_upload') < 0, calls);
      finish();
    })();
  }
})();

function finish() {
  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
}

// 이마트 점포별 일별 매출 합성 파일 — lines: [업태명, 점포코드, 점포명, 상품코드, 날짜별 수량...]
function storeSales(dates, lines) {
  return [['업태명', '점포코드', '점포명', '상품코드', '상품명', '대분류', '중분류', '소분류', '브랜드'].concat(dates, ['합계', '평균'])]
    .concat(lines.map(l => [l[0], l[1], l[2], l[3], '가상 ' + l[3], '가전', '가전', '가전', '기타'].concat(l.slice(4), [0, 0])));
}

// OFFLINE_MASTERS는 let 선언이라 vm 컨텍스트 프로퍼티가 아니다 — 스크립트로 넣는다
function vmSet(ctx, masters) { require('vm').runInContext('OFFLINE_MASTERS = ' + J(masters) + ';', ctx); }

// 이마트 재고 합성 파일('재고현황_상세' — 상단 요약 뒤 헤더) — lines: [점포명, 점포코드, 상품코드, 현재수량, 매출량]
function stockFile(lines) {
  return [['구분', '전월재고', '매입', '매출', '이관', '현재고'], ['수량', 0, 0, 0, 0, lines.reduce((s, l) => s + l[3], 0)], [], [],
    ['조회일자', '점포명', '점포코드', '상품명', '전월수량', '전월금액', '현재수량', '현재금액', '이관량', '이관액', '매입량', '매입액', '상품코드', '매출량']]
    .concat(lines.map(l => ['202609', l[0], l[1], '가상 ' + l[2], 0, 0, l[3], 0, 0, 0, 0, 0, l[2], l[4]]));
}
