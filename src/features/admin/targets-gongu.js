'use strict';
/* 목표 관리(#admin/targets) [공구 목표] 탭 — 공동구매 월 목표(공구목표_월). 행 = 품목군 → 모델(벤더 합) → 벤더(입력), 열 = 1~12월 + 연 합계.
   [목표금액 / 목표수량] 중 보이는 값만 편집한다. 모델 줄은 벤더 합계(읽기 전용)이고 ▸로 벤더 줄을 펼친다(값이 있는 모델은 펼친 채로 시작).
   엑셀 범위 붙여넣기 · 저장은 바뀐 칸만 offline_saveGonguTargets(출처 input — 이관이 덮어쓰지 않는다).
   칸을 고칠 때는 표를 다시 그리지 않고 합계 칸만 갱신한다(연간 보기와 같은 이유 — Tab으로 연달아 입력).
   품목은 공구 화면에 나오는 품목군·모델(카탈로그 gongu) + 데이터에만 있는 모델. */

const _TGG={year:'',field:'amount',data:null,err:'',edits:{},saving:false,open:{},extraVendors:[],newVendor:'',rows:[]};
const _TGG_SEP='\u0001';
function _tggMonths(){const o=[];for(let m=1;m<=12;m++)o.push(_TGG.year+'-'+String(m).padStart(2,'0'));return o;}
const _tggEditKey=(field,rowKey,ym)=>field+_TGG_SEP+rowKey+_TGG_SEP+ym;

async function _tggLoad(force){
  if(!_TGG.year)_TGG.year=(_TG.ym||_tgThisYm()).slice(0,4);
  _TGG.err='';_TGG.data=null;_tgRender();
  try{_TGG.data=await _offlineCached('offline_getGonguTargets',{year:_TGG.year},force);}
  catch(e){_TGG.err=e.message;}
  _tgRender();
}
function _tggChangedKeys(){return Object.keys(_TGG.edits).filter(_tggIsChanged);}
function _tggGuard(){const n=_tggChangedKeys().length;if(n){showToast('저장하지 않은 변경 '+n+'칸이 있습니다 — 저장하거나 되돌린 뒤 바꾸세요.',{type:'error'});_tgRender();return false;}return true;}
function _tggSetYear(v){if(!/^\d{4}$/.test(v)||!_tggGuard())return;_TGG.year=v;_TGG.edits={};_tggLoad();}
function _tggSetField(v){_TGG.field=v;_tgRender();}
function _tggVendors(){
  const v=((_TGG.data&&_TGG.data.vendors)||[]).slice();
  _TGG.extraVendors.forEach(x=>{if(v.indexOf(x)<0)v.push(x);});
  return v;
}
function _tggAddVendor(){
  const name=String(_TGG.newVendor||'').trim();
  if(!name){showToast('벤더 이름을 입력하세요.',{type:'error'});return;}
  if(name.length>40){showToast('벤더 이름은 40자까지입니다.',{type:'error'});return;}
  if(_tggVendors().indexOf(name)>=0){showToast('이미 있는 벤더입니다: '+name,{type:'error'});return;}
  _TGG.extraVendors.push(name);_TGG.newVendor='';
  _TGG.rows.forEach(r=>{if(r.kind==='model')_TGG.open[r.key]=true;}); // 새 벤더 줄이 보이게 펼친다
  _tgRender();
}

