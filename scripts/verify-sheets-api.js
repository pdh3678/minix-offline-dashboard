/* Sheets API 도입(2026-10-02) 반영 전후 대조 — 로컬 확인용(테스트 아님, 데이터 파일은 커밋하지 않는다). 출력은 합계·건수·호출 수뿐이다.
   바꾸기 전 GAS(git BEFORE_REF — SpreadsheetApp만)와 지금 GAS(Sheets API, tests/lib/offline-gas.js 목)를 각각 새 목 시트에 띄워 같은 순서로 돌린다:
   setup → samples/ 실파일을 브라우저와 같은 경로로 반영 → 이마트 일별상세 재반영(멱등) → 확인용 코드매핑·목표·단가(대조용 고정값) → 조회(캐시 없이)

   ① 반영 파일별 행 수 · 서비스 호출 수(전 = SpreadsheetApp 호출, 후 = Sheets API 호출 + SpreadsheetApp 호출)
   ② 같은 파일 재반영 — 판매원장 행 수 그대로(멱등)
   ③ 모든 탭 값·텍스트 서식 범위가 칸 단위로 같은지
   ④ 채널별 9월 IN·OUT·재고 전후
   ⑤ 파트 홈 채널군 9월·연 누적 전후
   ⑥ 판매 분석(채널별 9월 모델별·지점별) 합계 전후
   ⑦ 조회 액션별 서비스 호출 수(캐시 없음) 전후 · 응답이 같은지

   서비스 호출 수는 왕복 수의 근사다 — SpreadsheetApp 쓰기(setValues·서식·clearContent)는 실제로는 몰아서 보내지므로 쓰기 쪽 "전" 값은
   실제 왕복보다 크게 나온다. 읽기(getSheetByName·getLastRow·getValues)는 호출마다 왕복이다. 실제 시간은 운영에서 잰다(offline_benchmarkReads·브라우저).

   실행: XLSX_PATH=<SheetJS 모듈 경로> [BEFORE_REF=39f94f1] node scripts/verify-sheets-api.js [samples 폴더] */
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const PROJ = path.join(__dirname, '..');
const { loadOfflineGas, dataRows } = require(path.join(PROJ, 'tests', 'lib', 'offline-gas.js'));
const P = require(path.join(PROJ, 'src', 'features', 'offline', 'parsers.js'));
const R = require(path.join(PROJ, 'src', 'features', 'offline', 'resolver.js'));
let XLSX;
try { XLSX = require(process.env.XLSX_PATH || 'xlsx'); } catch (e) { console.error('SheetJS가 없습니다. XLSX_PATH=<xlsx 모듈 경로> 로 실행하세요.'); process.exit(2); }
const SAMPLES = process.argv[2] || path.join(PROJ, 'samples');
const REF = process.env.BEFORE_REF || '39f94f1';
const TODAY = '2026-09-30', YM = '2026-09', AUTH = { email: 'verify@local' };
const GAS_FILES = ['apps-script.js', 'apps-script-offline.js', 'apps-script-offline-targets.js', 'apps-script-offline-inventory.js', 'apps-script-home.js'];
const J = JSON.stringify;
const won = v => (v == null ? '—' : Math.round(v).toLocaleString('ko-KR'));
const ok = b => (b ? 'OK' : '불일치');

const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetsapi-before-'));
GAS_FILES.forEach(f => fs.writeFileSync(path.join(oldDir, f), cp.execFileSync('git', ['show', REF + ':' + f], { cwd: PROJ, maxBuffer: 64 << 20 })));

const files = fs.readdirSync(SAMPLES).filter(f => /\.(xlsx|xls|csv)$/i.test(f)).map(f => ({ f, rows: P.dropUnusedColumns(P.readWorkbookRows(XLSX, fs.readFileSync(path.join(SAMPLES, f))).rows) }));

