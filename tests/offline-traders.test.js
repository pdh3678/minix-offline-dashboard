/* 트레이더스 분리(2026-09-28) — 이마트 포털의 점포별 일별 매출·재고 파일로 이마트·트레이더스를 나눈다.

   지키려는 성질:
     [2] 코드 매핑 공유 — 트레이더스는 코드체계채널(emart) 매핑으로 해석한다(월별 해석·재고 지표·프론트 해석기),
         미매칭코드·매핑 저장은 emart 한 벌(같은 코드가 두 번 뜨지 않음), 코드 매핑 화면에는 트레이더스가 따로 없고 안내가 뜬다

   실행: node tests/offline-traders.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadOfflineGas, dataRows } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const { loadFrontend } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
const PROJ = path.join(__dirname, '..');

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

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})();

// OFFLINE_MASTERS는 let 선언이라 vm 컨텍스트 프로퍼티가 아니다 — 스크립트로 넣는다
function vmSet(ctx, masters) { require('vm').runInContext('OFFLINE_MASTERS = ' + J(masters) + ';', ctx); }
