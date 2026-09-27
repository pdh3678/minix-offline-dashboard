/* 사이드바·라우팅 구조(0단계, 2026-09-25) 검증.

   지키려는 성질:
     · 사이드바 메뉴 순서·이름·그룹 중첩이 확정안과 같다(파트 홈 / 오프라인 / 공동구매 / 대시보드 관리 / 월 회고)
     · '새 공구건 등록'은 사이드바에서 빠졌다(페이지 버튼으로 대체)
     · 그룹 접기 상태가 localStorage에 저장·복원되고, 접힌 그룹 안의 현재 페이지는 화면에서만 펼쳐 보인다
     · 기존 해시는 하나도 바뀌지 않았다(워크스페이스 iframe 미러링) + 신규 해시가 각 페이지로 간다
     · 해시 없음/모르는 해시는 #home, #offline/channel/{id}는 채널 상세로, #gongu/new는 캘린더+등록 모달
     · 모든 신규 페이지가 ?embed=1을 유지한다

   실행: node tests/nav-structure.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadFrontend, readFrontSource } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));

const PROJ = process.argv[2] || path.join(__dirname, '..');
const html = readFrontSource(PROJ);
const SHIM = `
  get PAGE_ID_TO_HASH(){return PAGE_ID_TO_HASH;},
  get pageParam(){return _pageParam;},
  get currentPageHash(){return _currentPageHash;}`;

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
// 클래스 목록이 실제로 동작하는 가짜 요소
function fakeEl(extra) {
  const s = new Set();
  return Object.assign({
    classList: { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c),
      toggle(c, on) { const want = on === undefined ? !s.has(c) : !!on; want ? s.add(c) : s.delete(c); return want; } },
    dataset: {}, style: {}, textContent: ''
  }, extra || {});
}

(async () => {
  console.log('\n[1] 앱 이름');
  check('<title>이 새 이름', html.indexOf('<title>미닉스 오프라인&amp;특수파트 대시보드</title>') >= 0);
  check('상단 헤더가 새 이름', html.indexOf('<div class="hdr-title">미닉스 오프라인&amp;특수파트 대시보드</div>') >= 0);
  check('옛 헤더 문구가 남아있지 않음', html.indexOf('미닉스 공구 관리') < 0 && html.indexOf('공동구매 대시보드 <span>Minix</span>') < 0);

  console.log('\n[2] 사이드바 순서·이름·그룹');
  const nav = html.slice(html.indexOf('<nav class="sb-nav">'), html.indexOf('</nav>'));
  const seq = [...nav.matchAll(/data-sec="([^"]+)"|data-page="([^"]+)"|<span class="sb-label">([^<]+)<\/span>/g)]
    .map(m => m[1] ? 'sec:' + m[1] : m[2] ? 'page:' + m[2] : m[3]);
  const EXPECT = [
    'page:home', '파트 홈',
    'sec:offline', '오프라인',
    'page:offline-channels', '채널 현황', 'page:offline-channel', '채널 상세', 'page:offline-inventory', '재고 현황',
    'sec:gongu', '공동구매',
    'page:calendar', '공구 캘린더', 'page:dashboard', '공구 분석',
    'sec:gongu-products', '품목별 실적',
    'page:review', '공동구매 회고', 'page:management', '미기입 목록',
    'sec:admin', '대시보드 관리',
    'page:admin-upload', '데이터 업로드', 'page:admin-code-mapping', '코드 매핑', 'page:admin-targets', '목표 관리',
    'page:monthly-review', '월 회고'
  ];
  check('메뉴 순서·이름이 확정안과 같음', JSON.stringify(seq) === JSON.stringify(EXPECT), seq);
  const at = s => nav.indexOf(s);
  check('품목별 실적은 공동구매 그룹 안의 하위 그룹',
    at('data-sec="gongu"') < at('data-sec="gongu-products"') && at('data-sec="gongu-products"') < at('data-sec="admin"') &&
    /class="sb-sec sb-sub" data-sec="gongu-products"/.test(nav));
  check('품목 항목은 여전히 PRODUCT_LINES에서 생성(#sbProductItems)', nav.indexOf('id="sbProductItems"') > at('data-sec="gongu-products"'));
  check("'새 공구건 등록'이 사이드바에 없음", nav.indexOf('새 공구건 등록') < 0 && nav.indexOf('openDealForm') < 0);
  check('미기입 목록 옆 배지 자리가 있고 기본은 숨김', /data-page="management"[^\n]*id="sbPendingBadge" style="display:none"/.test(nav));
  check('하단 영역(연동 시트·접속자·로그아웃)은 그대로',
    html.indexOf('<span class="sb-label">연동 시트</span>') > 0 && html.indexOf('id="presenceCount"') > 0 && html.indexOf('onclick="signOut()"') > 0);

  console.log('\n[3] 라우터 표와 마크업이 서로 맞음');
  const { ctx: c0, X: X0 } = loadFrontend(PROJ, SHIM);
  const pages = Object.keys(X0.PAGE_ID_TO_HASH);
  pages.forEach(p => {
    check(`#page-${p} 컨테이너가 있음`, html.indexOf(`id="page-${p}"`) > 0);
    check(`  ↳ 사이드바에 data-page="${p}" 항목이 있음`, nav.indexOf(`data-page="${p}"`) > 0);
  });
  const OLD = { calendar: 'calendar', dashboard: 'dashboard', management: 'entry-list', review: 'review' };
  check('기존 해시 4종이 그대로(워크스페이스 미러링)', Object.keys(OLD).every(p => X0.PAGE_ID_TO_HASH[p] === OLD[p]), X0.PAGE_ID_TO_HASH);

  console.log('\n[4] 해시 → 페이지 (임베드 상태로)');
  const ROUTES = [
    ['', 'page:home'], ['nope', 'page:home'], ['sales', 'page:home'], ['home', 'page:home'],
    ['offline/channels', 'page:offline-channels'], ['offline/channel', 'page:offline-channel'],
    ['offline/channel/ch-001', 'page:offline-channel|ch-001'], ['offline/inventory', 'page:offline-inventory'],
    ['admin/upload', 'page:admin-upload'], ['admin/code-mapping', 'page:admin-code-mapping'], ['admin/targets', 'page:admin-targets'],
    ['monthly-review', 'page:monthly-review'],
    // 기존 해시 — 개명된 페이지도 해시는 그대로
    ['calendar', 'page:calendar'], ['dashboard', 'page:dashboard'], ['review', 'page:review'], ['entry-list', 'page:management'],
    ['product-TheFlender', 'sales:플렌더'], ['product-TheShift', 'sales:시프트'], ['product-TheSlim', 'sales:슬림'], ['product-TheAirDry', 'sales:에어드라이'],
    ['new-deal', 'form'], ['gongu/new', 'page:calendar>form(gongu/new)']
  ];
  ROUTES.forEach(([hash, expect]) => {
    const { ctx } = loadFrontend(PROJ, SHIM, { search: '?embed=1', runHeadScripts: true });
    const trail = [];
    ctx.navPage = (pageId, el, param) => trail.push('page:' + pageId + (param ? '|' + param : ''));
    ctx.navSales = (el, prod) => trail.push('sales:' + prod);
    ctx.openDealForm = o => trail.push('form' + (o && o.hash ? '(' + o.hash + ')' : ''));
    ctx.location.hash = hash ? '#' + hash : '';
    ctx._routeFromHash();
    check('#' + (hash || '(없음)') + ' → ' + expect, trail.join('>') === expect, trail);
  });

  console.log('\n[5] 실제 navPage — 주소 기록과 파라미터, 임베드 유지');
  {
    const { ctx, X } = loadFrontend(PROJ, SHIM, { search: '?embed=1', runHeadScripts: true });
    const last = () => ctx.history._urls[ctx.history._urls.length - 1];
    ['home', 'offline-channels', 'offline-inventory', 'admin-upload', 'admin-code-mapping', 'admin-targets', 'monthly-review'].forEach(p => {
      ctx.navPage(p, null);
      check(`${p} → /?embed=1#${X.PAGE_ID_TO_HASH[p]}`, last() === '/?embed=1#' + X.PAGE_ID_TO_HASH[p], last());
    });
    ctx.navPage('offline-channel', null, 'ch-001');
    check('채널 상세 + 파라미터 → #offline/channel/ch-001', last() === '/?embed=1#offline/channel/ch-001', last());
    check('  ↳ _pageParam에 채널 id가 남음', X.pageParam === 'ch-001', X.pageParam);
    check('  ↳ 모달을 닫으면 돌아올 해시도 파라미터 포함', X.currentPageHash === 'offline/channel/ch-001', X.currentPageHash);
    ctx.navPage('offline-channel', null);
    check('파라미터 없이 다시 들어오면 파라미터가 지워짐', X.pageParam === null && last() === '/?embed=1#offline/channel', last());
  }

  console.log('\n[6] 그룹 접기 상태 저장·복원');
  {
    const { ctx } = loadFrontend(PROJ, SHIM);
    const sec = fakeEl(); sec.dataset.sec = 'offline';
    const btn = { parentElement: sec };
    ctx.toggleSec(btn);
    check('접으면 closed 클래스', sec.classList.contains('closed'));
    check('  ↳ localStorage에 접은 그룹 키 저장', ctx.localStorage.getItem('gp_sb_closed') === '["offline"]', ctx.localStorage.getItem('gp_sb_closed'));
    const sub = fakeEl(); sub.dataset.sec = 'gongu-products';
    ctx.toggleSec({ parentElement: sub });
    ctx.toggleSec(btn); // 오프라인 다시 펼침
    check('펼치면 그 키만 빠짐', ctx.localStorage.getItem('gp_sb_closed') === '["gongu-products"]', ctx.localStorage.getItem('gp_sb_closed'));
    // 새로고침 후 복원 — 저장된 목록대로 closed가 붙는다
    const a = fakeEl(), b = fakeEl(); a.dataset.sec = 'offline'; b.dataset.sec = 'gongu-products'; b.classList.add('x');
    ctx.document.querySelectorAll = () => [a, b];
    ctx._applySbClosedState();
    check('복원: 저장된 그룹만 접힘', !a.classList.contains('closed') && b.classList.contains('closed'));
    ctx.localStorage.setItem('gp_sb_closed', '{깨진값');
    ctx._applySbClosedState();
    check('저장값이 깨져 있어도 전부 펼침으로 복구(예외 없음)', !a.classList.contains('closed') && !b.classList.contains('closed'));
  }

  console.log('\n[7] 접힌 그룹 안의 현재 페이지는 화면에서 펼쳐 보임(저장값은 그대로)');
  {
    const { ctx } = loadFrontend(PROJ, SHIM);
    const outer = fakeEl(), inner = fakeEl();
    outer.classList.add('closed'); inner.classList.add('closed');
    outer.parentElement = { closest: () => null };
    inner.parentElement = { closest: () => outer };
    const item = { closest: () => inner };
    ctx.localStorage.setItem('gp_sb_closed', '["gongu","gongu-products"]');
    ctx._sbRevealActive(item);
    check('하위 그룹·상위 그룹 모두 펼쳐짐', !inner.classList.contains('closed') && !outer.classList.contains('closed'));
    check('저장된 접기 상태는 바뀌지 않음', ctx.localStorage.getItem('gp_sb_closed') === '["gongu","gongu-products"]');
  }

  console.log('\n[8] 메뉴 배지');
  {
    const { ctx } = loadFrontend(PROJ, SHIM);
    const el = fakeEl();
    ctx.document.getElementById = id => (id === 'sbPendingBadge' ? el : null);
    ctx._setSbBadge('sbPendingBadge', 3);
    check('3건 → "3" 표시', el.textContent === '3' && el.style.display === '', el);
    ctx._setSbBadge('sbPendingBadge', 0);
    check('0건 → 숨김', el.style.display === 'none' && el.textContent === '', el);
  }

  console.log('\n[9] 신규 페이지 빈 틀 — 제목 + 준비 중 + 예정 내용 한 줄');
  {
    const vm = require('vm');
    const { scriptEntries } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
    const PLAN = {
      home: ['파트 홈', '공구+오프라인 통합 목표 대비 실적, 재고 경보 요약 (추후)'],
      'offline-channels': ['채널 현황', '채널별 달성률·재고일수·진열 점포 수 카드 (1~2단계)'],
      'offline-channel': ['채널 상세', '채널별 SKU Sell-in/Sell-out/재고 추이 (2단계)'],
      'offline-inventory': ['재고 현황', 'SKU × 채널 재고 분포와 경보 (2단계)'],
      'monthly-review': ['월 회고', '파트 전체 월간 회고, 공동구매 회고 편집기 재사용 (추후)']
    };
    const { ctx } = loadFrontend(PROJ, SHIM);
    const box = {};
    ctx.document.getElementById = id => (box[id] = box[id] || { innerHTML: '' });
    // 로드 시점엔 스텁 DOM에 그려졌으므로, 빈 틀 페이지 파일만 받아 적는 DOM 위에서 다시 실행한다(함수 호출뿐인 파일).
    // 실제 기능이 들어온 페이지(1단계 데이터 업로드·코드 매핑, 2-A 목표 관리)와 오프라인 공용 모듈은 빈 틀이 아니라서 제외한다 —
    // 그쪽은 최상위 const가 있어 같은 컨텍스트에서 두 번 실행할 수도 없다(offline-ui.test.js가 따로 검증).
    const NOT_PLACEHOLDER = /^src\/features\/(offline\/(parsers|resolver|sheetjs|api|common)|admin\/(mapping-panel|upload|code-mapping|targets))\.js$/;
    const files = scriptEntries(PROJ).filter(e => /^src\/features\/(home|offline|admin|monthly-review)\//.test(e.name) && !NOT_PLACEHOLDER.test(e.name));
    check('빈 틀 페이지 파일 ' + Object.keys(PLAN).length + '개가 index.html에 실림', files.length === Object.keys(PLAN).length, files.map(f => f.name));
    files.forEach(f => vm.runInContext(f.code, ctx, { filename: f.name }));
    Object.keys(PLAN).forEach(p => {
      const h = (box['page-' + p] || {}).innerHTML || '';
      check(`${PLAN[p][0]}: 제목·준비 중·예정 내용`, h.indexOf('<div class="card-hd">' + PLAN[p][0] + '</div>') >= 0 &&
        h.indexOf('준비 중') > 0 && h.indexOf('예정: ' + PLAN[p][1].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')) > 0, h);
    });
    const order = scriptEntries(PROJ).filter(e => e.kind === 'file').map(e => e.name);
    check('main.js는 여전히 맨 마지막', order[order.length - 1] === 'src/main.js', order.slice(-3));
    check('폴더 구조: features/home·offline·gongu·admin·monthly-review, shared',
      ['src/features/home/', 'src/features/offline/', 'src/features/gongu/', 'src/features/admin/', 'src/features/monthly-review/', 'src/shared/']
        .every(dir => order.some(n => n.indexOf(dir) === 0)));
    check('품목 상수는 src/shared/constants/ 에 있음', order.indexOf('src/shared/constants/products.js') >= 0);
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})();
