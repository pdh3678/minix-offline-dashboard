'use strict';
/* 코드 매핑(#admin/code-mapping) [제품마스터] 탭 — 표준 SKU 목록을 보고 표준명·품목군·모델·옵션·활성·정렬순서를 고친다.
   · 품목군을 바꾸면 이 SKU에 연결된 코드 전부의 집계(품목군·모델·대분류)가 옮겨 가므로, 연결 코드가 있으면 한 번 더 확인한다
   · 삭제는 없다 — 비활성(활성=N)으로 바꾸면 새 매핑 드롭다운에서만 숨고 과거 집계에는 그대로 쓰인다
   저장 = offline_saveSku(수정 모드). 서버가 캐시를 무효화하므로 마스터를 다시 받아 그린다. */

const _SKM={filter:{line:'',active:'',q:''},editId:null,edit:null,confirm:'',busy:false};

// 활성 매핑(sku_id가 있는 코드) 수 — 품목군을 바꾸면 이만큼의 코드 집계가 바뀐다
function _skmMappedCount(id){return ((OFFLINE_MASTERS&&OFFLINE_MASTERS.mappings)||[]).filter(m=>m.skuId===id).length;}
function _skmList(){
  const f=_SKM.filter,q=String(f.q||'').trim().toLowerCase();
  const lineIdx=k=>{const i=PRODUCT_CATALOG.findIndex(l=>l.key===k);return i<0?99:i;};
  return ((OFFLINE_MASTERS&&OFFLINE_MASTERS.skus)||[]).filter(s=>{
    if(f.line&&s.line!==f.line)return false;
    if(f.active==='Y'&&s.active==='N')return false;
    if(f.active==='N'&&s.active!=='N')return false;
    if(q&&[s.skuId,s.name,s.model,s.option,s.note].join(' ').toLowerCase().indexOf(q)<0)return false;
    return true;
  }).sort((a,b)=>lineIdx(a.line)-lineIdx(b.line)||(Number(a.order)||9999)-(Number(b.order)||9999)||String(a.skuId).localeCompare(String(b.skuId)));
}
function _skmSetFilter(k,v,tableOnly){_SKM.filter[k]=v;if(tableOnly)_skmRenderTable();else _cmRender();}

