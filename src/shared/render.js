'use strict';
/* 전체 다시 그리기 진입점 render()와 헤더 날짜. */

// DATA가 바뀔 수 있는 모든 경로가 render()를 거치므로 여기서 등급 산정 캐시를 비움.
// 시트 G·H열 되기록(syncTiersToSheet)도 같은 이유로 여기 한 곳에만 걸어둠 — 초기 로드/공구건 저장/
// 수동 지정 변경/팔로워 수 편집/완료 전환이 전부 이 경로를 지나므로 시점을 따로 챙길 필요가 없다.
// 값이 안 바뀌었으면 내부에서 즉시 빠져나가므로(요청 자체가 안 나감) 매 렌더 호출해도 부담 없음.
// 파트 홈은 공구 실적·일정·미기입을 DATA로 계산하므로 여기서 같이 다시 그린다(보고 있을 때만 — renderHomePage 안에서 판정)
function render(){invalidateTierStats();invalidateChannelInfo();renderDashboard();renderTbl();renderCalendarPage();renderMgmtPage();renderHomePage();syncTiersToSheet();}
document.getElementById('hDate').textContent=_NOW.getFullYear()+'년 '+(_NOW.getMonth()+1)+'월 '+_NOW.getDate()+'일';
