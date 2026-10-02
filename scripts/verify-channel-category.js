/* 채널 대분류 도입(2026-10-02) 반영 전후 대조 — 로컬 확인용(테스트 아님, 데이터 파일은 커밋하지 않는다). 출력은 합계·건수뿐이다.
   운영 순서를 그대로 흉내 낸다: 바꾸기 전 GAS(git BEFORE_REF)로 setup → samples/ 실파일을 브라우저와 같은 경로로 반영 → 확인용 코드매핑·목표·단가
   → 숫자(전) → 같은 목 시트에 새 GAS를 붙여넣고 offline_setupSheets(유형 → 채널대분류·채널별칭·신세계백화점) → 숫자(후).
   목표·단가는 실제 값이 아니라 대조용 고정값이다(IN 목표·실적·금액이 비지 않게). 코드매핑은 모델명(MN 코드) → 카탈로그 모델만.

   실행: XLSX_PATH=<SheetJS 모듈 경로> [BEFORE_REF=8f8a2e5] node scripts/verify-channel-category.js [samples 폴더]
   ① 채널마스터 반영 결과(유형 → 채널대분류·채널명·별칭)
   ② 채널별 9월 IN·OUT(목표·실적 수량·금액)·재고(정상·전시·리퍼·최근 판매·재고일수·진열 점포·점포 결품) 전후
   ③ 파트 홈 채널군 9월·연 누적(목표·실적) 전후 · 채널 표 합 = 채널군 · 채널대분류 소계 = 소속 채널 합
   ④ 데이터 현황(판매·재고 마지막 기준일·빈 날짜) 전후
   ⑤ 진행현황 이관 미리보기 — 원본 채널명 '신세계' → shinsegae(신세계백화점) */
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), cp = require('child_process');
const PROJ = path.join(__dirname, '..');
const { loadOfflineGas } = require(path.join(PROJ, 'tests', 'lib', 'offline-gas.js'));
const P = require(path.join(PROJ, 'src', 'features', 'offline', 'parsers.js'));
const R = require(path.join(PROJ, 'src', 'features', 'offline', 'resolver.js'));
let XLSX;
try { XLSX = require(process.env.XLSX_PATH || 'xlsx'); } catch (e) { console.error('SheetJS가 없습니다. XLSX_PATH=<xlsx 모듈 경로> 로 실행하세요.'); process.exit(2); }
const SAMPLES = process.argv[2] || path.join(PROJ, 'samples');
const REF = process.env.BEFORE_REF || '8f8a2e5';
const TODAY = '2026-09-30', YM = '2026-09', AUTH = { email: 'verify@local' };
const GAS_FILES = ['apps-script.js', 'apps-script-offline.js', 'apps-script-offline-targets.js', 'apps-script-offline-inventory.js', 'apps-script-home.js'];
const J = JSON.stringify;
const won = v => (v == null ? '—' : Math.round(v).toLocaleString('ko-KR'));
const ok = b => (b ? 'OK' : '불일치');

// 0) 바꾸기 전 GAS — git show REF:파일 → 임시 폴더
const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chcat-before-'));
GAS_FILES.forEach(f => fs.writeFileSync(path.join(oldDir, f), cp.execFileSync('git', ['show', REF + ':' + f], { cwd: PROJ, maxBuffer: 64 << 20 })));

// 1) 바꾸기 전 GAS로 setup — 운영과 같은 채널마스터(11열, C열 '유형', 채널명 '신세계')
const g = loadOfflineGas({ dir: oldDir, setup: true, today: TODAY });
let uuid = 0;
g.ctx.Utilities.getUuid = () => String(++uuid).padStart(4, '0') + '-uuid'; // 업로드마다 다른 upload_id
const def = k => g.ctx.OFF_TABS[k];
const read = k => g.ctx._offReadRows(g.tab(def(k).name), def(k));
const append = (k, rows) => { if (rows.length) g.ctx._offWriteBlock(g.tab(def(k).name), def(k), g.tab(def(k).name).getLastRow() + 1, rows); };
console.log('바꾸기 전 GAS = ' + REF + ' · 채널마스터 머리 ' + J(g.tab('채널마스터')._grid[0].filter(Boolean)));

