/* 코드 제외·ERP 제외 브랜드 — samples 실파일 대조 (2026-10-07). 로컬 확인용(테스트 아님, 데이터 파일은 커밋하지 않는다). 출력은 코드·건수·합계뿐이다.
   ① 브랜드 규칙을 끈 채(ERP_제외브랜드 빈칸 — 기능 전 운영 모양) 실파일 전부를 수동 업로드 경로로 반영 → 톰 코드가 미매칭에 있는지
   ② 톰 코드 4개를 코드 매핑 화면처럼 제외(offline_saveExcluded) → 미매칭 목록에서 사라지는지 · 본품 합계(월별 OUT 실적·대분류)·파트 홈·재고 숫자가 같은지 · 원장 그대로
   ③ 해제 → 다시 미매칭에 나타나고 모든 조회가 제외 전과 같은지
   ④ ERP 실파일 미리보기의 "제외 브랜드 n행" · 기본 설정(톰)으로 새로 반영하면 톰 상품은 브랜드 규칙으로 제외되고 미매칭에 뜨지 않는지

   실행: XLSX_PATH=<SheetJS 모듈 폴더> node scripts/verify-exclude.js [samples 폴더] */
const fs = require('fs'), path = require('path');
const PROJ = path.join(__dirname, '..');
const { loadOfflineGas, dataRows } = require(path.join(PROJ, 'tests', 'lib', 'offline-gas.js'));
const { session } = require(path.join(PROJ, 'tests', 'lib', 'offline-2b-fixture.js'));
const P = require(path.join(PROJ, 'src', 'features', 'offline', 'parsers.js'));
let XN;
try { XN = require(path.dirname(require.resolve(path.join(process.env.XLSX_PATH || 'xlsx', 'package.json')))); } catch (e) { console.error('SheetJS가 없습니다. XLSX_PATH=<xlsx 모듈 폴더> 로 실행하세요.'); process.exit(2); }
const SAMPLES = process.argv[2] || path.join(PROJ, 'samples');
const TODAY = '2026-10-07', EMAIL = 'verify@athomecorp.com', J = JSON.stringify, ok = b => (b ? 'OK' : '불일치');
const TOM = ['9812365001318', '9812365001360', '9812365001201', '9812365001362'];
const files = fs.readdirSync(SAMPLES).filter(f => /\.(xlsx|xls)$/i.test(f) && f.indexOf('~$') !== 0).sort()
  .map(f => ({ name: f, rows: P.dropUnusedColumns(P.readWorkbookRows(XN, new Uint8Array(fs.readFileSync(path.join(SAMPLES, f)))).rows) }));

function env(brands) {
  const g = loadOfflineGas({ setup: true, today: TODAY });
  const tok = session(g.ctx, EMAIL);
  g.call = (action, data) => { const r = JSON.parse(g.ctx.doPost({ postData: { contents: J({ action, session: tok, data: data || {} }) }, parameter: {} })); if (r.error) throw new Error(action + ': ' + r.error); return r; };
  if (brands != null) g.tab('설정')._grid.forEach(r => { if (r[0] === 'ERP_제외브랜드') r[1] = brands; });
  const offsets = {};
  g.ctx._offReadRows(g.tab('채널마스터'), g.ctx.OFF_TABS.channel).forEach(r => { const o = g.ctx._offStockOffsetOf(r); if (r[0] && o) offsets[r[0]] = o; });
  g.results = files.map(f => {
    const p = P.parseRows(f.rows, { fileName: f.name, today: TODAY, stockOffsets: offsets });
    if (!p.ok || p.blocked) return { name: f.name, skipped: p.ok ? '반영하지 않는 양식' : p.error };
    // 거래처매핑에 없는 거래처는 보류 그대로(미리보기에서 고르지 않은 상태)
    return Object.assign({ name: f.name, type: p.type }, g.ctx._offUpload(P.toUploadPayload(p, { fileName: f.name }), { email: EMAIL }));
  });
  return g;
}
const strip = o => { const c = JSON.parse(J(o)); delete c.cached; delete c.execMs; delete c.version; return c; };
function snap(g) {
  g.ctx._offInvalidateCache();
  return {
    monthly: strip(g.call('offline_getMonthly', { from: '2026-01', to: '2026-12' })),
    inv: strip(g.call('offline_getInventory', {})),
    home: strip(g.call('home_getSummary', { ym: '2026-09', mode: 'ytd' })),
    homeOct: strip(g.call('home_getSummary', { ym: '2026-10', mode: 'month' })),
    un: strip(g.call('offline_getUnmatched', {}))
  };
}
const outActual = s => s.monthly.totals.byMonth.reduce((a, m) => a + (Number(m.out.actual) || 0), 0);
const unQty = s => s.monthly.totals.byMonth.reduce((a, m) => a + (Number(m.out.unmatchedQty) || 0), 0);
const homeQty = s => s.home.categorySales.reduce((a, c) => a + (Number(c.offline.qty) || 0) + (Number(c.closed.qty) || 0), 0);
const ledger = g => J(['판매원장', '재고_채널일별', '재고_점포최신'].map(n => dataRows(g.tab(n))));

