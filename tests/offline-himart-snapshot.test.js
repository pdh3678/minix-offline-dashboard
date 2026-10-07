/* 하이마트 불완전 파일 대응 (2026-10-07) — 스냅샷 삭제·복구 + 급감 차단 + 취급 없음 표시

   배경: 하이마트 포털에서 당일 날짜로 받은 파일은 일부 점포만 들어 있다(운영 10/6 12행·10/7 22행 — 평소 1,500행대).
   그대로 반영되면 10/6 판매 = 당월판매(10/6, 일부 점포) − 당월판매(10/5, 전체) → 빠진 점포가 0으로 계산돼 큰 음수,
   재고_점포최신·재고_채널일별도 그 파일로 바뀌어 재고가 거의 0이 된다.

   지키려는 성질:
     · 급감 차단(수동·자동 공통) — 스냅샷형 파일의 행 수·점포 수가 직전 스냅샷(재고_점포최신에 있는 그 채널 최신 기준일)의 50% 미만이면
       쓰기 전에 거절. 수동은 [그래도 반영](allowShrink)으로만, 자동 반영은 allowShrink가 있어도 거절 → 오류 폴더 + 같은 사유.
       직전이 없으면(첫 업로드) 보지 않는다, 기간 교체형은 보지 않는다, 이마트 재고는 이마트·트레이더스 합쳐서
     · 하이마트 당일 파일(기준일 = 오늘) — 막지 않고 경고(업로드로그 경고·자동 반영 상태 경고)
     · 스냅샷 삭제 — 그 날짜 스냅샷·판매·채널 재고를 지우고, 다음 스냅샷 날짜는 남은 스냅샷으로 다시 계산, 재고_점포최신은 남은
       가장 최근 스냅샷으로 복원 → 불완전 파일 두 개를 지운 결과 = 그 파일들을 처음부터 올리지 않은 결과(판매원장·재고 세 탭·스냅샷).
       업로드로그: 지운 날짜 업로드는 '스냅샷 삭제됨'(데이터 현황·판매 최신 기준일에서 빠짐) + 삭제 기록 행. 다른 채널은 그대로
     · 중간 날짜를 지우면 = 그 날 파일이 없던 것과 같다(다음 날짜가 period로 다시 계산)
     · 스냅샷에 재고만 있는 행은 최근 7개 기준일만 둔다(복원용) — 판매 계산 결과는 그대로. 옛 스냅샷(판매 행만)에서는 일부만 복원되고 결과에 표시
     · 취급 없음 — 재고 0이고 최근 판매도 0 → idle(재고일수 '—', 경보 없음), 결품 위험은 판매가 있는데 재고일수가 짧을 때만
     · 화면 — 미리보기 급감 경고·[그래도 반영](확인창), 당일 경고, 업로드 로그 [이 날짜 스냅샷 삭제](확인창), 채널 상세 '취급 없음'

   실행: node tests/offline-himart-snapshot.test.js  (또는 node tests/run-all.js) */
