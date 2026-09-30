/* ERP 매출이익리스트(2026-09-30) — 백화점(신세계·롯데백화점)·폐쇄몰(디에이블앤·워크숍에이트)·렌탈(다파라솔루션) 매출.
   우리 창고에서 고객에게 직접 출고한 기록이라 그 파일의 판매가 곧 우리 매출(IN)이자 판매(OUT)다.

   지키려는 성질:
     [1] 채널·거래처 설정 — 운영 모양(채널마스터 10열·7채널)에 setup: IN실적원천 열, 신세계·디에이블앤 켜기(erp·upload), 없는 ERP 채널 3개 추가,
         거래처매핑 초기값 9행, 거래처 = 점포마스터 점포. 재실행 불변·사람이 고친 값 그대로. 마스터에 codeSystems·customers·inSource,
         erp 코드체계로 매핑 저장, 채널군 렌탈 = 특수
     [2] 판매원장 금액·수수료 — 금액이 있는 행은 그 값, 빈 행은 수량 × 공급가(포털 채널 숫자 불변), 섞이면 미완성 표시, 미매칭 금액 따로
     [3] 파서 — 2줄 헤더 판별, 쓰는 열 11개만(개인정보 열은 읽자마자 버림), 날짜 = 날짜 열, 날짜 × 거래처 × 코드 합산, 무상 동봉(구성품·금액 0) 제외,
         반품 음수, 교체 기간 = 파일명 기간(없으면 최소~최대), 거래처·브랜드 요약, 페이로드에 개인정보 없음
     [4] 반영 — 거래처매핑으로 채널, 없는 거래처 보류, 미리보기에서 고른 거래처 저장(포털 채널은 거절), ERP 채널 전부 기간 교체(판매 없던 채널 정리),
         포털 채널·교체 기간 밖 불변, 멱등, 로그 채널 5개·데이터 현황, 시트 어디에도 개인정보 없음
     [5] 화면 — 거래처 → 채널 표(없는 거래처는 ERP 채널만 선택), 채널별·브랜드별(미닉스 외 강조)·무상 동봉 제외, 안 고르면 반영 막음, 요청에 고른 거래처만

   실행: node tests/offline-erp.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadOfflineGas, dataRows } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const { session } = require(path.join(__dirname, 'lib', 'offline-2b-fixture.js'));
const { loadFrontend } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
const PROJ = path.join(__dirname, '..');
const P = require(path.join(PROJ, 'src', 'features', 'offline', 'parsers.js'));
const tick = () => new Promise(r => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }

/* ── 합성 ERP 매출이익리스트 — 실파일과 같은 2줄 헤더·57열(열 이름은 실파일 그대로, 값은 전부 가짜).
   개인정보 칸에는 찾기 쉬운 가짜 값을 넣어 두고, 어디에도(행·파싱 결과·전송 페이로드·시트·로그·화면) 남지 않는지 본다. ── */
const ERP_HEAD = ['날짜', '주문일', '매장', '매출구분', '주문번호', '전표번호', '거래처코드', '거래처명', '담당자', '자체(연계)코드', '회계(연계)코드', '주문자명', '주문자ID', '주문자 전화번호', '주문자 휴대폰',
  '수취인명', '수취인 전화번호', '수취인 휴대폰', '우편번호', '주소', '브랜드', '브랜드코드', '상품코드', '상품상태', '마켓상품코드', '자체코드', '판매자코드', '카테고리', '로케이션', '창고구분', '창고코드',
  '기본상품명', '기본상품 규격', '주문상품명', '주문상품 규격', '상품명 별칭', '상품비고', '관리비고', '관리코드', '송장번호', '택배사', '수불구분', '수량', '매출단가', '금액', '수수료', '수수료율', '공급액', '물류비',
  '인터넷단가', '인터넷총액', '원가', '원가총액', '이익액', '이익율', '이익액', '이익율'];
const ERP_GROUP = ERP_HEAD.map((h, i) => ({ 0: '주문정보', 6: '거래처정보', 11: '주문자명', 12: '주문자정보', 15: '수령자정보', 20: '상품정보', 39: '배송정보', 41: '수불구분', 42: '수량', 43: '총액' })[i] || '');
const PII = ['홍길동가짜', 'fakeuser01', '010-1111-2222', '02-333-4444', '김수취가짜', '010-5555-6666', '06236', '서울 가상구 가상로 1', '555566667777', 'ORD-PII-0001'];
const CODE = { MAX: '9812365001397', MINI: '9812365001472', LOCK: '9812365001386', CONT: '9812365001556', TOM: '9812365001362', SLIM_EM: '9812365001396' };
const NAME = { [CODE.MAX]: '미닉스 더 플렌더 MAX_그레이지 (MNFD-200G)', [CODE.MINI]: '미닉스 더 플렌더 MINI_그레이지 (MNFD-300G)', [CODE.LOCK]: '미닉스 더 플렌더 3중 활성탄 하드 락 필터',
  [CODE.CONT]: '미닉스 실링 컨테이너 2L', [CODE.TOM]: '톰 더 글로우 (TLDM-12)', [CODE.SLIM_EM]: '[이마트] 미닉스 더 슬림_그레이지 (MNVC-100G)' };
