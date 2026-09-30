/* 채널 상세 판매 분석 — offline_getSalesBreakdown(GAS 실코드, 목 시트) + 화면(channel-sales.js, 프론트 실코드).

   지키려는 성질:
     · 점포마스터 점포유형 열(온라인/오프라인) — setup이 멱등하게 덧붙이고 이름·지역 규칙으로 채움, 새 점포도 규칙, 사람이 고친 값은 그대로
     · 판매원장 판매 등록 수량(하이마트는 설치완료 선택), 연월 = 기간종료일의 달(period도), 코드 해석 = 기존 resolver
     · 모델별 합계 = 지점별 합계 = totals.qty = 같은 기간 OUT 실적(본품, offline_getMonthly) + 필터 + 미매칭
     · 미매칭 코드는 "미매칭(원본코드)" 항목으로 합계에 남는다(대분류를 고르면 빠짐), 모델/SKU 토글해도 합계 불변
     · 대분류: 기본 본품 + 필터(기타 제외), 전체면 기타 포함, 하나 고르면 그 대분류만
     · 온라인 점포가 있는 채널만 online(온라인/오프라인 합계), 캐시·무효화, 입력 검증
     · 화면: 필터(기간·단위·대분류·하이마트 기준), 순위 막대·월별 표(색 농도·트로피)·지점 누적 막대(같은 색)·내역·검색·지역·CSV,
       온라인/오프라인은 해당 채널만, 콘솔 에러 없음, 임베드

   실행: node tests/offline-sales-breakdown.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadFrontend } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
const { loadOfflineGas, dataRows } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const FX = require(path.join(__dirname, 'lib', 'offline-2b-fixture.js'));
const PROJ = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 700) : '')); }
}
const J = JSON.stringify;
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 0)); };
const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// 2-B 픽스처 + 필터 SKU(하이마트 RF3 3대) · 기타 SKU(하이마트 전시대 1대) · 전자랜드 온라인 점포(E9 온라인쇼핑몰 2대) · 하이마트 period(8/28~9/2 4대 → 9월)
function env() {
  const g = FX.env();
  const T = g.ctx.OFF_TABS;
  const append = (key, rows) => { const sh = g.tab(T[key].name); g.ctx._offWriteBlock(sh, T[key], sh.getLastRow() + 1, rows); };
  append('sku', [['SKU-0009', '기타 3kg 건조기 전시대', '기타', '기타', '3kg 건조기 전시대', 'Y', '', ''], ['SKU-0010', '필터 하드락필터', '필터', '하드락필터', '', 'Y', '', '']]);
  append('mapping', [['himart', 'DISP', 'SKU-0009', '전시', '전시대', '2026-09-27', 'a', ''], ['himart', 'RF3', 'SKU-0010', '정상', '필터', '2026-09-27', 'a', '']]);
  append('store', [['etland', 'E9', '온라인쇼핑몰', '온라인', '', '', '']]);
  const SL = (s, e, ch, store, code, q, inst) => [s, e, s === e ? 'day' : 'period', ch, store, code, q, inst == null ? '' : inst, 'upload', 'U'];
  append('sales', [SL('2026-09-12', '2026-09-12', 'himart', 'S2', 'DISP', 1, 1), SL('2026-09-13', '2026-09-13', 'himart', 'S5', 'RF3', 3, 3),
    SL('2026-09-10', '2026-09-10', 'etland', 'E9', 'MNFD-200G', 2), SL('2026-08-28', '2026-09-02', 'himart', 'S1', 'MNMD-110G', 4, 4)]);
  g.ctx._offInvalidateCache();
  return g;
}
const B = (g, data) => g.call('offline_getSalesBreakdown', data);

(async function main() {
  console.log('\n[1] 점포마스터 점포유형 열');
  {
    const g = loadOfflineGas({ setup: true, today: FX.TODAY });
    const T = g.ctx.OFF_TABS, sh = g.tab('점포마스터');
    check('새 시트 헤더에 점포유형', J(sh._grid[0].slice(0, 7)) === J(['channel_id', '점포코드', '점포명', '지역', '최초등록일', '최근확인일', '점포유형']));
    // 6열(판매 분석 전) 모양 + 기존 점포
    sh._grid.forEach(r => { r.length = 6; });
    sh._grid.length = 1; // setup이 등록한 ERP 거래처 점포는 지우고 시작(다시 실행하면 뒤에 다시 붙는다)
    g.ctx._offWriteBlock(sh, { name: '점포마스터', headers: T.store.headers.slice(0, 6), text: [0, 1, 2, 3, 4, 5] }, 2,
      [['etland', '400040', '온라인쇼핑몰', '온라인', '', ''], ['etland', '302420', '용산5호점', 'B2B', '', ''], ['himart', 'C6450E', '수지롯데몰HM', '수원지사', '', ''], ['himart', 'Z1', '인터넷사업부', '본사', '', '']]);
    const rep = g.ctx.offline_setupSheets();
    check('6열 탭 → 점포유형 열 덧붙임(보고)', rep.extended.some(e => e.tab === '점포마스터' && J(e.added) === J(['점포유형'])), rep.extended);
    const rows = dataRows(sh).filter(r => r[0] === 'etland' || r[0] === 'himart');
    check('규칙으로 채움 — 온라인쇼핑몰·인터넷사업부 = 온라인, 용산5호점(B2B)·수지롯데몰HM = 오프라인', rows.map(r => r[2] + '=' + r[6]).join() === '온라인쇼핑몰=온라인,용산5호점=오프라인,수지롯데몰HM=오프라인,인터넷사업부=온라인', rows.map(r => r[6]));
    sh._grid[2][6] = '온라인'; // 사람이 용산5호점을 온라인으로
    const rep2 = g.ctx.offline_setupSheets();
    check('다시 실행 — 확장 없음, 사람이 고친 값 그대로', !rep2.extended.some(e => e.tab === '점포마스터') && dataRows(sh)[1][6] === '온라인');
    check('_offStoreTypeOf — 온라인·인터넷·e몰·쇼핑몰·(ON), 롯데몰(실매장)은 오프라인', g.ctx._offStoreTypeOf('강남e몰점', '') === '온라인' && g.ctx._offStoreTypeOf('강남e 몰', '') === '온라인' &&
      g.ctx._offStoreTypeOf('X', '온라인') === '온라인' && g.ctx._offStoreTypeOf('잠실(ON)HM', '강남지사') === '온라인' && g.ctx._offStoreTypeOf('잠실HM', '강남지사') === '오프라인' &&
      g.ctx._offStoreTypeOf('광복롯데몰HM', '부산지사') === '오프라인' && g.ctx._offStoreTypeOf('jess몰', '') === '오프라인');
  }
  {
    const g = FX.env();
    const P = require(path.join(__dirname, '..', 'src', 'features', 'offline', 'parsers.js'));
    const rows = [['판매내역'], ['거래처코드', '거래처명', '지부', '지점코드', '지점명', '품목', '상품구분', '모델명', '설명', '판매수량', '단가', '금액', '판매일자', '구분'],
      ['1', 'x', '온라인', '400040', '온라인쇼핑몰', 'KREF', 'a', 'MNFD-200G', 'x', '1', '1', '1', '2026-09-20', '판매(계약)'],
      ['1', 'x', '서울', '300009', '신규점', 'KREF', 'a', 'MNFD-200G', 'x', '1', '1', '1', '2026-09-20', '판매(계약)']];
    const r = P.parseRows(rows, { fileName: '판매내역_2026-09-21_101010.xls', today: FX.TODAY });
    g.ctx._offUpload(P.toUploadPayload(r, { fileName: 'f.xls', replaceStart: '2026-09-20', replaceEnd: '2026-09-20' }), { email: FX.ADMIN });
    const st = dataRows(g.tab('점포마스터')).filter(x => x[0] === 'etland' && (x[1] === '400040' || x[1] === '300009'));
    check('업로드로 새로 생긴 점포 — 규칙으로 점포유형(온라인쇼핑몰 = 온라인, 신규점 = 오프라인)', J(st.map(x => x[2] + '=' + x[6])) === J(['온라인쇼핑몰=온라인', '신규점=오프라인']), st);
    const m = g.call('offline_getMasters');
    check('마스터 점포에 storeType', m.stores.find(s => s.code === '400040').storeType === '온라인' && m.stores.find(s => s.code === 'S1').storeType === '오프라인');
  }

  console.log('\n[2] offline_getSalesBreakdown — 합계 대조');
  const g = env();
  const d = B(g, { channelId: 'himart', from: '2026-09', to: '2026-09' });
  const mon = g.call('offline_getMonthly', { from: '2026-09', to: '2026-09', channelId: 'himart', totalsOnly: true });
  const cm = mon.totals.byChannelMonth[0], filt = mon.totals.byCategory.filter(x => x.category === '필터').reduce((s, x) => s + (x.out.actual || 0), 0);
  const sumKeys = x => x.keys.reduce((s, k) => s + k.total, 0), sumStores = x => x.stores.reduce((s, t) => s + t.total, 0);
  check('성공 · 월 = 9월 · 단위 모델 · 기준 판매등록', d.success && J(d.months) === J(['2026-09']) && d.unit === 'model' && d.measure === 'sale', d.error || d.months);
  check('모델별 합계 = 지점별 합계 = totals.qty', sumKeys(d) === d.totals.qty && sumStores(d) === d.totals.qty, [sumKeys(d), sumStores(d), d.totals.qty]);
  check('totals = OUT 실적(본품 ' + cm.out.actual + ') + 필터 ' + filt + ' + 미매칭 ' + cm.out.unmatchedQty + ' (기본 = 본품 + 필터)', d.totals.qty === cm.out.actual + filt + cm.out.unmatchedQty && filt === 3 && cm.out.unmatchedQty === 5, [d.totals, cm.out]);
  check('많이 팔린 순 — 더 플렌더 MAX 78 · 미니 건조기 PRO 32(period 4 포함) · 더 슬림 28 · 미매칭 COFFEE 5 · 하드락필터 3', J(d.keys.map(k => k.label + ' ' + k.total)) === J(['더 플렌더 MAX 78', '미니 건조기 PRO 32', '더 슬림 28', '미매칭(원본코드) COFFEE 5', '하드락필터 3']), d.keys.map(k => k.label + ' ' + k.total));
  const um = d.keys.find(k => k.unmatched);
  check('미매칭 항목 — 원본코드·상품명, 대분류 없음', um.code === 'COFFEE' && um.name === '커피머신(타 브랜드)' && um.category === '' && d.totals.unmatchedQty === 5, um);
  check('기타(전시대)는 기본에서 빠짐', !d.keys.some(k => k.category === '기타'));
  const s1 = d.stores.find(s => s.store === 'S1');
  check('지점 — S1점(강남) 합계·모델별(MAX 78 · 더 슬림 28 · 미니 건조기 PRO 4)', s1 && s1.storeName === 'S1점' && s1.region === '강남' && s1.total === 110 && s1.byKey['더플렌더|더 플렌더 MAX'] === 78 && s1.byKey['미니건조기|미니 건조기 PRO'] === 4, s1);
  check('지점 합계 많은 순, 지역 목록', d.stores[0].store === 'S1' && J(d.regions) === J(['강남', '강북']), [d.stores.map(s => s.store), d.regions]);
  check('하이마트는 온라인 점포 없음 → online null, 설치완료 있음', d.online === null && d.hasInst === true);
  const sku = B(g, { channelId: 'himart', from: '2026-09', to: '2026-09', unit: 'sku' });
  check('SKU 단위 — 합계 불변, 항목 = SKU(표준명)', sku.totals.qty === d.totals.qty && sku.keys.some(k => k.key === 'SKU-0002' && k.label === '미니 건조기 PRO 그레이지' && k.total === 32) && sumStores(sku) === d.totals.qty, sku.keys.map(k => k.key));
  const all = B(g, { channelId: 'himart', from: '2026-09', to: '2026-09', category: '*' });
  check('전체(기타 포함) = 기본 + 기타 1', all.totals.qty === d.totals.qty + 1 && all.keys.some(k => k.category === '기타' && k.total === 1));
  const one = B(g, { channelId: 'himart', from: '2026-09', to: '2026-09', category: '음식물처리기' });
  check('대분류 하나(음식물처리기) — 그것만, 미매칭은 빠짐', one.totals.qty === 78 && one.totals.unmatchedQty === 0 && one.keys.length === 1, one.keys);
  check('대분류(기타)만', B(g, { channelId: 'himart', from: '2026-09', to: '2026-09', category: '기타' }).totals.qty === 1);
  const ins = B(g, { channelId: 'himart', from: '2026-09', to: '2026-09', measure: 'inst' });
  check('설치완료 기준 — 설치완료수량 합(18 + 7 + 50 + 28 + 28 + 4 + 3, 미매칭 COFFEE는 설치 빈칸)', ins.totals.qty === 138 && ins.measure === 'inst', [ins.totals, ins.keys.map(k => k.label + ' ' + k.total)]);
  const two = B(g, { channelId: 'himart', from: '2026-08', to: '2026-09' });
  const mx = two.keys.find(k => k.label === '더 플렌더 MAX');
  check('여러 달 — 월 × 모델(8월 100 · 9월 78), period(8/28~9/2)는 기간종료일 9월', J(two.months) === J(['2026-08', '2026-09']) && mx.byMonth['2026-08'] === 100 && mx.byMonth['2026-09'] === 78 &&
    two.keys.find(k => k.label === '미니 건조기 PRO').byMonth['2026-08'] === undefined, [mx.byMonth, two.keys.find(k => k.label === '미니 건조기 PRO').byMonth]);
  const et = B(g, { channelId: 'etland', from: '2026-09', to: '2026-09' });
  const etMon = g.call('offline_getMonthly', { from: '2026-09', to: '2026-09', channelId: 'etland', totalsOnly: true }).totals.byChannelMonth[0];
  check('전자랜드 — 합계 = OUT 실적, 온라인 점포(E9 온라인쇼핑몰) → 온라인 2 · 오프라인 4', et.totals.qty === etMon.out.actual && J(et.online) === J({ online: 2, offline: 4, stores: ['온라인쇼핑몰'] }) && et.hasInst === false, [et.totals, et.online]);
  check('캐시 — 같은 조회는 캐시', B(g, { channelId: 'himart', from: '2026-09', to: '2026-09' }).cached === true);
  g.call('offline_saveMapping', { items: [{ op: 'upsert', channelId: 'himart', code: 'COFFEE', skuId: 'SKU-0001', stockType: '정상' }] }, 'admin');
  const after = B(g, { channelId: 'himart', from: '2026-09', to: '2026-09' });
  check('매핑을 바꾸면 무효 — COFFEE가 더 플렌더 MAX로(83), 미매칭 0, 합계 그대로', !after.cached && after.totals.unmatchedQty === 0 && after.keys[0].total === 83 && after.totals.qty === d.totals.qty, after.keys.map(k => k.label + ' ' + k.total));
  check('입력 검증 — 연월·채널·대분류·기간 길이', /연월 범위/.test(B(g, { channelId: 'himart', from: '2026-9' }).error || '') && /채널마스터에 없는/.test(B(g, { channelId: 'nope', from: '2026-09' }).error || '') &&
    /대분류가 올바르지/.test(B(g, { channelId: 'himart', from: '2026-09', category: 'x' }).error || '') && /24개월까지/.test(B(g, { channelId: 'himart', from: '2024-01', to: '2026-09' }).error || ''));

  console.log('\n[3] 화면 — 채널 상세 판매 분석 카드');
  {
    const g2 = env();
    const { ctx, X } = loadFrontend(PROJ, 'get OSA(){return _OSA;}, get OCD(){return _OCD;}, get OF(){return OFFLINE_FILTER;}');
    const box = {}, errors = [], blobs = [];
    const el = id => (box[id] = box[id] || { id, innerHTML: '', value: '', textContent: '', dataset: {}, style: {}, children: [], getContext: () => ({}), scrollIntoView() {}, contains: () => false, querySelector: () => null,
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } } });
    ctx.document.getElementById = el;
    ctx.Chart = function () { return { destroy() {} }; };
    ctx.Blob = function (parts) { blobs.push(parts.join('')); };
    ctx.URL.createObjectURL = () => 'blob:x'; ctx.URL.revokeObjectURL = () => {};
    ctx._getToken = () => 'T';
    const calls = [];
    ctx._gasFetch = async (url, o) => { const b = JSON.parse(o.body); calls.push({ action: b.action, data: b.data }); return g2.call(b.action, b.data, 'admin'); };
    ctx.console = Object.assign({}, console, { error: (...a) => errors.push(a.map(String).join(' ')), warn() {}, log() {}, debug() {} });
    X.OF.ym = '2026-09';
    Object.assign(X.OSA, { preset: 'custom', from: '2026-09', to: '2026-09' }); // 실행 날짜와 무관하게 9월
    ctx.navPage('offline-channel', null, 'himart'); await settle();
    const card = () => el('ocdSalesCard').innerHTML;
    let h = card();
    check('카드: 판매 분석 · 기간 · 판매 등록 기준 · 합계 146대(본품 138 + 필터 3 + 미매칭 5)', /판매 분석/.test(h) && /2026-09 · 판매원장 판매 등록 기준/.test(h) && /합계 <b>146대<\/b> · 미매칭 5대 포함/.test(h), text(h).slice(0, 200));
    check('offline_getSalesBreakdown 호출(9월 · 모델 · 본품+필터 · 판매등록)', calls.some(c => c.action === 'offline_getSalesBreakdown' && J(c.data) === J({ channelId: 'himart', from: '2026-09', to: '2026-09', unit: 'model', category: '', measure: 'sale' })));
    check('필터 — 기간 4종 · 모델/SKU · 대분류(본품 + 필터 기본) · 하이마트 판매등록/설치완료', /이번 달[^]*최근 3개월[^]*올해[^]*직접 선택/.test(h) && /_osaSet\('unit','sku'\)/.test(h) && /<option value="" selected>본품 \+ 필터/.test(h) && /설치완료/.test(h));
    const rank = h.slice(h.indexOf('osa-rank'), h.indexOf('월별 모델별'));
    check('순위 막대 — 많이 팔린 순 5개, 1위 더 플렌더 MAX 78(막대 100%)', (rank.match(/class="osa-row"/g) || []).length === 5 && /더 플렌더 MAX[^]*?width:100\.0%;background:#2a78d6[^]*?osa-v">78/.test(rank));
    check('월별 표 — 합계·평균 열, 셀 색 농도, 1위 트로피, 안내 문구', /<th class="num-col">9월<\/th><th class="num-col">합계<\/th><th class="num-col">평균<\/th>/.test(h) && /osa-heat" style="background:rgba\(42,120,214,0\.600\)"><span class="osa-trophy"[^>]*>🏆<\/span>78/.test(h) &&
      h.indexOf('월별 모델별 판매량 · 색이 짙을수록 많이 팔린 기간, 트로피는 그 기간의 1위 모델') >= 0);
    const st = h.slice(h.indexOf('지점별 판매량'));
    check('지점 — 누적 막대(모델 색 = 순위 막대 색), 합계, 내역 줄 "더 플렌더 MAX 78대 · 더 슬림 28대 · 미니 건조기 PRO 4대"', /S1점[^]*?osa-seg" style="width:[\d.]+%;background:#2a78d6/.test(st) && /osa-v">110/.test(st) && st.indexOf('더 플렌더 MAX 78대 · 더 슬림 28대 · 미니 건조기 PRO 4대') >= 0);
    check('범례 = 모델 색(5개, 9개 미만이라 그 외 없음)', (st.match(/class="osa-leg"/g) || []).length === 5 && st.indexOf('그 외') < 0);
    check('하이마트는 온라인/오프라인 섹션 없음', h.indexOf('온라인 / 오프라인 판매량') < 0);
    ctx._osaSet('q', 'S5');
    check('점포 검색 → S5점만(목록만 다시 그림)', (el('osaStores').innerHTML.match(/class="osa-store"/g) || []).length === 1 && /S5점/.test(el('osaStores').innerHTML));
    ctx._osaSet('q', ''); ctx._osaSet('region', '강북');
    check('지역 필터(강북) → S3·S4·S5', (el('osaStores').innerHTML.match(/class="osa-store"/g) || []).length === 3);
    ctx._osaSet('region', '');
    ctx._osaStoreCsv();
    const csv = blobs.pop() || '';
    check('CSV — 머리(채널·기간·점포·지역·점포유형·합계·모델들) + 점포 4곳(S2는 기타만 팔아 기본에서 빠짐), BOM', csv.charCodeAt(0) === 0xFEFF && /채널,기간,점포코드,점포명,지역,점포유형,합계,더 플렌더 MAX/.test(csv) && csv.trim().split('\r\n').length === 5 && /하이마트,2026-09,S1,S1점,강남,오프라인,110,78/.test(csv), csv.slice(0, 300));
    const n0 = calls.length;
    ctx._osaSet('unit', 'sku'); await settle();
    h = card();
    check('SKU 토글 → 다시 받음, 합계 그대로(146)', calls.length > n0 && /합계 <b>146대<\/b>/.test(h) && /미니 건조기 PRO 그레이지/.test(h));
    ctx._osaSet('unit', 'model'); ctx._osaSet('measure', 'inst'); await settle();
    check('설치완료 → 138대(설치완료수량 합, 미매칭 COFFEE는 설치 빈칸)', /합계 <b>138대<\/b>/.test(card()), text(card()).slice(0, 160));
    ctx._osaSet('measure', 'sale'); ctx._osaSet('category', '*'); await settle();
    check('대분류 전체 → 기타 포함 147대', /합계 <b>147대<\/b>/.test(card()));
    ctx._osaSet('category', ''); await settle();
    ctx.navPage('offline-channel', null, 'etland'); await settle();
    h = card();
    check('전자랜드로 이동 → 다시 받음, 판매등록/설치완료 토글 없음, 온라인/오프라인 섹션(온라인 2 · 오프라인 4)', /합계 <b>6대<\/b>/.test(h) && h.indexOf('설치완료') < 0 && /온라인 \/ 오프라인 판매량/.test(h) && /온라인<\/span>[^]*?osa-v">2 /.test(h) && /온라인 점포: 온라인쇼핑몰/.test(h), text(h).slice(-400));
    Object.assign(X.OSA, { preset: 'custom', from: '2026-10', to: '2026-10' }); ctx._osaLoad(); await settle();
    check('판매 없는 기간 → 안내', /이 기간에 판매 기록이 없습니다/.test(card()));
    check('판매 분석 그리기에 콘솔 에러 없음', errors.length === 0, errors);
    // 섹션 순서 — 채널마다 같다(기존 섹션은 그대로, 판매 분석은 모델·SKU 표와 점포 표 사이)
    const ORDER = /월별 추이[^]*일별 Sell-out[^]*모델·SKU[^]*id="ocdSalesCard"[^]*id="ocdStoreCard"/;
    for (const c of ['himart', 'etland', 'emart']) {
      ctx.navPage('offline-channel', null, c); await settle();
      check(c + ' 섹션 순서 = 월별 추이 → 일별 Sell-out → 모델·SKU → 판매 분석 → 점포', ORDER.test(el('page-offline-channel').innerHTML) && /판매 분석/.test(card()));
    }
    check('채널을 오가도 콘솔 에러 없음', errors.length === 0, errors);
  }
  {
    const g3 = env();
    const { ctx, X } = loadFrontend(PROJ, 'get OSA(){return _OSA;}, get OF(){return OFFLINE_FILTER;}', { search: '?embed=1', runHeadScripts: true });
    const box = {}, errors = [];
    ctx.document.getElementById = id => (box[id] = box[id] || { id, innerHTML: '', value: '', style: {}, children: [], getContext: () => ({}), classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
    ctx.Chart = function () { return { destroy() {} }; };
    ctx._getToken = () => 'T';
    ctx._gasFetch = async (url, o) => { const b = JSON.parse(o.body); return g3.call(b.action, b.data, 'admin'); };
    ctx.console = Object.assign({}, console, { error: (...a) => errors.push(a.map(String).join(' ')), warn() {}, log() {}, debug() {} });
    X.OF.ym = '2026-09'; Object.assign(X.OSA, { preset: 'custom', from: '2026-09', to: '2026-09' });
    ctx.navPage('offline-channel', null, 'himart'); await settle();
    check('임베드(?embed=1) — 판매 분석 카드가 그려지고 주소에 embed 유지, 콘솔 에러 없음', X.IS_EMBED === true && /합계 <b>146대<\/b>/.test(box.ocdSalesCard.innerHTML) &&
      /\?embed=1#offline\/channel\/himart$/.test(ctx.history._urls[ctx.history._urls.length - 1]) && errors.length === 0, errors);
    check('임베드 — 섹션 순서 같음(모델·SKU → 판매 분석 → 점포)', /모델·SKU[^]*id="ocdSalesCard"[^]*id="ocdStoreCard"/.test(box['page-offline-channel'].innerHTML));
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})();
