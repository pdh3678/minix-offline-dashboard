/* 2-B 재고·판매 지표 공용 픽스처 — offline-inventory.test.js(GAS 지표)와 offline-screens-ui.test.js(화면)가 같이 쓴다.
   숫자는 손으로 계산해 둔 기대값과 맞물려 있다(offline-inventory.test.js 주석) — 바꾸면 두 테스트를 같이 고칠 것. */
const path = require('path');
const { loadOfflineGas } = require(path.join(__dirname, 'offline-gas.js'));
const J = JSON.stringify;
const TODAY = '2026-09-27';
const ADMIN = 'p_dh_3678@athomecorp.com', USER = 'member@athomecorp.com';
// ── 픽스처(각 탭 _offReadRows 모양) ──
const CHANNELS = [
  ['himart', '하이마트', '양판점', 'Y', 1, '2026-09'], ['etland', '전자랜드', '양판점', 'Y', 2, '2026-09'],
  ['emart', '이마트', '할인점', 'Y', 3, '2026-09'], ['traders', '트레이더스', '할인점', 'N', 4, '']];
const SKUS = [
  ['SKU-0001', '더 플렌더 MAX', '더플렌더', '더 플렌더 MAX', '', 'Y', '', ''],
  ['SKU-0002', '미니 건조기 PRO 그레이지', '미니건조기', '미니 건조기 PRO', '그레이지', 'Y', '', ''],
  ['SKU-0003', '더 슬림', '더슬림', '', '', 'N', '', '']]; // 비활성 SKU도 집계에는 쓴다
const MAP = (ch, code, sku, type, name) => [ch, code, sku, type, name || '', '2026-09-27', 'a', ''];
const MAPPINGS = [
  MAP('himart', 'MNFD-200G', 'SKU-0001', '정상'), MAP('himart', '(J)MNFD-200G', 'SKU-0001', '전시'), MAP('himart', 'MNFD-200G_R', 'SKU-0001', '리퍼'),
  MAP('himart', 'MNMD-110G', 'SKU-0002', '정상'), MAP('himart', 'MNVC-100G', 'SKU-0003', '정상'),
  MAP('himart', 'OLD', '', '정상', '옛 코드'), // 비활성화된 매핑 → 미매칭
  MAP('etland', 'MNFD-200G', 'SKU-0001', '정상'), MAP('etland', 'MNFD-200G.DEMO', 'SKU-0001', '전시')];
const SD = (d, ch, code, q) => [d, ch, code, q, '', '', 'U'];
const STOCK_DAILY = [
  SD('2026-09-23', 'himart', 'MNFD-200G', 999), // 예전 기준일 — 무시
  SD('2026-09-24', 'himart', 'MNFD-200G', 50), SD('2026-09-24', 'himart', '(J)MNFD-200G', 4), SD('2026-09-24', 'himart', 'MNFD-200G_R', 2),
  SD('2026-09-24', 'himart', 'MNMD-110G', 10), SD('2026-09-24', 'himart', 'MNVC-100G', 200), SD('2026-09-24', 'himart', 'COFFEE', 7), SD('2026-09-24', 'himart', 'OLD', 1),
  SD('2026-09-25', 'etland', 'MNFD-200G', 2), SD('2026-09-25', 'etland', 'MNFD-200G.DEMO', 1)];
const LOG = (type, ch, range) => ['U', '2026-09-27 10:00:00', 'a', 'f', type, ch, range, 1, 1, 0, '', '성공'];
const UPLOAD_LOG = [LOG('HIMART_SALES_STOCK', 'himart', '2026-09-24'), LOG('ETLAND_SALES', 'etland', '2026-09-01~2026-09-20'), LOG('ETLAND_STOCK', 'etland', '2026-09-25'),
  ['U', '', '', 'f', 'ETLAND_SALES', 'etland', '2026-09-01~2026-09-26', 1, 1, 0, '', '실패: x']]; // 실패 업로드는 기준일에 안 셈
const SL = (s, e, ch, store, code, q, inst) => [s, e, s === e ? 'day' : 'period', ch, store, code, q, inst == null ? '' : inst, 'upload', 'U'];
const SALES = [
  SL('2026-09-01', '2026-09-23', 'himart', 'S1', 'MNFD-200G', 20, 18), // period — 기간종료일이 창 안이라 통째로
  SL('2026-09-24', '2026-09-24', 'himart', 'S1', 'MNFD-200G', 8, 7),
  SL('2026-08-20', '2026-08-20', 'himart', 'S1', 'MNFD-200G', 100, 100), // 창(08-28~09-24) 밖
  SL('2026-09-25', '2026-09-25', 'himart', 'S1', 'MNFD-200G', 50, 50),   // 판매 최신 기준일(09-24) 뒤 — 창 밖
  SL('2026-09-10', '2026-09-10', 'himart', 'S3', 'MNMD-110G', 28, 28),
  SL('2026-09-15', '2026-09-15', 'himart', 'S1', 'MNVC-100G', 28, 28),
  SL('2026-09-24', '2026-09-24', 'himart', 'S4', 'COFFEE', 5),
  SL('2026-09-05', '2026-09-05', 'etland', 'E1', 'MNFD-200G', 3),
  SL('2026-09-19', '2026-09-19', 'etland', 'E2', 'MNFD-200G', 1)];
