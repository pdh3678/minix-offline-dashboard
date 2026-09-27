'use strict';
/* 목표 관리(#admin/targets) — 오프라인 채널 월별 목표(Sell-in IN·Sell-out OUT)와 실적 입력, 단가, 과거 실적 이관.
   탭 3개: [월별 입력] offline_getMonthly + offline_saveTargets / [단가] offline_getPrices·savePrices /
          [이관] offline_migrateProgress·migratePrices(미리보기 → 매핑 확인 → 반영)

   월별 입력 표는 칸을 고칠 때 표를 다시 그리지 않는다 — 다시 그리면 Tab으로 옮겨 간 입력칸이 사라져
   키보드로 연달아 입력할 수 없다. 대신 그 줄의 달성률·금액과 합계 칸만 id로 찾아 갱신한다. */

const _TG_FIELDS=['inT','inA','outT','outA'];
const _TG={tab:'monthly',ym:'',ch:'',data:null,err:'',loading:false,edits:{},collapsed:{},saving:false,view:[],
  prices:null,priceErr:'',priceCh:'',priceEditKey:null,priceEdit:null,priceForm:null,priceBusy:false,
  mig:{prog:null,progErr:'',progBusy:false,progMap:null,progResult:null,progConfirm:false,
    price:null,priceErr:'',priceBusy:false,priceRows:{},priceStart:'',priceResult:null,priceConfirm:false,log:null}};