// ① 브랜드 규칙 끔
const g = env('');
console.log('① 브랜드 규칙을 끈 채 실파일 ' + files.length + '개 반영');
console.table(g.results.map(r => ({ 파일: r.name.slice(0, 44), 결과: r.skipped ? '건너뜀: ' + r.skipped : '반영', 미매칭: r.unmatched ? r.unmatched.length : '' })));
// 빈 시트라 매핑이 없다 — 톰이 아닌 미매칭 코드의 절반을 본품 SKU에 매핑해 본품 합계·파트 홈 숫자가 0이 아니게 한다(나머지 절반은 미매칭으로 둔다)
g.ctx._offWriteBlock(g.tab('제품마스터'), g.ctx.OFF_TABS.sku, 2, [['SKU-0001', '더 플렌더 MAX', '더플렌더', '더 플렌더 MAX', '', 'Y', '', '']]);
const toMap = g.call('offline_getUnmatched').items.filter(u => TOM.indexOf(u.code) < 0).filter((u, i) => i % 2 === 0);
g.call('offline_saveMapping', { items: toMap.map(u => ({ op: 'upsert', channelId: u.channelId, code: u.code, skuId: 'SKU-0001', stockType: '정상', name: u.name })) });
const s0 = snap(g), l0 = ledger(g);
const inUn = TOM.filter(c => s0.un.items.some(u => u.code === c));
console.log('톰 외 미매칭 코드 ' + toMap.length + '개를 본품 SKU에 매핑 → 미매칭 목록 ' + s0.un.items.length + '건 — 톰 코드 4개 중 목록에 있는 것: ' + inUn.length + '개 (' + inUn.join(', ') + ')');

// ② 제외
const items = TOM.map(code => ({ op: 'exclude', channelId: 'erp', code }));
const r = g.call('offline_saveExcluded', { items });
const s1 = snap(g);
const gone = TOM.every(c => !s1.un.items.some(u => u.code === c));
console.log('\n② 톰 코드 4개 제외(offline_saveExcluded) → 제외 ' + r.excluded + '건');
console.table([
  { 항목: '미매칭 목록', 제외전: s0.un.items.length, 제외후: s1.un.items.length, 결과: ok(gone && s1.un.items.length === s0.un.items.length - inUn.length) + ' (톰 4개 사라짐)' },
  { 항목: '월별 OUT 실적(매핑된 코드, 1~12월 합)', 제외전: outActual(s0), 제외후: outActual(s1), 결과: ok(outActual(s0) === outActual(s1)) },
  { 항목: '월별 대분류별 실적', 제외전: '', 제외후: '', 결과: ok(J(s0.monthly.totals.byCategory) === J(s1.monthly.totals.byCategory)) },
  { 항목: '미매칭 판매 수량(1~12월)', 제외전: unQty(s0), 제외후: unQty(s1), 결과: unQty(s1) <= unQty(s0) ? '톰 판매만큼 감소' : '불일치' },
  { 항목: '파트 홈 대분류별 판매(9월 누적)', 제외전: homeQty(s0), 제외후: homeQty(s1), 결과: ok(J(s0.home.categorySales) === J(s1.home.categorySales) && J(s0.home.series) === J(s1.home.series)) },
  { 항목: '파트 홈 10월', 제외전: '', 제외후: '', 결과: ok(J(s0.homeOct.categorySales) === J(s1.homeOct.categorySales) && J(s0.homeOct.series) === J(s1.homeOct.series)) },
  { 항목: '파트 홈 미매칭 카드', 제외전: s0.home.today.unmatched, 제외후: s1.home.today.unmatched, 결과: ok(s1.home.today.unmatched === s0.home.today.unmatched - inUn.length) },
  { 항목: '재고 지표(경보·그룹)', 제외전: '', 제외후: '', 결과: ok(J(s0.inv.groups) === J(s1.inv.groups)) },
  { 항목: '판매원장·재고 원본 행', 제외전: '', 제외후: '', 결과: ok(ledger(g) === l0) + ' (삭제 없음)' }
]);

