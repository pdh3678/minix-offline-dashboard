/* 2-A 이관·월별 해석 실데이터 검증 — 로컬 확인용(테스트 아님, 데이터 파일은 커밋하지 않는다).
   기존 진행현황 스프레드시트와 오프라인 스프레드시트를 xlsx로 내보낸 파일을 받아, GAS 실코드
   (apps-script-offline*.js)를 목 시트 위에서 그대로 돌린다. 원본에는 읽기 호출만 한다.

   실행: XLSX_PATH=<SheetJS 모듈 경로> node scripts/verify-offline-migration.js <진행현황.xlsx> <오프라인.xlsx> [YYYY-MM]
   출력(집계값만):
     ① 미리보기 — 월 범위·채널·품목명 목록과 제안
     ② 반영 행 수, 두 번 반영해도 같은지
     ③ 채널×월×항목 합계 vs 원본 '소계' 행 — 불일치 칸은 원본 소계가 수식인지 수기 값인지 함께
     ④ 월별 해석: 채널별 "집계 OUT 실적 + 미매칭 = 판매원장 합계"
     ⑤ 업로드시작월 대조 리포트, 납품가 이관 미리보기 */
const fs = require('fs'), path = require('path');
const { loadOfflineGas, dataRows } = require(path.join(__dirname, '..', 'tests', 'lib', 'offline-gas.js'));
let XLSX;
try { XLSX = require(process.env.XLSX_PATH || 'xlsx'); } catch (e) { console.error('SheetJS가 없습니다. XLSX_PATH=<xlsx 모듈 경로> 로 실행하세요.'); process.exit(2); }
const [legacyPath, offlinePath, ymArg] = process.argv.slice(2);
if (!legacyPath || !offlinePath) { console.error('사용법: node scripts/verify-offline-migration.js <진행현황.xlsx> <오프라인.xlsx> [YYYY-MM]'); process.exit(2); }

function tab(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error('탭이 없습니다: ' + name);
  const R = XLSX.utils.decode_range(ws['!ref']); R.s.c = 0; R.s.r = 0; ws['!ref'] = XLSX.utils.encode_range(R);
  return { ws, grid: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }),
    merges: (ws['!merges'] || []).map(m => [m.s.r + 1, m.s.c + 1, m.e.r - m.s.r + 1, m.e.c - m.s.c + 1]) };
}
const legacyWb = XLSX.read(fs.readFileSync(legacyPath), { cellFormula: true });
const P = tab(legacyWb, '26년 진행현황');
const g = loadOfflineGas({ setup: true, today: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10),
  legacy: { '26년 진행현황': { grid: P.grid, merges: P.merges }, '납품가 수수료': tab(legacyWb, '납품가 수수료') } });
const T = g.ctx.OFF_TABS;
const offWb = XLSX.read(fs.readFileSync(offlinePath));
function load(name, key) {
  if (!offWb.Sheets[name]) return;
  const rows = XLSX.utils.sheet_to_json(offWb.Sheets[name], { header: 1, raw: true, defval: '' }).slice(1).filter(r => r.some(v => v !== ''))
    .map(r => T[key].headers.map((h, i) => { const v = r[i]; return v === undefined ? '' : (T[key].text.indexOf(i) >= 0 ? String(v) : v); }));
  if (!rows.length) return;
  const sh = g.tab(name);
  if (key === 'channel') sh._grid.length = 1; // setup이 넣은 초기값 대신 운영 값
  g.ctx._offWriteBlock(sh, T[key], 2, rows);
}
[['채널마스터', 'channel'], ['제품마스터', 'sku'], ['코드매핑', 'mapping'], ['판매원장', 'sales'], ['단가마스터', 'prices']].forEach(([n, k]) => load(n, k));
// 1단계 시트라 업로드시작월 열이 비어 있으면 setup 초기값과 같게 채운다
g.tab('채널마스터')._grid.forEach((r, i) => { if (i && !r[5] && g.ctx.OFF_UPLOAD_START_SEED[r[0]]) r[5] = g.ctx.OFF_UPLOAD_START_SEED[r[0]]; });
const AUTH = { email: 'verify@local' };

