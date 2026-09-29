'use strict';
/* 목표 관리(#admin/targets) [연간 보기] 탭 — 행 = 채널 × 대분류 / 품목군 / 모델, 열 = 1~12월 + 연 합계.
   [IN / OUT] · [목표 / 실적 / 달성률]. 데이터 = offline_getMonthly(그 해 1~12월) — 월별 입력 탭과 같은 해석이라 월 합계가 같다.
   목표 보기에서만 칸 편집·엑셀 붙여넣기. 저장은 바뀐 칸만 offline_saveTargets 로 보내되 **목표만** 보낸다
   (actual 키를 빼면 서버가 실적 칸을 그대로 둔다). 대분류 단위 이관 행(모델 구분 없는 과거 수치)은 읽기 전용 줄.
   칸을 고칠 때는 표를 다시 그리지 않고 합계 칸만 갱신한다(월별 입력 탭과 같은 이유 — Tab으로 연달아 입력). */

const _TGA={year:'',side:'IN',view:'target',ch:'',data:null,err:'',edits:{},saving:false,collapsed:{},rows:[]};
function _tgaMonths(){const o=[];for(let m=1;m<=12;m++)o.push(_TGA.year+'-'+String(m).padStart(2,'0'));return o;}
const _tgaEditKey=(side,rowKey,ym)=>side+'\u0001'+rowKey+'\u0001'+ym;

async function _tgaLoad(force){
  if(!_TGA.year)_TGA.year=(_TG.ym||_tgThisYm()).slice(0,4);
  _TGA.err='';_TGA.data=null;_tgRender();
  try{
    const [,d]=await Promise.all([_offlineLoadMasters(),_offlineCached('offline_getMonthly',{from:_TGA.year+'-01',to:_TGA.year+'-12',channelId:_TGA.ch},force)]);
    _TGA.data=d;
  }catch(e){_TGA.err=e.message;}
  _tgRender();
}
function _tgaChangedCount(){return Object.keys(_TGA.edits).filter(k=>_tgaIsChanged(k)).length;}
// 저장하지 않은 변경이 있으면 연도·채널을 못 바꾼다(변경분이 다른 해 표에 섞이지 않게)
function _tgaGuard(){if(_tgaChangedCount()){showToast('저장하지 않은 변경 '+_tgaChangedCount()+'칸이 있습니다 — 저장하거나 되돌린 뒤 바꾸세요.',{type:'error'});_tgRender();return false;}return true;}
function _tgaSetYear(v){if(!/^\d{4}$/.test(v)||!_tgaGuard())return;_TGA.year=v;_TGA.edits={};_tgaLoad();}
function _tgaSetCh(v){if(!_tgaGuard())return;_TGA.ch=v;_TGA.edits={};_tgaLoad();}
function _tgaSet(k,v){_TGA[k]=v;_tgRender();}

