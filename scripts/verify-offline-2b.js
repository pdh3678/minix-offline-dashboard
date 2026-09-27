/* 2-B 실데이터 대조 — 로컬 확인용(테스트 아님, 데이터 파일은 커밋하지 않는다). 출력은 집계값뿐이다.
   오프라인 스프레드시트를 xlsx로 내보낸 파일 + 협력사 원본 파일 폴더로, GAS 실코드(목 시트)와 프론트 실코드(샌드박스)를 같이 돌려
   "원본 파일 합계 = GAS 응답 = 화면에 그린 숫자"를 대조한다.

   실행: XLSX_PATH=<SheetJS 모듈 경로> node scripts/verify-offline-2b.js <오프라인.xlsx> <원본 폴더(samples)> [진행현황.xlsx]
         진행현황을 주면 목표를 이관(제안 매핑)한 상태로 목표 쪽 대조(9월 OUT, 연간 보기 = 월별 입력)를 한다.
   ① 재고: 원본 파일 재고 합계(이마트는 상단 요약의 현재고) = getInventory 채널 합(SKU + 미매칭) = 재고 현황 [전체] 합계 줄
   ② 9월 채널별 OUT 실적: 채널 현황 카드 = 목표 관리 월별 입력 = offline_getMonthly, 그리고 + 미매칭 = 판매원장 9월 합
   ③ 연간 보기 월 합계 = 월별 입력 탭 합계(1~12월, IN·OUT 목표·실적)
   ④ 재고일수 표본 3건 — 원장 행에서 따로 계산(정상 재고 ÷ (창 판매 ÷ N))해 GAS 값과 비교 */
const fs = require('fs'), path = require('path');
const PROJ = path.join(__dirname, '..');
const { loadOfflineGas } = require(path.join(PROJ, 'tests', 'lib', 'offline-gas.js'));
const { loadFrontend } = require(path.join(PROJ, 'tests', 'lib', 'front-sandbox.js'));
const P = require(path.join(PROJ, 'src', 'features', 'offline', 'parsers.js'));
let XLSX;
try { XLSX = require(process.env.XLSX_PATH || 'xlsx'); } catch (e) { console.error('SheetJS가 없습니다. XLSX_PATH=<xlsx 모듈 경로> 로 실행하세요.'); process.exit(2); }
const [offPath, sampleDir, legacyPath] = process.argv.slice(2);
if (!offPath || !sampleDir) { console.error('사용법: node scripts/verify-offline-2b.js <오프라인.xlsx> <원본 폴더> [진행현황.xlsx]'); process.exit(2); }
const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const J = JSON.stringify;
const ADMIN = 'p_dh_3678@athomecorp.com';

// ── GAS 목 환경 ──
function tab(wb, name) {
  const ws = wb.Sheets[name];
  const R = XLSX.utils.decode_range(ws['!ref']); R.s.c = 0; R.s.r = 0; ws['!ref'] = XLSX.utils.encode_range(R);
  return { grid: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }), merges: (ws['!merges'] || []).map(m => [m.s.r + 1, m.s.c + 1, m.e.r - m.s.r + 1, m.e.c - m.s.c + 1]) };
}
const lw = legacyPath ? XLSX.read(fs.readFileSync(legacyPath)) : null;
const g = loadOfflineGas({ setup: true, today: TODAY, legacy: lw ? { '26년 진행현황': tab(lw, '26년 진행현황'), '납품가 수수료': tab(lw, '납품가 수수료') } : undefined });
const T = g.ctx.OFF_TABS, wb = XLSX.read(fs.readFileSync(offPath));
const rowsOf = (name, key) => !wb.Sheets[name] ? [] : XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' }).slice(1).filter(r => r.some(v => v !== ''))
  .map(r => T[key].headers.map((h, i) => { const v = r[i]; return v === undefined ? '' : (T[key].text.indexOf(i) >= 0 ? String(v) : v); }));
