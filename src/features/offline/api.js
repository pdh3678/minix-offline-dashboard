'use strict';
/* 오프라인 API 클라이언트 — offline_* 액션은 전부 doPost로 보낸다(apps-script-offline.js).

   왜 공구 쓰기(_gasWrite, GET 청크)와 다른 길인가: 업로드 레코드가 수백 KB라 GET으로는 요청이 수백 번
   쪼개진다. 본문을 JSON 문자열로 주고 헤더를 지정하지 않으면 브라우저가 text/plain을 붙여 CORS
   프리플라이트가 생기지 않는다 — 접속자 하트비트(presence.js)가 운영에서 이미 쓰는 방식 그대로다.
   세션 토큰은 URL이 아니라 본문에 싣는다(서버 실행 로그·중간 경유지에 URL이 남으므로).
   재시도·세션 연장·AUTH_REQUIRED 처리는 공용 _gasFetch를 그대로 탄다. */
const OFFLINE_UPLOAD_TIMEOUT_MS=300000; // 하이마트 1개 파일 반영이 수십 초까지 걸릴 수 있다
const OFFLINE_CALL_TIMEOUT_MS=45000;
// 원장·원본 스프레드시트를 통째로 읽고 쓰는 액션 — 업로드와 같은 긴 타임아웃
const OFFLINE_LONG_ACTIONS={offline_upload:true,offline_migrateProgress:true,offline_migratePrices:true};

async function _offlineCall(action,data){
  if(!_getToken())throw new Error('로그인이 필요합니다.');
  const body=JSON.stringify({action,session:_getToken(),data:data||{}});
  const j=await _gasFetch(_getGasUrl(),{method:'POST',body,
    _timeoutMs:OFFLINE_LONG_ACTIONS[action]?OFFLINE_UPLOAD_TIMEOUT_MS:OFFLINE_CALL_TIMEOUT_MS});
  if(!j)throw new Error('서버 응답이 비었습니다.');
  if(j.error){
    if(j.error==='AUTH_REQUIRED')throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.');
    // 오프라인 파일(offline.gs)을 추가하기 전 배포본은 offline_ 액션을 모른다
    if(/presence 전용|_offlineHandle is not defined/.test(j.error))throw new Error('Apps Script 배포본에 오프라인 기능이 아직 없습니다 — apps-script-offline.js 추가 후 재배포가 필요합니다.');
    // 2-A 파일(offline_targets)을 추가하기 전 배포본
    if(/_off(GetMonthly|SaveTargets|GetPrices|SavePrices|MigrateProgress|MigratePrices) is not defined/.test(j.error))throw new Error('Apps Script 배포본에 목표·단가·이관 기능이 아직 없습니다 — apps-script-offline-targets.js(offline_targets) 추가 후 재배포가 필요합니다.');
    throw new Error(j.error);
  }
  return j;
}

/* 마스터(제품·채널·코드매핑·점포) — 오프라인 화면들이 공유한다. 저장하면 force로 다시 받는다
   (서버가 offline: 캐시를 무효화하므로 바로 새 값이 온다). */
let OFFLINE_MASTERS=null;
async function _offlineLoadMasters(force){
  if(OFFLINE_MASTERS&&!force)return OFFLINE_MASTERS;
  OFFLINE_MASTERS=await _offlineCall('offline_getMasters');
  return OFFLINE_MASTERS;
}
function _offlineResolver(){return OfflineResolver.createResolver(OFFLINE_MASTERS||{});}
function _offlineChannelName(id){
  const c=((OFFLINE_MASTERS&&OFFLINE_MASTERS.channels)||[]).find(x=>x.channelId===id);
  return c?c.name:id;
}