const BRAND = { [CODE.MAX]: '미닉스 더 플렌더', [CODE.MINI]: '미닉스 더 플렌더', [CODE.LOCK]: '미닉스 더 플렌더', [CODE.CONT]: '미닉스 더 플렌더', [CODE.TOM]: '톰 디바이스', [CODE.SLIM_EM]: '미닉스 더 슬림' };
const CAT = { [CODE.MAX]: '본품', [CODE.MINI]: '본품', [CODE.LOCK]: '구성품', [CODE.CONT]: '구성품', [CODE.TOM]: '본품', [CODE.SLIM_EM]: '본품' };
const CUST = { '00476': '(주)신세계(센텀시티점)', '00474': '(주)디에이블앤', '00261': '(주)다파라솔루션 (빌리고)', '00999': '주식회사 가상상사(구 : 옛가상)' };
// [날짜, 거래처코드, 상품코드, 수불구분, 수량, 금액, 수수료]
function erpRow(d, cust, code, gubun, qty, amt, fee) {
  const o = {};
  ERP_HEAD.forEach((h, i) => { o[i] = ''; });
  const set = (h, v) => { o[ERP_HEAD.indexOf(h)] = v; };
  set('날짜', d); set('주문일', '2026-08-30'); set('매출구분', '앳홈'); set('주문번호', PII[9]); set('거래처코드', cust); set('거래처명', CUST[cust]);
  set('주문자명', PII[0]); set('주문자ID', PII[1]); set('주문자 전화번호', PII[3]); set('주문자 휴대폰', PII[2]);
  set('수취인명', PII[4]); set('수취인 전화번호', PII[3]); set('수취인 휴대폰', PII[5]); set('우편번호', PII[6]); set('주소', PII[7]); set('송장번호', PII[8]);
  set('브랜드', BRAND[code]); set('상품코드', code); set('카테고리', CAT[code]); set('창고구분', '토마스'); set('기본상품명', NAME[code]);
  set('수불구분', gubun); set('수량', qty); set('금액', amt); set('수수료', fee); set('매출단가', qty ? Math.abs(amt / qty) : 0);
  return ERP_HEAD.map((h, i) => o[i]);
}
const ERP_ROWS = [
  erpRow('2026-09-02', '00476', CODE.MAX, '매출출고', 1, 330000, 0),
  erpRow('2026-09-02', '00476', CODE.MAX, '매출출고', 1, 330000, 0),        // 같은 날·거래처·코드 → 합산 2 / 660,000
  erpRow('2026-09-02', '00476', CODE.CONT, '매출출고', 1, 0, 0),            // 무상 동봉(구성품·금액 0) → 제외
  erpRow('2026-09-03', '00474', CODE.MINI, '매출출고', 3, 690000, 30000),
  erpRow('2026-09-04', '00474', CODE.MINI, '매출반품', -1, -230000, -10000), // 반품 — 음수 그대로
  erpRow('2026-09-04', '00474', CODE.CONT, '매출반품', -1, 0, 0),           // 반품이어도 무상 동봉이면 제외
  erpRow('2026-09-05', '00474', CODE.LOCK, '매출출고', 2, 29000, 0),         // 구성품이지만 유상(금액 있음) → 판매
  erpRow('2026-09-05', '00474', CODE.TOM, '매출출고', 1, 500000, 0),         // 미닉스 외 브랜드
  erpRow('2026-09-06', '00261', CODE.SLIM_EM, '매출출고', 2, 460000, 0),
  erpRow('2026-09-07', '00476', CODE.MAX, '매출출고', 1, 330000, 0),
  erpRow('2026-09-07', '00476', CODE.MAX, '매출취소', -1, -330000, 0),      // 같은 날 출고 + 취소 → 0·0·0 → 저장하지 않음
  erpRow('2026-09-08', '00999', CODE.MAX, '매출출고', 1, 300000, 0)];       // 거래처매핑에 없는 거래처
const ERP_FILE = '백화점, 폐쇄몰, 렌탈 매출이익리스트(2026-09-01~2026-09-30).xlsx';
const erpGrid = () => [ERP_GROUP.slice(), ERP_HEAD.slice()].concat(ERP_ROWS.map(r => r.slice()));
const hasPII = s => PII.filter(x => String(s).indexOf(x) >= 0);

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 800) : '')); }
}
const J = JSON.stringify;
const TODAY = '2026-09-30';
const EMAIL = 'tester@athomecorp.com';
const ERP_CHS = ['shinsegae', 'theablen', 'lotte_dept', 'workshop8', 'dapara'];

function env() {
  const g = loadOfflineGas({ setup: true, today: TODAY });
  g.rows = name => dataRows(g.tab(name));
  const tok = session(g.ctx, EMAIL);
  g.call = (action, data) => JSON.parse(g.ctx.doPost({ postData: { contents: J({ action, session: tok, data: data || {} }) }, parameter: {} }));
  return g;
}