const SS = (d, ch, store, code, q, ms) => [d, ch, store, code, q, '', '', '', ms, 'U'];
const STOCK_STORE = [
  SS('2026-09-24', 'himart', 'S1', 'MNFD-200G', 3, 5), SS('2026-09-24', 'himart', 'S1', '(J)MNFD-200G', 1, 0),
  SS('2026-09-24', 'himart', 'S2', 'MNFD-200G', 0, 2),  // 팔렸는데 재고 0 → 점포 결품
  SS('2026-09-24', 'himart', 'S3', '(J)MNFD-200G', 1, 0), SS('2026-09-24', 'himart', 'S3', 'MNMD-110G', 0, 0),
  SS('2026-09-24', 'himart', 'S4', 'COFFEE', 7, 1),     // 미매칭 — 결품·점포 수에 안 셈
  SS('2026-09-24', 'himart', 'S5', 'MNVC-100G', 5, 0),
  SS('2026-09-25', 'etland', 'E2', 'MNFD-200G', 2, ''), SS('2026-09-25', 'etland', 'E3', 'MNFD-200G.DEMO', 1, '')]; // 당월판매 열 없음 → 원장
const STORES = ['S1', 'S2', 'S3', 'S4', 'S5'].map((s, i) => ['himart', s, s + '점', i < 2 ? '강남' : '강북', '', ''])
  .concat(['E1', 'E2', 'E3', 'E4'].map(s => ['etland', s, s + '점', '서울', '', '']));
const UNMATCHED_TAB = [['himart', 'COFFEE', '커피머신(타 브랜드)', '2026-09-27', '2026-09-27', 1]];

function compute(g, extra) {
  return g.ctx._offInventoryCompute(Object.assign({ today: TODAY, settingsRows: [], channels: CHANNELS, skus: SKUS, mappings: MAPPINGS, stores: STORES,
    sales: SALES, stockDaily: STOCK_DAILY, stockStore: STOCK_STORE, uploadLog: UPLOAD_LOG, unmatchedTab: UNMATCHED_TAB }, extra || {}));
}
const G = (res, ch, level, key) => res.groups.find(x => x.channelId === ch && x.level === level && x.key === (key || ''));
const near = (a, b) => a != null && Math.abs(a - b) < 1e-9;

// 세션·doPost — offline-api.test.js와 같은 방식
function session(ctx, email) {
  const sheet = ctx._sessionSheet(ctx.SpreadsheetApp.getActiveSpreadsheet());
  const now = Date.now(), sid = 'sid-' + Math.random().toString(36).slice(2);
  sheet.appendRow([sid, email, '사용자', now, now + 3600e3 * 12, now]);
  return ctx._signSessionToken({ sid, email, name: '사용자', exp: now + 3600e3 * 12, iat: now, kv: 1 });
}
function env() {
  const g = loadOfflineGas({ setup: true, today: TODAY });
  const T = g.ctx.OFF_TABS;
  const put = (key, rows) => { const sh = g.tab(T[key].name); if (key === 'channel') sh._grid.length = 1; g.ctx._offWriteBlock(sh, T[key], 2, rows); };
  put('channel', CHANNELS); put('sku', SKUS); put('mapping', MAPPINGS); put('store', STORES); put('sales', SALES);
  put('stockDaily', STOCK_DAILY); put('stockStore', STOCK_STORE); put('uploadLog', UPLOAD_LOG); put('unmatched', UNMATCHED_TAB);
  const tokens = { admin: session(g.ctx, ADMIN), user: session(g.ctx, USER) };
  g.call = (action, data, who) => JSON.parse(g.ctx.doPost({ postData: { contents: J({ action, session: tokens[who || 'user'], data }) }, parameter: {} }));
  return g;
}

module.exports = { TODAY, ADMIN, USER, CHANNELS, SKUS, MAPPINGS, STOCK_DAILY, UPLOAD_LOG, SALES, STOCK_STORE, STORES, UNMATCHED_TAB, compute, G, near, session, env };
