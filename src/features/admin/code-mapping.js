'use strict';
/* 코드 매핑(#admin/code-mapping) — 채널마다 다른 원본코드를 표준 SKU에 연결한다.
   위: 미매칭 코드(offline_getUnmatched) — 데이터 업로드 카드와 같은 매핑 패널(mapping-panel.js)
   아래: 전체 매핑 표 — 채널·품목군·재고구분 필터, 검색, 수정, 비활성화(sku_id 비움 → 미매칭으로 복귀)
   저장하면 마스터(offline: 캐시는 서버가 무효화)와 미매칭 목록을 다시 받는다. */

const _CM={tab:'mapping',unmatched:null,err:'',filter:{ch:'',line:'',type:'',q:''},editKey:null,edit:null,confirmKey:null,busy:false};
const _cmKey=m=>m.channelId+'\u0001'+m.code;

function mountCodeMappingPage(){
  _cmRender();
  _cmLoad();
}
PAGE_MOUNTS['admin-code-mapping']=mountCodeMappingPage;

async function _cmLoad(){
  try{
    const [,un]=await Promise.all([_offlineLoadMasters(true),_offlineCall('offline_getUnmatched')]);
    _CM.unmatched=un.items;_CM.err='';
  }catch(e){_CM.err=e.message;}
  _cmRender();
}

function _cmRender(){
  const host=document.getElementById('page-admin-code-mapping');
  if(!host)return;
  if(_CM.err&&!OFFLINE_MASTERS){host.innerHTML=`<div class="card"><div class="card-hd">코드 매핑</div><div class="up-err">${_escHtml(_CM.err)}</div></div>`;return;}
  // [코드 매핑 | 제품마스터] — 제품마스터 탭은 sku-master.js
  const tabs=`<div class="subtabs open">${[['mapping','코드 매핑'],['skus','제품마스터']].map(([k,l])=>`<button type="button" class="stab${_CM.tab===k?' sam':''}" onclick="_cmSetTab('${k}')">${l}</button>`).join('')}</div>`;
  if(_CM.tab==='skus'){host.innerHTML=tabs+_skmHtml();return;}
  const n=_CM.unmatched?_CM.unmatched.length:null;
  host.innerHTML=tabs+`
  <div class="card"><div class="card-hd">미매칭 코드${n!=null?' '+n+'개':''}<span class="card-hd-r">제안 = 같은 모델명이 이미 매핑된 SKU · 확정은 저장 버튼으로</span></div>
    ${_CM.err?`<div class="up-err">${_escHtml(_CM.err)}</div>`:''}
    <div id="cmUnmatched">${_CM.unmatched?'':'<div class="mp-empty">불러오는 중…</div>'}</div></div>
  <div class="card"><div class="card-hd">전체 매핑<span class="card-hd-r" id="cmCount"></span></div>
    ${_cmFiltersHtml()}<div id="cmTable"></div></div>`;
  if(_CM.unmatched){
    renderMappingPanel('cmUnmatched',_CM.unmatched.map(u=>({channelId:u.channelId,code:u.code,name:u.name,count:u.count,lastSeen:u.lastSeen})),
      {showChannel:true,showStats:true,onSaved:()=>_cmLoad()});
  }
  _cmRenderTable();
}

function _cmSetTab(t){_CM.tab=t;_cmRender();}