// SpreadsheetApp 호출을 센다 — 오프라인 목 스프레드시트(openById·getSheetByName)와 탭마다(getLastRow·getMaxRows·insertRowsAfter·getRange의 값·서식 호출)
function instrument(g) {
  const c = { ssa: 0, cells: 0 };
  const bump = n => { c.ssa++; c[n] = (c[n] || 0) + 1; };
  const open = global.SpreadsheetApp.openById;
  global.SpreadsheetApp.openById = id => { bump('openById'); return open(id); };
  const gsn = g.off.getSheetByName;
  g.off.getSheetByName = n => { bump('getSheetByName'); return gsn(n); };
  Object.keys(g.off._sheets).forEach(n => {
    const sh = g.off._sheets[n], lr = sh.getLastRow, mr = sh.getMaxRows, ins = sh.insertRowsAfter.bind(sh), gr = sh.getRange;
    sh.getLastRow = () => { bump('getLastRow'); return lr(); };
    sh.getMaxRows = () => { bump('getMaxRows'); return mr(); };
    sh.insertRowsAfter = (a, k) => { bump('insertRowsAfter'); return ins(a, k); };
    sh.getRange = (r, col, nr, nc) => {
      const api = gr(r, col, nr, nc);
      ['getValues', 'setValues', 'setNumberFormat', 'clearContent'].forEach(m => {
        const f = api[m];
        api[m] = (...a) => { bump(m); if (m === 'getValues') c.cells += (nr || 1) * (nc || 1); return f.apply(api, a); };
      });
      return api;
    };
  });
  const flush = global.SpreadsheetApp.flush;
  global.SpreadsheetApp.flush = () => { bump('flush'); return flush(); };
  return () => ({ ssa: c.ssa, api: g.api ? g.api.calls.length : 0, apiOps: g.api ? g.api.calls.map(x => x.op) : [], detail: Object.assign({}, c) });
}
const delta = (a, b) => ({ ssa: b.ssa - a.ssa, api: b.api - a.api, ops: b.apiOps.slice(a.apiOps.length) });