[['채널마스터', 'channel'], ['제품마스터', 'sku'], ['코드매핑', 'mapping'], ['점포마스터', 'store'], ['판매원장', 'sales'], ['재고_채널일별', 'stockDaily'],
  ['재고_점포최신', 'stockStore'], ['업로드로그', 'uploadLog'], ['미매칭코드', 'unmatched'], ['목표실적_월', 'targets'], ['단가마스터', 'prices'], ['설정', 'settings']].forEach(([n, k]) => {
  const rows = rowsOf(n, k);
  if (!rows.length) return;
  const sh = g.tab(n); sh._grid.length = 1;
  g.ctx._offWriteBlock(sh, T[k], 2, rows);
});
g.tab('채널마스터')._grid.forEach((r, i) => { if (i && !r[5] && g.ctx.OFF_UPLOAD_START_SEED[r[0]]) r[5] = g.ctx.OFF_UPLOAD_START_SEED[r[0]]; });
const AUTH = { email: ADMIN };
if (lw) {
  const pv = g.ctx._offMigrateProgress({ mode: 'preview' }, AUTH);
  const mapping = { channels: {}, products: {} };
  pv.channels.forEach(c => { mapping.channels[c.legacy] = c.channelId; });
  pv.products.forEach(p => { mapping.products[p.legacy] = p.suggest.level === 'category' ? { category: p.suggest.category } : { line: p.suggest.line, model: p.suggest.model }; });
  const ap = g.ctx._offMigrateProgress({ mode: 'apply', mapping }, AUTH);
  console.log('(진행현황 이관 ' + ap.written + '행을 얹어 대조 — 운영 시트에는 반영하지 않음)');
}
const call = (a, d) => JSON.parse(g.ctx._offlineHandle(a, d || {}, AUTH));

// ── 프론트 샌드박스(GAS 직결) ──
const { ctx: F, X } = loadFrontend(PROJ, 'get OF(){return OFFLINE_FILTER;}, get TG(){return _TG;}, get TGA(){return _TGA;}');
const box = {};
F.document.getElementById = id => (box[id] = box[id] || { id, innerHTML: '', value: '', textContent: '', dataset: {}, style: {}, getContext: () => ({}),
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
F.Chart = function () { return { destroy() {} }; };
F._getToken = () => 'T';
F._gasFetch = async (url, opts) => { const b = JSON.parse(opts.body); return call(b.action, b.data); };
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0)); };
const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const n = s => Number(String(s).replace(/,/g, ''));