// 2) 실파일 반영 — 브라우저와 같은 경로·순서(이마트 점포별 일별 매출 먼저, 하이마트는 기준일 오름차순 맨 뒤)
const offsets = {};
read('channel').forEach(r => { if (Number(r[9])) offsets[r[0]] = Number(r[9]); });
const files = fs.readdirSync(SAMPLES).filter(f => /\.(xlsx|xls|csv)$/i.test(f)).map(f => {
  const rows = P.dropUnusedColumns(P.readWorkbookRows(XLSX, fs.readFileSync(path.join(SAMPLES, f))).rows);
  return { f, p: P.parseRows(rows, { fileName: f, today: TODAY, stockOffsets: offsets }) };
});
const skipped = files.filter(x => !x.p.ok || x.p.blocked).map(x => x.f + ' (' + (x.p.blocked ? '반영 불가 양식' : x.p.error) + ')');
const rank = x => (x.p.split === 'biz' ? 0 : x.p.channelId === 'himart' ? 2 : 1);
const queue = files.filter(x => x.p.ok && !x.p.blocked).sort((a, b) => (rank(a) - rank(b)) || String(a.p.baseDate || '').localeCompare(String(b.p.baseDate || '')));
console.log('\n반영한 파일');
console.table(queue.map(x => {
  const res = g.ctx._offUpload(P.toUploadPayload(x.p, { fileName: x.f }), AUTH);
  return { 파일: x.f.slice(0, 40), 유형: x.p.type, 채널: res.channels.join(','), 판매행: res.applied.sales == null ? '' : res.applied.sales, 재고행: res.applied.stockDaily == null ? '' : res.applied.stockDaily, 미매칭: res.unmatched.length };
}));
if (skipped.length) console.log('건너뜀: ' + skipped.join(' · '));

// 3) 확인용 코드매핑(모델명 → 카탈로그 모델) · 목표 · 단가 — 전후 같은 값이므로 실제 값일 필요는 없다
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
const chRows = read('channel').filter(r => r[0]);
const models = skuRows.map(s => [s[2], s[3]]);
append('prices', [].concat(...chRows.map((c, i) => models.map(([line, model], j) => [c[0], line, model, 100000 + 1000 * i + 10 * j, '2026-01-01', '대조용', TODAY, 'verify']))));
append('targets', [].concat(...['2026-08', YM].map(ym => [].concat(...chRows.map(c => [].concat(...models.map(([line, model]) => [
  [ym, c[0], line, model, 'IN', 10, 7, 'input', TODAY, 'verify', '대조용', g.ctx.OFFLINE_LINE_CATEGORY[line]],
  [ym, c[0], line, model, 'OUT', 9, '', 'input', TODAY, 'verify', '대조용', g.ctx.OFFLINE_LINE_CATEGORY[line]]])))))));
console.log('확인용 매핑 ' + mapRows.length + '건(SKU ' + skuRows.length + '개) · 미매칭으로 남은 코드 ' + (read('unmatched').length - mapRows.length) + '건 · 목표·단가 = 대조용 고정값');

