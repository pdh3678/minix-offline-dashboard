/* 필터·기타 분리 실데이터 대조 — 로컬 확인용(테스트 아님, 데이터 파일은 커밋하지 않는다). 출력은 집계값뿐이다.
   samples/의 포털 원본 파일을 빈 오프라인 시트(목, GAS 실코드)에 반영하고, 본품 코드는 모델명(MN…)별 임시 SKU로 매핑한 뒤
   미매칭으로 남는 하이마트 필터·전시대·타사 리퍼 코드를 필터·기타 SKU로 매핑해 전후를 비교한다.

   실행: XLSX_PATH=<SheetJS 모듈 경로> node scripts/verify-offline-extra.js [원본 폴더(기본 samples)]
   ① 매핑 전후 채널 단위(본품) 재고 지표 — 정상·전시·리퍼·최근 판매·재고일수·진열·취급 점포·점포 결품·경보
   ② 매핑 전후 월별 채널 합계(본품) — IN·OUT 목표·실적(달성률 = 실적 ÷ 목표라 이 둘이 같으면 같다)
   ③ 필터 한 줄에 나올 값 — 채널별 필터 OUT 실적(이번 달)·필터 재고
   ④ 경보 — 기타 SKU의 과다·결품 위험·점포 결품 0건, 필터 경보 건수 */
const fs = require('fs'), path = require('path');
const PROJ = path.join(__dirname, '..');
const { loadOfflineGas } = require(path.join(PROJ, 'tests', 'lib', 'offline-gas.js'));
const P = require(path.join(PROJ, 'src', 'features', 'offline', 'parsers.js'));
const R = require(path.join(PROJ, 'src', 'features', 'offline', 'resolver.js'));
let XLSX;
try { XLSX = require(process.env.XLSX_PATH || 'xlsx'); } catch (e) { console.error('SheetJS가 없습니다. XLSX_PATH=<xlsx 모듈 경로> 로 실행하세요.'); process.exit(2); }
const dir = process.argv[2] || path.join(PROJ, 'samples');
const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const J = JSON.stringify, AUTH = { email: 'verify@local' };

const g = loadOfflineGas({ setup: true, today: TODAY });
const call = (a, d) => { const j = JSON.parse(g.ctx._offlineHandle(a, d || {}, AUTH)); if (j.error) throw new Error(a + ': ' + j.error); return j; };

// 1) 원본 반영 — 막힌 유형(이마트 합계 파일)은 건너뛰고, 하이마트는 기준일 오름차순으로 맨 뒤(업로드 화면과 같은 순서)
const parsed = fs.readdirSync(dir).filter(f => /\.(xlsx|xls|csv)$/i.test(f)).map(f => {
  const { rows } = P.readWorkbookRows(XLSX, fs.readFileSync(path.join(dir, f)));
  return { f, p: P.parseRows(rows, { fileName: f, today: TODAY }) };
}).filter(x => x.p.ok && !g.ctx.OFF_FILE_TYPES[x.p.type].blocked);
parsed.sort((a, b) => ((a.p.channelId === 'himart') - (b.p.channelId === 'himart')) || String(a.p.baseDate || '').localeCompare(String(b.p.baseDate || '')));
parsed.forEach(x => g.ctx._offUpload(P.toUploadPayload(x.p, { fileName: x.f }), AUTH));
console.log('반영한 파일 ' + parsed.length + '개: ' + parsed.map(x => x.p.type).join(', '));

// 2) 본품 코드 → 모델명별 임시 SKU(더플렌더 품목군 — 본품이기만 하면 된다). 모델명이 안 뽑히는 코드(타사)는 미매칭으로 둔다
const EXTRA = { 'MNFD-RF3': ['필터', '하드락필터', '', '정상'], 'MNFD-RF5': ['필터', '하드필터', '', '정상'],
  '(J)MNMD-FN': ['기타', '기타', '3kg 건조기 전시대', '전시'], 'MW74017_264837': ['기타', '기타', '타 브랜드 리퍼', '리퍼'] };
const um = call('offline_getUnmatched').items;
const skuOf = {}, items = [];
um.filter(u => !EXTRA[u.code]).forEach(u => {
  const m = R.extractModel(u.code) || R.extractModel(u.name);
  if (!m) return;
  if (!skuOf[m]) skuOf[m] = call('offline_saveSku', { sku: { name: '본품 ' + m, line: '더플렌더', model: m } }).sku.skuId;
  items.push({ op: 'upsert', channelId: u.channelId, code: u.code, skuId: skuOf[m], stockType: R.guessStockType(u.code, u.name) });
});
if (items.length) call('offline_saveMapping', { items });
const extraFound = um.filter(u => EXTRA[u.code]);
console.log('본품 코드 ' + items.length + '개 → 임시 SKU ' + Object.keys(skuOf).length + '개 · 남은 미매칭 중 필터·기타 대상 ' + extraFound.length + '개(' + extraFound.map(u => u.channelId + ' ' + u.code).join(', ') + ')');

