'use strict';
/* 해시 라우팅 — 해시 ↔ 페이지, 품목 슬러그, 페이지 전환(navPage). */

/* ── 탭 해시 라우팅 ──
   #home / #calendar / #dashboard / #entry-list / #new-deal / #product-TheFlender 등으로 현재 탭을 표시.
   전환은 항상 history.replaceState로만 처리(location.hash 직접 할당 금지) → 뒤로가기 히스토리에
   탭이 안 쌓이고, 대시보드 진입 이전 페이지로 바로 나가짐. 해시가 포함된 주소로 직접 열거나
   새로고침하면 _routeFromHash()가 그 탭을 그대로 열어줌.
   ⚠ 기존 해시는 절대 바꾸지 말 것 — 세일즈 팀 워크스페이스(minix-workspace)가 ?embed=1#<해시>로
     iframe 미러링 중이다(#calendar·#dashboard·#product-TheFlender·#product-TheShift·#review).
     메뉴 이름이 바뀌어도(대시보드→공구 분석, 회고→공동구매 회고, 실적 미기입 목록→미기입 목록) 해시는 그대로다. */
/* 품목별 실적 해시 슬러그 ↔ 내부 품목 키.
   슬러그는 ASCII로 쓴다 — 한글 슬러그는 브라우저가 프래그먼트를 퍼센트 인코딩하는 순간
   #product-%EB%8D%94%ED%94%8C%EB%A0%8C%EB%8D%94 처럼 길어져서, iframe src나 문서에 붙였을 때
   읽을 수도 눈으로 확인할 수도 없는 주소가 된다.
   ⚠ 예전 한글 슬러그(#product-더플렌더)로 저장해둔 링크가 이미 돌아다니므로 별칭으로 계속 받는다.
   새로 만들어지는 주소는 항상 ST_PRODUCT_TO_HASH의 ASCII 슬러그를 쓴다(단방향 전환). */
const ST_PRODUCT_TO_HASH=Object.assign({},...PRODUCT_LINES.map(l=>({[l.st]:l.slug})));
const HASH_PRODUCT_TO_ST=Object.assign({},
  // 표준 슬러그
  ...PRODUCT_LINES.map(l=>({[l.slug]:l.st})),
  // 과거 한글 슬러그(#product-더플렌더) — 기존 링크/북마크 호환용(계속 유지할 것)
  ...PRODUCT_LINES.map(l=>({[l.key]:l.st})));
// 대소문자는 무시하고 찾는다 — 주소를 손으로 옮겨 적는 경우가 많아 theflender/THEFLENDER도 받아준다
function _productFromHashSlug(slug){
  if(HASH_PRODUCT_TO_ST[slug])return HASH_PRODUCT_TO_ST[slug];
  const lower=String(slug||'').toLowerCase();
  for(const k in HASH_PRODUCT_TO_ST)if(k.toLowerCase()===lower)return HASH_PRODUCT_TO_ST[k];
  return null;
}
// 페이지 id(= #page-<id>, 사이드바 data-page) → 해시. 품목별 실적(sales)은 #product-<slug>라 여기 없다.
const PAGE_ID_TO_HASH={
  home:'home',
  'offline-channels':'offline/channels','offline-channel':'offline/channel','offline-inventory':'offline/inventory',
  calendar:'calendar',dashboard:'dashboard',review:'review',management:'entry-list',
  'admin-upload':'admin/upload','admin-code-mapping':'admin/code-mapping','admin-targets':'admin/targets','admin-surveys':'admin/surveys',
  'monthly-review':'monthly-review'
};
const HASH_TO_PAGE_ID=Object.assign({},...Object.keys(PAGE_ID_TO_HASH).map(p=>({[PAGE_ID_TO_HASH[p]]:p})));
// 해시 뒤에 /<파라미터>를 더 받을 수 있는 페이지 — #offline/channel/{channelId} (채널 상세, 2단계에서 채움)
// #admin/surveys/{설문ID} · /{설문ID}/results · /{설문ID}/r/{응답ID} (설문 관리 — 파라미터에 / 가 들어간다)
const PAGE_WITH_PARAM=['offline-channel','admin-surveys'];
const DEFAULT_PAGE_ID='home'; // 해시 없음/알 수 없는 해시 → 파트 홈
let _currentPageHash='dashboard'; // 새 공구건 등록 모달을 닫을 때 되돌아갈 해시(모달 밑에 깔린 실제 탭)
let _pageParam=null; // 지금 페이지의 해시 파라미터(#offline/channel/{channelId}의 channelId) — 없으면 null
// 페이지에 들어올 때마다 부를 함수(데이터를 서버에서 받아 그리는 페이지용) — 페이지 파일이 자기 것을 등록한다
const PAGE_MOUNTS={};