// ── 표 모델 ──
function _tgaBuild(){
  const d=_TGA.data||{rows:[],categoryRows:[]},m=OFFLINE_MASTERS||{};
  const hasData=ch=>(d.rows||[]).some(r=>r.channelId===ch)||(d.categoryRows||[]).some(c=>c.channelId===ch);
  const chans=(m.channels||[]).slice().sort((a,b)=>(Number(a.order)||99)-(Number(b.order)||99))
    .filter(c=>_TGA.ch?c.channelId===_TGA.ch:(c.active==='Y'||hasData(c.channelId)));
  const byKey={};(d.rows||[]).forEach(r=>{const k=r.channelId+'|'+r.line+'|'+r.model;(byKey[k]=byKey[k]||{known:r.knownModel!==false,m:{}}).m[r.ym]=r;});
  const cat={};(d.categoryRows||[]).forEach(c=>{(cat[c.channelId+'|'+c.category]=cat[c.channelId+'|'+c.category]||{})[c.ym]=c;});
  const rows=[];
  chans.forEach(c=>PRODUCT_CATALOG.forEach(line=>{
    const models=line.models.map(x=>x.label);
    (d.rows||[]).forEach(r=>{if(r.channelId===c.channelId&&r.line===line.key&&models.indexOf(r.model)<0)models.push(r.model);});
    models.forEach(model=>{
      const k=c.channelId+'|'+line.key+'|'+model,x=byKey[k];
      rows.push({key:k,ch:c.channelId,category:line.category,line:line.key,lineLabel:line.label,model,months:x?x.m:{},known:!x||x.known});
    });
  }));
  _TGA.rows=rows;_TGA.cat=cat;
  return chans;
}
// 원래 값(서버) — side 'IN'/'OUT', f 'target'/'actual'
function _tgaOrig(src,ym,f){const r=src&&src[ym];if(!r)return null;const s=_TGA.side==='IN'?r.in:r.out;return s&&s[f]!=null?s[f]:null;}
// 화면 목표 값(고친 값 우선) — 숫자 | null | NaN(잘못된 입력)
function _tgaTarget(row,ym){
  const k=_tgaEditKey(_TGA.side,row.key,ym);
  if(k in _TGA.edits){const s=String(_TGA.edits[k]).replace(/[,\s]/g,'');return s===''?null:Number(s);}
  return _tgaOrig(row.months,ym,'target');
}
function _tgaIsChanged(k){
  const [side,rowKey,ym]=k.split('\u0001');
  const row=_TGA.rows.find(r=>r.key===rowKey);if(!row)return false;
  const s=String(_TGA.edits[k]).replace(/[,\s]/g,''),v=s===''?null:Number(s);
  const r=row.months[ym],o=r?(side==='IN'?r.in:r.out).target:null;
  return !(v===o||(v!=null&&o!=null&&Number(v)===Number(o)));
}
// 칸 값(보기에 따라)
function _tgaCell(row,ym){
  if(_TGA.view==='target')return _tgaTarget(row,ym);
  const a=_tgaOrig(row.months,ym,'actual');
  if(_TGA.view==='actual')return a;
  return _ofRate(a,_tgaTarget(row,ym));
}
function _tgaCatCell(cr,ym,f){return _tgaOrig(cr,ym,f);}

/* 합계 — scope: cat:ch|대분류 · ln:ch|품목군 · ch:ch · all. 대분류·채널·전체에는 대분류 단위(이관) 행도 더한다(월별 입력 탭과 같은 규칙).
   채널·전체 = 본품 합계(필터·기타는 자기 대분류 합계에만 — 월별 입력 탭과 같은 규칙).
   반환 {ym|'Y': {t, a}} — t = 목표 합(고친 값 포함), a = 실적 합 */
function _tgaTotals(){
  const T={},months=_tgaMonths();
  const add=(scope,ym,t,a)=>{
    const s=T[scope]||(T[scope]={}),o=s[ym]||(s[ym]={t:null,a:null});
    if(t!=null&&isFinite(t))o.t=(o.t||0)+t;
    if(a!=null)o.a=(o.a||0)+a;
  };
  const shown={};
  _TGA.rows.forEach(r=>{shown[r.ch]=true;months.forEach(ym=>{
    const t=_tgaTarget(r,ym),a=_tgaOrig(r.months,ym,'actual');
    ['cat:'+r.ch+'|'+r.category,'ln:'+r.ch+'|'+r.line,'row:'+r.key].concat(_tgIsMain(r.category)?['ch:'+r.ch,'all']:[]).forEach(s=>{add(s,ym,t,a);add(s,'Y',t,a);});
  });});
  Object.keys(_TGA.cat||{}).forEach(k=>{
    const [ch,cat]=k.split('|');if(!shown[ch])return;
    months.forEach(ym=>{const t=_tgaOrig(_TGA.cat[k],ym,'target'),a=_tgaOrig(_TGA.cat[k],ym,'actual');
      ['cat:'+k,'catrow:'+k].concat(_tgIsMain(cat)?['ch:'+ch,'all']:[]).forEach(s=>{add(s,ym,t,a);add(s,'Y',t,a);});});
  });
  return T;
}
function _tgaFmtTot(o){
  if(!o)return '';
  if(_TGA.view==='target')return _tgFmt(o.t);
  if(_TGA.view==='actual')return _tgFmt(o.a);
  return _tgRate(o.a,o.t);
}
const _tgaId=scope=>'tga'+scope.replace(/[^A-Za-z0-9]/g,c=>'_'+c.charCodeAt(0));