function _tgThisYm(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
function _tgPrevYm(ym){let y=+ym.slice(0,4),m=+ym.slice(5,7)-1;if(m<1){m=12;y--;}return y+'-'+String(m).padStart(2,'0');}
const _tgKey=(ch,line,model)=>ch+'\u0001'+line+'\u0001'+model;
const _tgFmt=v=>v==null||v===''?'':Number(v).toLocaleString('ko-KR');
const _tgRate=(a,t)=>(t&&a!=null&&a!=='')?Math.round(a/t*1000)/10+'%':'—';
const _tgWon=v=>v==null?'—':'₩'+Math.round(v).toLocaleString('ko-KR');

function mountTargetsPage(){
  if(!_TG.ym)_TG.ym=_tgThisYm();
  _tgRender();
  _tgLoad();
}
PAGE_MOUNTS['admin-targets']=mountTargetsPage;

async function _tgLoad(){
  _TG.loading=true;_TG.err='';_tgRender();
  try{
    const [,mon,pr]=await Promise.all([_offlineLoadMasters(),_offlineCall('offline_getMonthly',{from:_TG.ym,to:_TG.ym}),_offlineCall('offline_getPrices')]);
    _TG.data=mon;_TG.prices=pr.items;_TG.edits={};
  }catch(e){_TG.err=e.message;}
  _TG.loading=false;_tgRender();
}
function _tgSetTab(t){
  _TG.tab=t;_tgRender();
  // 단가·이관을 반영하면 월별 데이터를 비워 두므로 돌아올 때 다시 받는다
  if(t==='monthly'&&!_TG.data&&!_TG.loading)_tgLoad();
  if(t==='prices'&&!_TG.prices)_tgLoadPrices();
}
function _tgSetYm(v){
  if(!/^\d{4}-\d{2}$/.test(v))return;
  if(_tgChangedCount()&&!_TG.confirmDiscard){_TG.confirmDiscard=v;_tgRender();return;}
  _TG.confirmDiscard=null;_TG.ym=v;_tgLoad();
}
function _tgKeepEdits(){_TG.confirmDiscard=null;_tgRender();}
function _tgDiscardAndGo(){const v=_TG.confirmDiscard;_TG.confirmDiscard=null;_TG.edits={};_TG.ym=v;_tgLoad();}
function _tgSetCh(v){_TG.ch=v;_tgRender();}

// ── 단가(클라이언트에서 금액 미리 계산 — 서버와 같은 규칙: 그 달 1일 기준 가장 최근 적용시작일) ──
function _tgPriceFor(ch,line,model,ym){
  const day1=ym+'-01';let hit=null,best='';
  (_TG.prices||[]).forEach(p=>{if(p.channelId===ch&&p.line===line&&p.model===model&&p.startDate<=day1&&p.startDate>best){best=p.startDate;hit=Number(p.price);}});
  return hit;
}
function _tgIsUpload(ch,ym){
  const c=((OFFLINE_MASTERS&&OFFLINE_MASTERS.channels)||[]).find(x=>x.channelId===ch);
  return !!(c&&c.uploadStartMonth&&ym>=c.uploadStartMonth);
}

// ── 표 모델: 채널 × 품목군 × 모델(품목 상수) + 데이터에만 있는 모델 ──
function _tgBuildView(){
  const m=OFFLINE_MASTERS||{},d=_TG.data||{rows:[]};
  const byKey={};(d.rows||[]).forEach(r=>{byKey[_tgKey(r.channelId,r.line,r.model)]=r;});
  const hasData=ch=>(d.rows||[]).some(r=>r.channelId===ch);
  const chans=(m.channels||[]).slice().sort((a,b)=>(Number(a.order)||99)-(Number(b.order)||99))
    .filter(c=>_TG.ch?c.channelId===_TG.ch:(c.active==='Y'||hasData(c.channelId)));
  const view=[];
  chans.forEach(c=>{
    PRODUCT_CATALOG.forEach(line=>{
      const models=line.models.map(x=>x.label);
      (d.rows||[]).forEach(r=>{if(r.channelId===c.channelId&&r.line===line.key&&models.indexOf(r.model)<0)models.push(r.model);});
      models.forEach(model=>{
        const k=_tgKey(c.channelId,line.key,model),r=byKey[k];
        const orig={inT:r?r.in.target:null,inA:r?r.in.actual:null,outT:r?r.out.target:null,outA:r?r.out.actual:null};
        view.push({key:k,ch:c.channelId,chName:c.name,line:line.key,lineLabel:line.label,model,orig,
          outSource:r?r.out.source:'',byType:r?r.out.byType:null,upload:_tgIsUpload(c.channelId,_TG.ym)});
      });
    });
  });
  _TG.view=view;
  return {chans,view};
}
// 화면에 보이는 값(고친 값 우선) — 숫자 | '' | NaN(잘못된 입력)
function _tgVal(row,f){
  const e=_TG.edits[row.key];
  if(e&&f in e){const s=String(e[f]).replace(/[,\s]/g,'');return s===''?'':Number(s);}
  const o=row.orig[f];return o==null?'':o;
}
function _tgChanged(row,f){
  const e=_TG.edits[row.key];if(!e||!(f in e))return false;
  const v=_tgVal(row,f),o=row.orig[f]==null?'':row.orig[f];
  return !(v===o||(v!==''&&o!==''&&Number(v)===Number(o)));
}
function _tgChangedCount(){return _TG.view.reduce((n,r)=>n+_TG_FIELDS.filter(f=>_tgChanged(r,f)).length,0);}
function _tgInvalidCount(){return _TG.view.reduce((n,r)=>n+_TG_FIELDS.filter(f=>{const v=_tgVal(r,f);return v!==''&&!isFinite(v);}).length,0);}
function _tgEditable(row,f){return !(f==='outA'&&row.upload);}

// 합계: 품목군(ln:ch|line) · 채널(ch:ch) · 전체(all)
function _tgTotals(){
  const t={};
  const add=(scope,row)=>{
    const s=t[scope]||(t[scope]={inT:null,inA:null,outT:null,outA:null,inAAmt:null,outAAmt:null});
    _TG_FIELDS.forEach(f=>{const v=_tgVal(row,f);if(v!==''&&isFinite(v))s[f]=(s[f]||0)+v;});
    const p=_tgPriceFor(row.ch,row.line,row.model,_TG.ym);
    if(p!=null){const a=_tgVal(row,'inA'),o=_tgVal(row,'outA');if(a!==''&&isFinite(a))s.inAAmt=(s.inAAmt||0)+a*p;if(o!==''&&isFinite(o))s.outAAmt=(s.outAAmt||0)+o*p;}
  };
  _TG.view.forEach(r=>{add('ln:'+r.ch+'|'+r.line,r);add('ch:'+r.ch,r);add('all',r);});
  return t;
}

// ── 그리기 ──
function _tgRender(){
  const host=document.getElementById('page-admin-targets');
  if(!host)return;
  const tabs=[['monthly','월별 입력'],['prices','단가'],['migrate','이관']];
  host.innerHTML=`<div class="subtabs open">${tabs.map(([k,l])=>`<button type="button" class="stab${_TG.tab===k?' sam':''}" onclick="_tgSetTab('${k}')">${l}</button>`).join('')}</div>`+
    (_TG.tab==='monthly'?_tgMonthlyHtml():_TG.tab==='prices'?_tgPricesHtml():_tgMigrateHtml());
  if(_TG.tab==='monthly'&&_TG.data&&!_TG.err)_tgRefreshNumbers();
}

function _tgMonthlyHtml(){
  const m=OFFLINE_MASTERS||{};
  const head=`<div class="card"><div class="card-hd">월별 목표·실적<span class="card-hd-r">IN = Sell-in(입고) · OUT = Sell-out(판매) · 업로드 채널은 업로드시작월부터 OUT 실적을 판매원장에서 집계</span></div>
    <div class="cm-filters">
      <input type="month" class="f-inp" value="${_TG.ym}" onchange="_tgSetYm(this.value)">
      <select class="f-sel" onchange="_tgSetCh(this.value)"><option value="">활성 채널 전체</option>${(m.channels||[]).map(c=>
        `<option value="${_escAttr(c.channelId)}"${_TG.ch===c.channelId?' selected':''}>${_escHtml(c.name)}${c.active==='Y'?'':' (비활성)'}</option>`).join('')}</select>
      <button type="button" class="btn-cancel up-btn" ${_TG.loading||_TG.saving?'disabled':''} onclick="_tgCopyPrev()">전월 목표 복사</button>
      <button type="button" class="btn-primary up-btn" id="tgSaveBtn" ${_TG.saving?'disabled':''} onclick="_tgSave()">저장</button>
      <button type="button" class="btn-cancel up-btn" onclick="_tgRevert()">되돌리기</button>
      <span class="off-muted" id="tgDirty"></span>
    </div>
    ${_TG.confirmDiscard?`<div class="up-err">저장하지 않은 변경이 있습니다. <button type="button" class="btn-cancel up-btn" onclick="_tgKeepEdits()">계속 편집</button> <button type="button" class="btn-cancel up-btn cm-danger" onclick="_tgDiscardAndGo()">버리고 ${_escHtml(_TG.confirmDiscard)}로 이동</button></div>`:''}
    <div class="off-muted tg-help">엑셀에서 복사한 범위(탭 구분)를 칸에 붙여넣으면 오른쪽·아래로 채워집니다. 고친 칸은 노란색, 저장하면 고친 줄만 보냅니다.</div></div>`;
  if(_TG.err)return head+`<div class="card"><div class="up-err">${_escHtml(_TG.err)}</div></div>`;
  if(_TG.loading||!_TG.data)return head+'<div class="card"><div class="mp-empty">불러오는 중…</div></div>';
  const d=_TG.data;
  const warn=[];
  if(d.unmatched&&d.unmatched.length){
    const q=d.unmatched.reduce((a,u)=>a+u.qty,0);
    warn.push(`<div class="up-err">⚠ 매핑 안 된 코드 ${d.unmatched.length}건(수량 ${q})은 OUT 실적에 들어가지 않았습니다 — <a href="#admin/code-mapping">코드 매핑</a>에서 연결하세요. <span class="off-muted">${d.unmatched.map(u=>_escHtml(_offlineChannelName(u.channelId)+' '+u.code+' '+u.qty)).join(' · ')}</span></div>`);
  }
  const priceWarn=(d.warnings||[]).filter(w=>/^단가 없음/.test(w));
  if(priceWarn.length)warn.push(`<details class="tg-warn"><summary>단가 없는 모델 ${priceWarn.length}개 — 금액이 계산되지 않습니다(단가 탭에서 추가)</summary>${priceWarn.map(w=>'<div>'+_escHtml(w)+'</div>').join('')}</details>`);
  const {chans}=_tgBuildView();
  return head+`<div class="card">${warn.join('')}<div class="tbl-wrap"><table class="tg-tbl"><thead><tr>
      <th>채널 / 품목</th><th class="num-col">IN 목표</th><th class="num-col">IN 실적</th><th class="num-col">IN 달성률</th>
      <th class="num-col">OUT 목표</th><th class="num-col">OUT 실적</th><th class="num-col">OUT 달성률</th><th class="num-col">금액(실적 환산)</th></tr></thead>
    <tbody>${chans.map(_tgChannelHtml).join('')}${_tgTotalRowHtml('all','전체 합계','tg-grand')}</tbody></table></div></div>`;
}
function _tgChannelHtml(c){
  const rows=_TG.view.filter(r=>r.ch===c.channelId);
  const up=c.uploadStartMonth&&_TG.ym>=c.uploadStartMonth;
  let html=`<tr class="tg-ch"><td colspan="8">${_escHtml(c.name)} ${up?`<span class="up-chip ready">OUT 실적 = 업로드 원장(${_escHtml(c.uploadStartMonth)}~)</span>`:(c.uploadStartMonth?`<span class="up-chip">업로드 ${_escHtml(c.uploadStartMonth)}부터 — 이 달은 입력값</span>`:'<span class="up-chip">업로드 없는 채널 — OUT 실적 입력</span>')}</td></tr>`;
  PRODUCT_CATALOG.forEach(line=>{
    const lr=rows.filter(r=>r.line===line.key);
    if(!lr.length)return;
    const ck=c.channelId+'|'+line.key;
    const has=lr.some(r=>_TG_FIELDS.some(f=>_tgVal(r,f)!==''));
    const closed=_TG.collapsed[ck]!=null?_TG.collapsed[ck]:!has;
    html+=_tgTotalRowHtml('ln:'+ck,`<button type="button" class="tg-fold" onclick="_tgFold('${_escAttr(ck)}')">${closed?'▸':'▾'}</button> ${_escHtml(line.label)}`,'tg-line');
    if(closed)return;
    lr.forEach(r=>{html+=_tgRowHtml(r,_TG.view.indexOf(r));});
  });
  return html+_tgTotalRowHtml('ch:'+c.channelId,_escHtml(c.name)+' 합계','tg-chtot');
}
function _tgRowHtml(r,i){
  const cell=f=>{
    if(!_tgEditable(r,f)){
      const bt=r.byType?Object.keys(r.byType).filter(k=>r.byType[k]).map(k=>k+' '+r.byType[k]).join(' · '):'';
      return `<td class="num-col tg-ro" title="판매원장 집계${bt?' — '+_escAttr(bt):''}">${_tgFmt(r.orig.outA)} <span class="tg-src">upload</span></td>`;
    }
    const v=_tgVal(r,f);
    const src=f==='outA'&&r.outSource&&r.outSource!=='upload'&&!_tgChanged(r,f)?`<span class="tg-src">${_escHtml(r.outSource)}</span>`:'';
    return `<td class="num-col"><input class="tg-inp${_tgChanged(r,f)?' changed':''}${v!==''&&!isFinite(v)?' bad':''}" data-r="${i}" data-f="${f}" value="${_escAttr(v===''?'':(isFinite(v)?v:(_TG.edits[r.key]||{})[f]))}" inputmode="numeric" oninput="_tgInput(this)" onpaste="_tgPaste(event,this)">${src}</td>`;
  };
  return `<tr class="tg-row"><td class="tg-model">${_escHtml(r.model)}</td>${cell('inT')}${cell('inA')}<td class="num-col" id="tgRi${i}">${_tgRate(_tgVal(r,'inA'),_tgVal(r,'inT'))}</td>
    ${cell('outT')}${cell('outA')}<td class="num-col" id="tgRo${i}">${_tgRate(_tgVal(r,'outA'),_tgVal(r,'outT'))}</td><td class="num-col tg-amt" id="tgAm${i}">${_tgAmtHtml(r)}</td></tr>`;
}
function _tgAmtHtml(r){
  const p=_tgPriceFor(r.ch,r.line,r.model,_TG.ym);
  if(p==null)return '<span class="off-muted" title="단가 없음">—</span>';
  const a=_tgVal(r,'inA'),o=_tgVal(r,'outA');
  return `<span title="공급가 ${_tgFmt(p)}">IN ${a===''||!isFinite(a)?'—':_tgWon(a*p)}<br>OUT ${o===''||!isFinite(o)?'—':_tgWon(o*p)}</span>`;
}
function _tgTotalRowHtml(scope,label,cls){
  const id=f=>'tgT'+scope.replace(/[^A-Za-z0-9]/g,c=>'_'+c.charCodeAt(0))+f;
  return `<tr class="${cls}"><td>${label}</td>${['inT','inA','inR','outT','outA','outR','amt'].map(f=>`<td class="num-col" id="${id(f)}"></td>`).join('')}</tr>`;
}
function _tgTotalId(scope,f){return 'tgT'+scope.replace(/[^A-Za-z0-9]/g,c=>'_'+c.charCodeAt(0))+f;}
// 표를 그린 뒤·칸을 고칠 때마다 합계·달성률·저장 버튼 상태만 갱신
function _tgRefreshNumbers(rowIdx){
  const set=(id,v)=>{const el=document.getElementById(id);if(el)el.innerHTML=v;};
  if(rowIdx!=null){const r=_TG.view[rowIdx];if(r){set('tgRi'+rowIdx,_tgRate(_tgVal(r,'inA'),_tgVal(r,'inT')));set('tgRo'+rowIdx,_tgRate(_tgVal(r,'outA'),_tgVal(r,'outT')));set('tgAm'+rowIdx,_tgAmtHtml(r));}}
  const t=_tgTotals();
  Object.keys(t).forEach(scope=>{
    const s=t[scope];
    set(_tgTotalId(scope,'inT'),_tgFmt(s.inT));set(_tgTotalId(scope,'inA'),_tgFmt(s.inA));set(_tgTotalId(scope,'inR'),_tgRate(s.inA,s.inT));
    set(_tgTotalId(scope,'outT'),_tgFmt(s.outT));set(_tgTotalId(scope,'outA'),_tgFmt(s.outA));set(_tgTotalId(scope,'outR'),_tgRate(s.outA,s.outT));
    set(_tgTotalId(scope,'amt'),s.inAAmt==null&&s.outAAmt==null?'—':`IN ${_tgWon(s.inAAmt)}<br>OUT ${_tgWon(s.outAAmt)}`);
  });
  const n=_tgChangedCount(),bad=_tgInvalidCount();
  set('tgDirty',n?`고친 칸 ${n}개${bad?` · 숫자가 아닌 칸 ${bad}개`:''}`:'');
  const b=document.getElementById('tgSaveBtn');if(b)b.textContent=n?`저장 (${n})`:'저장';
}
function _tgFold(ck){
  const lr=_TG.view.filter(r=>r.ch+'|'+r.line===ck);
  const has=lr.some(r=>_TG_FIELDS.some(f=>_tgVal(r,f)!==''));
  const cur=_TG.collapsed[ck]!=null?_TG.collapsed[ck]:!has;
  _TG.collapsed[ck]=!cur;_tgRender();
}
function _tgSetEdit(r,f,raw){(_TG.edits[r.key]=_TG.edits[r.key]||{})[f]=raw;}
function _tgInput(el){
  const i=+el.dataset.r,f=el.dataset.f,r=_TG.view[i];
  if(!r)return;
  _tgSetEdit(r,f,el.value);
  el.classList.toggle('changed',_tgChanged(r,f));
  const v=_tgVal(r,f);el.classList.toggle('bad',v!==''&&!isFinite(v));
  _tgRefreshNumbers(i);
}
/* 엑셀 범위 붙여넣기 — 탭·줄바꿈으로 나눠 이 칸부터 오른쪽(IN 목표→IN 실적→OUT 목표→OUT 실적)·아래(화면에 보이는
   모델 줄 순서)로 채운다. 업로드 원장 칸은 건너뛰되 열 위치는 그대로 센다(엑셀의 같은 열이 같은 칸에 가도록). */
function _tgPaste(ev,el){
  const text=(ev.clipboardData||window.clipboardData||{getData:()=>''}).getData('text');
  if(!/[\t\n]/.test(text))return; // 한 칸짜리는 브라우저 기본 붙여넣기
  ev.preventDefault();
  const lines=text.replace(/\r/g,'').split('\n');if(lines.length&&lines[lines.length-1]==='')lines.pop();
  const visible=[...document.querySelectorAll('.tg-tbl tr.tg-row')].map(tr=>{const inp=tr.querySelector('input[data-r]');return inp?+inp.dataset.r:null;}).filter(x=>x!=null);
  const startRow=visible.indexOf(+el.dataset.r),startCol=_TG_FIELDS.indexOf(el.dataset.f);
  let n=0;
  lines.forEach((line,di)=>{
    const r=_TG.view[visible[startRow+di]];if(!r)return;
    line.split('\t').forEach((cellText,dj)=>{
      const f=_TG_FIELDS[startCol+dj];if(!f||!_tgEditable(r,f))return;
      _tgSetEdit(r,f,cellText.trim());n++;
    });
  });
  _tgRender();
  showToast(n+'칸을 붙여넣었습니다.');
}
function _tgRevert(){_TG.edits={};_tgRender();}
async function _tgCopyPrev(){
  const prev=_tgPrevYm(_TG.ym);
  try{
    const pd=await _offlineCall('offline_getMonthly',{from:prev,to:prev});
    const byKey={};(pd.rows||[]).forEach(r=>{byKey[_tgKey(r.channelId,r.line,r.model)]=r;});
    let n=0;
    _TG.view.forEach(r=>{
      const p=byKey[r.key];if(!p)return;
      [['inT',p.in.target],['outT',p.out.target]].forEach(([f,v])=>{if(v!=null&&_tgVal(r,f)===''){_tgSetEdit(r,f,String(v));n++;}});
    });
    // 복사한 값이 들어간 품목군은 펼쳐서 보여 준다
    _TG.view.forEach(r=>{if(_TG_FIELDS.some(f=>_tgChanged(r,f)))_TG.collapsed[r.ch+'|'+r.line]=false;});
    _tgRender();
    showToast(n?`${prev} 목표 ${n}칸을 비어 있는 목표에 채웠습니다(저장 전).`:`${prev}에서 채울 목표가 없습니다(이미 값이 있는 칸은 그대로).`);
  }catch(e){showToast('전월 목표를 불러오지 못했습니다: '+e.message,{type:'error'});}
}
async function _tgSave(){
  if(_TG.saving)return;
  if(_tgInvalidCount()){showToast('숫자가 아닌 칸이 있습니다(빨간 칸).',{type:'error'});return;}
  const items=[];
  _TG.view.forEach(r=>{
    const base={ym:_TG.ym,channelId:r.ch,line:r.line,model:r.model};
    if(_tgChanged(r,'inT')||_tgChanged(r,'inA'))items.push(Object.assign({type:'IN',target:_tgVal(r,'inT'),actual:_tgVal(r,'inA')},base));
    if(_tgChanged(r,'outT')||_tgChanged(r,'outA'))items.push(Object.assign({type:'OUT',target:_tgVal(r,'outT'),actual:r.upload?'':_tgVal(r,'outA')},base));
  });
  if(!items.length){showToast('고친 칸이 없습니다.');return;}
  _TG.saving=true;_tgRender();
  try{
    await _offlineCall('offline_saveTargets',{items});
    showToast(items.length+'줄을 저장했습니다.',{type:'success'});
    _TG.saving=false;
    await _tgLoad();
  }catch(e){showToast('저장 실패: '+e.message,{type:'error'});}
  finally{_TG.saving=false;_tgRender();}
}

// ━━ [단가] 탭 ━━
async function _tgLoadPrices(){
  _TG.priceErr='';
  try{await _offlineLoadMasters();_TG.prices=(await _offlineCall('offline_getPrices')).items;}
  catch(e){_TG.priceErr=e.message;}
  _tgRender();
}
function _tgLineOpts(cur){return PRODUCT_CATALOG.map(l=>`<option value="${_escAttr(l.key)}"${l.key===cur?' selected':''}>${_escHtml(l.label)}</option>`).join('');}
function _tgModelOpts(line,cur){
  const l=PRODUCT_CATALOG.find(x=>x.key===line);
  return '<option value="">— 모델 —</option>'+(l?l.models:[]).map(m=>`<option value="${_escAttr(m.label)}"${m.label===cur?' selected':''}>${_escHtml(m.label)}</option>`).join('');
}
function _tgChOpts(cur,blank){
  return (blank?'<option value="">— 채널 —</option>':'')+((OFFLINE_MASTERS&&OFFLINE_MASTERS.channels)||[]).map(c=>`<option value="${_escAttr(c.channelId)}"${c.channelId===cur?' selected':''}>${_escHtml(c.name)}</option>`).join('');
}
const _tgPriceKey=p=>[p.channelId,p.line,p.model,p.startDate].join('\u0001');
function _tgPricesHtml(){
  if(_TG.priceErr)return `<div class="card"><div class="up-err">${_escHtml(_TG.priceErr)}</div></div>`;
  if(!_TG.prices)return '<div class="card"><div class="mp-empty">불러오는 중…</div></div>';
  const f=_TG.priceForm||(_TG.priceForm={channelId:'',line:PRODUCT_CATALOG[0].key,model:'',price:'',startDate:new Date().toISOString().slice(0,10),note:''});
  const today=new Date().toISOString().slice(0,10);
  // 키(채널·품목군·모델)별로 오늘 적용 중인 행 — 적용시작일 ≤ 오늘 중 가장 최근
  const current={};
  _TG.prices.forEach(p=>{const k=[p.channelId,p.line,p.model].join('|');if(p.startDate<=today&&(!current[k]||p.startDate>current[k]))current[k]=p.startDate;});
  const list=_TG.prices.filter(p=>!_TG.priceCh||p.channelId===_TG.priceCh);
  const lineLabel=k=>{const l=PRODUCT_CATALOG.find(x=>x.key===k);return l?l.label:k;};
  const rows=list.map(p=>{
    const k=_tgPriceKey(p),cur=current[[p.channelId,p.line,p.model].join('|')]===p.startDate;
    if(_TG.priceEditKey===k){
      const e=_TG.priceEdit;
      return `<tr><td>${_escHtml(_offlineChannelName(p.channelId))}</td><td>${_escHtml(lineLabel(p.line))}</td><td>${_escHtml(p.model)}</td>
        <td><input class="f-inp tg-inp" value="${_escAttr(e.price)}" oninput="_TG.priceEdit.price=this.value"></td>
        <td><input type="date" class="f-inp" value="${_escAttr(e.startDate)}" onchange="_TG.priceEdit.startDate=this.value"></td>
        <td><input class="f-inp" value="${_escAttr(e.note)}" oninput="_TG.priceEdit.note=this.value"></td><td></td>
        <td><div class="cm-acts"><button type="button" class="btn-primary up-btn" ${_TG.priceBusy?'disabled':''} onclick="_tgPriceSaveEdit()">저장</button><button type="button" class="btn-cancel up-btn" onclick="_tgPriceCancel()">취소</button></div></td></tr>`;
    }
    return `<tr class="${cur?'':'cm-off'}"><td>${_escHtml(_offlineChannelName(p.channelId))}</td><td>${_escHtml(lineLabel(p.line))}</td><td>${_escHtml(p.model)}</td>
      <td class="num-col">${_tgFmt(p.price)}</td><td>${_escHtml(p.startDate)} ${cur?'<span class="up-chip ready">현재 적용</span>':(p.startDate>today?'<span class="up-chip">예정</span>':'')}</td>
      <td class="cm-wrap cm-reg">${_escHtml(p.note)}</td><td class="cm-reg">${_escHtml(p.updatedAt)}<br>${_escHtml(p.updatedBy)}</td>
      <td><button type="button" class="btn-cancel up-btn" onclick="_tgPriceStartEdit('${_escAttr(k)}')">수정</button></td></tr>`;
  }).join('');
  return `<div class="card"><div class="card-hd">단가 추가<span class="card-hd-r">금액 = 수량 × 그 달 1일 기준 가장 최근 적용시작일의 공급가</span></div>
    <div class="cm-filters">
      <select class="f-sel" onchange="_TG.priceForm.channelId=this.value">${_tgChOpts(f.channelId,true)}</select>
      <select class="f-sel" onchange="_TG.priceForm.line=this.value;_TG.priceForm.model='';_tgRender()">${_tgLineOpts(f.line)}</select>
      <select class="f-sel" onchange="_TG.priceForm.model=this.value">${_tgModelOpts(f.line,f.model)}</select>
      <input class="f-inp tg-inp" placeholder="공급가" value="${_escAttr(f.price)}" oninput="_TG.priceForm.price=this.value">
      <input type="date" class="f-inp" value="${_escAttr(f.startDate)}" onchange="_TG.priceForm.startDate=this.value">
      <input class="f-inp" placeholder="비고" value="${_escAttr(f.note)}" oninput="_TG.priceForm.note=this.value">
      <button type="button" class="btn-primary up-btn" ${_TG.priceBusy?'disabled':''} onclick="_tgPriceAdd()">추가</button>
    </div></div>
  <div class="card"><div class="card-hd">단가 이력<span class="card-hd-r">${list.length}건 · 흐린 줄 = 지난 단가</span></div>
    <div class="cm-filters"><select class="f-sel" onchange="_TG.priceCh=this.value;_tgRender()"><option value="">전체 채널</option>${_tgChOpts(_TG.priceCh,false)}</select></div>
    ${list.length?`<div class="tbl-wrap"><table class="cm-tbl"><thead><tr><th>채널</th><th>품목군</th><th>모델</th><th class="num-col">공급가</th><th>적용시작일</th><th>비고</th><th>수정</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      :'<div class="mp-empty">단가가 없습니다 — 위에서 추가하거나 [이관] 탭에서 납품가 수수료를 가져오세요.</div>'}</div>`;
}
function _tgPriceStartEdit(k){
  const p=_TG.prices.find(x=>_tgPriceKey(x)===k);if(!p)return;
  _TG.priceEditKey=k;_TG.priceEdit={price:String(p.price),startDate:p.startDate,note:p.note||'',orig:p};_tgRender();
}
function _tgPriceCancel(){_TG.priceEditKey=null;_TG.priceEdit=null;_tgRender();}
async function _tgPriceSend(items,ok){
  _TG.priceBusy=true;_tgRender();
  let done=false;
  try{
    await _offlineCall('offline_savePrices',{items});
    showToast(ok,{type:'success'});
    _TG.priceEditKey=null;_TG.priceEdit=null;
    _TG.prices=(await _offlineCall('offline_getPrices')).items;
    _TG.data=null; // 월별 금액이 바뀌므로 월별 입력은 다시 받는다
    done=true;
  }catch(e){showToast('단가 저장 실패: '+e.message,{type:'error'});}
  finally{_TG.priceBusy=false;_tgRender();}
  return done;
}
function _tgPriceSaveEdit(){
  const e=_TG.priceEdit,p=e.orig;
  _tgPriceSend([{channelId:p.channelId,line:p.line,model:p.model,price:String(e.price).replace(/[,\s]/g,''),startDate:e.startDate,note:e.note,origStartDate:p.startDate}],'단가를 수정했습니다.');
}
function _tgPriceAdd(){
  const f=_TG.priceForm;
  if(!f.channelId||!f.model||String(f.price).trim()===''){showToast('채널·모델·공급가를 입력하세요.',{type:'error'});return;}
  _tgPriceSend([{channelId:f.channelId,line:f.line,model:f.model,price:String(f.price).replace(/[,\s]/g,''),startDate:f.startDate,note:f.note}],'단가를 추가했습니다.')
    .then(ok=>{if(ok){_TG.priceForm.price='';_TG.priceForm.note='';_tgRender();}});
}

// ━━ [이관] 탭 ━━
function _tgMigrateHtml(){
  const g=_TG.mig;
  return `<div class="card"><div class="card-hd">진행현황 이관<span class="card-hd-r">기존 '26년 진행현황'(읽기만 함) → 목표실적_월 · 출처 migration</span></div>
    <div class="off-muted tg-help">이관 대상: 모든 월의 IN 목표·IN 실적·OUT 목표, 그리고 OUT 실적은 각 채널 업로드시작월 이전 달만. 반영은 migration 행만 지우고 다시 넣으므로 여러 번 실행해도 결과가 같고, 목표 관리에서 직접 입력한(input) 값은 덮어쓰지 않습니다.</div>
    <div class="cm-filters"><button type="button" class="btn-cancel up-btn" ${g.progBusy?'disabled':''} onclick="_tgProgPreview(false)">${g.prog?'다시 미리보기':'미리보기'}</button>
      ${g.prog?`<button type="button" class="btn-cancel up-btn" ${g.progBusy?'disabled':''} onclick="_tgProgPreview(true)">매핑으로 다시 계산</button>
        <button type="button" class="btn-primary up-btn${g.progConfirm?' cm-danger':''}" ${g.progBusy?'disabled':''} onclick="_tgProgApply()">${g.progConfirm?'반영 확인 — '+g.prog.planRows+'행 쓰기':'반영'}</button>`:''}
      ${g.progBusy?'<span class="up-progress">처리 중…</span>':''}</div>
    ${g.progErr?`<div class="up-err">${_escHtml(g.progErr)}</div>`:''}
    ${g.progResult?`<div class="up-result">✓ 반영 완료 — ${g.progResult.written}행 쓰기(기존 migration ${g.progResult.removed}행 교체)${g.progResult.skippedInput?` · 입력값 보존으로 건너뜀 ${g.progResult.skippedInput}`:''}</div>`:''}
    ${g.prog?_tgProgPreviewHtml(g.prog):''}</div>
  <div class="card"><div class="card-hd">단가 이관<span class="card-hd-r">기존 '납품가 수수료'(읽기만 함) → 단가마스터</span></div>
    <div class="cm-filters"><button type="button" class="btn-cancel up-btn" ${g.priceBusy?'disabled':''} onclick="_tgPricePreview()">${g.price?'다시 미리보기':'미리보기'}</button>
      ${g.price?`<span class="f-lbl">적용시작일</span><input type="date" class="f-inp" value="${_escAttr(g.priceStart)}" onchange="_TG.mig.priceStart=this.value;_tgRender()">
        <button type="button" class="btn-primary up-btn${g.priceConfirm?' cm-danger':''}" ${g.priceBusy?'disabled':''} onclick="_tgPriceApply()">${g.priceConfirm?'반영 확인':'반영'}</button>`:''}
      ${g.priceBusy?'<span class="up-progress">처리 중…</span>':''}</div>
    ${g.price&&g.priceStart&&g.priceStart.slice(8)!=='01'?`<div class="off-muted tg-help">적용시작일(${_escHtml(g.priceStart)})이 속한 달부터가 아니라 <b>다음 달 1일부터</b> 금액이 계산됩니다(그 달 1일 기준 규칙). 연초부터 같은 단가였다면 적용시작일을 해당 달 1일(예: 2026-01-01)로 바꾸세요.</div>`:''}
    ${g.priceErr?`<div class="up-err">${_escHtml(g.priceErr)}</div>`:''}
    ${g.priceResult?`<div class="up-result">✓ 반영 완료 — ${g.priceResult.written}건${g.priceResult.unmapped&&g.priceResult.unmapped.length?` · 미매핑 ${g.priceResult.unmapped.length}건: ${_escHtml(g.priceResult.unmapped.join(', '))}`:''}</div>`:''}
    ${g.price?_tgPricePreviewHtml(g.price):''}</div>
  ${g.log?`<div class="card"><div class="card-hd">이관로그<span class="card-hd-r">최근 20건</span></div>${_tgLogHtml(g.log)}</div>`:''}`;
}
function _tgLogHtml(log){
  if(!log.length)return '<div class="mp-empty">아직 이관 기록이 없습니다.</div>';
  return `<div class="tbl-wrap"><table class="cm-tbl"><thead><tr><th>실행시각</th><th>대상</th><th>월 범위</th><th class="num-col">반영 행수</th><th>미매핑</th><th>상태</th><th>실행자</th></tr></thead><tbody>${
    log.map(x=>`<tr><td>${_escHtml(x.at)}</td><td>${_escHtml(x.target)}</td><td>${_escHtml(x.range)}</td><td class="num-col">${x.count}</td><td class="cm-wrap cm-reg">${_escHtml(x.unmapped)}</td><td>${_escHtml(x.status)}</td><td class="cm-reg">${_escHtml(x.by)}</td></tr>`).join('')}</tbody></table></div>`;
}
// 미리보기 응답의 채널·품목 매핑 → 편집용 상태(이미 고친 값은 유지)
function _tgProgMapFrom(pv){
  const cur=_TG.mig.progMap||{channels:{},products:{}};
  const m={channels:{},products:{}};
  pv.channels.forEach(c=>{m.channels[c.legacy]=c.legacy in cur.channels?cur.channels[c.legacy]:c.channelId;});
  pv.products.forEach(p=>{m.products[p.legacy]=cur.products[p.legacy]||{line:p.line,model:p.model};});
  return m;
}
async function _tgProgPreview(withMap){
  const g=_TG.mig;g.progBusy=true;g.progErr='';g.progConfirm=false;_tgRender();
  try{
    await _offlineLoadMasters();
    const pv=await _offlineCall('offline_migrateProgress',{mode:'preview',mapping:withMap?g.progMap:null});
    g.prog=pv;g.progMap=_tgProgMapFrom(pv);g.log=pv.recentLog;
  }catch(e){g.progErr=e.message;}
  g.progBusy=false;_tgRender();
}
function _tgProgSetCh(legacy,v){_TG.mig.progMap.channels[legacy]=v;_TG.mig.progConfirm=false;}
function _tgProgSetLine(legacy,v){_TG.mig.progMap.products[legacy]={line:v,model:''};_TG.mig.progConfirm=false;_tgRender();}
function _tgProgSetModel(legacy,v){_TG.mig.progMap.products[legacy].model=v;_TG.mig.progConfirm=false;}
async function _tgProgApply(){
  const g=_TG.mig;
  if(!g.progConfirm){g.progConfirm=true;_tgRender();return;}
  g.progBusy=true;g.progErr='';_tgRender();
  try{
    const r=await _offlineCall('offline_migrateProgress',{mode:'apply',mapping:g.progMap});
    g.progResult=r;g.prog=r;g.progMap=_tgProgMapFrom(r);g.log=r.recentLog;
    _TG.data=null;
    showToast('진행현황 '+r.written+'행을 이관했습니다.',{type:'success'});
  }catch(e){g.progErr=e.message;}
  g.progBusy=false;g.progConfirm=false;_tgRender();
}
function _tgProgPreviewHtml(pv){
  const m=_TG.mig.progMap;
  const chRows=pv.channels.map(c=>`<tr><td>${_escHtml(c.legacy)} <span class="off-muted">${_escHtml(c.group)} · ${c.rows}행</span></td>
    <td><select class="f-sel" onchange="_tgProgSetCh('${_escAttr(c.legacy)}',this.value)">${_tgChOpts(m.channels[c.legacy],true)}</select>${c.suggest&&c.suggest!==m.channels[c.legacy]?` <span class="off-muted">제안 ${_escHtml(c.suggest)}</span>`:''}</td></tr>`).join('');
  const prRows=pv.products.map(p=>{
    const cur=m.products[p.legacy]||{line:'',model:''};
    const miss=!cur.line||!cur.model;
    return `<tr class="${miss?'tg-miss':''}"><td>${_escHtml(p.legacy)}${p.ambiguous?' <span class="up-chip applying">모델 선택 필요</span>':''}</td><td class="cm-reg">${_escHtml(p.channels.join(' · '))}</td>
      <td><select class="f-sel" onchange="_tgProgSetLine('${_escAttr(p.legacy)}',this.value)"><option value="">— 품목군 —</option>${_tgLineOpts(cur.line)}</select></td>
      <td><select class="f-sel" onchange="_tgProgSetModel('${_escAttr(p.legacy)}',this.value)">${_tgModelOpts(cur.line,cur.model)}</select></td></tr>`;
  }).join('');
  const cmp=(pv.compare||[]).map(x=>`<tr class="${x.total?'tg-chtot':''}"><td>${_escHtml(_offlineChannelName(x.channelId))}</td><td>${_escHtml(x.model)}</td>
    <td class="num-col">${x.legacy==null?'—':_tgFmt(x.legacy)}</td><td class="num-col">${_tgFmt(x.ledger)}</td>
    <td class="num-col ${x.diff?'tg-diff':''}">${x.diff>0?'+':''}${_tgFmt(x.diff)}</td><td class="cm-reg">${x.total&&x.unmatchedQty?'미매칭 '+x.unmatchedQty:''}</td></tr>`).join('');
  return `<div class="up-stats">원본 <b>${_escHtml(pv.sheetName)}</b> · ${pv.months.length?_escHtml(pv.months[0]+' ~ '+pv.months[pv.months.length-1]):'-'} (${pv.months.length}개월) · 품목 행 <b>${pv.legacyRows}</b> ·
      반영 예정 <b>${pv.planRows}</b>행${pv.skippedInput?` · 입력값 보존 ${pv.skippedInput}`:''} · 업로드 달이라 제외한 OUT 실적 ${pv.outSkippedUploadMonths}칸${pv.badCells?` · 오류 칸 ${pv.badCells}개(빈칸 처리)`:''}</div>
    ${pv.unmapped&&pv.unmapped.length?`<div class="up-err">미매핑(이관하지 않음): ${_escHtml(pv.unmapped.join(', '))}</div>`:''}
    <div class="tg-2col"><div><div class="f-lbl">채널 연결</div><table class="cm-tbl"><tbody>${chRows}</tbody></table></div>
      <div><div class="f-lbl">품목 연결 (모델 모호한 항목은 직접 선택 → [매핑으로 다시 계산])</div><table class="cm-tbl"><thead><tr><th>원본 품목명</th><th>나오는 채널</th><th>품목군</th><th>모델</th></tr></thead><tbody>${prRows}</tbody></table></div></div>
    <div class="f-lbl" style="margin-top:14px">업로드시작월 대조 — 진행현황 OUT 실적 vs 원장 집계 (이관하지 않음)</div>
    ${cmp?`<div class="tbl-wrap"><table class="cm-tbl"><thead><tr><th>채널</th><th>모델</th><th class="num-col">진행현황</th><th class="num-col">원장</th><th class="num-col">차이</th><th></th></tr></thead><tbody>${cmp}</tbody></table></div>`:'<div class="mp-empty">대조할 업로드 채널·월이 없습니다.</div>'}`;
}
async function _tgPricePreview(){
  const g=_TG.mig;g.priceBusy=true;g.priceErr='';g.priceConfirm=false;_tgRender();
  try{
    await _offlineLoadMasters();
    const pv=await _offlineCall('offline_migratePrices',{mode:'preview'});
    g.price=pv;g.log=pv.recentLog;g.priceStart=g.priceStart||pv.baseDate;
    pv.rows.forEach(r=>{if(!g.priceRows[r.rowNo])g.priceRows[r.rowNo]={channelId:r.suggest.channelId,line:r.suggest.line,model:r.suggest.model};});
  }catch(e){g.priceErr=e.message;}
  g.priceBusy=false;_tgRender();
}
function _tgPriceRowSet(rowNo,k,v){const p=_TG.mig.priceRows[rowNo];p[k]=v;if(k==='line')p.model='';_TG.mig.priceConfirm=false;if(k==='line')_tgRender();}
async function _tgPriceApply(){
  const g=_TG.mig;
  if(!g.priceConfirm){g.priceConfirm=true;_tgRender();return;}
  g.priceBusy=true;g.priceErr='';_tgRender();
  try{
    const rows=g.price.rows.map(r=>Object.assign({rowNo:r.rowNo},g.priceRows[r.rowNo]));
    const r=await _offlineCall('offline_migratePrices',{mode:'apply',startDate:g.priceStart,rows});
    g.priceResult=r;g.log=r.recentLog;_TG.prices=null;_TG.data=null;
    showToast('단가 '+r.written+'건을 이관했습니다.',{type:'success'});
  }catch(e){g.priceErr=e.message;}
  g.priceBusy=false;g.priceConfirm=false;_tgRender();
}
function _tgPricePreviewHtml(pv){
  const g=_TG.mig;
  const rows=pv.rows.map(r=>{
    const p=g.priceRows[r.rowNo]||{};
    const miss=!p.channelId||!p.line||!p.model;
    const src=r.suggest.from==='model-code'?'<span class="up-chip ready">MN 코드</span>':(r.suggest.ambiguous?'<span class="up-chip applying">모델 선택 필요</span>':'<span class="up-chip">이름</span>');
    return `<tr class="${miss?'tg-miss':''}"><td class="cm-reg">${r.rowNo}행</td><td>${_escHtml(r.legacyChannel)}</td><td>${_escHtml(r.product)}</td><td class="mp-code">${_escHtml(r.modelCode)}</td><td class="num-col">${_tgFmt(r.supplyPrice)}</td>
      <td><select class="f-sel" onchange="_tgPriceRowSet(${r.rowNo},'channelId',this.value)">${_tgChOpts(p.channelId,true)}</select></td>
      <td><select class="f-sel" onchange="_tgPriceRowSet(${r.rowNo},'line',this.value)"><option value="">— 품목군 —</option>${_tgLineOpts(p.line)}</select></td>
      <td><select class="f-sel" onchange="_tgPriceRowSet(${r.rowNo},'model',this.value)">${_tgModelOpts(p.line,p.model)}</select> ${src}</td></tr>`;
  }).join('');
  return `<div class="up-stats">원본 <b>${_escHtml(pv.sheetName)}</b> · 기준일 ${_escHtml(pv.baseDate||'(못 찾음)')} · ${pv.rows.length}행 · 공급가는 부가세 포함</div>
    <div class="tbl-wrap"><table class="cm-tbl"><thead><tr><th></th><th>원본 채널</th><th>품목</th><th>모델명</th><th class="num-col">공급가</th><th>채널</th><th>품목군</th><th>모델</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