function _setHash(h){
  /* ⚠ location.search를 반드시 보존할 것. 예전엔 pathname만 붙여서, 임베드(?embed=1)로 들어와도
     첫 메뉴 이동에 쿼리가 통째로 날아가 사이드바가 다시 튀어나왔다. 앞으로 어떤 쿼리 파라미터가
     생기든 같은 이유로 살아남아야 하므로 search 전체를 그대로 옮긴다. */
  history.replaceState(null,'',location.pathname+location.search+'#'+h);
}
function _findPageEl(pageId){
  return document.querySelector(`.sb-item-solo[data-page="${pageId}"], .sb-item[data-page="${pageId}"]`);
}
function _findProdEl(prod){
  return document.querySelector(`.sb-item[data-prod="${prod}"]`);
}
/* 해시를 라우팅 키로 바꾼다.
   ⚠ 품목별 실적 해시에는 한글이 들어간다(#product-더플렌더). 브라우저·상황에 따라 location.hash가
   퍼센트 인코딩된 형태(#product-%EB%8D%94...)로 돌아오는데, 그대로 비교하면 HASH_PRODUCT_TO_ST
   조회가 실패해 조용히 기본 탭(대시보드)으로 떨어진다 — "URL은 맞는데 엉뚱한 페이지가 열린다"가 되는 자리.
   디코딩해서 양쪽 표기를 모두 받아준다. %가 이스케이프가 아닌 채로 섞여 있으면 decodeURIComponent가
   던지므로 그때는 원문을 그대로 쓴다. */
function _decodeHash(h){
  const s=String(h||'').replace(/^#/,'');
  try{ return decodeURIComponent(s); }catch(e){ return s; }
}
// 해시(디코딩된 것) → {pageId, param}. 모르는 해시면 pageId=null.
function _pageFromHash(raw){
  if(Object.prototype.hasOwnProperty.call(HASH_TO_PAGE_ID,raw))return{pageId:HASH_TO_PAGE_ID[raw],param:null};
  for(const pid of PAGE_WITH_PARAM){
    const base=PAGE_ID_TO_HASH[pid]+'/';
    if(raw.indexOf(base)===0&&raw.length>base.length)return{pageId:pid,param:raw.slice(base.length)};
  }
  return{pageId:null,param:null};
}
function _routeFromHash(){
  const raw=_decodeHash(location.hash);
  if(raw==='new-deal'){openDealForm();return;}
  // #gongu/new — 공구 캘린더를 연 뒤 그 위에 등록 모달(닫으면 #calendar로 돌아감)
  if(raw==='gongu/new'){navPage('calendar',_findPageEl('calendar'));openDealForm({hash:'gongu/new'});return;}
  if(raw.indexOf('product-')===0){
    const prod=_productFromHashSlug(raw.slice('product-'.length));
    if(prod){navSales(_findProdEl(prod),prod);return;}
  }
  const {pageId,param}=_pageFromHash(raw);
  const target=pageId||DEFAULT_PAGE_ID; // 해시 없음/인식 불가 → 파트 홈(주소도 #home으로 정리됨)
  navPage(target,_findPageEl(target),param);
}
window.addEventListener('hashchange',_routeFromHash);

// 페이지 전환 — 사이드바 항목 클릭과 해시 라우팅이 모두 여기를 지난다. param은 PAGE_WITH_PARAM 페이지의 /<파라미터>.
function navPage(pageId,el,param){
  // 회고 페이지를 떠나는 경우 언마운트 — 저장은 React 쪽 언마운트 훅이 처리함
  if(pageId!=='review'&&document.getElementById('page-review').classList.contains('active'))_unmountReviewApp();
  _sbClearActive();
  if(el){el.classList.add('active');_sbRevealActive(el);}
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById('page-'+pageId).classList.add('active');
  closeMobileSidebar();
  _pageParam=param||null;
  const hash=(PAGE_ID_TO_HASH[pageId]||pageId)+(_pageParam?'/'+_pageParam:'');
  _currentPageHash=hash;
  _setHash(hash);
  if(pageId==='review')_mountReviewApp();
  if(PAGE_MOUNTS[pageId])PAGE_MOUNTS[pageId](_pageParam);
}
