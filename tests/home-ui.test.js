/* 파트 홈 화면(#home)과 목표 관리 [공구 목표]·[연간 보기 공동구매 줄]·[이관 — 공구 목표 이관]. index.html이 싣는 프론트 실코드 + GAS 실코드(목 시트).

   지키려는 성질(명세 6번 검증을 테스트로 고정):
     · 파트 홈의 공구 월 실적 = 공구 분석 화면의 같은 연월 필터 '총 매출'(renderKPI 실코드) — 월·연 누적 모두
     · 오프라인 + 폐쇄몰·특판 IN 금액 = 채널 현황의 IN 금액(_ofTotals) · 파트 실적 = 채널군 3개 합 · 연간 추이 월 합 = 카드 값
     · 오늘 챙길 것 = 각 화면의 실제 건수(미기입 배지 · 코드 매핑 미매칭 수 · 재고 현황 경보 탭 · 데이터 지연 채널), 0건은 "이상 없음"
     · 공구 일정: 이번 주·다음 주의 진행중·예정만, 누르면 공구 캘린더 그 달 · 연간 추이 막대를 누르면 그 달로
     · 대분류별 판매: 오프라인·폐쇄몰·특판 OUT + 공구 판매(카탈로그 밖 제품은 따로), 대분류 필터
     · 불러오는 동안 스켈레톤, 서버 오류·그리기 오류가 한 섹션에 나도 나머지 섹션은 그려짐, 콘솔 에러 없음, ?embed=1 유지
     · [공구 목표] 탭: 품목군 → 모델(벤더 합) → 벤더 입력, 금액/수량 전환, 바뀐 칸만 저장(고친 쪽 값만), 엑셀 붙여넣기, 벤더 추가
     · [연간 보기]: 채널 전체일 때 공동구매(읽기 전용) · IN 쪽 파트 합계(IN + 공동구매) 줄
     · [이관]: 공구 목표 이관 미리보기 → 매핑 → 대조(일치/다름, 마감 매출 vs 공구 시트 실적) → 두 번 눌러 반영

   실행: node tests/home-ui.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadFrontend } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
const { loadOfflineGas, dataRows } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const FX = require(path.join(__dirname, 'lib', 'offline-2b-fixture.js'));
const { buildLegacy, TAB } = require(path.join(__dirname, 'lib', 'gongu-legacy-fixture.js'));
const PROJ = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 700) : '')); }
}
const J = JSON.stringify;
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 0)); };
const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const SHIM = 'get HOME(){return HOME;}, get DASH(){return DASH;}, get TG(){return _TG;}, get TGA(){return _TGA;}, get TGG(){return _TGG;}, get OF(){return OFFLINE_FILTER;}, get CM(){return _CM;}, get OIV(){return _OIV;}, get CAL(){return CAL_STATE;}, fmtWon(v){return won(v);}, fmtPct(r){return _ofPct(r);}';

// ── GAS(목 시트) — 2-B 픽스처 + 폐쇄몰 채널 + 오프라인 목표·단가 + 공구 목표 + 원본 '공동구매 26년 목표' ──
function gasEnv() {
  const L = buildLegacy();
  const g = loadOfflineGas({ setup: true, today: FX.TODAY, legacy: { [TAB]: { grid: L.grid, merges: L.merges } } });
  const T = g.ctx.OFF_TABS;
  const put = (key, rows) => { const sh = g.tab(T[key].name); if (key === 'channel') sh._grid.length = 1; g.ctx._offWriteBlock(sh, T[key], 2, rows); };
  put('channel', FX.CHANNELS.concat([['theablen', '디에이블앤', '폐쇄몰', 'N', 6, '']])); put('sku', FX.SKUS); put('mapping', FX.MAPPINGS);
  put('store', FX.STORES); put('sales', FX.SALES); put('stockDaily', FX.STOCK_DAILY); put('stockStore', FX.STOCK_STORE);
  put('uploadLog', FX.UPLOAD_LOG); put('unmatched', FX.UNMATCHED_TAB);
  const token = FX.session(g.ctx, FX.ADMIN);
  g.call = (action, data) => JSON.parse(g.ctx.doPost({ postData: { contents: J({ action, session: token, data }) }, parameter: {} }));
  const it = (ym, ch, line, model, t, a) => ({ ym, channelId: ch, line, model, type: 'IN', target: t, actual: a });
  g.call('offline_saveTargets', { items: [it('2026-09', 'himart', '더플렌더', '더 플렌더 MAX', 100, 80), it('2026-09', 'emart', '더플렌더', '더 플렌더 MAX', 50, 60),
    it('2026-08', 'himart', '더플렌더', '더 플렌더 MAX', 40, 40), it('2026-09', 'theablen', '더슬림', '더 슬림', 10, 5)] });
  const pr = (ch, line, model, price) => ({ channelId: ch, line, model, price, startDate: '2026-01-01' });
  g.call('offline_savePrices', { items: [pr('himart', '더플렌더', '더 플렌더 MAX', 400000), pr('emart', '더플렌더', '더 플렌더 MAX', 390000), pr('theablen', '더슬림', '더 슬림', 200000)] });
  g.call('offline_saveGonguTargets', { items: [{ ym: '2026-09', vendor: '모엔즈', line: '더플렌더', model: '더 플렌더 MAX', qty: 100, amount: 44900000 },
    { ym: '2026-09', vendor: '기타', line: '더에어드라이', model: '더 에어드라이', qty: 10, amount: 3590000 },
    { ym: '2026-08', vendor: '모엔즈', line: '더시프트', model: '더 시프트', qty: 5, amount: 1795000 }] });
  return g;
}

// ── 프론트 — 서버 호출은 GAS 실코드로 직결 ──
function front(g, opts) {
  const { ctx, X } = loadFrontend(PROJ, SHIM, opts);
  const box = {}, charts = [], errors = [], calls = [];
  const el = id => (box[id] = box[id] || { id, innerHTML: '', value: '', textContent: '', dataset: {}, style: {}, children: [], getContext: () => ({}), scrollIntoView() {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } } });
  ctx.document.getElementById = el;
  ctx.document.querySelectorAll = sel => {
    const m = { '.tgg-tbl tr.tg-row': 'page-admin-targets', '.tga-tbl tr.tg-row': 'page-admin-targets' }[sel];
    if (!m) return { length: 0, forEach() {}, map: () => [] };
    const out = [];
    el(m).innerHTML.split('<tr class="tg-row">').slice(1).forEach(chunk => { const r = /data-r="(\d+)"/.exec(chunk.split('</tr>')[0]); out.push({ querySelector: () => r ? { dataset: { r: r[1] } } : null }); });
    return out;
  };
  ctx._getToken = () => 'T';
  ctx._gasFetch = async (url, o) => { const b = JSON.parse(o.body); calls.push({ action: b.action, data: b.data }); return ctx.__fail && ctx.__fail(b.action) || g.call(b.action, b.data); };
  ctx.showToast = () => {};
  ctx.Chart = function (c, cfg) { charts.push(cfg); return { destroy() {} }; };
  ctx.sessionStorage.setItem('gp_user', J({ email: FX.ADMIN, name: '관리자' }));
  ctx.console = Object.assign({}, console, { error: (...a) => errors.push(a.map(String).join(' ')), warn() {}, log() {}, debug() {} });
  return { ctx, X, el, charts, errors, calls, page: id => el('page-' + id).innerHTML };
}

// ── 공구건(DATA) — 상태는 실제 오늘(KST) 기준으로 판정되므로, 일정용 건은 오늘에서 계산한다 ──
function deals(ctx) {
  const today = ctx._kstTodayDate(), f = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const add = n => f(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));
  const dow = (today.getDay() + 6) % 7, nextMon = 7 - dow;
  let id = 0;
  const D = (product, ch, start, end, qty, rev, sale) => ({ id: ++id, dealId: 'D' + id, brand: 'Minix', product, ch, influencer: ch, start, end, status: '', qty, rev,
    codes: [], reels: [], perfRows: qty != null || rev != null ? 1 : 0, s: { retail: null, sale: sale || null, comm: null, note: '' } });
  return [
    D('더 플렌더 MAX', '키친퀸', '2026-09-03', '2026-09-05', 100, 44900000, 449000),
    D('더 시프트', '데일리팁스', '2026-09-10', '2026-09-12', 10, 3590000, 359000),
    D('더 에어드라이', '뷰티노트', '2026-08-20', '2026-08-22', 5, 1795000, 359000),
    D('더 플렌더 PRO', '헤어러브', '2026-09-25', '2026-09-27', null, null, 379000),      // 완료 + 실적 미기입
    D('더 슬림', '핏푸디', '2099-01-10', '2099-01-12', null, null, 289000),               // 예정 — 매출 제외, 배지 제외
    D('신제품X', '뉴채널', '2026-09-15', '2026-09-16', 3, 300000, 100000),              // 카탈로그 밖 제품
    D('더 플렌더 MAX', '진행채널', add(-1), add(1), null, null, 449000),                  // 이번 주 진행중(실적 아직 없음)
    D('더 시프트', '다음주채널', add(nextMon + 1), add(nextMon + 2), null, null, 359000), // 다음 주 예정
    D('더 플렌더 mini', '끝난채널', add(-1), add(-1), 1, 0, 289000)                        // 완료 — 일정에 안 나옴
  ];
}

(async function main() {
  console.log('\n[1] 파트 홈 — 불러오는 동안 스켈레톤, 다 받으면 다섯 섹션');
  const g = gasEnv();
  const F = front(g);
  const { ctx, X, el, page } = F;
  X.DATA.splice(0, X.DATA.length, ...deals(ctx));
  // '끝난채널'(어제 끝난 완료 건, 수량 1)이 9월에 들어가는지는 실행 날짜에 따라 다르다
  const d9Sep = X.DATA.find(d => d.ch === '끝난채널').start.slice(0, 7) === '2026-09' ? 1 : 0;
  X.HOME.ym = '2026-09';
  ctx.navPage('home', null);
  check('불러오는 중 — 스켈레톤', /home-skel/.test(page('home')) && /① 파트 실적/.test(page('home')));
  await settle();
  let h = page('home');
  check('다섯 섹션 모두 그려짐', ['① 파트 실적', '② 연간 추이', '③ 오늘 챙길 것', '④ 공구 일정', '⑤ 대분류별 이번 달 판매'].every(s => h.indexOf(s) >= 0) && !/home-skel/.test(h));
  check('home_getSummary를 필터 그대로 부름', F.calls.some(c => c.action === 'home_getSummary' && J(c.data) === J({ ym: '2026-09', mode: 'month', category: '' })));
  check('매출 기준 안내 문구', h.indexOf('매출 기준: 오프라인 Sell-in × 공급가 + 공구 판매 × 공구가 (VAT 포함') >= 0);
  check('판매 기준 안내 문구', h.indexOf('판매 기준: 오프라인 Sell-out + 공구 판매') >= 0);
  check('데이터 기준일 — 오프라인 채널별 최신일 + 공구 실시간', /of-fresh-ch">하이마트/.test(h) && /of-fresh-ch">공구<\/span> 실시간/.test(h));

  console.log('\n[2] 금액 대조 — 채널군 합 = 파트, 오프라인 = 채널 현황 IN 금액, 공구 = 공구 분석 총 매출');
  let M = ctx._homeModel();
  const G = k => M.groups.find(x => x.key === k);
  check('오프라인 9월 IN 실적 = 80×400,000 + 60×390,000', G('offline').actual === 55400000, G('offline'));
  check('폐쇄몰·특판 = 5×200,000', G('closed').actual === 1000000 && G('closed').target === 2000000, G('closed'));
  check('공동구매 9월 = 44,900,000 + 3,590,000 + 카탈로그 밖 300,000(예정·다른 달 제외)', G('gongu').actual === 48790000 && G('gongu').target === 48490000, G('gongu'));
  check('파트 실적·목표 = 채널군 3개 합', M.part.actual === 55400000 + 1000000 + 48790000 && M.part.target === 59500000 + 2000000 + 48490000, M.part);
  check('기여 비중 합 = 100%', Math.abs(M.groups.reduce((s, x) => s + x.share, 0) - 1) < 1e-9);
  const mon = await ctx._offlineCall('offline_getMonthly', { from: '2026-01', to: '2026-12', totalsOnly: true });
  check('오프라인 + 폐쇄몰·특판 = 채널 현황 IN 금액(_ofTotals)', G('offline').actual + G('closed').actual === ctx._ofTotals(mon, '', ['2026-09'], '').in.actualAmount);
  const kpiRev = () => { ctx.renderKPI(); return (/총 매출 \(완료\+진행중\)<\/div><div class="kpi-val cm">([^<]*)</.exec(el('kpiRow').innerHTML) || [])[1]; };
  Object.assign(X.DASH, { years: new Set([2026]), months: new Set([9]), weeks: null, channel: null, revTier: 'all', followerTier: 'all', product: 'all' });
  check('공구 9월 실적 = 공구 분석 같은 연월 필터 총 매출(renderKPI)', X.fmtWon(G('gongu').actual) === kpiRev(), [X.fmtWon(G('gongu').actual), kpiRev()]);
  check('트렌드 9월 = 카드 값(월)', M.trend.find(x => x.ym === '2026-09').actual === M.part.actual && M.trend.find(x => x.ym === '2026-09').target === M.part.target);
  check('① 카드에 파트 실적(짧은 금액)·달성률', h.indexOf(ctx._ofWonShort(M.part.actual)) >= 0 && h.indexOf(X.fmtPct(M.part.rate)) >= 0);

  ctx._homeSet('mode', 'ytd'); await settle();
  M = ctx._homeModel();
  X.DASH.months = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  check('연 누적 — 공구 실적 = 공구 분석 1~9월 총 매출', X.fmtWon(M.groups.find(x => x.key === 'gongu').actual) === kpiRev(), [M.groups.find(x => x.key === 'gongu').actual, kpiRev()]);
  const ytdSum = M.trend.filter(x => x.ym <= '2026-09').reduce((s, x) => s + (x.actual || 0), 0);
  check('연 누적 — 연간 추이 1~9월 합 = 카드 값', ytdSum === M.part.actual && M.part.actual === 55400000 + 1000000 + 48790000 + 16000000 + 1795000, [ytdSum, M.part.actual]);
  const mon8 = ctx._ofTotals(mon, '', M.s.range, '').in.actualAmount;
  check('연 누적 — 오프라인 + 폐쇄몰·특판 = 채널 현황 IN 금액(연 누적)', M.groups[0].actual + M.groups[1].actual === mon8, [M.groups[0].actual, M.groups[1].actual, mon8]);
  ctx._homeSet('mode', 'month'); await settle();

  console.log('\n[3] 연간 추이 — 누적 막대 + 목표 선, 막대를 누르면 그 달');
  const tc = F.charts.filter(c => c.data && c.data.datasets.some(d => d.label === '파트 월 목표')).pop();
  check('채널군 3개 누적 막대(고정 색) + 파트 월 목표 선, 축 하나', tc && J(tc.data.datasets.map(d => d.type + ':' + d.label)) === J(['bar:오프라인', 'bar:특수(폐쇄몰·특판·렌탈)', 'bar:공동구매', 'line:파트 월 목표']) &&
    tc.data.datasets[0].stack === 'part' && !tc.options.scales.y2, tc && tc.data.datasets.map(d => d.label));
  check('막대 데이터 = 월별 채널군 실적', tc.data.datasets[2].data[8] === 48790000 && tc.data.datasets[0].data[7] === 16000000);
  check('월별 표(표 보기) 제공', /<summary>월별 표<\/summary>/.test(page('home')));
  tc.options.onClick({}, [], { getElementsAtEventForMode: () => [{ index: 7 }] });
  check('8월 막대 클릭 → 연월 2026-08', X.HOME.ym === '2026-08');
  await settle();
  check('다시 불러옴(8월)', F.calls.filter(c => c.action === 'home_getSummary').pop().data.ym === '2026-08');
  ctx._homeSet('ym', '2026-09'); await settle();
  h = page('home');

  console.log('\n[4] 오늘 챙길 것 — 각 화면의 건수와 같다');
  ctx.renderMgmtPage();
  check('미기입 = 사이드바 미기입 배지(완료 1건)', el('sbPendingBadge').textContent === '1' && ctx.partPendingDoneCount() === 1 && /미기입 목록 — 종료·실적 미기입 공구<\/div><div class="home-todo-v"><span class="home-todo-n">⚠ 1/.test(h), el('sbPendingBadge').textContent);
  const S = X.HOME.sum;
  check('미매칭 = 코드 매핑 미매칭 목록 수', S.today.unmatched === g.call('offline_getUnmatched').items.length && new RegExp('코드 매핑 — 미매칭 코드</div><div class="home-todo-v"><span class="home-todo-n">⚠ ' + S.today.unmatched).test(h));
  check('업로드 지연 = 전자랜드(판매 7일 전)', J(S.today.delayed.map(c => c.channelId)) === J(['etland']) && /전자랜드 판매 7일 전/.test(h));
  ctx.navPage('offline-inventory', null); await settle();
  const inv = X.OIV.inv, a = ctx._ofAlertCounts(inv, '');
  const ih = page('offline-inventory');
  check('재고 경보 = 재고 현황 경보 탭(과다·결품 위험·점포 결품)', J(S.today.alerts) === J(a) && ih.indexOf('과다 ' + a.over) >= 0 && ih.indexOf('점포 결품 ' + a.storeOut) >= 0, { home: S.today.alerts, inv: a });
  ctx.navPage('home', null); await settle();
  X.HOME.category = '음식물처리기'; ctx._homeGoInventory();
  check('재고 현황으로 갈 때 대분류 필터를 넘긴다', X.OF.category === '음식물처리기' && /#offline\/inventory$/.test(ctx.history._urls[ctx.history._urls.length - 1]));
  X.OF.category = ''; X.HOME.category = '';
  ctx.navPage('home', null); await settle();
  // 0건이면 "이상 없음"
  X.HOME.sum.today = { delayed: [], unmatched: 0, alerts: { over: 0, risk: 0, storeOut: 0 } };
  ctx._homeRender();
  check('0건 → 이상 없음(오프라인 세 항목)', (page('home').match(/✓ 이상 없음/g) || []).length === 3);
  ctx._homeLoad(true); await settle();

  console.log('\n[5] 공구 일정 — 이번 주·다음 주, 진행중·예정만, 누르면 공구 캘린더');
  h = page('home');
  check('이번 주 = 진행중 1건(완료·예정 먼 건 제외)', /이번 주 1/.test(h) && /진행채널/.test(h) && !/끝난채널/.test(h) && !/핏푸디/.test(h));
  check('다음 주 탭 건수 1', /다음 주 1/.test(h));
  ctx._homeSetWeek('next');
  h = page('home');
  check('다음 주 = 예정 1건, 공구가·상태 배지', /다음주채널/.test(h) && /₩359,000/.test(h) && /bdg-p">예정/.test(h));
  const dStart = X.DATA.find(d => d.ch === '다음주채널').start;
  ctx._homeGoCalendar(dStart);
  check('일정 클릭 → 공구 캘린더(#calendar), 그 달 펼침', /#calendar$/.test(ctx.history._urls[ctx.history._urls.length - 1]) && X.CAL.months.has(dStart.slice(0, 7)) && X.CAL.years.has(dStart.slice(0, 4)));
  ctx._homeSetWeek('this');
  ctx.navPage('home', null); await settle();

  console.log('\n[6] 대분류별 이번 달 판매');
  const rows = ctx._homeCatRows();
  const R = c => rows.find(r => r.category === c);
  const mon9 = g.call('offline_getMonthly', { from: '2026-09', to: '2026-09', totalsOnly: true });
  const outQ = c => mon9.totals.byCategory.filter(x => x.category === c).reduce((s, x) => s + (x.out.actual || 0), 0);
  check('본품 대분류 + 카탈로그 밖 제품 줄', J(rows.map(r => r.category)) === J(['음식물처리기', '김치냉장고', '청소기', '건조기', '식세기', '카탈로그 밖 제품']), rows.map(r => r.category));
  check('음식물처리기 = 오프라인 OUT(원장) + 공구 100(+ 어제 끝난 1)', (R('음식물처리기').offline || 0) + (R('음식물처리기').closed || 0) === outQ('음식물처리기') && R('음식물처리기').gongu === 100 + d9Sep &&
    R('음식물처리기').total === outQ('음식물처리기') + 100 + d9Sep, R('음식물처리기'));
  check('김치냉장고 공구 10 · 카탈로그 밖 3', R('김치냉장고').gongu === 10 && R('카탈로그 밖 제품').gongu === 3);
  const cc = F.charts.filter(c => c.options && c.options.indexAxis === 'y').pop();
  check('대분류 차트 — 가로 누적 막대, 채널군 색 같음', cc && J(cc.data.datasets.map(d => d.label + d.backgroundColor)) === J(['오프라인#2a78d6', '특수(폐쇄몰·특판·렌탈)#eb6834', '공동구매#1baf7a']));
  ctx._homeSet('category', '음식물처리기'); await settle();
  M = ctx._homeModel();
  check('대분류 필터 — 공구는 그 대분류만(44,900,000), 판매 표도 그 대분류만', M.groups[2].actual === 44900000 && J(ctx._homeCatRows().map(r => r.category)) === J(['음식물처리기']), M.groups[2]);
  check('대분류 필터 — 필터 매출 줄 숨김', page('home').indexOf('필터 매출') < 0);
  ctx._homeSet('category', ''); await settle();
  check('정상 그리기에 콘솔 에러 없음', F.errors.length === 0, F.errors);

  console.log('\n[7] 오류 격리 — 서버 오류·섹션 그리기 오류');
  ctx.__fail = act => act === 'home_getSummary' ? { error: '집계 실패(테스트)' } : null;
  ctx._homeLoad(true); await settle();
  h = page('home');
  check('서버 오류 → ①② 오류 카드', (h.match(/파트 집계를 불러오지 못했습니다/g) || []).length === 2);
  check('  ③ 미기입(공구)은 그대로 · 오프라인 항목은 "불러오지 못함"', /⚠ 1<small>건/.test(h) && /불러오지 못함/.test(h));
  check('  ④ 공구 일정은 그대로', /진행채널/.test(h));
  check('  ⑤ 공구 판매만 표시', /공구 판매만 표시합니다/.test(h) && /카탈로그 밖 제품/.test(h));
  ctx.__fail = null;
  ctx._homeLoad(true); await settle();
  const orig = ctx.partGonguByCategory;
  ctx.partGonguByCategory = () => { throw new Error('그리기 실패(테스트)'); };
  F.errors.length = 0;
  ctx._homeRender();
  h = page('home');
  check('⑤ 그리기 오류 → ⑤만 오류 카드, ①~④는 그려짐', /⑤ 대분류별 이번 달 판매<\/div><div class="up-err">그리기 실패/.test(h) && /home-hero/.test(h) && /④ 공구 일정/.test(h) && F.errors.length > 0);
  ctx.partGonguByCategory = orig;

  console.log('\n[8] 목표 관리 [공구 목표] 탭');
  ctx.navPage('admin-targets', null); await settle();
  ctx._tgSetTab('gongu'); await settle();
  let tp = page('admin-targets');
  check('탭 [월별 입력 | 연간 보기 | 공구 목표 | 단가 | 이관]', /월별 입력[^]*연간 보기[^]*공구 목표[^]*단가[^]*이관/.test(text(tp.slice(0, tp.indexOf('</div>')))));
  check('품목군 → 모델(벤더 합) → 벤더: 더 플렌더 품목군 줄 + 모델 4 + 값 있는 모델은 펼침(모엔즈·기타)',
    /tg-cat"><td>더 플렌더/.test(tp) && /더 플렌더 MAX/.test(tp) && /<td class="tg-model">모엔즈<\/td>/.test(tp) && /<td class="tg-model">기타<\/td>/.test(tp) && tp.indexOf('미니 건조기') < 0);
  const T = ctx._tggTotals(), SEP = '\u0001';
  check('합계 — 9월 전체 48,490,000 · 연 50,285,000 · 모엔즈 합 46,695,000', T.all['2026-09'] === 48490000 && T.all.Y === 50285000 && T['vd' + SEP + '모엔즈'].Y === 46695000, T.all);
  check('합계 칸이 그려짐(전체 합계 연 합계)', el('tggall_Y').innerHTML === '50,285,000');
  ctx._tggSetField('qty');
  check('목표수량 보기 — 9월 110', ctx._tggTotals().all['2026-09'] === 110);
  ctx._tggSetField('amount');
  const ri = X.TGG.rows.findIndex(r => r.kind === 'vendor' && r.vendor === '모엔즈' && r.model === '더 플렌더 MAX');
  ctx._tggInput({ dataset: { r: String(ri), m: '8' }, value: '50,000,000', classList: { toggle() {} } });
  check('칸 수정 → 고친 칸 1개, 합계 즉시 갱신', /고친 칸 1개/.test(el('tggDirty').innerHTML) && ctx._tggTotals().all['2026-09'] === 53590000);
  // 붙여넣기 — 모엔즈 더 플렌더 MAX 10월부터 두 칸, 아래 벤더(기타) 줄
  ctx._tggPaste({ clipboardData: { getData: () => '1000\t2000\n300\t400\n' }, preventDefault() {} }, { dataset: { r: String(ri), m: '9' } });
  const ed = X.TGG.edits, k = (v, m) => 'amount' + SEP + v + SEP + '더플렌더' + SEP + '더 플렌더 MAX' + SEP + m;
  check('엑셀 붙여넣기 — 오른쪽(다음 달)·아래(보이는 벤더 줄)', ed[k('모엔즈', '2026-10')] === '1000' && ed[k('모엔즈', '2026-11')] === '2000' && ed[k('기타', '2026-10')] === '300', Object.keys(ed).length);
  X.TGG.newVendor = 'KLJ'; ctx._tggAddVendor();
  check('벤더 추가 → 모든 모델에 KLJ 줄', (page('admin-targets').match(/<td class="tg-model">KLJ<\/td>/g) || []).length >= 4);
  const n0 = F.calls.length;
  await ctx._tggSave(); await settle();
  const sv = F.calls.slice(n0).find(c => c.action === 'offline_saveGonguTargets');
  const svMax = sv && sv.data.items.find(x => x.vendor === '모엔즈' && x.ym === '2026-09');
  check('저장 = 바뀐 칸만(5칸), 고친 쪽(금액)만 — 수량 키 없음', sv && sv.data.items.length === 5 && J(svMax) === J({ ym: '2026-09', vendor: '모엔즈', line: '더플렌더', model: '더 플렌더 MAX', amount: '50000000' }), sv && sv.data.items);
  check('저장 후 다시 받음 — 시트 값 반영, 출처 input', X.TGG.data.items.find(x => x.vendor === '모엔즈' && x.ym === '2026-09' && x.model === '더 플렌더 MAX').amount === 50000000 && Object.keys(X.TGG.edits).length === 0);

  console.log('\n[9] [연간 보기] — 공동구매 줄 · 파트 합계(IN + 공동구매)');
  ctx._tgSetTab('annual'); await settle();
  tp = page('admin-targets');
  const A = ctx._tgaTotals();
  check('공동구매 줄(읽기 전용) — 9월 목표수량 110, 실적 = 공구 판매수량(100 + 10 + 3)', /tga-gongu-sep/.test(tp) && A.gongu['2026-09'].t === 110 && A.gongu['2026-09'].a === 113 + d9Sep, A.gongu['2026-09']);
  check('파트 합계(IN) = 전체 합계 + 공동구매', A.part['2026-09'].t === A.all['2026-09'].t + 110 && A.part.Y.t === A.all.Y.t + A.gongu.Y.t, { part: A.part['2026-09'], all: A.all['2026-09'] });
  ctx._tgaSet('side', 'OUT');
  check('OUT 쪽에는 파트 합계 줄 없음', page('admin-targets').indexOf('파트 합계 (IN + 공동구매)') < 0 && page('admin-targets').indexOf('tga-gongu-sep') >= 0);
  ctx._tgaSet('side', 'IN');
  ctx._tgaSetCh('himart'); await settle();
  check('채널 하나만 보면 공동구매 줄 없음', page('admin-targets').indexOf('tga-gongu-sep') < 0);
  ctx._tgaSetCh(''); await settle();

  console.log('\n[10] [이관] — 공구 목표 이관 카드');
  ctx._tgSetTab('migrate');
  check('공구 목표 이관 카드', /공구 목표 이관/.test(page('admin-targets')) && /'26년 목표 합' 탭은 쓰지 않습니다/.test(page('admin-targets')));
  await ctx._tgGongPreview(false); await settle();
  tp = page('admin-targets');
  check('미리보기 — 상품명 연결 표(제안) · 미매핑 안내', /상품명 연결/.test(tp) && /미매핑\(이관하지 않음\): 기타 특가세트/.test(tp) && /더플렌더 mini/.test(tp));
  check('대조 — 11월 다름, 1월 일치', /2026-11<\/td>[^]*?applying">다름/.test(tp) && /2026-01<\/td>[^]*?ready">일치/.test(tp));
  check('참고 — 마감 매출 vs 공구 시트 실적 표(9월 공구 실적 = 48,790,000)', /원본 마감 매출/.test(tp) && /2026-09<\/td><td class="num-col"><\/td><td class="num-col">48,790,000/.test(tp));
  ctx._tgGongSetLine('특가세트', '더플렌더'); ctx._tgGongSetModel('특가세트', '더 플렌더 MAX');
  await ctx._tgGongPreview(true); await settle();
  tp = page('admin-targets');
  check('매핑으로 다시 계산 → 대조 전부 일치', (tp.match(/applying">다름/g) || []).length === 0 && (tp.match(/ready">일치/g) || []).length >= 12);
  await ctx._tgGongApply();
  check('반영은 두 번 눌러야 — 첫 번째는 확인 버튼(10행 중 [공구 목표]에서 입력한 2칸과 겹치는 2행 제외 = 8행)', /반영 확인 — 8행 쓰기/.test(page('admin-targets')) && !F.calls.some(c => c.action === 'offline_migrateGonguTargets' && c.data.mode === 'apply'));
  await ctx._tgGongApply(); await settle();
  const gt = dataRows(g.tab('공구목표_월'));
  const inp = (ym, v) => gt.find(r => r[7] === 'input' && r[0] === ym && r[1] === v && r[4] === '더 플렌더 MAX');
  check('반영 → migration 8행, input 행 보존(9월 50,000,000 · 겹친 10월 모엔즈 1,000 · 11월 기타 400 그대로)', gt.filter(r => r[7] === 'migration').length === 8 &&
    inp('2026-09', '모엔즈')[6] === 50000000 && inp('2026-10', '모엔즈')[6] === 1000 && inp('2026-11', '기타')[6] === 400, gt.length);
  check('반영 결과 안내(입력값 보존 2)', /반영 완료 — 8행 쓰기/.test(page('admin-targets')) && /입력값 보존으로 건너뜀 2/.test(page('admin-targets')));

  console.log('\n[11] 임베드(?embed=1) — 파트 홈이 그려지고 이동해도 embed 유지');
  {
    const E = front(g, { search: '?embed=1', runHeadScripts: true });
    E.X.DATA.splice(0, E.X.DATA.length, ...deals(E.ctx));
    E.X.HOME.ym = '2026-09';
    E.ctx.navPage('home', null); await settle();
    check('임베드 모드 + 파트 홈 섹션', E.X.IS_EMBED === true && /① 파트 실적/.test(E.page('home')) && /home-hero/.test(E.page('home')));
    E.ctx._homeGoInventory();
    check('파트 홈에서 이동해도 ?embed=1 유지', /\?embed=1#offline\/inventory$/.test(E.ctx.history._urls[E.ctx.history._urls.length - 1]), E.ctx.history._urls.slice(-1));
    check('콘솔 에러 없음(임베드)', E.errors.length === 0, E.errors);
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})();