function _cmFiltersHtml(){
  const f=_CM.filter,m=OFFLINE_MASTERS||{};
  const opt=(v,label,cur)=>`<option value="${_escAttr(v)}"${v===cur?' selected':''}>${_escHtml(label)}</option>`;
  return `<div class="cm-filters">
    <select class="f-sel" onchange="_cmSetFilter('ch',this.value)">${opt('','전체 채널',f.ch)}${(m.channels||[]).map(c=>opt(c.channelId,c.name,f.ch)).join('')}</select>
    <select class="f-sel" onchange="_cmSetFilter('line',this.value)">${opt('','전체 품목군',f.line)}${PRODUCT_CATALOG.map(l=>opt(l.key,l.label,f.line)).join('')}${opt('-','비활성(SKU 없음)',f.line)}</select>
    <select class="f-sel" onchange="_cmSetFilter('type',this.value)">${opt('','전체 재고구분',f.type)}${OfflineResolver.STOCK_TYPES.map(t=>opt(t,t,f.type)).join('')}</select>
    <input class="f-inp" type="search" placeholder="원본코드·상품명·SKU 검색" value="${_escAttr(f.q)}" oninput="_cmSetFilter('q',this.value,true)">
  </div>`;
}
function _cmSetFilter(k,v,tableOnly){
  _CM.filter[k]=v;
  // 검색어 입력 중에는 표만 다시 그린다 — 입력칸을 다시 만들면 포커스가 날아간다
  if(tableOnly)_cmRenderTable();else _cmRender();
}

// 필터·검색을 통과한 매핑(비활성 포함). 품목군은 매핑된 SKU의 품목군, '-'는 SKU가 비어 있는 비활성 매핑
function _cmFilteredMappings(){
  const f=_CM.filter,m=OFFLINE_MASTERS||{};
  const skuById={};(m.skus||[]).forEach(s=>{skuById[s.skuId]=s;});
  const q=String(f.q||'').trim().toLowerCase();
  return (m.mappings||[]).filter(x=>{
    const sku=skuById[x.skuId];
    if(f.ch&&x.channelId!==f.ch)return false;
    if(f.line==='-'){if(x.skuId)return false;}
    else if(f.line&&(!sku||sku.line!==f.line))return false;
    if(f.type&&x.stockType!==f.type)return false;
    if(q&&[x.code,x.name,x.skuId,sku&&sku.name].join(' ').toLowerCase().indexOf(q)<0)return false;
    return true;
  }).sort((a,b)=>String(a.channelId).localeCompare(String(b.channelId))||String(a.code).localeCompare(String(b.code)));
}

