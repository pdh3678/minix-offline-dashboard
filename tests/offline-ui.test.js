/* 데이터 업로드 화면(#admin/upload)과 공용 매핑 패널 — index.html이 싣는 실코드 그대로, 서버 호출(_offlineCall)과
   SheetJS 읽기만 가짜로 바꿔서 화면 흐름을 끝까지 돌린다.

   지키려는 성질:
     · 페이지에 들어오면 상태·로그·마스터를 받아 그린다(PAGE_MOUNTS 훅) — 빈 날짜는 구간으로 줄여 보여 줌
     · 파일을 넣으면 판별 유형·기준일(파일명)·반영 예정 행수·미매칭 수가 카드에 나온다
     · 기준일이 없으면 반영하지 않고, 고르면 그 값으로 보낸다 / 교체 기간·유형을 고칠 수 있다
     · 전체 반영은 하이마트를 기준일 오름차순으로 맨 뒤에, 파일 1개 = 요청 1개로 순차 전송
     · 카드의 "미매칭 N개"에서 바로 매핑(제안 칩 → 저장 버튼으로 확정), 새 SKU 만들기(표준명 자동)
     · 파일명·상품명 같은 외부 문자열은 HTML로 해석되지 않는다
     · 코드 매핑 화면(#admin/code-mapping): 미매칭 목록(같은 패널) + 전체 매핑 표의 필터·검색·수정,
       비활성화는 두 번 눌러야 하고, 저장하면 마스터·미매칭을 다시 받는다

   실행: node tests/offline-ui.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadFrontend } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
const PROJ = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const tick = () => new Promise(r => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }

const SHIM = 'get UP(){return _UP;}, get MASTERS(){return OFFLINE_MASTERS;}, get MP(){return _MP;}, get PAGE_MOUNTS(){return PAGE_MOUNTS;}, get CM(){return _CM;}';

// ── 합성 파일 ──
const HIMART = d => [['지사명', '인도처코드', '인도처명', '상품코드', '상품명', '당월실판매', '당월판매', '금주판매', '당일판매', '잔여재고', '회전율'],
  ['가상지사', 'A1', '가상HM', '(J)MNFD-200G', '가상 MAX 전시', 1, d, 1, 1, 1, 0], ['가상지사', 'A1', '가상HM', 'MNFD-200G', '가상 MAX', 0, 0, 0, 0, 2, 0]];
const ETLAND = [['판매내역'], ['거래처코드', '거래처명', '지부', '지점코드', '지점명', '품목', '상품구분', '모델명', '설명', '판매수량', '단가', '금액', '판매일자', '구분'],
  ['1', 'x', '충청', '300001', '가상점', 'a', 'b', 'MNFD-200G', '가상 MAX', '1', '1', '1', '2026-09-02', '판매(계약)'],
  ['1', 'x', '충청', '300001', '가상점', 'a', 'b', 'MNFD-200G', '가상 MAX', '1', '1', '1', '2026-09-04', '반품']];
const EMART_STOCK = [['조회일자', '점포명', '점포코드', '상품명', '현재수량', '매입량', '상품코드', '매출량'], ['202609', 'EM가상', '0012', '가상 <b>굵게</b>', 3, 1, '8800000000011', 2]];
const MASTERS = {
  success: true,
  skus: [{ skuId: 'SKU-0001', name: '더 플렌더 MAX 그레이지', line: '더플렌더', model: '더 플렌더 MAX', option: '그레이지', active: 'Y', order: 1 },
    { skuId: 'SKU-0002', name: '미니 건조기', line: '미니건조기', model: '', option: '', active: 'N', order: '' }],
  channels: [{ channelId: 'himart', name: '하이마트', channelCategory: '양판점' }, { channelId: 'etland', name: '전자랜드', channelCategory: '양판점' }, { channelId: 'emart', name: '이마트', channelCategory: '할인점' }],
  channelCategories: ['양판점', '할인점', '백화점', '폐쇄몰', '렌탈', '특판'],
  mappings: [{ channelId: 'etland', code: 'MNFD-200G', skuId: 'SKU-0001', stockType: '정상', name: '가상 MAX' }],
  stores: [], productLines: [], stockTypes: ['정상', '전시', '리퍼']
};
const STATUS = { success: true, today: '2026-09-27', month: '2026-09', channels: [
  { channelId: 'himart', name: '하이마트', channelCategory: '양판점', salesLast: '2026-09-24', stockLast: '2026-09-24',
    missingDays: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-25', '2026-09-26'] },
  { channelId: 'etland', name: '전자랜드', channelCategory: '양판점', salesLast: '', stockLast: '', missingDays: [] }] };

function setup() {
  const { ctx, X } = loadFrontend(PROJ, SHIM);
  const box = {};
  const el = id => (box[id] = box[id] || { id, innerHTML: '', value: '', textContent: '', className: '', style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } } });
  ctx.document.getElementById = el;
  const calls = [];
  const replies = {
    offline_getStatus: () => STATUS, offline_getUploadLog: () => ({ success: true, items: [] }),
    offline_getMasters: () => JSON.parse(JSON.stringify(MASTERS)),
    offline_upload: data => ({ success: true, uploadId: 'U1', applied: { stockDaily: 1, stockStore: 2 }, replaceRange: { baseDate: data.meta.baseDate }, unmatched: [], warnings: [] }),
    offline_saveMapping: () => ({ success: true, saved: 1 }),
    offline_saveSku: data => ({ success: true, sku: Object.assign({ skuId: 'SKU-0003' }, data.sku) })
  };
  ctx._offlineCall = async (action, data) => { calls.push({ action, data }); return replies[action](data || {}); };
  const byName = {};
  ctx._loadSheetJS = async () => ({});
  ctx.OfflineParsers.readWorkbookRows = (XLSX, bytes) => ({ rows: byName[bytes.__name] });
  ctx.Uint8Array = function (buf) { return { __name: buf.__name }; };
  const addFile = (name, rows) => { byName[name] = rows; return { name, arrayBuffer: async () => ({ __name: name }) }; };
  return { ctx, X, box, el, calls, replies, addFile, page: () => el('page-admin-upload').innerHTML };
}

(async function main() {
  console.log('\n[1] 로드와 페이지 진입 훅');
  {
    const { ctx, X, calls, page } = setup();
    check('파서·리졸버 전역', ctx.OfflineParsers && typeof ctx.OfflineParsers.parseRows === 'function' && ctx.OfflineResolver && typeof ctx.OfflineResolver.createResolver === 'function');
    check('업로드 페이지가 PAGE_MOUNTS에 등록', typeof X.PAGE_MOUNTS['admin-upload'] === 'function');
    check('SheetJS 지연 로더와 SRI 고정', typeof ctx._loadSheetJS === 'function');
    ctx.navPage('admin-upload', null);
    await settle();
    check('들어오면 상태·로그·마스터를 받는다', ['offline_getStatus', 'offline_getUploadLog', 'offline_getMasters'].every(a => calls.some(c => c.action === a)), calls.map(c => c.action));
    const h = page();
    check('세 영역', h.indexOf('데이터 현황') >= 0 && h.indexOf('파일 업로드') >= 0 && h.indexOf('최근 업로드 로그') >= 0);
    check('빈 날짜를 구간으로: 9/1~9/3, 9/25~9/26 (5일)', h.indexOf('9/1~9/3, 9/25~9/26 (5일)') >= 0, h.slice(h.indexOf('off-miss'), h.indexOf('off-miss') + 80));
    check('빈 날짜 없으면 "없음"', /off-ok">없음/.test(h));
    check('로그 비어 있음 안내', h.indexOf('아직 업로드 기록이 없습니다') >= 0);
    check('다른 페이지 진입은 오프라인 요청을 보내지 않음', (() => { const n = calls.length; ctx.navPage('calendar', null); return calls.length === n; })());
  }

  console.log('\n[2] 파일 카드 — 판별·기준일·반영 예정·미매칭');
  {
    const { ctx, X, calls, addFile, page } = setup();
    await ctx._upRefreshSide();
    ctx._upAddFiles([addFile('판매재고현황_20260924.xlsx', HIMART(3)), addFile('판매재고현황_20260923.xlsx', HIMART(2)),
      addFile('판매내역_2026-09-25_124820.xls', ETLAND), addFile('재고현황_상세.xlsx', EMART_STOCK)]);
    check('읽는 동안 "분석 중"', page().indexOf('분석 중') >= 0);
    await settle();
    const f = X.UP.files;
    check('4개 모두 판별', f.map(x => x.parse && x.parse.type).join() === 'HIMART_SALES_STOCK,HIMART_SALES_STOCK,ETLAND_SALES,EMART_STOCK', f.map(x => x.parse && x.parse.type));
    const h = page();
    check('유형 드롭다운에 판별 결과 선택', h.indexOf('<option value="HIMART_SALES_STOCK" selected>하이마트 판매재고현황') >= 0);
    check('기준일 = 파일명(9/24)', h.indexOf('value="2026-09-24"') >= 0 && h.indexOf('파일명에서 읽음') >= 0);
    check('파일명에 날짜 없는 이마트 재고 → 선택 필요 강조', h.indexOf('up-need') >= 0 && h.indexOf('선택 필요') >= 0);
    check('기간 교체형 → 교체 기간 입력(9/2~9/4)', h.indexOf('value="2026-09-02"') >= 0 && h.indexOf('value="2026-09-04"') >= 0);
    check('전자랜드 구분 요약', h.indexOf('판매(계약) <b>1</b>건') >= 0 && h.indexOf('반품 <b>1</b>건') >= 0);
    // 누적스냅샷 = 판매 값이 있거나 잔여재고가 있는 행(2026-10-07 — 재고만 있는 MNFD-200G도)
    check('하이마트 반영 예정(점포 재고 2 · 누적스냅샷 2)', h.indexOf('점포 재고 <b>2</b>') >= 0 && h.indexOf('누적스냅샷 <b>2</b>') >= 0);
    check('미매칭: 하이마트 코드 2개 모두(같은 코드의 전자랜드 매핑은 채널이 달라 해당 없음)', ctx._upUnmatched(f[0]).length === 2, ctx._upUnmatched(f[0]));
    check('미매칭: 전자랜드는 매핑됨 → "모든 코드 매핑됨"', ctx._upUnmatched(f[2]).length === 0 && h.indexOf('모든 코드 매핑됨') >= 0);
    check('전체 반영 버튼 = 준비된 3개(기준일 없는 파일 제외)', h.indexOf('전체 반영 (3)') >= 0);
    check('상품명의 태그는 이스케이프', h.indexOf('<b>굵게</b>') < 0);

    console.log('\n[3] 전체 반영 — 하이마트는 기준일 오름차순으로 맨 뒤');
    calls.length = 0;
    await ctx._upApplyAll();
    await settle();
    const ups = calls.filter(c => c.action === 'offline_upload').map(c => c.data.meta.fileName);
    check('순서: 전자랜드 → 하이마트 9/23 → 9/24', JSON.stringify(ups) === JSON.stringify(['판매내역_2026-09-25_124820.xls', '판매재고현황_20260923.xlsx', '판매재고현황_20260924.xlsx']), ups);
    check('파일 1개 = 요청 1개, meta에 유형·채널·기준일', calls.filter(c => c.action === 'offline_upload')[2].data.meta.baseDate === '2026-09-24' && calls.filter(c => c.action === 'offline_upload')[2].data.meta.channelId === 'himart');
    check('기간 교체형 meta = 파일 최소~최대', (() => { const m = calls.find(c => c.action === 'offline_upload').data.meta; return m.replaceStart === '2026-09-02' && m.replaceEnd === '2026-09-04' && m.rawRowCount === 2; })());
    check('반영 후 상태·로그를 다시 받음', calls.filter(c => c.action === 'offline_getStatus').length === 1);
    check('카드에 반영 결과', page().indexOf('✓ 반영 완료') >= 0 && X.UP.files.filter(x => x.status === 'done').length === 3);

    console.log('\n[4] 기준일 없는 파일 — 막았다가, 고르면 그 날짜로');
    const em = X.UP.files[3];
    calls.length = 0;
    await ctx._upApply(em.id);
    check('반영 요청을 보내지 않고 안내', !calls.some(c => c.action === 'offline_upload') && /기준일을 선택/.test(em.error), em.error);
    ctx._upSetBase(em.id, '2026-09-25');
    check('고르면 준비 상태', em.status === 'ready' && !em.error && page().indexOf('직접 선택') >= 0);
    await ctx._upApply(em.id);
    check('고른 기준일로 전송', calls.find(c => c.action === 'offline_upload').data.meta.baseDate === '2026-09-25');
  }

  console.log('\n[5] 교체 기간·유형·연도 수정');
  {
    const { ctx, X, calls, addFile, page } = setup();
    await ctx._upRefreshSide();
    ctx._upAddFiles([addFile('판매내역_2026-09-25.xls', ETLAND)]);
    await settle();
    const f = X.UP.files[0];
    ctx._upSetRange(f.id, 'replaceEnd', '2026-09-30');
    await ctx._upApply(f.id);
    const m = calls.find(c => c.action === 'offline_upload').data.meta;
    check('고친 교체 기간으로 전송', m.replaceStart === '2026-09-02' && m.replaceEnd === '2026-09-30', m);
    ctx._upSetRange(f.id, 'replaceStart', '2026-10-05');
    check('시작 > 끝이면 안내', page().indexOf('시작이 끝보다 늦습니다') >= 0 && ctx._upApplyOrder().length === 0);
    ctx._upSetType(f.id, 'ETLAND_STOCK');
    check('유형을 잘못 고르면 오류 카드(유형 선택은 남음)', f.status === 'error' && /헤더를/.test(f.error) && page().indexOf('— 유형 선택 —') >= 0, f.error);
    ctx._upSetType(f.id, 'ETLAND_SALES');
    check('되돌리면 다시 준비', f.status === 'ready');
    const daily = [['상품 코드', '상품명', '12월 30일', '1월 2일', '합계'], ['A', 'x', 1, 2, 3]];
    ctx._upAddFiles([addFile('기간별매출(상품별)_일별요약_x.xlsx', daily)]);
    await settle();
    const d = X.UP.files[1];
    check('이마트 일별: 연도 입력 표시', page().indexOf('up-year') >= 0);
    ctx._upSetYear(d.id, 2025);
    check('연도를 고치면 다시 파싱', d.parse.records.sales.every(x => x.s.slice(0, 4) === '2025'), d.parse.records.sales);
    ctx._upRemove(d.id);
    check('제거', X.UP.files.length === 1);
  }

  console.log('\n[6] 카드에서 바로 매핑 — 제안 칩 → 저장 버튼으로 확정');
  {
    const { ctx, X, calls, addFile, el, replies } = setup();
    await ctx._upRefreshSide();
    ctx._upAddFiles([addFile('판매재고현황_20260924.xlsx', HIMART(3))]);
    await settle();
    const f = X.UP.files[0];
    ctx._upTogglePanel(f.id);
    const host = 'upMap-' + f.id;
    const ph = el(host).innerHTML;
    check('패널에 미매칭 코드 2개', (ph.match(/class="mp-code"/g) || []).length === 2, ph.length);
    check('같은 모델(MNFD-200G)이 매핑된 SKU를 제안 칩으로', ph.indexOf('제안(모델 MNFD-200G)') >= 0 && ph.indexOf('더 플렌더 MAX 그레이지</button>') >= 0);
    check('재고구분 추정: (J) → 전시가 미리 선택', /<option selected>전시<\/option>/.test(ph));
    check('비활성 SKU는 드롭다운에 없음', ph.indexOf('SKU-0002') < 0);
    check('품목군별 optgroup', ph.indexOf('<optgroup label="더 플렌더">') >= 0);
    check('아직 고른 게 없으면 저장 버튼 비활성', ph.indexOf('선택한 0건 매핑 저장') >= 0 && /disabled onclick="_mpSave/.test(ph));
    ctx._mpApplySugg(host, 0);
    const st = X.MP[host];
    const k0 = st.items[0].channelId + '\u0001' + st.items[0].code;
    check('제안 칩 → 그 줄에 채워지고 저장 대상 체크(아직 저장 안 함)', st.sel[k0].skuId === 'SKU-0001' && st.sel[k0].checked && !calls.some(c => c.action === 'offline_saveMapping'));
    replies.offline_getMasters = () => { const m = JSON.parse(JSON.stringify(MASTERS)); m.mappings.push({ channelId: 'himart', code: '(J)MNFD-200G', skuId: 'SKU-0001', stockType: '전시' }); return m; };
    await ctx._mpSave(host);
    await settle();
    const sv = calls.find(c => c.action === 'offline_saveMapping');
    check('저장 요청: upsert·채널·코드·SKU·재고구분·상품명', sv && JSON.stringify(sv.data.items) === JSON.stringify([{ op: 'upsert', channelId: 'himart', code: '(J)MNFD-200G', skuId: 'SKU-0001', stockType: '전시', name: '가상 MAX 전시' }]), sv && sv.data);
    check('저장 후 마스터를 다시 받아 카드의 미매칭이 1개로', ctx._upUnmatched(f).length === 1 && (el(host).innerHTML.match(/class="mp-code"/g) || []).length === 1);

    console.log('\n[7] 새 SKU 만들기 — 품목군은 공유 상수, 표준명 자동 생성 후 수정 가능');
    check('자동 표준명: 품목군 + 모델 + 옵션', ctx._mpAutoName('더플렌더', 'MAX', '그레이지') === '더 플렌더 MAX 그레이지');
    check('모델이 이미 품목군 이름으로 시작하면 중복하지 않음', ctx._mpAutoName('더플렌더', '더 플렌더 PLUS', '크림 화이트') === '더 플렌더 PLUS 크림 화이트' && ctx._mpAutoName('더시프트', '더시프트 PRO', '') === '더시프트 PRO');
    check('모델 없으면 품목군 이름', ctx._mpAutoName('미니건조기', '', '네이처그린') === '미니 건조기 네이처그린');
    ctx._mpOpenNewSku(host, 0);
    const nh = el(host).innerHTML;
    check('폼: 품목군 선택지 = PRODUCT_CATALOG 6개', (nh.match(/<option value="(더플렌더|더시프트|더슬림|더에어드라이|미니건조기|미니식기세척기)"/g) || []).length === 6);
    const models = line => { el('mpNsLine-' + host).value = line; ctx._mpNsInput(host, true); const h = el(host).innerHTML;
      const dl = h.slice(h.indexOf('<datalist'), h.indexOf('</datalist>')); return (dl.match(/<option value="([^"]+)">/g) || []).map(s => s.slice(15, -2)); };
    check('모델 목록(datalist) 더 플렌더 6개', JSON.stringify(models('더플렌더')) === JSON.stringify(['더 플렌더 Basic', '더 플렌더 PRO', '더 플렌더 MAX', '더 플렌더 mini', '더 플렌더 NEXT', '더 플렌더 PLUS']), models('더플렌더'));
    check('모델 목록 미니 건조기 3개', JSON.stringify(models('미니건조기')) === JSON.stringify(['미니 건조기', '미니 건조기 PRO', '미니 건조기 PRO+']), models('미니건조기'));
    check('모델 목록 미니 식기세척기 2개', JSON.stringify(models('미니식기세척기')) === JSON.stringify(['미니 식기세척기', '미니 식기세척기 PRO']), models('미니식기세척기'));
    check('자동 표준명: 미니 건조기 PRO+ + 옵션', ctx._mpAutoName('미니건조기', '미니 건조기 PRO+', '그레이지') === '미니 건조기 PRO+ 그레이지');
    el('mpNsLine-' + host).value = '더플렌더'; el('mpNsModel-' + host).value = 'MAX'; el('mpNsOption-' + host).value = '그레이지';
    ctx._mpNsInput(host);
    check('입력하면 표준명 칸이 따라 바뀜', el('mpNsName-' + host).value === '더 플렌더 MAX 그레이지');
    ctx._mpNsNameEdited(host, '더 플렌더 MAX (그레이지)');
    el('mpNsOption-' + host).value = '그레이지2'; ctx._mpNsInput(host);
    check('표준명을 직접 고친 뒤에는 자동으로 덮어쓰지 않음', X.MP[host].ns.name === '더 플렌더 MAX (그레이지)');
    await ctx._mpCreateSku(host);
    const sk = calls.find(c => c.action === 'offline_saveSku');
    check('offline_saveSku 요청', sk && JSON.stringify(sk.data.sku) === JSON.stringify({ name: '더 플렌더 MAX (그레이지)', line: '더플렌더', model: 'MAX', option: '그레이지2', active: 'Y' }), sk && sk.data);
    const it = X.MP[host].items[0];
    check('만든 SKU가 그 줄에 선택되고 폼은 닫힘', X.MP[host].sel[it.channelId + '\u0001' + it.code].skuId === 'SKU-0003' && !X.MP[host].ns);
  }

  console.log('\n[8] 외부 문자열 이스케이프 · 빈 날짜 구간');
  {
    const { ctx, X, addFile, page } = setup();
    ctx._upAddFiles([addFile('<img src=x onerror=alert(1)>_20260924.xlsx', HIMART(1))]);
    await settle();
    check('파일명 태그가 그대로 나가지 않음', page().indexOf('<img src=x') < 0 && page().indexOf('&lt;img src=x') >= 0);
    check('구간 압축', ctx._upDayRanges(['2026-09-01', '2026-09-02', '2026-09-04', '2026-09-30']) === '9/1~9/2, 9/4, 9/30' && ctx._upDayRanges([]) === '');
    check('월 경계 연속', ctx._upDayRanges(['2026-09-30', '2026-10-01']) === '9/30~10/1');
  }

  console.log('\n[9] 코드 매핑 화면 — 미매칭 목록 + 전체 매핑 표');
  {
    const { ctx, X, calls, el, replies } = setup();
    const M = JSON.parse(JSON.stringify(MASTERS));
    M.mappings.push({ channelId: 'emart', code: '8809770080968', skuId: 'SKU-0001', stockType: '정상', name: '미닉스 더플렌더 MAX(그레이지)', registeredAt: '2026-09-27', registeredBy: 'a@athomecorp.com', note: '' },
      { channelId: 'himart', code: 'MNVC-100G', skuId: '', stockType: '정상', name: '무선청소기 <i>x</i>', note: '비활성화 2026-09-27 a@athomecorp.com' });
    replies.offline_getMasters = () => JSON.parse(JSON.stringify(M));
    replies.offline_getUnmatched = () => ({ success: true, items: [{ channelId: 'himart', code: '(J)MNFD-200G', name: '가상 MAX 전시', firstSeen: '2026-09-20', lastSeen: '2026-09-25', count: 3 }] });
    check('코드 매핑 페이지가 PAGE_MOUNTS에 등록', typeof X.PAGE_MOUNTS['admin-code-mapping'] === 'function');
    ctx.navPage('admin-code-mapping', null);
    await settle();
    const page = () => el('page-admin-code-mapping').innerHTML, table = () => el('cmTable').innerHTML;
    check('들어오면 마스터·미매칭을 받는다', calls.some(c => c.action === 'offline_getMasters') && calls.some(c => c.action === 'offline_getUnmatched'));
    check('두 영역과 미매칭 수', page().indexOf('미매칭 코드 1개') >= 0 && page().indexOf('전체 매핑') >= 0 && page().indexOf('준비 중') < 0);
    const ph = el('cmUnmatched').innerHTML;
    check('미매칭 패널: 채널(채널대분류 · 채널명)·발견횟수·최근발견일 열, 모델 제안', ph.indexOf('<th>채널</th>') >= 0 && ph.indexOf('<td>양판점 · 하이마트</td>') >= 0 && ph.indexOf('<td class="num-col">3</td>') >= 0 && ph.indexOf('제안(모델 MNFD-200G)') >= 0);
    check('전체 매핑 3건, 건수 표시', (table().match(/class="mp-code"/g) || []).length === 3 && el('cmCount').textContent === '3 / 3건', el('cmCount').textContent);
    check('비활성 매핑: "비활성" + 다시 매핑 버튼(비활성화 버튼 없음)', /off-miss">비활성/.test(table()) && table().indexOf('다시 매핑') >= 0);
    check('상품명 이스케이프', table().indexOf('<i>x</i>') < 0);

    ctx._cmSetFilter('ch', 'emart');
    check('채널 필터', ctx._cmFilteredMappings().map(x => x.code).join() === '8809770080968');
    ctx._cmSetFilter('ch', ''); ctx._cmSetFilter('line', '-');
    check('품목군 "비활성(SKU 없음)"', ctx._cmFilteredMappings().map(x => x.code).join() === 'MNVC-100G');
    ctx._cmSetFilter('line', '더플렌더');
    check('품목군 필터 = 매핑된 SKU의 품목군', ctx._cmFilteredMappings().length === 2);
    ctx._cmSetFilter('line', ''); ctx._cmSetFilter('q', '그레이지', true);
    check('검색: SKU 표준명·상품명·코드', ctx._cmFilteredMappings().length === 2 && el('cmCount').textContent === '2 / 3건');
    ctx._cmSetFilter('q', 'mnvc', true);
    check('검색은 대소문자 무시', ctx._cmFilteredMappings().map(x => x.code).join() === 'MNVC-100G');
    ctx._cmSetFilter('q', '', true); ctx._cmSetFilter('type', '전시');
    check('재고구분 필터(전시 없음) → 안내 문구', ctx._cmFilteredMappings().length === 0 && table().indexOf('조건에 맞는 매핑이 없습니다') >= 0);
    ctx._cmSetFilter('type', '');

    const rows = () => X.CM.rows;
    const iE = rows().findIndex(x => x.code === 'MNFD-200G');
    ctx._cmStartEdit(iE);
    check('수정 줄: SKU 드롭다운·재고구분·비고·저장', table().indexOf('_cmSaveEdit(' + iE + ')') >= 0 && table().indexOf('내 이메일로 기록') >= 0);
    ctx._cmEditSet('stockType', '리퍼'); ctx._cmEditSet('note', '확인 완료');
    calls.length = 0;
    await ctx._cmSaveEdit(iE);
    await settle();
    const sv = calls.find(c => c.action === 'offline_saveMapping');
    check('수정 저장 = upsert(재고구분·비고 반영)', sv && JSON.stringify(sv.data.items) === JSON.stringify([{ op: 'upsert', channelId: 'etland', code: 'MNFD-200G', skuId: 'SKU-0001', stockType: '리퍼', name: '가상 MAX', note: '확인 완료' }]), sv && sv.data);
    check('저장 후 마스터·미매칭을 다시 받음', calls.some(c => c.action === 'offline_getMasters') && calls.some(c => c.action === 'offline_getUnmatched') && X.CM.editKey === null);

    const iD = rows().findIndex(x => x.code === '8809770080968');
    calls.length = 0;
    await ctx._cmDeactivate(iD);
    check('비활성화 첫 클릭은 확인 버튼으로만 바뀜(요청 없음)', !calls.some(c => c.action === 'offline_saveMapping') && table().indexOf('비활성화 확인') >= 0);
    await ctx._cmDeactivate(iD);
    await settle();
    const dv = calls.find(c => c.action === 'offline_saveMapping');
    check('두 번째 클릭에 deactivate 요청', dv && JSON.stringify(dv.data.items) === JSON.stringify([{ op: 'deactivate', channelId: 'emart', code: '8809770080968' }]), dv && dv.data);

    replies.offline_getMasters = () => { throw new Error('Apps Script 배포본에 오프라인 기능이 아직 없습니다 — 재배포 필요'); };
    X.CM.unmatched = null;
    await ctx._cmLoad();
    check('서버 오류는 화면에 문구로(예외로 멈추지 않음)', page().indexOf('재배포') >= 0);
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL  예외: ' + (e && e.stack)); process.exit(1); });