// ③ 해제
g.call('offline_saveExcluded', { items: TOM.map(code => ({ op: 'include', channelId: 'erp', code })) });
const s2 = snap(g);
const backAll = inUn.every(c => s2.un.items.some(u => u.code === c));
const same = ['monthly', 'inv', 'home', 'homeOct'].filter(k => J(s2[k]) !== J(s0[k]));
console.log('\n③ 해제 → 톰 코드 미매칭에 다시: ' + ok(backAll) + ' · 월별·재고·파트 홈이 제외 전과 같음: ' + ok(!same.length) + (same.length ? ' (' + same.join(', ') + ')' : '') +
  ' · 제외코드 탭 ' + dataRows(g.tab('제외코드')).length + '행');

// ④ 기본 설정(톰) — 미리보기 "제외 브랜드 n행"과 브랜드 규칙 자동 등록
console.log('\n④ ERP 실파일 — 미리보기 제외 브랜드(설정 기본값 톰)');
files.filter(f => /매출이익리스트/.test(f.name)).forEach(f => {
  const p = P.parseRows(f.rows, { fileName: f.name, today: TODAY });
  const xb = p.summary.brands.filter(b => P.brandExcluded(b.brand, ['톰']));
  const codes = Object.keys(p.summary.products).filter(c => P.brandExcluded(p.summary.products[c].brand, ['톰']));
  console.log('  ' + f.name.slice(0, 44) + ' — 제외 브랜드(톰) ' + xb.reduce((a, b) => a + b.rows, 0) + '행 · 수량 ' + xb.reduce((a, b) => a + b.qty, 0) + ' · 상품코드 ' + codes.length + '종 [' + codes.join(', ') + '] · 브랜드: ' + xb.map(b => b.brand).join(', '));
});
const d = env(null);
const xs = dataRows(d.tab('제외코드'));
const un = d.call('offline_getUnmatched').items;
const tomUn = un.filter(u => xs.some(x => x[1] === u.code) || TOM.indexOf(u.code) >= 0);
console.log('  기본 설정으로 새로 반영 → 제외코드(브랜드 규칙) ' + xs.length + '행 [' + xs.map(x => x[1]).join(', ') + '] · 사유 모두 브랜드 규칙: ' + ok(xs.length && xs.every(x => x[3] === '브랜드 규칙')) +
  ' · 미매칭 목록에 톰 코드: ' + tomUn.length + '개 : ' + ok(!tomUn.length) + ' · 톰 코드 4개 모두 등록: ' + ok(TOM.every(c => xs.some(x => x[1] === c))));
const all = gone && outActual(s0) === outActual(s1) && J(s0.home.categorySales) === J(s1.home.categorySales) && ledger(g) === l0 && backAll && !same.length && !tomUn.length;
console.log(all ? '\n모두 맞음' : '\n⚠ 다른 곳이 있음');
process.exit(all ? 0 : 1);