// ── 표 모델 ── 품목군(line) · 모델(model, 벤더 합) · 벤더(vendor, 입력)
function _tggBuild(){
  const items=(_TGG.data&&_TGG.data.items)||[],vendors=_tggVendors();
  const cell={};items.forEach(it=>{cell[it.vendor+_TGG_SEP+it.line+_TGG_SEP+it.model+_TGG_SEP+it.ym]=it;});
  const rows=[];
  PRODUCT_CATALOG.forEach(line=>{
    const models=line.gongu?line.models.filter(m=>m.gongu).map(m=>m.label):[];
    items.forEach(it=>{if(it.line===line.key&&models.indexOf(it.model)<0)models.push(it.model);});
    if(!models.length)return;
    if(models.length>1)rows.push({kind:'line',key:'ln'+_TGG_SEP+line.key,line:line.key,label:line.label});
    models.forEach(model=>{
      const mk='md'+_TGG_SEP+line.key+_TGG_SEP+model;
      rows.push({kind:'model',key:mk,line:line.key,model,label:model});
      vendors.forEach(v=>rows.push({kind:'vendor',key:v+_TGG_SEP+line.key+_TGG_SEP+model,modelKey:mk,vendor:v,line:line.key,model,label:v}));
    });
  });
  _TGG.cell=cell;_TGG.rows=rows;
  return rows;
}
function _tggOrig(r,ym){const it=_TGG.cell[r.key+_TGG_SEP+ym];if(!it)return null;const v=_TGG.field==='amount'?it.amount:it.qty;return v==null?null:v;}
// 화면 값(고친 값 우선) — 숫자 | null | NaN(잘못된 입력)
function _tggVal(r,ym){
  const k=_tggEditKey(_TGG.field,r.key,ym);
  if(k in _TGG.edits){const s=String(_TGG.edits[k]).replace(/[,\s]/g,'');return s===''?null:Number(s);}
  return _tggOrig(r,ym);
}
function _tggIsChanged(k){
  const [field,vendor,line,model,ym]=k.split(_TGG_SEP),it=(_TGG.cell||{})[[vendor,line,model,ym].join(_TGG_SEP)];
  const s=String(_TGG.edits[k]).replace(/[,\s]/g,''),v=s===''?null:Number(s);
  const o=it?(field==='amount'?it.amount:it.qty):null;
  return !(v===o||(v!=null&&o!=null&&Number(v)===Number(o)));
}
function _tggModelHas(mk){return _TGG.rows.some(r=>r.kind==='vendor'&&r.modelKey===mk&&_tggMonths().some(ym=>_tggVal(r,ym)!=null));}
function _tggOpen(mk){return _TGG.open[mk]!=null?_TGG.open[mk]:_tggModelHas(mk);}
function _tggFold(mk){_TGG.open[mk]=!_tggOpen(mk);_tgRender();}
function _tggFoldAll(on){_TGG.rows.forEach(r=>{if(r.kind==='model')_TGG.open[r.key]=on;});_tgRender();}

/* 합계 — 모델(md) · 품목군(ln) · 벤더 줄 연 합계(v) · 벤더별(vd:벤더) · 전체(all). 반환 {scope: {ym|'Y': 값}} */
function _tggTotals(){
  const T={},add=(s,ym,v)=>{if(v==null||!isFinite(v))return;const o=T[s]||(T[s]={});o[ym]=(o[ym]||0)+v;};
  _TGG.rows.forEach(r=>{
    if(r.kind!=='vendor')return;
    _tggMonths().forEach(ym=>{
      const v=_tggVal(r,ym);
      [r.modelKey,'ln'+_TGG_SEP+r.line,'v'+_TGG_SEP+r.key,'vd'+_TGG_SEP+r.vendor,'all'].forEach(s=>{add(s,ym,v);add(s,'Y',v);});
    });
  });
  return T;
}
const _tggId=scope=>'tgg'+scope.replace(/[^A-Za-z0-9]/g,c=>'_'+c.charCodeAt(0));

