/* 재고 기준일 보정 — 전자랜드 현재고·이마트 재고현황_상세(트레이더스 포함)는 파일명 날짜의 전일 마감 재고. 파서(브라우저 실코드) → GAS 실코드(목 시트).

   지키려는 성질:
     · offline_setupSheets가 채널마스터에 재고기준일오프셋 열을 멱등하게 붙인다 — himart 0, etland·emart·traders −1, 나머지 0(사람이 고친 값은 그대로)
     · 업로드: 재고 기준일 = 파일명 날짜 + 채널 오프셋(스냅샷형만). 새 화면은 미리보기에서 정해 보내고(fileDate와 함께) 서버는 그대로 쓴다,
       옛 화면(fileDate 없음)이면 서버가 오프셋을 더한다. 직접 고른 기준일은 그대로. 하이마트는 파일명 날짜 그대로(판매 계산 불변)
     · 업로드로그 기준일 = 보정된 재고 기준일 + 경고 열에 "재고 기준일 …" 표시
     · 데이터 현황(재고 마지막 기준일)·재고 지표 기준일·지연 경고·재고 추이 날짜가 보정된 기준일로
     · offline_fixStockDates: 옛 업로드의 재고_채널일별·재고_점포최신·업로드로그 기준일을 채널 오프셋만큼(−1일), 새 기준 업로드는 그대로,
       판매원장·하이마트 불변, 같은 (기준일, 채널)에 업로드가 둘이면 늦은 업로드만 남기고 보고, 설정 탭에 완료 기록 → 두 번째 실행은 건너뜀
     · 업로드 화면: "파일명 날짜 9/25 → 재고 기준일 9/24 (전일 기준)", 기준일은 계속 수정 가능, 채널마스터가 늦게 오면 다시 판별

   실행: node tests/offline-stock-date.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadOfflineGas, dataRows } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const { loadFrontend } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
const P = require(path.join(__dirname, '..', 'src', 'features', 'offline', 'parsers.js'));
const PROJ = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 700) : '')); }
}
const J = JSON.stringify;
const TODAY = '2026-09-29';
const AUTH = { email: 'tester@athomecorp.com' };
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0)); };

// ── 픽스처(합성) ──
function etlandStock(lines) { // [지점코드, 모델명, 재고]
  return [['현 재고'], ['거래처코드', '거래처명', '지부', '입고지점코드', '입고지점', '품목', '모델명', '설명', '재고수량', '타지점입고 예정수량', '합계', '단가', '재고금액', '판매 예약수량']]
    .concat(lines.map(l => ['1', '가상', '중부', l[0], '점' + l[0], 'KREF', l[1], '가상 ' + l[1], String(l[2]), '0', '0', '1', '1', '0']));
}
function emartStock(lines) { // [점포명, 점포코드, 상품코드, 현재수량]
  return [['구분'], ['조회일자', '점포명', '점포코드', '상품명', '현재수량', '매입량', '상품코드', '매출량']]
    .concat(lines.map(l => ['202609', l[0], l[1], '가상', l[3], 0, l[2], 0]));
}
function himart(entries) { // { 'S1|C1': [당월실판매, 당월판매, 금주판매, 당일판매, 잔여재고] }
  return [['지사명', '인도처코드', '인도처명', '상품코드', '상품명', '당월실판매', '당월판매', '금주판매', '당일판매', '잔여재고', '회전율']]
    .concat(Object.keys(entries).map(k => { const [s, c] = k.split('|'); return ['가상지사', s, s + 'HM', c, '가상 ' + c].concat(entries[k], [0]); }));
}
const channels = g => g.ctx._offReadRows(g.tab('채널마스터'), g.ctx.OFF_TABS.channel);
const offsets = g => { const o = {}; channels(g).forEach(r => { const v = g.ctx._offStockOffsetOf(r); if (v) o[r[0]] = v; }); return o; };
// 새 화면: 채널마스터 오프셋으로 파싱 → fileDate와 함께 보냄 / 옛 화면: 오프셋 없이 파싱 → fileDate 없음
function upNew(g, rows, fileName, edits) {
  const r = P.parseRows(rows, Object.assign({ fileName, today: TODAY, stockOffsets: offsets(g) }, edits && edits.baseDate ? { baseDate: edits.baseDate } : {}));
  if (!r.ok) throw new Error(r.error);
  return { parsed: r, res: g.ctx._offUpload(P.toUploadPayload(r, Object.assign({ fileName, baseDate: r.baseDate }, edits || {})), AUTH) };
}
function upOld(g, rows, fileName) {
  const r = P.parseRows(rows, { fileName, today: TODAY });
  const payload = P.toUploadPayload(r, { fileName, baseDate: r.baseDate });
  delete payload.meta.fileDate; // 이 기능 전의 화면은 fileDate를 몰랐다
  return g.ctx._offUpload(payload, AUTH);
}
// 목 Utilities.getUuid는 고정값이라 같은 초의 업로드 id가 겹친다 — 실제처럼 업로드마다 다른 id가 나오게
function uniqueIds(g) { let n = 0; g.ctx.Utilities.getUuid = () => String(++n).padStart(4, '0') + '-uuid'; return g; }
const setOffsets = (g, map) => { const T = g.ctx.OFF_TABS, sh = g.tab('채널마스터'), rows = channels(g); rows.forEach(r => { r[9] = map[r[0]] || 0; }); g.ctx._offWriteAll(sh, T.channel, rows, rows.length); };

(function main() {
  console.log('\n[1] 채널마스터 재고기준일오프셋 열 — 새로 만들 때 · 기존 탭에 덧붙일 때');
  {
    const g = uniqueIds(loadOfflineGas({ setup: true, today: TODAY }));
    const ch = channels(g);
    check('새 시트: 재고기준일오프셋 = himart 0 · etland/emart/traders −1 · 나머지 0', ch.map(r => r[0] + '=' + r[9]).join() === 'himart=0,etland=-1,emart=-1,traders=-1,shinsegae=0,theablen=0,special=0', ch.map(r => r[9]));
    check('헤더 10열', J(g.tab('채널마스터')._grid[0].slice(0, 10)) === J(['channel_id', '채널명', '유형', '활성', '정렬순서', '업로드시작월', '원천업태명', '점포명접두어', '코드체계채널', '재고기준일오프셋']));
    // 트레이더스 분리 이후 모양(9열)으로 되돌린 뒤 — 사람이 바꾼 값이 있는 상태
    const sh = g.tab('채널마스터');
    sh._grid.forEach(row => { row.length = 9; });
    sh._grid[1][3] = 'N'; // 하이마트 활성을 사람이 바꿔 둠
    const rep = g.ctx.offline_setupSheets();
    check('9열 탭 → 재고기준일오프셋 열만 덧붙임(보고)', rep.extended.length === 1 && J(rep.extended[0].added) === J(['재고기준일오프셋']), rep.extended);
    const ch2 = channels(g);
    check('  ↳ 오프셋 초기값 채움, 다른 열은 그대로(트레이더스를 다시 켜지 않음·하이마트 활성 N 유지)', ch2.map(r => r[9]).join() === '0,-1,-1,-1,0,0,0' && ch2[0][3] === 'N' && ch2[3][8] === 'emart', ch2);
    sh._grid[2][9] = 0; // 사람이 전자랜드 오프셋을 0으로 바꿈
    const rep2 = g.ctx.offline_setupSheets();
    check('다시 실행해도 확장 없음, 사람이 고친 오프셋 그대로', rep2.extended.length === 0 && channels(g)[1][9] === 0, rep2.extended);
    check('README 채널마스터 설명에 재고기준일오프셋', dataRows(g.tab('README')).some(r => r[0] === '채널마스터' && /재고기준일오프셋/.test(r[1])));
    check('_offStockOffsetOf — 빈칸·소수·큰 값은 0', g.ctx._offStockOffsetOf(['x', '', '', '', '', '', '', '', '', '']) === 0 && g.ctx._offStockOffsetOf([0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5]) === 0 && g.ctx._offStockOffsetOf([0, 0, 0, 0, 0, 0, 0, 0, 0, -30]) === 0 && g.ctx._offStockOffsetOf([0, 0, 0, 0, 0, 0, 0, 0, 0, -1]) === -1);
  }

  console.log('\n[2] 업로드 — 재고 기준일 = 파일명 날짜 + 채널 오프셋');
  {
    const g = uniqueIds(loadOfflineGas({ setup: true, today: TODAY }));
    const m = JSON.parse(g.ctx._offlineHandle('offline_getMasters', {}, AUTH));
    check('마스터 채널에 stockOffset', m.channels.find(c => c.channelId === 'etland').stockOffset === -1 && m.channels.find(c => c.channelId === 'himart').stockOffset === 0);
    const a = upNew(g, etlandStock([['302001', 'MNKR-999G', 2]]), '현재고_2026-09-25_124812.xls');
    check('새 화면: 전자랜드 9/25 파일 → 미리보기 9/24, 서버가 그대로 저장', a.parsed.baseDate === '2026-09-24' && dataRows(g.tab('재고_채널일별')).every(r => r[0] === '2026-09-24') && dataRows(g.tab('재고_점포최신'))[0][0] === '2026-09-24');
    let log = dataRows(g.tab('업로드로그')).pop();
    check('업로드로그 기준일 = 재고 기준일 9/24, 경고 열에 "재고 기준일 2026-09-24 (파일명 날짜 2026-09-25)"', log[6] === '2026-09-24' && /재고 기준일 2026-09-24 \(파일명 날짜 2026-09-25\)/.test(log[10]), log);
    const b = upOld(g, etlandStock([['302001', 'MNKR-999G', 3]]), '현재고_2026-09-26_124812.xls');
    check('옛 화면(fileDate 없음): 서버가 오프셋을 더해 9/25로 저장 + 표시', dataRows(g.tab('재고_채널일별')).some(r => r[0] === '2026-09-25' && r[3] === 3) && b.warnings.some(w => /재고 기준일 2026-09-25 \(파일명 날짜 2026-09-26 -1일/.test(w)), b.warnings);
    const c = upNew(g, etlandStock([['302001', 'MNKR-999G', 4]]), '현재고_2026-09-27_124812.xls', { baseDate: '2026-09-27' });
    check('직접 고른 기준일(9/27, 파일명 날짜와 같음)은 그대로 — 서버가 다시 빼지 않음', dataRows(g.tab('재고_채널일별')).some(r => r[0] === '2026-09-27' && r[3] === 4) && c.res.warnings.some(w => /파일명 날짜 그대로/.test(w)), c.res.warnings);
    const e = upNew(g, emartStock([['EM분당점', '1003', '8800000000011', 5], ['TR구성점', '2001', '8800000000011', 7]]), '재고현황_상세_20260928101559.xlsx');
    const d = dataRows(g.tab('재고_채널일별')).filter(r => r[1] === 'emart' || r[1] === 'traders');
    check('이마트 재고현황_상세 9/28 → 이마트·트레이더스 모두 9/27', e.parsed.baseDate === '2026-09-27' && d.length === 2 && d.every(r => r[0] === '2026-09-27') && d.map(r => r[1]).sort().join() === 'emart,traders', d);
    const mb = upNew(g, etlandStock([['302001', 'MNKR-999G', 6]]), '현재고_2026-10-01_090000.xls');
    check('월말 경계 — 10/1 파일 → 9/30', mb.parsed.baseDate === '2026-09-30' && dataRows(g.tab('재고_채널일별')).some(r => r[0] === '2026-09-30'));
    const h = upNew(g, himart({ 'S1|C1': [2, 3, 1, 1, 10] }), '판매재고현황_20260924.xlsx');
    const hs = dataRows(g.tab('판매원장')).filter(r => r[3] === 'himart');
    check('하이마트 — 기준일 9/24 그대로, 판매(9/1~9/24 누적) 계산 그대로, 표시 없음', h.parsed.baseDate === '2026-09-24' && dataRows(g.tab('재고_채널일별')).some(r => r[1] === 'himart' && r[0] === '2026-09-24') &&
      hs.length === 1 && hs[0][0] === '2026-09-01' && hs[0][1] === '2026-09-24' && hs[0][6] === 3 && !h.res.warnings.some(w => /재고 기준일/.test(w)), { hs, w: h.res.warnings });
    // 화면 쪽 기준일 — 데이터 현황·재고 지표·지연 경고·재고 추이
    const st = JSON.parse(g.ctx._offlineHandle('offline_getStatus', {}, AUTH));
    check('데이터 현황: 전자랜드 재고 마지막 기준일 = 9/30(10/1 파일), 이마트·트레이더스 = 9/27', st.channels.find(c => c.channelId === 'etland').stockLast === '2026-09-30' &&
      st.channels.find(c => c.channelId === 'emart').stockLast === '2026-09-27' && st.channels.find(c => c.channelId === 'traders').stockLast === '2026-09-27', st.channels);
    const inv = JSON.parse(g.ctx._offlineHandle('offline_getInventory', {}, AUTH));
    const tr = inv.channels.find(c => c.channelId === 'traders');
    check('재고 지표 기준일(트레이더스 9/27) · 지연 경고는 보정된 날짜 기준(오늘 9/29 → 2일, 경고 아님)', tr.stockDate === '2026-09-27' && tr.stockAge === 2 && tr.staleStock === false, tr);
    const trend = JSON.parse(g.ctx._offlineHandle('offline_getInventoryTrend', { from: '2026-09-20', to: '2026-10-05', channelId: 'etland' }, AUTH));
    check('재고 추이 날짜 = 재고 기준일(9/24·9/25·9/27·9/30)', J(trend.dates) === J(['2026-09-24', '2026-09-25', '2026-09-27', '2026-09-30']), trend.dates);
  }

  console.log('\n[3] offline_fixStockDates — 옛 데이터 1회 보정');
  {
    const g = uniqueIds(loadOfflineGas({ setup: true, today: TODAY }));
    const SEED = { himart: 0, etland: -1, emart: -1, traders: -1 };
    // 이 기능 전 상태를 만든다: 오프셋 0으로 옛 화면 업로드(파일명 날짜 그대로, 표시 없음)
    setOffsets(g, {});
    // (옛 9/25 파일을 두면 새 9/26 파일(→ 9/25)이 업로드 때 그 날짜를 통째로 교체한다 — 그래서 보정은 새 기준 업로드보다 먼저 돌려야 한다)
    upOld(g, etlandStock([['302001', 'A', 1]]), '현재고_2026-09-24_124812.xls');
    upOld(g, etlandStock([['302001', 'A', 2]]), '현재고_2026-09-26_124812.xls');
    upOld(g, emartStock([['EM분당점', '1003', 'E1', 5], ['TR구성점', '2001', 'E1', 7]]), '재고현황_상세_20260928101559.xlsx');
    upOld(g, himart({ 'S1|H1': [1, 1, 1, 1, 9] }), '판매재고현황_20260928.xlsx');
    const salesBefore = J(dataRows(g.tab('판매원장')));
    const hmStock = J(dataRows(g.tab('재고_채널일별')).filter(r => r[1] === 'himart'));
    // 오프셋을 켜고(setup이 채운 값) 새 기준 업로드 하나 — 9/26 파일 = 9/25(표시 있음). 옛 9/26 업로드를 옮기면 9/25가 겹친다
    setOffsets(g, SEED);
    const nw = upNew(g, etlandStock([['302001', 'A', 20], ['302001', 'B', 1]]), '현재고_2026-09-26_130000.xls');
    check('준비: 새 기준 업로드(9/26 파일 → 9/25, 표시)', nw.parsed.baseDate === '2026-09-25' && /재고 기준일/.test(dataRows(g.tab('업로드로그')).pop()[10]));
    const rep = g.ctx.offline_fixStockDates();
    check('보정 실행 — 채널 오프셋(etland·emart·traders −1)', rep.done && J(rep.channels) === J({ etland: -1, emart: -1, traders: -1 }), rep);
    const daily = dataRows(g.tab('재고_채널일별'));
    const et = daily.filter(r => r[1] === 'etland').map(r => r[0] + '|' + r[2] + '|' + r[3]).sort();
    check('재고_채널일별 — 옛 9/24 → 9/23, 옛 9/26 → 9/25는 새 9/25 업로드와 겹쳐 새 것(늦은 업로드)만 남김', J(et) === J(['2026-09-23|A|1', '2026-09-25|A|20', '2026-09-25|B|1']), et);
    check('  ↳ 중복 보고(9/25 전자랜드, 남긴 것 = 새 업로드)', rep.duplicates.length === 1 && rep.duplicates[0].date === '2026-09-25' && rep.duplicates[0].channelId === 'etland' && rep.duplicates[0].kept === nw.res.uploadId && rep.duplicateRows === 1, rep.duplicates);
    check('  ↳ 이마트·트레이더스 9/28 → 9/27', daily.filter(r => r[1] === 'emart' || r[1] === 'traders').every(r => r[0] === '2026-09-27'));
    check('  ↳ 하이마트 재고·판매원장은 그대로', J(daily.filter(r => r[1] === 'himart')) === hmStock && J(dataRows(g.tab('판매원장'))) === salesBefore);
    const store = dataRows(g.tab('재고_점포최신'));
    check('재고_점포최신 — 채널마다 최근 기준일 한 벌(전자랜드 새 9/25, 이마트·트레이더스 9/27, 하이마트 9/28)', J([...new Set(store.map(r => r[1] + '=' + r[0]))].sort()) === J(['emart=2026-09-27', 'etland=2026-09-25', 'himart=2026-09-28', 'traders=2026-09-27']), store.map(r => r[1] + '=' + r[0]));
    const logs = dataRows(g.tab('업로드로그'));
    check('업로드로그 — 옛 재고 업로드 기준일 −1(9/23·9/25·9/27), 새 업로드(9/25)·하이마트(9/28) 그대로', J(logs.map(r => r[4] + '=' + r[6])) === J(['ETLAND_STOCK=2026-09-23', 'ETLAND_STOCK=2026-09-25', 'EMART_STOCK=2026-09-27', 'HIMART_SALES_STOCK=2026-09-28', 'ETLAND_STOCK=2026-09-25']), logs.map(r => r[4] + '=' + r[6]));
    check('보정 건수 보고(채널일별 옛 4행 · 점포최신 · 로그 3행)', rep.stockDaily === 4 && rep.uploadLog === 3 && rep.stockStore > 0, rep);
    const set = dataRows(g.tab('설정')).find(r => r[0] === '재고기준일보정_완료');
    check('설정 탭에 재고기준일보정_완료 = 1 + 시각·건수', set && set[1] === 1 && /보정 — 재고_채널일별 4행/.test(set[2]), set);
    const st = JSON.parse(g.ctx._offlineHandle('offline_getStatus', {}, AUTH));
    check('데이터 현황도 보정된 기준일(이마트·트레이더스 재고 9/27)', st.channels.find(c => c.channelId === 'emart').stockLast === '2026-09-27' && st.channels.find(c => c.channelId === 'traders').stockLast === '2026-09-27');
    const again = g.ctx.offline_fixStockDates();
    check('두 번째 실행은 건너뜀(이중 보정 없음)', again.skipped === true && /이미 보정했습니다/.test(again.reason) && J(dataRows(g.tab('재고_채널일별'))) === J(daily), again);
    // 목 GAS는 전역을 공유한다 — 여기부터는 새로 띄운 한 벌씩만 쓴다
    const g2 = loadOfflineGas({ setup: true, today: TODAY });
    g2.tab('채널마스터')._grid.forEach(row => { row.length = 9; });
    let err = '';
    try { g2.ctx.offline_fixStockDates(); } catch (e) { err = e.message; }
    check('채널마스터에 오프셋 열이 없으면 setup을 먼저 하라고 안내(아무것도 쓰지 않음)', /offline_setupSheets를 먼저 실행/.test(err) && !dataRows(g2.tab('설정')).some(r => r[0] === '재고기준일보정_완료'), err);
    const setOnly = loadOfflineGas({ setup: true, today: TODAY });
    setOffsets(setOnly, {});
    const z = setOnly.ctx.offline_fixStockDates();
    check('오프셋이 모두 0이면 옮길 것 없음(완료 표시도 남기지 않음)', z.skipped && !dataRows(setOnly.tab('설정')).some(r => r[0] === '재고기준일보정_완료'), z);
  }

  (async () => {
    console.log('\n[4] 업로드 화면 — "파일명 날짜 → 재고 기준일" 표시, 수정 가능, 채널마스터가 늦게 와도 다시 판별');
    const g = uniqueIds(loadOfflineGas({ setup: true, today: TODAY }));
    const { ctx } = loadFrontend(PROJ, 'get UP(){return _UP;}');
    const box = {};
    ctx.document.getElementById = id => (box[id] = box[id] || { id, innerHTML: '', value: '', textContent: '', dataset: {}, style: {}, children: [], classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
    ctx._getToken = () => 'T';
    const token = require(path.join(__dirname, 'lib', 'offline-2b-fixture.js')).session(g.ctx, AUTH.email);
    ctx._gasFetch = async (url, o) => { const b = JSON.parse(o.body); return JSON.parse(g.ctx.doPost({ postData: { contents: J({ action: b.action, session: token, data: b.data }) }, parameter: {} })); };
    ctx.showToast = () => {};
    const X = ctx.__X__;
    // 채널마스터를 받기 전에 파일이 먼저 들어온 경우
    X.UP.files.push({ id: 1, name: '현재고_2026-09-29_101010.xls', rows: etlandStock([['302001', 'A', 1]]), parse: null, edits: {}, status: 'parsing', error: '', result: null, panelOpen: false });
    const f = X.UP.files[0];
    ctx._upParse(f);
    check('채널마스터 전: 파일명 날짜 그대로 + "설정을 불러오는 중"', f.parse.baseDate === '2026-09-29' && f.parse.stockOffset === null && /불러오는 중/.test(ctx._upBaseNote(f, f.parse, f.parse.baseDate)));
    await ctx._upRefreshSide(); await settle();
    check('채널마스터를 받으면 다시 판별 → 재고 기준일 9/28', f.parse.baseDate === '2026-09-28' && f.parse.stockOffset === -1, [f.parse.baseDate, f.parse.stockOffset]);
    ctx._upRender();
    const h = box['page-admin-upload'].innerHTML;
    check('미리보기: "재고 기준일" 입력 9/28 + "파일명 날짜 9/29 → 재고 기준일 9/28 (전일 기준)"', /재고 기준일<\/span><input type="date" class="f-inp" value="2026-09-28"/.test(h) && h.indexOf('파일명 날짜 9/29 → 재고 기준일 9/28 (전일 기준)') >= 0, h.slice(h.indexOf('up-card'), h.indexOf('up-card') + 900));
    ctx._upSetBase(1, '2026-09-26');
    check('기준일 수정 → "직접 선택 (파일명 날짜 9/29)"', f.parse.baseDate === '2026-09-26' && /직접 선택 \(파일명 날짜 9\/29\)/.test(box['page-admin-upload'].innerHTML));
    const ok = await ctx._upApply(1, true); await settle();
    check('반영 — 직접 고른 9/26으로 저장(서버가 다시 빼지 않음)', ok && dataRows(g.tab('재고_채널일별')).some(r => r[1] === 'etland' && r[0] === '2026-09-26'), dataRows(g.tab('재고_채널일별')));

    console.log('\n' + '─'.repeat(50));
    console.log('통과 ' + pass + ' / 실패 ' + fail);
    process.exit(fail ? 1 : 0);
  })();
})();
