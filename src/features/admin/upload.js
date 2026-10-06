'use strict';
/* 데이터 업로드(#admin/upload) — 협력사 포털에서 받은 엑셀을 그대로 올리면 판별·파싱해 오프라인 원장에 반영.
   화면: ① 데이터 현황(offline_getStatus) ② 파일 카드(판별 유형·기준일·교체기간 수정, 미매칭 즉석 매핑, 반영)
         ③ 최근 업로드 로그(offline_getUploadLog)
   파일은 브라우저에서 파싱하고(src/features/offline/parsers.js) 정규화 레코드만 서버로 보낸다. 반영은 파일
   1개 = 요청 1개이고, 서버가 락으로 직렬화한다. 하이마트는 누적 차이 계산이라 기준일 오름차순으로 보낸다. */

const _UP={files:[],seq:0,status:null,statusErr:'',log:null,logErr:'',mastersErr:'',busyAll:false,progress:'',inbox:null,inboxErr:'',inboxBusy:false};

function mountUploadPage(){
  _upRender();
  _upRefreshSide();
}
PAGE_MOUNTS['admin-upload']=mountUploadPage;

// 상태·로그·마스터(미매칭 수 계산용)를 다시 받는다 — 각자 실패해도 나머지는 그린다
async function _upRefreshSide(){
  await Promise.all([
    _offlineCall('offline_getStatus').then(j=>{_UP.status=j;_UP.statusErr='';}).catch(e=>{_UP.statusErr=e.message;}),
    _offlineCall('offline_getUploadLog').then(j=>{_UP.log=j.items;_UP.logErr='';}).catch(e=>{_UP.logErr=e.message;}),
    _offlineCall('offline_getInboxStatus').then(j=>{_UP.inbox=j;_UP.inboxErr='';}).catch(e=>{_UP.inboxErr=e.message;}),
    _offlineLoadMasters(true).then(()=>{_UP.mastersErr='';}).catch(e=>{_UP.mastersErr=e.message;})
  ]);
  // 채널마스터(재고기준일오프셋)가 오기 전에 판별한 파일은 오프셋을 넣어 다시 판별한다(반영 중·반영한 파일은 그대로)
  const key=JSON.stringify(_upStockOffsets());
  _UP.files.forEach(f=>{if(f.rows&&f.status==='ready'&&f.offsetsKey!==key)_upParse(f);});
  _upRender();
}

