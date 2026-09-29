'use strict';
/* 코드 매핑 패널 — 미매칭 원본코드를 표준 SKU에 연결한다. 코드 매핑 화면(#admin/code-mapping)의 미매칭 목록과
   데이터 업로드 화면의 파일 카드("미매칭 코드 N개" → 그 자리에서 매핑)가 이 한 벌을 같이 쓴다.

   제안은 제안일 뿐이다: 같은 모델명이 이미 매핑된 SKU를 칩으로 보여 주고, 누르면 그 줄에 채워지고,
   저장 버튼을 눌러야 확정된다. 재고구분도 코드·상품명으로 추정해 미리 골라 두지만 저장 전까지는 바꿀 수 있다.

   renderMappingPanel(hostId, items, opts)
     items  [{channelId, code, name, count?, lastSeen?}]
     opts   { showChannel, showStats, onSaved() }
   패널 상태는 hostId별로 남는다(다시 그려도 고른 SKU·체크가 유지됨 — 키는 채널+원본코드). */
const _MP={};
const _mpKey=it=>it.channelId+'\u0001'+it.code;

// 품목군별 optgroup — 활성 SKU만(이미 골라 둔 값이 비활성이면 그것도 보여 준다)
function _mpSkuOptions(selected){
  const skus=((OFFLINE_MASTERS&&OFFLINE_MASTERS.skus)||[]);
  const byOrder=(a,b)=>(Number(a.order)||9999)-(Number(b.order)||9999)||String(a.name).localeCompare(String(b.name),'ko');
  return '<option value="">— SKU 선택 —</option>'+PRODUCT_CATALOG.map(line=>{
    const items=skus.filter(s=>s.line===line.key&&(s.active!=='N'||s.skuId===selected)).sort(byOrder);
    if(!items.length)return '';
    return `<optgroup label="${_escAttr(line.label)}">`+items.map(s=>
      `<option value="${_escAttr(s.skuId)}"${s.skuId===selected?' selected':''}>${_escHtml(s.name)} · ${_escHtml(s.skuId)}${s.active==='N'?' (비활성)':''}</option>`
    ).join('')+'</optgroup>';
  }).join('');
}
function _mpSkuName(id){
  const s=((OFFLINE_MASTERS&&OFFLINE_MASTERS.skus)||[]).find(x=>x.skuId===id);
  return s?s.name:id;
}

// 새 SKU 표준명 자동 생성 — "품목군 표시명 + 모델"(모델이 이미 품목군 이름으로 시작하면 모델만) + 옵션
function _mpAutoName(lineKey,model,option){
  const line=PRODUCT_CATALOG.find(l=>l.key===lineKey);
  const label=line?line.label:'';
  const m=String(model||'').trim(),o=String(option||'').trim();
  let base=m?(m.replace(/\s/g,'').indexOf(label.replace(/\s/g,''))===0?m:(label+' '+m)):label;
  return (base+(o?' '+o:'')).trim();
}

