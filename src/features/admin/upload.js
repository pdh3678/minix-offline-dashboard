'use strict';
/* 데이터 업로드(#admin/upload) — 협력사 포털에서 받은 엑셀을 그대로 올리면 판별·파싱해 오프라인 원장에 반영.
   화면: ① 데이터 현황(offline_getStatus) ② 파일 카드(판별 유형·기준일·교체기간 수정, 미매칭 즉석 매핑, 반영)
         ③ 최근 업로드 로그(offline_getUploadLog)
   파일은 브라우저에서 파싱하고(src/features/offline/parsers.js) 정규화 레코드만 서버로 보낸다. 반영은 파일
   1개 = 요청 1개이고, 서버가 락으로 직렬화한다. 하이마트는 누적 차이 계산이라 기준일 오름차순으로 보낸다. */

const _UP={files:[],seq:0,status:null,statusErr:'',log:null,logErr:'',mastersErr:'',busyAll:false,progress:''};

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
    _offlineLoadMasters(true).then(()=>{_UP.mastersErr='';}).catch(e=>{_UP.mastersErr=e.message;})
  ]);
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
    f.rows=OfflineParsers.readWorkbookRows(XLSX,new Uint8Array(buf)).rows;
    _upParse(f);
  }catch(e){
    f.status='error';f.error='파일을 읽지 못했습니다: '+e.message;
  }
  _upRender();
}
// 판별·파싱(유형·기준일·연도를 고칠 때마다 다시 돈다 — 원본 행은 f.rows에 남아 있다)
function _upParse(f){
  f.parse=OfflineParsers.parseRows(f.rows,{fileName:f.name,type:f.edits.type||null,baseDate:f.edits.baseDate||'',year:f.edits.year||null,today:_upTodayStr()});
  f.status=f.parse.ok?'ready':'error';
  f.error=f.parse.ok?'':f.parse.error;
  f.result=null;
}
function _upFile(id){return _UP.files.find(x=>x.id===id);}
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
  if(p.kind==='period'){
    const s=f.edits.replaceStart||(p.period&&p.period.start)||'',e=f.edits.replaceEnd||(p.period&&p.period.end)||'';
    if(!s||!e)return{error:'교체 기간을 정하세요.'};
    if(s>e)return{error:'교체 기간의 시작이 끝보다 늦습니다.'};
    return{replaceStart:s,replaceEnd:e};
  }
  const b=f.edits.baseDate||p.baseDate;
  if(!b)return{error:'기준일을 선택하세요(파일명에 날짜가 없습니다).'};
  return{baseDate:b};
}
function _upUnmatched(f){
  const p=f.parse;
  if(!p||!p.ok||!OFFLINE_MASTERS)return null;
  return _offlineResolver().unmatched(p.channelId,p.codes).map(code=>({channelId:p.channelId,code,name:p.records.names[code]||''}));
}

