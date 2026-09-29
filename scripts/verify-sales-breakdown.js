/* 채널 상세 판매 분석 실데이터 대조 — 로컬 확인용(테스트 아님, 데이터 파일은 커밋하지 않는다). 출력은 합계뿐이다.
   오프라인 원장 스프레드시트를 xlsx로 받아 둔 사본의 탭을 목 시트에 그대로 넣고 GAS 실코드로 계산한다.

   실행: XLSX_PATH=<SheetJS 모듈 경로> node scripts/verify-sales-breakdown.js <오프라인원장.xlsx> [이마트 일별상세.xlsx] [연월(기본 2026-09)]
   ① 네 채널: 모델별 합계 = 지점별 합계 = OUT 실적(본품, offline_getMonthly) + 필터 + 미매칭, 모델/SKU 토글 합계 불변, 하이마트 설치완료
   ② 이마트·트레이더스: 일별상세 파일의 업태별 합계 vs 원장(같은 날짜 범위) — 파일을 새 목 원장에 올린 판매 분석 합계와도 */
const path = require('path'), fs = require('fs');
const PROJ = path.join(__dirname, '..');
const { loadOfflineGas } = require(path.join(PROJ, 'tests', 'lib', 'offline-gas.js'));
const P = require(path.join(PROJ, 'src', 'features', 'offline', 'parsers.js'));
let XLSX;
try { XLSX = require(process.env.XLSX_PATH || 'xlsx'); } catch (e) { console.error('SheetJS가 없습니다. XLSX_PATH=<xlsx 모듈 경로> 로 실행하세요.'); process.exit(2); }
const [ledgerFile, dailyFile, ymArg] = process.argv.slice(2);
if (!ledgerFile) { console.error('오프라인 원장 xlsx 경로를 주세요.'); process.exit(2); }
const YM = ymArg || '2026-09';
const AUTH = { email: 'verify@local' };

// 원장 사본 → 목 시트(탭 이름·헤더가 OFF_TABS와 같은 탭만). 텍스트 열은 _offWriteBlock이 문자열로 넣는다
const g = loadOfflineGas({ setup: true });
const wb = XLSX.readFile(ledgerFile, { raw: true });
const T = g.ctx.OFF_TABS;
Object.keys(T).forEach(key => {
  const ws = wb.Sheets[T[key].name];
  if (!ws || key === 'readme') return;
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true }).slice(1).filter(r => r.some(v => v !== ''));
  const sh = g.tab(T[key].name);
  sh._grid.length = 1;
  if (rows.length) g.ctx._offWriteBlock(sh, T[key], 2, rows.map(r => r.slice(0, T[key].headers.length)));
});
g.ctx._offInvalidateCache();
const call = (a, d) => { const j = JSON.parse(g.ctx._offlineHandle(a, d || {}, AUTH)); if (j.error) throw new Error(a + ': ' + j.error); return j; };
const N = v => Math.round(v || 0).toLocaleString('ko-KR');

console.log('① ' + YM + ' 채널별 대조');
['himart', 'etland', 'emart', 'traders'].forEach(ch => {
  const b = call('offline_getSalesBreakdown', { channelId: ch, from: YM, to: YM });
  const sk = call('offline_getSalesBreakdown', { channelId: ch, from: YM, to: YM, unit: 'sku' });
  const mon = call('offline_getMonthly', { from: YM, to: YM, channelId: ch, totalsOnly: true });
  const cm = mon.totals.byChannelMonth[0] || { out: { actual: 0, unmatchedQty: 0 } };
  const filt = mon.totals.byCategory.filter(x => x.category === '필터').reduce((s, x) => s + (x.out.actual || 0), 0);
  const keys = b.keys.reduce((s, k) => s + k.total, 0), stores = b.stores.reduce((s, x) => s + x.total, 0);
  const want = (cm.out.actual || 0) + filt + (cm.out.unmatchedQty || 0);
  console.log('   ' + ch.padEnd(8) + ' 모델별 ' + N(keys) + ' · 지점별 ' + N(stores) + ' · SKU 단위 ' + N(sk.totals.qty) + ' | OUT(본품) ' + N(cm.out.actual) + ' + 필터 ' + N(filt) + ' + 미매칭 ' + N(cm.out.unmatchedQty) +
    ' = ' + N(want) + '  ' + (keys === stores && stores === want && sk.totals.qty === want ? 'OK' : '다름') + ' | 모델 ' + b.keys.length + '개 · 점포 ' + b.stores.length + '곳' +
    (b.online ? ' · 온라인 ' + N(b.online.online) + ' / 오프라인 ' + N(b.online.offline) : '') + (b.hasInst ? ' · 설치완료 ' + N(call('offline_getSalesBreakdown', { channelId: ch, from: YM, to: YM, measure: 'inst' }).totals.qty) : ''));
});

if (dailyFile) {
  console.log('② 이마트 일별상세 파일 vs 원장');
  const { rows } = P.readWorkbookRows(XLSX, fs.readFileSync(dailyFile));
  const p = P.parseRows(rows, { fileName: path.basename(dailyFile), today: YM + '-28' });
  if (!p.ok || p.type !== 'EMART_DAILY_SALES_STORE') { console.error('   일별상세 파일이 아닙니다: ' + (p.error || p.type)); process.exit(1); }
  const byBiz = {};
  p.records.sales.forEach(r => { byBiz[r.biz] = (byBiz[r.biz] || 0) + r.qty; });
  const ledger = g.ctx._offReadRows(g.tab(T.sales.name), T.sales);
  [['이마트', 'emart'], ['트레이더스', 'traders']].forEach(([biz, ch]) => {
    const inRange = ledger.filter(r => r[3] === ch && r[0] >= p.period.start && r[1] <= p.period.end).reduce((s, r) => s + (Number(r[6]) || 0), 0);
    console.log('   ' + biz.padEnd(6) + ' 파일(' + p.period.start + '~' + p.period.end + ') ' + N(byBiz[biz]) + ' · 운영 원장 같은 기간 ' + N(inRange) + '  ' + (byBiz[biz] === inRange ? 'OK' : '다름'));
  });
  // 파일을 빈 목 원장에 올린 뒤 판매 분석(전체 대분류 = 기타·미매칭 포함) 합계
  const g2 = loadOfflineGas({ setup: true });
  const T2 = g2.ctx.OFF_TABS;
  ['sku', 'mapping', 'channel', 'store'].forEach(k => {
    const src = g.ctx._offReadRows(g.tab(T[k].name), T[k]), sh = g2.tab(T2[k].name);
    sh._grid.length = 1; if (src.length) g2.ctx._offWriteBlock(sh, T2[k], 2, src);
  });
  g2.ctx._offUpload(P.toUploadPayload(p, { fileName: path.basename(dailyFile) }), AUTH);
  [['이마트', 'emart'], ['트레이더스', 'traders']].forEach(([biz, ch]) => {
    const b = JSON.parse(g2.ctx._offlineHandle('offline_getSalesBreakdown', { channelId: ch, from: YM, to: YM, category: '*' }, AUTH));
    console.log('   ' + biz.padEnd(6) + ' 파일만 올린 판매 분석(전체) ' + N(b.totals.qty) + ' = 파일 ' + N(byBiz[biz]) + '  ' + (b.totals.qty === byBiz[biz] ? 'OK' : '다름'));
  });
}