function run(label, dir) {
  const g = loadOfflineGas({ dir, setup: true, today: TODAY });
  let uuid = 0;
  g.ctx.Utilities.getUuid = () => String(++uuid).padStart(4, '0') + '-uuid';
  const fmt = g.ctx.Utilities.formatDate; // 업로드 시각·upload_id 고정 — 전후 시트를 칸 단위로 비교하려고
  g.ctx.Utilities.formatDate = (d, tz, f) => (Math.abs(d.getTime() - Date.now()) < 3600000 ? fmt(new Date('2026-09-30T10:20:30+09:00'), tz, f) : fmt(d, tz, f));
  const T = g.ctx.OFF_TABS, read = k => g.ctx._offReadRows(g.tab(T[k].name), T[k]);
  const append = (k, rows) => { if (rows.length) g.ctx._offWriteBlock(g.tab(T[k].name), T[k], g.tab(T[k].name).getLastRow() + 1, rows); };
  const counts = instrument(g);
  const call = (action, data) => { const o = JSON.parse(g.ctx._offlineHandle(action, data || {}, AUTH)); delete o.execMs; delete o.version; return o; };
  const out = { uploads: [], reads: {}, res: {} };

  // 1) 실파일 반영 — 브라우저와 같은 경로·순서(이마트 점포별 일별 매출 먼저, 하이마트는 기준일 오름차순 맨 뒤)
  const offsets = {};
  read('channel').forEach(r => { if (Number(r[9])) offsets[r[0]] = Number(r[9]); });
  const parsed = files.map(x => ({ f: x.f, p: P.parseRows(x.rows, { fileName: x.f, today: TODAY, stockOffsets: offsets }) })).filter(x => x.p.ok && !x.p.blocked);
  const rank = x => (x.p.split === 'biz' ? 0 : x.p.channelId === 'himart' ? 2 : 1);
  parsed.sort((a, b) => (rank(a) - rank(b)) || String(a.p.baseDate || '').localeCompare(String(b.p.baseDate || '')));
  const up = x => {
    const c0 = counts();
    const res = call('offline_upload', P.toUploadPayload(x.p, { fileName: x.f }));
    if (res.error) throw new Error(label + ' 반영 실패 ' + x.f + ': ' + res.error);
    return { f: x.f, type: x.p.type, res, calls: delta(c0, counts()), salesRows: dataRows(g.tab('판매원장')).length };
  };
  parsed.forEach(x => out.uploads.push(up(x)));
  // 2) 같은 파일 재반영(멱등)
  const emart = parsed.find(x => x.p.type === 'EMART_DAILY_SALES_STORE');
  out.again = emart ? up(emart) : null;

  // 3) 확인용 코드매핑(모델명 → 카탈로그 모델)·목표·단가 — 전후 같은 값이므로 실제 값일 필요는 없다
  const MODEL = { 'MNFD-200G': ['더플렌더', '더 플렌더 MAX'], 'MNFD-300G': ['더플렌더', '더 플렌더 mini'], 'MNFD-120G': ['더플렌더', '더 플렌더 PRO'], 'MNKR-100G': ['더시프트', '더 시프트'],
    'MNMD-200G': ['더에어드라이', '더 에어드라이'], 'MNMD-110G': ['미니건조기', '미니 건조기 PRO'], 'MNMD-120G': ['미니건조기', '미니 건조기 PRO+'], 'MNVC-100G': ['더슬림', '더 슬림'],
    'MNDW-110G': ['미니식기세척기', '미니 식기세척기 PRO'], 'MNDW-110OB': ['미니식기세척기', '미니 식기세척기 PRO'], 'MNDW-110CG': ['미니식기세척기', '미니 식기세척기 PRO'] };
  const skuOf = {}, skuRows = [], mapRows = [];
  read('unmatched').forEach(u => {
    const m = MODEL[R.extractModel(u[1]) || R.extractModel(u[2])];
    if (!m) return;
    const k = m.join('|');
    if (!skuOf[k]) { skuOf[k] = 'SKU-' + (9001 + skuRows.length); skuRows.push([skuOf[k], m[1], m[0], m[1], '', 'Y', '', '대조용']); }
    mapRows.push([u[0], u[1], skuOf[k], R.guessStockType(u[1], u[2]), u[2], TODAY, 'verify', '대조용']);
  });
  append('sku', skuRows);
  append('mapping', mapRows);
  const chRows = read('channel').filter(r => r[0]), models = skuRows.map(s => [s[2], s[3]]);
  append('prices', [].concat(...chRows.map((c, i) => models.map(([line, model], j) => [c[0], line, model, 100000 + 1000 * i + 10 * j, '2026-01-01', '대조용', TODAY, 'verify']))));
  append('targets', [].concat(...['2026-08', YM].map(ym => [].concat(...chRows.map(c => [].concat(...models.map(([line, model]) => [
    [ym, c[0], line, model, 'IN', 10, 7, 'input', TODAY, 'verify', '대조용', g.ctx.OFFLINE_LINE_CATEGORY[line]],
    [ym, c[0], line, model, 'OUT', 9, '', 'input', TODAY, 'verify', '대조용', g.ctx.OFFLINE_LINE_CATEGORY[line]]])))))));
  out.mapped = mapRows.length; out.skus = skuRows.length;

  // 4) 조회 — 매번 캐시 세대를 바꿔 시트를 읽게 한다(파트 홈을 먼저: 안에서 부르는 월별·재고 캐시가 비어 있게)
  const reads = [['home_getSummary', { ym: YM, mode: 'month' }], ['home_getSummary(ytd)', { ym: YM, mode: 'ytd' }], ['offline_getMonthly', { from: '2026-01', to: '2026-12', totalsOnly: true }],
    ['offline_getMonthly(himart)', { from: '2026-01', to: '2026-12', channelId: 'himart' }], ['offline_getInventory', {}], ['offline_getInventory(himart)', { channelId: 'himart' }],
    ['offline_getMasters', {}], ['offline_getStatus', {}], ['offline_getUnmatched', {}], ['offline_getUploadLog', {}]]
    .concat(chRows.map(c => ['offline_getSalesBreakdown(' + c[0] + ')', { channelId: c[0], from: YM, to: YM }]));
  reads.forEach(([name, data]) => {
    g.ctx._offInvalidateCache();
    const c0 = counts();
    out.res[name] = call(name.replace(/\(.*\)$/, ''), data);
    out.reads[name] = delta(c0, counts());
  });
  const tabs = {}, formats = {};
  g.off._order.forEach(n => { tabs[n] = J(g.tab(n)._grid); formats[n] = J(g.tab(n)._formats); });
  out.tabs = tabs; out.formats = formats; out.channels = chRows;
  return out;
}