const ym = TODAY.slice(0, 7);
const KEYS = ['stock', 'total', 'windowQty', 'dailyAvg', 'days', 'noSales', 'displayStores', 'handlingStores', 'coverage', 'storeOuts', 'alert'];
const snap = () => {
  const inv = call('offline_getInventory', {}), mon = call('offline_getMonthly', { from: ym, to: ym });
  const ch = {};
  inv.groups.filter(x => x.level === 'channel').forEach(x => { const o = {}; KEYS.forEach(k => { o[k] = x[k]; }); ch[x.channelId] = o; });
  const tot = mon.totals.byChannelMonth.map(t => ({ ch: t.channelId, 'in': [t['in'].target, t['in'].actual], out: [t.out.target, t.out.actual], unmatchedQty: t.out.unmatchedQty }));
  return { inv, mon, ch, tot };
};
const before = snap();

// 3) 필터·기타 SKU를 만들고 미매칭 4건을 매핑
const made = {};
Object.keys(EXTRA).forEach(code => {
  const [line, model, option] = EXTRA[code], key = line + '|' + model + '|' + option;
  if (!made[key]) made[key] = call('offline_saveSku', { sku: { name: (line === '기타' ? '기타 ' + option : '필터 ' + model), line, model, option } }).sku.skuId;
});
call('offline_saveMapping', { items: extraFound.map(u => { const e = EXTRA[u.code]; return { op: 'upsert', channelId: u.channelId, code: u.code, skuId: made[e[0] + '|' + e[1] + '|' + e[2]], stockType: e[3] }; }) });
const after = snap();

// ① ② 비교
const chans = Object.keys(before.ch);
const diffCh = chans.filter(c => J(before.ch[c]) !== J(after.ch[c]));
console.log('\n① 채널 단위(본품) 재고 지표 ' + chans.length + '개(채널 + 전체) — ' + (diffCh.length ? 'DIFF ' + J(diffCh) : '매핑 전후 같음 OK'));
chans.forEach(c => { const x = after.ch[c]; if (x.total || x.windowQty) console.log('   ' + c.padEnd(8) + ' 정상 ' + x.stock['정상'] + ' · 전시 ' + x.stock['전시'] + ' · 리퍼 ' + x.stock['리퍼'] +
  ' · 최근 판매 ' + x.windowQty + ' · 재고일수 ' + (x.days == null ? (x.noSales ? '판매 없음' : '—') : Math.round(x.days * 10) / 10) + ' · 진열 ' + x.displayStores + ' · 취급 ' + x.handlingStores + ' · 점포 결품 ' + x.storeOuts); });
const noUm = t => t.map(x => J([x.ch, x['in'], x.out]));
console.log('② ' + ym + ' 월별 채널 합계(본품) — ' + (J(noUm(before.tot)) === J(noUm(after.tot)) ? '매핑 전후 같음 OK' : 'DIFF'));
after.tot.forEach(x => { const b = before.tot.find(y => y.ch === x.ch) || {}; console.log('   ' + x.ch.padEnd(8) + ' IN ' + J(x['in']) + ' · OUT ' + J(x.out) + ' · 미매칭 판매 ' + b.unmatchedQty + ' → ' + x.unmatchedQty); });

// ③ 필터 한 줄
console.log('③ 필터 한 줄(채널 카드·채널 상세)');
chans.filter(c => c !== '*').forEach(c => {
  const cat = after.inv.groups.find(x => x.channelId === c && x.level === 'category' && x.key === '필터');
  const sold = (after.mon.totals.byCategory.find(x => x.channelId === c && x.category === '필터') || { out: {} }).out.actual || 0;
  if (cat || sold) console.log('   ' + c.padEnd(8) + ' 필터 판매 ' + sold + '개 · 필터 재고 ' + (cat ? cat.total : 0) + '개');
});

// ④ 경보
const skuCat = {};
after.inv.groups.filter(x => x.level === 'sku').forEach(x => { skuCat[x.skuId] = x.category; });
const al = cat => after.inv.groups.filter(x => x.level === 'sku' && x.channelId !== '*' && x.category === cat && x.alert).length;
const so = cat => after.inv.storeOuts.filter(s => skuCat[s.skuId] === cat).length;
console.log('④ 경보 — 기타: 과다·결품 위험 ' + al('기타') + '건 · 점포 결품 ' + so('기타') + '건 ' + (al('기타') + so('기타') ? 'DIFF' : 'OK') +
  ' / 필터: 과다·결품 위험 ' + al('필터') + '건 · 점포 결품 ' + so('필터') + '건');
