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
const OFFLINE_LONG_ACTIONS={offline_upload:true,offline_migrateProgress:true,offline_migratePrices:true,offline_processInbox:true,offline_deleteHimartSnapshot:true};

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
    // 2-B 파일(offline_inventory)을 추가하기 전 배포본 — 단가 삭제는 offline_targets 갱신분이라 같이 안내한다
    if(/_off(GetInventory|GetDailySales|GetInventoryTrend|SaveSettings|DeletePrice) is not defined/.test(j.error))throw new Error('Apps Script 배포본에 재고 지표 기능이 아직 없습니다 — apps-script-offline-inventory.js(offline_inventory) 추가와 offline·offline_targets 갱신 후 새 버전 배포가 필요합니다.');
    // 하이마트 스냅샷 삭제(2026-10-07) 전 배포본
    if(/알 수 없는 오프라인 액션: offline_deleteHimartSnapshot/.test(j.error))throw new Error('Apps Script 배포본에 하이마트 스냅샷 삭제가 아직 없습니다 — apps-script-offline.js(offline) 갱신 후 새 버전 배포가 필요합니다.');
    throw new Error(j.error);
  }
  // 쓰기가 성공하면 조회 메모를 비운다 — 서버 캐시 세대가 바뀌는 것과 같은 시점
  if(!/^offline_get/.test(action))Object.keys(_OFFLINE_MEMO).forEach(k=>{delete _OFFLINE_MEMO[k];});
  return j;
}

/* 조회 메모 — 채널 현황·채널 상세·재고 현황을 오갈 때 같은 조회를 또 기다리지 않게(서버 캐시가 있어도 왕복이 1~3초).
   같은 액션·인자는 2분 동안 같은 응답을 쓰고, force면 다시 받는다. 실패한 조회는 메모하지 않는다. */
const _OFFLINE_MEMO={};
const OFFLINE_MEMO_MS=120000;
function _offlineCached(action,data,force){
  const k=action+'|'+JSON.stringify(data||{});
  const m=_OFFLINE_MEMO[k];
  if(!force&&m&&Date.now()-m.at<OFFLINE_MEMO_MS)return m.p;
  const p=_offlineCall(action,data);
  _OFFLINE_MEMO[k]={at:Date.now(),p};
  p.catch(()=>{if(_OFFLINE_MEMO[k]&&_OFFLINE_MEMO[k].p===p)delete _OFFLINE_MEMO[k];});
  return p;
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
// 채널 이름 — 채널이 아닌 코드체계(erp: 코드매핑·미매칭코드·ERP 업로드 파일이 이 이름으로 쌓인다)면 그 표시 이름(마스터 codeSystems)
function _offlineChannelName(id){
  const m=OFFLINE_MASTERS||{};
  const c=(m.channels||[]).find(x=>x.channelId===id)||(m.codeSystems||[]).find(x=>x.id===id);
  return c?c.name:id;
}

/* 채널대분류(채널마스터 '채널대분류' — 양판점·할인점·백화점·폐쇄몰·렌탈·특판). 순서는 서버 마스터 channelCategories 한 곳에서 받는다.
   목록 밖 값은 그 뒤(처음 나온 순), 빈칸은 '미분류'. 채널이 아닌 코드체계(erp)는 '' */
const OFFLINE_UNCATEGORIZED='미분류';
function _offlineChannelCatOf(id){
  const c=((OFFLINE_MASTERS&&OFFLINE_MASTERS.channels)||[]).find(x=>x.channelId===id);
  return c?(c.channelCategory||OFFLINE_UNCATEGORIZED):'';
}
function _offlineChannelCats(){
  const out=((OFFLINE_MASTERS&&OFFLINE_MASTERS.channelCategories)||[]).slice();
  ((OFFLINE_MASTERS&&OFFLINE_MASTERS.channels)||[]).forEach(c=>{const k=c.channelCategory||OFFLINE_UNCATEGORIZED;if(out.indexOf(k)<0)out.push(k);});
  return out;
}
const _ofChLabel=(cat,name)=>cat?cat+' · '+name:name;
// '채널대분류 · 채널명' (코드체계 erp 등 채널이 아니면 이름만)
function _offlineChannelLabel(id){return _ofChLabel(_offlineChannelCatOf(id),_offlineChannelName(id));}
// 여러 채널(업로드로그 'emart,traders') → '할인점 · 이마트·트레이더스 / 백화점 · …' (채널대분류로 묶어서)
function _offlineChannelsLabel(csv){
  const ids=String(csv||'').split(',').map(x=>x.trim()).filter(Boolean);
  return _offlineGroupChannels(ids.map(id=>({channelId:id,name:_offlineChannelName(id)})))
    .map(g=>_ofChLabel(g.cat,g.channels.map(c=>c.name).join('·'))).join(' / ');
}
// 채널대분류 순서 → 정렬순서
function _offlineSortChannels(list){
  const cats=_offlineChannelCats(),rk=c=>{const i=cats.indexOf(_offlineChannelCatOf(c.channelId));return i<0?99:i;};
  return list.slice().sort((a,b)=>(rk(a)-rk(b))||((Number(a.order)||99)-(Number(b.order)||99)));
}
/* 채널 목록 → [{cat, channels[]}] — 채널대분류 순서, 대분류 안은 받은 순서 그대로(정렬해서 넘길 것).
   채널마스터에 없는 id는 cat '' 그룹 */
function _offlineGroupChannels(list){
  const cats=_offlineChannelCats(),by={},order=[];
  list.forEach(c=>{const k=_offlineChannelCatOf(c.channelId);if(!by[k]){by[k]=[];order.push(k);}by[k].push(c);});
  order.sort((a,b)=>{const x=cats.indexOf(a),y=cats.indexOf(b);return (x<0?99:x)-(y<0?99:y);});
  return order.map(k=>({cat:k,channels:by[k]}));
}