const before = run('전', oldDir);
const after = run('후', PROJ); // 앞 env의 시트는 여기서 끝 — loadOfflineGas는 같은 전역을 쓴다
fs.rmSync(oldDir, { recursive: true, force: true });
const name = id => (after.channels.find(r => r[0] === id) || [])[1] || id;

console.log('바꾸기 전 GAS = ' + REF + ' (SpreadsheetApp) · 지금 GAS = 작업 폴더 (Sheets API 목)');
console.log('\n① 반영 파일별 — 행 수 · 서비스 호출 수');
console.table(after.uploads.map((u, i) => {
  const b = before.uploads[i];
  return { 파일: u.f.slice(0, 38), 채널: u.res.channels.join(','), 판매행: u.res.applied.sales == null ? '' : u.res.applied.sales, 재고행: u.res.applied.stockDaily == null ? '' : u.res.applied.stockDaily,
    '호출 전(SpreadsheetApp)': b.calls.ssa, '호출 후(API+SSA)': u.calls.api + '+' + u.calls.ssa, '후 API 내역': u.calls.ops.join(' '), 결과: ok(J(u.res) === J(b.res)) };
}));
if (after.again) {
  const a = after.again, b = before.again, prev = after.uploads[after.uploads.length - 1].salesRows;
  console.log('\n② 같은 파일 재반영(' + a.f + ') — 판매원장 ' + prev + '행 → ' + a.salesRows + '행 (바꾸기 전 코드: ' + b.salesRows + '행), 지운 ' + a.res.applied.salesRemoved + ' = 넣은 ' + a.res.applied.sales +
    ' : ' + ok(a.salesRows === prev && a.res.applied.salesRemoved === a.res.applied.sales && a.salesRows === b.salesRows) +
    ' · 호출 전 ' + b.calls.ssa + ' / 후 ' + a.calls.api + '+' + a.calls.ssa);
}
const tabDiff = Object.keys(after.tabs).filter(n => after.tabs[n] !== before.tabs[n]), fmtDiff = Object.keys(after.formats).filter(n => after.formats[n] !== before.formats[n]);
console.log('\n③ 모든 탭(' + Object.keys(after.tabs).length + '개) 값 칸 단위 같음: ' + ok(!tabDiff.length) + (tabDiff.length ? ' — 다른 탭 ' + tabDiff.join(', ') : '') +
  ' · 텍스트 서식 범위 같음: ' + ok(!fmtDiff.length) + (fmtDiff.length ? ' — 다른 탭 ' + fmtDiff.join(', ') : '') + ' (확인용 매핑 ' + after.mapped + '건, SKU ' + after.skus + '개)');

