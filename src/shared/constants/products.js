'use strict';
/* 품목 분류 상수 — 품목군·세부 모델 정의의 유일한 기준(PRODUCT_CATALOG)과, 공구 화면이 쓰는 파생 상수. */

/* ── 품목 카탈로그 (2026-09-25) ───────────────────────────────────────────────
   품목군·세부 모델은 **여기에만** 적는다. 아래의 PRODUCT_LINES / PRODUCT_TAXONOMY / PRODUCT_SHEET_NAME /
   LINE_HAS_MODELS / LINE_MODEL_OPTIONS / PRODUCT_MODEL_TABS는 전부 이 배열에서 만들어지므로 따로 고치지
   말 것 — 예전엔 이 여섯 개가 세 파일에 흩어져 있어서 모델 하나를 추가하려면 전부 따로 손대야 했다.

   gongu  공동구매 화면 노출 여부(품목군·모델 모두 명시). false면 파생 상수에 아예 들어가지 않으므로
          사이드바·모델 탭·등록/수정 폼 드롭다운·공구 분석 필터·배지 어디에도 나타나지 않는다.
          (미니 건조기·미니 식기세척기와 그 모델, 더 플렌더 Basic·PLUS — 오프라인 코드 매핑용)
          색상은 모델이 아니라 제품마스터 '옵션'으로 구분한다 — 여기에 색상별 모델을 만들지 말 것.
          모델은 품목군과 둘 다 true여야 공구 화면에 나온다.

   배열 순서 = 사이드바 '품목별 실적' 순서 = 대시보드 품목 필터/히트맵 열 순서 = 모델 탭 순서.

   품목군  key   공백 없는 내부 표기. 등록/수정 모달 품목군 드롭다운의 value, PRODUCT_TAXONOMY의 line
           st    품목별 실적 페이지의 ST.prod 값(= 사이드바 data-prod, filteredProd의 분기 키)
           slug  해시 라우팅용 ASCII 슬러그(#product-<slug>) — 한글 슬러그는 퍼센트 인코딩돼 읽을 수 없어짐
           label 표시 이름 · icon 사이드바 아이콘
           category 대분류(오프라인 집계·이관용 — 음식물처리기·김치냉장고·청소기·건조기·식세기 + 본품 외 필터·기타). 품목군 위 단계라
                 더 에어드라이와 미니 건조기가 같은 '건조기'에 묶이지만, 품목군은 그대로 따로다(공구 화면 무관).
                 GAS apps-script-offline-targets.js 의 OFFLINE_CATALOG 와 같아야 한다(테스트가 대조).
   모델    key   배지 색·집계 키(productColorKey 결과와 같아야 함)
           label 표시 이름
           sheet 시트 C열 데이터 확인 규칙 표기 — 아래 PRODUCT_SHEET_NAME 주석 참고. 표시 이름과 지금은
                 같지만 일부러 따로 둔다: 표시만 바꾸려다 저장이 깨지는 일을 막기 위해.
           option 등록/수정 폼 '제품' 드롭다운 value. 이게 있는 모델이 하나라도 있는 품목군만 제품
                 드롭다운이 뜬다(LINE_HAS_MODELS). 없는 품목군(더 슬림·더 에어드라이)은 단일 제품이라
                 품목군 key 자체가 제품명으로 저장된다.
           tab / tabLabel  품목별 실적 모델 탭 값(flenderModel/shiftModel 결과와 같아야 함) / 탭 글자(없으면 tab)
           color 배지·캘린더 막대 색
   더 플렌더 NEXT/더 시프트 PRO는 아직 출시 전이라 실제 데이터는 없지만, 미리 등록해두면 출시 후
   데이터가 들어오는 순간 별도 코드 수정 없이 모든 필터/집계에 자동으로 나타남. */