async function _upApply(id,quiet){
  const f=_upFile(id);
  if(!f||f.status==='applying')return false;
  const plan=_upPlan(f);
  if(plan.error){f.error=plan.error;_upRender();return false;}
  f.status='applying';f.error='';f.result=null;_upRender();
  try{
    const payload=OfflineParsers.toUploadPayload(f.parse,Object.assign({fileName:f.name},plan));
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
// 한 파일에 여러 채널이 섞인 파일(split) — 채널별 레코드·점포·판매 합계
function _upSplitHtml(p){
  if(p.split!=='biz'||!p.summary.byBiz)return '';
  const parts=p.summary.byBiz.map(b=>{
    const c=_upBizChannel(b.biz);
    return c?`<span class="up-chip ready">${_escHtml(c.name)}</span> 업태명 "${_escHtml(b.biz)}" · 레코드 <b>${b.rows}</b> · 점포 <b>${b.stores}</b> · 판매 <b>${b.qty}</b>`
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
  <div class="card"><div class="card-hd">데이터 현황<span class="card-hd-r">채널별 마지막 기준일 · 이번 달 빈 날짜(1일~어제, 업로드로그 기준)</span></div>${_upStatusHtml()}</div>
  <div class="card"><div class="card-hd">파일 업로드<span class="card-hd-r">하이마트·전자랜드·이마트 협력사 포털 엑셀을 받은 그대로</span></div>
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

function _upStatusHtml(){
  if(_UP.statusErr)return `<div class="up-err">${_escHtml(_UP.statusErr)}</div>`;
  if(!_UP.status)return '<div class="mp-empty">불러오는 중…</div>';
  const rows=_UP.status.channels.map(c=>`<tr>
    <td>${_escHtml(c.name)}</td>
    <td>${c.salesLast?_escHtml(c.salesLast):'<span class="off-muted">없음</span>'}</td>
    <td>${c.stockLast?_escHtml(c.stockLast):'<span class="off-muted">없음</span>'}</td>
    <td>${c.missingDays.length?`<span class="off-miss">${_escHtml(_upDayRanges(c.missingDays))} (${c.missingDays.length}일)</span>`:'<span class="off-ok">없음</span>'}</td>
  </tr>`).join('');
  return `<div class="tbl-wrap"><table class="off-status"><thead><tr><th>채널</th><th>판매 마지막 기준일</th><th>재고 마지막 기준일</th><th>이번 달 빈 날짜 (${_escHtml(_UP.status.month)})</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const _UP_STATUS_LABEL={parsing:'분석 중',ready:'준비',applying:'반영 중…',done:'반영 완료',error:'오류'};
function _upCardHtml(f){
  const p=f.parse;
  const chip=`<span class="up-chip ${f.status}">${_UP_STATUS_LABEL[f.status]}</span>`;
  const busy=f.status==='applying'||_UP.busyAll;
  const acts=`<div class="up-acts">
    ${p&&p.ok?`<button type="button" class="btn-primary up-btn" ${busy?'disabled':''} onclick="_upApply(${f.id})">${f.status==='done'?'다시 반영':'반영'}</button>`:''}
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
      <span class="off-muted">기본값 = 파일 안의 최소~최대 날짜</span>`;
    if(p.type==='EMART_DAILY_SALES')dateCtl+=`<span class="f-lbl">연도</span><input type="number" class="f-inp up-year" value="${p.year}" ${busy?'disabled':''} onchange="_upSetYear(${f.id},this.value)">`;
  }else{
    const b=f.edits.baseDate||p.baseDate;
    dateCtl=`<span class="f-lbl">기준일</span><input type="date" class="f-inp${b?'':' up-need'}" value="${b}" ${busy?'disabled':''} onchange="_upSetBase(${f.id},this.value)">
      <span class="off-muted">${f.edits.baseDate?'직접 선택':(p.fileDate?'파일명에서 읽음':'파일명에 날짜 없음 — 선택 필요')}</span>`;
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
    <div class="up-card-hd"><span class="up-fname">${_escHtml(f.name)}</span>${chip}<span class="off-muted">${_escHtml(_offlineChannelName(p.channelId))}</span>${acts}</div>
    <div class="up-row">${typeSel}${dateCtl}</div>
    <div class="up-stats">헤더 <b>${p.headerRow}</b>행 · 원본 <b>${p.rawRowCount}</b>행 · 반영 예정 ${planned} · 점포 <b>${p.summary.storeCount}</b> · 원본코드 <b>${p.summary.codeCount}</b>종${gubun}</div>
    ${_upSplitHtml(p)}
    <div class="up-row">${umHtml}</div>
    ${p.warnings.length?`<ul class="up-warn">${p.warnings.map(w=>'<li>'+_escHtml(w)+'</li>').join('')}</ul>`:''}
    ${f.error?`<div class="up-err">${_escHtml(f.error)}</div>`:(plan.error&&p.kind==='period'?`<div class="up-err">${_escHtml(plan.error)}</div>`:'')}
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
  // 채널별(한 파일에 여러 채널 — 이마트·트레이더스)
  if(a.byChannel)parts.push(Object.keys(a.byChannel).map(c=>_offlineChannelName(c)+' '+a.byChannel[c].rows+'행·판매 '+a.byChannel[c].qty).join(' / '));
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
  return `<div class="tbl-wrap"><table class="up-log"><thead><tr><th>시각</th><th>파일명</th><th>유형</th><th>기준일/기간</th>
    <th class="num-col">원본</th><th class="num-col">반영</th><th class="num-col">미매칭</th><th>상태</th><th>업로더</th><th>경고</th></tr></thead><tbody>${
    _UP.log.map(x=>`<tr><td>${_escHtml(x.at)}</td><td>${_escHtml(x.fileName)}</td><td>${_escHtml(label(x.fileType))}</td><td>${_escHtml(x.range)}</td>
      <td class="num-col">${x.rawRows}</td><td class="num-col">${x.appliedRows}</td><td class="num-col">${x.unmatched}</td>
      <td>${x.status==='성공'?'<span class="off-ok">성공</span>':'<span class="off-miss">'+_escHtml(x.status)+'</span>'}</td>
      <td>${_escHtml(x.uploader)}</td><td class="up-log-warn">${_escHtml(x.warnings)}</td></tr>`).join('')}</tbody></table></div>`;
}
