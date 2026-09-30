'use strict';
/* 배포 버전 문자열·임베드 판정·Apps Script 주소 — 모든 파일보다 먼저 로드된다. */

// 배포본 확인용 버전 문자열 — 프론트를 수정할 때마다(순수 프론트 전용 변경 포함) 바꿔서, 콘솔에서
// "이 브라우저가 최신 프론트를 받았는지"를 바로 확인 가능. apps-script.js의 SCRIPT_VERSION과는
// 더 이상 짝을 맞추지 않음 — 아래 REQUIRED_SCRIPT_VERSION이 그 역할을 대신함(이유는 그 주석 참고).
const DASHBOARD_VERSION='dash-erp-sales-2026-09-30-01';
console.log('[dashboard] 프론트 버전:',DASHBOARD_VERSION);
/* 임베드 여부 단일 창구 — 화면 숨김은 head에서 붙인 html.embed 클래스가 CSS로 처리하고,
   여기서는 JS 동작 분기가 필요할 때 이 상수를 본다(둘의 판정 기준은 같아야 함). */
const IS_EMBED=document.documentElement.classList.contains('embed');
if(IS_EMBED)console.log('[dashboard] 임베드 모드 — 사이드바/헤더 숨김, 내부 이동 시 embed 파라미터 유지');

// 이 프론트가 실제로 의존하는 "최소 호환 Apps Script 버전" — DASHBOARD_VERSION(프론트 전용 버전,
// 프론트만 바뀌어도 매번 값이 달라짐)과 분리해서 관리함. 예전엔 fetchLive가 서버 응답의 version을
// DASHBOARD_VERSION과 직접 비교했는데, 그러면 Code.gs는 그대로인데 프론트만 고친 경우에도 항상
// "버전 불일치" 오탐 경고가 떴음(실제로 재배포가 필요 없는데도). 이 값은 Code.gs가 실제로 바뀌어서
// 프론트가 그 변경에 의존하게 될 때만 그 시점의 SCRIPT_VERSION으로 갱신할 것 — 프론트 전용 변경으로는
// 절대 건드리지 말 것.
const REQUIRED_SCRIPT_VERSION='erp-sales-2026-09-30-01';

// Apps Script Web App 기본 URL — ⚙ 연결 설정에서 URL을 저장한 적 없는 브라우저(신규 로그인,
// 시크릿 모드, 새 팀원 PC 등)는 localStorage가 비어있어 요청을 보낼 곳이 없었고, 그 결과 fetchLive가
// GAS_URL_MISSING으로 조용히 샘플 데이터에 머무는 문제가 있었음(2026-07-28 확인). 이 상수를 최종
// 폴백으로 내장해서 설정 없이도 곧바로 실데이터에 연결되게 함 — 우선순위는 항상
// "localStorage에 사용자가 저장한 값 > 이 기본값" (_getGasUrl() 참고).
// ⚠ 배포 관리 → 기존 배포 편집 → "새 버전"으로 업데이트하는 경우는 URL이 그대로 유지되므로 이 값을
// 안 바꿔도 됨. URL이 실제로 바뀌는 경우는 오직 "새 배포"를 완전히 새로 만들 때뿐이며, 그때만 아래
// 값을 새 URL로 갱신할 것.
const DEFAULT_GAS_URL='https://script.google.com/macros/s/AKfycbxz5VBbD1IDha4mLCkozP2Q3cofukqCx5d2h1CaONghOOPAAh_D_P9_OKT2UlQBhL5Q/exec';
// GAS Web App URL 읽기 단일 창구 — 이 함수를 거치지 않고 localStorage.getItem('gp_gas_url')을
// 직접 읽으면 사용자가 URL을 설정 안 한 브라우저에서 다시 조용히 빈 값이 나오니 반드시 이걸 사용할 것
// (단, ⚙ 연결 설정 입력창 초기값 표시는 예외 — 사용자가 실제로 저장한 값이 있는지 그대로 보여줘야
// 하므로 openCfg()는 이 함수를 쓰지 않고 localStorage를 직접 읽음).
function _getGasUrl(){return localStorage.getItem('gp_gas_url')||DEFAULT_GAS_URL;}