// ── 그리기 ──
function _tgaHtml(){
  const m=OFFLINE_MASTERS||{},Y=+(_TGA.year||(_TG.ym||_tgThisYm()).slice(0,4));
  const tog=(k,opts)=>`<span class="axis-toggle">${opts.map(([v,l])=>`<button type="button" class="${_TGA[k]===v?'on':''}" onclick="_tgaSet('${k}','${v}')">${l}</button>`).join('')}</span>`;
  const head=`<div class="card"><div class="card-hd">연간 보기<span class="card-hd-r">월별 입력과 같은 해석 · 목표 보기에서만 편집(엑셀 범위 붙여넣기 가능) · 저장은 바뀐 목표 칸만</span></div>
    <div class="cm-filters">
      <select class="f-sel" onchange="_tgaSetYear(this.value)">${[Y-1,Y,Y+1].map(y=>`<option value="${y}"${String(y)===_TGA.year?' selected':''}>${y}년</option>`).join('')}</select>
      <select class="f-sel" onchange="_tgaSetCh(this.value)"><option value="">활성 채널 전체</option>${(m.channels||[]).map(c=>
        `<option value="${_escAttr(c.channelId)}"${_TGA.ch===c.channelId?' selected':''}>${_escHtml(c.name)}${c.active==='Y'?'':' (비활성)'}</option>`).join('')}</select>
      ${tog('side',[['IN','IN'],['OUT','OUT']])}${tog('view',[['target','목표'],['actual','실적'],['rate','달성률']])}${_tgNonMainToggleHtml()}
      ${_TGA.view==='target'?`<button type="button" class="btn-primary up-btn" id="tgaSaveBtn" ${_TGA.saving?'disabled':''} onclick="_tgaSave()">저장</button>
        <button type="button" class="btn-cancel up-btn" onclick="_tgaRevert()">되돌리기</button>`:''}
      <span class="off-muted" id="tgaDirty"></span>
    </div></div>`;
  if(_TGA.err)return head+`<div class="card"><div class="up-err">${_escHtml(_TGA.err)}</div></div>`;
  if(!_TGA.data)return head+'<div class="card"><div class="mp-empty">불러오는 중…</div></div>';
  const chans=_tgaBuild(),months=_tgaMonths();
  const th=`<tr><th>채널 / 품목</th>${months.map(ym=>`<th class="num-col">${+ym.slice(5)}월</th>`).join('')}<th class="num-col">연 합계</th></tr>`;
  const totRow=(scope,label,cls)=>`<tr class="${cls}"><td>${label}</td>${months.concat(['Y']).map(ym=>`<td class="num-col" id="${_tgaId(scope)}_${ym.slice(-2)}"></td>`).join('')}</tr>`;
  let body='';
  chans.forEach(c=>{
    body+=`<tr class="tg-ch"><td colspan="14">${_escHtml(c.name)}${c.active==='Y'?'':' <span class="up-chip">비활성</span>'}${_TGA.side==='OUT'&&c.uploadStartMonth?` <span class="up-chip ready">OUT 실적 = 업로드 원장(${_escHtml(c.uploadStartMonth)}~)</span>`:''}</td></tr>`;
    // 본품 대분류 → 채널 합계(본품) → "비본품 표시"면 구분선 뒤에 필터·기타
    const catBody=cat=>{
      let h='';
      const ck=c.channelId+'|'+cat,cr=(_TGA.cat||{})[ck],lines=PRODUCT_CATALOG.filter(l=>l.category===cat);
      const closed=_tgaCatClosed(ck);
      h+=totRow('cat:'+ck,`<button type="button" class="tg-fold" onclick="_tgaFold('${_escAttr(ck)}')">${closed?'▸':'▾'}</button> ${_escHtml(cat)}${cr?' <span class="up-chip">이관 대분류 합계 포함</span>':''}`,'tg-cat');
      if(closed)return h;
      if(cr)h+=`<tr class="tg-catrow"><td class="tg-model">이관(모델 구분 없음)</td>${months.map(ym=>{
        const t=_tgaCatCell(cr,ym,'target'),a=_tgaCatCell(cr,ym,'actual');
        return `<td class="num-col tg-ro">${_TGA.view==='target'?_tgFmt(t):_TGA.view==='actual'?_tgFmt(a):_tgRate(a,t)}</td>`;}).join('')}<td class="num-col tg-ro" id="${_tgaId('catrow:'+ck)}_Y"></td></tr>`;
      lines.forEach(line=>{
        if(lines.length>1)h+=totRow('ln:'+c.channelId+'|'+line.key,_escHtml(line.label),'tg-line');
        _TGA.rows.forEach((r,i)=>{if(r.ch===c.channelId&&r.line===line.key)h+=_tgaRowHtml(r,i,months);});
      });
      return h;
    };
    body+=PRODUCT_MAIN_CATEGORIES.map(catBody).join('')+totRow('ch:'+c.channelId,_escHtml(c.name)+' 합계','tg-chtot');
    if(_TG.nonMain)body+=`<tr class="tg-sep"><td colspan="14">본품 외 — ${_escHtml(c.name)} 합계·전체 합계에 들어가지 않습니다</td></tr>`+PRODUCT_EXTRA_CATEGORIES.map(catBody).join('');
  });
  body+=totRow('all','전체 합계','tg-grand');
  return head+`<div class="card"><div class="tbl-wrap"><table class="tg-tbl tga-tbl"><thead>${th}</thead><tbody>${body}</tbody></table></div></div>`;
}
function _tgaRowHtml(r,i,months){
  const edit=_TGA.view==='target'&&r.known;
  const cells=months.map((ym,mi)=>{
    const v=_tgaCell(r,ym);
    if(!edit)return `<td class="num-col${_TGA.view==='target'?' tg-ro':''}">${_TGA.view==='rate'?_ofPct(v):_tgFmt(v)}</td>`;
    const k=_tgaEditKey(_TGA.side,r.key,ym),changed=(k in _TGA.edits)&&_tgaIsChanged(k),bad=v!=null&&!isFinite(v);
    return `<td class="num-col"><input class="tg-inp tga-inp${changed?' changed':''}${bad?' bad':''}" data-r="${i}" data-m="${mi}" value="${_escAttr(k in _TGA.edits?_TGA.edits[k]:(v==null?'':v))}" inputmode="numeric" oninput="_tgaInput(this)" onpaste="_tgaPaste(event,this)"></td>`;
  }).join('');
  return `<tr class="tg-row"><td class="tg-model">${_escHtml(r.model)}${r.known?'':' <span class="up-chip applying" title="품목 상수에 없는 모델 — 편집하려면 품목 상수에 추가">상수 없음</span>'}</td>${cells}<td class="num-col" id="${_tgaId('row:'+r.key)}_Y"></td></tr>`;
}
function _tgaCatClosed(ck){const [ch,cat]=ck.split('|');return _TGA.collapsed[ck]!=null?_TGA.collapsed[ck]:!_tgaCatHas(ch,cat);} // 데이터 없는 대분류는 접힌 채로 시작
function _tgaFold(ck){_TGA.collapsed[ck]=!_tgaCatClosed(ck);_tgRender();}
function _tgaCatHas(ch,cat){return !!(_TGA.cat||{})[ch+'|'+cat]||_TGA.rows.some(r=>r.ch===ch&&r.category===cat&&_tgaMonths().some(ym=>_tgaTarget(r,ym)!=null||_tgaOrig(r.months,ym,'actual')!=null));}
// 표를 그린 뒤·칸을 고칠 때마다 합계 칸·행 연 합계·저장 버튼만 갱신
function _tgaRefresh(){
  if(!_TGA.data)return;
  const T=_tgaTotals(),set=(id,v)=>{const el=document.getElementById(id);if(el)el.innerHTML=v;};
  Object.keys(T).forEach(scope=>{Object.keys(T[scope]).forEach(ym=>{set(_tgaId(scope)+'_'+ym.slice(-2),_tgaFmtTot(T[scope][ym]));});});
  const n=_tgaChangedCount(),bad=Object.keys(_TGA.edits).filter(k=>{const s=String(_TGA.edits[k]).replace(/[,\s]/g,'');return s!==''&&!isFinite(Number(s));}).length;
  set('tgaDirty',n?`고친 칸 ${n}개${bad?` · 숫자가 아닌 칸 ${bad}개`:''}`:'');
  const b=document.getElementById('tgaSaveBtn');if(b)b.textContent=n?`저장 (${n})`:'저장';
}
function _tgaInput(el){
  const r=_TGA.rows[+el.dataset.r],ym=_tgaMonths()[+el.dataset.m];if(!r||!ym)return;
  const k=_tgaEditKey(_TGA.side,r.key,ym);
  _TGA.edits[k]=el.value;
  el.classList.toggle('changed',_tgaIsChanged(k));
  const s=String(el.value).replace(/[,\s]/g,'');el.classList.toggle('bad',s!==''&&!isFinite(Number(s)));
  _tgaRefresh();
}
/* 엑셀 범위 붙여넣기 — 탭·줄바꿈으로 나눠 이 칸부터 오른쪽(다음 달)·아래(화면에 보이는 모델 줄 순서)로 채운다 */
function _tgaPaste(ev,el){
  const text=(ev.clipboardData||window.clipboardData||{getData:()=>''}).getData('text');
  if(!/[\t\n]/.test(text))return;
  ev.preventDefault();
  const lines=text.replace(/\r/g,'').split('\n');if(lines.length&&lines[lines.length-1]==='')lines.pop();
  const visible=[...document.querySelectorAll('.tga-tbl tr.tg-row')].map(tr=>{const inp=tr.querySelector('input[data-r]');return inp?+inp.dataset.r:null;}).filter(x=>x!=null);
  const start=visible.indexOf(+el.dataset.r),m0=+el.dataset.m,months=_tgaMonths();
  let n=0;
  lines.forEach((line,di)=>{
    const r=_TGA.rows[visible[start+di]];if(!r||!r.known)return;
    line.split('\t').forEach((cell,dj)=>{const ym=months[m0+dj];if(!ym)return;_TGA.edits[_tgaEditKey(_TGA.side,r.key,ym)]=cell.trim();n++;});
  });
  _tgRender();
  showToast(n+'칸을 붙여넣었습니다.');
}
function _tgaRevert(){_TGA.edits={};_tgRender();}
async function _tgaSave(){
  if(_TGA.saving)return;
  const keys=Object.keys(_TGA.edits).filter(_tgaIsChanged);
  const bad=keys.filter(k=>{const s=String(_TGA.edits[k]).replace(/[,\s]/g,'');return s!==''&&!isFinite(Number(s));});
  if(bad.length){showToast('숫자가 아닌 칸이 있습니다(빨간 칸).',{type:'error'});return;}
  if(!keys.length){showToast('고친 칸이 없습니다.');return;}
  // 목표만 보낸다 — actual 키가 없으면 서버가 실적 칸을 건드리지 않는다
  const items=keys.map(k=>{
    const [side,rowKey,ym]=k.split('\u0001'),r=_TGA.rows.find(x=>x.key===rowKey);
    return {ym,channelId:r.ch,line:r.line,model:r.model,type:side,target:String(_TGA.edits[k]).replace(/[,\s]/g,'')};
  });
  _TGA.saving=true;_tgRender();
  try{
    await _offlineCall('offline_saveTargets',{items});
    showToast(items.length+'칸을 저장했습니다.',{type:'success'});
    _TGA.edits={};_TGA.saving=false;_TG.data=null; // 월별 입력 탭도 다시 받는다
    await _tgaLoad(true);
  }catch(e){showToast('저장 실패: '+e.message,{type:'error'});}
  finally{_TGA.saving=false;_tgRender();}
}
