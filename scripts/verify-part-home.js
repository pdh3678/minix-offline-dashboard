/* 파트 홈 공구 실적 실데이터 대조 — 로컬 확인용(테스트 아님, 원본 파일은 커밋하지 않는다). 출력은 월 합계뿐이다.
   운영과 같은 경로로 공구 실적을 만든다: 공구 시트 '실적통합'(xlsx 사본) → GAS parseMainSheet(실코드, 목 시트)
   → 프론트 adaptGAS · _mergeDuplicateCodeRows(실코드) → DATA → 파트 홈 partGonguMonthly · 공구 분석 renderKPI(월 필터).

   실행: XLSX_PATH=<SheetJS 모듈 경로> node scripts/verify-part-home.js <공구시트.xlsx> [원본 진행현황.xlsx]
   ① 월별: 파트 홈 공구 실적 vs 공구 분석 같은 연월 필터 '총 매출'(일치해야 한다)
   ② 원본 '공동구매 26년 목표' 마감 매출 블록 월 합계 vs 공구 시트 실적(참고 — 이관하지 않음) */
const fs = require('fs'), path = require('path'), vm = require('vm');
const PROJ = path.join(__dirname, '..');
const { makeSheet, installGlobals } = require(path.join(PROJ, 'tests', 'lib', 'mock-sheets.js'));
const { loadFrontend } = require(path.join(PROJ, 'tests', 'lib', 'front-sandbox.js'));
let XLSX;
try { XLSX = require(process.env.XLSX_PATH || 'xlsx'); } catch (e) { console.error('SheetJS가 없습니다. XLSX_PATH=<xlsx 모듈 경로> 로 실행하세요.'); process.exit(2); }
const [gonguFile, legacyFile] = process.argv.slice(2);
if (!gonguFile) { console.error('공구 시트 xlsx 경로를 주세요.'); process.exit(2); }
const YEAR = 2026;

// 1) 공구 시트 → GAS parseMainSheet
const wb = XLSX.readFile(gonguFile, { cellDates: true });
const ws = wb.Sheets['실적통합'];
if (!ws) { console.error("'실적통합' 탭이 없습니다."); process.exit(2); }
const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
const sheets = { '실적통합': makeSheet('실적통합', grid) };
installGlobals(sheets, { scriptProps: { SESSION_SECRET_V1: 'verify' } });
const g = vm.createContext(global);
vm.runInContext(fs.readFileSync(path.join(PROJ, 'apps-script.js'), 'utf8'), g, { filename: 'apps-script.js' });
g._resolveCols(sheets['실적통합']);
const parsed = g.parseMainSheet(sheets['실적통합']);

// 2) 프론트 실코드로 DATA
const { ctx, X } = loadFrontend(PROJ, 'get DASH(){return DASH;}, fmtWon(v){return won(v);}');
const box = {};
ctx.document.getElementById = id => (box[id] = box[id] || { innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
ctx.console = Object.assign({}, console, { log() {}, warn() {}, debug() {} });
const adapted = ctx.adaptGAS({ purchases: parsed.deals });
X.DATA.splice(0, X.DATA.length, ...ctx._mergeDuplicateCodeRows(adapted));
const W = v => v == null ? '—' : Math.round(v).toLocaleString('ko-KR');
console.log('공구건 ' + X.DATA.length + '건(시트 행 병합 후) · 오늘(KST) ' + ctx._kstTodayDate().toDateString());

// ① 파트 홈 공구 실적 = 공구 분석 총 매출
const gm = ctx.partGonguMonthly(YEAR, '');
Object.assign(X.DASH, { years: new Set([YEAR]), weeks: null, channel: null, revTier: 'all', followerTier: 'all', product: 'all' });
let allOk = true;
console.log('① 파트 홈 공구 실적 vs 공구 분석 같은 연월 필터 총 매출');
for (let m = 1; m <= 12; m++) {
  X.DASH.months = new Set([m]);
  ctx.renderKPI();
  const kpi = (/총 매출 \(완료\+진행중\)<\/div><div class="kpi-val cm">([^<]*)</.exec(box.kpiRow.innerHTML) || [])[1];
  const ym = YEAR + '-' + String(m).padStart(2, '0'), home = gm[ym].rev;
  const ok = (home ? X.fmtWon(home) : '—') === kpi;
  allOk = allOk && ok;
  console.log('   ' + ym + '  파트 홈 ' + W(home) + ' (' + gm[ym].deals + '건 · ' + W(gm[ym].qty) + '대)  공구 분석 ' + kpi + '  ' + (ok ? 'OK' : '다름'));
}
console.log('   → ' + (allOk ? '12개월 모두 일치' : '다른 달이 있음'));

// ② 원본 마감 매출 vs 공구 시트 실적
if (legacyFile) {
  const { loadOfflineGas } = require(path.join(PROJ, 'tests', 'lib', 'offline-gas.js'));
  const lw = XLSX.readFile(legacyFile, { cellDates: true }), TAB = '공동구매 26년 목표', lws = lw.Sheets[TAB];
  const lgrid = XLSX.utils.sheet_to_json(lws, { header: 1, defval: '', raw: true });
  const merges = (lws['!merges'] || []).map(x => [x.s.r + 1, x.s.c + 1, x.e.r - x.s.r + 1, x.e.c - x.s.c + 1]);
  const og = loadOfflineGas({ setup: true, legacy: { [TAB]: { grid: lgrid, merges } } });
  const lp = og.ctx._gtParseLegacy(og.ctx._offLegacyGrid(og.legacy, TAB));
  console.log('② 원본 마감 매출(채널 합계 소계) vs 공구 시트 실적(공구 분석 규칙)');
  let sl = 0, sg = 0;
  lp.close.months.forEach(mo => {
    const l = lp.close.grand.values[mo.ym], a = gm[mo.ym];
    sl += l.amt || 0; sg += a.rev;
    console.log('   ' + mo.ym + '  원본 ' + W(l.amt) + ' (' + W(l.qty) + '대)  공구 시트 ' + W(a.rev) + ' (' + W(a.qty) + '대)  차이 ' + W(a.rev - (l.amt || 0)));
  });
  console.log('   합계  원본 ' + W(sl) + '  공구 시트 ' + W(sg) + '  차이 ' + W(sg - sl));
}
