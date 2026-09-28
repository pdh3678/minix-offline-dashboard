/* 트레이더스 분리 실데이터 대조 — 로컬 확인용(테스트 아님, 데이터 파일은 커밋하지 않는다). 출력은 집계값뿐이다.
   운영 오프라인 스프레드시트 xlsx 사본 + samples/의 이마트 포털 파일로, 사용자가 할 순서를 GAS 실코드(목 시트)에서 그대로 돈다:
   offline_setupSheets 재실행 → '기간별매출(상품별)_일별상세' 반영 → '재고현황_상세' 반영.

   실행: XLSX_PATH=<SheetJS 모듈 경로> node scripts/verify-traders-split.js <오프라인.xlsx> <원본 폴더(samples)>
   ① 판매 파일: 이마트 합계 + 트레이더스 합계 = 파일 전체 합계
   ② 재고 파일: 이마트 재고 + 트레이더스 재고 = 파일 상단 현재고 합계
   ③ 재고 파일 점포 판별: 점포마스터(판매 파일에서 익힘) 기준 vs 점포명접두어 기준 — 불일치 목록
   ④ 같은 판매·재고 파일 2번 반영 시 행 수 불변
   ⑤ 트레이더스 SKU 해석(이마트 매핑)·미매칭 중복 없음
   ⑥ 기존 EMART_DAILY_SALES(합계) 파일 반영 차단
   ⑦ 분리 전 이마트 수치 = 분리 후 이마트 + 트레이더스 (9월 OUT 실적·9/28 재고) */
const fs = require('fs'), path = require('path');
const PROJ = path.join(__dirname, '..');
const { loadOfflineGas, dataRows } = require(path.join(PROJ, 'tests', 'lib', 'offline-gas.js'));
const P = require(path.join(PROJ, 'src', 'features', 'offline', 'parsers.js'));
let XLSX;
try { XLSX = require(process.env.XLSX_PATH || 'xlsx'); } catch (e) { console.error('SheetJS가 없습니다. XLSX_PATH=<xlsx 모듈 경로> 로 실행하세요.'); process.exit(2); }
const [offPath, dir] = process.argv.slice(2);
if (!offPath || !dir) { console.error('사용법: node scripts/verify-traders-split.js <오프라인.xlsx> <원본 폴더>'); process.exit(2); }
const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const J = JSON.stringify, AUTH = { email: 'verify@local' };

// ── 운영 시트 사본을 목 시트에(분리 전 상태 그대로 — 채널마스터 6열) ──
const g = loadOfflineGas({ today: TODAY });
const T = g.ctx.OFF_TABS, wb = XLSX.read(fs.readFileSync(offPath));
const tabs = [['README', 'readme'], ['채널마스터', 'channel'], ['제품마스터', 'sku'], ['코드매핑', 'mapping'], ['점포마스터', 'store'], ['판매원장', 'sales'], ['재고_채널일별', 'stockDaily'],
  ['재고_점포최신', 'stockStore'], ['하이마트_누적스냅샷', 'himartSnap'], ['업로드로그', 'uploadLog'], ['미매칭코드', 'unmatched'], ['목표실적_월', 'targets'], ['단가마스터', 'prices'], ['이관로그', 'migrationLog'], ['설정', 'settings']];
tabs.forEach(([name, key]) => {
  const ws = wb.Sheets[name];
  const sh = g.off.insertSheet(name);
  if (!ws) return;
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }).filter((r, i) => i === 0 || r.some(v => v !== ''));
  const W = grid[0].filter(v => v !== '').length;
  grid.forEach((r, i) => { sh._grid[i] = r.slice(0, W).map((v, c) => (i && T[key].text.indexOf(c) >= 0 && v !== '') ? String(v) : v); });
});
const call = (a, d) => JSON.parse(g.ctx._offlineHandle(a, d || {}, AUTH));
const count = () => ['판매원장', '재고_채널일별', '재고_점포최신', '점포마스터', '미매칭코드'].map(n => dataRows(g.tab(n)).length).join('/');
const ym = TODAY.slice(0, 7);

// 분리 전 숫자
const monB = call('offline_getMonthly', { from: ym, to: ym });
const outB = monB.totals.byChannelMonth.find(t => t.channelId === 'emart') || { out: { actual: 0, unmatchedQty: 0 } };
const invB = call('offline_getInventory', {});
const gB = invB.groups.find(x => x.channelId === 'emart' && x.level === 'channel'), cB = invB.channels.find(c => c.channelId === 'emart');
console.log('분리 전(운영 사본): 채널마스터 열 ' + g.tab('채널마스터')._grid[0].length + ' · 판매원장 emart ' + dataRows(g.tab('판매원장')).filter(r => r[3] === 'emart').length + '행 · 점포마스터 emart ' +
  dataRows(g.tab('점포마스터')).filter(r => r[0] === 'emart').length + '곳');
