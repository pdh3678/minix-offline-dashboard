/* 품목군(제품 라인) 배선 검증 — 배포되는 index.html의 인라인 스크립트를 그대로 실행해서,
   "PRODUCT_LINES 상수 한 곳만 고치면 사이드바·해시 라우팅·품목군 드롭다운이 전부 따라오는지"를
   확인한다. 예전엔 이 셋이 HTML에 각각 하드코딩돼 있어서, 실제로 더 슬림이 모달 드롭다운에만
   있고 사이드바에는 없는 상태로 배포돼 있었다 — 그 재발을 막는 게 이 스위트의 목적이다.

   사은품 목록은 프론트(index.html)와 GAS(apps-script.js)에 같은 값이 두 벌 있어야 하는 구조라,
   두 파일에서 각각 읽어 와 서로 어긋나지 않는지도 함께 본다.

   실행: node tests/product-line.test.js  (또는 node tests/run-all.js) */
const fs = require('fs');
const path = require('path');
const { loadFrontend, readFrontSource } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));

const PROJ = process.argv[2] || path.join(__dirname, '..');
const SHIM = `
  get PRODUCT_LINES(){return PRODUCT_LINES;},
  get PRODUCT_TAXONOMY(){return PRODUCT_TAXONOMY;},
  get PRODUCT_LINE_LABELS(){return PRODUCT_LINE_LABELS;},
  get PRODUCT_GROUP_LABELS(){return PRODUCT_GROUP_LABELS;},
  get PRODUCT_COLORS(){return PRODUCT_COLORS;},
  get PRODUCT_SHEET_NAME(){return PRODUCT_SHEET_NAME;},
  get ST_PRODUCT_TO_HASH(){return ST_PRODUCT_TO_HASH;},
  get HASH_PRODUCT_TO_ST(){return HASH_PRODUCT_TO_ST;},
  get LINE_HAS_MODELS(){return LINE_HAS_MODELS;},
  get LINE_MODEL_OPTIONS(){return LINE_MODEL_OPTIONS;},
  get PRODUCT_MODEL_TABS(){return PRODUCT_MODEL_TABS;},
  get GIFT_ITEMS(){return GIFT_ITEMS;},
  get PRODUCT_CATALOG(){return PRODUCT_CATALOG;},
  get ST(){return ST;}`;

let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

// 더 슬림은 "세부 모델이 없는 단일 제품" 라인이라, 모델이 있는 라인과 다른 경로를 탄다.
const SLIM = { key: '더슬림', st: '슬림', slug: 'TheSlim', label: '더 슬림' };
const EXPECTED_ORDER = ['더플렌더', '더시프트', '더슬림', '더에어드라이'];
const SLIM_GIFTS = ['더 슬림 먼지봉투(3개입)', '더 슬림 헤파필터', '더 슬림 스테이션 헤파필터',
                    '더 슬림 배터리', '더 슬림 브러쉬롤러'];

/* _renderProductNav/_renderLineOptions는 document에 직접 그린다. 샌드박스의 기본 DOM 스텁은
   innerHTML을 삼켜버리므로, 잠시 "받아 적는" 엘리먼트로 갈아끼워 실제 생성 결과를 본다. */
function captureRender(ctx, fn) {
  const box = {};
  const orig = ctx.document.getElementById;
  ctx.document.getElementById = id => (box[id] = box[id] || { innerHTML: '', title: '' });
  try { fn(); } finally { ctx.document.getElementById = orig; }
  return box;
}

