/* 공구 목표 이관 실데이터 대조 — 로컬 확인용(테스트 아님, 원본 파일은 커밋하지 않는다). 출력은 합계뿐이다.
   원본 스프레드시트를 xlsx로 받아 둔 파일의 '공동구매 26년 목표' 탭을 GAS 실코드(_gtParseLegacy·_gtPlan·_gtCompare)로 읽는다.
   xlsx는 병합 범위를 따로 주므로 목 원본 시트에 그대로 넘기면 _offLegacyGrid가 실제 GAS처럼 병합 칸을 채운다.

   실행: XLSX_PATH=<SheetJS 모듈 경로> node scripts/verify-gongu-targets.js <원본.xlsx>
   ① 블록·벤더·상품명·월 범위 ② 제안 매핑 ③ 이관 예정 행 수 ④ 대조(월·연·분기·벤더) ⑤ 마감 매출 월별 합계 */
const path = require('path');
const PROJ = path.join(__dirname, '..');
const { loadOfflineGas } = require(path.join(PROJ, 'tests', 'lib', 'offline-gas.js'));
let XLSX;
try { XLSX = require(process.env.XLSX_PATH || 'xlsx'); } catch (e) { console.error('SheetJS가 없습니다. XLSX_PATH=<xlsx 모듈 경로> 로 실행하세요.'); process.exit(2); }
const file = process.argv[2];
if (!file) { console.error('원본 xlsx 경로를 주세요.'); process.exit(2); }
const TAB = '공동구매 26년 목표';
const wb = XLSX.readFile(file, { cellDates: true });
const ws = wb.Sheets[TAB];
if (!ws) { console.error('"' + TAB + '" 탭이 없습니다.'); process.exit(2); }
const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
// SheetJS 범위는 0-based {s:{r,c}, e:{r,c}} → 목 원본 [행, 열, 행수, 열수] (1-based)
const merges = (ws['!merges'] || []).map(m => [m.s.r + 1, m.s.c + 1, m.e.r - m.s.r + 1, m.e.c - m.s.c + 1]);
const g = loadOfflineGas({ setup: true, legacy: { [TAB]: { grid, merges } } });
const parsed = g.ctx._gtParseLegacy(g.ctx._offLegacyGrid(g.legacy, TAB));
const plan = g.ctx._gtPlan(parsed, null);
const cmp = g.ctx._gtCompare(parsed, plan.rows);
const W = v => v == null ? '—' : Math.round(v).toLocaleString('ko-KR');
const P = parsed.plan;
console.log('① 월 ' + P.months[0].ym + ' ~ ' + P.months[P.months.length - 1].ym + ' (' + P.months.length + '개월) · 벤더 ' + P.vendorOrder.join(', ') +
  ' · 상품 행 ' + P.rows.length + ' · 오류 칸 ' + parsed.badCells);
console.log('② 상품명 제안');
plan.products.forEach(p => console.log('   ' + p.legacy + ' (' + p.vendors.join('·') + ') → ' + (p.mapped ? p.line + ' / ' + p.model : '(빈칸 — 선택 필요)')));
console.log('③ 이관 예정 ' + plan.rows.length + '행 · 미매핑 ' + (plan.unmapped.join(', ') || '없음'));
console.log('④ 대조');
cmp.months.forEach(m => console.log('   ' + m.ym + '  예정 ' + W(m.planAmt) + ' (' + W(m.planQty) + '대)  원본 채널 합계 ' + W(m.legacyAmt) + ' (' + W(m.legacyQty) + '대)  ' + (m.ok ? 'OK' : '다름')));
console.log('   연 합계  예정 ' + W(cmp.total.planAmt) + '  원본 ' + W(cmp.total.legacyAmt) + '  ' + (cmp.total.ok ? 'OK' : '다름'));
console.log('   26년 목표  예정 ' + W(cmp.year.planAmt) + '  원본 ' + W(cmp.year.legacyAmt) + '  ' + (cmp.year.ok ? 'OK' : '다름'));
cmp.quarters.forEach(q => console.log('   ' + q.q + '분기  예정 ' + W(q.planAmt) + '  원본 ' + W(q.legacyAmt) + '  ' + (q.ok ? 'OK' : '다름')));
cmp.vendors.forEach(v => console.log('   벤더 ' + v.vendor + '  예정 ' + W(v.planAmt) + '  원본 소계 ' + W(v.legacyAmt) + '  ' + (v.ok ? 'OK' : '다름')));
console.log('⑤ 마감 매출 월별 합계(채널 합계 뒤 소계)' + (cmp.close.found ? '' : ' — 블록 없음'));
cmp.close.months.forEach(m => console.log('   ' + m.ym + '  ' + W(m.amt) + ' (' + W(m.qty) + '대)'));
console.log('   분기 마감 ' + JSON.stringify(cmp.close.quarters) + ' · 26년 마감 셀 ' + W(cmp.close.year));