// 숫자 모음 — 채널별 9월 IN·OUT·재고, 파트 홈 채널군, 데이터 현황
function snap() {
  g.ctx._offInvalidateCache();
  const mon = g.ctx._offGetMonthly({ from: '2026-01', to: '2026-12', totalsOnly: true });
  const inv = g.ctx._offGetInventory({});
  const home = g.ctx._homeGetSummary({ ym: YM, mode: 'month' }), ytd = g.ctx._homeGetSummary({ ym: YM, mode: 'ytd' });
  const st = g.ctx._offGetStatus();
  const ch = {};
  read('channel').filter(r => r[0]).forEach(r => {
    const t = mon.totals.byChannelMonth.find(x => x.ym === YM && x.channelId === r[0]) || { in: {}, out: {} };
    const gr = inv.groups.find(x => x.channelId === r[0] && x.level === 'channel') || { stock: {} };
    const ci = inv.channels.find(x => x.channelId === r[0]) || {};
    ch[r[0]] = {
      inT: t.in.target, inA: t.in.actual, inTA: t.in.targetAmount, inAA: t.in.actualAmount, outT: t.out.target, outA: t.out.actual, outAA: t.out.actualAmount,
      정상: gr.stock['정상'], 전시: gr.stock['전시'], 리퍼: gr.stock['리퍼'], 판매N일: gr.windowQty, 재고일수: gr.days == null ? null : Math.round(gr.days * 10) / 10,
      진열점포: gr.displayStores, 점포결품: gr.storeOuts, 재고기준일: ci.stockDate || '', 판매기준일: ci.salesDate || '', 미매칭재고: ci.unmatchedStock
    };
  });
  const all = inv.groups.find(x => x.channelId === '*' && x.level === 'channel');
  const grp = (s, k) => s.range.reduce((a, ym) => ({ t: a.t + (s.series[k][ym].target || 0), a: a.a + (s.series[k][ym].actual || 0) }), { t: 0, a: 0 });
  const home2 = {};
  ['offline', 'closed', 'gongu'].forEach(k => { home2[k] = { 월: grp(home, k), 연누적: grp(ytd, k) }; });
  const status = {};
  st.channels.forEach(c => { status[c.channelId] = [c.salesLast, c.stockLast, c.missingDays.length].join(' / '); });
  return { ch, all: { 정상: all.stock['정상'], 전체: all.total, 판매N일: all.windowQty }, home: home2, homeRaw: { home, ytd }, status, mon };
}
const before = snap();
const chBefore = read('channel').filter(r => r[0]).map(r => r.slice());

// 4) 새 GAS를 같은 시트에 붙여넣고 setup 실행(운영 배포와 같은 순서)
GAS_FILES.forEach(f => vm.runInContext(fs.readFileSync(path.join(PROJ, f), 'utf8'), g.ctx, { filename: f }));
g.ctx._offToday = () => TODAY;
const rep = g.ctx.offline_setupSheets();
const after = snap();
const chAfter = read('channel').filter(r => r[0]);

console.log('\n① 채널마스터 — 유형 → 채널대분류(옮긴 결과), 채널명·별칭 (channel_id 그대로)');
console.table(chAfter.map(r => {
  const b = chBefore.find(x => x[0] === r[0]) || [], mv = (rep.channelCategory || []).find(x => x.channelId === r[0]) || {};
  return { channel_id: r[0], '유형(전)': b[2], 채널대분류: r[2], '옮김': mv.from === undefined ? '' : mv.from === mv.to ? '그대로' : mv.from + ' → ' + mv.to,
    '채널명(전)': b[1], 채널명: r[1], 채널별칭: r[11], 활성: r[3], 정렬순서: r[4] };
}));
console.log('setup 보고 — 확장 ' + J(rep.extended) + ' · 채널명 변경 ' + J(rep.channelRenamed) + ' · 헤더 불일치 ' + rep.mismatched.length + '개');
const otherCols = rows => J(rows.map(r => [r[0], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10]]));
console.log('채널마스터 다른 열(활성·정렬순서·업로드시작월·원천업태명·점포명접두어·코드체계채널·재고기준일오프셋·IN실적원천) 그대로: ' + ok(otherCols(chBefore) === otherCols(chAfter)));

console.log('\n② 채널별 9월 IN·OUT·재고 — 전후 (값은 후, 결과 = 전과 같은지)');
const name = id => (chAfter.find(r => r[0] === id) || [])[1] || id;
console.table(Object.keys(after.ch).map(id => {
  const a = after.ch[id], b = before.ch[id];
  return { 채널: name(id), 대분류: (chAfter.find(r => r[0] === id) || [])[2], 'IN 목표/실적': (a.inT == null ? '—' : a.inT) + ' / ' + (a.inA == null ? '—' : a.inA), 'IN 실적금액': won(a.inAA),
    'OUT 목표/실적': (a.outT == null ? '—' : a.outT) + ' / ' + (a.outA == null ? '—' : a.outA), 'OUT 실적금액': won(a.outAA), 정상재고: a.정상 == null ? '—' : a.정상, 재고일수: a.재고일수 == null ? '—' : a.재고일수,
    결과: ok(J(a) === J(b)) };
}));
console.log('전체 채널(*) 재고 — 정상 ' + after.all.정상 + ' · 전체 ' + after.all.전체 + ' · 최근 판매 ' + after.all.판매N일 + ' : ' + ok(J(after.all) === J(before.all)));
console.log('월별 해석 합계 전체(byChannelMonth·byMonth·byCategory, 1~12월) 같음: ' + ok(J(after.mon.totals) === J(before.mon.totals)));

