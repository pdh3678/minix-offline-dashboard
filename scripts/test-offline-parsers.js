/* 오프라인 파서 테스트 — node scripts/test-offline-parsers.js (tests/run-all.js에도 포함)
   실데이터가 아닌 **합성 픽스처**만 쓴다(samples/는 커밋 금지). 픽스처는 samples/ 실파일의 헤더·배치
   구조(제목 행, 요약 블록, 공백 섞인 헤더, 텍스트 숫자)를 그대로 흉내 낸 가짜 값이다.
   SheetJS가 있으면(XLSX_PATH 환경변수 또는 require('xlsx')) 워크북 읽기(범위 보정·HTML raw)도 검사하고,
   없으면 그 부분만 건너뛴다 — 저장소에는 SheetJS 의존성이 없다(브라우저는 CDN으로 로드). */
const path = require('path');
const P = require(path.join(__dirname, '..', 'src', 'features', 'offline', 'parsers.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const TODAY = '2026-09-27';
const sum = (a, k) => a.reduce((s, r) => s + (Number(r[k]) || 0), 0);

// ── 합성 픽스처 ──
const EMART_STOCK = [
  ['구분', '전월재고', '매입', '매출', '이관', '현재고'],
  ['수량', 12, 3, 4, 0, 11],
  ['금액', 0, 0, 0, 0, 999],
  ['', '', '', '', '', ''],
  ['조회일자', '점포명', '점포코드', '상품명', '전월수량', '전월금액', '현재수량', '현재금액', '이관량', '이관액', '매입량', '매입액', '상품코드', '매출량'],
  ['202609', 'EM가상점', '0012', '가상 블렌더 A', 5, 0, 4, 100, 0, 0, 1, 0, '8800000000011', 2],
  ['202609', 'EM가상점', '0012', '가상 블렌더 B', 3, 0, 3, 100, 0, 0, 0, 0, '2790000000022', 0],
  ['202609', 'EM테스트점', '1003', '가상 블렌더 A', 4, 0, 4, 100, 0, 0, 2, 0, '8800000000011', 2],
  ['202609', 'EM테스트점', '1003', '가상 블렌더 C', 0, 0, 0, 0, 0, 0, 0, 0, '8800000000033', 0]
];
const EMART_DAILY = [
  ['상품 코드', '상품명', '9월 1일', '9월 2일', '9월 3일', '합계', '평균'],
  ['8800000000011', '가상 블렌더 A', 2, 0, -1, 1, 0],
  ['8800000000022', '가상 블렌더 B', '1,200', '', 3, 1203, 401],
  ['', '', '', '', '', '', '']
];
const ETLAND_SALES = [
  ['판매내역', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['거래처코드', '거래처명', '지부', '지점코드', '지점명', '품목', '상품구분', '모델명', '설명', '판매수량', '단가', '금액', '판매일자', '구분'],
  ['1000001', '가상거래처', '충청', '300001', '가상1점', '청소기', '매입상품', 'MNVC-999G', '가상 청소기', '1.000', '1000', '1000.000', '2026-09-02', '판매(계약)'],
  ['1000001', '가상거래처', '충청', '300001', '가상1점', '청소기', '매입상품', 'MNVC-999G', '가상 청소기', '1.000', '1000', '1000.000', '2026-09-02', '판매(계약)'],
  ['1000001', '가상거래처', '충청', '300001', '가상1점', '청소기', '매입상품', 'MNVC-999G', '가상 청소기', '-1.000', '1000', '-1000.000', '2026-09-02', '판매(계약)'],
  ['1000001', '가상거래처', '부산', '300002', '가상2점', '청소기', '매입상품', 'MNVC-999G.DEMO', '가상 청소기 전시', '1.000', '500', '500.000', '2026-09-05', '반품'],
  ['1000001', '가상거래처', '부산', '300002', '가상2점', '청소기', '매입상품', 'MNFD-999G', '가상 음처기', '2.000', '500', '500.000', '2026-09-01', '판매(계약)'],
  ['1000001', '가상거래처', '부산', '300002', '가상2점', '청소기', '매입상품', 'MNFD-999G', '가상 음처기', '-2.000', '500', '500.000', '2026-09-03', '판매(계약)'],
  ['1000001', '가상거래처', '부산', '300002', '가상2점', '청소기', '매입상품', 'MNFD-999G', '가상 음처기', '2.000', '500', '500.000', '2026-09-03', '판매(계약)']
];
const ETLAND_STOCK = [
  ['현 재고', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['거래처코드', '거래처명', '지부', '입고지점코드', '입고지점', '품목', '모델명', '설명', '재고수량', '타지점입고 예정수량', '합계', '단가', '재고금액', '판매 예약수량', 'PLC'],
  ['1000001', '가상거래처', '중부', '302001', '가상A점', 'KREF', 'MNKR-999G.DEMO', '가상 김치냉장고', '1.0', '0.0', '1.0', '10', '10.0', '0.0', 'X'],
  ['1000001', '가상거래처', '중부', '302001', '가상A점', 'KREF', 'MNKR-999G', '가상 김치냉장고', '2.0', '1.0', '3.0', '10', '20.0', '1.0', 'X'],
  ['1000001', '가상거래처', '남부', '302002', '가상B점', 'KREF', 'MNKR-999G', '가상 김치냉장고', '0.0', '0.0', '0.0', '10', '0.0', '0.0', 'X']
];
const HIMART = (rows) => [['지사명', '인도처코드', '인도처명', '상품코드', '상품명', '당월실판매', '당월판매', '금주판매', '당일판매', '잔여재고', '회전율']].concat(rows);
const HIMART_ROWS = [
  ['가상지사', 'A0001E', '가상1HM', '(J)MNMD-999G_OFF', '(진열) 가상 건조기', 1, 2, 1, 1, 0, 0],
  ['가상지사', 'A0001E', '가상1HM', 'MNMD-999G_OFF', '가상 건조기', 0, 0, 0, 0, 3, 0],
  ['물류센타', 'S01C', '가상물류', 'MNMD-999G_OFF', '가상 건조기', 0, 0, 0, 0, 40, 0],
  ['가상지사', 'B0002E', '가상2HM', 'MW00000_000000', '[리퍼 A급] 가상 커피머신', 0, -1, -1, 0, 1, 0]
];

console.log('\n[1] 판별 — 시그니처 헤더, 상위 15행, 공백 무시');
{
  const cases = [
    ['이마트 재고(요약 블록 뒤 5행 헤더)', EMART_STOCK, 'EMART_STOCK', 4],
    ['이마트 일별 매출(1행)', EMART_DAILY, 'EMART_DAILY_SALES', 0],
    ['전자랜드 판매내역(1행 제목 + 2행 헤더)', ETLAND_SALES, 'ETLAND_SALES', 1],
    ['전자랜드 현재고(모르는 열 PLC 섞임)', ETLAND_STOCK, 'ETLAND_STOCK', 1],
    ['하이마트 판매재고현황(1행)', HIMART(HIMART_ROWS), 'HIMART_SALES_STOCK', 0]
  ];
  cases.forEach(([l, rows, type, hi]) => {
    const d = P.detect(rows);
    check(l + ' → ' + type, d && d.type === type && d.headerIndex === hi, d);
  });
  check('아는 헤더가 없으면 null', P.detect([['a', 'b'], [1, 2]]) === null);
  const deep = Array.from({ length: 15 }, () => ['메모']).concat([HIMART([])[0]]);
  check('16행째 헤더는 찾지 않음(상위 15행만)', P.detect(deep) === null);
  check('유형을 지정하면 그 유형만 찾음', P.detect(EMART_STOCK, 'ETLAND_STOCK') === null && P.detect(EMART_STOCK, 'EMART_STOCK').headerIndex === 4);
  check('모르는 유형 지정은 null(예외 없음)', P.detect(EMART_STOCK, 'NOPE') === null);
  const shuffled = [['잔여재고', '상품명', '당일판매', '인도처코드', '당월판매', '상품코드', '당월실판매', '지사명', '인도처명', '금주판매'],
    [7, '가상', 1, 'A1', 2, 'MNX-1', 3, '지사', '점', 1]];
  const r = P.parseRows(shuffled, { fileName: 'x_20260901.xlsx', today: TODAY });
  check('열 순서가 달라도 헤더 이름으로 읽음', r.ok && r.records.himart[0].real === 3 && r.records.himart[0].sale === 2 && r.records.storeStock[0].stock === 7, r.records && r.records.himart);
}

console.log('\n[2] 파일명 기준일');
[
  ['판매재고현황_20260923.xlsx', '2026-09-23'], ['재고현황_상세_20260925104937.xlsx', '2026-09-25'],
  ['현재고_2026-09-25_124812.xls', '2026-09-25'], ['sales_2026_09_24.csv', '2026-09-24'],
  ['판매재고현황.xlsx', ''], ['x_20260231.xlsx', ''], ['x_2026-09_25.xlsx', ''], ['v120260923.xlsx', ''],
  // 날짜+시각 14자리(YYYYMMDDhhmmss)는 앞 8자리 — 이마트 포털 파일명(2026-09-28 트레이더스 분리)
  ['재고현황_상세_20260928101559.xlsx', '2026-09-28'], ['기간별매출(상품별)_일별상세_20260928101437.xlsx', '2026-09-28'],
  ['20260928101559.xlsx', '2026-09-28'], ['재고_20260231235959.xlsx', ''], ['x_20260928246060.xlsx', '2026-09-28']
].forEach(([n, want]) => check(`${n} → "${want}"`, P.dateFromFileName(n) === want, P.dateFromFileName(n)));
// 기존 샘플 파일명의 기준일은 바뀌지 않는다(14자리 규칙 추가 전 결과 그대로)
[['기간별매출(상품별)_일별요약_20260925104853.xlsx', '2026-09-25'], ['재고현황_상세_20260925104937.xlsx', '2026-09-25'],
  ['판매내역_2026-09-25_124820.xls', '2026-09-25'], ['현재고_2026-09-25_124812.xls', '2026-09-25'],
  ['판매재고현황_20260923.xlsx', '2026-09-23'], ['판매재고현황_20260924.xlsx', '2026-09-24']
].forEach(([n, want]) => check(`기존 샘플 ${n} → "${want}" 그대로`, P.dateFromFileName(n) === want, P.dateFromFileName(n)));

console.log('\n[3] 값 정규화');
{
  check("'1,234' → 1234", P.toNum('1,234') === 1234);
  check("'1.000' → 1 (텍스트 숫자)", P.toNum('1.000') === 1);
  check("빈칸 → 0", P.toNum('') === 0 && P.toNum(null) === 0);
  check('음수 그대로(반품)', P.toNum('-2.000') === -2 && P.toNum(-3) === -3);
  check('숫자 아닌 글자 → NaN(호출부가 경고)', isNaN(P.toNum('abc')));
  check('13자리 숫자 코드 → 문자열 그대로', P.toCode(8809770080951) === '8809770080951');
  check("'0012' 그대로", P.toCode(' 0012 ') === '0012');
  const serial = (Date.UTC(2026, 8, 1) - Date.UTC(1899, 11, 30)) / 86400000;
  check('엑셀 날짜 일련번호 → 2026-09-01', P.toDate(serial) === '2026-09-01', P.toDate(serial));
  check('일련번호에 시각이 붙어도 날짜만', P.toDate(serial + 0.99) === '2026-09-01');
  check("'2026.09.02' / '20260902' / '2026-9-2'", P.toDate('2026.09.02') === '2026-09-02' && P.toDate('20260902') === '2026-09-02' && P.toDate('2026-9-2') === '2026-09-02');
  check('없는 날짜는 null', P.toDate('2026-02-30') === null && P.toDate('abc') === null && P.toDate(5) === null);
}

console.log('\n[4] 이마트 점포 재고');
{
  const r = P.parseRows(EMART_STOCK, { fileName: '재고현황_상세_20260925104937.xlsx', today: TODAY });
  check('헤더 5행, 원본 4행, 기준일 = 파일명', r.ok && r.headerRow === 5 && r.rawRowCount === 4 && r.baseDate === '2026-09-25', r);
  const s = r.records.storeStock;
  check('점포 재고 4행(0 재고 포함)', s.length === 4 && s.some(x => x.code === '8800000000033' && x.stock === 0), s);
  check('현재수량·당월입고(매입량)·당월판매(매출량)', s[0].stock === 4 && s[0].monthIn === 1 && s[0].monthSale === 2, s[0]);
  check('이동중·예약은 파일에 없으므로 빈칸', s[0].transit === '' && s[0].reserved === '');
  check("점포코드 '0012' 문자열 보존", s[0].store === '0012');
  const c = r.records.channelStock;
  check('채널 합계 = 원본코드별 합', c.length === 3 && c.find(x => x.code === '8800000000011').stock === 8 && sum(c, 'stock') === 11, c);
  check('점포 2개(이름 포함, 지역 없음)', r.records.stores.length === 2 && r.records.stores[0].name === 'EM가상점' && r.records.stores[0].region === '');
  check('상품명 기록', r.records.names['2790000000022'] === '가상 블렌더 B');
  check('반영 예정 행수', r.plannedRows.stockStore === 4 && r.plannedRows.stockDaily === 3 && r.plannedRows.himartSnap === 0, r.plannedRows);
  const r2 = P.parseRows(EMART_STOCK, { fileName: '재고현황_상세.xlsx', today: TODAY });
  check('파일명에 날짜가 없으면 기준일 선택 필요', r2.needsDate && r2.baseDate === '' && r2.warnings.some(w => /기준일/.test(w)));
  const r3 = P.parseRows(EMART_STOCK, { fileName: '재고현황_상세.xlsx', baseDate: '2026-09-20', today: TODAY });
  check('미리보기에서 고른 기준일', !r3.needsDate && r3.baseDate === '2026-09-20');
  const r4 = P.parseRows(EMART_STOCK, { fileName: '재고현황_상세_20261003.xlsx', today: TODAY });
  check('조회일자(202609)와 기준일 월이 다르면 경고', r4.warnings.some(w => /조회일자/.test(w)), r4.warnings);
}

console.log('\n[5] 이마트 일별 매출');
{
  const r = P.parseRows(EMART_DAILY, { fileName: '기간별매출(상품별)_일별요약_20260925104853.xlsx', today: TODAY });
  const s = r.records.sales;
  check('합계·평균 열 제외, 0은 레코드 없음 → 4건', r.ok && s.length === 4, s);
  check('day 레코드, 점포 빈칸', s.every(x => x.s === x.e && x.store === ''));
  check("'1,200' 쉼표 처리, 음수 유지", s.find(x => x.code === '8800000000022' && x.s === '2026-09-01').qty === 1200 && s.find(x => x.s === '2026-09-03' && x.code === '8800000000011').qty === -1, s);
  check('교체 기간 기본값 = 파일의 최소~최대 날짜', r.period.start === '2026-09-01' && r.period.end === '2026-09-03', r.period);
  check('연도 추정(업로드 9월 → 9월은 올해)', r.year === 2026);
  check('빈 행은 원본 행수에서 제외', r.rawRowCount === 2, r.rawRowCount);
  const cross = [['상품 코드', '상품명', '12월 30일', '1월 2일', '합계'], ['A', 'x', 1, 2, 3]];
  const rc = P.parseRows(cross, { today: '2027-01-05' });
  check('해를 넘는 파일: 현재 월보다 미래 월(12월)은 전년도', rc.records.sales.map(x => x.s).join() === '2026-12-30,2027-01-02' && rc.period.start === '2026-12-30', rc.records.sales);
  const ro = P.parseRows(EMART_DAILY, { today: TODAY, year: 2025 });
  check('미리보기에서 연도 수정', ro.records.sales.every(x => x.s.slice(0, 4) === '2025') && ro.year === 2025);
}

console.log('\n[6] 전자랜드 판매내역');
{
  const r = P.parseRows(ETLAND_SALES, { fileName: '판매내역_2026-09-25_124820.xls', today: TODAY });
  const s = r.records.sales;
  const one = s.filter(x => x.code === 'MNVC-999G');
  check('같은 날·지점·모델 여러 줄 합산(1+1−1 = 1)', one.length === 1 && one[0].qty === 1 && one[0].s === '2026-09-02' && one[0].store === '300001', one);
  check('합이 0이 된 날은 레코드 없음(9/3: −2+2)', !s.some(x => x.s === '2026-09-03'), s);
  check('.DEMO 코드는 그대로 별도 코드', s.some(x => x.code === 'MNVC-999G.DEMO'));
  check('설치완료수량은 빈칸(하이마트만)', s.every(x => x.inst === ''));
  check('교체 기간 = 판매일자 최소~최대', r.period.start === '2026-09-01' && r.period.end === '2026-09-05', r.period);
  check('구분 값별 건수', r.summary.gubun['판매(계약)'] === 6 && r.summary.gubun['반품'] === 1, r.summary.gubun);
  check('"판매(계약)" 외의 값이면 경고', r.warnings.some(w => /판매\(계약\)/.test(w) && /반품 1건/.test(w)), r.warnings);
  check('점포 = 지점코드·지점명·지부', r.records.stores.length === 2 && r.records.stores[0].region === '충청' && r.records.stores[1].name === '가상2점');
  check('상품명 = 설명', r.records.names['MNFD-999G'] === '가상 음처기');
  check('반영 예정 = 판매 레코드 수', r.plannedRows.sales === s.length);
}

console.log('\n[7] 전자랜드 현재고');
{
  const r = P.parseRows(ETLAND_STOCK, { fileName: '현재고_2026-09-25_124812.xls', today: TODAY });
  const s = r.records.storeStock;
  check('3행, 기준일 = 파일명', r.ok && s.length === 3 && r.baseDate === '2026-09-25');
  const x = s.find(o => o.code === 'MNKR-999G' && o.store === '302001');
  check('재고수량·이동중(타지점입고 예정수량)·예약(판매 예약수량)', x.stock === 2 && x.transit === 1 && x.reserved === 1, x);
  check('당월입고·당월판매는 파일에 없어 빈칸', x.monthIn === '' && x.monthSale === '');
  const c = r.records.channelStock.find(o => o.code === 'MNKR-999G');
  check('채널 합계(재고·이동중·예약)', c.stock === 2 && c.transit === 1 && c.reserved === 1, c);
  check('.DEMO 코드 유지', r.codes.indexOf('MNKR-999G.DEMO') >= 0, r.codes);
}

console.log('\n[8] 하이마트 판매재고현황');
{
  const r = P.parseRows(HIMART(HIMART_ROWS), { fileName: '판매재고현황_20260924.xlsx', today: TODAY });
  check('기준일 = 파일명 날짜(오프셋 없음)', r.baseDate === '2026-09-24');
  const h = r.records.himart;
  check('누적 스냅샷 4행', h.length === 4 && h[0].real === 1 && h[0].sale === 2 && h[0].week === 1 && h[0].day === 1, h[0]);
  check('(J) 접두어·리퍼 코드 그대로', r.codes.indexOf('(J)MNMD-999G_OFF') >= 0 && r.codes.indexOf('MW00000_000000') >= 0);
  const s = r.records.storeStock.find(o => o.store === 'S01C');
  check('점포 재고 = 잔여재고, 당월판매 채움, 나머지 빈칸', s.stock === 40 && s.monthSale === 0 && s.transit === '' && s.monthIn === '', s);
  check('채널 합계 재고', r.records.channelStock.find(o => o.code === 'MNMD-999G_OFF').stock === 43);
  check('점포 = 인도처코드·인도처명·지사명', r.records.stores.find(o => o.code === 'S01C').region === '물류센타');
  check('누적 스냅샷 반영 예정 = 판매 값 있는 행만(2)', r.plannedRows.himartSnap === 2 && r.plannedRows.stockStore === 4, r.plannedRows);
}

console.log('\n[8-1] 재고 기준일 = 파일명 날짜 + 채널 재고기준일오프셋(스냅샷형만)');
{
  const OFF = { himart: 0, etland: -1, emart: -1, traders: -1 };
  const et = P.parseRows(ETLAND_STOCK, { fileName: '현재고_2026-09-25_124812.xls', today: TODAY, stockOffsets: OFF });
  check('전자랜드 현재고 9/25 파일 → 재고 기준일 9/24(오프셋 −1)', et.fileDate === '2026-09-25' && et.baseDate === '2026-09-24' && et.stockOffset === -1, [et.fileDate, et.baseDate, et.stockOffset]);
  const em = P.parseRows(EMART_STOCK, { fileName: '재고현황_상세_20260928101559.xlsx', today: TODAY, stockOffsets: OFF });
  check('이마트 재고현황_상세 9/28 파일 → 9/27(파일 단위로 이마트 오프셋)', em.fileDate === '2026-09-28' && em.baseDate === '2026-09-27' && em.stockOffset === -1, [em.fileDate, em.baseDate]);
  const hm = P.parseRows(HIMART(HIMART_ROWS), { fileName: '판매재고현황_20260924.xlsx', today: TODAY, stockOffsets: { himart: -1 } });
  check('하이마트는 오프셋을 적용하지 않는다(누적 판매 차이도 같은 날짜) — 9/24 그대로', hm.baseDate === '2026-09-24' && hm.stockOffset === 0, [hm.baseDate, hm.stockOffset]);
  const mb = P.parseRows(ETLAND_STOCK, { fileName: '현재고_2026-10-01_090000.xls', today: TODAY, stockOffsets: OFF });
  check('월말 경계 — 10/1 파일 → 9/30', mb.baseDate === '2026-09-30', mb.baseDate);
  const yb = P.parseRows(EMART_STOCK, { fileName: '재고현황_상세_20270101090000.xlsx', today: TODAY, stockOffsets: OFF });
  check('연말 경계 — 2027-01-01 파일 → 2026-12-31', yb.baseDate === '2026-12-31', yb.baseDate);
  check('10/1 이마트 파일(조회일자 202609 = 재고 기준일의 월) → 조회일자 경고 없음',
    !P.parseRows(EMART_STOCK, { fileName: '재고현황_상세_20261001090000.xlsx', today: TODAY, stockOffsets: OFF }).warnings.some(w => /조회일자/.test(w)));
  check('오프셋 0 채널(stockOffsets에 없음) → 파일명 날짜 그대로', P.parseRows(ETLAND_STOCK, { fileName: '현재고_2026-09-25_124812.xls', today: TODAY, stockOffsets: {} }).baseDate === '2026-09-25');
  const none = P.parseRows(ETLAND_STOCK, { fileName: '현재고_2026-09-25_124812.xls', today: TODAY });
  check('채널마스터를 아직 못 받음(stockOffsets 없음) → stockOffset null, 기준일 = 파일명 날짜', none.stockOffset === null && none.baseDate === '2026-09-25');
  const chosen = P.parseRows(ETLAND_STOCK, { fileName: '현재고_2026-09-25_124812.xls', today: TODAY, stockOffsets: OFF, baseDate: '2026-09-25' });
  check('직접 고른 기준일이 오프셋보다 우선', chosen.baseDate === '2026-09-25' && chosen.baseDateChosen === true);
  check('판매(기간 교체형)에는 오프셋 없음', P.parseRows(ETLAND_SALES, { fileName: '판매내역_2026-09-25_124820.xls', today: TODAY, stockOffsets: OFF }).period.end === '2026-09-05');
  // 업로드 입력 — 파일명 날짜(fileDate)는 "재고 기준일이 이미 정해졌다"는 표시. 모르면 보내지 않아 서버가 오프셋을 더한다
  const pe = P.toUploadPayload(et, { fileName: 'f.xls', baseDate: et.baseDate });
  check('오프셋 적용 → meta.baseDate 9/24 + fileDate 9/25', pe.meta.baseDate === '2026-09-24' && pe.meta.fileDate === '2026-09-25', pe.meta);
  const pn = P.toUploadPayload(none, { fileName: 'f.xls', baseDate: none.baseDate });
  check('오프셋을 모름 → fileDate 없음(서버가 채널 오프셋 적용)', pn.meta.baseDate === '2026-09-25' && !('fileDate' in pn.meta), pn.meta);
  const pc = P.toUploadPayload(P.parseRows(ETLAND_STOCK, { fileName: '현재고_2026-09-25_124812.xls', today: TODAY, baseDate: '2026-09-23' }), { baseDate: '2026-09-23' });
  check('오프셋을 몰라도 직접 고른 기준일이면 fileDate를 보낸다(서버가 다시 더하지 않게)', pc.meta.baseDate === '2026-09-23' && pc.meta.fileDate === '2026-09-25', pc.meta);
  check('하이마트는 fileDate를 보내지 않는다(서버 처리 그대로)', !('fileDate' in P.toUploadPayload(hm, { baseDate: hm.baseDate }).meta));
  check('addDays', P.addDays('2026-03-01', -1) === '2026-02-28' && P.addDays('2028-03-01', -1) === '2028-02-29' && P.addDays('2026-09-30', 1) === '2026-10-01');
}

console.log('\n[9] 업로드 입력 만들기 — 미리보기 수정값 반영');
{
  const r = P.parseRows(ETLAND_SALES, { fileName: 'f.xls', today: TODAY });
  const p = P.toUploadPayload(r, { fileName: 'f.xls', replaceStart: '2026-09-01', replaceEnd: '2026-09-30' });
  check('기간 교체형 meta', p.meta.fileType === 'ETLAND_SALES' && p.meta.channelId === 'etland' && p.meta.replaceStart === '2026-09-01' && p.meta.replaceEnd === '2026-09-30' && p.meta.rawRowCount === 7, p.meta);
  const r2 = P.parseRows(ETLAND_STOCK, { fileName: '현재고.xls', today: TODAY });
  const p2 = P.toUploadPayload(r2, { baseDate: '2026-09-26' });
  check('스냅샷형 meta — 고른 기준일', p2.meta.baseDate === '2026-09-26' && !('replaceStart' in p2.meta), p2.meta);
  check('레코드는 JSON으로 왕복 가능', JSON.stringify(JSON.parse(JSON.stringify(p2.records))) === JSON.stringify(p2.records));
}

console.log('\n[10] 필수 열이 빠지면 무엇이 없는지 알려준다');
{
  const bad = [['지사명', '인도처코드', '상품코드', '당월실판매', '당월판매', '당일판매', '잔여재고']];
  const r = P.parseRows(bad, { today: TODAY });
  check('인도처명·상품명 누락 보고', !r.ok && /인도처명/.test(r.error) && /상품명/.test(r.error), r.error);
  check('모르는 파일', !P.parseRows([['x']], {}).ok);
}

console.log('\n[11] 워크북 읽기(SheetJS) — 범위 보정·HTML raw');
{
  let XLSX = null;
  try { XLSX = require(process.env.XLSX_PATH || 'xlsx'); } catch (e) { XLSX = null; }
  if (!XLSX) {
    console.log('  SKIP  SheetJS가 없어 건너뜀 (XLSX_PATH=<xlsx 모듈 경로> 로 실행하면 검사)');
  } else {
    // 이마트 재고 실파일은 <dimension>이 A1:F3인데 셀은 843행까지 있다. SheetJS는 쓸 때 !ref 밖을 버리므로
    // 그런 파일을 만들 수 없어서, "읽은 직후의 워크북"(셀은 다 있고 !ref만 작음)을 read()가 돌려주게 한다.
    const ws = XLSX.utils.aoa_to_sheet(EMART_STOCK);
    ws['!ref'] = 'A1:F3';
    const plain = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }).length;
    const fake = { read: () => ({ SheetNames: ['재고현황_상세'], Sheets: { '재고현황_상세': ws } }), utils: XLSX.utils };
    const got = P.readWorkbookRows(fake, Buffer.from('x'));
    check('(보정 없이 읽으면 3행뿐임을 확인)', plain === 3, plain);
    check('잘못된 범위를 셀 주소로 다시 잡아 전체 행을 읽음', got.rows.length === EMART_STOCK.length && P.detect(got.rows).type === 'EMART_STOCK', got.rows.length);
    const html = '<html><body><table><tr><td>판매내역</td></tr><tr>' + ETLAND_SALES[1].map(h => '<td>' + h + '</td>').join('') +
      '</tr><tr>' + ETLAND_SALES[2].map((v, i) => '<td>' + (i === 3 ? '003001' : v) + '</td>').join('') + '</tr></table></body></html>';
    const g2 = P.readWorkbookRows(XLSX, Buffer.from('\r\n\r\n' + html, 'utf8'));
    const r = P.parseRows(g2.rows, { today: TODAY });
    check('HTML .xls: 판매일자가 하루 밀리지 않음', r.ok && r.records.sales[0].s === '2026-09-02', r.records && r.records.sales);
    check("HTML .xls: 지점코드 앞자리 0 보존('003001')", r.records.stores[0].code === '003001', r.records.stores);
  }
}

console.log('\n' + '─'.repeat(50));
console.log('통과 ' + pass + ' / 실패 ' + fail);
process.exit(fail ? 1 : 0);