// ① 미리보기
const pv = g.ctx._offMigrateProgress({ mode: 'preview' }, AUTH);
console.log('① 월', pv.months[0] + '~' + pv.months[pv.months.length - 1], '(' + pv.months.length + '개월) · 품목 행', pv.legacyRows, '· 오류 칸', pv.badCells);
console.log('   채널', pv.channels.map(c => c.legacy + '→' + (c.channelId || '?')).join(', '));
console.log('   품목', pv.products.map(p => p.legacy + '→' + (p.suggest.level === 'category' ? '대분류 ' + p.suggest.category : (p.suggest.model || '?'))).join(', '));

// ② 반영 — 제안 그대로(모델 단위 / 건조기·식세기는 대분류 단위)
const mapping = { channels: {}, products: {} };
pv.channels.forEach(c => { mapping.channels[c.legacy] = c.channelId; });
pv.products.forEach(p => {
  mapping.products[p.legacy] = p.suggest.level === 'category' ? { category: p.suggest.category } : { line: p.suggest.line, model: p.suggest.model };
});
console.log('   미매핑', pv.unmapped.length ? pv.unmapped.join(', ') : '0건', '· 대분류 연결', pv.products.filter(p => p.level === 'category').map(p => p.legacy + '→' + p.category).join(', '));
const ap = g.ctx._offMigrateProgress({ mode: 'apply', mapping }, AUTH);
const n1 = dataRows(g.tab('목표실적_월')).length;
g.ctx._offMigrateProgress({ mode: 'apply', mapping }, AUTH);
console.log('② 반영', ap.written, '행 · 업로드 달이라 뺀 OUT 실적', ap.outSkippedUploadMonths, '칸 · 두 번째 반영 후', dataRows(g.tab('목표실적_월')).length, '행', n1 === dataRows(g.tab('목표실적_월')).length ? '(불변)' : '(달라짐!)');

// ③ 소계 대조
const tg = dataRows(g.tab('목표실적_월'));
const parsed = g.ctx._offParseLegacyProgress(g.ctx._offLegacyGrid(g.legacy, '26년 진행현황'));
const chRows = g.ctx._offChannelRows(g.ctx._offSS()), start = {};
chRows.forEach(c => { if (c[5]) start[c[0]] = c[5]; });
const grid = g.ctx._offLegacyGrid(g.legacy, '26년 진행현황').values;
let ok = 0; const diff = [];
grid.forEach((row, r) => {
  if (String(row[3]).trim() !== '소계') return;
  const ch = mapping.channels[String(row[2]).trim()];
  parsed.months.forEach(mo => [['inT', 'IN', 5], ['inA', 'IN', 6], ['outT', 'OUT', 5], ['outA', 'OUT', 6]].forEach(([k, type, i]) => {
    const c = mo.cols[k];
    if (c == null || (k === 'outA' && start[ch] && mo.ym >= start[ch])) return;
    const want = row[c] === '' ? 0 : Number(row[c]);
    const got = tg.filter(x => x[0] === mo.ym && x[1] === ch && x[4] === type).reduce((a, x) => a + (Number(x[i]) || 0), 0);
    if (got === want) { ok++; return; }
    const cell = P.ws[XLSX.utils.encode_cell({ r, c })];
    diff.push([ch, mo.ym, k, '이관 ' + got, '원본 소계 ' + want, cell && cell.f ? '수식 ' + cell.f : '수기 값(수식 아님)'].join(' | '));
  }));
});
console.log('③ 소계 대조: 일치', ok, '/ 불일치', diff.length);
diff.forEach(d => console.log('     ' + d));

