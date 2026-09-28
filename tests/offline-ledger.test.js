/* 오프라인 원장 반영 규칙 — 파서(브라우저 코드) → offline_upload(GAS 실코드) 왕복.

   지키려는 성질:
     A. 기간 교체형(전자랜드 판매·이마트 일별): 그 채널의 교체 기간 안 행만 지우고 새로 넣는다.
        같은 파일을 여러 번 올려도 결과가 같다. 교체 기간 밖 레코드는 넣지 않는다(재업로드 중복 방지).
     B. 스냅샷형: 재고_채널일별은 (기준일, 채널) 교체로 이력 누적, 재고_점포최신은 더 최신일 때만 교체.
     C. 하이마트: 당월 누적 스냅샷의 차이로 판매를 만든다. 업로드 순서를 뒤섞어도 결과가 같고,
        빠진 날은 period로 묶였다가 그 날 파일이 오면 day로 다시 쪼개진다. day는 당일판매와 대조.
     공통: 점포마스터 upsert, 미매칭코드 누적, 업로드로그, 캐시 무효화, 락, 입력 검증.

   실행: node tests/offline-ledger.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadOfflineGas, dataRows } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const P = require(path.join(__dirname, '..', 'src', 'features', 'offline', 'parsers.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const AUTH = { email: 'tester@athomecorp.com' };
const TODAY = '2026-09-27';
const J = x => JSON.stringify(x);

// ── 합성 파일(파서 입력 모양) → 업로드 ──
function etlandSales(lines) { // [판매일자, 지점코드, 모델명, 수량, 구분?]
  return [['판매내역'], ['거래처코드', '거래처명', '지부', '지점코드', '지점명', '품목', '상품구분', '모델명', '설명', '판매수량', '단가', '금액', '판매일자', '구분']]
    .concat(lines.map(l => ['1', '가상', '충청', l[1], '점' + l[1], '청소기', '매입상품', l[2], '가상 ' + l[2], String(l[3]), '1', '1', l[0], l[4] || '판매(계약)']));
}
function etlandStock(lines) { // [지점코드, 모델명, 재고, 이동중, 예약, 지점명?]
  return [['현 재고'], ['거래처코드', '거래처명', '지부', '입고지점코드', '입고지점', '품목', '모델명', '설명', '재고수량', '타지점입고 예정수량', '합계', '단가', '재고금액', '판매 예약수량']]
    .concat(lines.map(l => ['1', '가상', '중부', l[0], l[5] || ('점' + l[0]), 'KREF', l[1], '가상 ' + l[1], String(l[2]), String(l[3] || 0), '0', '1', '1', String(l[4] || 0)]));
}
function emartDaily(header, lines) { return [['상품 코드', '상품명'].concat(header, ['합계', '평균'])].concat(lines.map(l => [l[0], '가상 ' + l[0]].concat(l.slice(1), [0, 0]))); }
// 하이마트: entries = { 'S1|C1': [당월실판매, 당월판매, 금주판매, 당일판매, 잔여재고] }
function himart(entries) {
  return [['지사명', '인도처코드', '인도처명', '상품코드', '상품명', '당월실판매', '당월판매', '금주판매', '당일판매', '잔여재고', '회전율']]
    .concat(Object.keys(entries).map(k => { const [s, c] = k.split('|'); const v = entries[k]; return ['가상지사', s, s + 'HM', c, '가상 ' + c].concat(v, [0]); }));
}
function upload(ctx, rows, fileName, edits) {
  const r = P.parseRows(rows, { fileName, today: TODAY });
  if (!r.ok) throw new Error('픽스처 파싱 실패: ' + r.error);
  return ctx._offUpload(P.toUploadPayload(r, Object.assign({ fileName }, edits || {})), AUTH);
}
// 비교용 — upload_id(마지막 열)는 업로드마다 달라서 뺀다
const noId = rows => rows.map(r => r.slice(0, r.length - 1));
const sorted = rows => noId(rows).map(r => J(r)).sort();
const ledger = t => dataRows(t('판매원장'));
const himartLedger = t => ledger(t).filter(r => r[3] === 'himart');

(function main() {
  console.log('\n[A1] 기간 교체형 — 같은 파일 두 번 = 결과 동일');
  {
    const { ctx, tab, locks } = loadOfflineGas({ setup: true, today: TODAY });
    const f = etlandSales([['2026-09-01', '300001', 'MNVC-999G', 1], ['2026-09-01', '300001', 'MNVC-999G', 1], ['2026-09-03', '300002', 'MNFD-999G', 2],
      ['2026-09-05', '300002', 'MNFD-999G', -1], ['2026-09-05', '300001', 'MNVC-999G', 0]]);
    const r1 = upload(ctx, f, '판매내역_2026-09-25_124820.xls');
    const once = ledger(tab);
    check('성공 + 교체 범위 = 파일 최소~최대 판매일자', r1.success && r1.replaceRange.start === '2026-09-01' && r1.replaceRange.end === '2026-09-05', r1.replaceRange);
    check('합산된 day 레코드 3행(0인 행 제외)', once.length === 3 && once.every(r => r[2] === 'day' && r[0] === r[1]), once);
    check('같은 날·지점·모델 합산 = 2', once.find(r => r[5] === 'MNVC-999G')[6] === 2);
    check('반품(음수) 유지', once.find(r => r[0] === '2026-09-05')[6] === -1);
    check('설치완료수량 빈칸, 출처 upload, upload_id 기록', once.every(r => r[7] === '' && r[8] === 'upload' && r[9] === r1.uploadId));
    const r2 = upload(ctx, f, '판매내역_2026-09-25_124820.xls');
    check('두 번째 업로드 후에도 행 수·값 동일', J(noId(ledger(tab))) === J(noId(once)), ledger(tab));
    check('  ↳ upload_id는 새 업로드로 바뀜', ledger(tab).every(r => r[9] === r2.uploadId));
    check('  ↳ 기존 행 3개를 지우고 3개 넣음', r2.applied.sales === 3 && r2.applied.salesRemoved === 3, r2.applied);
    check('락을 잡았다', locks.taken >= 2);
  }

  console.log('\n[A2] 기간 교체형 — 겹치는 기간, 다른 채널, 교체 기간 밖, 0이 된 날');
  {
    const { ctx, tab } = loadOfflineGas({ setup: true, today: TODAY });
    const def = ctx.OFF_TABS.sales;
    ctx._offWriteBlock(tab('판매원장'), def, 2, [['2026-09-02', '2026-09-02', 'day', 'himart', 'A1', 'X', 5, 5, 'upload', 'U0']]);
    upload(ctx, etlandSales([['2026-09-01', '1', 'A', 1], ['2026-09-10', '1', 'A', 1], ['2026-09-20', '1', 'A', 1]]), 'a.xls');
    const r = upload(ctx, etlandSales([['2026-09-10', '1', 'A', 3], ['2026-09-25', '1', 'A', 4]]), 'b.xls', { replaceStart: '2026-09-10', replaceEnd: '2026-09-24' });
    const et = ledger(tab).filter(x => x[3] === 'etland');
    check('교체 기간(9/10~9/24) 밖의 기존 9/1 행은 유지', et.some(x => x[0] === '2026-09-01' && x[6] === 1), et);
    check('기간 안 9/10은 새 값 3, 9/20(새 파일에 없음)은 삭제', et.find(x => x[0] === '2026-09-10')[6] === 3 && !et.some(x => x[0] === '2026-09-20'), et);
    check('교체 기간 밖 레코드(9/25)는 넣지 않고 경고', !et.some(x => x[0] === '2026-09-25') && r.warnings.some(w => /교체 기간/.test(w) && /1건/.test(w)), r.warnings);
    check('다른 채널(하이마트) 행은 그대로', ledger(tab).some(x => x[3] === 'himart' && x[6] === 5));
  }

  console.log('\n[A3] 이마트 일별 매출(합계 양식) — 트레이더스가 합쳐진 파일이라 반영 거절(2026-09-28)');
  {
    const { ctx, tab } = loadOfflineGas({ setup: true, today: TODAY });
    const f = emartDaily(['9월 1일', '9월 2일'], [['8800000000011', 2, 0], ['2790000000022', 0, -1]]);
    const pr = P.parseRows(f, { fileName: '기간별매출(상품별)_일별요약_20260925104853.xlsx', today: TODAY });
    check('판별은 그대로(EMART_DAILY_SALES) + blocked 안내', pr.ok && pr.type === 'EMART_DAILY_SALES' && /트레이더스가 합쳐진 합계 파일/.test(pr.blocked), pr.blocked);
    let err = null;
    try { upload(ctx, f, '기간별매출(상품별)_일별요약_20260925104853.xlsx'); } catch (e) { err = e; }
    check('서버도 반영 거절 — "일별상세 파일을 사용하세요"', err && /일별상세/.test(err.message), err && err.message);
    check('  ↳ 원장·업로드로그에 아무것도 남지 않음', ledger(tab).length === 0 && dataRows(tab('업로드로그')).length === 0);
  }

  console.log('\n[B] 스냅샷형 — 채널일별 이력 누적, 점포최신은 더 최신일 때만');
  {
    const { ctx, tab } = loadOfflineGas({ setup: true, today: TODAY });
    const st = [['302001', 'MNKR-999G', 2, 1, 1], ['302001', 'MNKR-999G.DEMO', 1], ['302002', 'MNKR-999G', 0]];
    const r1 = upload(ctx, etlandStock(st), '현재고_2026-09-25_124812.xls');
    const daily1 = dataRows(tab('재고_채널일별')), store1 = dataRows(tab('재고_점포최신'));
    check('채널일별 = 코드별 합계 2행', daily1.length === 2 && daily1.find(x => x[2] === 'MNKR-999G')[3] === 2 && daily1[0][0] === '2026-09-25', daily1);
    check('  ↳ 이동중·예약 합계', daily1.find(x => x[2] === 'MNKR-999G')[4] === 1 && daily1.find(x => x[2] === 'MNKR-999G')[5] === 1);
    check('점포최신 3행(0 재고 포함), 당월입고·당월판매 빈칸', store1.length === 3 && store1.some(x => x[4] === 0) && store1.every(x => x[7] === '' && x[8] === ''), store1);
    check('반영 행수 보고', r1.applied.stockDaily === 2 && r1.applied.stockStore === 3, r1.applied);
    upload(ctx, etlandStock(st), '현재고_2026-09-25_124812.xls');
    check('같은 파일 재업로드 → 채널일별·점포최신 행 수 불변', dataRows(tab('재고_채널일별')).length === 2 && dataRows(tab('재고_점포최신')).length === 3);
    upload(ctx, etlandStock([['302001', 'MNKR-999G', 5]]), '현재고_2026-09-26_090000.xls');
    const daily2 = dataRows(tab('재고_채널일별'));
    check('다음 날 파일 → 채널일별에 9/25·9/26 둘 다(이력)', daily2.filter(x => x[0] === '2026-09-25').length === 2 && daily2.filter(x => x[0] === '2026-09-26').length === 1, daily2);
    check('점포최신은 9/26 1벌로 교체', J(dataRows(tab('재고_점포최신')).map(x => [x[0], x[3], x[4]])) === J([['2026-09-26', 'MNKR-999G', 5]]));
    const r3 = upload(ctx, etlandStock([['302001', 'MNKR-999G', 9]]), '현재고_2026-09-24_090000.xls');
    check('더 과거 파일 → 채널일별에는 9/24 추가', dataRows(tab('재고_채널일별')).some(x => x[0] === '2026-09-24'));
    check('  ↳ 점포최신은 건드리지 않고 경고', dataRows(tab('재고_점포최신'))[0][4] === 5 && r3.applied.stockStore === 0 && r3.warnings.some(w => /2026-09-26/.test(w)), r3.warnings);
    // 다른 채널의 점포최신은 그대로
    const em = [['구분'], ['조회일자', '점포명', '점포코드', '상품명', '현재수량', '매입량', '상품코드', '매출량'], ['202609', 'EM가상', '0012', '가상', 3, 1, '8800000000011', 2]];
    upload(ctx, em, '재고현황_상세_20260925104937.xlsx');
    const s = dataRows(tab('재고_점포최신'));
    check('이마트 반영 후 전자랜드 점포최신 유지 + 이마트 당월입고·당월판매', s.some(x => x[1] === 'etland' && x[4] === 5) && s.some(x => x[1] === 'emart' && x[2] === '0012' && x[7] === 1 && x[8] === 2), s);
  }

  // ── 하이마트 ──
  const H = {
    '2026-09-22': { 'S1|C1': [2, 3, 3, 1, 4], 'S1|C2': [0, 0, 0, 0, 7] },
    '2026-09-23': { 'S1|C1': [4, 5, 5, 2, 3], 'S2|C1': [0, 1, 1, 1, 2], 'S1|C2': [0, 0, 0, 0, 7] },
    '2026-09-24': { 'S1|C1': [5, 5, 5, 0, 3], 'S2|C1': [0, 0, 0, -1, 3], 'S1|C2': [0, 0, 0, 0, 6] }
  };
  const upH = (ctx, d, entries) => upload(ctx, himart(entries || H[d]), '판매재고현황_' + d.replace(/-/g, '') + '.xlsx');
  const EXPECT_SEQ = [
    ['2026-09-01', '2026-09-22', 'period', 'himart', 'S1', 'C1', 3, 2, 'upload'],
    ['2026-09-23', '2026-09-23', 'day', 'himart', 'S1', 'C1', 2, 2, 'upload'],
    ['2026-09-23', '2026-09-23', 'day', 'himart', 'S2', 'C1', 1, 0, 'upload'],
    ['2026-09-24', '2026-09-24', 'day', 'himart', 'S1', 'C1', 0, 1, 'upload'],
    ['2026-09-24', '2026-09-24', 'day', 'himart', 'S2', 'C1', -1, 0, 'upload']
  ].map(r => J(r)).sort();

  console.log('\n[C1] 하이마트 — 연속 업로드: 첫날 period, 이후 day = 누적 차이');
  {
    const { ctx, tab } = loadOfflineGas({ setup: true, today: TODAY });
    const r22 = upH(ctx, '2026-09-22'), r23 = upH(ctx, '2026-09-23'), r24 = upH(ctx, '2026-09-24');
    check('판매원장 = 기대값(수량 = 당월판매 차이, 설치완료 = 당월실판매 차이)', J(sorted(himartLedger(tab))) === J(EXPECT_SEQ), sorted(himartLedger(tab)));
    check('당일판매와 전부 일치 → 불일치 경고 없음', ![r22, r23, r24].some(r => r.warnings.some(w => /불일치/.test(w))), [r23.warnings, r24.warnings]);
    check('9/22: 같은 달에 이전 스냅샷 없음 → period [9/1, 9/22]', r22.replaceRange.himart.recomputed[0].unit === 'period' && r22.replaceRange.himart.recomputed[0].start === '2026-09-01', r22.replaceRange);
    check('9/23 업로드는 9/23만(다음 스냅샷 없음)', J(r23.replaceRange.himart.recomputed.map(x => x.date)) === J(['2026-09-23']));
    check('설치완료만 있고 판매 차이 0인 행도 저장(S1/C1 9/24: 0, 1)', himartLedger(tab).some(r => r[0] === '2026-09-24' && r[4] === 'S1' && r[6] === 0 && r[7] === 1));
    const snap = dataRows(tab('하이마트_누적스냅샷'));
    check('누적스냅샷 = 판매 값 있는 행만(재고만 있는 S1/C2 제외)', snap.length === 5 && !snap.some(r => r[2] === 'C2'), snap.map(r => r.slice(0, 3)));
    check('하이마트도 재고 반영(점포최신 = 9/24, 3행)', dataRows(tab('재고_점포최신')).filter(r => r[1] === 'himart').length === 3 && dataRows(tab('재고_점포최신'))[0][0] === '2026-09-24');
    check('  ↳ 점포최신 당월판매 = 당월판매, 재고 = 잔여재고', dataRows(tab('재고_점포최신')).some(r => r[2] === 'S1' && r[3] === 'C1' && r[4] === 3 && r[8] === 5));
    const again = J(sorted(himartLedger(tab)));
    upH(ctx, '2026-09-23');
    check('중간 날짜 재업로드 → 결과 동일', J(sorted(himartLedger(tab))) === again);
  }

  console.log('\n[C2] 하이마트 — 업로드 순서를 뒤섞어도 결과 동일(6가지 순서)');
  {
    const days = ['2026-09-22', '2026-09-23', '2026-09-24'];
    const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    perms.forEach(p => {
      const { ctx, tab } = loadOfflineGas({ setup: true, today: TODAY });
      p.forEach(i => upH(ctx, days[i]));
      check('순서 ' + p.map(i => days[i].slice(8)).join('→'), J(sorted(himartLedger(tab))) === J(EXPECT_SEQ), sorted(himartLedger(tab)));
    });
  }

  console.log('\n[C3] 하이마트 — 빈 날짜는 period, 누락 파일이 오면 day로 재계산');
  {
    const { ctx, tab } = loadOfflineGas({ setup: true, today: TODAY });
    upH(ctx, '2026-09-22'); upH(ctx, '2026-09-24');
    const gap = himartLedger(tab).filter(r => r[1] === '2026-09-24');
    check('9/23 없음 → 9/24는 period [9/23, 9/24] (S1/C1 5−3=2, 설치 5−2=3)', gap.length >= 1 && gap.every(r => r[2] === 'period' && r[0] === '2026-09-23') &&
      gap.some(r => r[4] === 'S1' && r[6] === 2 && r[7] === 3), gap);
    const r23 = upH(ctx, '2026-09-23');
    check('9/23 업로드 → 영향 날짜 = 9/23 + 다음 스냅샷 9/24', J(r23.replaceRange.himart.recomputed.map(x => x.date + ':' + x.unit)) === J(['2026-09-23:day', '2026-09-24:day']), r23.replaceRange);
    check('period가 사라지고 연속 업로드와 같은 결과', !himartLedger(tab).some(r => r[2] === 'period' && r[1] !== '2026-09-22') && J(sorted(himartLedger(tab))) === J(EXPECT_SEQ), sorted(himartLedger(tab)));
  }

  console.log('\n[C4] 하이마트 — 명세 예시: 9/28 period[9/27~9/28]에 9/27 파일이 오면 day 두 개');
  {
    const { ctx, tab } = loadOfflineGas({ setup: true, today: '2026-09-29' });
    upH(ctx, '2026-09-26', { 'S1|C1': [1, 1, 1, 1, 0] });
    upH(ctx, '2026-09-28', { 'S1|C1': [4, 6, 6, 2, 0] });
    check('업로드 전: 9/28은 period [9/27, 9/28] 수량 5', J(himartLedger(tab).filter(r => r[1] === '2026-09-28').map(r => [r[0], r[2], r[6]])) === J([['2026-09-27', 'period', 5]]));
    upH(ctx, '2026-09-27', { 'S1|C1': [2, 4, 4, 3, 0] });
    const after = himartLedger(tab).filter(r => r[1] >= '2026-09-27').map(r => [r[0], r[1], r[2], r[6]]);
    check('9/27 day 3, 9/28 day 2, period 없음', J(after.sort()) === J([['2026-09-27', '2026-09-27', 'day', 3], ['2026-09-28', '2026-09-28', 'day', 2]]), after);
  }

  console.log('\n[C5] 하이마트 — 월 경계·월초 판매 없는 날·불일치 경고');
  {
    const { ctx, tab } = loadOfflineGas({ setup: true, today: '2026-10-05' });
    upH(ctx, '2026-09-30', { 'S1|C1': [9, 9, 3, 1, 0] });
    upH(ctx, '2026-10-01', { 'S1|C1': [1, 2, 4, 2, 0] });
    const oct1 = himartLedger(tab).filter(r => r[1] === '2026-10-01');
    check('10/1: 이전 스냅샷이 전월 → day, 수량 = 당월판매(10/1) 그대로', J(oct1.map(r => [r[0], r[2], r[6], r[7]])) === J([['2026-10-01', 'day', 2, 1]]), oct1);
    upH(ctx, '2026-10-03', { 'S1|C1': [1, 5, 7, 3, 0] });
    const oct3 = himartLedger(tab).filter(r => r[1] === '2026-10-03');
    check('10/3 (10/2 없음): period [10/2, 10/3] 수량 3', J(oct3.map(r => [r[0], r[2], r[6]])) === J([['2026-10-02', 'period', 3]]), oct3);

    const z = loadOfflineGas({ setup: true, today: '2026-10-05' });
    upH(z.ctx, '2026-10-01', { 'S1|C1': [0, 0, 0, 0, 5] });
    check('판매 없는 날도 스냅샷 표시 행을 남김', dataRows(z.tab('하이마트_누적스냅샷')).some(r => r[0] === '2026-10-01'));
    upH(z.ctx, '2026-10-02', { 'S1|C1': [0, 1, 1, 1, 4] });
    const d2 = himartLedger(z.tab);
    check('  ↳ 그래서 다음 날은 day로 계산(period 아님)', J(d2.map(r => [r[0], r[1], r[2], r[6]])) === J([['2026-10-02', '2026-10-02', 'day', 1]]), d2);

    const m = loadOfflineGas({ setup: true, today: TODAY });
    upH(m.ctx, '2026-09-22');
    const bad = upH(m.ctx, '2026-09-23', { 'S1|C1': [4, 5, 5, 7, 3], 'S2|C1': [0, 1, 1, 1, 2] });
    check('day 수량(2)이 당일판매(7)와 다르면 경고 1건', bad.warnings.some(w => /2026-09-23 당일판매 불일치 1건/.test(w)), bad.warnings);
    check('  ↳ 값은 차이 계산 결과(2)를 쓴다', himartLedger(m.tab).find(r => r[1] === '2026-09-23' && r[4] === 'S1')[6] === 2);
    const logRow = dataRows(m.tab('업로드로그')).pop();
    check('  ↳ 경고가 업로드로그에도 기록', /불일치/.test(logRow[10]), logRow);
  }

  console.log('\n[C6] 하이마트 — 45일 지난 스냅샷 정리');
  {
    const { ctx, tab } = loadOfflineGas({ setup: true, today: TODAY });
    ctx._offWriteBlock(tab('하이마트_누적스냅샷'), ctx.OFF_TABS.himartSnap, 2, [['2026-08-10', 'S9', 'C9', 1, 1, 1, 1, 0, 'U0'], ['2026-08-20', 'S9', 'C9', 2, 2, 1, 1, 0, 'U0']]);
    upH(ctx, '2026-09-22');
    const snap = dataRows(tab('하이마트_누적스냅샷'));
    check('9/27 기준 45일 전(8/13)보다 오래된 8/10은 삭제, 8/20은 유지', !snap.some(r => r[0] === '2026-08-10') && snap.some(r => r[0] === '2026-08-20'), snap.map(r => r[0]));
    const old = upH(ctx, '2026-08-01', { 'S1|C1': [1, 1, 1, 1, 0] });
    check('보관 기간보다 오래된 파일도 판매는 계산하되 스냅샷은 남기지 않음', old.applied.himartSnap === 0 && himartLedger(tab).some(r => r[1] === '2026-08-01'));
  }

  console.log('\n[D] 점포마스터 upsert');
  {
    const { ctx, tab } = loadOfflineGas({ setup: true, today: TODAY });
    upload(ctx, etlandStock([['302001', 'A', 1, 0, 0, '가상A점'], ['302002', 'A', 1]]), '현재고_2026-09-25_1.xls');
    let st = dataRows(tab('점포마스터'));
    check('새 점포 2개(지역 = 지부, 최초·최근 = 오늘)', st.length === 2 && st[0][3] === '중부' && st[0][4] === TODAY && st[0][5] === TODAY, st);
    ctx._offToday = () => '2026-09-28';
    upload(ctx, etlandStock([['302001', 'A', 1, 0, 0, '가상A점(이전)']]), '현재고_2026-09-26_1.xls');
    st = dataRows(tab('점포마스터'));
    const a = st.find(r => r[1] === '302001');
    check('점포명 갱신, 최초등록일 유지, 최근확인일 갱신', st.length === 2 && a[2] === '가상A점(이전)' && a[4] === TODAY && a[5] === '2026-09-28', a);
    check('이번 파일에 없는 점포는 그대로', st.find(r => r[1] === '302002')[5] === TODAY);
  }

  console.log('\n[E] 미매칭코드 누적 · 매핑되면 제거');
  {
    const { ctx, tab } = loadOfflineGas({ setup: true, today: TODAY });
    const f = etlandSales([['2026-09-01', '1', 'MNVC-999G', 1], ['2026-09-01', '1', 'MNFD-999G', 1]]);
    const r1 = upload(ctx, f, 'a.xls');
    check('매핑 없는 코드 2개 반환·기록(발견횟수 1)', r1.unmatched.length === 2 && dataRows(tab('미매칭코드')).every(r => r[5] === 1 && r[3] === TODAY), dataRows(tab('미매칭코드')));
    check('  ↳ 원본상품명 기록', dataRows(tab('미매칭코드')).some(r => r[1] === 'MNFD-999G' && r[2] === '가상 MNFD-999G'));
    upload(ctx, f, 'a.xls');
    check('다시 나오면 발견횟수 2', dataRows(tab('미매칭코드')).every(r => r[5] === 2));
    ctx._offWriteBlock(tab('코드매핑'), ctx.OFF_TABS.mapping, 2, [['etland', 'MNVC-999G', 'SKU-0001', '정상', '', TODAY, 'x', ''], ['etland', 'MNFD-999G', '', '정상', '', TODAY, 'x', '비활성화']]);
    const r3 = upload(ctx, f, 'a.xls');
    check('매핑된 코드는 미매칭에서 빠짐, 비활성(sku 빈) 매핑은 남음', r3.unmatched.map(u => u.code).join() === 'MNFD-999G' && dataRows(tab('미매칭코드')).map(r => r[1]).join() === 'MNFD-999G', dataRows(tab('미매칭코드')));
    check('원장에는 매핑 여부와 무관하게 원본코드 그대로', ledger(tab).map(r => r[5]).sort().join() === 'MNFD-999G,MNVC-999G');
  }

  console.log('\n[F] 업로드로그 · 캐시 무효화 · 실패 기록');
  {
    const { ctx, tab, cacheStore, off } = loadOfflineGas({ setup: true, today: TODAY });
    cacheStore['offline:masters:meta'] = '1'; cacheStore['offline:status:meta'] = '1';
    const r = upload(ctx, etlandStock([['302001', 'A', 1]]), '현재고_2026-09-25_124812.xls');
    const log = dataRows(tab('업로드로그'));
    check('로그 1행: id·업로더·파일·유형·채널·기준일·행수·상태', log.length === 1 && log[0][0] === r.uploadId && log[0][2] === AUTH.email && log[0][3] === '현재고_2026-09-25_124812.xls' &&
      log[0][4] === 'ETLAND_STOCK' && log[0][5] === 'etland' && log[0][6] === '2026-09-25' && log[0][7] === 1 && log[0][8] === 2 && log[0][9] === 1 && log[0][11] === '성공', log[0]);
    check('업로드시각 형식', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(log[0][1]), log[0][1]);
    check('offline: 캐시 무효화', !('offline:masters:meta' in cacheStore) && !('offline:status:meta' in cacheStore));
    upload(ctx, etlandSales([['2026-09-01', '1', 'A', 1]]), 'p.xls');
    check('기간 교체형 로그의 기준일/기간 = 시작~끝', dataRows(tab('업로드로그'))[1][6] === '2026-09-01~2026-09-01');
    delete off._sheets['재고_점포최신'];
    let err = null;
    try { upload(ctx, etlandStock([['302001', 'A', 1]]), '현재고_2026-09-26_1.xls'); } catch (e) { err = e; }
    check('반영 중 실패하면 예외', err && /재고_점포최신/.test(err.message), err && err.message);
    check('  ↳ 실패도 업로드로그에 남김', /^실패: /.test(dataRows(tab('업로드로그')).pop()[11]));
  }

  console.log('\n[G] 입력 검증 — 잘못된 요청은 시트를 건드리기 전에 거절');
  {
    const { ctx, tab } = loadOfflineGas({ setup: true, today: TODAY });
    const base = () => P.toUploadPayload(P.parseRows(etlandStock([['1', 'A', 1]]), { fileName: '현재고_2026-09-25.xls', today: TODAY }), {});
    const cases = [
      ['유형과 채널 불일치', p => { p.meta.channelId = 'emart'; }, /채널/],
      ['모르는 유형', p => { p.meta.fileType = 'X'; }, /유형/],
      ['기준일 형식', p => { p.meta.baseDate = '2026/09/25'; }, /기준일/],
      ['수량이 숫자가 아님', p => { p.records.storeStock[0].stock = '3'; }, /숫자/],
      ['원본코드 빈칸', p => { p.records.channelStock[0].code = ''; }, /원본코드/]
    ];
    cases.forEach(([l, mut, re]) => {
      const p = base(); mut(p);
      let err = null;
      try { ctx._offUpload(p, AUTH); } catch (e) { err = e; }
      check(l, err && re.test(err.message), err && err.message);
    });
    const ps = P.toUploadPayload(P.parseRows(etlandSales([['2026-09-01', '1', 'A', 1]]), { today: TODAY }), { replaceStart: '2026-09-05', replaceEnd: '2026-09-01' });
    let e2 = null; try { ctx._offUpload(ps, AUTH); } catch (e) { e2 = e; }
    check('교체 기간 시작 > 끝', e2 && /교체 기간/.test(e2.message));
    check('거절된 요청은 아무것도 쓰지 않음(로그 포함)', ['판매원장', '재고_채널일별', '재고_점포최신', '업로드로그', '미매칭코드'].every(n => tab(n).getLastRow() === 1));
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})();