async function main() {
  console.log('\n[1] 채널·거래처 설정 — 운영 모양(ERP 전) 시트에 setup');
  {
    const g = env(), T = g.ctx.OFF_TABS;
    // ERP 전 운영 모양: 채널마스터 10열·7채널(신세계·디에이블앤 비활성·자기 코드체계), 거래처매핑 탭 없음, 점포마스터에 ERP 점포 없음
    const ch = g.tab('채널마스터');
    ch._grid.length = 1; ch._grid[0].length = 10;
    g.ctx._offWriteBlock(ch, { headers: T.channel.headers.slice(0, 10), text: [0, 1, 2, 3, 5, 6, 7, 8] }, 2, [
      ['himart', '하이마트', '전문점', 'Y', 1, '2026-09', '', '', 'himart', 0], ['etland', '전자랜드', '전문점', 'Y', 2, '2026-09', '', '', 'etland', -1],
      ['emart', '이마트', '할인점', 'Y', 3, '2026-09', '이마트', 'EM', 'emart', -1], ['traders', '트레이더스', '창고형', 'N', 4, '2026-09', '트레이더스', 'TR', 'emart', -1],
      ['shinsegae', '신세계', '백화점', 'N', 5, '', '', '', 'shinsegae', 0], ['theablen', '디에이블앤(수정)', '폐쇄몰', 'N', 6, '', '', '', 'theablen', 0],
      ['special', '기타 특판', '특판', 'N', 7, '', '', '', 'special', 0]]);
    delete g.off._sheets['거래처매핑']; g.off._order.splice(g.off._order.indexOf('거래처매핑'), 1);
    g.tab('점포마스터')._grid.length = 1;
    g.ctx._offWriteBlock(g.tab('점포마스터'), T.store, 2, [['himart', 'S1', '강남점', '강남', '2026-09-01', '2026-09-01', '오프라인']]);
    const rep = g.ctx.offline_setupSheets();
    check('채널마스터 IN실적원천 열만 덧붙임 · 거래처매핑 탭 생성', J(rep.extended) === J([{ tab: '채널마스터', added: ['IN실적원천'] }]) && J(rep.created) === J(['거래처매핑']), rep);
    const rows = g.rows('채널마스터'), by = id => rows.find(r => r[0] === id);
    check('신세계·디에이블앤 = 활성 Y · 업로드시작월 2026-09 · 코드체계 erp · IN실적원천 upload (채널명 등 다른 값은 그대로)',
      ['shinsegae', 'theablen'].every(id => by(id)[3] === 'Y' && by(id)[5] === '2026-09' && by(id)[8] === 'erp' && by(id)[10] === 'upload') && by('theablen')[1] === '디에이블앤(수정)', rows);
    check('나머지 채널 = input, 사람이 끈 트레이더스는 그대로 N', ['himart', 'etland', 'emart', 'traders', 'special'].every(id => by(id)[10] === 'input') && by('traders')[3] === 'N' && by('special')[3] === 'N');
    check('없는 ERP 채널 3개 덧붙임(롯데백화점 백화점 · 워크숍에이트 폐쇄몰 · 다파라솔루션 렌탈)', J(rep.channelsAdded) === J(['lotte_dept', 'workshop8', 'dapara']) &&
      J(['lotte_dept', 'workshop8', 'dapara'].map(id => [by(id)[1], by(id)[2], by(id)[3], by(id)[5], by(id)[8], by(id)[10]])) ===
      J([['롯데백화점', '백화점', 'Y', '2026-09', 'erp', 'upload'], ['워크숍에이트', '폐쇄몰', 'Y', '2026-09', 'erp', 'upload'], ['다파라솔루션', '렌탈', 'Y', '2026-09', 'erp', 'upload']]), rows.slice(7));
    const cust = g.rows('거래처매핑');
    check('거래처매핑 초기값 9행(거래처코드 앞자리 0 보존)', cust.length === 9 && J(cust.map(r => r[0] + '=' + r[2])) === J(['00476=shinsegae', '00440=shinsegae', '00580=shinsegae', '00608=shinsegae', '00619=shinsegae',
      '00604=lotte_dept', '00474=theablen', '00260=workshop8', '00261=dapara']), cust);
    check('  ↳ 거래처명 = 법인 표기 뺀 이름', J(cust.map(r => r[1])) === J(['신세계(센텀시티점)', '신세계(강남점)', '대전신세계', '신세계 동대구복합환승센터', '신세계(청담점)', '롯데백화점 본점', '디에이블앤', '워크숍에이트', '다파라솔루션']));
    const st = g.rows('점포마스터');
    check('거래처 9곳 = 채널의 점포(점포코드 = 거래처코드, 점포명 = 거래처명), 있던 점포는 그대로', st.length === 10 && st[0][1] === 'S1' &&
      J(st.slice(1).map(r => [r[0], r[1], r[2], r[4]])) === J(cust.map(r => [r[2], r[0], r[1], TODAY])) && J(rep.storesAdded.slice(0, 2)) === J(['shinsegae:00476', 'shinsegae:00440']), st);
    const before = J(g.off.getSheets().map(s => s._grid));
    const rep2 = g.ctx.offline_setupSheets();
    check('다시 실행 — 확장·추가 없음, 시트 내용 그대로(멱등)', !rep2.extended.length && !rep2.created.length && !rep2.channelsAdded.length && !rep2.storesAdded.length &&
      J(g.off.getSheets().map(s => s._grid)) === before, rep2);
    // 사람이 고친 값은 다시 실행해도 그대로 — 신세계를 끄고, 거래처 하나를 채널을 바꾸고, 롯데백화점 행을 지움
    ch._grid.find(r => r[0] === 'shinsegae')[3] = 'N';
    g.tab('거래처매핑')._grid[1][1] = '센텀시티점';
    const rep3 = g.ctx.offline_setupSheets();
    check('사람이 끈 신세계는 다시 켜지 않음 · 고친 거래처명 그대로', g.rows('채널마스터').find(r => r[0] === 'shinsegae')[3] === 'N' && g.rows('거래처매핑')[0][1] === '센텀시티점' && !rep3.channelsAdded.length);
    const lotteRow = ch._grid.findIndex(r => r[0] === 'lotte_dept');
    ch._grid.splice(lotteRow, 1);
    check('지운 ERP 채널은 다음 setup이 다시 붙인다', J(g.ctx.offline_setupSheets().channelsAdded) === J(['lotte_dept']));
    check('README에 거래처매핑·IN실적원천 설명', g.rows('README').some(r => r[0] === '거래처매핑' && /거래처코드/.test(r[1])) && g.rows('README').some(r => r[0] === '채널마스터' && /IN실적원천/.test(r[1])));
  }

  console.log('\n[1-2] 마스터 — codeSystems · customers · inSource, erp 코드체계로 매핑 저장');
  {
    const g = env();
    const m = g.call('offline_getMasters');
    check('codeSystems = [erp — ERP (백화점·폐쇄몰·렌탈 공통), 채널 5개]', J(m.codeSystems) === J([{ id: 'erp', name: 'ERP (백화점·폐쇄몰·렌탈 공통)', channels: ['shinsegae', 'theablen', 'lotte_dept', 'workshop8', 'dapara'] }]), m.codeSystems);
    check('customers 9곳(거래처코드·이름·채널)', m.customers.length === 9 && J(m.customers[5]) === J({ code: '00604', name: '롯데백화점 본점', channelId: 'lotte_dept', note: '초기값' }), m.customers);
    check('채널 inSource — ERP 5채널 upload, 나머지 input', m.channels.every(c => c.inSource === (ERP_CHS.indexOf(c.channelId) >= 0 ? 'upload' : 'input')) && m.channels.filter(c => c.codeSystem === 'erp').length === 5);
    g.ctx._offWriteBlock(g.tab('제품마스터'), g.ctx.OFF_TABS.sku, 2, [['SKU-0001', '더 플렌더 MAX', '더플렌더', '더 플렌더 MAX', '', 'Y', '', '']]);
    const r1 = g.call('offline_saveMapping', { items: [{ op: 'upsert', channelId: 'erp', code: '9812365001397', skuId: 'SKU-0001', stockType: '정상', name: '미닉스 더 플렌더 MAX_그레이지 (MNFD-200G)' }] });
    const r2 = g.call('offline_saveMapping', { items: [{ op: 'upsert', channelId: 'dapara', code: '9812365001472', skuId: 'SKU-0001', stockType: '정상' }] });
    check('erp로 온 매핑 · ERP 채널(다파라솔루션)로 온 매핑 모두 erp 한 벌로 저장', r1.success && r2.success && J(g.rows('코드매핑').map(r => r[0] + ':' + r[1])) === J(['erp:9812365001397', 'erp:9812365001472']), [r1, r2, g.rows('코드매핑')]);
    check('채널도 코드체계도 아닌 id는 거절', /채널마스터에 없는/.test(g.call('offline_saveMapping', { items: [{ op: 'upsert', channelId: 'nope', code: 'X', skuId: 'SKU-0001' }] }).error || ''));
    check('채널군 — 백화점 = 오프라인, 폐쇄몰·렌탈 = 특수', g.ctx._offChannelGroup('백화점') === 'offline' && g.ctx._offChannelGroup('폐쇄몰') === 'closed' && g.ctx._offChannelGroup('렌탈') === 'closed');
  }

  console.log('\n[2] 판매원장 금액·수수료 — 금액이 있으면 그 값, 없으면 수량 × 공급가');
  {
    const g = env(), T = g.ctx.OFF_TABS, read = k => g.ctx._offReadRows(g.tab(T[k].name), T[k]);
    check('판매원장 헤더 끝에 금액·수수료(숫자 열)', J(g.tab('판매원장')._grid[0].slice(9, 12)) === J(['upload_id', '금액', '수수료']) && T.sales.text.indexOf(10) < 0 && T.sales.text.indexOf(11) < 0);
    const SKUS = [['SKU-0001', '더 플렌더 MAX', '더플렌더', '더 플렌더 MAX', '', 'Y', '', ''], ['SKU-0002', '더 슬림', '더슬림', '더 슬림', '', 'Y', '', '']];
    const MAPS = [['himart', 'MNFD-200G', 'SKU-0001', '정상', '', '', '', ''], ['erp', 'E-MAX', 'SKU-0001', '정상', '', '', '', ''], ['erp', 'E-SLIM', 'SKU-0002', '정상', '', '', '', '']];
    const SL = (d, ch, store, code, q, amt, fee) => [d, d, 'day', ch, store, code, q, '', 'upload', 'U', amt == null ? '' : amt, fee == null ? '' : fee];
    const sales = [
      SL('2026-09-03', 'himart', 'S1', 'MNFD-200G', 3),                            // 포털 채널 — 금액 빈칸 → 수량 × 공급가
      SL('2026-09-04', 'shinsegae', '00476', 'E-MAX', 2, 700000, 70000),
      SL('2026-09-05', 'shinsegae', '00440', 'E-MAX', -1, -350000, -35000),       // 반품 — 음수 그대로
      SL('2026-09-06', 'theablen', '00474', 'E-SLIM', 1),                          // 금액 없는 ERP 행(가정) — 단가도 없으면 금액 미완성
      SL('2026-09-06', 'theablen', '00474', 'E-SLIM', 2, 400000, 0),
      SL('2026-09-07', 'theablen', '00474', 'E-NEW', 3, 90000, 9000),             // 미매칭 — 금액도 따로
      SL('2026-09-08', 'theablen', '00474', 'E-MAX', 0, 5000, 0)];                 // 수량 0, 금액만(가격 조정) — 금액에 들어간다
    const mon = g.ctx._offMonthlyCompute({ from: '2026-09', to: '2026-09', channels: read('channel'), targets: [], sales, mappings: MAPS, skus: SKUS,
      prices: [['himart', '더플렌더', '더 플렌더 MAX', 400000, '2026-01-01', '', '', '']] });
    const R = (ch, model) => mon.rows.find(r => r.channelId === ch && r.model === model);
    const byCM = ch => mon.totals.byChannelMonth.find(x => x.channelId === ch);
    check('포털 채널(하이마트) = 수량 3 × 공급가 400,000 = 1,200,000, 미완성 아님(기존과 같음)', R('himart', '더 플렌더 MAX').out.actualAmount === 1200000 && !byCM('himart').out.amountIncomplete);
    check('신세계 = 원장 금액 700,000 − 350,000 = 350,000 (수량 1, 단가 없어도 완성)', R('shinsegae', '더 플렌더 MAX').out.actual === 1 && R('shinsegae', '더 플렌더 MAX').out.actualAmount === 350000 && !byCM('shinsegae').out.amountIncomplete, R('shinsegae', '더 플렌더 MAX').out);
    check('디에이블앤 더 슬림 = 원장 금액 400,000 + 금액 없는 1대(단가 없음 → 미완성 표시)', R('theablen', '더 슬림').out.actual === 3 && R('theablen', '더 슬림').out.actualAmount === 400000 && byCM('theablen').out.amountIncomplete &&
      mon.warnings.some(w => /단가 없음.*theablen/.test(w)), [R('theablen', '더 슬림').out, mon.warnings]);
    check('수량 0·금액만 있는 행도 금액에 더함(더 플렌더 MAX 5,000)', R('theablen', '더 플렌더 MAX').out.actual === 0 && R('theablen', '더 플렌더 MAX').out.actualAmount === 5000);
    check('미매칭 — 수량·금액 따로(합계에 안 들어감) + 경고에 금액', J(mon.unmatched) === J([{ ym: '2026-09', channelId: 'theablen', code: 'E-NEW', qty: 3, amount: 90000 }]) &&
      byCM('theablen').out.unmatchedQty === 3 && byCM('theablen').out.unmatchedAmount === 90000 && byCM('himart').out.unmatchedAmount == null && mon.warnings.some(w => /수량 3 · 금액 90000/.test(w)), [mon.unmatched, byCM('theablen').out]);
  }

  console.log('\n[3] ERP 매출이익리스트 파서 — 판별·쓰는 열만·무상 동봉 제외·합산·기간');
  {
    const grid = erpGrid();
    check('2줄 헤더 판별 — 2행이 헤더(ERP_SALES_PROFIT)', J(P.detect(grid)) === J({ type: 'ERP_SALES_PROFIT', headerIndex: 1 }));
    const rows = P.dropUnusedColumns(grid);
    check('쓰는 열 11개만 남긴다(그룹명 행·개인정보 열 버림)', J(rows[0]) === J(['날짜', '거래처코드', '거래처명', '브랜드', '상품코드', '기본상품명', '카테고리', '수불구분', '수량', '금액', '수수료']) &&
      rows.length === ERP_ROWS.length + 1 && rows.every(r => r.length === 11), rows[0]);
    check('  ↳ 남은 행에 개인정보·주문번호·주문일 없음', !hasPII(J(rows)).length && J(rows).indexOf('2026-08-30') < 0, hasPII(J(rows)));
    check('  ↳ 다른 유형 파일은 그대로 둔다', P.dropUnusedColumns([['인도처코드', '상품코드', '당월실판매', '당월판매', '당일판매', '잔여재고', 'X']]).length === 1);
    const r = P.parseRows(rows, { fileName: ERP_FILE, today: TODAY });
    check('파싱 성공 — 원본 12행, 교체 기간 = 파일명 기간', r.ok && r.type === 'ERP_SALES_PROFIT' && r.channelId === 'erp' && r.split === 'customer' && r.rawRowCount === 12 &&
      J(r.period) === J({ start: '2026-09-01', end: '2026-09-30' }) && r.periodFrom === 'file', r);
    const S = r.records.sales.map(x => [x.s, x.store, x.code, x.qty, x.amt, x.fee].join('|'));
    check('날짜 × 거래처 × 상품코드로 합산, 무상 동봉·0이 된 합은 저장하지 않음, 반품 음수·날짜 = 날짜 열(주문일 아님)', J(S) === J([
      '2026-09-02|00476|' + CODE.MAX + '|2|660000|0', '2026-09-03|00474|' + CODE.MINI + '|3|690000|30000', '2026-09-04|00474|' + CODE.MINI + '|-1|-230000|-10000',
      '2026-09-05|00474|' + CODE.TOM + '|1|500000|0', '2026-09-05|00474|' + CODE.LOCK + '|2|29000|0', '2026-09-06|00261|' + CODE.SLIM_EM + '|2|460000|0',
      '2026-09-08|00999|' + CODE.MAX + '|1|300000|0']), S);
    check('무상 동봉 제외 2행 · 수량 0(1 + 반품 −1)', J(r.summary.excluded) === J({ rows: 2, qty: 0 }));
    check('파일 금액 합 = 원본 금액 합(2,409,000), 레코드 금액 합과 같음', r.summary.fileAmount === 2409000 && r.records.sales.reduce((s, x) => s + x.amt, 0) === 2409000, r.summary.fileAmount);
    check('거래처별(원본 순서) — 법인 표기 뺀 이름, 원본 행·수량·금액·수수료·제외 수량', J(r.summary.byCust.map(c => [c.code, c.name, c.rows, c.qty, c.amount, c.fee, c.excludedQty])) === J([
      ['00476', '신세계(센텀시티점)', 5, 2, 660000, 0, 1], ['00474', '디에이블앤', 5, 5, 989000, 20000, -1], ['00261', '다파라솔루션 (빌리고)', 1, 2, 460000, 0, 0], ['00999', '가상상사', 1, 1, 300000, 0, 0]]), r.summary.byCust);
    check('브랜드별(제외 뒤) — 톰 디바이스는 미닉스 외', J(r.summary.brands.map(b => [b.brand, b.qty, b.amount, b.minix])) === J([['미닉스 더 플렌더', 7, 1449000, true], ['톰 디바이스', 1, 500000, false], ['미닉스 더 슬림', 2, 460000, true]]), r.summary.brands);
    check('상품 정보(브랜드·카테고리)·상품명 — 제외된 무상 동봉 코드는 없음', r.summary.products[CODE.LOCK].category === '구성품' && r.summary.products[CODE.TOM].brand === '톰 디바이스' && !r.summary.products[CODE.CONT] &&
      r.records.names[CODE.SLIM_EM] === NAME[CODE.SLIM_EM] && r.codes.indexOf(CODE.CONT) < 0 && r.codes.length === 5, r.codes);
    check('거래처 = 점포(점포코드 = 거래처코드) 4곳', J(r.records.stores.map(s => s.code + '=' + s.name)) === J(['00476=신세계(센텀시티점)', '00474=디에이블앤', '00261=다파라솔루션 (빌리고)', '00999=가상상사']));
    check('수불구분 요약', J(r.summary.gubun) === J({ '매출출고': 9, '매출반품': 2, '매출취소': 1 }));
    const pay = P.toUploadPayload(r, { fileName: ERP_FILE, customers: [{ code: '00999', name: '가상상사', channelId: 'dapara' }] });
    check('전송 페이로드 — 교체 기간·새 거래처, 개인정보 없음', pay.meta.fileType === 'ERP_SALES_PROFIT' && pay.meta.channelId === 'erp' && pay.meta.replaceStart === '2026-09-01' && pay.meta.replaceEnd === '2026-09-30' &&
      J(pay.meta.customers) === J([{ code: '00999', name: '가상상사', channelId: 'dapara' }]) && !hasPII(J(pay)).length && !hasPII(J(r)).length, hasPII(J(pay)));
    const r2 = P.parseRows(rows, { fileName: '매출이익리스트.xlsx', today: TODAY });
    check('파일명에 기간이 없으면 파일 안 최소~최대 날짜', J(r2.period) === J({ start: '2026-09-02', end: '2026-09-08' }) && r2.periodFrom === 'data');
    check('파일명 기간 — (YYYY-MM-DD~YYYY-MM-DD) · _YYYY-MM-DD_YYYY-MM-DD_ · _YYYYMMDD_YYYYMMDD_ · 뒤집힌/하나뿐이면 없음',
      J(P.periodFromFileName(ERP_FILE)) === J({ start: '2026-09-01', end: '2026-09-30' }) &&
      J(P.periodFromFileName('백화점, 폐쇄몰, 렌탈_매출이익리스트_2026-09-01_2026-09-15_.xlsx')) === J({ start: '2026-09-01', end: '2026-09-15' }) &&
      J(P.periodFromFileName('매출이익리스트_20260901_20260930_.xlsx')) === J({ start: '2026-09-01', end: '2026-09-30' }) &&
      P.periodFromFileName('x_2026-09-30_2026-09-01.xlsx') === null && P.periodFromFileName('x_2026-09-01.xlsx') === null);
    check('파일명 기간 밖 날짜가 있으면 경고', P.parseRows(rows, { fileName: 'x_2026-09-03_2026-09-30_.xlsx', today: TODAY }).warnings.some(w => /벗어납니다/.test(w)));
    check('거래처명 정리 — (주)·주식회사·옛 이름', P.cleanCustomerName('(주)신세계(센텀시티점)') === '신세계(센텀시티점)' && P.cleanCustomerName('주식회사 워크숍에이트(구 : 워크숍씨엘티비)') === '워크숍에이트' &&
      P.cleanCustomerName('㈜대전신세계') === '대전신세계');
    check('유형 목록 — 포털 5종 + 합계 양식 사이에', P.TYPE_ORDER.indexOf('ERP_SALES_PROFIT') === P.TYPE_ORDER.indexOf('EMART_DAILY_SALES') - 1);
  }

  console.log('\n[4] ERP 업로드 반영 — 거래처 → 채널, ERP 채널 기간 교체, 포털 채널 불변, 멱등, 개인정보 없음');
  {
    const g = env(), T = g.ctx.OFF_TABS, AUTH = { email: EMAIL };
    const SL = (d, ch, store, code, q, amt, uid) => [d, d, 'day', ch, store, code, q, '', 'upload', uid || 'U-OLD', amt == null ? '' : amt, ''];
    // 기존 원장: 포털 채널(하이마트·이마트) 9월 판매, 워크숍에이트의 예전 ERP 업로드(이번 파일엔 없음), 8월 신세계(교체 기간 밖)
    g.ctx._offWriteBlock(g.tab('판매원장'), T.sales, 2, [SL('2026-09-02', 'himart', 'S1', 'MNFD-200G', 5), SL('2026-09-03', 'emart', '1003', '8800000000011', 2),
      SL('2026-09-10', 'workshop8', '00260', CODE.MAX, 4, 1320000), SL('2026-08-28', 'shinsegae', '00476', CODE.MAX, 1, 330000)]);
    const portal = () => g.rows('판매원장').filter(r => r[3] === 'himart' || r[3] === 'emart').map(r => J(r));
    const portalBefore = portal();
    const parsed = P.parseRows(P.dropUnusedColumns(erpGrid()), { fileName: ERP_FILE, today: TODAY });
    const up = customers => g.ctx._offUpload(P.toUploadPayload(parsed, { fileName: ERP_FILE, customers }), AUTH);
    const r1 = up([]);
    const erpRows = () => g.rows('판매원장').filter(r => ERP_CHS.indexOf(r[3]) >= 0);
    check('반영 — 거래처매핑으로 채널(신세계·디에이블앤·다파라솔루션), 매핑 없는 00999는 보류 + 경고', J(erpRows().filter(r => r[0] >= '2026-09-01').map(r => [r[0], r[3], r[4], r[5], r[6], r[10], r[11]])) === J([
      ['2026-09-02', 'shinsegae', '00476', CODE.MAX, 2, 660000, 0], ['2026-09-03', 'theablen', '00474', CODE.MINI, 3, 690000, 30000], ['2026-09-04', 'theablen', '00474', CODE.MINI, -1, -230000, -10000],
      ['2026-09-05', 'theablen', '00474', CODE.TOM, 1, 500000, 0], ['2026-09-05', 'theablen', '00474', CODE.LOCK, 2, 29000, 0], ['2026-09-06', 'dapara', '00261', CODE.SLIM_EM, 2, 460000, 0]]) &&
      r1.warnings.some(w => /00999 1건/.test(w) && /보류/.test(w)), [erpRows(), r1.warnings]);
    check('  ↳ 워크숍에이트의 예전 9월 행(이번 파일에 판매 없음)도 교체 기간이라 지워짐, 8월 신세계 행은 그대로', !erpRows().some(r => r[3] === 'workshop8') && erpRows().some(r => r[0] === '2026-08-28' && r[3] === 'shinsegae'));
    check('  ↳ 포털 채널(하이마트·이마트) 행은 그대로(금액·수수료 빈칸)', J(portal()) === J(portalBefore) && g.rows('판매원장').filter(r => r[3] === 'himart').every(r => r[10] === '' && r[11] === ''));
    check('응답 — 채널별(판매 없던 채널 0 포함)·교체한 채널 전부', J(r1.channels) === J(ERP_CHS) && r1.applied.byChannel.theablen.amount === 989000 && r1.applied.byChannel.workshop8.rows === 0 &&
      r1.applied.sales === 6 && r1.applied.salesRemoved === 1, r1.applied);
    const log = g.rows('업로드로그').pop();
    check('업로드로그 — 유형·채널 5개·교체 기간·성공', log[4] === 'ERP_SALES_PROFIT' && log[5] === ERP_CHS.join(',') && log[6] === '2026-09-01~2026-09-30' && log[11] === '성공', log);
    check('미매칭코드 = erp 코드체계로(상품명 = 기본상품명)', g.rows('미매칭코드').every(r => r[0] === 'erp') && g.rows('미매칭코드').length === 5 && g.rows('미매칭코드').some(r => r[1] === CODE.TOM && r[2] === NAME[CODE.TOM]), g.rows('미매칭코드'));
    const st0 = g.rows('점포마스터').find(r => r[1] === '00476');
    check('점포마스터 — 거래처매핑 이름 유지(파일의 (주) 이름으로 바꾸지 않음), 매핑 없는 00999는 점포로 등록하지 않음', st0[0] === 'shinsegae' && st0[2] === '신세계(센텀시티점)' && !g.rows('점포마스터').some(r => r[1] === '00999'));
    const st = g.call('offline_getStatus'), by = {}; st.channels.forEach(c => { by[c.channelId] = c; });
    check('데이터 현황 — ERP 5채널 판매 기준일 9/30, 이번 달 빈 날짜 없음(워크숍에이트 포함)', ERP_CHS.every(c => by[c].salesLast === '2026-09-30' && !by[c].missingDays.length), by.workshop8);

    // 미리보기에서 00999 → 다파라솔루션
    const bad = (() => { try { up([{ code: '00999', name: '가상상사', channelId: 'himart' }]); return null; } catch (e) { return e.message; } })();
    check('포털 채널로 고른 거래처는 거절 — 아무것도 쓰지 않음', /ERP 채널/.test(bad || '') && g.rows('거래처매핑').length === 9 && J(portal()) === J(portalBefore), bad);
    const r2 = up([{ code: '00999', name: '가상상사', channelId: 'dapara' }]);
    const c99 = g.rows('거래처매핑').find(r => r[0] === '00999');
    check('고른 거래처 → 거래처매핑에 저장(비고에 지정일·지정자), 그 채널로 반영, 점포 등록(정리한 이름)', c99 && c99[1] === '가상상사' && c99[2] === 'dapara' && /업로드 미리보기에서 지정 2026-09-30 tester@/.test(c99[3]) &&
      erpRows().some(r => r[3] === 'dapara' && r[4] === '00999' && r[10] === 300000) && g.rows('점포마스터').some(r => r[0] === 'dapara' && r[1] === '00999' && r[2] === '가상상사') &&
      r2.applied.customersAdded === 1 && !r2.warnings.some(w => /보류/.test(w)), [c99, r2.warnings]);
    const snap = () => J(g.rows('판매원장').map(r => r.slice(0, 9).concat(r.slice(10))));
    const once = snap(), n1 = g.rows('판매원장').length, m1 = g.rows('점포마스터').length, c1 = g.rows('거래처매핑').length;
    up([]);
    check('같은 파일 다시 반영 → 판매원장 행 수·내용·점포마스터·거래처매핑 불변(멱등)', snap() === once && g.rows('판매원장').length === n1 && g.rows('점포마스터').length === m1 && g.rows('거래처매핑').length === c1);
    const all = J(g.off.getSheets().map(s => s._grid));
    check('시트 어디에도(업로드로그·원장·마스터) 개인정보·주문번호 없음', !hasPII(all).length, hasPII(all));
    check('거래처매핑 탭이 없으면(setup 전) 안내하며 실패', (() => { delete g.off._sheets['거래처매핑']; try { up([]); return false; } catch (e) { return /offline_setupSheets/.test(e.message); } })());
  }

  await uploadUi();

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
}