console.log('\n④ 채널별 9월 IN·OUT·재고 — 전후 (값은 후)');
const monA = after.res['offline_getMonthly'], monB = before.res['offline_getMonthly'], invA = after.res['offline_getInventory'], invB = before.res['offline_getInventory'];
const chNums = (mon, inv, id) => {
  const t = mon.totals.byChannelMonth.find(x => x.ym === YM && x.channelId === id) || { in: {}, out: {} };
  const gr = inv.groups.find(x => x.channelId === id && x.level === 'channel') || { stock: {} };
  return { inT: t.in.target, inA: t.in.actual, inAA: t.in.actualAmount, outT: t.out.target, outA: t.out.actual, outAA: t.out.actualAmount, 정상: gr.stock['정상'], 전체: gr.total, 판매N일: gr.windowQty, 재고일수: gr.days };
};
console.table(after.channels.map(c => {
  const a = chNums(monA, invA, c[0]), b = chNums(monB, invB, c[0]);
  return { 채널: c[1], 'IN 목표/실적': (a.inT == null ? '—' : a.inT) + ' / ' + (a.inA == null ? '—' : a.inA), 'IN 실적금액': won(a.inAA), 'OUT 목표/실적': (a.outT == null ? '—' : a.outT) + ' / ' + (a.outA == null ? '—' : a.outA),
    'OUT 실적금액': won(a.outAA), 정상재고: a.정상 == null ? '—' : a.정상, 재고일수: a.재고일수 == null ? '—' : Math.round(a.재고일수 * 10) / 10, 결과: ok(J(a) === J(b)) };
}));
console.log('월별 해석 합계 전체(1~12월) 같음: ' + ok(J(monA.totals) === J(monB.totals)) + ' · 재고 지표 전체 같음: ' + ok(J(invA) === J(invB)));

console.log('\n⑤ 파트 홈 채널군 — 9월(월)·1~9월(연 누적) 목표·실적 금액 전후');
const grp = (s, k) => s.range.reduce((a, ym) => ({ t: a.t + (s.series[k][ym].target || 0), a: a.a + (s.series[k][ym].actual || 0) }), { t: 0, a: 0 });
const L = { offline: '오프라인', closed: '특수', gongu: '공동구매' };
console.table(['offline', 'closed', 'gongu'].map(k => {
  const a = { 월: grp(after.res.home_getSummary, k), 연: grp(after.res['home_getSummary(ytd)'], k) }, b = { 월: grp(before.res.home_getSummary, k), 연: grp(before.res['home_getSummary(ytd)'], k) };
  return { 채널군: L[k], '9월 목표': won(a.월.t), '9월 실적': won(a.월.a), '연누적 목표': won(a.연.t), '연누적 실적': won(a.연.a), 결과: ok(J(a) === J(b)) };
}));
console.log('파트 홈 응답 전체 같음 — 월 ' + ok(J(after.res.home_getSummary) === J(before.res.home_getSummary)) + ' · 연 누적 ' + ok(J(after.res['home_getSummary(ytd)']) === J(before.res['home_getSummary(ytd)'])));

console.log('\n⑥ 판매 분석 — 채널별 9월(모델별 합계 = 지점별 합계)');
console.table(after.channels.map(c => {
  const k = 'offline_getSalesBreakdown(' + c[0] + ')', a = after.res[k], b = before.res[k];
  return { 채널: c[1], 판매량: a.totals.qty, 미매칭: a.totals.unmatchedQty, 모델수: a.keys.length, 지점수: a.stores.length, '지점 합': a.stores.reduce((s, x) => s + x.total, 0), 결과: ok(J(a) === J(b)) };
}));

console.log('\n⑦ 조회 액션별 서비스 호출 수(캐시 없음) — 전 = SpreadsheetApp, 후 = Sheets API + SpreadsheetApp');
console.table(Object.keys(after.reads).filter(k => !/SalesBreakdown\((?!himart|emart)/.test(k)).map(k => ({
  액션: k, '전': before.reads[k].ssa, '후 API': after.reads[k].api, '후 SSA': after.reads[k].ssa, 응답: ok(J(after.res[k]) === J(before.res[k])) })));
const allSame = Object.keys(after.res).every(k => J(after.res[k]) === J(before.res[k]));
console.log('조회 응답 ' + Object.keys(after.res).length + '개 모두 같음: ' + ok(allSame));
process.exit(allSame && !tabDiff.length && !fmtDiff.length ? 0 : 1);
