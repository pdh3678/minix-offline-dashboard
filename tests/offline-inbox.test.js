/* 드라이브 수신함 자동 반영 — offline_processInbox (2026-10-06)

   지키려는 성질:
     · 수동 업로드와 결과가 같다 — 같은 파일들을 수신함에 넣고 처리한 시트 = 같은 순서로 수동 업로드한 시트(업로드로그는 반영방식·업로더·원본 파일 열만 다름)
     · 처리 순서: 이마트 일별상세 → 이마트 재고현황_상세 → 나머지(파일명 순) → 하이마트(기준일 오름차순)
     · 성공 → '처리완료', 파일 문제(판별 불가·반영 불가 양식·모르는 업태·매핑 안 된 거래처) → '오류' + 사유. 미매칭 상품코드는 성공(미매칭 목록에 쌓임)
       모르는 업태·매핑 안 된 거래처는 파일 전체를 쓰지 않는다(판매원장 그대로)
     · 같은 파일 재투입(같은 내용) → 건너뜀. 실패한 파일을 고쳐 다시 넣으면 다시 처리. 엑셀이 아닌 파일은 손대지 않음
     · 회당 최대 파일 수·5분 시간 예산 — 남은 파일은 다음 실행에서. 다른 반영이 락을 잡고 있으면 오류가 아니라 다음 실행으로
     · ERP — 시트·업로드로그·상태·실행 로그 어디에도 개인정보 없음, 임시 파일 없음(드라이브에 새 파일이 생기지 않음)
     · 공유 드라이브 — Drive 호출마다 supportsAllDrives, 목록은 corpora drive·driveId, 업로더 = lastModifyingUser 이메일
     · 권한 부족으로 이동·휴지통 실패 → 반영은 그대로, 업로드로그 수신함처리 열·상태 경고에 사유. 오류 폴더로 못 옮긴 실패 파일은 매번 다시 실패하지 않음
     · 처리완료 보관일수가 지난 파일(이 작업이 옮긴 것만)은 휴지통으로
     · Sheets API — 파일 1개 처리 호출 수(읽기 2 + 쓰기), 분당 상한 때문에 파일 사이에서 기다림, 한도 초과 대체 횟수 표시
   엑셀 읽기(SheetJS)는 tests/offline-inbox-parsers.test.js가 실파일로 검사한다 — 여기서는 파일 내용을 JSON 2차원 배열로 두고
   가짜 XLSX(같은 readWorkbookRows·dropUnusedColumns 경로를 그대로 탄다)로 읽는다.

   실행: node tests/offline-inbox.test.js  (또는 node tests/run-all.js) */
