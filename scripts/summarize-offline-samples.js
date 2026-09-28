/* samples/ 실파일 파싱 요약 — 로컬 확인용(테스트 아님, 결과를 커밋하지 않는다).
   실행: XLSX_PATH=<SheetJS 모듈 경로> node scripts/summarize-offline-samples.js [폴더(기본 samples)]
   SheetJS는 저장소 의존성이 아니다 — npm i --no-save https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
   처럼 저장소 밖(또는 --no-save)으로 받아 경로를 넘긴다.
   출력은 집계값(유형·헤더 행·기준일·행수·코드 종류 수)뿐이다 — 실데이터 값은 찍지 않는다. */
const fs = require('fs'), path = require('path');
const P = require(path.join(__dirname, '..', 'src', 'features', 'offline', 'parsers.js'));

let XLSX;
try { XLSX = require(process.env.XLSX_PATH || 'xlsx'); }
catch (e) { console.error('SheetJS가 없습니다. XLSX_PATH=<xlsx 모듈 경로> 로 실행하세요.'); process.exit(2); }

const dir = process.argv[2] || path.join(__dirname, '..', 'samples');
const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // Asia/Seoul
const files = fs.readdirSync(dir).filter(f => /\.(xlsx|xls|csv)$/i.test(f)).sort();
const out = [];
for (const f of files) {
  const { rows } = P.readWorkbookRows(XLSX, fs.readFileSync(path.join(dir, f)));
  const r = P.parseRows(rows, { fileName: f, today });
  if (!r.ok) { out.push({ 파일: f, 유형: '판별 실패', 비고: r.error }); continue; }
  out.push({
    파일: f, 유형: r.type, 헤더행: r.headerRow,
    '기준일/기간': r.kind === 'period' ? (r.period ? r.period.start + '~' + r.period.end : '-') : (r.baseDate || '(선택 필요)'),
    원본행수: r.rawRowCount, 코드종류: r.codes.length, 점포수: r.records.stores.length,
    반영예정: Object.keys(r.plannedRows).map(k => k + ' ' + r.plannedRows[k]).join(', '),
    경고: r.warnings.join(' / ') || '-'
  });
}
console.table(out);

/* GAS 반영 시뮬레이션 — 같은 실파일을 apps-script-offline.js 실코드에 목 시트로 두 번씩 반영한다.
   ① 재업로드 시 원장 행 수 불변 ② 하이마트 연속 이틀: day 레코드 수량 = 파일의 당일판매 */
const { loadOfflineGas, dataRows } = require(path.join(__dirname, '..', 'tests', 'lib', 'offline-gas.js'));
const gas = loadOfflineGas({ setup: true, today });
const parsed = files.map(f => {
  const { rows } = P.readWorkbookRows(XLSX, fs.readFileSync(path.join(dir, f)));
  return { f, r: P.parseRows(rows, { fileName: f, today }) };
}).filter(x => x.r.ok)
  .sort((a, b) => (a.r.baseDate || '').localeCompare(b.r.baseDate || '')); // 하이마트는 기준일 오름차순
const TABS = ['판매원장', '재고_채널일별', '재고_점포최신', '하이마트_누적스냅샷', '점포마스터', '미매칭코드'];
const counts = () => TABS.map(t => dataRows(gas.tab(t)).length).join('/');
const sim = [];
for (const { f, r } of parsed) {
  if (r.blocked) { sim.push({ 파일: f, 반영: '차단 — ' + r.blocked }); continue; } // 반영하지 않는 양식(트레이더스가 합쳐진 이마트 합계)
  const res1 = gas.ctx._offUpload(P.toUploadPayload(r, { fileName: f }), { email: 'local@athomecorp.com' });
  const c1 = counts();
  gas.ctx._offUpload(P.toUploadPayload(r, { fileName: f }), { email: 'local@athomecorp.com' });
  const c2 = counts();
  sim.push({ 파일: f, 반영: Object.keys(res1.applied).map(k => k + ' ' + res1.applied[k]).join(', '), 미매칭: res1.unmatched.length,
    [TABS.join('/')]: c1, 재업로드후: c2, 불변: c1 === c2 ? 'OK' : '다름', 경고: res1.warnings.join(' / ') || '-' });
}
console.log('\nGAS 반영 시뮬레이션(목 시트, 같은 파일 2회씩)');
console.table(sim);

const hs = parsed.filter(x => x.r.type === 'HIMART_SALES_STOCK');
for (let i = 1; i < hs.length; i++) {
  const D = hs[i].r.baseDate;
  const dayRecs = dataRows(gas.tab('판매원장')).filter(x => x[3] === 'himart' && x[1] === D && x[2] === 'day');
  const got = {};
  dayRecs.forEach(x => { got[x[4] + '|' + x[5]] = x[6]; });
  let mism = 0, checked = 0, fileSum = 0;
  hs[i].r.records.himart.forEach(h => { checked++; fileSum += h.day; if ((got[h.store + '|' + h.code] || 0) !== h.day) mism++; });
  console.log('하이마트 ' + hs[i - 1].r.baseDate + ' → ' + D + ': day 레코드 ' + dayRecs.length + '건, 수량 합 ' +
    dayRecs.reduce((s, x) => s + x[6], 0) + ' / 파일 당일판매 합 ' + fileSum + ', 점포×코드 ' + checked + '개 중 불일치 ' + mism + '건');
}