const PRODUCT_CATALOG=[
  {key:'더플렌더', st:'플렌더', slug:'TheFlender', label:'더 플렌더', icon:'🌀', category:'음식물처리기', gongu:true, models:[
    {key:'플렌더Basic', label:'더 플렌더 Basic', gongu:false}, // 오프라인 코드 매핑용
    {key:'플렌더PRO', label:'더 플렌더 PRO',  sheet:'더 플렌더 PRO',  option:'더플렌더PRO',  tab:'PRO',  color:{bg:'#F3E8FF',fg:'#7C3AED'}, gongu:true},
    {key:'플렌더MAX',  label:'더 플렌더 MAX',  sheet:'더 플렌더 MAX',  option:'더플렌더MAX',  tab:'MAX',  color:{bg:'#DBEAFE',fg:'#2563EB'}, gongu:true},
    {key:'플렌더mini', label:'더 플렌더 mini', sheet:'더 플렌더 mini', option:'더플렌더mini', tab:'mini', color:{bg:'#DCFCE7',fg:'#16A34A'}, gongu:true},
    {key:'플렌더NEXT', label:'더 플렌더 NEXT', sheet:'더 플렌더 NEXT', option:'더플렌더NEXT', tab:'NEXT', color:{bg:'#FEF9C3',fg:'#CA8A04'}, gongu:true}, // 출시 예정
    {key:'플렌더PLUS', label:'더 플렌더 PLUS', gongu:false}, // 오프라인 코드 매핑용
  ]},
  {key:'더시프트', st:'시프트', slug:'TheShift', label:'더 시프트', icon:'📦', category:'김치냉장고', gongu:true, models:[
    {key:'시프트',    label:'더 시프트',     sheet:'더 시프트',     option:'더시프트',    tab:'기본', tabLabel:'더 시프트', color:{bg:'#FFEDD5',fg:'#EA580C'}, gongu:true},
    {key:'시프트PRO', label:'더 시프트 PRO', sheet:'더 시프트 PRO', option:'더시프트PRO', tab:'PRO', color:{bg:'#FFE1B8',fg:'#C2410C'}, gongu:true}, // 출시 예정
  ]},
  {key:'더슬림', st:'슬림', slug:'TheSlim', label:'더 슬림', icon:'🧹', category:'청소기', gongu:true, models:[
    {key:'슬림', label:'더 슬림', sheet:'더 슬림', color:{bg:'#CCFBF1',fg:'#0D9488'}, gongu:true},
  ]},
  {key:'더에어드라이', st:'에어드라이', slug:'TheAirDry', label:'더 에어드라이', icon:'💨', category:'건조기', gongu:true, models:[
    {key:'에어드라이', label:'더 에어드라이', sheet:'더 에어드라이', color:{bg:'#FFE4E6',fg:'#E11D48'}, gongu:true},
  ]},
  // 오프라인 코드 매핑용 품목군 — 공구 화면에는 나타나지 않음
  {key:'미니건조기', label:'미니 건조기', category:'건조기', gongu:false, models:[
    {key:'미니건조기', label:'미니 건조기', gongu:false},
    {key:'미니건조기PRO', label:'미니 건조기 PRO', gongu:false},
    {key:'미니건조기PRO+', label:'미니 건조기 PRO+', gongu:false},
  ]},
  {key:'미니식기세척기', label:'미니 식기세척기', category:'식세기', gongu:false, models:[
    {key:'미니식기세척기', label:'미니 식기세척기', gongu:false},
    {key:'미니식기세척기PRO', label:'미니 식기세척기 PRO', gongu:false},
  ]},
  // 본품이 아닌 품목(2026-09-29) — 본품 뒤에 둔다(대분류 필터 순서 = 이 순서). 본품 합계 제외는 PRODUCT_CATEGORY_ATTR
  {key:'필터', label:'필터', category:'필터', gongu:false, models:[ // 더 플렌더 전용 필터
    {key:'하드락필터', label:'하드락필터', gongu:false},
    {key:'하드필터', label:'하드필터', gongu:false},
  ]},
  // 판매용이 아닌 전시대·타 브랜드 리퍼 등. 모델은 하나, 품명은 SKU 옵션에 적는다(skuOptionHint가 있으면 새 SKU 만들기에서 옵션 필수)
  {key:'기타', label:'기타', category:'기타', gongu:false, skuOptionHint:'품명 입력 (예: 3kg 건조기 전시대)', models:[
    {key:'기타', label:'기타', gongu:false},
  ]},
];
// 대분류 목록(카탈로그 등장 순) — 오프라인 목표 관리 표·이관 매핑이 쓴다. 공구 화면은 쓰지 않는다.
const PRODUCT_CATEGORIES=[...new Set(PRODUCT_CATALOG.map(l=>l.category))];
/* 대분류 속성 — main = 본품합계포함(Y/N). N이면 채널 현황 KPI·채널 카드·달성률·IN−OUT 갭·정상재고·재고일수·진열 점포 수와
   목표 관리 채널·전체 합계(= 본품 합계)에서 빠지고, 대분류 단위로만 따로 보인다. 재고 경보 대상 여부는 GAS가 정한다.
   GAS apps-script-offline-targets.js 의 OFFLINE_CATEGORY_ATTR 와 main 값이 같아야 한다(테스트가 대조). */
