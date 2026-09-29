'use strict';
/* 파트 합산 공용 — 파트 홈(home.js)과 목표 관리 [공구 목표]·[연간 보기]·[이관]이 같이 쓴다.

   공구 실적은 공구 분석 화면과 같은 규칙·같은 함수로 센다 — 같은 연월 필터에서 공구 분석 KPI '총 매출'과 같은 숫자가 나와야 한다.
     월 귀속   시작일(yearOf/monthOf(d.start)) — dashPeriodMatch와 같다
     상태      _isRevStatus(완료+진행중, KST 날짜 판정) — 예정 건은 뺀다
     매출      d.rev(실적통합 '총매출' = 판매수량 × 공동구매가 수식, VAT 포함) · 수량 d.qty — 미기입은 0
   오프라인 금액(IN 실적 × 공급가)·공구 목표는 서버(home_getSummary · offline_getGonguTargets)가 준다.
   채널군 색은 이 순서로 고정한다(데이터 시각화 팔레트 1~3번 — 필터로 채널군이 빠져도 남은 색은 그대로). */

const PART_GROUPS=[
  {key:'offline',label:'오프라인',color:'#2a78d6'},
  {key:'closed',label:'폐쇄몰·특판',color:'#eb6834'},
  {key:'gongu',label:'공동구매',color:'#1baf7a'}
];
const _partYm=(y,m)=>y+'-'+String(m).padStart(2,'0');

// 공구 제품명 → 카탈로그 품목군 → 대분류. 카탈로그에 없는 제품은 '' — 대분류 필터를 걸면 빠지고 '전체'에서는 더한다(공구 분석 총 매출과 같게)
function partGonguCategory(product){
  const line=productLineKey(product);
  const l=PRODUCT_CATALOG.find(x=>x.key===line);
  return l?l.category:'';
}
function _partCatMatch(d,category){return !category||partGonguCategory(d.product)===category;}
// 매출 집계 대상 공구건(공구 분석과 같은 스코프) — 그 해·대분류
function partGonguDeals(year,category){
  return DATA.filter(d=>d.start&&yearOf(d.start)===+year&&_isRevStatus(d)&&_partCatMatch(d,category));
}
/* 공구 월별 실적 — {ym: {rev, qty, deals}} (그 해 1~12월 전부) */
function partGonguMonthly(year,category){
  const out={};
  for(let m=1;m<=12;m++)out[_partYm(year,m)]={rev:0,qty:0,deals:0};
  partGonguDeals(year,category).forEach(d=>{
    const o=out[_partYm(year,monthOf(d.start))];
    o.rev+=d.rev||0;o.qty+=d.qty||0;o.deals++;
  });
  return out;
}
/* 그 달 공구 판매를 대분류별로 — {대분류('' = 카탈로그 밖 제품): {rev, qty, deals}} */
function partGonguByCategory(ym){
  const out={};
  partGonguDeals(ym.slice(0,4),'').forEach(d=>{
    if(_partYm(yearOf(d.start),monthOf(d.start))!==ym)return;
    const c=partGonguCategory(d.product),o=out[c]||(out[c]={rev:0,qty:0,deals:0});
    o.rev+=d.rev||0;o.qty+=d.qty||0;o.deals++;
  });
  return out;
}
// 실적 미기입 목록의 '완료' 건수 — 사이드바 '미기입 목록' 배지와 같은 수(pending-list.js)
function partPendingDoneCount(){return pendingPerfDeals().filter(d=>_displayStatus(d)==='완료').length;}
// 공구 데이터가 실서버에서 온 것인지(샘플·로컬 캐시가 아니라) — 대조 표에 "잠정" 표시할 때
function partGonguLive(){return typeof _tierSyncReady!=='undefined'&&_tierSyncReady;}
