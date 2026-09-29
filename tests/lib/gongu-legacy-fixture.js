/* 공구 목표 이관 테스트용 원본 탭 목 — home-gas.test.js(GAS)와 home-ui.test.js(화면)가 같이 쓴다.
   1행 비움 · 2025년 '매출 현황' 블록(이관 대상 아님) · "2. … 사업 계획" / "ㄴ 월별 품목 매출 계획" / 머리글 두 줄(구분+월 날짜 병합 | 채널·상품명·매출금액·수량·매출…)
   · 모엔즈(벤더 칸 병합) 5행 + 소계 · 기타 4행 + 소계 · 채널 합계(병합) + 소계 · 1~4분기 목표 · 26년 목표
   · "3. … 마감 내역" / "ㄴ 월별 품목 마감 매출" 블록 + 1~4분기 마감 · 26년 마감 */
const COLS = 30; // A..AD
function monthCols(m) { return { q: 4 + (m - 1) * 2, a: 5 + (m - 1) * 2 }; } // 1-based: 1월 수량 D(4)·매출 E(5)
const TOTQ = 28, TOTA = 29; // AB·AC
// 상품 행 데이터: { 월: [수량, 매출] }
const PLAN = {
  '모엔즈': [
    ['더 에어드라이', 359000, { 1: [0, 0], 2: [0, 0] }], // 0만 있는 달 → 이관 안 함
    ['더시프트', 300000, { 1: [10, 3000000], 2: [5, 1400000] }], // 2월 매출 ≠ 5 × 300,000 — 원본 값 그대로
    ['더플렌더 mini', 250000, { 8: [20, 5000000] }],
    ['더플렌더 PRO', 375000, { 1: [8, 3000000], 4: [4, 1500000] }],
    ['더플렌더 MAX', 430000, { 3: [30, 13000000], 7: [0, 0], 10: [12, 5000000] }]],
  '기타': [
    ['더시프트', 300000, { 1: [2, 600000] }],
    ['더플렌더 mini', 250000, {}], // 값 없는 행
    ['더플렌더 PRO', 375000, { 2: [3, 1100000] }],
    ['특가세트', 400000, { 11: [5, 2000000] }]] // 모호한 상품명 → 제안 빈칸(미매핑)
};
const CLOSE = { '모엔즈': [['더플렌더 MAX', 430000, { 1: [9, 3800000], 3: [25, 10500000] }], ['더플렌더 MINI', 250000, { 8: [4, 1000000] }]] };

function buildLegacy() {
  const g = [], merges = [];
  const row = n => { while (g.length < n) g.push(new Array(COLS).fill('')); return g[n - 1]; };
  const put = (n, c, v) => { row(n)[c - 1] = v; };
  const header = (n, year) => {
    put(n, 1, '구분'); merges.push([n, 1, 1, 3]);
    for (let m = 1; m <= 12; m++) { put(n, monthCols(m).q, new Date(Date.UTC(year, m - 1, 1))); merges.push([n, monthCols(m).q, 1, 2]); }
    put(n, TOTQ, '총 합계'); merges.push([n, TOTQ, 1, 3]);
    put(n + 1, 1, '채널'); put(n + 1, 2, '상품명'); put(n + 1, 3, '매출금액');
    for (let m = 1; m <= 12; m++) { put(n + 1, monthCols(m).q, '수량'); put(n + 1, monthCols(m).a, '매출'); }
    put(n + 1, TOTQ, '수량'); put(n + 1, TOTA, '매출'); put(n + 1, 30, '비중');
  };
  const sumInto = (acc, data) => { Object.keys(data).forEach(m => { const a = acc[m] || (acc[m] = [0, 0]); a[0] += data[m][0]; a[1] += data[m][1]; }); };
  const writeVals = (n, data) => {
    let tq = 0, ta = 0;
    Object.keys(data).forEach(m => { put(n, monthCols(+m).q, data[m][0]); put(n, monthCols(+m).a, data[m][1]); tq += data[m][0]; ta += data[m][1]; });
    put(n, TOTQ, tq); put(n, TOTA, ta);
  };
  // 블록: 벤더별 행 + 소계, 채널 합계 + 소계. 반환 { next, grand }
  const block = (start, vendors) => {
    let n = start;
    const byProduct = {}, grand = {};
    Object.keys(vendors).forEach(v => {
      const first = n, sub = {};
      vendors[v].forEach(([name, unit, data]) => {
        if (n === first) put(n, 1, v);
        put(n, 2, name); put(n, 3, unit); writeVals(n, data);
        sumInto(sub, data); sumInto(byProduct[name.toLowerCase()] = byProduct[name.toLowerCase()] || {}, data); n++;
      });
      merges.push([first, 1, vendors[v].length, 1]);
      put(n, 1, '소계'); merges.push([n, 1, 1, 3]); writeVals(n, sub); sumInto(grand, sub); n++;
    });
    const first = n, names = Object.keys(byProduct);
    names.forEach(k => { if (n === first) put(n, 1, '채널 합계'); put(n, 2, k); writeVals(n, byProduct[k]); n++; });
    merges.push([first, 1, names.length, 1]);
    put(n, 1, '소계'); merges.push([n, 1, 1, 3]); writeVals(n, grand);
    return { next: n + 1, grand };
  };
  // 2025 블록(이관 대상 아님)
  put(2, 1, '1. 공동구매 _ 2025년 운영 결과');
  put(3, 1, 'ㄴ 월별 품목 매출 현황'); header(4, 2025);
  put(6, 1, '에이버스'); put(6, 2, '더 플렌더'); writeVals(6, { 1: [999, 99900000] });
  put(7, 1, '소계'); writeVals(7, { 1: [999, 99900000] });
  // 2026 계획
  put(9, 1, '2. 공동구매 _ 2026년 사업 계획');
  put(10, 1, 'ㄴ 월별 품목 매출 계획'); put(10, TOTQ, '(단위 : 대, 원, VAT+)');
  header(11, 2026);
  const p = block(13, PLAN);
  const q = [0, 0, 0, 0];
  Object.keys(p.grand).forEach(m => { q[Math.floor((+m - 1) / 3)] += p.grand[m][1]; });
  let n = p.next + 1;
  ['1분기 목표', '2분기 목표', '3분기 목표', '4분기 목표'].forEach((lb, i) => { put(n, 4, lb); put(n, 5, q[i]); n++; });
  put(n, 4, '26년 목표'); put(n, 5, q.reduce((a, b) => a + b, 0)); n += 2;
  // 마감
  put(n, 1, '3. 공동구매 _ 2026년 마감 내역'); n += 2;
  put(n, 1, 'ㄴ 월별 품목 마감 매출'); header(n + 1, 2026);
  const c = block(n + 3, CLOSE);
  const cq = [0, 0, 0, 0];
  Object.keys(c.grand).forEach(m => { cq[Math.floor((+m - 1) / 3)] += c.grand[m][1]; });
  n = c.next + 2;
  ['1분기 마감', '2분기 마감', '3분기 마감', '4분기 마감'].forEach((lb, i) => { put(n, 4, lb); put(n, 5, cq[i]); n++; });
  put(n, 4, '26년 마감'); put(n, 5, cq[2]); // 원본처럼 3분기 값만 들어간 셀
  // 병합 셀은 왼쪽 위만 값이 있다 — 목은 그대로 두고 _offLegacyGrid가 채운다
  return { grid: g, merges, planGrand: p.grand, quarters: q, closeGrand: c.grand };
}

module.exports = { buildLegacy, PLAN, CLOSE, TAB: '공동구매 26년 목표' };