const PRODUCT_CATEGORY_ATTR={
  '음식물처리기':{main:'Y'},'김치냉장고':{main:'Y'},'청소기':{main:'Y'},'건조기':{main:'Y'},'식세기':{main:'Y'},
  '필터':{main:'N'}, // 본품 합계에서 빼고 "필터 판매 n개 · 필터 재고 n개" 한 줄로 따로 보여 준다
  '기타':{main:'N'}, // 본품 합계·재고 경보 모두 제외
};
const PRODUCT_MAIN_CATEGORIES=PRODUCT_CATEGORIES.filter(c=>PRODUCT_CATEGORY_ATTR[c].main==='Y');
const PRODUCT_EXTRA_CATEGORIES=PRODUCT_CATEGORIES.filter(c=>PRODUCT_CATEGORY_ATTR[c].main!=='Y'); // 본품 외(필터 → 기타)
// 공구 화면에 노출되는 품목군과 그 모델만(순서 유지)
const _GONGU_LINES=PRODUCT_CATALOG.filter(l=>l.gongu).map(l=>({line:l,models:l.models.filter(m=>m.gongu)}));

// 시트 C열(제품명) 데이터 확인 규칙이 실제로 허용하는 표기 — 폼/모달 내부에서 쓰는 공백 없는 값을
// 저장 직전에 반드시 이 표기로 바꿔야 함(공백 차이로 "데이터 확인 규칙을 위반합니다" 저장 실패가
// 반복 발생했던 이력 — 더시프트/더시프트PRO도 2026-07-28에 같은 이유로 재발했다가 아래 표기로
// 수정함). 2026-07-28 기준 사용자가 직접 확인한 시트 규칙 목록: 더 슬림, 더 플렌더 MAX, 더 플렌더
// PRO, 더글로우, 더 시프트, 미니건조기, 프로그램 G필, 프로티원, 더 플렌더 NEXT, 더 시프트 PRO.
// ★ 이 목록엔 "더 플렌더 MINI"와 "더 에어드라이"가 안 보임 — 이전 확인 때는 있었던 값이라, 실수로
//   빠졌는지 실제로 규칙에서 제거됐는지 반드시 시트에서 재확인 필요. 확인 전까지는 기존 표기를
//   그대로 유지해뒀으니, 이 두 제품으로 저장이 또 실패하면 이 주석부터 다시 볼 것.
// 2026-07-29 확정(실제 시트 검증 에러 메시지에서 직접 확보한 허용 목록 — 더 이상 추측 아님):
// 더 슬림, 더 플렌더 MAX, 더 플렌더 PRO, 더글로우, 더 시프트, 미니건조기, 프로그램 G필, 프로티원,
// 더 플렌더 NEXT, 더 시프트 PRO, 더 플렌더 mini(소문자!), 더 에어드라이 — 전부 띄어쓰기 포함.
// ⚠ 이전엔 mini를 대문자(MINI)로 잘못 매핑해서 "더플렌더mini" 저장이 전부 실패하고 있었음(헤이지니
// 건 등) — 시트 규칙은 소문자 mini가 정답. 더글로우/프로그램 G필/프로티원/미니건조기는 톰 브랜드
// 제품이라 이 대시보드(Minix 전용) 드롭다운엔 없음 — 매핑 테이블에 없어도 정상.
// 키: 제품 드롭다운이 있는 품목군은 모델의 option, 단일 제품 품목군은 품목군 key(그 값이 저장되므로).
// 값: 카탈로그 모델의 sheet. 공구 노출 모델만 들어간다 — 폼에서 고를 수 없는 값은 저장될 일도 없다.
const PRODUCT_SHEET_NAME=Object.assign({},..._GONGU_LINES.flatMap(({line,models})=>
  models.map(m=>({[m.option||line.key]:m.sheet}))));