// ④ 월별 해석 vs 판매원장
const ym = ymArg || pv.months[pv.months.length - 1];
const mon = g.ctx._offGetMonthly({ from: ym, to: ym });
const ledger = {};
dataRows(g.tab('판매원장')).forEach(s => { if (String(s[1]).slice(0, 7) === ym) ledger[s[3]] = (ledger[s[3]] || 0) + Number(s[6]); });
console.log('④ ' + ym + ' 월별 해석 vs 판매원장');
mon.totals.byChannelMonth.filter(t => ledger[t.channelId] != null).forEach(t =>
  console.log('     ' + t.channelId.padEnd(8) + '집계 ' + t.out.actual + ' + 미매칭 ' + t.out.unmatchedQty + ' = ' + (t.out.actual + t.out.unmatchedQty) + ' | 원장 ' + ledger[t.channelId] + ((t.out.actual + t.out.unmatchedQty) === ledger[t.channelId] ? ' OK' : ' DIFF')));

// ④-2 건조기 대분류 합계 = 진행현황 "건조기" 행 + "더에어드라이/에어드라이" 행 (업로드 달 OUT 실적은 원장이라 제외)
{
  const all = g.ctx._offGetMonthly({ from: pv.months[0], to: pv.months[pv.months.length - 1] });
  const DRY = { '건조기': true, '더에어드라이': true, '에어드라이': true };
  let ok = 0; const bad = [];
  pv.channels.forEach(c => {
    const legacyRows = parsed.rows.filter(r => r.channel === c.legacy && DRY[String(r.product).trim()]);
    if (!legacyRows.length) return;
    parsed.months.forEach(mo => [['inT', 'in', 'target'], ['inA', 'in', 'actual'], ['outT', 'out', 'target'], ['outA', 'out', 'actual']].forEach(([k, side, f]) => {
      if (mo.cols[k] == null || (k === 'outA' && start[c.channelId] && mo.ym >= start[c.channelId])) return;
      const want = legacyRows.reduce((a, r) => (r.values[mo.ym][k] == null ? a : (a || 0) + r.values[mo.ym][k]), null);
      const t = all.totals.byCategory.find(x => x.ym === mo.ym && x.channelId === c.channelId && x.category === '건조기');
      const got = t ? t[side][f] : null;
      if ((want || 0) === (got || 0)) ok++; else bad.push(c.channelId + ' ' + mo.ym + ' ' + k + ' 원본 ' + want + ' / 대분류 합계 ' + got);
    }));
  });
  console.log('④-2 건조기 대분류 합계 대조: 일치', ok, '/ 불일치', bad.length);
  bad.forEach(b => console.log('     ' + b));
  const samp = all.totals.byCategory.filter(x => x.category === '건조기' && (x.in.actual || x.in.target)).slice(0, 6);
  samp.forEach(x => console.log('     표본 ' + x.channelId.padEnd(9) + x.ym + ' IN ' + x.in.target + '/' + x.in.actual + ' OUT ' + x.out.target + '/' + x.out.actual + (x.hasCategoryRow ? ' (대분류 행 포함)' : '')));
  const dup = all.warnings.filter(w => /^중복 가능/.test(w));
  console.log('     중복 경고', dup.length ? dup.join(' | ') : '없음');
}

// ⑤ 대조 리포트·납품가
console.log('⑤ 업로드시작월 대조(채널 합계)');
ap.compare.filter(x => x.total).forEach(x => console.log('     ' + x.channelId.padEnd(8) + '진행현황 ' + x.legacy + ' / 원장 ' + x.ledger + ' / 차이 ' + x.diff + ' / 미매칭 ' + x.unmatchedQty));
const pp = g.ctx._offMigratePrices({ mode: 'preview' }, AUTH);
console.log('   납품가: 기준일 ' + pp.baseDate + ' · ' + pp.rows.length + '행 · MN 코드 제안 ' + pp.rows.filter(r => r.suggest.from === 'model-code').length + ' · 모호 ' + pp.rows.filter(r => r.suggest.ambiguous).length);
console.log('   원본 호출:', [...new Set(g.legacy._calls)].join(', '));