(async () => {
  const { ctx, X } = loadFrontend(PROJ, SHIM);

  console.log('\n[1] PRODUCT_LINES — 품목군 정의가 한 배열에 모여 있고 순서가 곧 화면 순서');
  const lines = X.PRODUCT_LINES;
  check('PRODUCT_LINES가 배열로 정의됨', Array.isArray(lines) && lines.length >= 4, lines && lines.length);
  check('순서가 더 플렌더 → 더 시프트 → 더 슬림 → 더 에어드라이',
    JSON.stringify(lines.map(l => l.key)) === JSON.stringify(EXPECTED_ORDER), lines.map(l => l.key));
  const slim = lines.find(l => l.key === SLIM.key);
  check('더 슬림 항목이 있음', !!slim);
  check('더 슬림의 st/slug/label이 규칙대로',
    slim && slim.st === SLIM.st && slim.slug === SLIM.slug && slim.label === SLIM.label, slim);
  check('모든 라인에 아이콘이 있음', lines.every(l => !!l.icon), lines.map(l => l.icon));
  ['key', 'st', 'slug', 'label'].forEach(f => {
    const vals = lines.map(l => l[f]);
    check(`${f} 값이 서로 겹치지 않음`, new Set(vals).size === vals.length, vals);
  });
  check('slug는 전부 ASCII (한글 슬러그는 퍼센트 인코딩돼 읽을 수 없어짐)',
    lines.every(l => /^[A-Za-z0-9_-]+$/.test(l.slug)), lines.map(l => l.slug));
  // 라인 키는 PRODUCT_TAXONOMY의 line 값과 반드시 같은 이름이어야 집계가 이어진다
  const taxLines = new Set(X.PRODUCT_TAXONOMY.map(t => t.line));
  check('모든 라인이 PRODUCT_TAXONOMY에 세부 모델을 최소 1개 가짐',
    lines.every(l => taxLines.has(l.key)), [...taxLines]);

  console.log('\n[2] 파생 상수가 전부 PRODUCT_LINES 하나를 따라감');
  check('PRODUCT_LINE_LABELS 순서 = PRODUCT_LINES 순서(+맨 뒤 other)',
    JSON.stringify(Object.keys(X.PRODUCT_LINE_LABELS)) === JSON.stringify(EXPECTED_ORDER.concat('other')),
    Object.keys(X.PRODUCT_LINE_LABELS));
  check('PRODUCT_LINE_LABELS["더슬림"] = "더 슬림"', X.PRODUCT_LINE_LABELS[SLIM.key] === SLIM.label);
  check('ST_PRODUCT_TO_HASH["슬림"] = "TheSlim"', X.ST_PRODUCT_TO_HASH[SLIM.st] === SLIM.slug, X.ST_PRODUCT_TO_HASH);
  check('HASH_PRODUCT_TO_ST["TheSlim"] = "슬림"', X.HASH_PRODUCT_TO_ST[SLIM.slug] === SLIM.st);
  check('과거 한글 슬러그(#product-더슬림)도 계속 받아줌', X.HASH_PRODUCT_TO_ST[SLIM.key] === SLIM.st);
  lines.forEach(l => {
    check(`${l.label}: 표준 슬러그와 한글 별칭이 둘 다 매핑됨`,
      X.HASH_PRODUCT_TO_ST[l.slug] === l.st && X.HASH_PRODUCT_TO_ST[l.key] === l.st);
  });
  check('슬러그 조회는 대소문자 무시(theslim)', ctx._productFromHashSlug('theslim') === SLIM.st);
  check('모르는 슬러그는 null', ctx._productFromHashSlug('TheNope') === null);

  console.log('\n[3] 사이드바 "품목별 실적" 메뉴가 상수에서 생성됨');
  const navBox = captureRender(ctx, () => ctx._renderProductNav());
  const navHtml = navBox.sbProductItems.innerHTML;
  const navProds = [...navHtml.matchAll(/data-prod="([^"]+)"/g)].map(m => m[1]);
  check('사이드바 항목 = PRODUCT_LINES 순서',
    JSON.stringify(navProds) === JSON.stringify(lines.map(l => l.st)), navProds);
  check('더 슬림이 더 시프트와 더 에어드라이 사이에 있음',
    navProds.indexOf('시프트') < navProds.indexOf(SLIM.st) &&
    navProds.indexOf(SLIM.st) < navProds.indexOf('에어드라이'), navProds);
  check('더 슬림 항목이 navSales("슬림")을 호출함', navHtml.includes(`navSales(this,'${SLIM.st}')`));
  check('더 슬림 라벨과 아이콘이 함께 렌더됨',
    navHtml.includes('>' + SLIM.label + '<') && navHtml.includes('>' + slim.icon + '<'));
  check('HTML에 품목이 하드코딩돼 남아있지 않음',
    !readFrontSource(PROJ)
      .includes(`<div class="sb-item" data-prod="플렌더"`));

  console.log('\n[4] 등록/수정 모달의 품목군 드롭다운도 같은 상수에서 생성됨');
  const selBox = captureRender(ctx, () => ctx._renderLineOptions());
  ['mLine', 'fLine'].forEach(id => {
    const html = selBox[id].innerHTML;
    const vals = [...html.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
    check(`${id}: 첫 옵션은 빈 값(선택)`, vals[0] === '' && html.includes('>선택<'), vals);
    check(`${id}: 품목군 순서 = PRODUCT_LINES 순서`,
      JSON.stringify(vals.slice(1)) === JSON.stringify(EXPECTED_ORDER), vals);
    check(`${id}: 더 슬림 옵션이 value="더슬림" / 표시 "더 슬림"`,
      html.includes('<option value="더슬림">더 슬림</option>'));
  });

  console.log('\n[5] 더 슬림은 세부 모델이 없는 단일 제품');
  check('LINE_HAS_MODELS에 더슬림이 없음(제품 드롭다운이 안 뜸)', !X.LINE_HAS_MODELS[SLIM.key], X.LINE_HAS_MODELS);
  check('LINE_MODEL_OPTIONS에도 더슬림이 없음', X.LINE_MODEL_OPTIONS[SLIM.key] === undefined);
  check('PRODUCT_MODEL_TABS에 슬림이 없어 모델 탭줄이 숨겨짐', X.PRODUCT_MODEL_TABS[SLIM.st] === undefined,
    Object.keys(X.PRODUCT_MODEL_TABS));
  // 모델이 없는 라인은 라인 키 자체가 제품명으로 저장된다 — 시트 표기로 반드시 번역돼야 함
  check('toSheetProductName("더슬림") = "더 슬림"(시트 데이터 확인 규칙 표기)',
    ctx.toSheetProductName(SLIM.key) === SLIM.label, ctx.toSheetProductName(SLIM.key));
  check('PRODUCT_SHEET_NAME 표기에 앞뒤 공백이 없음',
    Object.values(X.PRODUCT_SHEET_NAME).every(v => v === v.trim()));

  console.log('\n[6] 배지 색 / 제품 분류');
  check('productColorKey("더 슬림") = "슬림"(공백 표기)', ctx.productColorKey('더 슬림') === SLIM.st);
  check('productColorKey("더슬림") = "슬림"(내부 표기)', ctx.productColorKey(SLIM.key) === SLIM.st);
  check('productLineKey("더 슬림") = "더슬림"', ctx.productLineKey('더 슬림') === SLIM.key);
  check('PRODUCT_GROUP_LABELS["슬림"] = "더 슬림"', X.PRODUCT_GROUP_LABELS[SLIM.st] === SLIM.label);
  const slimColor = ctx.productColor('더 슬림');
  check('더 슬림 배지 색이 기타(other) 폴백이 아님',
    slimColor.bg !== X.PRODUCT_COLORS.other.bg, slimColor);
  const pairs = Object.entries(X.PRODUCT_COLORS).map(([k, c]) => [k, c.bg + '/' + c.fg]);
  check('모든 제품 배지 색 조합이 서로 구분됨',
    new Set(pairs.map(p => p[1])).size === pairs.length, pairs);

  console.log('\n[7] 품목별 실적 필터링 — 더 슬림만 걸러짐');
  const rows = [
    { product: '더 슬림' }, { product: '더슬림' }, { product: '더 플렌더 PRO' },
    { product: '더 시프트' }, { product: '더 에어드라이' }
  ];
  X.ST.prod = SLIM.st; X.ST.model = 'all';
  check('ST.prod="슬림"이면 더 슬림 행만 남음',
    ctx.filteredProd(rows).length === 2, ctx.filteredProd(rows).map(r => r.product));
  X.ST.prod = '에어드라이';
  check('다른 품목 페이지에는 더 슬림이 섞이지 않음',
    ctx.filteredProd(rows).every(r => r.product !== '더 슬림'));
  X.ST.prod = 'all';
  check('전체에는 더 슬림도 포함', ctx.filteredProd(rows).length === rows.length);

  console.log('\n[8] 사은품 — 더 슬림용 5종');
  const gifts = X.GIFT_ITEMS;
  SLIM_GIFTS.forEach(g => check(`GIFT_ITEMS에 "${g}" 포함`, gifts.includes(g)));
  check('사은품 표기에 앞뒤 공백이 없음', gifts.every(g => g === g.trim()),
    gifts.filter(g => g !== g.trim()));
  check('사은품 목록에 중복이 없음', new Set(gifts).size === gifts.length);
  // 사은품 1·2·3 드롭다운은 전부 이 함수 하나를 거치므로, 여기 있으면 세 칸 모두에 반영된다
  const giftHtml = ctx._giftItemOptionsHtml();
  check('사은품 드롭다운 옵션에 5종이 모두 들어감', SLIM_GIFTS.every(g => giftHtml.includes(`>${g}<`)));
  check('사은품 드롭다운 첫 옵션은 "없음"', giftHtml.indexOf('<option value="">없음</option>') === 0);
  // 선착순 품목 드롭다운도 같은 함수를 쓴다(따로 관리되지 않는지 확인)
  check('선착순 품목 드롭다운도 같은 목록을 씀', ctx._giftItemOptionsHtml() === giftHtml);

  console.log('\n[9] 프론트 GIFT_ITEMS와 GAS GIFT_ITEMS가 어긋나지 않음');
  const gas = fs.readFileSync(path.join(PROJ, 'apps-script.js'), 'utf8');
  const gasList = gas.match(/var GIFT_ITEMS = \[([\s\S]*?)\];/);
  check('apps-script.js에서 GIFT_ITEMS를 찾음', !!gasList);
  const gasItems = gasList ? [...gasList[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];
  check('두 파일의 사은품 목록이 순서까지 동일',
    JSON.stringify(gasItems) === JSON.stringify(gifts), { gas: gasItems, front: gifts });
  const aliasBlock = gas.match(/var GIFT_ITEM_ALIASES = \{([\s\S]*?)\n\};/);
  check('GIFT_ITEM_ALIASES에 모든 사은품이 등록돼 있음',
    !!aliasBlock && gasItems.every(it => aliasBlock[1].includes(`'${it}':`)),
    gasItems.filter(it => aliasBlock && !aliasBlock[1].includes(`'${it}':`)));

  console.log('\n[10] 해시 라우팅 — #product-TheSlim (임베드 포함)');
  const embed = loadFrontend(PROJ, SHIM, { search: '?embed=1', runHeadScripts: true });
  check('임베드 모드로 로드됨', embed.X.IS_EMBED === true);
  embed.ctx.location.hash = '#product-' + SLIM.slug;
  embed.ctx._routeFromHash();
  check('#product-TheSlim → 품목별 실적(더 슬림)이 열림', embed.X.ST.prod === SLIM.st, embed.X.ST.prod);
  check('모델 탭은 전체(all)로 시작', embed.X.ST.model === 'all');
  const urls = embed.ctx.history._urls;
  check('주소가 #product-TheSlim으로 정리됨',
    urls.length > 0 && urls[urls.length - 1].endsWith('#product-' + SLIM.slug), urls.slice(-1));
  check('임베드 쿼리(?embed=1)가 보존됨',
    urls.length > 0 && urls[urls.length - 1].includes('?embed=1'), urls.slice(-1));
  // 예전 한글 링크로 들어와도 같은 페이지가 열려야 한다(북마크 호환)
  embed.ctx.location.hash = '#product-' + SLIM.key;
  embed.X.ST.prod = 'all';
  embed.ctx._routeFromHash();
  check('과거 한글 해시(#product-더슬림)도 같은 페이지로', embed.X.ST.prod === SLIM.st);

  console.log('\n[11] 신규 등록 왕복 — 더 슬림 + 사은품1 "더 슬림 헤파필터"가 시트에 그대로 남는지');
  {
    /* 프론트의 saveDeal()을 끝까지 실행하고, HTTP만 생략한 채 진짜 GAS 핸들러에 연결한다
       (save-path.test.js와 같은 방식). 제품명은 내부 표기 '더슬림'으로 폼에 들어가서
       시트 표기 '더 슬림'으로 저장돼야 하고, 사은품은 헤더 기반으로 제 열에 들어가야 한다. */
    const vm = require('vm');
    const { makeSheet, installGlobals } = require(path.join(__dirname, 'lib', 'mock-sheets.js'));
    const HEADERS = require(path.join(__dirname, 'lib', 'real-headers.js'));
    const sheet = makeSheet('실적통합', [new Array(HEADERS.length).fill(''), HEADERS.slice()]);
    installGlobals({ '실적통합': sheet }, {});
    const gas = vm.createContext(global);
    vm.runInContext(fs.readFileSync(path.join(PROJ, 'apps-script.js'), 'utf8'), gas, { filename: 'apps-script.js' });

    const { ctx: f, X: FX } = loadFrontend(PROJ, SHIM);
    const vals = {
      fLine: SLIM.key, fModel: '', fInfluencer: '슬림채널', fPlatform: '인스타그램',
      fIgId: 'slim.ch', fMonth: '9', fStart: '2026-09-20', fEnd: '2026-09-25',
      fSalePrice: '29000', fCommission: '10', fYear: '2026'
    };
    const els = {};
    f.document.getElementById = id => (els[id] = els[id] || {
      id, value: vals[id] != null ? vals[id] : '', style: {}, textContent: '', innerHTML: '',
      classList: { add(){}, remove(){}, contains: () => false },
      closest: () => ({ querySelector: () => null, appendChild(){} }),
      parentElement: { querySelector: () => null, appendChild(){} },
      querySelectorAll: () => [], querySelector: () => null, appendChild(){}, focus(){}, remove(){}
    });
    f.document.querySelectorAll = () => [];
    FX.setFormState({ codes: ['SLIM1'], gifts: [{ item: '더 슬림 헤파필터', qty: '300' }] });
    // 실제 폼에서는 사은품을 고르는 순간 이 함수가 '구성' 칸을 다시 만든다(읽기전용 칸이라 이 경로뿐)
    f.fRecalcComposition();
    const reqs = [];
    f._getGasUrl = () => 'https://example.test/exec';
    f._gasWrite = async (url, action, data) => {
      reqs.push({ action, data });
      return JSON.parse(gas._handleWriteAction({ parameter: { action, payload: JSON.stringify(data) } }, ''));
    };
    f.closeDealForm = () => {}; f.render = () => {}; f.showToast = () => {}; f.setLoad = () => {};

    let threw = null;
    try { await f.saveDeal(); } catch (e) { threw = e; }
    await new Promise(r => setTimeout(r, 30));
    check('saveDeal이 예외 없이 완료', threw === null, threw && threw.message);
    check('addSalesRow 요청이 1회', reqs.length === 1 && reqs[0].action === 'addSalesRow',
      reqs.map(r => r.action));
    const sentProduct = reqs.length ? reqs[0].data.product : null;
    check('요청의 제품명이 시트 표기 "더 슬림"(내부 표기 그대로 나가면 데이터 확인 규칙 위반)',
      sentProduct === SLIM.label, sentProduct);
    check('요청에 사은품1이 실림', reqs.length && reqs[0].data.giftItem1 === '더 슬림 헤파필터',
      reqs.length && reqs[0].data.giftItem1);

    // 시트에 실제로 쓰인 값을 GAS의 헤더 기반 파서로 다시 읽어 확인한다
    const back = gas.parseMainSheet(sheet).deals.filter(d => d.channel === '슬림채널');
    check('시트에 1건 기록됨', back.length === 1, back.length);
    const row = back[0] || {};
    check('시트 C열 제품명 = "더 슬림"', row.product === SLIM.label, row.product);
    check('시트 사은품 품목1(AU열) = "더 슬림 헤파필터"', row.giftItem1 === '더 슬림 헤파필터', row.giftItem1);
    check('사은품 수량1도 함께 기록됨', String(row.giftQty1) === '300', row.giftQty1);
    check('구성 문구에 사은품이 조합됨',
      typeof row.composition === 'string' && row.composition.includes('더 슬림 헤파필터'), row.composition);
    // 저장된 제품명이 화면 쪽 분류로 되돌아오는지(왕복 일관성)
    check('되읽은 제품명이 다시 슬림 품목으로 분류됨', f.productColorKey(row.product) === SLIM.st);
    check('되읽은 제품명의 배지 색이 더 슬림 색', f.productColor(row.product).bg === slimColor.bg);
  }

  console.log('\n[12] 품목 카탈로그 — 오프라인용 품목은 카탈로그에만, 공구 화면은 전과 동일');
  {
    const cat = X.PRODUCT_CATALOG;
    check('PRODUCT_CATALOG가 배열로 정의됨', Array.isArray(cat) && cat.length >= 6, cat && cat.length);
    check('모든 품목군·모델에 gongu 속성이 boolean으로 명시됨',
      cat.every(l => typeof l.gongu === 'boolean' && l.models.every(m => typeof m.gongu === 'boolean')));
    const lineByLabel = lb => cat.find(l => l.label === lb);
    ['미니 건조기', '미니 식기세척기'].forEach(lb => {
      const l = lineByLabel(lb);
      check(`카탈로그에 품목군 '${lb}'가 있음(공구 비노출)`, !!l && l.gongu === false, l);
      check(`  ↳ '${lb}'는 사이드바·드롭다운·해시에 없음`,
        l && !X.PRODUCT_LINES.some(p => p.key === l.key) && X.HASH_PRODUCT_TO_ST[l.key] === undefined &&
        X.PRODUCT_LINE_LABELS[l.key] === undefined);
    });
    const plus = lineByLabel('더 플렌더').models.find(m => m.label === '더 플렌더 PLUS');
    check("더 플렌더 하위에 'PLUS' 모델이 있음(공구 비노출)", !!plus && plus.gongu === false, plus);
    check('  ↳ PLUS는 모델 탭에 없음',
      JSON.stringify(X.PRODUCT_MODEL_TABS['플렌더'].tabs.map(t => t.m)) === JSON.stringify(['all', 'PRO', 'MAX', 'mini', 'NEXT']),
      X.PRODUCT_MODEL_TABS['플렌더'].tabs);
    check('  ↳ PLUS는 등록 폼 제품 드롭다운에 없음',
      JSON.stringify(X.LINE_MODEL_OPTIONS['더플렌더']) === JSON.stringify(['더플렌더PRO', '더플렌더MAX', '더플렌더mini', '더플렌더NEXT']),
      X.LINE_MODEL_OPTIONS['더플렌더']);
    check('  ↳ PLUS는 배지 색/집계 키(PRODUCT_TAXONOMY)에 없음', !X.PRODUCT_TAXONOMY.some(t => t.key === plus.key));
    // 2026-09-27 오프라인 코드 매핑용 모델 추가 — 전부 공구 비노출, 파생 상수에 섞이면 안 된다
    const modelLabels = lb => lineByLabel(lb).models.map(m => m.label);
    check('더 플렌더 모델 6개: Basic, PRO, MAX, mini, NEXT, PLUS',
      JSON.stringify(modelLabels('더 플렌더')) === JSON.stringify(['더 플렌더 Basic', '더 플렌더 PRO', '더 플렌더 MAX', '더 플렌더 mini', '더 플렌더 NEXT', '더 플렌더 PLUS']), modelLabels('더 플렌더'));
    check('미니 건조기 모델 3개: 기본, PRO, PRO+', JSON.stringify(modelLabels('미니 건조기')) === JSON.stringify(['미니 건조기', '미니 건조기 PRO', '미니 건조기 PRO+']), modelLabels('미니 건조기'));
    check('미니 식기세척기 모델 2개: 기본, PRO', JSON.stringify(modelLabels('미니 식기세척기')) === JSON.stringify(['미니 식기세척기', '미니 식기세척기 PRO']), modelLabels('미니 식기세척기'));
    const added = ['더 플렌더 Basic', '미니 건조기 PRO', '미니 건조기 PRO+', '미니 식기세척기 PRO'].map(lb => cat.flatMap(l => l.models).find(m => m.label === lb));
    check('  ↳ 추가 모델은 전부 공구 비노출, 배지 색·집계 키·저장 표기에 없음',
      added.every(m => m && m.gongu === false && !m.option && !m.tab && !X.PRODUCT_TAXONOMY.some(t => t.key === m.key) && !(m.key in X.PRODUCT_SHEET_NAME)), added);
    check('  ↳ 모델 key가 카탈로그 전체에서 겹치지 않음', (() => { const ks = cat.flatMap(l => l.models.map(m => m.key)); return ks.length === new Set(ks).size; })());
    // 공구 화면이 보는 파생 상수 — 카탈로그 전환(2026-09-25) 이전의 리터럴 값과 똑같아야 한다
    check('더 시프트 모델 탭이 전과 동일(전체/더 시프트/PRO)',
      JSON.stringify(X.PRODUCT_MODEL_TABS['시프트']) ===
      JSON.stringify({ label: '더 시프트', tabs: [{ m: 'all', lb: '전체' }, { m: '기본', lb: '더 시프트' }, { m: 'PRO', lb: 'PRO' }] }),
      X.PRODUCT_MODEL_TABS['시프트']);
    check('모델 탭이 있는 품목은 플렌더·시프트 둘뿐', JSON.stringify(Object.keys(X.PRODUCT_MODEL_TABS)) === '["플렌더","시프트"]');
    check('LINE_HAS_MODELS가 전과 동일', JSON.stringify(X.LINE_HAS_MODELS) === '{"더플렌더":true,"더시프트":true}', X.LINE_HAS_MODELS);
    check('LINE_MODEL_OPTIONS[더시프트]가 전과 동일', JSON.stringify(X.LINE_MODEL_OPTIONS['더시프트']) === '["더시프트","더시프트PRO"]');
    const SHEET_BEFORE = { '더플렌더PRO': '더 플렌더 PRO', '더플렌더MAX': '더 플렌더 MAX', '더플렌더mini': '더 플렌더 mini',
      '더플렌더NEXT': '더 플렌더 NEXT', '더시프트': '더 시프트', '더시프트PRO': '더 시프트 PRO', '더에어드라이': '더 에어드라이', '더슬림': '더 슬림' };
    const sheetKeys = Object.keys(X.PRODUCT_SHEET_NAME);
    check('PRODUCT_SHEET_NAME이 전과 같은 키·값(순서 무관 — 조회로만 쓰임)',
      sheetKeys.length === Object.keys(SHEET_BEFORE).length && sheetKeys.every(k => X.PRODUCT_SHEET_NAME[k] === SHEET_BEFORE[k]),
      X.PRODUCT_SHEET_NAME);
    check('비노출 품목은 저장 표기 매핑에도 없어 저장이 차단됨',
      ctx.toSheetProductName('미니건조기') === null && ctx.toSheetProductName('더플렌더PLUS') === null);
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})();