console.log('  ' + ym + ' 이마트 OUT ' + outB.out.actual + ' + 미매칭 ' + outB.out.unmatchedQty + ' · 재고 ' + cB.stockDate + ' ' + gB.total + ' + 미매칭 ' + cB.unmatchedStock);

// 1) setup 재실행 — 채널마스터 확장 + 트레이더스 켜기
const rep = g.ctx.offline_setupSheets();
console.log('\nsetup: 확장 ' + J(rep.extended.map(e => e.tab + '+' + e.added.join('·'))) + ' · 새 탭 ' + J(rep.created) + ' · 헤더 불일치 ' + rep.mismatched.length);
console.log('  채널마스터 ' + J(dataRows(g.tab('채널마스터')).filter(r => /emart|traders/.test(r[0]))));

const files = fs.readdirSync(dir);
const read = f => { const { rows } = P.readWorkbookRows(XLSX, fs.readFileSync(path.join(dir, f))); return { rows, p: P.parseRows(rows, { fileName: f, today: TODAY }) }; };
const up = (f, p) => g.ctx._offUpload(P.toUploadPayload(p, { fileName: f }), AUTH);

// 2) 판매 파일
const salesF = files.filter(f => /일별상세/.test(f)).sort().pop();
const S = read(salesF);
const r1 = up(salesF, S.p);
const fileTotal = S.p.records.sales.reduce((s, x) => s + x.qty, 0);
const byCh = r1.applied.byChannel;
console.log('\n① 판매 파일 ' + salesF + ' (' + S.p.type + ', ' + S.p.period.start + '~' + S.p.period.end + ')');
console.log('   이마트 ' + byCh.emart.qty + ' + 트레이더스 ' + byCh.traders.qty + ' = ' + (byCh.emart.qty + byCh.traders.qty) + ' / 파일 전체 ' + fileTotal + ' → ' + (byCh.emart.qty + byCh.traders.qty === fileTotal ? 'OK' : 'DIFF') +
  ' · 레코드 ' + byCh.emart.rows + '/' + byCh.traders.rows + ' · 교체로 지운 기존 행 ' + r1.applied.salesRemoved + ' · 옮긴 점포 ' + (r1.applied.storesMoved || 0) + ' · 경고 ' + (r1.warnings.join(' / ') || '없음'));
console.log('   판매원장 emart 점포 빈칸 행 남음: ' + dataRows(g.tab('판매원장')).filter(r => r[3] === 'emart' && !r[4] && r[1] >= S.p.period.start && r[1] <= S.p.period.end).length);

// 3) 재고 파일
const stockF = files.filter(f => /재고현황_상세/.test(f)).sort().pop();
const K = read(stockF);
const top = (() => { const h = K.rows.findIndex(r => r.some(v => String(v).replace(/\s/g, '') === '현재고')); const q = K.rows.find((r, i) => i > h && String(r[0]).trim() === '수량'); return q ? Number(q[K.rows[h].findIndex(v => String(v).replace(/\s/g, '') === '현재고')]) : null; })();
const r2 = up(stockF, K.p);
const b2 = r2.applied.byChannel;
console.log('\n② 재고 파일 ' + stockF + ' (기준일 ' + K.p.baseDate + ')');
console.log('   이마트 ' + b2.emart.stock + ' + 트레이더스 ' + b2.traders.stock + ' = ' + (b2.emart.stock + b2.traders.stock) + ' / 상단 현재고 ' + top + ' → ' + (b2.emart.stock + b2.traders.stock === top ? 'OK' : 'DIFF') +
  ' · 점포 ' + b2.emart.stores + '/' + b2.traders.stores + ' · 판별 ' + J(r2.applied.channelVia) + ' · 경고 ' + (r2.warnings.join(' / ') || '없음'));

// ③ 점포 판별 — 점포마스터 기준 vs 접두어 기준
const master = {}; dataRows(g.tab('점포마스터')).forEach(r => { if (r[0] === 'emart' || r[0] === 'traders') master[r[1]] = r[0]; });
const byPrefix = nm => /^TR/.test(nm) ? 'traders' : /^EM/.test(nm) ? 'emart' : '';
const seen = {}, mism = [], noPrefix = [];
K.p.records.stores.forEach(s => {
  if (seen[s.code]) return; seen[s.code] = true;
  const pm = byPrefix(s.name), mm = master[s.code];
  if (!pm) noPrefix.push(s.code + ' ' + s.name + ' → 점포마스터 ' + (mm || '없음'));
  else if (mm && pm !== mm) mism.push(s.code + ' ' + s.name + ' 접두어 ' + pm + ' / 점포마스터 ' + mm);
});
console.log('\n③ 재고 파일 점포 ' + Object.keys(seen).length + '곳 — 접두어와 점포마스터가 모순: ' + mism.length + '곳' + (mism.length ? ' ' + J(mism) : ''));
console.log('   접두어(EM/TR)로 못 가르는 점포 ' + noPrefix.length + '곳(점포마스터로 판별): ' + noPrefix.join(' | '));