function _upTodayStr(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
const _upMD=s=>+s.slice(5,7)+'/'+ +s.slice(8,10);
// ['2026-09-01','2026-09-02','2026-09-05'] → '9/1~9/2, 9/5'
function _upDayRanges(days){
  const out=[];let a=null,b=null;
  (days||[]).forEach(d=>{
    if(b&&_upNextDay(b)===d){b=d;return;}
    if(a)out.push(a===b?_upMD(a):_upMD(a)+'~'+_upMD(b));
    a=b=d;
  });
  if(a)out.push(a===b?_upMD(a):_upMD(a)+'~'+_upMD(b));
  return out.join(', ');
}
function _upNextDay(s){const t=new Date(Date.UTC(+s.slice(0,4),+s.slice(5,7)-1,+s.slice(8,10)+1));return t.toISOString().slice(0,10);}

// ── 파일 추가 ──
function _upPick(input){_upAddFiles(input.files);input.value='';}
function _upDragOver(ev){ev.preventDefault();const el=document.getElementById('upDrop');if(el)el.classList.add('over');}
function _upDragLeave(){const el=document.getElementById('upDrop');if(el)el.classList.remove('over');}
function _upDrop(ev){ev.preventDefault();_upDragLeave();if(ev.dataTransfer&&ev.dataTransfer.files)_upAddFiles(ev.dataTransfer.files);}
function _upAddFiles(list){
  Array.from(list||[]).forEach(file=>{
    const f={id:++_UP.seq,name:file.name,rows:null,parse:null,edits:{},status:'parsing',error:'',result:null,panelOpen:false};
    _UP.files.push(f);
    _upReadFile(f,file);
  });
  _upRender();
}
async function _upReadFile(f,file){
  try{
    const [XLSX,buf]=await Promise.all([_loadSheetJS(),file.arrayBuffer()]);
    // 개인정보 열이 있는 양식(ERP 매출이익리스트)은 쓰는 열만 남기고 원본 행은 버린다 — 이후 미리보기·전송은 이 배열만 본다
    f.rows=OfflineParsers.dropUnusedColumns(OfflineParsers.readWorkbookRows(XLSX,new Uint8Array(buf)).rows);
    _upParse(f);
  }catch(e){
    f.status='error';f.error='파일을 읽지 못했습니다: '+e.message;
  }
  _upRender();
}
/* 채널마스터 재고기준일오프셋 {channel_id: 일} — 재고 기준일 = 파일명 날짜 + 오프셋(스냅샷형 재고 파일).
   마스터를 아직 못 받았으면 null — 파서가 오프셋을 적용하지 않고, 반영 때 서버가 채널 오프셋을 더한다 */
function _upStockOffsets(){
  if(!OFFLINE_MASTERS||!OFFLINE_MASTERS.channels)return null;
  const o={};OFFLINE_MASTERS.channels.forEach(c=>{if(c.stockOffset)o[c.channelId]=c.stockOffset;});
  return o;
}
// 판별·파싱(유형·기준일·연도를 고칠 때마다 다시 돈다 — 원본 행은 f.rows에 남아 있다)
function _upParse(f){
  const offsets=_upStockOffsets();
  f.offsetsKey=JSON.stringify(offsets);
  f.parse=OfflineParsers.parseRows(f.rows,{fileName:f.name,type:f.edits.type||null,baseDate:f.edits.baseDate||'',year:f.edits.year||null,today:_upTodayStr(),stockOffsets:offsets||undefined});
  f.status=f.parse.ok?'ready':'error';
  f.error=f.parse.ok?'':f.parse.error;
  f.result=null;
}
function _upFile(id){return _UP.files.find(x=>x.id===id);}
// 기준일 옆 설명 — 스냅샷형 재고 파일은 "파일명 날짜 9/29 → 재고 기준일 9/28 (전일 기준)"
function _upBaseNote(f,p,b){
  if(f.edits.baseDate)return '직접 선택'+(p.fileDate&&p.fileDate!==b?` (파일명 날짜 ${_upMD(p.fileDate)})`:'');
  if(!p.fileDate)return '파일명에 날짜 없음 — 선택 필요';
  if(p.kind==='snapshot'&&p.stockOffset==null)return '파일명에서 읽음 — 채널 재고 기준일 설정을 불러오는 중(반영 때 서버가 적용)';
  if(p.stockOffset)return `파일명 날짜 ${_upMD(p.fileDate)} → 재고 기준일 ${_upMD(b)} (${p.stockOffset===-1?'전일 기준':p.stockOffset+'일'})`;
  return '파일명에서 읽음';
}
function _upRemove(id){_UP.files=_UP.files.filter(x=>x.id!==id);_upRender();}
function _upSetType(id,v){const f=_upFile(id);f.edits={type:v,baseDate:f.edits.baseDate};_upParse(f);_upRender();}
function _upSetBase(id,v){const f=_upFile(id);f.edits.baseDate=v;_upParse(f);_upRender();}
function _upSetYear(id,v){const f=_upFile(id);f.edits.year=v?Number(v):null;f.edits.replaceStart=f.edits.replaceEnd='';_upParse(f);_upRender();}
function _upSetRange(id,which,v){const f=_upFile(id);f.edits[which]=v;f.result=null;f.error='';if(f.status==='done')f.status='ready';_upRender();}
function _upTogglePanel(id){const f=_upFile(id);f.panelOpen=!f.panelOpen;_upRender();}

// 반영 직전 값(미리보기에서 고친 값 우선) — 오류 문구가 있으면 반영하지 않는다
function _upPlan(f){
  const p=f.parse;
  if(!p||!p.ok)return{error:f.error||'파일을 해석하지 못했습니다.'};
  if(p.blocked)return{error:p.blocked,blocked:true}; // 반영하지 않는 양식(트레이더스가 합쳐진 이마트 합계 파일)
  if(p.kind==='period'){
    const s=f.edits.replaceStart||(p.period&&p.period.start)||'',e=f.edits.replaceEnd||(p.period&&p.period.end)||'';
    if(!s||!e)return{error:'교체 기간을 정하세요.'};
    if(s>e)return{error:'교체 기간의 시작이 끝보다 늦습니다.'};
    if(p.split==='customer'){
      if(!OFFLINE_MASTERS)return{error:'거래처매핑을 불러오는 중입니다 — 잠시 후 다시 누르세요.'};
      const miss=_upErpCusts(f).filter(c=>!c.channelId);
      if(miss.length)return{error:`채널을 정하지 않은 거래처 ${miss.length}곳이 있습니다(${miss.map(c=>c.name||c.code).join(', ')}) — 아래 거래처 표에서 채널을 고르세요.`};
    }
    return{replaceStart:s,replaceEnd:e};
  }
  const b=f.edits.baseDate||p.baseDate;
  if(!b)return{error:'기준일을 선택하세요(파일명에 날짜가 없습니다).'};
  return{baseDate:b};
}
function _upUnmatched(f){
  const p=f.parse;
  if(!p||!p.ok||!OFFLINE_MASTERS)return null;
  // ERP 매출이익리스트는 브랜드·카테고리(본품/구성품)를 같이 넘긴다 — 코드 매핑 제안(필터·기타)이 쓴다
  const info=(p.summary&&p.summary.products)||{};
  return _offlineResolver().unmatched(p.channelId,p.codes).map(code=>Object.assign({channelId:p.channelId,code,name:p.records.names[code]||''},
    info[code]?{brand:info[code].brand,cat:info[code].category}:{}));
}

/* ERP 매출이익리스트(split 'customer') — 거래처 → 채널. 거래처매핑(마스터 customers)에 ERP 채널로 있으면 그 채널, 없으면 미리보기에서 고른다
   (f.edits.cust{거래처코드: channel_id | '-'(이번엔 반영 안 함)}). 고른 채널은 반영 때 GAS가 거래처매핑에 저장한다. 반영 때는 서버가 같은 규칙으로 정한다 */
function _upErpChannels(p){return _offlineSortChannels(((OFFLINE_MASTERS&&OFFLINE_MASTERS.channels)||[]).filter(c=>c.codeSystem===p.channelId));}
function _upErpCusts(f){
  const p=f.parse,erp=_upErpChannels(p).map(c=>c.channelId),picks=f.edits.cust||{};
  const known={};((OFFLINE_MASTERS&&OFFLINE_MASTERS.customers)||[]).forEach(c=>{known[c.code]=c;});
  return (p.summary.byCust||[]).map(c=>{
    const k=known[c.code],mapped=k&&erp.indexOf(k.channelId)>=0;
    return Object.assign({},c,{name:mapped&&k.name?k.name:c.name,mapped:!!mapped,channelId:mapped?k.channelId:(picks[c.code]||'')});
  });
}
function _upSetCust(id,code,v){const f=_upFile(id);(f.edits.cust=f.edits.cust||{})[code]=v;f.result=null;f.error='';if(f.status==='done')f.status='ready';_upRender();}
// 반영 요청에 실을 새 거래처 — 미리보기에서 채널을 고른 것만('-' = 반영 안 함은 싣지 않는다 → 서버가 보류)
function _upErpPicks(f){return f.parse.split!=='customer'?[]:_upErpCusts(f).filter(c=>!c.mapped&&c.channelId&&c.channelId!=='-').map(c=>({code:c.code,name:c.name,channelId:c.channelId}));}
function _upErpHtml(f,p){
  if(p.split!=='customer'||!p.summary.byCust)return '';
  if(!OFFLINE_MASTERS)return '<div class="up-stats"><span class="off-muted">거래처매핑을 불러오는 중…</span></div>';
  const won=v=>'₩'+Math.round(v||0).toLocaleString('ko-KR'),n=v=>Math.round(v||0).toLocaleString('ko-KR');
  const chs=_upErpChannels(p),custs=_upErpCusts(f),busy=f.status==='applying'||_UP.busyAll;
  const s=p.summary,ex=s.excluded||{rows:0,qty:0};
  const gub=Object.keys(s.gubun||{}).map(g=>_escHtml(g)+' <b>'+n(s.gubun[g])+'</b>').join(' · ');
  const custRows=custs.map(c=>{
    const sel=c.mapped?`<span class="up-chip ready">${_escHtml(_offlineChannelLabel(c.channelId))}</span>`
      :`<select class="f-sel${c.channelId?'':' up-need'}" ${busy?'disabled':''} onchange="_upSetCust(${f.id},'${_escAttr(c.code)}',this.value)"><option value="">— 채널 선택 —</option>${_offlineGroupChannels(chs).map(g=>`<optgroup label="${_escAttr(g.cat)}">${g.channels.map(ch=>`<option value="${_escAttr(ch.channelId)}"${c.channelId===ch.channelId?' selected':''}>${_escHtml(ch.name)}</option>`).join('')}</optgroup>`).join('')}<option value="-"${c.channelId==='-'?' selected':''}>이번엔 반영 안 함</option></select> <span class="off-miss">거래처매핑에 없음</span>`;
    return `<tr><td class="mp-code">${_escHtml(c.code)}</td><td>${_escHtml(c.name)}</td><td>${sel}</td><td class="num-col">${n(c.rows)}</td><td class="num-col">${n(c.qty)}</td><td class="num-col">${won(c.amount)}</td><td class="num-col">${c.excludedQty?n(c.excludedQty):'—'}</td></tr>`;
  }).join('');
  const byCh={};custs.forEach(c=>{if(!c.channelId||c.channelId==='-')return;const o=byCh[c.channelId]||(byCh[c.channelId]={custs:0,qty:0,amount:0,ex:0});o.custs++;o.qty+=c.qty;o.amount+=c.amount;o.ex+=c.excludedQty;});
  const chRows=chs.map(ch=>{const o=byCh[ch.channelId]||{custs:0,qty:0,amount:0,ex:0};
    return `<tr><td>${_escHtml(_ofChLabel(ch.channelCategory,ch.name))}</td><td class="num-col">${o.custs}</td><td class="num-col">${n(o.qty)}</td><td class="num-col">${won(o.amount)}</td><td class="num-col">${o.ex?n(o.ex):'—'}</td></tr>`;}).join('');
  const brRows=(s.brands||[]).map(b=>`<tr${b.minix?'':' class="up-other"'}><td>${_escHtml(b.brand)}${b.minix?'':' <span class="up-chip applying">미닉스 외</span>'}</td><td class="num-col">${n(b.qty)}</td><td class="num-col">${won(b.amount)}</td></tr>`).join('');
  return `<div class="up-stats">파일 금액 합계 <b>${won(s.fileAmount)}</b> · 수불구분 ${gub}${s.dataPeriod?` · 파일 안 날짜 ${_escHtml(s.dataPeriod.start)} ~ ${_escHtml(s.dataPeriod.end)}`:''}<br>
      무상 동봉 제외(카테고리 구성품 · 금액 0 — 판매로 저장하지 않음) <b>${n(ex.rows)}</b>행 · 수량 <b>${n(ex.qty)}</b></div>
    <div class="up-erp"><div><div class="f-lbl">거래처 → 채널 <span class="off-muted">거래처매핑 · 없는 거래처는 채널을 고르면 반영 때 저장</span></div>
      <div class="tbl-wrap"><table class="cm-tbl"><thead><tr><th>거래처코드</th><th>거래처(점포)</th><th>채널</th><th class="num-col">원본 행</th><th class="num-col">판매 수량</th><th class="num-col">금액</th><th class="num-col">무상 동봉 제외</th></tr></thead><tbody>${custRows}</tbody></table></div></div>
    <div class="up-erp-2"><div><div class="f-lbl">채널별 <span class="off-muted">교체 기간 동안 이 채널들의 판매원장을 바꾼다</span></div>
      <div class="tbl-wrap"><table class="cm-tbl"><thead><tr><th>채널</th><th class="num-col">거래처</th><th class="num-col">수량</th><th class="num-col">금액</th><th class="num-col">무상 동봉 제외</th></tr></thead><tbody>${chRows}</tbody></table></div></div>
      <div><div class="f-lbl">브랜드별 <span class="off-muted">무상 동봉 제외 뒤</span></div>
      <div class="tbl-wrap"><table class="cm-tbl"><thead><tr><th>브랜드</th><th class="num-col">수량</th><th class="num-col">금액</th></tr></thead><tbody>${brRows}</tbody></table></div></div></div></div>`;
}

async function _upApply(id,quiet){
  const f=_upFile(id);
  if(!f||f.status==='applying')return false;
  const plan=_upPlan(f);
  if(plan.error){f.error=plan.error;_upRender();return false;}
  f.status='applying';f.error='';f.result=null;_upRender();
  try{
    const payload=OfflineParsers.toUploadPayload(f.parse,Object.assign({fileName:f.name},plan,{customers:_upErpPicks(f)}));
    f.result=await _offlineCall('offline_upload',payload);
    f.status='done';
  }catch(e){
    f.status='ready';f.error='반영 실패: '+e.message;
  }
  _upRender();
  if(!quiet)_upRefreshSide();
  return f.status==='done';
}
/* 전체 반영 — 준비된 파일을 하나씩. 하이마트는 누적 차이 계산이라 기준일 오름차순으로 맨 뒤에 모아 보낸다
   (순서를 뒤섞어도 서버 결과는 같지만, 오름차순이면 매번 "다음 스냅샷 재계산"이 생기지 않아 가장 빠르다).
   이마트 점포별 일별 매출은 이마트 재고보다 먼저 — 매출 파일의 업태명으로 점포 → 채널(이마트·트레이더스)을 먼저 익혀야
   재고 파일(업태명 없음)의 점포를 점포마스터로 가를 수 있다. */
function _upApplyOrder(){
  const ready=_UP.files.filter(f=>f.status==='ready'&&!_upPlan(f).error);
  const hm=ready.filter(f=>f.parse.channelId==='himart').sort((a,b)=>_upPlan(a).baseDate.localeCompare(_upPlan(b).baseDate));
  const rank=f=>f.parse.split==='biz'?0:1;
  return ready.filter(f=>f.parse.channelId!=='himart').sort((a,b)=>rank(a)-rank(b)).concat(hm);
}
// 업태명 → 채널(채널마스터 원천업태명, 쉼표로 여러 개) — 미리보기용. 반영 때는 서버가 같은 규칙으로 정한다
function _upBizChannel(biz){
  const b=String(biz||'').trim();
  return ((OFFLINE_MASTERS&&OFFLINE_MASTERS.channels)||[]).find(c=>String(c.bizNames||'').split(',').map(x=>x.trim()).indexOf(b)>=0)||null;
}
/* 재고 파일(split 'store') — 점포마다 채널: 점포마스터(같은 코드체계) → 점포명접두어 → 코드체계 채널(이마트).
   미리보기용이고 반영 때는 서버(_offApplyStockSplit)가 같은 순서로 다시 정한다 → { byCh{채널: {stores, stock}}, via{master, prefix, fallback} } */
function _upStoreSplit(p){
  const m=OFFLINE_MASTERS||{},cs=OfflineResolver.codeSystemOf(m),root=p.channelId;
  const master={};(m.stores||[]).forEach(x=>{if(cs(x.channelId)===cs(root))master[x.code]=x.channelId;});
  const prefixes=[];(m.channels||[]).forEach(c=>{if(cs(c.channelId)===cs(root))String(c.storePrefix||'').split(',').map(x=>x.trim()).filter(Boolean).forEach(px=>prefixes.push({ch:c.channelId,px}));});
  prefixes.sort((a,b)=>b.px.length-a.px.length);
  const names={};(p.records.stores||[]).forEach(x=>{names[x.code]=x.name||'';});
  const chOf={},via={master:0,prefix:0,fallback:0},byCh={};
  const storeCh=code=>{
    if(chOf[code])return chOf[code];
    let c=master[code];
    if(c)via.master++;
    else{const hit=prefixes.find(x=>(names[code]||'').indexOf(x.px)===0);if(hit){c=hit.ch;via.prefix++;}else{c=root;via.fallback++;}}
    return chOf[code]=c;
  };
  (p.records.storeStock||[]).forEach(r=>{
    const c=r.store?storeCh(r.store):root,o=byCh[c]||(byCh[c]={stores:{},stock:0});
    if(r.store)o.stores[r.store]=true;o.stock+=Number(r.stock)||0;
  });
  Object.keys(byCh).forEach(c=>{byCh[c]={stores:Object.keys(byCh[c].stores).length,stock:byCh[c].stock};});
  return {byCh,via};
}
// 한 파일에 여러 채널이 섞인 파일(split) — 채널별 레코드·점포·판매 합계 / 재고는 채널별 점포 수·재고 합계
function _upSplitHtml(p){
  if(p.split==='store'){
    const {byCh,via}=_upStoreSplit(p);
    const rows=Object.keys(byCh).map(c=>`<span class="up-chip ready">${_escHtml(_offlineChannelLabel(c))}</span> 점포 <b>${byCh[c].stores}</b> · 재고 <b>${byCh[c].stock}</b>`);
    return `<div class="up-stats">${rows.join('<br>')}<br><span class="off-muted">점포 채널 판별: 점포마스터 ${via.master}곳 · 점포명접두어 ${via.prefix}곳${via.fallback?` · <b class="off-miss">못 정해 ${_escHtml(_offlineChannelName(p.channelId))}로 ${via.fallback}곳</b> — 점포별 일별 매출 파일을 먼저 올리면 점포마스터로 정해집니다`:''}</span></div>`;
  }
  if(p.split!=='biz'||!p.summary.byBiz)return '';
  const parts=p.summary.byBiz.map(b=>{
    const c=_upBizChannel(b.biz);
    return c?`<span class="up-chip ready">${_escHtml(_offlineChannelLabel(c.channelId))}</span> 업태명 "${_escHtml(b.biz)}" · 레코드 <b>${b.rows}</b> · 점포 <b>${b.stores}</b> · 판매 <b>${b.qty}</b>`
      :`<span class="up-chip error">채널 없음</span> 업태명 "${_escHtml(b.biz)}" · 레코드 <b>${b.rows}</b> · 판매 <b>${b.qty}</b> — 채널마스터 원천업태명에 없어 반영을 보류합니다`;
  });
  return `<div class="up-stats">${parts.join('<br>')}</div>`;
}
async function _upApplyAll(){
  if(_UP.busyAll)return;
  const queue=_upApplyOrder();
  if(!queue.length){showToast('반영할 준비된 파일이 없습니다.');return;}
  _UP.busyAll=true;
  let ok=0;
  for(let i=0;i<queue.length;i++){
    _UP.progress=(i+1)+'/'+queue.length+' 반영 중 — '+queue[i].name;
    if(await _upApply(queue[i].id,true))ok++;
  }
  _UP.busyAll=false;
  _UP.progress='';
  showToast(queue.length+'개 중 '+ok+'개 반영 완료',{type:ok===queue.length?'success':'error'});
  await _upRefreshSide();
}

// ── 그리기 ──
function _upRender(){
  const host=document.getElementById('page-admin-upload');
  if(!host)return;
  const nReady=_upApplyOrder().length;
  host.innerHTML=`
  <div class="card"><div class="card-hd">자동 반영<span class="card-hd-r">드라이브 수신함 폴더에 넣은 엑셀을 1시간마다 이 화면과 같은 규칙으로 반영</span></div>${_upInboxHtml()}</div>
  <div class="card"><div class="card-hd">데이터 현황<span class="card-hd-r">채널별 마지막 기준일 · 이번 달 빈 날짜(1일~어제, 업로드로그 기준)</span></div>${_upStatusHtml()}</div>
  <div class="card"><div class="card-hd">파일 업로드<span class="card-hd-r">하이마트·전자랜드·이마트 협력사 포털 엑셀 · ERP 매출이익리스트(백화점·폐쇄몰·렌탈)를 받은 그대로</span></div>
    <label class="up-drop" id="upDrop" ondragover="_upDragOver(event)" ondragleave="_upDragLeave()" ondrop="_upDrop(event)">
      <input type="file" id="upInput" multiple accept=".xlsx,.xls,.csv" onchange="_upPick(this)">
      <span class="up-drop-main">여기로 파일을 끌어다 놓거나 눌러서 선택</span>
      <span class="up-drop-sub">여러 개 한 번에 · .xlsx / .xls / .csv · 파일명은 포털 원본 그대로(기준일이 들어 있음)</span>
    </label>
    ${_UP.files.length?`<div class="up-bar">
      <button type="button" class="btn-primary up-btn" ${_UP.busyAll||!nReady?'disabled':''} onclick="_upApplyAll()">전체 반영 (${nReady})</button>
      ${_UP.progress?`<span class="up-progress">${_escHtml(_UP.progress)}</span>`:''}
      ${_UP.mastersErr?`<span class="up-err">마스터를 불러오지 못해 미매칭 수를 셀 수 없습니다: ${_escHtml(_UP.mastersErr)}</span>`:''}
    </div>`:''}
    <div class="up-cards">${_UP.files.map(_upCardHtml).join('')}</div>
  </div>
  <div class="card"><div class="card-hd">최근 업로드 로그<span class="card-hd-r">최근 50건</span></div>${_upLogHtml()}</div>`;
  _UP.files.forEach(f=>{
    if(!f.panelOpen)return;
    const items=_upUnmatched(f)||[];
    renderMappingPanel('upMap-'+f.id,items,{onSaved:()=>_upRender()});
  });
}

/* 드라이브 수신함 자동 반영(apps-script-offline-inbox.js) — 사용 여부·폴더·트리거·마지막 실행 결과, [지금 확인] = offline_processInbox
   (사용 여부·시각 범위와 관계없이 바로. 파일 수에 따라 몇 분 걸릴 수 있다 — 긴 요청 타임아웃) */
const _UP_INBOX_RESULT={success:['done','반영'],error:['error','오류'],skipped:['ready','건너뜀'],deferred:['applying','다음 실행']};
function _upInboxBy(by){return by==='trigger'?'자동(1시간마다)':by==='editor'?'편집기에서 실행':/^manual:/.test(by||'')?'지금 확인 · '+by.slice(7):(by||'');}
function _upInboxHtml(){
  if(_UP.inboxErr)return `<div class="up-err">자동 반영 상태를 불러오지 못했습니다: ${_escHtml(_UP.inboxErr)}</div>`;
  const s=_UP.inbox;
  if(!s)return '<div class="mp-empty">불러오는 중…</div>';
  const st=s.settings||{},last=s.last,busy=_UP.inboxBusy;
  const use=st.enabled?`<span class="off-ok">켜짐</span> · ${st.startHour}~${st.endHour}시 1시간마다 · 회당 최대 ${st.maxFiles}개 · 처리완료 보관 ${st.keepDays}일`
    :'<span class="off-miss">꺼짐</span> — 설정 탭 자동반영_사용 = N ([지금 확인]은 된다)';
  const trig=s.triggerInstalled===false?' · <span class="off-miss">트리거 없음 — 편집기에서 offline_installInboxTrigger 실행</span>':s.triggerInstalled?' · 트리거 설치됨':'';
  const folder=s.folderUrl?`<a href="${_escAttr(s.folderUrl)}" target="_blank" rel="noopener">수신함 폴더 열기</a>`:'<span class="off-miss">수신함 폴더 미등록 — Script Properties OFFLINE_INBOX_FOLDER_ID</span>';
  let lastHtml='<span class="off-muted">아직 실행 기록이 없습니다.</span>';
  if(last){
    const c=last.counts||{};
    lastHtml=`마지막 실행 <b>${_escHtml(last.at)}</b> (${_escHtml(_upInboxBy(last.by))}) · 반영 <b>${c.success||0}</b> · 오류 <b${c.error?' class="off-miss"':''}>${c.error||0}</b> · 건너뜀 <b>${c.skipped||0}</b> · 다음 실행으로 <b>${c.deferred||0}</b>`+
      `${last.trashed?` · 보관일수 지나 휴지통 <b>${last.trashed}</b>`:''} · Sheets API <b>${last.apiCalls||0}</b>회${last.apiFallbacks?` · <span class="off-miss">한도 초과로 이전 방식 대체 ${last.apiFallbacks}회</span>`:''}`+
      (last.note?`<br><span class="off-miss">${_escHtml(last.note)}</span>`:'')+
      ((last.warnings||[]).length?`<ul class="up-warn">${last.warnings.map(w=>'<li>'+_escHtml(w)+'</li>').join('')}</ul>`:'');
  }
  const files=last&&(last.files||[]).length?`<div class="tbl-wrap"><table class="cm-tbl"><thead><tr><th>파일</th><th>결과</th><th>내용</th></tr></thead><tbody>${last.files.map(f=>{
    const r=_UP_INBOX_RESULT[f.result]||['ready',f.result];
    return `<tr><td>${_escHtml(f.name)}</td><td><span class="up-chip ${r[0]}">${r[1]}</span></td><td>${_escHtml(f.detail||'')}</td></tr>`;}).join('')}</tbody></table></div>`:'';
  return `<div class="up-stats">${use}${trig}<br>${folder}<br>${lastHtml}</div>${files}
    <div class="up-bar"><button type="button" class="btn-primary up-btn" ${busy||!s.folderUrl?'disabled':''} onclick="_upInboxRun()">${busy?'확인 중… (몇 분 걸릴 수 있음)':'지금 확인'}</button>
    <span class="off-muted">이동·휴지통은 실행 계정에 공유 드라이브 콘텐츠 관리자 이상 권한이 있어야 합니다</span></div>`;
}
async function _upInboxRun(){
  if(_UP.inboxBusy)return;
  _UP.inboxBusy=true;_upRender();
  try{
    const r=await _offlineCall('offline_processInbox');
    if(r.busy)showToast(r.message||'다른 수신함 확인이 진행 중입니다.');
    else{const c=r.counts||{};showToast(`수신함 확인 — 반영 ${c.success||0} · 오류 ${c.error||0} · 건너뜀 ${c.skipped||0} · 다음 실행으로 ${c.deferred||0}`,{type:c.error?'error':'success'});}
  }catch(e){showToast('수신함 확인 실패: '+e.message,{type:'error'});}
  _UP.inboxBusy=false;
  await _upRefreshSide();
}

function _upStatusHtml(){
  if(_UP.statusErr)return `<div class="up-err">${_escHtml(_UP.statusErr)}</div>`;
  if(!_UP.status)return '<div class="mp-empty">불러오는 중…</div>';
  // 채널대분류 묶음 머리 줄 + 채널(서버가 채널대분류 → 정렬순서로 준다)
  let prev=null;
  const rows=_UP.status.channels.map(c=>{const cat=c.channelCategory||OFFLINE_UNCATEGORIZED,hd=cat!==prev?`<tr class="off-grp"><td colspan="4">${_escHtml(cat)}</td></tr>`:'';prev=cat;return hd+`<tr>
    <td>${_escHtml(c.name)}</td>
    <td>${c.salesLast?_escHtml(c.salesLast):'<span class="off-muted">없음</span>'}</td>
    <td>${c.stockLast?_escHtml(c.stockLast):'<span class="off-muted">없음</span>'}</td>
    <td>${c.missingDays.length?`<span class="off-miss">${_escHtml(_upDayRanges(c.missingDays))} (${c.missingDays.length}일)</span>`:'<span class="off-ok">없음</span>'}</td>
  </tr>`;}).join('');
  return `<div class="tbl-wrap"><table class="off-status"><thead><tr><th>채널</th><th>판매 마지막 기준일</th><th>재고 마지막 기준일</th><th>이번 달 빈 날짜 (${_escHtml(_UP.status.month)})</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const _UP_STATUS_LABEL={parsing:'분석 중',ready:'준비',applying:'반영 중…',done:'반영 완료',error:'오류'};
function _upCardHtml(f){
  const p=f.parse;
  const chip=`<span class="up-chip ${f.status}">${_UP_STATUS_LABEL[f.status]}</span>`;
  const busy=f.status==='applying'||_UP.busyAll;
  const acts=`<div class="up-acts">
    ${p&&p.ok?`<button type="button" class="btn-primary up-btn" ${busy||p.blocked?'disabled':''} ${p.blocked?'title="반영할 수 없는 양식"':''} onclick="_upApply(${f.id})">${f.status==='done'?'다시 반영':'반영'}</button>`:''}
    <button type="button" class="btn-cancel up-btn" ${busy?'disabled':''} onclick="_upRemove(${f.id})">제거</button></div>`;
  const typeSel=`<span class="f-lbl">유형</span><select class="f-sel" ${busy?'disabled':''} onchange="_upSetType(${f.id},this.value)">
    ${p&&p.ok?'':'<option value="">— 유형 선택 —</option>'}
    ${OfflineParsers.TYPE_ORDER.map(t=>`<option value="${t}"${p&&p.type===t?' selected':''}>${_escHtml(OfflineParsers.TYPES[t].label)}</option>`).join('')}</select>`;
  if(f.status==='parsing')return `<div class="up-card"><div class="up-card-hd"><span class="up-fname">${_escHtml(f.name)}</span>${chip}</div></div>`;
  if(!p||!p.ok){
    return `<div class="up-card error"><div class="up-card-hd"><span class="up-fname">${_escHtml(f.name)}</span>${chip}${acts}</div>
      ${f.rows?`<div class="up-row">${typeSel}</div>`:''}<div class="up-err">${_escHtml(f.error)}</div></div>`;
  }
  const plan=_upPlan(f);
  let dateCtl='';
  if(p.kind==='period'){
    const s=f.edits.replaceStart||(p.period&&p.period.start)||'',e=f.edits.replaceEnd||(p.period&&p.period.end)||'';
    dateCtl=`<span class="f-lbl">교체 기간</span>
      <input type="date" class="f-inp" value="${s}" ${busy?'disabled':''} onchange="_upSetRange(${f.id},'replaceStart',this.value)">~
      <input type="date" class="f-inp" value="${e}" ${busy?'disabled':''} onchange="_upSetRange(${f.id},'replaceEnd',this.value)">
      <span class="off-muted">${p.periodFrom==='file'?'기본값 = 파일명의 기간':'기본값 = 파일 안의 최소~최대 날짜'}</span>`;
    if(p.type==='EMART_DAILY_SALES')dateCtl+=`<span class="f-lbl">연도</span><input type="number" class="f-inp up-year" value="${p.year}" ${busy?'disabled':''} onchange="_upSetYear(${f.id},this.value)">`;
  }else{
    const b=f.edits.baseDate||p.baseDate;
    dateCtl=`<span class="f-lbl">${p.kind==='snapshot'?'재고 기준일':'기준일'}</span><input type="date" class="f-inp${b?'':' up-need'}" value="${b}" ${busy?'disabled':''} onchange="_upSetBase(${f.id},this.value)">
      <span class="off-muted">${_upBaseNote(f,p,b)}</span>`;
  }
  const pr=p.plannedRows;
  const planned=p.kind==='period'?`판매 <b>${pr.sales}</b>행`
    :`채널 재고 <b>${pr.stockDaily}</b> · 점포 재고 <b>${pr.stockStore}</b>${p.kind==='himart'?` · 누적스냅샷 <b>${pr.himartSnap}</b> (판매는 반영 때 계산)`:''}`;
  const gubun=p.summary.gubun?'<br>구분: '+Object.keys(p.summary.gubun).map(g=>_escHtml(g)+' <b>'+p.summary.gubun[g]+'</b>건').join(' · '):'';
  const um=_upUnmatched(f);
  const umHtml=um==null?'<span class="off-muted">미매칭 코드 수: 마스터 확인 중</span>'
    :um.length?`<button type="button" class="up-unm" onclick="_upTogglePanel(${f.id})">미매칭 코드 ${um.length}개 ${f.panelOpen?'▴ 닫기':'▾ 여기서 매핑'}</button> <span class="off-muted">매핑 없이 반영해도 원장에는 원본코드로 저장됩니다</span>`
    :'<span class="up-unm none">모든 코드 매핑됨</span>';
  return `<div class="up-card ${f.status==='done'?'done':''}">
    <div class="up-card-hd"><span class="up-fname">${_escHtml(f.name)}</span>${chip}<span class="off-muted">${_escHtml(_offlineChannelLabel(p.channelId))}</span>${acts}</div>
    <div class="up-row">${typeSel}${dateCtl}</div>
    <div class="up-stats">헤더 <b>${p.headerRow}</b>행 · 원본 <b>${p.rawRowCount}</b>행 · 반영 예정 ${planned} · 점포 <b>${p.summary.storeCount}</b> · 원본코드 <b>${p.summary.codeCount}</b>종${gubun}</div>
    ${_upSplitHtml(p)}${_upErpHtml(f,p)}
    <div class="up-row">${umHtml}</div>
    ${p.warnings.length?`<ul class="up-warn">${p.warnings.map(w=>'<li>'+_escHtml(w)+'</li>').join('')}</ul>`:''}
    ${f.error?`<div class="up-err">${_escHtml(f.error)}</div>`:(plan.error&&(p.kind==='period'||plan.blocked)?`<div class="up-err">${plan.blocked?'⛔ ':''}${_escHtml(plan.error)}</div>`:'')}
    ${f.result?_upResultHtml(f.result):''}
    ${f.panelOpen?`<div class="up-panel" id="upMap-${f.id}"></div>`:''}
  </div>`;
}
function _upResultHtml(r){
  const a=r.applied||{},rr=r.replaceRange||{};
  const parts=[];
  if(a.sales!=null)parts.push('판매 '+a.sales+'행'+(a.salesRemoved?' (기존 '+a.salesRemoved+'행 교체)':''));
  if(a.stockDaily!=null)parts.push('채널 재고 '+a.stockDaily);
  if(a.stockStore!=null)parts.push('점포 재고 '+a.stockStore);
  if(a.himartSnap!=null)parts.push('누적스냅샷 '+a.himartSnap);
  if(a.storesAdded)parts.push('새 점포 '+a.storesAdded);
  if(a.storesMoved)parts.push('채널 옮긴 점포 '+a.storesMoved);
  if(a.customersAdded)parts.push('거래처매핑에 추가 '+a.customersAdded);
  // 채널별(한 파일에 여러 채널 — 이마트·트레이더스, ERP 매출이익리스트는 금액도)
  if(a.byChannel)parts.push(Object.keys(a.byChannel).map(c=>{const b=a.byChannel[c];return _offlineChannelLabel(c)+(b.rows!=null?' '+b.rows+'행·판매 '+b.qty+(b.amount!=null?'·금액 ₩'+Math.round(b.amount).toLocaleString('ko-KR'):''):' 점포 '+b.stores+'·재고 '+b.stock);}).join(' / '));
  let range=rr.start?rr.start+' ~ '+rr.end:(rr.baseDate||'');
  if(rr.himart)range+=' · 판매 재계산: '+rr.himart.recomputed.map(x=>x.date+'('+(x.unit==='day'?'day':x.start+'~ period')+')').join(', ');
  return `<div class="up-result">✓ 반영 완료 — ${_escHtml(parts.join(' · '))}<br>교체 범위: ${_escHtml(range)} · 미매칭 ${r.unmatched?r.unmatched.length:0}개</div>`+
    (r.warnings&&r.warnings.length?`<ul class="up-warn">${r.warnings.map(w=>'<li>'+_escHtml(w)+'</li>').join('')}</ul>`:'');
}

function _upLogHtml(){
  if(_UP.logErr)return `<div class="up-err">${_escHtml(_UP.logErr)}</div>`;
  if(!_UP.log)return '<div class="mp-empty">불러오는 중…</div>';
  if(!_UP.log.length)return '<div class="mp-empty">아직 업로드 기록이 없습니다.</div>';
  const label=t=>OfflineParsers.TYPES[t]?OfflineParsers.TYPES[t].label:t;
  return `<div class="tbl-wrap"><table class="up-log"><thead><tr><th>시각</th><th>방식</th><th>파일명</th><th>유형</th><th>채널</th><th>기준일/기간</th>
    <th class="num-col">원본</th><th class="num-col">반영</th><th class="num-col">미매칭</th><th>상태</th><th>업로더</th><th>경고</th></tr></thead><tbody>${
    _UP.log.map(x=>`<tr><td>${_escHtml(x.at)}</td><td>${x.mode==='auto'?'<span class="up-chip done">자동 반영</span>':'<span class="off-muted">수동</span>'}</td><td>${_escHtml(x.fileName)}</td><td>${_escHtml(label(x.fileType))}</td><td>${_escHtml(_offlineChannelsLabel(x.channelId))}</td><td>${_escHtml(x.range)}</td>
      <td class="num-col">${x.rawRows}</td><td class="num-col">${x.appliedRows}</td><td class="num-col">${x.unmatched}</td>
      <td>${x.status==='성공'?'<span class="off-ok">성공</span>':'<span class="off-miss">'+_escHtml(x.status)+'</span>'}</td>
      <td>${_escHtml(x.uploader)}</td><td class="up-log-warn">${_escHtml(x.warnings)}${x.inboxNote?`<div class="off-miss">${_escHtml(x.inboxNote)}</div>`:''}</td></tr>`).join('')}</tbody></table></div>`;
}