function renderMappingPanel(hostId,items,opts){
  const st=_MP[hostId]||(_MP[hostId]={sel:{},ns:null,busy:false,msg:''});
  st.items=items||[];st.opts=opts||{};
  const host=document.getElementById(hostId);
  if(!host)return;
  const O=st.opts;
  const masters=OFFLINE_MASTERS||{};
  const rows=st.items.map((it,i)=>{
    const k=_mpKey(it);
    const sel=st.sel[k]||(st.sel[k]={skuId:'',stockType:OfflineResolver.guessStockType(it.code,it.name),checked:false});
    const sugg=OfflineResolver.suggestSkus(masters,it.code,it.name)[0];
    const suggHtml=sugg&&sugg.skuId!==sel.skuId
      ?`<div class="mp-sugg">제안(모델 ${_escHtml(sugg.model)}): <button type="button" class="mp-chip" onclick="_mpApplySugg('${hostId}',${i})">${_escHtml(_mpSkuName(sugg.skuId))}</button></div>`:'';
    return `<tr>
      ${O.showChannel?`<td>${_escHtml(_offlineChannelName(it.channelId))}</td>`:''}
      <td class="mp-code">${_escHtml(it.code)}</td>
      <td>${_escHtml(it.name||'')}</td>
      ${O.showStats?`<td class="num-col">${_escHtml(it.count)}</td><td>${_escHtml(it.lastSeen||'')}</td>`:''}
      <td><select class="f-sel mp-sku" onchange="_mpSetSku('${hostId}',${i},this.value)">${_mpSkuOptions(sel.skuId)}</select>
        ${suggHtml}<div><button type="button" class="mp-link" onclick="_mpOpenNewSku('${hostId}',${i})">＋ 새 SKU 만들기</button></div></td>
      <td><select class="f-sel mp-type" onchange="_mpSetType('${hostId}',${i},this.value)">${OfflineResolver.STOCK_TYPES.map(t=>
        `<option${t===sel.stockType?' selected':''}>${t}</option>`).join('')}</select></td>
      <td><input type="checkbox" title="저장 대상"${sel.checked?' checked':''} onchange="_mpCheck('${hostId}',${i},this.checked)"></td>
    </tr>`;
  }).join('');
  const nChecked=st.items.filter(it=>{const s=st.sel[_mpKey(it)];return s&&s.checked&&s.skuId;}).length;
  host.innerHTML=(st.ns?_mpNewSkuHtml(hostId,st):'')+
    (st.items.length?`<div class="tbl-wrap"><table class="mp-tbl"><thead><tr>
      ${O.showChannel?'<th>채널</th>':''}<th>원본코드</th><th>원본상품명</th>
      ${O.showStats?'<th class="num-col">발견</th><th>최근 발견</th>':''}
      <th>SKU</th><th>재고구분</th><th>저장</th></tr></thead><tbody>${rows}</tbody></table></div>`
      :'<div class="mp-empty">매핑할 코드가 없습니다.</div>')+
    `<div class="mp-foot">
      ${st.items.length?`<button type="button" class="btn-primary up-btn" ${st.busy||!nChecked?'disabled':''} onclick="_mpSave('${hostId}')">선택한 ${nChecked}건 매핑 저장</button>`:''}
      ${st.ns?'':`<button type="button" class="btn-cancel up-btn" onclick="_mpOpenNewSku('${hostId}',-1)">＋ 새 SKU 만들기</button>`}
      ${st.msg?`<span class="off-muted">${_escHtml(st.msg)}</span>`:''}
    </div>`;
}
function _mpRerender(hostId){const st=_MP[hostId];if(st)renderMappingPanel(hostId,st.items,st.opts);}
function _mpItemSel(hostId,i){const st=_MP[hostId];const it=st.items[i];return st.sel[_mpKey(it)];}
function _mpSetSku(hostId,i,v){const s=_mpItemSel(hostId,i);s.skuId=v;s.checked=!!v;_mpRerender(hostId);}
function _mpSetType(hostId,i,v){_mpItemSel(hostId,i).stockType=v;}
function _mpCheck(hostId,i,on){_mpItemSel(hostId,i).checked=on;_mpRerender(hostId);}
function _mpApplySugg(hostId,i){
  const st=_MP[hostId],it=st.items[i];
  const sugg=OfflineResolver.suggestSkus(OFFLINE_MASTERS||{},it.code,it.name)[0];
  if(!sugg)return;
  const s=_mpItemSel(hostId,i);s.skuId=sugg.skuId;s.checked=true;_mpRerender(hostId);
}

async function _mpSave(hostId){
  const st=_MP[hostId];
  if(!st||st.busy)return;
  const items=st.items.filter(it=>{const s=st.sel[_mpKey(it)];return s&&s.checked&&s.skuId;}).map(it=>{
    const s=st.sel[_mpKey(it)];
    return {op:'upsert',channelId:it.channelId,code:it.code,skuId:s.skuId,stockType:s.stockType,name:it.name||''};
  });
  if(!items.length)return;
  st.busy=true;st.msg='저장 중…';_mpRerender(hostId);
  try{
    await _offlineCall('offline_saveMapping',{items});
    await _offlineLoadMasters(true);
    items.forEach(x=>{delete st.sel[x.channelId+'\u0001'+x.code];});
    st.msg='';
    showToast('매핑 '+items.length+'건을 저장했습니다.',{type:'success'});
    if(st.opts.onSaved)await st.opts.onSaved(items);
  }catch(e){
    st.msg='';
    showToast('매핑 저장 실패: '+e.message,{type:'error'});
  }finally{
    st.busy=false;_mpRerender(hostId);
  }
}