// ④ 멱등성
const c1 = count();
up(salesF, S.p); up(stockF, K.p);
console.log('\n④ 판매·재고 파일 2번째 반영 — 판매원장/재고_채널일별/재고_점포최신/점포마스터/미매칭코드 ' + c1 + ' → ' + count() + ' ' + (c1 === count() ? 'OK(불변)' : 'DIFF'));

// ⑤ 트레이더스 SKU 해석·미매칭
const inv = call('offline_getInventory', { channelId: 'traders' });
const tr = inv.channels.find(c => c.channelId === 'traders'), trSku = inv.groups.filter(x => x.channelId === 'traders' && x.level === 'sku');
const trTotal = inv.groups.find(x => x.channelId === 'traders' && x.level === 'channel').total;
console.log('\n⑤ 트레이더스 재고 ' + (trTotal + tr.unmatchedStock) + ' = SKU로 해석 ' + trTotal + ' (' + trSku.length + '개 SKU, 이마트 매핑) + 미매칭 ' + tr.unmatchedStock);
const um = dataRows(g.tab('미매칭코드')), dup = {};
um.forEach(r => { const k = (r[0] === 'traders' ? 'emart' : r[0]) + '|' + r[1]; dup[k] = (dup[k] || 0) + 1; });
console.log('   미매칭코드 ' + um.length + '행 — traders 이름 행 ' + um.filter(r => r[0] === 'traders').length + ' · 중복 ' + Object.keys(dup).filter(k => dup[k] > 1).length + ' · 코드매핑 traders 행 ' + dataRows(g.tab('코드매핑')).filter(r => r[0] === 'traders').length);

// ⑥ 기존 합계 파일 차단
const oldF = files.filter(f => /일별요약/.test(f)).sort().pop();
if (oldF) {
  const O = read(oldF);
  let err = null; try { up(oldF, O.p); } catch (e) { err = e.message; }
  console.log('\n⑥ ' + oldF + ' (' + O.p.type + ') 반영 → ' + (err ? '거절: ' + err : '반영됨!'));
}

// ⑦ 분리 전 = 분리 후 이마트 + 트레이더스
const monA = call('offline_getMonthly', { from: ym, to: ym });
const o = id => monA.totals.byChannelMonth.find(t => t.channelId === id) || { out: { actual: 0, unmatchedQty: 0 } };
const invA = call('offline_getInventory', {});
const st = id => { const gg = invA.groups.find(x => x.channelId === id && x.level === 'channel'), cc = invA.channels.find(c => c.channelId === id); return { d: cc.stockDate, t: gg.total + cc.unmatchedStock }; };
const before = outB.out.actual + outB.out.unmatchedQty, after = o('emart').out.actual + o('emart').out.unmatchedQty + o('traders').out.actual + o('traders').out.unmatchedQty;
console.log('\n⑦ ' + ym + ' OUT(미매칭 포함): 분리 전 이마트 ' + before + ' → 분리 후 이마트 ' + (o('emart').out.actual + o('emart').out.unmatchedQty) + ' + 트레이더스 ' + (o('traders').out.actual + o('traders').out.unmatchedQty) + ' = ' + after +
  ' → ' + (before === after ? 'OK' : 'DIFF(' + (after - before) + ')'));
const se = st('emart'), stt = st('traders');
console.log('   재고(미매칭 포함): 분리 전 이마트 ' + cB.stockDate + ' ' + (gB.total + cB.unmatchedStock) + ' → 분리 후 이마트 ' + se.d + ' ' + se.t + ' + 트레이더스 ' + stt.d + ' ' + stt.t + ' = ' + (se.t + stt.t) +
  ' → ' + ((cB.stockDate === se.d && gB.total + cB.unmatchedStock === se.t + stt.t) ? 'OK' : '비교 기준일 확인'));
console.log('   ' + ym + ' 트레이더스 OUT 원천: ' + (monA.rows.filter(r => r.channelId === 'traders').map(r => r.model + ' ' + r.out.actual + '(' + r.out.source + ')').join(', ') || '없음'));