function _skmHtml(){
  const f=_SKM.filter,m=OFFLINE_MASTERS||{};
  const opt=(v,l,cur)=>`<option value="${_escAttr(v)}"${v===cur?' selected':''}>${_escHtml(l)}</option>`;
  const n=(m.skus||[]).length,off=(m.skus||[]).filter(s=>s.active==='N').length;
  return `<div class="card"><div class="card-hd">제품마스터<span class="card-hd-r">${n}개 SKU${off?` · 비활성 ${off}`:''} · 비활성 SKU는 새 매핑 드롭다운에서 숨고 과거 집계에는 그대로 쓰입니다</span></div>
    <div class="cm-filters">
      <select class="f-sel" onchange="_skmSetFilter('line',this.value)">${opt('','전체 품목군',f.line)}${PRODUCT_CATALOG.map(l=>opt(l.key,l.label,f.line)).join('')}</select>
      <select class="f-sel" onchange="_skmSetFilter('active',this.value)">${opt('','활성·비활성 전체',f.active)}${opt('Y','활성만',f.active)}${opt('N','비활성만',f.active)}</select>
      <input class="f-inp" type="search" placeholder="sku_id·표준명·모델·옵션 검색" value="${_escAttr(f.q)}" oninput="_skmSetFilter('q',this.value,true)">
    </div><div id="skmTable">${_skmTableHtml()}</div></div>`;
}
function _skmRenderTable(){const el=document.getElementById('skmTable');if(el)el.innerHTML=_skmTableHtml();}
function _skmTableHtml(){
  if(!OFFLINE_MASTERS)return '<div class="mp-empty">불러오는 중…</div>';
  const list=_skmList();
  if(!list.length)return `<div class="mp-empty">${(OFFLINE_MASTERS.skus||[]).length?'조건에 맞는 SKU가 없습니다.':'아직 SKU가 없습니다 — 코드 매핑의 "＋ 새 SKU 만들기"로 만드세요.'}</div>`;
  return `<div class="tbl-wrap"><table class="cm-tbl skm-tbl"><thead><tr><th>sku_id</th><th>표준명</th><th>품목군</th><th>모델</th><th>옵션</th><th>활성</th><th class="num-col">정렬순서</th><th class="num-col">연결 코드</th><th>비고</th><th></th></tr></thead><tbody>${
    list.map(s=>_SKM.editId===s.skuId?_skmEditRowHtml(s):_skmRowHtml(s)).join('')}</tbody></table></div>`;
}
function _skmRowHtml(s){
  const off=s.active==='N',n=_skmMappedCount(s.skuId),confirmOff=_SKM.confirm==='off:'+s.skuId;
  return `<tr class="${off?'cm-off':''}"><td class="mp-code">${_escHtml(s.skuId)}</td><td class="cm-wrap">${_escHtml(s.name)}</td><td>${_escHtml(_ofLineLabel(s.line))}</td>
    <td>${_escHtml(s.model)}</td><td>${_escHtml(s.option)}</td><td>${off?'<span class="off-miss">비활성</span>':'<span class="off-ok">활성</span>'}</td>
    <td class="num-col">${_escHtml(s.order)}</td><td class="num-col">${n}</td><td class="cm-wrap cm-reg">${_escHtml(s.note)}</td>
    <td><div class="cm-acts"><button type="button" class="btn-cancel up-btn" ${_SKM.busy?'disabled':''} onclick="_skmStartEdit('${_escAttr(s.skuId)}')">수정</button>
      <button type="button" class="btn-cancel up-btn${confirmOff?' cm-danger':''}" ${_SKM.busy?'disabled':''} onclick="_skmToggleActive('${_escAttr(s.skuId)}')">${off?'활성화':(confirmOff?'비활성화 확인':'비활성화')}</button></div>
      ${confirmOff?'<div class="cm-reg">새 매핑 드롭다운에서 숨깁니다(과거 집계는 유지)</div>':''}</td></tr>`;
}
function _skmEditRowHtml(s){
  const e=_SKM.edit,line=PRODUCT_CATALOG.find(l=>l.key===e.line)||PRODUCT_CATALOG[0];
  const n=_skmMappedCount(s.skuId),lineChanged=e.line!==s.line,confirm=_SKM.confirm==='line:'+s.skuId;
  return `<tr><td class="mp-code">${_escHtml(s.skuId)}</td>
    <td><input class="f-inp" value="${_escAttr(e.name)}" oninput="_skmEditSet('name',this.value)"></td>
    <td><select class="f-sel" onchange="_skmEditSet('line',this.value,true)">${PRODUCT_CATALOG.map(l=>`<option value="${_escAttr(l.key)}"${l.key===e.line?' selected':''}>${_escHtml(l.label)}</option>`).join('')}</select></td>
    <td><input class="f-inp" list="skmModels" value="${_escAttr(e.model)}" oninput="_skmEditSet('model',this.value)"><datalist id="skmModels">${line.models.map(m=>`<option value="${_escAttr(m.label)}"></option>`).join('')}</datalist></td>
    <td><input class="f-inp" value="${_escAttr(e.option)}" oninput="_skmEditSet('option',this.value)"></td>
    <td><select class="f-sel mp-type" onchange="_skmEditSet('active',this.value)"><option value="Y"${e.active!=='N'?' selected':''}>활성</option><option value="N"${e.active==='N'?' selected':''}>비활성</option></select></td>
    <td><input class="f-inp tg-inp" value="${_escAttr(e.order)}" oninput="_skmEditSet('order',this.value)"></td>
    <td class="num-col">${n}</td>
    <td><input class="f-inp" value="${_escAttr(e.note)}" oninput="_skmEditSet('note',this.value)"></td>
    <td><div class="cm-acts"><button type="button" class="btn-primary up-btn${confirm?' cm-danger':''}" ${_SKM.busy?'disabled':''} onclick="_skmSave()">${confirm?'변경 확인':'저장'}</button>
      <button type="button" class="btn-cancel up-btn" onclick="_skmCancel()">취소</button></div>
      ${lineChanged&&n?`<div class="up-err">이 SKU에 연결된 코드 ${n}개의 집계가 바뀝니다 (${_escHtml(_ofLineLabel(s.line))} → ${_escHtml(_ofLineLabel(e.line))})${confirm?' — 한 번 더 누르면 저장':''}</div>`:''}</td></tr>`;
}
function _skmStartEdit(id){
  const s=((OFFLINE_MASTERS&&OFFLINE_MASTERS.skus)||[]).find(x=>x.skuId===id);if(!s)return;
  _SKM.editId=id;_SKM.confirm='';
  _SKM.edit={name:s.name||'',line:s.line,model:s.model||'',option:s.option||'',active:s.active==='N'?'N':'Y',order:s.order==null?'':String(s.order),note:s.note||''};
  _skmRenderTable();
}
// 입력 중에는 표를 다시 그리지 않는다(포커스 유지) — 품목군을 바꿀 때만(모델 후보·경고 문구 때문에) 다시 그림
function _skmEditSet(k,v,rerender){if(!_SKM.edit)return;_SKM.edit[k]=v;_SKM.confirm='';if(rerender)_skmRenderTable();}
function _skmCancel(){_SKM.editId=null;_SKM.edit=null;_SKM.confirm='';_skmRenderTable();}
async function _skmSave(){
  const id=_SKM.editId,e=_SKM.edit;
  const s=((OFFLINE_MASTERS&&OFFLINE_MASTERS.skus)||[]).find(x=>x.skuId===id);
  if(!s||!e)return;
  if(!String(e.name).trim()){showToast('표준명을 입력하세요.',{type:'error'});return;}
  if(String(e.order).trim()!==''&&!isFinite(Number(e.order))){showToast('정렬순서는 숫자여야 합니다.',{type:'error'});return;}
  // 품목군 변경 + 연결 코드가 있으면 두 번 눌러야 저장(브라우저 확인창 대신 버튼이 "변경 확인"으로 바뀐다)
  if(e.line!==s.line&&_skmMappedCount(id)&&_SKM.confirm!=='line:'+id){_SKM.confirm='line:'+id;_skmRenderTable();return;}
  await _skmSend({skuId:id,name:String(e.name).trim(),line:e.line,model:String(e.model).trim(),option:String(e.option).trim(),active:e.active,order:String(e.order).trim(),note:String(e.note).trim()},'SKU '+id+'를 저장했습니다.');
}
async function _skmToggleActive(id){
  const s=((OFFLINE_MASTERS&&OFFLINE_MASTERS.skus)||[]).find(x=>x.skuId===id);if(!s)return;
  const on=s.active==='N';
  if(!on&&_SKM.confirm!=='off:'+id){_SKM.confirm='off:'+id;_skmRenderTable();return;}
  await _skmSend({skuId:id,name:s.name,line:s.line,active:on?'Y':'N'},on?'SKU '+id+'를 다시 활성화했습니다.':'SKU '+id+'를 비활성화했습니다 — 새 매핑 드롭다운에서 숨겨집니다.');
}
async function _skmSend(sku,ok){
  if(_SKM.busy)return;
  _SKM.busy=true;_skmRenderTable();
  try{
    const j=await _offlineCall('offline_saveSku',{sku});
    _SKM.editId=null;_SKM.edit=null;_SKM.confirm='';
    showToast(ok+(j.lineChanged&&j.mappedCodes?` 연결 코드 ${j.mappedCodes}개의 집계가 새 품목군으로 옮겨 갑니다.`:''),{type:'success'});
    await _offlineLoadMasters(true);
  }catch(err){showToast('저장 실패: '+err.message,{type:'error'});}
  finally{_SKM.busy=false;_cmRender();}
}