console.log('\n③ 파트 홈 채널군 — 9월(월)·1~9월(연 누적) 목표·실적 금액 전후');
const L = { offline: '오프라인', closed: '특수', gongu: '공동구매' };
console.table(['offline', 'closed', 'gongu'].map(k => ({ 채널군: L[k], '9월 목표': won(after.home[k].월.t), '9월 실적': won(after.home[k].월.a), '연누적 목표': won(after.home[k].연누적.t), '연누적 실적': won(after.home[k].연누적.a),
  결과: ok(J(after.home[k]) === J(before.home[k])) })));
const H = after.homeRaw.home;
console.log('채널군 표시명 — ' + H.groups.map(x => x.label).join(' · ') + (H.warnings.length ? ' · 경고 ' + J(H.warnings) : ' · 경고 없음'));
const cats = [];
H.channels.forEach(c => { let b = cats.find(x => x.cat === c.channelCategory && x.group === c.group); if (!b) cats.push(b = { cat: c.channelCategory, group: c.group, chs: [] }); b.chs.push(c); });
console.table(cats.map(b => {
  const sumA = b.chs.reduce((s, c) => s + (c.actual || 0), 0), sumT = b.chs.reduce((s, c) => s + (c.target || 0), 0);
  const fromMon = b.chs.reduce((s, c) => s + (((after.mon.totals.byChannelMonth.find(x => x.ym === YM && x.channelId === c.channelId) || { in: {} }).in.actualAmount) || 0), 0);
  return { 채널군: L[b.group], 채널대분류: b.cat, 채널: b.chs.map(c => c.name).join('·'), '소계 실적(채널 합)': won(sumA), '소계 목표': won(sumT), '채널 현황 IN 금액 합': won(fromMon), 결과: ok(sumA === fromMon) };
}));
['offline', 'closed'].forEach(k => {
  const s = H.channels.filter(c => c.group === k).reduce((a, c) => a + (c.actual || 0), 0);
  console.log('채널 표 ' + L[k] + ' 채널 합 ' + won(s) + ' = 채널군 9월 실적 ' + won(H.series[k][YM].actual) + ' : ' + ok(s === (H.series[k][YM].actual || 0)));
});

console.log('\n④ 데이터 현황(판매 마지막 / 재고 마지막 / 9월 빈 날짜 수) 전후 — 순서는 후(채널대분류 → 정렬순서)');
console.table(Object.keys(after.status).map(id => ({ 채널: name(id), 값: after.status[id], 결과: ok(after.status[id] === before.status[id]) })));
console.log('목록 순서 — 전 ' + Object.keys(before.status).join(',') + '\n            후 ' + Object.keys(after.status).join(','));

console.log('\n⑤ 진행현황 이관 미리보기 — 원본 채널명 → channel_id 제안(채널명·별칭)');
const W = 12, row = c => { const r = new Array(W).fill(''); Object.keys(c).forEach(k => { r[k] = c[k]; }); return r; };
const legacy = g.ctx._offParseLegacyProgress({ name: '26년 진행현황', values: [row({ 1: '구분', 2: '채널', 3: '품목', 5: '9월' }), row({ 5: '목표 (IN)', 6: '실적 (IN)', 7: '목표(OUT)', 8: '실적(OUT)' })]
  .concat(['하이마트', '전자랜드', '이마트', '트레이더스', '신세계', '롯데백화점', '디에이블앤', '워크숍에이트', '다파라솔루션', '특판'].map(n => row({ 1: '', 2: n, 3: '더플렌더 MAX', 5: 1 }))) });
const plan = g.ctx._offProgressPlan(legacy, chAfter, null);
console.table(plan.channels.map(c => ({ 원본: c.legacy, 제안: c.suggest, 채널명: name(c.suggest), 결과: c.legacy === '신세계' ? ok(c.suggest === 'shinsegae') : '' })));
fs.rmSync(oldDir, { recursive: true, force: true });