/* ── 화면 — 데이터 업로드 카드(실코드, 서버 호출·SheetJS만 가짜) ── */
const UI_SHIM = 'get UP(){return _UP;}, get MASTERS(){return OFFLINE_MASTERS;}, get CM(){return _CM;}, get TG(){return _TG;}';
const ERP_CH_OBJ = [['shinsegae', '신세계', '백화점', 5], ['theablen', '디에이블앤', '폐쇄몰', 6], ['lotte_dept', '롯데백화점', '백화점', 8], ['workshop8', '워크숍에이트', '폐쇄몰', 9], ['dapara', '다파라솔루션', '렌탈', 10]]
  .map(([id, name, type, order]) => ({ channelId: id, name, type, active: 'Y', order, uploadStartMonth: '2026-09', codeSystem: 'erp', inSource: 'upload' }));
const UI_MASTERS = () => ({
  success: true,
  skus: [{ skuId: 'SKU-0001', name: '더 플렌더 MAX 그레이지', line: '더플렌더', model: '더 플렌더 MAX', option: '그레이지', active: 'Y', order: 1 }],
  channels: [{ channelId: 'himart', name: '하이마트', type: '전문점', active: 'Y', order: 1, uploadStartMonth: '2026-09', codeSystem: 'himart', inSource: 'input' }].concat(ERP_CH_OBJ.map(c => Object.assign({}, c))),
  codeSystems: [{ id: 'erp', name: 'ERP (백화점·폐쇄몰·렌탈 공통)', channels: ERP_CHS }],
  customers: [{ code: '00476', name: '신세계(센텀시티점)', channelId: 'shinsegae' }, { code: '00474', name: '디에이블앤', channelId: 'theablen' }, { code: '00261', name: '다파라솔루션', channelId: 'dapara' }],
  mappings: [{ channelId: 'erp', code: CODE.MAX, skuId: 'SKU-0001', stockType: '정상', name: NAME[CODE.MAX] }],
  stores: [], productLines: [], stockTypes: ['정상', '전시', '리퍼']
});
function uiSetup() {
  const { ctx, X } = loadFrontend(PROJ, UI_SHIM);
  const box = {};
  const el = id => (box[id] = box[id] || { id, innerHTML: '', value: '', textContent: '', className: '', style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle() {} } });
  ctx.document.getElementById = el;
  const calls = [];
  const replies = {
    offline_getStatus: () => ({ success: true, today: TODAY, month: '2026-09', channels: [] }), offline_getUploadLog: () => ({ success: true, items: [] }),
    offline_getMasters: () => UI_MASTERS(),
    offline_upload: () => ({ success: true, uploadId: 'U1', applied: { sales: 6, salesRemoved: 0, customersAdded: 1, byChannel: { shinsegae: { rows: 1, qty: 2, amount: 660000, fee: 0 }, workshop8: { rows: 0, qty: 0, amount: 0, fee: 0 } } },
      replaceRange: { start: '2026-09-01', end: '2026-09-30' }, unmatched: [], warnings: [], channels: ERP_CHS })
  };
  ctx._offlineCall = async (action, data) => { calls.push({ action, data }); return replies[action] ? replies[action](data || {}) : { success: true, items: [] }; };
  const byName = {};
  ctx._loadSheetJS = async () => ({});
  ctx.OfflineParsers.readWorkbookRows = (XLSX, bytes) => ({ rows: byName[bytes.__name] });
  ctx.Uint8Array = function (buf) { return { __name: buf.__name }; };
  const addFile = (name, rows) => { byName[name] = rows; return { name, arrayBuffer: async () => ({ __name: name }) }; };
  return { ctx, X, el, calls, addFile, page: () => el('page-admin-upload').innerHTML };
}
async function uploadUi() {
  console.log('\n[5] 데이터 업로드 화면 — 거래처 → 채널 미리보기, 채널 고르기, 무상 동봉·브랜드, 개인정보 없음');
  const { ctx, X, calls, addFile, page } = uiSetup();
  await ctx._upRefreshSide();
  ctx._upAddFiles([addFile(ERP_FILE, erpGrid())]);
  await settle();
  const f = X.UP.files[0];
  check('판별 = ERP 매출이익리스트, 채널 칸 = ERP 코드체계 이름', f.parse && f.parse.type === 'ERP_SALES_PROFIT' && page().indexOf('ERP (백화점·폐쇄몰·렌탈 공통)') >= 0, f.parse && f.parse.type);
  check('읽자마자 쓰는 열만 남김 — 브라우저에 남은 행·미리보기 HTML에 개인정보 없음', f.rows[0].length === 11 && !hasPII(J(f.rows)).length && !hasPII(page()).length, hasPII(page()));
  const h = page();
  check('교체 기간 = 파일명 기간(기본값 안내)', h.indexOf('value="2026-09-01"') >= 0 && h.indexOf('value="2026-09-30"') >= 0 && h.indexOf('기본값 = 파일명의 기간') >= 0);
  check('거래처 표 — 매핑된 거래처는 채널 칩, 없는 거래처(00999)는 ERP 채널 선택 + 이번엔 반영 안 함', h.indexOf('거래처 → 채널') >= 0 && /onchange="_upSetCust\(\d+,'00999'/.test(h) &&
    h.indexOf('<option value="dapara">다파라솔루션</option>') >= 0 && h.indexOf('<option value="himart"') < 0 && h.indexOf('이번엔 반영 안 함') >= 0 && h.indexOf('거래처매핑에 없음') >= 0);
  check('  ↳ 매핑된 거래처 이름은 거래처매핑 이름(다파라솔루션), 금액·제외 수량', h.indexOf('<td>다파라솔루션</td>') >= 0 && h.indexOf('₩660,000') >= 0);
  check('무상 동봉 제외 2행 · 파일 금액 합계', /무상 동봉 제외[^<]*<b>2<\/b>행/.test(h) && h.indexOf('₩2,409,000') >= 0);
  check('채널별 표 — ERP 5채널(판매 없는 채널 포함)', h.indexOf('채널별') >= 0 && ['신세계', '디에이블앤', '롯데백화점', '워크숍에이트', '다파라솔루션'].every(n => h.indexOf('<td>' + n + ' <span') >= 0));
  check('브랜드별 — 미닉스 외(톰 디바이스) 강조', /up-other"><td>톰 디바이스 <span class="up-chip applying">미닉스 외<\/span>/.test(h));
  check('미매칭 코드 = 제외 뒤 코드 중 매핑 없는 것(4개), 브랜드·카테고리를 같이 넘김', ctx._upUnmatched(f).length === 4 && ctx._upUnmatched(f).find(x => x.code === CODE.TOM).brand === '톰 디바이스' &&
    ctx._upUnmatched(f).find(x => x.code === CODE.LOCK).cat === '구성품', ctx._upUnmatched(f));
  check('채널을 안 고른 거래처가 있으면 반영하지 않고 안내', /채널을 정하지 않은 거래처 1곳/.test(h) && !(await ctx._upApply(f.id)) && !calls.some(c => c.action === 'offline_upload'), f.error);
  ctx._upSetCust(f.id, '00999', 'dapara');
  check('고르면 준비 — 채널별 다파라솔루션 거래처 2', page().indexOf('채널을 정하지 않은') < 0 && /<td>다파라솔루션 <span[^>]*>렌탈<\/span><\/td><td class="num-col">2<\/td>/.test(page()));
  await ctx._upApply(f.id);
  const call = calls.find(c => c.action === 'offline_upload');
  check('반영 요청 — 교체 기간·새 거래처(고른 것만), 개인정보 없음', call && call.data.meta.replaceStart === '2026-09-01' && J(call.data.meta.customers) === J([{ code: '00999', name: '가상상사', channelId: 'dapara' }]) &&
    call.data.records.sales.length === 7 && !hasPII(J(call.data)).length, call && call.data.meta);
  check('결과 — 채널별 금액·거래처매핑 추가', page().indexOf('신세계 1행·판매 2·금액 ₩660,000') >= 0 && page().indexOf('거래처매핑에 추가 1') >= 0);
  ctx._upSetCust(f.id, '00999', '-');
  calls.length = 0;
  await ctx._upApply(f.id);
  check('"이번엔 반영 안 함" — 새 거래처를 싣지 않는다(서버가 보류)', J(calls.find(c => c.action === 'offline_upload').data.meta.customers) === J([]));
}

main();