// 매핑에 없는 내부 표기로 저장을 시도하면(드롭다운에 새 옵션만 추가하고 매핑 갱신을 깜빡한 경우 등)
// null을 반환해서 호출부가 저장 자체를 막고 사용자에게 알리게 함 — 예전처럼 콘솔 경고만 남기고
// 원본 값을 그대로 내보내면, 시트 규칙 위반이 저장 시점에야(그것도 CORS로 위장된 채) 발견됨.
function toSheetProductName(p){
  if(!p)return p;
  const mapped=PRODUCT_SHEET_NAME[p];
  if(mapped===undefined){
    console.error('[제품명 매핑] "'+p+'"에 대한 시트 표기 매핑이 없습니다 — 저장을 차단합니다. PRODUCT_SHEET_NAME에 추가하세요.');
    return null;
  }
  return mapped;
}

// 세부 모델(fine-grained) → 대분류 제품 라인(line) + 표시 라벨 + 배지 색 — 채널별 성과 필터/시즌성
// 제품군 필터/제품군별 비교/배지 색 등 공구 분석 전체가 이 배열을 본다(PRODUCT_COLORS/
// PRODUCT_GROUP_LABELS/PRODUCT_LINE_OF도 여기서 파생).
const PRODUCT_TAXONOMY=_GONGU_LINES.flatMap(({line,models})=>
  models.map(m=>({key:m.key,line:line.key,label:m.label,color:m.color})));
const PRODUCT_COLORS=Object.assign({},...PRODUCT_TAXONOMY.map(t=>({[t.key]:t.color})),{other:{bg:'#F3F4F6',fg:'#6B7280'}});
const PRODUCT_GROUP_LABELS=Object.assign({},...PRODUCT_TAXONOMY.map(t=>({[t.key]:t.label})),{other:'기타'});
// 세부 모델 → 제품 라인(대분류) 매핑 — 시즌성 제품군 필터 등 라인 단위 집계용
const PRODUCT_LINE_OF=Object.assign({},...PRODUCT_TAXONOMY.map(t=>({[t.key]:t.line})));
/* 제품 라인(대분류) — 사이드바 메뉴·해시 라우팅(ST_PRODUCT_TO_HASH/HASH_PRODUCT_TO_ST)·등록/수정 모달의
   품목군 드롭다운이 전부 이 배열에서 생성됨 — HTML에 품목을 직접 써넣지 말 것. */
const PRODUCT_LINES=_GONGU_LINES.map(({line})=>({key:line.key,st:line.st,slug:line.slug,label:line.label,icon:line.icon}));
const PRODUCT_LINE_LABELS=Object.assign({},...PRODUCT_LINES.map(l=>({[l.key]:l.label})),{other:'기타'});

// 품목군별 제품 드롭다운 여부 — 신규 등록 모달(fLine/fModel)과 수정 모달(mLine/mModel) 둘 다
// 이 상수 하나만 참조함(예전엔 두 모달이 각각 다른 상수를 써서 한쪽만 고치면 어긋나기 쉬웠음 —
// 더시프트 PRO 드롭다운이 신규 등록에만 있고 수정 모달엔 없던 게 그 사례).
const LINE_HAS_MODELS=Object.assign({},..._GONGU_LINES.filter(({models})=>models.some(m=>m.option))
  .map(({line})=>({[line.key]:true})));
// 품목군별 제품 드롭다운 옵션(내부 표기, 공백 없음) — 값 표기는 품목별 실적의 모델 매칭 규칙
// (flenderModel/shiftModel)과 정확히 일치해야 함. 시트에 실제로 저장되는 표기(공백 포함)는
// 이 값이 아니라 PRODUCT_SHEET_NAME을 거친 결과.
const LINE_MODEL_OPTIONS=Object.assign({},..._GONGU_LINES.filter(({models})=>models.some(m=>m.option))
  .map(({line,models})=>({[line.key]:models.filter(m=>m.option).map(m=>m.option)})));
// 품목별 실적 모델 탭 구성(키는 ST.prod) — 탭이 없는 제품(슬림/에어드라이)은 빠져 subTabs가 숨겨짐
const PRODUCT_MODEL_TABS=Object.assign({},..._GONGU_LINES.filter(({models})=>models.some(m=>m.tab))
  .map(({line,models})=>({[line.st]:{label:line.label,tabs:[{m:'all',lb:'전체'}]
    .concat(models.filter(m=>m.tab).map(m=>({m:m.tab,lb:m.tabLabel||m.tab})))}})));