// ── 그리기 ──
function _tggHtml(){
  const Y=+(_TGG.year||(_TG.ym||_tgThisYm()).slice(0,4));
  const fieldTog=`<span class="axis-toggle">${[['amount','목표금액'],['qty','목표수량']].map(([v,l])=>`<button type="button" class="${_TGG.field===v?'on':''}" onclick="_tggSetField('${v}')">${l}</button>`).join('')}</span>`;
  const head=`<div class="card"><div class="card-hd">공구 목표<span class="card-hd-r">공구목표_월 · 금액은 원(VAT 포함) · 모델 줄 = 벤더 합계 · 저장은 바뀐 칸만(출처 input — 이관이 덮어쓰지 않음)</span></div>
    <div class="cm-filters">
      <select class="f-sel" onchange="_tggSetYear(this.value)">${[Y-1,Y,Y+1].map(y=>`<option value="${y}"${String(y)===_TGG.year?' selected':''}>${y}년</option>`).join('')}</select>
      ${fieldTog}
      <button type="button" class="btn-cancel up-btn" onclick="_tggFoldAll(true)">벤더 모두 펼치기</button>
      <button type="button" class="btn-cancel up-btn" onclick="_tggFoldAll(false)">접기</button>
      <input class="f-inp" style="width:120px" placeholder="새 벤더 이름" value="${_escAttr(_TGG.newVendor)}" oninput="_TGG.newVendor=this.value" onkeydown="if(event.key==='Enter')_tggAddVendor()">
      <button type="button" class="btn-cancel up-btn" onclick="_tggAddVendor()">＋ 벤더 추가</button>
      <button type="button" class="btn-primary up-btn" id="tggSaveBtn" ${_TGG.saving?'disabled':''} onclick="_tggSave()">저장</button>
      <button type="button" class="btn-cancel up-btn" onclick="_tggRevert()">되돌리기</button>
      <span class="off-muted" id="tggDirty"></span>
    </div>
    <div class="off-muted tg-help">엑셀에서 복사한 범위(탭 구분)를 벤더 줄 칸에 붙여넣으면 오른쪽(다음 달)·아래(보이는 벤더 줄)로 채워집니다. 원본 '공동구매 26년 목표'는 [이관] 탭에서 가져옵니다.</div></div>`;
  if(_TGG.err)return head+`<div class="card"><div class="up-err">${_escHtml(_TGG.err)}</div></div>`;
  if(!_TGG.data)return head+'<div class="card"><div class="mp-empty">불러오는 중…</div></div>';
  const rows=_tggBuild(),months=_tggMonths(),vendors=_tggVendors();
  const th=`<tr><th>품목 / 벤더</th>${months.map(ym=>`<th class="num-col">${+ym.slice(5)}월</th>`).join('')}<th class="num-col">연 합계</th></tr>`;
  const totRow=(scope,label,cls)=>`<tr class="${cls}"><td>${label}</td>${months.concat(['Y']).map(ym=>`<td class="num-col" id="${_tggId(scope)}_${ym.slice(-2)}"></td>`).join('')}</tr>`;
  let body='';
  rows.forEach((r,i)=>{
    if(r.kind==='line'){body+=totRow(r.key,_escHtml(r.label),'tg-cat');return;}
    if(r.kind==='model'){
      const open=_tggOpen(r.key);
      body+=totRow(r.key,`<button type="button" class="tg-fold" onclick="_tggFold('${_escAttr(r.key)}')">${open?'▾':'▸'}</button> ${_escHtml(r.label)}${vendors.length?'':' <span class="off-muted">— 벤더를 추가하세요</span>'}`,'tg-line');
      return;
    }
    if(!_tggOpen(r.modelKey))return;
    body+=`<tr class="tg-row"><td class="tg-model">${_escHtml(r.vendor)}</td>${months.map((ym,mi)=>{
      const k=_tggEditKey(_TGG.field,r.key,ym),v=_tggVal(r,ym),it=_TGG.cell[r.key+_TGG_SEP+ym];
      const changed=(k in _TGG.edits)&&_tggIsChanged(k),bad=v!=null&&!isFinite(v);
      const tip=it?`${it.source==='migration'?'이관':'입력'} · ${it.updatedAt||''} ${it.updatedBy||''}`:'';
      return `<td class="num-col"><input class="tg-inp tgg-inp${changed?' changed':''}${bad?' bad':''}" data-r="${i}" data-m="${mi}" title="${_escAttr(tip)}" value="${_escAttr(k in _TGG.edits?_TGG.edits[k]:(v==null?'':v))}" inputmode="numeric" oninput="_tggInput(this)" onpaste="_tggPaste(event,this)"></td>`;
    }).join('')}<td class="num-col" id="${_tggId('v'+_TGG_SEP+r.key)}_Y"></td></tr>`;
  });
  body+=vendors.map(v=>totRow('vd'+_TGG_SEP+v,_escHtml(v)+' 합계','tg-chtot')).join('')+totRow('all','전체 합계','tg-grand');
  return head+`<div class="card"><div class="tbl-wrap"><table class="tg-tbl tga-tbl tgg-tbl"><thead>${th}</thead><tbody>${body}</tbody></table></div></div>`;
}
// 표를 그린 뒤·칸을 고칠 때마다 합계 칸·저장 버튼만 갱신
function _tggRefresh(){
  if(!_TGG.data||_TGG.err)return;
  const T=_tggTotals(),set=(id,v)=>{const el=document.getElementById(id);if(el)el.innerHTML=v;};
  const months=_tggMonths().concat(['Y']);
  // 합계가 없는 칸은 비운다(값을 지웠을 때 옛 합계가 남지 않게)
  _TGG.rows.forEach(r=>{const s=r.kind==='vendor'?'v'+_TGG_SEP+r.key:r.key;months.forEach(ym=>set(_tggId(s)+'_'+ym.slice(-2),_tgFmt((T[s]||{})[ym])));});
  ['all'].concat(_tggVendors().map(v=>'vd'+_TGG_SEP+v)).forEach(s=>months.forEach(ym=>set(_tggId(s)+'_'+ym.slice(-2),_tgFmt((T[s]||{})[ym]))));
  const n=_tggChangedKeys().length,bad=Object.keys(_TGG.edits).filter(k=>{const s=String(_TGG.edits[k]).replace(/[,\s]/g,'');return s!==''&&!isFinite(Number(s));}).length;
  set('tggDirty',n?`고친 칸 ${n}개${bad?` · 숫자가 아닌 칸 ${bad}개`:''}`:'');
  const b=document.getElementById('tggSaveBtn');if(b)b.textContent=n?`저장 (${n})`:'저장';
}
function _tggInput(el){
  const r=_TGG.rows[+el.dataset.r],ym=_tggMonths()[+el.dataset.m];if(!r||!ym)return;
  const k=_tggEditKey(_TGG.field,r.key,ym);
  _TGG.edits[k]=el.value;
  el.classList.toggle('changed',_tggIsChanged(k));
  const s=String(el.value).replace(/[,\s]/g,'');el.classList.toggle('bad',s!==''&&!isFinite(Number(s)));
  _tggRefresh();
}
/* 엑셀 범위 붙여넣기 — 이 칸부터 오른쪽(다음 달)·아래(화면에 보이는 벤더 줄 순서)로 채운다 */
function _tggPaste(ev,el){
  const text=(ev.clipboardData||window.clipboardData||{getData:()=>''}).getData('text');
  if(!/[\t\n]/.test(text))return;
  ev.preventDefault();
  const lines=text.replace(/\r/g,'').split('\n');if(lines.length&&lines[lines.length-1]==='')lines.pop();
  const visible=[...document.querySelectorAll('.tgg-tbl tr.tg-row')].map(tr=>{const inp=tr.querySelector('input[data-r]');return inp?+inp.dataset.r:null;}).filter(x=>x!=null);
  const start=visible.indexOf(+el.dataset.r),m0=+el.dataset.m,months=_tggMonths();
  let n=0;
  lines.forEach((line,di)=>{
    const r=_TGG.rows[visible[start+di]];if(!r||r.kind!=='vendor')return;
    line.split('\t').forEach((cell,dj)=>{const ym=months[m0+dj];if(!ym)return;_TGG.edits[_tggEditKey(_TGG.field,r.key,ym)]=cell.trim();n++;});
  });
  _tgRender();
  showToast(n+'칸을 붙여넣었습니다.');
}
function _tggRevert(){_TGG.edits={};_tgRender();}
async function _tggSave(){
  if(_TGG.saving)return;
  const keys=_tggChangedKeys();
  if(keys.some(k=>{const s=String(_TGG.edits[k]).replace(/[,\s]/g,'');return s!==''&&!isFinite(Number(s));})){showToast('숫자가 아닌 칸이 있습니다(빨간 칸).',{type:'error'});return;}
  if(!keys.length){showToast('고친 칸이 없습니다.');return;}
  // 같은 (연월·벤더·품목군·모델)의 금액·수량 수정은 한 항목으로 — 고치지 않은 쪽 키는 보내지 않는다(서버가 그대로 둔다)
  const byKey={},items=[];
  keys.forEach(k=>{
    const [field,vendor,line,model,ym]=k.split(_TGG_SEP),ik=[ym,vendor,line,model].join(_TGG_SEP);
    let it=byKey[ik];
    if(!it){it=byKey[ik]={ym,vendor,line,model};items.push(it);}
    it[field]=String(_TGG.edits[k]).replace(/[,\s]/g,'');
  });
  _TGG.saving=true;_tgRender();
  try{
    await _offlineCall('offline_saveGonguTargets',{items});
    showToast(keys.length+'칸을 저장했습니다.',{type:'success'});
    _TGG.edits={};_TGG.extraVendors=[];_TGG.saving=false;
    _TGA.gongu=null; // 연간 보기의 공동구매 줄도 다시 받는다
    await _tggLoad(true);
  }catch(e){showToast('저장 실패: '+e.message,{type:'error'});}
  finally{_TGG.saving=false;_tgRender();}
}