(async function main() {
  const inv = call('offline_getInventory', {});
  const Gp = (ch, lv, k) => inv.groups.find(x => x.channelId === ch && x.level === lv && x.key === (k || ''));

  // ① 재고 — 원본 파일(채널별 가장 최근 기준일 파일)
  const files = fs.readdirSync(sampleDir).filter(f => /\.(xlsx|xls|csv)$/i.test(f));
  const fileTot = {};
  files.forEach(f => {
    const { rows } = P.readWorkbookRows(XLSX, fs.readFileSync(path.join(sampleDir, f)));
    const p = P.parseRows(rows, { fileName: f, today: TODAY });
    if (!p.ok || p.kind === 'period') return;
    const prev = fileTot[p.channelId];
    if (prev && prev.date >= p.baseDate) return;
    let sum = p.records.channelStock.reduce((s, x) => s + x.stock, 0), how = '파일 재고 열 합계';
    if (p.type === 'EMART_STOCK') { // 상단 요약 블록 — 구분 '수량' 행의 현재고
      const hdr = rows.findIndex(r => r.some(v => String(v).replace(/\s/g, '') === '현재고'));
      const qtyRow = rows.find((r, i) => i > hdr && String(r[0]).trim() === '수량');
      if (hdr >= 0 && qtyRow) { sum = Number(qtyRow[rows[hdr].findIndex(v => String(v).replace(/\s/g, '') === '현재고')]); how = '상단 요약 현재고'; }
    }
    fileTot[p.channelId] = { date: p.baseDate, sum, how, file: f };
  });
  F.navPage('offline-inventory', null);
  await settle();
  F._oivSetType('all');
  const invHtml = box['page-offline-inventory'].innerHTML;
  const heads = [...invHtml.matchAll(/<th>([^<]+)<div class="of-sub">/g)].map(m => m[1]);
  const totRow = (invHtml.match(/<tr class="of-lv-total">([\s\S]*?)<\/tr>/) || [])[1] || '';
  const screen = {};
  [...totRow.matchAll(/<td>([\d,]+)<\/td>/g)].forEach((m, i) => { if (heads[i]) screen[heads[i]] = n(m[1]); });
  console.log('\n① 재고 합계 (재고구분 전체, 미매칭 포함)');
  console.log('채널 | 원본 파일(기준일 · 방법) | GAS SKU 합 + 미매칭 | 재고 현황 [전체] 합계 줄 | 일치');
  inv.channels.filter(c => c.hasStock).forEach(c => {
    const f = fileTot[c.channelId], gt = Gp(c.channelId, 'channel').total + c.unmatchedStock, sc = screen[c.name];
    console.log([c.name, f ? f.sum + ' (' + f.date + ' · ' + f.how + ')' : '파일 없음', Gp(c.channelId, 'channel').total + ' + ' + c.unmatchedStock + ' = ' + gt, sc,
      f && f.date === c.stockDate && f.sum === gt && sc === gt ? 'OK' : (f && f.date !== c.stockDate ? '기준일 다름(' + c.stockDate + ')' : 'DIFF')].join(' | '));
  });

  // ② 9월 채널별 OUT 실적
  const ym = process.env.YM || TODAY.slice(0, 7);
  X.OF.ym = ym;
  F.navPage('offline-channels', null);
  await settle();
  const chHtml = box['page-offline-channels'].innerHTML;
  X.TG.ym = ym;
  F.navPage('admin-targets', null);
  await settle();
  const tgT = F._tgTotals();
  const mon = call('offline_getMonthly', { from: ym, to: ym });
  const ledger = {};
  call('offline_getMasters');
  rowsOf('판매원장', 'sales').forEach(s => { if (String(s[1]).slice(0, 7) === ym) ledger[s[3]] = (ledger[s[3]] || 0) + Number(s[6]); });
  console.log('\n② ' + ym + ' 채널별 OUT 실적');
  console.log('채널 | 채널 현황 카드 | 목표 관리 월별 입력 | offline_getMonthly | + 미매칭 = 판매원장 ' + ym + ' 합 | 일치');
  mon.totals.byChannelMonth.forEach(t => {
    const i = chHtml.indexOf(`_ofGo('offline-channel','${t.channelId}')`);
    const card = i < 0 ? '' : text(chHtml.slice(i, chHtml.indexOf('<div class="of-card"', i + 10) < 0 ? chHtml.length : chHtml.indexOf('<div class="of-card"', i + 10)));
    const m = /OUT [^실]*실적 ([\d,—]+)/.exec(card);
    const cv = m ? (m[1] === '—' ? null : n(m[1])) : '(카드 없음)';
    const tv = (tgT['ch:' + t.channelId] || {}).outA;
    const lg = ledger[t.channelId];
    const ok = cv === t.out.actual && (tv == null ? t.out.actual == null : tv === t.out.actual) && (lg == null || t.out.actual + t.out.unmatchedQty === lg);
    console.log([t.channelId, cv, tv == null ? '—' : tv, t.out.actual, lg == null ? '(원장 없음 — 입력·이관 값)' : t.out.actual + ' + ' + t.out.unmatchedQty + ' = ' + (t.out.actual + t.out.unmatchedQty) + ' / 원장 ' + lg, ok ? 'OK' : 'DIFF'].join(' | '));
  });

  // ③ 연간 보기 = 월별 입력
  F._tgSetTab('annual');
  await settle();
  let ok3 = 0; const bad3 = [];
  for (let m = 1; m <= 12; m++) {
    const y = ym.slice(0, 4) + '-' + String(m).padStart(2, '0');
    X.TG.ym = y; X.TG.tab = 'monthly';
    await F._tgLoad();
    const mt = F._tgTotals().all || {};
    ['IN', 'OUT'].forEach(side => {
      X.TGA.side = side;
      const at = (F._tgaTotals().all || {})[y] || { t: null, a: null };
      const want = side === 'IN' ? [mt.inT, mt.inA] : [mt.outT, mt.outA];
      if ((at.t || 0) === (want[0] || 0) && (at.a || 0) === (want[1] || 0)) ok3++; else bad3.push(y + ' ' + side + ' 연간 ' + at.t + '/' + at.a + ' vs 월별 ' + want.join('/'));
    });
  }
  console.log('\n③ 연간 보기 월 합계 = 월별 입력 탭 합계(1~12월 × IN·OUT, 목표·실적): 일치 ' + ok3 + ' / 불일치 ' + bad3.length);
  bad3.forEach(b => console.log('   ' + b));

  // ④ 재고일수 표본 — 채널마다 정상재고가 가장 많은 SKU를 원장 행에서 따로 계산
  const N = inv.windowDays, maps = {}, logLast = {};
  rowsOf('코드매핑', 'mapping').forEach(m => { if (m[2]) maps[m[0] + '|' + m[1]] = m; });
  rowsOf('업로드로그', 'uploadLog').forEach(r => {
    if (r[11] !== '성공' || !/SALES/.test(r[4])) return;
    const b = String(r[6]).split('~').pop();
    if (b > (logLast[r[5]] || '')) logLast[r[5]] = b;
  });
  const sd = rowsOf('재고_채널일별', 'stockDaily'), sl = rowsOf('판매원장', 'sales');
  console.log('\n④ 재고일수 표본 (N = ' + N + '일, 창 끝 = 업로드로그의 판매 최신 기준일)');
  console.log('채널 · SKU | 정상재고(최신 기준일 정상 코드 합) | 창 판매 합(기간종료일 ∈ 창) | 수기 재고일수 | GAS 재고일수 | 일치');
  inv.channels.filter(c => c.hasStock && c.hasSales).forEach(c => {
    const s = inv.groups.filter(x => x.channelId === c.channelId && x.level === 'sku' && x.dailyAvg > 0).sort((a, b) => b.stock['정상'] - a.stock['정상'])[0];
    if (!s) return;
    const last = sd.filter(r => r[1] === c.channelId).reduce((d, r) => r[0] > d ? r[0] : d, '');
    const stock = sd.filter(r => r[1] === c.channelId && r[0] === last && maps[c.channelId + '|' + r[2]] && maps[c.channelId + '|' + r[2]][2] === s.skuId && maps[c.channelId + '|' + r[2]][3] === '정상').reduce((a, r) => a + Number(r[3]), 0);
    const end = logLast[c.channelId], from = new Date(Date.parse(end + 'T00:00:00Z') - (N - 1) * 86400000).toISOString().slice(0, 10);
    const qty = sl.filter(r => r[3] === c.channelId && r[1] >= from && r[1] <= end && maps[c.channelId + '|' + r[5]] && maps[c.channelId + '|' + r[5]][2] === s.skuId).reduce((a, r) => a + Number(r[6]), 0);
    const days = stock / (qty / N);
    console.log([c.name + ' · ' + s.name, stock + ' (' + last + ')', qty + ' (' + from + '~' + end + ')', stock + ' ÷ (' + qty + ' ÷ ' + N + ') = ' + days.toFixed(2), s.days.toFixed(2), Math.abs(days - s.days) < 1e-9 ? 'OK' : 'DIFF'].join(' | '));
  });

  // ⑤ 미매칭
  console.log('\n⑤ 미매칭 — 합계에서 빠지지 않고 따로');
  inv.channels.filter(c => c.unmatchedStock || c.unmatchedQty).forEach(c =>
    console.log('   ' + c.name + ': 재고 ' + c.unmatchedStock + ' · 최근 ' + N + '일 판매 ' + c.unmatchedQty + ' — 코드 ' + inv.unmatched.filter(u => u.channelId === c.channelId).map(u => u.code + '(' + u.stock + ')').join(', ')));
  console.log('   화면 안내: ' + (/매핑 안 된 코드 — 재고/.test(text(invHtml)) ? '재고 현황에 미매칭 안내·코드 매핑 링크 있음' : '없음!'));
  process.exit(0); // 샌드박스의 로그인·회고 스크립트 대기 타이머를 기다리지 않는다
})().catch(e => { console.error(e); process.exit(1); });