const path = require('path'), crypto = require('crypto');
const { loadOfflineGas, dataRows, installDrive, installScriptApp } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const P = require(path.join(__dirname, '..', 'src', 'features', 'offline', 'parsers.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 900) : '')); }
}
const J = JSON.stringify;
const TODAY = '2026-10-06';
const PARTNER = { emailAddress: 'partner@athomecorp.com', displayName: '협력사 담당' };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ── 합성 파일(파서 입력 모양) — tests/offline-sheets-api.test.js와 같은 양식 ──
function storeSales(dates, lines) {
  return [['업태명', '점포코드', '점포명', '상품코드', '상품명', '대분류', '중분류', '소분류', '브랜드'].concat(dates, ['합계', '평균'])]
    .concat(lines.map(l => [l[0], l[1], l[2], l[3], '가상 ' + l[3], '가전', '가전', '가전', '기타'].concat(l.slice(4), [0, 0])));
}
function stockFile(lines) {
  return [['구분', '전월재고', '매입', '매출', '이관', '현재고'], ['수량', 0, 0, 0, 0, 0], [], [],
    ['조회일자', '점포명', '점포코드', '상품명', '전월수량', '전월금액', '현재수량', '현재금액', '이관량', '이관액', '매입량', '매입액', '상품코드', '매출량']]
    .concat(lines.map(l => ['202610', l[0], l[1], '가상 ' + l[2], 0, 0, l[3], 0, 0, 0, 0, 0, l[2], l[4]]));
}
function etlandSales(lines) {
  return [['판매내역'], ['거래처코드', '거래처명', '지부', '지점코드', '지점명', '품목', '상품구분', '모델명', '설명', '판매수량', '단가', '금액', '판매일자', '구분']]
    .concat(lines.map(l => ['1', '가상', '충청', l[1], '점' + l[1], '청소기', '매입상품', l[2], '가상 ' + l[2], String(l[3]), '1', '1', l[0], '판매(계약)']));
}
function himart(entries) {
  return [['지사명', '인도처코드', '인도처명', '상품코드', '상품명', '당월실판매', '당월판매', '금주판매', '당일판매', '잔여재고', '회전율']]
    .concat(Object.keys(entries).map(k => { const [s, c] = k.split('|'); return ['가상지사', s, s + 'HM', c, '가상 ' + c].concat(entries[k], [0]); }));
}
const ERP_HEAD = ['날짜', '주문일', '매장', '매출구분', '주문번호', '전표번호', '거래처코드', '거래처명', '담당자', '자체(연계)코드', '회계(연계)코드', '주문자명', '주문자ID', '주문자 전화번호', '주문자 휴대폰',
  '수취인명', '수취인 전화번호', '수취인 휴대폰', '우편번호', '주소', '브랜드', '브랜드코드', '상품코드', '상품상태', '마켓상품코드', '자체코드', '판매자코드', '카테고리', '로케이션', '창고구분', '창고코드',
  '기본상품명', '기본상품 규격', '주문상품명', '주문상품 규격', '상품명 별칭', '상품비고', '관리비고', '관리코드', '송장번호', '택배사', '수불구분', '수량', '매출단가', '금액', '수수료', '수수료율', '공급액', '물류비',
  '인터넷단가', '인터넷총액', '원가', '원가총액', '이익액', '이익율', '이익액', '이익율'];
const ERP_GROUP = ERP_HEAD.map((h, i) => ({ 0: '주문정보', 6: '거래처정보', 11: '주문자명', 12: '주문자정보', 15: '수령자정보', 20: '상품정보', 39: '배송정보', 41: '수불구분', 42: '수량', 43: '총액' })[i] || '');
const PII = { '주문자명': '홍길동가짜', '주문자ID': 'fakeuser01', '주문자 전화번호': '02-333-4444', '주문자 휴대폰': '010-1111-2222', '수취인명': '김수취가짜',
  '수취인 전화번호': '02-555-6666', '수취인 휴대폰': '010-5555-6666', '우편번호': '06236', '주소': '서울 가상구 가상로 1', '송장번호': '555566667777' };
function erpFile(lines) { // [날짜, 거래처코드, 상품코드, 수량, 금액, 수수료]
  return [ERP_GROUP, ERP_HEAD].concat(lines.map(l => ERP_HEAD.map(h => (PII[h] || ({ 날짜: l[0], 주문일: l[0], 매출구분: '앳홈', 거래처코드: l[1], 거래처명: '거래처 ' + l[1], 브랜드: '미닉스 더 플렌더',
    상품코드: l[2], 카테고리: '본품', 창고구분: '토마스', 기본상품명: '미닉스 더 플렌더 MAX (MNFD-200G)', 수불구분: '매출출고', 수량: l[3], 금액: l[4], 수수료: l[5], 매출단가: l[4] / l[3] })[h]) ?? '')));
}
const ERP_NAME = '백화점, 폐쇄몰, 렌탈 매출이익리스트(2026-10-01~2026-10-31).xlsx';
const FILES = () => [
  ['판매재고현황_20261002.xlsx', himart({ 'S1|C1': [2, 4, 3, 2, 4], 'S2|C2': [1, 1, 1, 0, 3] })],
  ['현재고_2026-10-03_101010.xls', [['현 재고'], ['거래처코드', '거래처명', '지부', '입고지점코드', '입고지점', '품목', '모델명', '설명', '재고수량', '타지점입고 예정수량', '합계', '단가', '재고금액', '판매 예약수량'],
    ['1', '가상', '중부', '302001', '점302001', 'KREF', 'MNFD-200G', '가상', '4', '1', '0', '1', '1', '0']]],
  ['판매재고현황_20261001.xlsx', himart({ 'S1|C1': [1, 2, 1, 1, 5], 'S2|C2': [0, 1, 1, 1, 3] })],
  [ERP_NAME, erpFile([['2026-10-02', '00476', '9812365001397', 2, 660000, 0], ['2026-10-03', '00474', '9812365001397', 1, 330000, 30000]])],
  ['재고현황_상세_20261003101010.xlsx', stockFile([['EM 성수', '1003', '8800000000001', 5, 0], ['TR 월계', '2001', '8800000000001', 3, 0]])],
  ['판매내역_2026-10-03_101010.xls', etlandSales([['2026-10-01', '302001', 'MNFD-200G', 2], ['2026-10-02', '302002', 'MNVC-100G', 1]])],
  ['기간별매출(상품별)_일별상세_20261003101010.xlsx', storeSales(['10월01일', '10월02일'], [['이마트', '1003', 'EM 성수', '8800000000001', 2, 1], ['트레이더스', '2001', 'TR 월계', '8800000000001', 1, 0]])]
];
const ORDER = ['기간별매출(상품별)_일별상세_20261003101010.xlsx', '재고현황_상세_20261003101010.xlsx', ERP_NAME, '판매내역_2026-10-03_101010.xls', '현재고_2026-10-03_101010.xls',
  '판매재고현황_20261001.xlsx', '판매재고현황_20261002.xlsx'];

// 가짜 XLSX — 파일 바이트(JSON 2차원 배열)를 한 시트로. readWorkbookRows·dropUnusedColumns는 실코드 그대로 탄다
const FAKE_XLSX = { version: 'fake', read: bytes => ({ SheetNames: ['S'], Sheets: { S: { '!rows': JSON.parse(Buffer.from(bytes).toString('utf8')) } } }),
  utils: { sheet_to_json: ws => ws['!rows'].map(r => r.slice()), decode_cell() {}, encode_range() {} } };

function inboxEnv(opts) {
  opts = opts || {};
  const g = loadOfflineGas({ setup: true, today: TODAY, sheetsApiFailEvery: opts.failEvery });
  let n = 0;
  g.ctx.Utilities.getUuid = () => String(++n).padStart(4, '0') + '-uuid';
  g.scriptProps.OFFLINE_INBOX_FOLDER_ID = 'INBOX';
  g.d = installDrive();
  g.triggers = installScriptApp();
  g.d.add({ id: 'INBOX', name: '오프라인 수신함', mimeType: g.d.FOLDER, parents: ['SHARED-ROOT'] });
  g.ctx._offXlsxLib = FAKE_XLSX;
  g.rows = name => dataRows(g.tab(name));
  g.put = (name, rows, extra) => {
    const bytes = Buffer.from(JSON.stringify(rows), 'utf8');
    return g.d.add(Object.assign({ name, mimeType: /\.xls$/.test(name) ? 'application/vnd.ms-excel' : XLSX_MIME, parents: ['INBOX'], md5Checksum: crypto.createHash('md5').update(bytes).digest('hex'),
      size: String(bytes.length), lastModifyingUser: PARTNER, bytes }, extra || {}));
  };
  g.run = () => g.ctx._offInboxRun('editor');
  g.folder = name => (Object.values(g.d.files).find(f => f.name === name && f.mimeType === g.d.FOLDER && f.parents[0] === 'INBOX') || {}).id;
  g.namesIn = id => g.d.in(id).filter(f => f.mimeType !== g.d.FOLDER).map(f => f.name).sort();
  return g;
}
// upload_id(반영 시각 초 + 일련번호)는 실행마다 다르다 — 그 업로드의 파일명으로 바꿔 놓고 비교(같은 초에 돌지 않아도 같게)
const normTab = (rows, log) => { const ids = {}; log.forEach(r => { ids[r[0]] = 'ID:' + r[3]; }); return J(rows.map(r => r.map(v => ids[v] || v))); };
function setSetting(g, key, val) { const st = g.tab('설정'), r = st._grid.find(x => x[0] === key); r[1] = val; }

(function main() {
  console.log('\n[1] 수신함 7개 파일 — 수동 업로드와 같은 결과, 처리 순서, 처리완료 폴더, 업로드로그');
  const ga = inboxEnv();
  FILES().forEach(([n, rows]) => ga.put(n, rows));
  ga.put('메모.txt', [['엑셀 아님']], { mimeType: 'text/plain' });
  const st = ga.run();
  const done = ga.folder('처리완료'), err = ga.folder('오류');
  check('7개 성공 · 오류 0 · 엑셀 아닌 파일 1개는 손대지 않음', st.counts.success === 7 && st.counts.error === 0 && st.ignored === 1 && !st.note, st);
  check('처리 순서 = 이마트 일별상세 → 이마트 재고 → 나머지(파일명 순) → 하이마트(기준일 오름차순)', J(st.files.map(f => f.name)) === J(ORDER), st.files.map(f => f.name));
  check('하위 폴더 처리완료·오류를 만들고, 7개는 처리완료로 · 수신함에는 메모.txt만', done && err && J(ga.namesIn(done)) === J(ORDER.slice().sort()) && J(ga.namesIn('INBOX')) === J(['메모.txt']));
  const log = ga.rows('업로드로그');
  check('업로드로그 7행 — 반영방식 자동 반영, 업로더 = 파일을 마지막으로 고친 사람, 원본파일ID·수정시각·MD5', log.length === 7 && log.every(r => r[12] === '자동 반영' && r[2] === PARTNER.emailAddress && r[13] && r[14] && r[15] && r[11] === '성공'), log.map(r => r.slice(11)));
  const autoTabs = {}; ga.off._order.forEach(n => { autoTabs[n] = ga.rows(n); });
  const autoNorm = nm => normTab(autoTabs[nm], autoTabs['업로드로그']);
  const autoRes = st.files;
  // 같은 파일들을 같은 순서로 수동 업로드(브라우저 경로: 파서 → toUploadPayload → offline_upload)
  const gm = loadOfflineGas({ setup: true, today: TODAY });
  let n2 = 0;
  gm.ctx.Utilities.getUuid = () => String(++n2).padStart(4, '0') + '-uuid';
  const offsets = {};
  gm.ctx._offReadRows(gm.tab('채널마스터'), gm.ctx.OFF_TABS.channel).forEach(r => { const o = gm.ctx._offStockOffsetOf(r); if (r[0] && o) offsets[r[0]] = o; });
  const byName = {}; FILES().forEach(([nm, rows]) => { byName[nm] = rows; });
  ORDER.forEach(nm => {
    const p = P.parseRows(P.dropUnusedColumns(byName[nm]), { fileName: nm, today: TODAY, stockOffsets: offsets });
    gm.ctx._offUpload(P.toUploadPayload(p, { fileName: nm }), { email: 'tester@athomecorp.com' });
  });
  const diff = gm.off._order.filter(nm => nm !== '업로드로그' && normTab(dataRows(gm.tab(nm)), dataRows(gm.tab('업로드로그'))) !== autoNorm(nm));
  check('업로드로그 밖 모든 탭이 수동 업로드와 칸 단위로 같다(판매원장·재고·스냅샷·점포·미매칭…)', !diff.length, diff.map(nm => [nm, autoTabs[nm], dataRows(gm.tab(nm))]));
  const mlog = dataRows(gm.tab('업로드로그'));
  const same = (r, m) => J(r.slice(3, 12)) === J(m.slice(3, 12)) && m[12] === '수동';
  check('  ↳ 업로드로그도 파일명·유형·채널·기간·행 수·미매칭·경고·상태가 같다(반영방식만 수동/자동)', log.every((r, i) => same(r, mlog[i])), log.map((r, i) => [r.slice(3, 12), mlog[i].slice(3, 12)]));
  check('미매칭 상품코드는 실패가 아니다 — 성공하고 미매칭 목록에 쌓임', autoRes.some(f => /미매칭 \d+개/.test(f.detail)) && dataRows(gm.tab('미매칭코드')).length > 0);

  console.log('\n[2] 같은 파일 재투입 → 건너뜀 · 실패 파일 → 오류 폴더 · 고쳐서 다시 넣으면 처리');
  {
    const g = inboxEnv(); // [1]의 수동 비교 env가 전역을 바꿨다 — 새로(tests/lib/offline-gas.js 주석)
    FILES().forEach(([nm, rows]) => g.put(nm, rows));
    g.run();
    const salesBefore = J(g.rows('판매원장')), logBefore = g.rows('업로드로그').length;
    const [n0, rows0] = FILES()[6];
    g.put(n0, rows0); // 같은 내용을 다시(새 파일 ID)
    g.put('알수없는파일.xlsx', [['가', '나'], [1, 2]]);
    g.put('기간별매출(상품별)_일별요약_20261003101010.xlsx', [['상품 코드', '상품명', '10월 1일', '합계', '평균'], ['8800000000001', '가상', 1, 1, 1]]);
    // 모르는 업태명(SSG) — 자동 반영은 파일 전체를 쓰지 않는다
    g.put('기간별매출(상품별)_일별상세_20261004101010.xlsx', storeSales(['10월03일'], [['이마트', '1003', 'EM 성수', '8800000000001', 9], ['SSG', '9001', '가상점', '8800000000001', 1]]));
    // 매핑 안 된 거래처(00999)
    g.put('백화점, 폐쇄몰, 렌탈 매출이익리스트(2026-10-01~2026-10-05).xlsx', erpFile([['2026-10-04', '00476', '9812365001397', 1, 330000, 0], ['2026-10-04', '00999', '9812365001397', 1, 300000, 0]]));
    const s2 = g.run();
    const errNames = g.namesIn(g.folder('오류'));
    check('같은 내용 재투입 → 건너뜀(반영·로그 없음) · 처리완료로 옮김', s2.counts.skipped === 1 && s2.files.some(f => f.result === 'skipped' && /이미 반영/.test(f.detail)) && g.namesIn(g.folder('처리완료')).filter(x => x === n0).length === 2, s2);
    check('판별 불가 · 반영 불가 양식(트레이더스 합쳐진 합계) · 모르는 업태 · 매핑 안 된 거래처 → 오류 4개, 오류 폴더로', s2.counts.error === 4 && errNames.length === 4, [s2.files, errNames]);
    check('  ↳ 사유가 업로드로그(실패)·상태에 — 판별 불가 / 반영할 수 없는 양식 / 원천업태명 SSG / 거래처 00999', ['판별 불가', '반영할 수 없는 양식', 'SSG', '00999'].every(k => s2.files.some(f => f.result === 'error' && f.detail.indexOf(k) >= 0)) &&
      g.rows('업로드로그').length === logBefore + 4 && g.rows('업로드로그').slice(-4).every(r => /^실패: /.test(r[11]) && r[12] === '자동 반영'), s2.files.map(f => f.detail));
    check('  ↳ 모르는 업태·매핑 안 된 거래처 파일은 판매원장을 하나도 바꾸지 않았다(이마트 10/3 9개·신세계 10/4도 없음)', J(g.rows('판매원장')) === salesBefore);
    // 고쳐서 다시: 채널마스터 원천업태명에 SSG를 이마트로 추가하고 같은 파일을 오류 폴더에서 수신함으로 옮김
    const emartRow = g.tab('채널마스터')._grid.find(r => r[0] === 'emart'); emartRow[6] = '이마트, SSG';
    const back = Object.values(g.d.files).find(f => /20261004101010/.test(f.name));
    back.parents = ['INBOX'];
    g.ctx._offInvalidateCache();
    const s3 = g.run();
    check('채널마스터를 고친 뒤 실패 파일을 수신함에 다시 넣으면 다시 처리해 성공', s3.counts.success === 1 && s3.files[0].name === back.name && g.namesIn(g.folder('처리완료')).indexOf(back.name) >= 0, s3);
  }

  console.log('\n[3] 회당 최대 파일 수 · 5분 시간 예산 · 다른 반영이 락을 잡고 있으면 다음 실행으로');
  {
    const g = inboxEnv();
    FILES().forEach(([nm, rows]) => g.put(nm, rows));
    setSetting(g, '자동반영_회당최대파일수', 3);
    const a = g.run();
    check('최대 3개 — 3개 반영, 4개는 다음 실행으로(수신함에 그대로)', a.counts.success === 3 && a.counts.deferred === 4 && /회당 최대 3개/.test(a.note) && g.namesIn('INBOX').length === 4, a);
    check('  ↳ 순서대로 앞의 3개(이마트 일별상세·재고·ERP)', J(a.files.map(f => f.name)) === J(ORDER.slice(0, 3)));
    const b = g.run(), c = g.run();
    check('다음 실행 3개, 그다음 1개 — 하이마트는 기준일 오름차순(10/1 → 10/2)', b.counts.success === 3 && c.counts.success === 1 && J(b.files.concat(c.files).map(f => f.name)) === J(ORDER.slice(3)) && !g.namesIn('INBOX').length, [b.files, c.files]);
    // 시간 예산: 첫 파일 뒤 예산을 넘기면 남은 파일은 다음 실행
    const g2 = inboxEnv();
    FILES().forEach(([nm, rows]) => g2.put(nm, rows));
    g2.ctx.OFF_INBOX_TIME_BUDGET_MS = 1;
    const t = g2.run();
    check('5분 예산을 넘기면 첫 파일만 하고 나머지 6개는 다음 실행으로', t.counts.success === 1 && t.counts.deferred === 6 && /실행 시간/.test(t.note), t);
    // 락: 다른 반영이 진행 중
    const g3 = inboxEnv();
    g3.put(FILES()[6][0], FILES()[6][1]);
    const real = global.LockService.getDocumentLock;
    global.LockService.getDocumentLock = () => ({ tryLock: () => false, releaseLock() {} });
    const l = g3.run();
    global.LockService.getDocumentLock = real;
    check('다른 반영이 락을 잡고 있으면 오류가 아니라 다음 실행으로(수신함에 그대로, 로그 없음)', l.counts.deferred === 1 && l.counts.error === 0 && g3.namesIn('INBOX').length === 1 && !g3.rows('업로드로그').length, l);
    const l2 = g3.run();
    check('  ↳ 다음 실행에서 반영', l2.counts.success === 1);
    // 같은 실행이 겹치면(트리거 + [지금 확인]) 뒤 것은 바로 돌아간다
    g3.cacheStore['offline:inbox:running'] = '1';
    check('이미 실행 중이면 겹쳐 돌지 않는다', g3.run().busy === true);
    delete g3.cacheStore['offline:inbox:running'];
  }

  console.log('\n[4] ERP 개인정보 · 임시 파일 · 공유 드라이브 인자 · 업로더');
  {
    const g = inboxEnv();
    const logs = [];
    global.Logger.log = s => { logs.push(String(s)); };
    g.put(ERP_NAME, FILES()[3][1]);
    const before = Object.keys(g.d.files).length;
    const s = g.run();
    global.Logger.log = () => {};
    const everything = J(g.off._order.map(nm => g.tab(nm)._grid)) + J(s) + logs.join('\n') + J(g.scriptProps) + J(g.cacheStore);
    const leaked = Object.values(PII).filter(v => everything.indexOf(v) >= 0);
    check('ERP 반영 성공 — 시트·업로드로그·상태·실행 로그·스크립트 속성·캐시 어디에도 개인정보 값 없음', s.counts.success === 1 && !leaked.length, leaked);
    check('임시 파일 없음 — 드라이브에 새 파일은 하위 폴더 2개뿐(처리완료·오류)', Object.keys(g.d.files).length === before + 2 && Object.values(g.d.files).filter(f => f.mimeType !== g.d.FOLDER).length === 1);
    const driveCalls = g.d.calls.filter(c => c.op !== 'download');
    check('Drive 호출마다 supportsAllDrives, 목록은 includeItemsFromAllDrives·corpora drive·driveId(수신함 폴더 정보에서)',
      driveCalls.every(c => c.opt && c.opt.supportsAllDrives === true) && g.d.calls.filter(c => c.op === 'list').every(c => c.opt.corpora === 'drive' && c.opt.driveId === g.d.DRIVE_ID && c.opt.includeItemsFromAllDrives === true), driveCalls.filter(c => !c.opt || !c.opt.supportsAllDrives));
    check('업로더 = lastModifyingUser 이메일(공유 드라이브 파일 소유자는 조직)', g.rows('업로드로그')[0][2] === PARTNER.emailAddress);
    // 목록이 여러 쪽이면 다음 쪽까지
    const g2 = inboxEnv();
    for (let i = 0; i < 205; i++) g2.put('메모' + i + '.txt', [['x']], { mimeType: 'text/plain' });
    g2.put(FILES()[6][0], FILES()[6][1]);
    const p = g2.run();
    check('수신함 파일이 200개를 넘어도(목록 여러 쪽) 다 본다', p.counts.success === 1 && p.ignored === 205 && g2.d.calls.some(c => c.op === 'list' && c.opt.pageToken));
  }

  console.log('\n[5] 권한 부족 — 이동·휴지통 실패해도 반영은 그대로, 사유 기록, 실패 파일은 매번 다시 실패하지 않음');
  {
    const g = inboxEnv();
    g.put(FILES()[6][0], FILES()[6][1]);
    g.put('알수없는파일.xlsx', [['가', '나'], [1, 2]]);
    g.d.deny.move = true;
    const s = g.run();
    const log = g.rows('업로드로그');
    check('반영은 그대로(성공 1·오류 1) — 파일은 수신함에 남음', s.counts.success === 1 && s.counts.error === 1 && g.namesIn('INBOX').length === 2 && g.rows('판매원장').length > 0, s);
    check('업로드로그 수신함처리 열·상태 경고에 이동 실패 사유(콘텐츠 관리자 권한)', log.length === 2 && log.every(r => /폴더로 옮기지 못함\(콘텐츠 관리자 권한 필요\)/.test(r[16])) && s.warnings.length === 2, [log.map(r => r[16]), s.warnings]);
    const s2 = g.run();
    check('다음 실행 — 성공 파일은 이미 반영(건너뜀), 실패 파일도 다시 실패 로그를 남기지 않음', s2.counts.skipped === 2 && s2.counts.error === 0 && s2.counts.success === 0 && g.rows('업로드로그').length === 2, s2);
    const api = g.ctx._offGetUploadLog();
    check('offline_getUploadLog — 자동 반영 표시·수신함처리 사유', api.items.every(x => x.mode === 'auto' && /옮기지 못함/.test(x.inboxNote)));
  }

  console.log('\n[6] 처리완료 보관일수 — 지난 파일만 휴지통, 사람이 넣은 파일은 그대로, 휴지통 실패는 경고');
  {
    const g = inboxEnv();
    const done = g.d.add({ name: '처리완료', mimeType: g.d.FOLDER, parents: ['INBOX'] }).id;
    g.d.add({ name: 'old.xlsx', mimeType: XLSX_MIME, parents: [done], appProperties: { offlineInboxAt: '2026-08-01 10:00:00' } });
    g.d.add({ name: 'recent.xlsx', mimeType: XLSX_MIME, parents: [done], appProperties: { offlineInboxAt: '2099-01-01 10:00:00' } });
    g.d.add({ name: 'human.xlsx', mimeType: XLSX_MIME, parents: [done] });
    const s = g.run();
    check('보관일수(30일) 지난 old만 휴지통, recent·사람이 넣은 human은 그대로', s.trashed === 1 && J(g.namesIn(done)) === J(['human.xlsx', 'recent.xlsx']), [s, g.namesIn(done)]);
    g.d.add({ name: 'old2.xlsx', mimeType: XLSX_MIME, parents: [done], appProperties: { offlineInboxAt: '2026-08-01 10:00:00' } });
    g.d.deny.trash = true;
    const s2 = g.run();
    check('  ↳ 휴지통 권한이 없으면 경고(콘텐츠 관리자 권한)로 남기고 계속', !s2.trashed && s2.warnings.some(w => /old2\.xlsx.*휴지통으로 보내지 못함\(콘텐츠 관리자 권한 필요\)/.test(w)), s2.warnings);
  }

  console.log('\n[7] Sheets API — 파일 1개 호출 수, 분당 상한으로 파일 사이에서 기다림, 한도 초과 대체 횟수');
  {
    const g = inboxEnv();
    FILES().forEach(([nm, rows]) => g.put(nm, rows));
    g.api.reset();
    // 가상 시계 — sleep만큼 시각이 흐른다(실제처럼). 그래야 "어느 1분 구간에서도 상한 이하"를 볼 수 있다
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    global.Utilities.sleep = ms => { shift += ms; g.slept.ms += ms; };
    const t0 = g.ctx._offApiTimes.length;
    let s;
    try { s = g.run(); } finally { Date.now = realNow; }
    const times = g.ctx._offApiTimes.slice(t0);
    const maxPerMin = times.reduce((m, t) => Math.max(m, times.filter(x => x >= t && x < t + 60000).length), 0);
    const per = s.files.map(f => f.name.slice(0, 18) + ' ' + f.apiCalls);
    check('파일 1개 = Sheets API ' + s.files[0].apiCalls + '번(이마트 일별상세: 읽기 2 + 쓰기 4) — 하이마트 ' + s.files[6].apiCalls + '번', s.files[0].apiCalls === 6 && s.files[6].apiCalls === 9, per);
    check('  ↳ 실행 전체 ' + s.apiCalls + '번(설정·업로드로그·채널마스터 읽기 포함) — 어느 1분 구간에서도 ' + maxPerMin + '번 ≤ 상한 ' + g.ctx.OFF_INBOX_API_PER_MIN + '번(파일 사이에서 ' + Math.round(s.waitedMs / 1000) + '초 기다림)',
      s.apiCalls === g.api.calls.length && maxPerMin <= g.ctx.OFF_INBOX_API_PER_MIN && s.waitedMs > 0, [s.apiCalls, maxPerMin, s.waitedMs]);
    const gq = inboxEnv({ failEvery: 4 });
    FILES().forEach(([nm, rows]) => gq.put(nm, rows));
    const q = gq.run();
    check('한도 초과가 섞이면 SpreadsheetApp 대체 횟수를 상태에 — 결과는 성공', q.counts.success === 7 && q.apiFallbacks > 0, [q.counts, q.apiFallbacks]);
    check('  ↳ 대체가 생긴 파일의 업로드로그 수신함처리 열에 횟수', gq.rows('업로드로그').some(r => /한도 초과로 SpreadsheetApp 대체 \d+회/.test(r[16])));
    const diff = gq.off._order.filter(nm => nm !== '업로드로그' && normTab(gq.rows(nm), gq.rows('업로드로그')) !== autoNorm(nm));
    check('  ↳ 대체가 섞여도 시트 결과는 [1]과 같다', !diff.length, diff);
  }

  console.log('\n[8] 트리거 · 사용 여부 · 시각 범위 · 상태 · doPost · 폴더 미등록 · SheetJS를 못 받을 때');
  {
    const g = inboxEnv();
    const a = g.ctx.offline_installInboxTrigger(), b = g.ctx.offline_installInboxTrigger();
    check('트리거 설치 — 1시간마다 offline_inboxTick, 두 번 실행해도 하나(중복 설치 방지)', g.triggers.length === 1 && g.triggers[0].handler === 'offline_inboxTick' && g.triggers[0].hours === 1 &&
      a.removedBefore === 0 && b.removedBefore === 1 && b.folderSet === true, [a, b]);
    g.put(FILES()[6][0], FILES()[6][1]);
    const fmt = g.ctx.Utilities.formatDate;
    const at = h => { g.ctx.Utilities.formatDate = (d, tz, f) => (f === 'HH' ? String(h).padStart(2, '0') : fmt(d, tz, f)); };
    setSetting(g, '자동반영_사용', 'N'); at(10);
    check('자동반영_사용 = N이면 트리거는 아무것도 하지 않는다', /N/.test(g.ctx.offline_inboxTick().skipped) && g.namesIn('INBOX').length === 1);
    setSetting(g, '자동반영_사용', 'Y'); at(22);
    check('시각 범위(7~22시) 밖 — 22시는 하지 않는다', /시각 범위 밖/.test(g.ctx.offline_inboxTick().skipped) && g.namesIn('INBOX').length === 1);
    at(6);
    check('  ↳ 6시도 하지 않는다', /시각 범위 밖/.test(g.ctx.offline_inboxTick().skipped));
    at(7);
    const t = g.ctx.offline_inboxTick();
    check('7시 — 반영(트리거 실행 표시)', t.counts.success === 1 && t.by === 'trigger');
    g.ctx.Utilities.formatDate = fmt;
    setSetting(g, '자동반영_시작시각', 'abc'); setSetting(g, '자동반영_종료시각', 3); setSetting(g, '자동반영_회당최대파일수', 0);
    const s = g.ctx._offInboxSettings();
    check('잘못된 설정값은 기본값(시작 7·종료 22·최대 10)', s.startHour === 7 && s.endHour === 22 && s.maxFiles === 10 && s.enabled === true, s);
    const AUTH = { email: 'tester@athomecorp.com' };
    const call = (action, data) => JSON.parse(g.ctx._offlineHandle(action, data || {}, AUTH));
    g.put(FILES()[5][0], FILES()[5][1]);
    const m = call('offline_processInbox');
    check('doPost offline_processInbox = [지금 확인] — 사용 여부·시각과 관계없이 바로, 실행한 사람 표시', m.success && m.counts.success === 1 && m.by === 'manual:tester@athomecorp.com', m);
    const st = call('offline_getInboxStatus');
    check('doPost offline_getInboxStatus — 폴더 링크·설정·트리거·마지막 실행', st.success && st.folderUrl === 'https://drive.google.com/drive/folders/INBOX' && st.triggerInstalled === true &&
      st.last.by === 'manual:tester@athomecorp.com' && st.last.counts.success === 1 && st.last.files[0].name === FILES()[5][0] && st.apiPerMin === 30, st);
    g.ctx.offline_removeInboxTrigger();
    check('트리거 제거 → 상태에 설치 안 됨', g.triggers.length === 0 && call('offline_getInboxStatus').triggerInstalled === false);
    delete g.scriptProps.OFFLINE_INBOX_FOLDER_ID;
    const nf = g.run();
    check('수신함 폴더 ID가 없으면 아무것도 하지 않고 안내', /OFFLINE_INBOX_FOLDER_ID/.test(nf.note) && call('offline_getInboxStatus').folderUrl === '');
    g.scriptProps.OFFLINE_INBOX_FOLDER_ID = 'INBOX';
    // SheetJS를 못 받으면 파일은 그대로(오류로 보내지 않음)
    g.put('판매내역_2026-10-05_101010.xls', etlandSales([['2026-10-04', '302001', 'MNFD-200G', 1]]));
    g.ctx._offXlsxLib = null;
    global.UrlFetchApp.fetch = () => ({ getResponseCode: () => 503, getContentText: () => '' });
    const x = g.run();
    check('SheetJS를 못 받으면 파일은 수신함에 그대로(다음 실행으로) · 오류 폴더로 보내지 않음', x.counts.deferred === 1 && x.counts.error === 0 && /HTTP 503/.test(x.note) &&
      g.namesIn('INBOX').indexOf('판매내역_2026-10-05_101010.xls') >= 0, x);
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})();