function _cmRenderTable(){
  const host=document.getElementById('cmTable');
  if(!host)return;
  const m=OFFLINE_MASTERS;
  if(!m){host.innerHTML='<div class="mp-empty">불러오는 중…</div>';return;}
  const list=_cmFilteredMappings();
  const cnt=document.getElementById('cmCount');
  if(cnt)cnt.textContent=list.length+' / '+(m.mappings||[]).length+'건';
  if(!list.length){host.innerHTML=`<div class="mp-empty">${(m.mappings||[]).length?'조건에 맞는 매핑이 없습니다.':'아직 매핑이 없습니다 — 위 미매칭 코드에서 SKU를 연결하세요.'}</div>`;return;}
  const skuById={};(m.skus||[]).forEach(s=>{skuById[s.skuId]=s;});
  const lineLabel=k=>{const l=PRODUCT_CATALOG.find(x=>x.key===k);return l?l.label:k;};
  _CM.rows=list;
  host.innerHTML=`<div class="tbl-wrap"><table class="cm-tbl"><thead><tr><th>채널</th><th>원본코드</th><th>원본상품명</th><th>SKU</th><th>품목군</th>
    <th>재고구분</th><th>등록</th><th>비고</th><th></th></tr></thead><tbody>${list.map((x,i)=>{
      const k=_cmKey(x),sku=skuById[x.skuId],off=!x.skuId;
      if(_CM.editKey===k)return _cmEditRowHtml(x,i);
      return `<tr class="${off?'cm-off':''}">
        <td>${_escHtml(_offlineChannelName(x.channelId))}</td><td class="mp-code">${_escHtml(x.code)}</td><td class="cm-wrap">${_escHtml(x.name)}</td>
        <td class="cm-wrap">${off?'<span class="off-miss">비활성</span>':(sku?_escHtml(sku.name)+'<div class="cm-reg">'+_escHtml(x.skuId)+'</div>':_escHtml(x.skuId))}</td>
        <td>${sku?_escHtml(lineLabel(sku.line)):''}</td><td>${_escHtml(x.stockType)}</td>
        <td class="cm-reg">${_escHtml(x.registeredAt)}<br>${_escHtml(x.registeredBy)}</td><td class="cm-wrap cm-reg">${_escHtml(x.note)}</td>
        <td><div class="cm-acts">
          <button type="button" class="btn-cancel up-btn" ${_CM.busy?'disabled':''} onclick="_cmStartEdit(${i})">${off?'다시 매핑':'수정'}</button>
          ${off?'':`<button type="button" class="btn-cancel up-btn${_CM.confirmKey===k?' cm-danger':''}" ${_CM.busy?'disabled':''} onclick="_cmDeactivate(${i})">${_CM.confirmKey===k?'비활성화 확인':'비활성화'}</button>`}
        </div></td></tr>`;
    }).join('')}</tbody></table></div>`;
}
function _cmEditRowHtml(x,i){
  const e=_CM.edit;
  return `<tr><td>${_escHtml(_offlineChannelName(x.channelId))}</td><td class="mp-code">${_escHtml(x.code)}</td><td class="cm-wrap">${_escHtml(x.name)}</td>
    <td colspan="2"><select class="f-sel" onchange="_cmEditSet('skuId',this.value)">${_mpSkuOptions(e.skuId)}</select></td>
    <td><select class="f-sel mp-type" onchange="_cmEditSet('stockType',this.value)">${OfflineResolver.STOCK_TYPES.map(t=>`<option${t===e.stockType?' selected':''}>${t}</option>`).join('')}</select></td>
    <td class="cm-reg">저장하면 오늘·<br>내 이메일로 기록</td>
    <td><input class="f-inp" value="${_escAttr(e.note)}" oninput="_cmEditSet('note',this.value)"></td>
    <td><div class="cm-acts"><button type="button" class="btn-primary up-btn" ${_CM.busy?'disabled':''} onclick="_cmSaveEdit(${i})">저장</button>
      <button type="button" class="btn-cancel up-btn" onclick="_cmCancelEdit()">취소</button></div></td></tr>`;
}
function _cmStartEdit(i){
  const x=_CM.rows[i];
  _CM.editKey=_cmKey(x);_CM.confirmKey=null;
  _CM.edit={skuId:x.skuId||'',stockType:x.stockType||OfflineResolver.guessStockType(x.code,x.name),note:x.note||''};
  _cmRenderTable();
}
function _cmEditSet(k,v){if(_CM.edit)_CM.edit[k]=v;}
function _cmCancelEdit(){_CM.editKey=null;_CM.edit=null;_cmRenderTable();}
async function _cmSaveEdit(i){
  const x=_CM.rows[i],e=_CM.edit;
  if(!e.skuId){showToast('SKU를 고르세요.',{type:'error'});return;}
  await _cmSend([{op:'upsert',channelId:x.channelId,code:x.code,skuId:e.skuId,stockType:e.stockType,name:x.name,note:e.note}],'매핑을 저장했습니다.');
}
// 비활성화는 두 번 눌러야 한다(브라우저 확인창 대신 버튼이 "비활성화 확인"으로 바뀜)
async function _cmDeactivate(i){
  const x=_CM.rows[i],k=_cmKey(x);
  if(_CM.confirmKey!==k){_CM.confirmKey=k;_cmRenderTable();return;}
  await _cmSend([{op:'deactivate',channelId:x.channelId,code:x.code}],'비활성화했습니다 — 이 코드는 미매칭 목록으로 돌아갑니다.');
}
async function _cmSend(items,okMsg){
  if(_CM.busy)return;
  _CM.busy=true;_cmRenderTable();
  try{
    await _offlineCall('offline_saveMapping',{items});
    _CM.editKey=null;_CM.edit=null;_CM.confirmKey=null;
    showToast(okMsg,{type:'success'});
    _CM.busy=false;
    await _cmLoad();
  }catch(err){
    showToast('저장 실패: '+err.message,{type:'error'});
  }finally{
    _CM.busy=false;_cmRenderTable();
  }
}