const path = require('path'), crypto = require('crypto');
const { loadOfflineGas, dataRows, installDrive, installScriptApp } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const P = require(path.join(__dirname, '..', 'src', 'features', 'offline', 'parsers.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 900) : '')); }
}
const J = JSON.stringify;
const AUTH = { email: 'tester@athomecorp.com' };
const TAIL = ' — 당일 날짜로 받은 불완전 파일일 수 있습니다. 전일 날짜로 다시 받아주세요';

// ── 합성 파일 ──
function himart(entries) {
  return [['지사명', '인도처코드', '인도처명', '상품코드', '상품명', '당월실판매', '당월판매', '금주판매', '당일판매', '잔여재고', '회전율']]
    .concat(Object.keys(entries).map(k => { const [s, c] = k.split('|'); return ['가상지사', s, s + 'HM', c, '가상 ' + c].concat(entries[k], [0]); }));
}
const STORES40 = Array.from({ length: 40 }, (_, i) => 'S' + String(i + 1).padStart(2, '0'));
// 그 달 d일까지 점포 i의 C1 당월 누적 판매 — (k + i) % 4 === 0 인 날 k마다 1개
const cum = (i, d) => { let n = 0; for (let k = 1; k <= d; k++) if ((k + i) % 4 === 0) n++; return n; };
// 완전한 파일 — 40점포 × (C1 판매+재고, C2 재고만) = 80행
function hmFull(d) {
  const e = {};
  STORES40.forEach((s, i) => { const c = cum(i, d); e[s + '|C1'] = [c, c, 0, c - cum(i, d - 1), 10 - (i % 5)]; e[s + '|C2'] = [0, 0, 0, 0, 3]; });
  return himart(e);
}
const monthSale = d => STORES40.reduce((s, x, i) => s + cum(i, d), 0);
// 당일 날짜로 받은 불완전 파일 — 3점포, 금주판매만 1(운영 10/6·10/7 파일 모양: 당월판매·잔여재고 0)
const hmPartial = () => himart({ 'S01|C1': [0, 0, 1, 0, 0], 'S02|C1': [0, 0, 1, 0, 0], 'S03|C2': [0, 0, 1, 0, 0] });
const hmName = ymd => '판매재고현황_' + ymd.replace(/-/g, '') + '.xlsx';
function etlandStock(lines) { // [지점코드, 모델명, 재고]
  return [['현 재고'], ['거래처코드', '거래처명', '지부', '입고지점코드', '입고지점', '품목', '모델명', '설명', '재고수량', '타지점입고 예정수량', '합계', '단가', '재고금액', '판매 예약수량']]
    .concat(lines.map(l => ['1', '가상', '중부', l[0], '점' + l[0], 'KREF', l[1], '가상 ' + l[1], String(l[2]), '0', '0', '1', '1', '0']));
}
function etlandSales(lines) { // [판매일자, 지점코드, 모델명, 수량]
  return [['판매내역'], ['거래처코드', '거래처명', '지부', '지점코드', '지점명', '품목', '상품구분', '모델명', '설명', '판매수량', '단가', '금액', '판매일자', '구분']]
    .concat(lines.map(l => ['1', '가상', '충청', l[1], '점' + l[1], '청소기', '매입상품', l[2], '가상 ' + l[2], String(l[3]), '1', '1', l[0], '판매(계약)']));
}
function emartStock(lines) { // [점포명, 점포코드, 상품코드, 현재수량]
  return [['구분', '전월재고', '매입', '매출', '이관', '현재고'], ['수량', 0, 0, 0, 0, 0], [], [],
    ['조회일자', '점포명', '점포코드', '상품명', '전월수량', '전월금액', '현재수량', '현재금액', '이관량', '이관액', '매입량', '매입액', '상품코드', '매출량']]
    .concat(lines.map(l => ['202610', l[0], l[1], '가상 ' + l[2], 0, 0, l[3], 0, 0, 0, 0, 0, l[2], 0]));
}

function mk(today) {
  const g = loadOfflineGas({ setup: true, today });
  let n = 0;
  g.ctx.Utilities.getUuid = () => String(++n).padStart(4, '0') + '-uuid';
  g.today = today;
  g.rows = nm => dataRows(g.tab(nm));
  g.call = (action, data) => JSON.parse(g.ctx._offlineHandle(action, data || {}, AUTH));
  g.logOf = d => g.rows('업로드로그').filter(r => r[4] === 'HIMART_SALES_STOCK' && r[6] === d);
  return g;
}
function payload(g, rows, fileName, force) {
  const p = P.parseRows(rows, { fileName, today: g.today, stockOffsets: {} });
  if (!p.ok) throw new Error('픽스처 파싱 실패: ' + p.error);
  const pl = P.toUploadPayload(p, { fileName });
  if (force) pl.meta.allowShrink = true;
  return pl;
}
const up = (g, rows, fileName, force) => g.ctx._offUpload(payload(g, rows, fileName, force), AUTH);
const upH = (g, d, force, rows) => up(g, rows || hmFull(+d.slice(8)), hmName(d), force);
const tryUp = (g, rows, fileName, force, opts) => { try { return g.ctx._offUpload(payload(g, rows, fileName, force), AUTH, opts); } catch (e) { return { error: String(e.message || e) }; } };
// 비교용 — upload_id 열을 뺀다(업로드마다 다르다)
const noId = (rows, idCol) => rows.map(r => J(r.filter((v, i) => i !== idCol))).sort();
const hmSales = g => g.rows('판매원장').filter(r => r[3] === 'himart');
const hmOf = (g, nm, chCol) => g.rows(nm).filter(r => r[chCol] === 'himart');
const notHm = (g, nm, chCol) => J(g.rows(nm).filter(r => r[chCol] !== 'himart'));

(async function main() {
  console.log('\n[1] 급감 차단 — 수동 업로드(서버). 직전 = 재고_점포최신의 그 채널 최신 기준일');
  {
    const g = mk('2026-10-07');
    const c = g.ctx;
    check('문구 — 운영 숫자 예시(천 단위 쉼표)', c._offShrinkReason(12, 12, { rows: 1534, stores: 393 }) === '직전 대비 행 수 급감(12행 / 직전 1,534행) · 점포 수 급감(12곳 / 직전 393곳)' + TAIL,
      c._offShrinkReason(12, 12, { rows: 1534, stores: 393 }));
    check('경계 — 정확히 50%는 통과, 그 미만만 차단 · 행 수만 줄면 행 수만', c._offShrinkReason(40, 20, { rows: 80, stores: 40 }) === '' &&
      c._offShrinkReason(39, 40, { rows: 80, stores: 40 }) === '직전 대비 행 수 급감(39행 / 직전 80행)' + TAIL && c._offShrinkReason(5, 5, null) === '');
    const r5 = upH(g, '2026-10-05');
    check('완전한 10/5 파일(80행·40점포) 반영 — 직전 없음(첫 업로드)이라 판정 안 함, 당일 경고 없음', r5.success && !r5.warnings.some(w => /당일/.test(w)), r5.warnings);
    const lg = g.call('offline_getUploadLog');
    check('업로드 로그 snapshotBase — 하이마트 직전 = 10/5 · 80행 · 40점포', J(lg.snapshotBase.HIMART_SALES_STOCK) === J({ date: '2026-10-05', rows: 80, stores: 40 }), lg.snapshotBase);
    const before = ['판매원장', '하이마트_누적스냅샷', '재고_점포최신', '재고_채널일별'].map(nm => J(g.rows(nm)));
    const bad = tryUp(g, hmPartial(), hmName('2026-10-06'));
    check('불완전 10/6 파일(3행·3점포) → 거절, 행 수·점포 수 둘 다 사유', bad.error === '직전 대비 행 수 급감(3행 / 직전 80행) · 점포 수 급감(3곳 / 직전 40곳)' + TAIL, bad);
    check('  ↳ 판매원장·스냅샷·재고 두 탭 그대로', ['판매원장', '하이마트_누적스냅샷', '재고_점포최신', '재고_채널일별'].every((nm, i) => J(g.rows(nm)) === before[i]));
    const last = g.rows('업로드로그').pop();
    check('  ↳ 업로드로그에 실패 + 같은 사유(반영방식 수동)', last[11] === '실패: 직전 대비 행 수 급감(3행 / 직전 80행) · 점포 수 급감(3곳 / 직전 40곳)' + TAIL && last[12] === '수동', last.slice(10, 13));
    const auto = tryUp(g, hmPartial(), hmName('2026-10-06'), true, { strict: true, auto: { fileId: 'F1', modifiedTime: 't', md5: 'm' } });
    check('자동 반영 경로는 allowShrink가 있어도 거절 — "자동 반영은 이 파일을 반영하지 않았습니다"', /^직전 대비 행 수 급감\(3행 \/ 직전 80행\).* — 자동 반영은 이 파일을 반영하지 않았습니다$/.test(auto.error || ''), auto);
    const forced = upH(g, '2026-10-06', true, hmPartial());
    check('[그래도 반영](allowShrink) → 반영 + 경고 "급감 확인 후 반영"', forced.success && forced.warnings.some(w => w === '급감 확인 후 반영(그래도 반영): 직전 대비 행 수 급감(3행 / 직전 80행) · 점포 수 급감(3곳 / 직전 40곳)' + TAIL), forced.warnings);
    check('  ↳ 업로드로그 경고 열에도', /급감 확인 후 반영/.test(g.rows('업로드로그').pop()[10]));
    const r7 = upH(g, '2026-10-07');
    check('당일 날짜(10/7 = 오늘) 완전한 파일 — 막지 않고 경고(직전 3행보다 많아 급감 아님)', r7.success && r7.warnings.some(w => w.indexOf('기준일이 업로드 당일(2026-10-07)입니다 — 당일 파일은 불완전할 수 있습니다') === 0), r7.warnings);
    check('  ↳ 업로드로그 경고 열에 당일 경고', /기준일이 업로드 당일\(2026-10-07\)/.test(g.rows('업로드로그').pop()[10]));
    // 다른 스냅샷형 채널 — 전자랜드(첫 업로드는 판정 안 함), 이마트 재고는 이마트·트레이더스 합쳐서
    const e1 = up(g, etlandStock([['302001', 'MNFD-200G', 4], ['302002', 'MNFD-200G', 2], ['302003', 'MNKR-100G', 1], ['302004', 'MNKR-100G', 1]]), '현재고_2026-10-05_101010.xls');
    const e2 = tryUp(g, etlandStock([['302001', 'MNFD-200G', 4]]), '현재고_2026-10-06_101010.xls');
    check('전자랜드 현재고 — 첫 업로드(4행)는 통과, 다음 날 1행은 거절', e1.success && e2.error === '직전 대비 행 수 급감(1행 / 직전 4행) · 점포 수 급감(1곳 / 직전 4곳)' + TAIL, e2);
    const s1 = up(g, etlandSales([['2026-10-01', '302001', 'MNFD-200G', 3], ['2026-10-02', '302002', 'MNFD-200G', 1], ['2026-10-03', '302003', 'MNFD-200G', 1]]), '판매내역_2026-10-04_101010.xls');
    const s2 = up(g, etlandSales([['2026-10-04', '302001', 'MNFD-200G', 1]]), '판매내역_2026-10-05_101010.xls');
    check('기간 교체형(전자랜드 판매내역)은 행 수가 줄어도 판정하지 않음', s1.success && s2.success);
    const m1 = up(g, emartStock([['EM 성수', '1003', '8800000000001', 5], ['EM 창동', '1001', '8800000000001', 2], ['TR 월계', '2001', '8800000000001', 3], ['TR 송림', '2002', '8800000000001', 1]]), '재고현황_상세_20261005101010.xlsx');
    const lg2 = g.call('offline_getUploadLog');
    check('이마트 재고 — 직전 = 이마트·트레이더스 합쳐서(4행·4점포)', m1.success && J(lg2.snapshotBase.EMART_STOCK) === J({ date: '2026-10-05', rows: 4, stores: 4 }), lg2.snapshotBase);
    const m2 = tryUp(g, emartStock([['EM 성수', '1003', '8800000000001', 5]]), '재고현황_상세_20261006101010.xlsx');
    const m3 = up(g, emartStock([['EM 성수', '1003', '8800000000001', 5], ['EM 창동', '1001', '8800000000001', 2], ['TR 월계', '2001', '8800000000001', 3]]), '재고현황_상세_20261006101010.xlsx');
    check('  ↳ 1점포 파일은 거절, 3점포(75%)는 통과', /^직전 대비 행 수 급감\(1행 \/ 직전 4행\) · 점포 수 급감\(1곳 \/ 직전 4곳\)/.test(m2.error || '') && m3.success, [m2, m3.success]);
  }

  console.log('\n[2] 급감 차단 — 드라이브 수신함 자동 반영: 오류 폴더 + 같은 사유, 당일 파일은 상태 경고');
  {
    const FAKE_XLSX = { version: 'fake', read: bytes => ({ SheetNames: ['S'], Sheets: { S: { '!rows': JSON.parse(Buffer.from(bytes).toString('utf8')) } } }),
      utils: { sheet_to_json: ws => ws['!rows'].map(r => r.slice()), decode_cell() {}, encode_range() {} } };
    const g = mk('2026-10-07');
    g.scriptProps.OFFLINE_INBOX_FOLDER_ID = 'INBOX';
    const d = installDrive();
    installScriptApp();
    d.add({ id: 'INBOX', name: '오프라인 수신함', mimeType: d.FOLDER, parents: ['SHARED-ROOT'] });
    g.ctx._offXlsxLib = FAKE_XLSX;
    const put = (name, rows) => { const bytes = Buffer.from(J(rows), 'utf8'); return d.add({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parents: ['INBOX'],
      md5Checksum: crypto.createHash('md5').update(bytes).digest('hex'), size: String(bytes.length), lastModifyingUser: { emailAddress: 'partner@athomecorp.com' }, bytes }); };
    const folder = nm => (Object.values(d.files).find(f => f.name === nm && f.mimeType === d.FOLDER && f.parents[0] === 'INBOX') || {}).id;
    const names = id => d.in(id).filter(f => f.mimeType !== d.FOLDER).map(f => f.name).sort();
    put(hmName('2026-10-05'), hmFull(5));
    const st1 = g.ctx._offInboxRun('editor');
    check('완전한 10/5 파일 → 반영', st1.counts.success === 1 && st1.counts.error === 0, st1);
    const snapBefore = J(g.rows('하이마트_누적스냅샷'));
    put(hmName('2026-10-06'), hmPartial());
    const st2 = g.ctx._offInboxRun('editor');
    check('불완전 10/6 파일 → 오류 1 · 오류 폴더로', st2.counts.error === 1 && J(names(folder('오류'))) === J([hmName('2026-10-06')]), st2);
    check('  ↳ 상태 패널 사유 = 수동과 같은 문구 + "자동 반영은 이 파일을 반영하지 않았습니다"',
      st2.files[0].detail === '직전 대비 행 수 급감(3행 / 직전 80행) · 점포 수 급감(3곳 / 직전 40곳)' + TAIL + ' — 자동 반영은 이 파일을 반영하지 않았습니다', st2.files[0].detail);
    const last = g.rows('업로드로그').pop();
    check('  ↳ 업로드로그 실패 행(자동 반영) + 같은 사유, 스냅샷 그대로', last[12] === '자동 반영' && /^실패: 직전 대비 행 수 급감\(3행 \/ 직전 80행\)/.test(last[11]) && J(g.rows('하이마트_누적스냅샷')) === snapBefore, last.slice(10, 13));
    put(hmName('2026-10-07'), hmFull(7));
    const st3 = g.ctx._offInboxRun('editor');
    check('당일(10/7) 완전한 파일 → 반영 + 상태 경고에 당일 경고', st3.counts.success === 1 && st3.warnings.some(w => w.indexOf(hmName('2026-10-07') + ' — 기준일이 업로드 당일(2026-10-07)') === 0), st3.warnings);
  }

  // ── 운영 재현: 9/30 · 10/1~10/5 완전한 파일 + 다른 채널, 10/6·10/7 불완전 파일(차단 전에 반영됨 — 여기서는 [그래도 반영]으로) ──
  const FULL = ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
  const others = g => {
    up(g, etlandStock([['302001', 'MNFD-200G', 4], ['302002', 'MNKR-100G', 2]]), '현재고_2026-10-05_101010.xls');
    up(g, etlandSales([['2026-10-01', '302001', 'MNFD-200G', 2], ['2026-10-05', '302002', 'MNKR-100G', 1]]), '판매내역_2026-10-05_101010.xls');
  };
  console.log('\n[3] 스냅샷 삭제 — 불완전 10/7·10/6을 지우면 = 처음부터 올리지 않은 것');
  // 기준: 10/5까지만 올린 결과(먼저 다 계산해 둔다 — loadOfflineGas는 전역을 공유한다)
  const R = (() => {
    const g = mk('2026-10-07');
    FULL.forEach(d => upH(g, d));
    others(g);
    return { sales: noId(hmSales(g), 9), store: noId(hmOf(g, '재고_점포최신', 1), 9), daily: noId(hmOf(g, '재고_채널일별', 1), 6),
      snap: noId(g.rows('하이마트_누적스냅샷').filter(r => r[0] === '2026-10-05'), 8), salesSnap: noId(g.rows('하이마트_누적스냅샷').filter(r => !g.ctx._offSnapStockOnly(r)), 8) };
  })();
  {
    const g = mk('2026-10-07');
    FULL.forEach(d => upH(g, d));
    others(g);
    upH(g, '2026-10-06', true, hmPartial());
    upH(g, '2026-10-07', true, hmPartial());
    const neg = hmSales(g).filter(r => r[1] === '2026-10-06' && r[6] < 0);
    const octSum = () => hmSales(g).filter(r => r[1] >= '2026-10-01').reduce((s, r) => s + r[6], 0);
    check('재현: 10/6 판매 = −당월판매(10/5) — 큰 음수, 10월 합계 0, 재고_점포최신 = 10/7 3행', neg.length > 30 && neg.reduce((s, r) => s + r[6], 0) === -monthSale(5) && octSum() === 0 &&
      J(hmOf(g, '재고_점포최신', 1).map(r => r[0])) === J(['2026-10-07', '2026-10-07', '2026-10-07']), [neg.length, octSum(), monthSale(5)]);
    const keep = { sales: notHm(g, '판매원장', 3), daily: notHm(g, '재고_채널일별', 1), store: notHm(g, '재고_점포최신', 1), master: J(g.rows('점포마스터')), um: J(g.rows('미매칭코드')) };
    const lg0 = g.call('offline_getUploadLog');
    const delBtn = lg0.items.filter(x => x.snapshotDeletable).map(x => x.range);
    check('업로드 로그 — 날짜마다 그 스냅샷을 만든 업로드에만 삭제 버튼(하이마트 8개 날짜)', J(delBtn.slice().sort()) === J(FULL.concat(['2026-10-06', '2026-10-07'])) &&
      lg0.items.filter(x => x.fileType !== 'HIMART_SALES_STOCK').every(x => !x.snapshotDeletable), delBtn);
    const id7 = g.logOf('2026-10-07')[0][0];
    const wrong = g.call('offline_deleteHimartSnapshot', { date: '2026-10-07', uploadId: 'U-다른업로드' });
    check('그 사이 다시 반영된 날짜(업로드 id 불일치) → 거절, 아무것도 안 바뀜', /그 사이 다른 업로드로 바뀌었습니다/.test(wrong.error || '') && g.rows('하이마트_누적스냅샷').some(r => r[0] === '2026-10-07'), wrong);
    const d7 = g.call('offline_deleteHimartSnapshot', { date: '2026-10-07', uploadId: id7 });
    check('① 10/7 삭제 — 스냅샷 3행, 다음 날짜 없음, 재고_점포최신은 남은 최근(10/6) 스냅샷 3행으로', d7.success && d7.snapshotRows === 3 && d7.recomputed === null &&
      J(d7.stockStore) === J({ from: '2026-10-06', rows: 3, fileRows: 3, stock: 0 }) && d7.stockDailyRemoved > 0 && d7.logMarked === 1, d7);
    const d6 = g.call('offline_deleteHimartSnapshot', { date: '2026-10-06', uploadId: g.logOf('2026-10-06').find(r => r[11] === '성공')[0] });
    check('② 10/6 삭제 — 음수 판매 지움, 재고_점포최신은 10/5 스냅샷 80행(그 날 파일 80행 — 전부)', d6.success && d6.salesRemoved === neg.length && J(d6.stockStore) === J({ from: '2026-10-05', rows: 80, fileRows: 80,
      stock: STORES40.reduce((s, x, i) => s + 10 - (i % 5) + 3, 0) }), d6);
    check('  ↳ 결과 문구에 지운 행·복원·상태 변경', /스냅샷 3행 삭제 · 판매원장 2026-10-06 하이마트 \d+행 지움 · 재고_점포최신 2026-10-05 스냅샷으로 80행 복원 · 재고_채널일별 \d+행 지움 · 업로드 1건 상태 → 스냅샷 삭제됨/.test(d6.note), d6.note);
    check('판매원장 하이마트 = 10/5까지만 올린 결과와 같다(음수 없음)', J(noId(hmSales(g), 9)) === J(R.sales) && !hmSales(g).some(r => r[6] < 0));
    check('10월 판매 합계 = 10/5 파일 당월판매 합계', octSum() === monthSale(5) && monthSale(5) > 0, [octSum(), monthSale(5)]);
    check('재고_점포최신(하이마트) = 10/5 기준으로 복원(10/5까지만 올린 결과와 같다)', J(noId(hmOf(g, '재고_점포최신', 1), 9)) === J(R.store));
    check('재고_채널일별(하이마트) = 10/5까지(10/6·10/7 행 없음)', J(noId(hmOf(g, '재고_채널일별', 1), 6)) === J(R.daily));
    check('누적스냅샷 — 10/5는 전 행 그대로, 판매 행은 10/5까지만 올린 결과와 같다', J(noId(g.rows('하이마트_누적스냅샷').filter(r => r[0] === '2026-10-05'), 8)) === J(R.snap) &&
      J(noId(g.rows('하이마트_누적스냅샷').filter(r => !g.ctx._offSnapStockOnly(r)), 8)) === J(R.salesSnap));
    check('다른 채널 숫자 불변 — 판매원장·재고 두 탭·점포마스터·미매칭코드', notHm(g, '판매원장', 3) === keep.sales && notHm(g, '재고_채널일별', 1) === keep.daily && notHm(g, '재고_점포최신', 1) === keep.store &&
      J(g.rows('점포마스터')) === keep.master && J(g.rows('미매칭코드')) === keep.um);
    const log = g.rows('업로드로그');
    check('업로드로그 — 10/6·10/7 업로드 상태 "스냅샷 삭제됨", 삭제 기록 2행(파일유형 HIMART_SNAPSHOT_DELETE · 업로더 · 지운 행 수)',
      ['2026-10-06', '2026-10-07'].every(d => g.logOf(d).filter(r => r[11] !== '실패' && !/^실패/.test(r[11])).every(r => r[11] === '스냅샷 삭제됨')) &&
      J(log.filter(r => r[4] === 'HIMART_SNAPSHOT_DELETE').map(r => [r[3], r[5], r[6], r[7], r[2], r[11], r[12]])) ===
      J([['하이마트 스냅샷 삭제 2026-10-07', 'himart', '2026-10-07', 3, AUTH.email, '성공', '수동'], ['하이마트 스냅샷 삭제 2026-10-06', 'himart', '2026-10-06', 3, AUTH.email, '성공', '수동']]), log.slice(-4));
    const st = g.call('offline_getStatus'), h = st.channels.find(c => c.channelId === 'himart');
    check('데이터 현황 — 하이마트 판매·재고 마지막 기준일 10/5(지운 날짜는 빈 날로)', h.salesLast === '2026-10-05' && h.stockLast === '2026-10-05' && h.missingDays.indexOf('2026-10-06') >= 0, h);
    const inv = g.call('offline_getInventory', { channelId: 'himart' }), ci = inv.channels.find(c => c.channelId === 'himart');
    check('재고 지표 — 하이마트 재고 기준일·판매 기준일 10/5, 점포 표 80행', ci.stockDate === '2026-10-05' && ci.salesDate === '2026-10-05' && inv.stores.length === 80, [ci.stockDate, ci.salesDate, inv.stores.length]);
    const lg1 = g.call('offline_getUploadLog');
    check('업로드 로그 — 지운 날짜는 버튼 없음, 삭제 기록 행 표시, 10/5는 버튼 그대로', !lg1.items.some(x => x.snapshotDeletable && /2026-10-0[67]/.test(x.range)) &&
      lg1.items.some(x => x.snapshotDeletable && x.range === '2026-10-05') && lg1.items[0].fileType === 'HIMART_SNAPSHOT_DELETE' && lg1.items[0].status === '성공');
    check('급감 기준도 10/5로 돌아간다(80행·40점포)', J(lg1.snapshotBase.HIMART_SALES_STOCK) === J({ date: '2026-10-05', rows: 80, stores: 40 }), lg1.snapshotBase);
    check('없는 날짜·잘못된 날짜 → 거절', /2026-10-07 스냅샷이 없습니다/.test(g.call('offline_deleteHimartSnapshot', { date: '2026-10-07' }).error) &&
      /기준일이 올바르지 않습니다/.test(g.call('offline_deleteHimartSnapshot', { date: '10/7' }).error));
    const re6 = upH(g, '2026-10-06');
    check('③ 완전한 10/6 파일 다시 올림 → 급감 아님, 10/6 = day(당월판매 차이), 10월 합계 = 당월판매(10/6)', re6.success && octSum() === monthSale(6) &&
      hmSales(g).filter(r => r[1] === '2026-10-06').every(r => r[2] === 'day' && r[6] >= 0), octSum());
    const chk = g.ctx.offline_himartCheck('2026-09-30');
    check('offline_himartCheck(편집기 점검) — 월 누적 대조 모두 같음, 9/30 → 10/1 월 경계 = 10/1 day(당월판매 그대로)', chk.ok && chk.monthCheck.length === 7 &&
      chk.ledger.find(x => x.end === '2026-10-01').units === 'day' && chk.ledger.find(x => x.end === '2026-10-01').qty === monthSale(1) && !chk.ledger.some(x => x.negative), chk.log);
  }

  console.log('\n[4] 중간 날짜 삭제 = 그 날 파일이 없던 것(다음 날짜가 period로 다시 계산), 월 경계 9/30 → 10/2');
  {
    const ref = (() => { const g = mk('2026-10-07'); ['2026-09-30', '2026-10-02', '2026-10-04', '2026-10-05'].forEach(d => upH(g, d)); return noId(hmSales(g), 9); })();
    const g = mk('2026-10-07');
    ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'].forEach(d => upH(g, d));
    const storeBefore = J(hmOf(g, '재고_점포최신', 1));
    const r3 = g.call('offline_deleteHimartSnapshot', { date: '2026-10-03' });
    check('10/3 삭제 → 10/4를 [10/3~10/4] period로 다시 계산, 재고_점포최신(10/5)은 그대로', r3.success && J([r3.recomputed.date, r3.recomputed.unit, r3.recomputed.start]) === J(['2026-10-04', 'period', '2026-10-03']) &&
      r3.stockStore === null && J(hmOf(g, '재고_점포최신', 1)) === storeBefore, r3);
    const r1 = g.call('offline_deleteHimartSnapshot', { date: '2026-10-01' });
    check('10/1 삭제 → 10/2가 그 달 첫 스냅샷: [10/1~10/2] period = 당월판매(10/2) 그대로(9/30과 차이 계산하지 않음)', r1.recomputed.unit === 'period' && r1.recomputed.start === '2026-10-01' &&
      hmSales(g).filter(r => r[1] === '2026-10-02').reduce((s, r) => s + r[6], 0) === monthSale(2), r1.recomputed);
    check('판매원장 = 처음부터 10/1·10/3 파일이 없던 결과와 같다', J(noId(hmSales(g), 9)) === J(ref));
  }

  console.log('\n[5] 옛 스냅샷(판매 행만 — 2026-10-07 전 반영)에서 복원하면 일부만 — 결과에 그 날 파일 행 수와 함께');
  {
    const g = mk('2026-10-07');
    upH(g, '2026-10-04'); upH(g, '2026-10-05');
    const sh = g.tab('하이마트_누적스냅샷');
    sh._grid = [sh._grid[0]].concat(sh._grid.slice(1).filter(r => !g.ctx._offSnapStockOnly(r)));
    upH(g, '2026-10-06', true, hmPartial());
    const r = g.call('offline_deleteHimartSnapshot', { date: '2026-10-06' });
    check('재고_점포최신 10/5 판매 행 40행만 복원(파일 80행) + 문구에 "일부"', r.stockStore.from === '2026-10-05' && r.stockStore.rows === 40 && r.stockStore.fileRows === 80 && /80행 중 — 판매 행만 남은 스냅샷이라 일부/.test(r.note), r.stockStore);
    check('  ↳ 판매원장은 그대로 정확(10월 합계 = 당월판매(10/5))', hmSales(g).filter(x => x[1] >= '2026-10-01').reduce((s, x) => s + x[6], 0) === monthSale(5));
  }

  console.log('\n[6] 누적스냅샷 — 재고만 있는 행은 최근 7개 기준일만, 판매 계산은 그대로');
  {
    const g = mk('2026-10-10');
    const days = Array.from({ length: 10 }, (_, i) => '2026-10-' + String(i + 1).padStart(2, '0'));
    days.forEach(d => upH(g, d));
    const snap = g.rows('하이마트_누적스냅샷'), so = d => snap.filter(r => r[0] === d && g.ctx._offSnapStockOnly(r)).length;
    check('재고만 있는 행(C2 40행) = 10/4~10/10(7개)에만, 10/1~10/3은 판매 행만', days.slice(3).every(d => so(d) === 40) && days.slice(0, 3).every(d => so(d) === 0 && snap.some(r => r[0] === d)), days.map(so));
    check('판매원장: 10/1 day + 이후 day, 10월 합계 = 당월판매(10/10)', hmSales(g).reduce((s, r) => s + r[6], 0) === monthSale(10) && hmSales(g).every(r => r[2] === 'day'));
    const chk = g.ctx.offline_himartCheck('2026-10-01');
    check('offline_himartCheck — 기준일별 재고만 행 수·파일 행 수, 월 누적 대조 10개 모두 같음', chk.ok && chk.snapshots.length === 10 && chk.snapshots[9].stockOnly === 40 && chk.snapshots[0].stockOnly === 0 && chk.snapshots[0].fileRows === 80, chk.log.slice(0, 4));
  }

  console.log('\n[7] 취급 없음 — 재고 0이고 최근 판매도 0 → 재고일수 —, 경보 없음. 결품 위험은 판매가 있을 때만');
  {
    const { compute, G, STOCK_DAILY, SALES } = require(path.join(__dirname, 'lib', 'offline-2b-fixture.js'));
    const g0 = loadOfflineGas({ today: '2026-09-27' });
    // SKU-0002(MNMD-110G): 재고 0 + 판매 없음 / SKU-0003(MNVC-100G): 재고 0 + 판매 28(창 안)
    const sd = STOCK_DAILY.map(r => r[2] === 'MNMD-110G' || r[2] === 'MNVC-100G' ? r.slice(0, 3).concat([0], r.slice(4)) : r);
    const r = compute(g0, { stockDaily: sd, sales: SALES.filter(x => x[5] !== 'MNMD-110G') });
    const idle = G(r, 'himart', 'sku', 'SKU-0002'), risk = G(r, 'himart', 'sku', 'SKU-0003'), ok = G(r, 'himart', 'sku', 'SKU-0001');
    check('재고 0 · 판매 0 → idle, 재고일수 null, 판매 없음 아님, 경보 없음', idle.idle === true && idle.days === null && idle.noSales === false && idle.alert === '' && idle.total === 0 && idle.windowQty === 0, idle);
    check('재고 0 · 판매 28 → 결품 위험(재고일수 0)', risk.idle === false && risk.days === 0 && risk.alert === 'risk', risk);
    check('재고 있는 SKU는 idle 아님', ok.idle === false && ok.total > 0);
    const neg = compute(g0, { stockDaily: sd, sales: SALES.filter(x => x[5] !== 'MNMD-110G').concat([['2026-09-24', '2026-09-24', 'day', 'himart', 'S1', 'MNMD-110G', -3, '', 'upload', 'U']]) });
    check('재고 0 · 최근 판매 음수(잘못 들어간 음수) → idle(판매 없음·결품 위험 아님)', G(neg, 'himart', 'sku', 'SKU-0002').idle === true && G(neg, 'himart', 'sku', 'SKU-0002').alert === '');
    check('재고 데이터 없는 채널(이마트)은 idle 아님(재고 0이 아니라 모름)', G(r, 'emart', 'channel').idle === false);
  }

  console.log('\n[8] 화면 — 업로드 미리보기 급감 경고·[그래도 반영], 당일 경고, 업로드 로그 [이 날짜 스냅샷 삭제], 채널 상세 취급 없음');
  {
    const { loadFrontend } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
    const PROJ = path.join(__dirname, '..');
    const { ctx, X } = loadFrontend(PROJ, 'get UP(){return _UP;}, get ofDays(){return _ofDays;}');
    const box = {};
    ctx.document.getElementById = id => (box[id] = box[id] || { id, innerHTML: '', value: '', textContent: '', className: '', style: {}, classList: { add() {}, remove() {}, contains() { return false; } } });
    const page = () => box['page-admin-upload'].innerHTML;
    const tick = () => new Promise(r => setTimeout(r, 0));
    const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
    const LOG_ITEMS = [
      { uploadId: 'X1', at: '2026-10-07 15:00:00', uploader: 'a', fileName: '하이마트 스냅샷 삭제 2026-10-07', fileType: 'HIMART_SNAPSHOT_DELETE', channelId: 'himart', range: '2026-10-07', rawRows: 22, appliedRows: 0, unmatched: 0, warnings: '스냅샷 22행 삭제', status: '성공', mode: 'manual', snapshotDeletable: false },
      { uploadId: 'U7', at: '2026-10-07 14:43:00', uploader: 'a', fileName: '판매재고현황_20261007.xlsx', fileType: 'HIMART_SALES_STOCK', channelId: 'himart', range: '2026-10-07', rawRows: 22, appliedRows: 50, unmatched: 0, warnings: '', status: '스냅샷 삭제됨', mode: 'auto', snapshotDeletable: false },
      { uploadId: 'U6', at: '2026-10-06 16:52:00', uploader: 'a', fileName: '판매재고현황_20261006.xlsx', fileType: 'HIMART_SALES_STOCK', channelId: 'himart', range: '2026-10-06', rawRows: 12, appliedRows: 40, unmatched: 0, warnings: '', status: '성공', mode: 'manual', snapshotDeletable: true },
      { uploadId: 'E5', at: '2026-10-06 16:50:00', uploader: 'a', fileName: '현재고_2026-10-06.xls', fileType: 'ETLAND_STOCK', channelId: 'etland', range: '2026-10-05', rawRows: 558, appliedRows: 600, unmatched: 0, warnings: '', status: '성공', mode: 'manual', snapshotDeletable: false }];
    const calls = [];
    let logBase = { HIMART_SALES_STOCK: { date: '2026-10-05', rows: 1534, stores: 393 } };
    const replies = {
      offline_getStatus: () => ({ success: true, today: '2026-10-07', month: '2026-10', channels: [] }),
      offline_getUploadLog: () => ({ success: true, items: LOG_ITEMS, snapshotBase: logBase }),
      offline_getInboxStatus: () => ({ success: true, settings: {}, last: null }),
      offline_getMasters: () => ({ success: true, skus: [], channels: [{ channelId: 'himart', name: '하이마트', channelCategory: '양판점' }], mappings: [], stores: [], productLines: [], stockTypes: ['정상', '전시', '리퍼'] }),
      offline_upload: d => ({ success: true, uploadId: 'U9', applied: { stockDaily: 1 }, replaceRange: { baseDate: d.meta.baseDate }, unmatched: [], warnings: [] }),
      offline_deleteHimartSnapshot: d => ({ success: true, date: d.date, note: '스냅샷 12행 삭제 · 재고_점포최신 2026-10-05 스냅샷으로 1534행 복원' })
    };
    ctx._offlineCall = async (action, data) => { calls.push({ action, data }); if (replies[action]) return replies[action](data || {}); throw new Error('모르는 액션 ' + action); };
    const byName = {};
    ctx._loadSheetJS = async () => ({});
    ctx.OfflineParsers.readWorkbookRows = (XLSX, bytes) => ({ rows: byName[bytes.__name] });
    ctx.Uint8Array = function (buf) { return { __name: buf.__name }; };
    const addFile = (name, rows) => { byName[name] = rows; return { name, arrayBuffer: async () => ({ __name: name }) }; };
    ctx.navPage('admin-upload', null);
    await settle();
    let h = page();
    check('업로드 로그 — 삭제 가능한 행(10/6)에만 [이 날짜 스냅샷 삭제], 삭제 기록 행은 "하이마트 스냅샷 삭제"', (h.match(/이 날짜 스냅샷 삭제/g) || []).length === 1 &&
      h.indexOf(`_upDeleteSnap('2026-10-06','U6')`) > 0 && h.indexOf('하이마트 스냅샷 삭제</td>') > 0 && /off-miss">스냅샷 삭제됨/.test(h));
    const today = ctx._upTodayStr();
    const partial = himart({ 'A1|MNFD-200G': [0, 0, 1, 0, 0], 'A2|MNFD-200G': [0, 0, 1, 0, 0] });
    ctx._upAddFiles([addFile('판매재고현황_20261006.xlsx', partial), addFile(hmName(today), hmFull(5))]);
    await settle();
    h = page();
    const f = X.UP.files;
    check('미리보기: 2행 파일 → ⛔ 직전 대비 행 수 급감(2행 / 직전 1,534행) · 점포 수 급감 + [그래도 반영], 반영 버튼 꺼짐',
      h.indexOf('⛔ 직전 대비 행 수 급감(2행 / 직전 1,534행) · 점포 수 급감(2곳 / 직전 393곳) — 당일 날짜로 받은 불완전 파일일 수 있습니다. 전일 날짜로 다시 받아주세요') > 0 &&
      h.indexOf(`_upForceShrink(${f[0].id})`) > 0 && /disabled\s+title="직전 대비 급감/.test(h), h.slice(h.indexOf('up-card'), h.indexOf('up-card') + 1500));
    // (이 80행 파일은 기준 1,534행의 절반 미만이라 급감으로도 막힌다 — 여기서는 당일 경고 문구만 본다)
    check('당일 날짜 하이마트 파일 → 미리보기에 당일 경고', h.indexOf(`기준일이 업로드 당일(${today})입니다 — 당일 파일은 불완전할 수 있습니다`) > 0);
    check('전체 반영 대상에서 급감 파일 제외', ctx._upApplyOrder().every(x => !ctx._upPlan(x).shrink) && ctx._upApplyOrder().length === 0);
    ctx.confirm = () => false;
    ctx._upForceShrink(f[0].id);
    await settle();
    check('[그래도 반영] — 확인창 취소면 보내지 않음', !calls.some(c => c.action === 'offline_upload'));
    ctx.confirm = () => true;
    ctx._upForceShrink(f[0].id);
    await settle();
    const sent = calls.filter(c => c.action === 'offline_upload');
    check('  ↳ 확인하면 allowShrink와 함께 1번 전송', sent.length === 1 && sent[0].data.meta.allowShrink === true && sent[0].data.meta.baseDate === '2026-10-06', sent.map(c => c.data.meta));
    // 미리보기가 기준을 못 받았을 때 — 서버 거절 문구로 [그래도 반영]
    logBase = null;
    await ctx._upRefreshSide();
    replies.offline_upload = () => { throw new Error('직전 대비 행 수 급감(80행 / 직전 1,534행) — 당일 날짜로 받은 불완전 파일일 수 있습니다. 전일 날짜로 다시 받아주세요'); };
    await ctx._upApply(f[1].id);
    h = page();
    check('기준을 못 받은 미리보기 — 서버가 급감으로 거절하면 그 문구 + [그래도 반영]', f[1].error.indexOf('반영 실패: 직전 대비') === 0 && h.indexOf(`_upForceShrink(${f[1].id})`) > 0);
    // 스냅샷 삭제
    ctx.confirm = () => false;
    await ctx._upDeleteSnap('2026-10-06', 'U6');
    check('[이 날짜 스냅샷 삭제] — 확인창 취소면 보내지 않음', !calls.some(c => c.action === 'offline_deleteHimartSnapshot'));
    let asked = '';
    ctx.confirm = msg => { asked = msg; return true; };
    await ctx._upDeleteSnap('2026-10-06', 'U6');
    const del = calls.filter(c => c.action === 'offline_deleteHimartSnapshot');
    h = page();
    check('  ↳ 확인하면 날짜·업로드 id로 1번, 확인창에 하는 일(스냅샷·판매 재계산·점포 재고 복원·채널 재고) 안내', del.length === 1 && J(del[0].data) === J({ date: '2026-10-06', uploadId: 'U6' }) &&
      /재고_점포최신\(하이마트\): 남아 있는 가장 최근 스냅샷으로 복원/.test(asked) && /다음 스냅샷 날짜를 다시 계산/.test(asked), del.map(c => c.data));
    check('  ↳ 결과 줄 + 로그를 다시 받음', h.indexOf('✓ 하이마트 2026-10-06 스냅샷 삭제 — 스냅샷 12행 삭제') > 0 && calls.filter(c => c.action === 'offline_getUploadLog').length >= 3);
    // 채널 상세 표·공용 표시
    const g = { stock: { '정상': 0, '전시': 0, '리퍼': 0 }, total: 0, windowQty: 0, dailyAvg: 0, days: null, noSales: false, idle: true, alert: '', displayStores: 0, storeOuts: 0 };
    const cells = ctx._ocdCells(null, g, { skuOut: 0 });
    check('채널 상세 — 취급 없음: 재고일수 —, 회색 배지 "취급 없음"(결품 위험·판매 없음 아님)', X.ofDays(g) === '—' && cells.indexOf('of-b-none') > 0 && cells.indexOf('취급 없음') > 0 && cells.indexOf('결품 위험') < 0 && cells.indexOf('판매 없음') < 0, cells);
    const risk = Object.assign({}, g, { idle: false, windowQty: 28, dailyAvg: 1, days: 0, alert: 'risk' });
    check('  ↳ 판매가 있는데 재고 0 → 결품 위험 그대로', ctx._ocdCells(null, risk, { skuOut: 0 }).indexOf('결품 위험') > 0 && X.ofDays(risk) === '0일');
  }

  console.log('\n' + (fail ? '실패 ' + fail + ' / ' : '') + '통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