// ── 새 SKU 만들기 (품목군은 공유 상수 PRODUCT_CATALOG에서만) ──
function _mpOpenNewSku(hostId,i){
  const st=_MP[hostId];
  const it=i>=0?st.items[i]:null;
  st.ns={forKey:it?_mpKey(it):null,forCode:it?it.code:'',line:PRODUCT_CATALOG[0].key,model:'',option:'',name:'',nameEdited:false};
  st.ns.name=_mpAutoName(st.ns.line,'','');
  _mpRerender(hostId);
}
// 옵션 필수 품목군(기타 — 품명을 옵션에 적는다): 카탈로그의 skuOptionHint가 곧 안내 문구
function _mpNsOptionHint(lineKey){const l=PRODUCT_CATALOG.find(x=>x.key===lineKey);return (l&&l.skuOptionHint)||'';}
function _mpNewSkuHtml(hostId,st){
  const ns=st.ns;
  const line=PRODUCT_CATALOG.find(l=>l.key===ns.line)||PRODUCT_CATALOG[0];
  const hint=_mpNsOptionHint(line.key);
  return `<div class="mp-newsku">
    <div class="f-lbl">새 SKU${ns.forCode?' — '+_escHtml(ns.forCode)+'에 연결':''}</div>
    <div class="up-row">
      <span class="f-lbl">품목군</span><select class="f-sel" id="mpNsLine-${hostId}" onchange="_mpNsInput('${hostId}',true)">${PRODUCT_CATALOG.map(l=>
        `<option value="${_escAttr(l.key)}"${l.key===ns.line?' selected':''}>${_escHtml(l.label)}</option>`).join('')}</select>
      <span class="f-lbl">모델</span><input class="f-inp" id="mpNsModel-${hostId}" list="mpNsModels-${hostId}" value="${_escAttr(ns.model)}" placeholder="예: ${_escAttr((line.models[0]||{}).label||'')}" oninput="_mpNsInput('${hostId}')">
      <datalist id="mpNsModels-${hostId}">${line.models.map(m=>`<option value="${_escAttr(m.label)}"></option>`).join('')}</datalist>
      <span class="f-lbl">옵션${hint?' <span class="off-miss">(필수)</span>':''}</span><input class="f-inp${hint?' mp-ns-name':''}" id="mpNsOption-${hostId}" value="${_escAttr(ns.option)}" placeholder="${_escAttr(hint||'예: 그레이지')}" oninput="_mpNsInput('${hostId}')">
    </div>
    ${hint?`<div class="mp-sugg">${_escHtml(hint)} — 표준명은 "${_escHtml(line.label)} {옵션}"으로 만들어집니다.</div>`:''}
    <div class="up-row">
      <span class="f-lbl">표준명</span><input class="f-inp mp-ns-name" id="mpNsName-${hostId}" value="${_escAttr(ns.name)}" oninput="_mpNsNameEdited('${hostId}',this.value)">
      <button type="button" class="btn-primary up-btn" ${st.busy?'disabled':''} onclick="_mpCreateSku('${hostId}')">만들기</button>
      <button type="button" class="btn-cancel up-btn" onclick="_mpCloseNewSku('${hostId}')">취소</button>
    </div>
  </div>`;
}
// 입력 중에는 전체를 다시 그리지 않는다(포커스 유지) — 품목군을 바꿀 때만 모델 목록 때문에 다시 그림
function _mpNsInput(hostId,lineChanged){
  const ns=_MP[hostId].ns;
  const v=id=>{const el=document.getElementById(id+'-'+hostId);return el?el.value:'';};
  const prevLine=ns.line;
  ns.line=v('mpNsLine')||ns.line;ns.model=v('mpNsModel');ns.option=v('mpNsOption');
  // 옵션 필수 품목군(기타)은 모델이 하나뿐이라 미리 채우고, 다른 품목군으로 옮기면 그 모델을 비운다
  if(lineChanged&&ns.line!==prevLine){
    const cur=PRODUCT_CATALOG.find(l=>l.key===ns.line),prev=PRODUCT_CATALOG.find(l=>l.key===prevLine);
    if(cur&&cur.skuOptionHint)ns.model=cur.models[0].label;
    else if(prev&&prev.skuOptionHint&&ns.model===prev.models[0].label)ns.model='';
  }
  if(!ns.nameEdited){
    ns.name=_mpAutoName(ns.line,ns.model,ns.option);
    const el=document.getElementById('mpNsName-'+hostId);
    if(el)el.value=ns.name;
  }
  if(lineChanged)_mpRerender(hostId);
}
function _mpNsNameEdited(hostId,v){const ns=_MP[hostId].ns;ns.name=v;ns.nameEdited=true;}
function _mpCloseNewSku(hostId){_MP[hostId].ns=null;_mpRerender(hostId);}
async function _mpCreateSku(hostId){
  const st=_MP[hostId],ns=st.ns;
  if(!ns||st.busy)return;
  if(!String(ns.name||'').trim()){showToast('표준명을 입력하세요.',{type:'error'});return;}
  if(_mpNsOptionHint(ns.line)&&!String(ns.option||'').trim()){showToast('옵션에 품명을 입력하세요 — '+_mpNsOptionHint(ns.line),{type:'error'});return;}
  st.busy=true;_mpRerender(hostId);
  try{
    const j=await _offlineCall('offline_saveSku',{sku:{name:ns.name.trim(),line:ns.line,model:ns.model.trim(),option:ns.option.trim(),active:'Y'}});
    await _offlineLoadMasters(true);
    if(ns.forKey){const s=st.sel[ns.forKey];if(s){s.skuId=j.sku.skuId;s.checked=true;}}
    st.ns=null;
    showToast('SKU '+j.sku.skuId+' "'+j.sku.name+'"를 만들었습니다.',{type:'success'});
  }catch(e){
    showToast('SKU 만들기 실패: '+e.message,{type:'error'});
  }finally{
    st.busy=false;_mpRerender(hostId);
  }
}