// ━━ [이관] 탭 — 공구 목표 이관 카드(원본 '공동구매 26년 목표' → 공구목표_월). 카드 틀은 targets.js _tgMigrateHtml이 부른다 ━━
function _tgGongMigrateHtml(){
  const g=_TG.mig;
  return `<div class="card"><div class="card-hd">공구 목표 이관<span class="card-hd-r">기존 '공동구매 26년 목표'(읽기만 함) → 공구목표_월 · 출처 migration</span></div>
    <div class="off-muted tg-help">이관 대상: '월별 품목 매출 계획' 블록의 벤더별 상품 행(소계·채널 합계 행 제외), 값이 있는 월만 · 금액은 원본 매출 값 그대로. 반영은 migration 행만 지우고 다시 넣으므로 여러 번 실행해도 결과가 같고, [공구 목표] 탭에서 직접 입력한(input) 값은 덮어쓰지 않습니다. '26년 목표 합' 탭은 쓰지 않습니다.</div>
    <div class="cm-filters"><button type="button" class="btn-cancel up-btn" ${g.ggBusy?'disabled':''} onclick="_tgGongPreview(false)">${g.gg?'다시 미리보기':'미리보기'}</button>
      ${g.gg?`<button type="button" class="btn-cancel up-btn" ${g.ggBusy?'disabled':''} onclick="_tgGongPreview(true)">매핑으로 다시 계산</button>
        <button type="button" class="btn-primary up-btn${g.ggConfirm?' cm-danger':''}" ${g.ggBusy?'disabled':''} onclick="_tgGongApply()">${g.ggConfirm?'반영 확인 — '+g.gg.planRows+'행 쓰기':'반영'}</button>`:''}
      ${g.ggBusy?'<span class="up-progress">처리 중…</span>':''}</div>
    ${g.ggErr?`<div class="up-err">${_escHtml(g.ggErr)}</div>`:''}
    ${g.ggResult?`<div class="up-result">✓ 반영 완료 — ${g.ggResult.written}행 쓰기(기존 migration ${g.ggResult.removed}행 교체)${g.ggResult.skippedInput?` · 입력값 보존으로 건너뜀 ${g.ggResult.skippedInput}`:''}</div>`:''}
    ${g.gg?_tgGongPreviewHtml(g.gg):''}</div>`;
}
// 미리보기 응답의 상품 매핑 → 편집용 상태(이미 고친 값은 유지)
function _tgGongMapFrom(pv){
  const cur=(_TG.mig.ggMap&&_TG.mig.ggMap.products)||{},m={products:{}};
  pv.products.forEach(p=>{m.products[p.legacy]=cur[p.legacy]||{line:p.line,model:p.model};});
  return m;
}
async function _tgGongPreview(withMap){
  const g=_TG.mig;g.ggBusy=true;g.ggErr='';g.ggConfirm=false;_tgRender();
  try{
    const pv=await _offlineCall('offline_migrateGonguTargets',{mode:'preview',mapping:withMap?g.ggMap:null});
    g.gg=pv;g.ggMap=_tgGongMapFrom(pv);g.log=pv.recentLog;
  }catch(e){g.ggErr=e.message;}
  g.ggBusy=false;_tgRender();
}
function _tgGongSetLine(legacy,v){_TG.mig.ggMap.products[legacy]={line:v,model:''};_TG.mig.ggConfirm=false;_tgRender();}
function _tgGongSetModel(legacy,v){_TG.mig.ggMap.products[legacy].model=v;_TG.mig.ggConfirm=false;}
async function _tgGongApply(){
  const g=_TG.mig;
  if(!g.ggConfirm){g.ggConfirm=true;_tgRender();return;}
  g.ggBusy=true;g.ggErr='';_tgRender();
  try{
    const r=await _offlineCall('offline_migrateGonguTargets',{mode:'apply',mapping:g.ggMap});
    g.ggResult=r;g.gg=r;g.ggMap=_tgGongMapFrom(r);g.log=r.recentLog;
    _TGG.data=null;_TGA.gongu=null; // 공구 목표·연간 보기는 다시 받는다
    showToast('공구 목표 '+r.written+'행을 이관했습니다.',{type:'success'});
  }catch(e){g.ggErr=e.message;}
  g.ggBusy=false;g.ggConfirm=false;_tgRender();
}
function _tgGongPreviewHtml(pv){
  const m=_TG.mig.ggMap,c=pv.compare,W=_tgFmt,ok=b=>b?'<span class="up-chip ready">일치</span>':'<span class="up-chip applying">다름</span>';
  const diff=(a,b)=>{const d=Math.round((a||0)-(b||0));return d?`<span class="tg-diff">${d>0?'+':''}${W(d)}</span>`:'0';};
  const prRows=pv.products.map(p=>{
    const cur=m.products[p.legacy]||{line:'',model:''},miss=!cur.line||!cur.model;
    return `<tr class="${miss?'tg-miss':''}"><td>${_escHtml(p.legacy)}${miss?' <span class="up-chip applying">연결 필요</span>':''}</td><td class="cm-reg">${_escHtml(p.vendors.join(' · '))}</td>
      <td><select class="f-sel" onchange="_tgGongSetLine('${_escAttr(p.legacy)}',this.value)"><option value="">— 품목군 —</option>${_tgLineOpts(cur.line)}</select></td>
      <td><select class="f-sel" onchange="_tgGongSetModel('${_escAttr(p.legacy)}',this.value)">${_tgModelOpts(cur.line,cur.model)}</select></td></tr>`;
  }).join('');
  const row=(lb,x,withQty,cls)=>`<tr${cls?` class="${cls}"`:''}><td>${lb}</td><td class="num-col">${W(x.planAmt)}</td><td class="num-col">${withQty?W(x.planQty):''}</td><td class="num-col">${W(x.legacyAmt)}</td><td class="num-col">${withQty?W(x.legacyQty):''}</td><td class="num-col">${diff(x.planAmt,x.legacyAmt)}</td><td>${ok(x.ok)}</td></tr>`;
  const cmpRows=c.months.map(x=>row(_escHtml(x.ym),x,true)).join('')+row('연 합계(채널 합계 소계)',c.total,true,'tg-chtot')+row('26년 목표',c.year,false)+
    c.quarters.map(q=>row(q.q+'분기 목표',q,false)).join('')+c.vendors.map(v=>row('벤더 소계 · '+_escHtml(v.vendor),v,true)).join('');
  // 참고: 원본 마감 매출 vs 공구 시트 실적(공구 분석과 같은 규칙 — 시작일 월 귀속, 완료+진행중, 총매출)
  const year=(pv.months[0]||'').slice(0,4),gm=year?partGonguMonthly(year,''):{};
  const cm=c.close.months||[];
  const cRows=cm.map(x=>{const a=gm[x.ym]||{rev:0,qty:0};return `<tr><td>${_escHtml(x.ym)}</td><td class="num-col">${W(x.amt)}</td><td class="num-col">${W(a.rev)}</td><td class="num-col">${diff(a.rev,x.amt)}</td><td class="num-col">${W(x.qty)}</td><td class="num-col">${W(a.qty)}</td></tr>`;}).join('');
  const cTot=cm.reduce((s,x)=>{const a=gm[x.ym]||{rev:0};s.l+=x.amt||0;s.g+=a.rev;return s;},{l:0,g:0});
  return `<div class="up-stats">원본 <b>${_escHtml(pv.sheetName)}</b> · ${pv.months.length?_escHtml(pv.months[0]+' ~ '+pv.months[pv.months.length-1]):'-'} · 벤더 ${_escHtml(pv.vendors.join(', '))} · 상품 행 <b>${pv.legacyRows}</b> ·
      반영 예정 <b>${pv.planRows}</b>행${pv.skippedInput?` · 입력값 보존 ${pv.skippedInput}`:''}${pv.badCells?` · 오류 칸 ${pv.badCells}개(빈칸 처리)`:''}</div>
    ${pv.unmapped&&pv.unmapped.length?`<div class="up-err">미매핑(이관하지 않음): ${_escHtml(pv.unmapped.join(', '))} — 품목군·모델을 고른 뒤 [매핑으로 다시 계산]</div>`:''}
    <div class="f-lbl" style="margin-top:10px">상품명 연결 — 제안: 대소문자·띄어쓰기 무시, 모호하면 빈칸</div>
    <div class="tbl-wrap"><table class="cm-tbl"><thead><tr><th>원본 상품명</th><th>벤더</th><th>품목군</th><th>모델</th></tr></thead><tbody>${prRows}</tbody></table></div>
    <div class="f-lbl" style="margin-top:14px">대조 — 이관 예정 합계 vs 원본(채널 합계 행 · 26년 목표 · 분기별 목표 · 벤더 소계)</div>
    <div class="tbl-wrap"><table class="cm-tbl"><thead><tr><th>구분</th><th class="num-col">이관 예정 금액</th><th class="num-col">수량</th><th class="num-col">원본 금액</th><th class="num-col">수량</th><th class="num-col">금액 차이</th><th></th></tr></thead><tbody>${cmpRows}</tbody></table></div>
    <div class="f-lbl" style="margin-top:14px">참고 — 원본 '월별 품목 마감 매출' vs 공구 시트 실적(공구 분석과 같은 규칙: 시작일 월 · 완료+진행중 · 총매출) · 이관하지 않음</div>
    ${partGonguLive()?'':'<div class="off-muted tg-help">⚠ 공구 데이터가 아직 서버에서 오지 않았습니다(샘플·캐시) — 공구 시트 실적은 잠정 값입니다.</div>'}
    ${c.close.found?`<div class="tbl-wrap"><table class="cm-tbl"><thead><tr><th>월</th><th class="num-col">원본 마감 매출</th><th class="num-col">공구 시트 실적</th><th class="num-col">차이</th><th class="num-col">원본 수량</th><th class="num-col">공구 판매수량</th></tr></thead><tbody>${cRows}
      <tr class="tg-chtot"><td>합계</td><td class="num-col">${W(cTot.l)}</td><td class="num-col">${W(cTot.g)}</td><td class="num-col">${diff(cTot.g,cTot.l)}</td><td></td><td></td></tr></tbody></table></div>
      <div class="off-muted tg-help">원본 분기 마감: ${[1,2,3,4].map(q=>q+'분기 '+W((c.close.quarters||{})[q])).join(' · ')} · '26년 마감' 셀 ${W(c.close.year)}</div>`:'<div class="mp-empty">원본에서 마감 매출 블록을 찾지 못했습니다.</div>'}`;
}
