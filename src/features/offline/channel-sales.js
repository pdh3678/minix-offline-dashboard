'use strict';
/* 채널 상세(#offline/channel/{id}) — (e) 판매 분석: 모델별·지점별 판매량(+ 온라인 점포가 있는 채널은 온라인/오프라인).
   데이터 = offline_getSalesBreakdown(판매원장 판매 등록 수량 · 하이마트는 설치완료 선택, 원본코드 → SKU → 모델은 서버 _offCodeResolver).
   매핑 안 된 코드는 "미매칭(원본코드)" 항목으로 합계에 그대로 들어간다. 모델별 합계 = 지점별 합계 = 카드 머리의 합계.
   필터(기간·단위·대분류·기준)는 이 카드 안에만 있다 — 위쪽 채널 상세 필터와 따로다. channel.js가 그릴 때마다 _osaRender를 부른다.
   색: 많이 팔린 순으로 데이터 시각화 범주 팔레트 8색(9개 이상이면 7색 + '그 외' 회색) — 모델 순위 막대와 지점 누적 막대가 같은 색. */

const _OSA={ch:'',preset:'month',from:'',to:'',unit:'model',category:'',measure:'sale',data:null,err:'',loading:false,showAll:false,q:'',region:'',req:0};
const OSA_TOP_STORES=15;
const OSA_COLORS=['#2a78d6','#eb6834','#1baf7a','#eda100','#e87ba4','#008300','#4a3aa7','#e34948'];
const OSA_OTHER_COLOR='#9CA3AF';

function _osaYmAdd(ym,n){const d=new Date(Date.UTC(+ym.slice(0,4),+ym.slice(5,7)-1+n,1));return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');}
// 기간 — 이번 달 / 최근 3개월 / 올해 / 직접 선택(월 범위)
function _osaRange(){
  const now=_ofThisYm();
  if(_OSA.preset==='3m')return {from:_osaYmAdd(now,-2),to:now};
  if(_OSA.preset==='year')return {from:now.slice(0,4)+'-01',to:now};
  if(_OSA.preset==='custom'&&_OSA.from&&_OSA.to)return {from:_OSA.from,to:_OSA.to};
  return {from:now,to:now};
}
function _osaArgs(){const r=_osaRange();return {channelId:_OSA.ch,from:r.from,to:r.to,unit:_OSA.unit,category:_OSA.category,measure:_OSA.measure};}

// channel.js _ocdRender 끝에서 부른다 — 채널이 바뀌었으면 다시 받는다
function _osaRender(){
  const host=document.getElementById('ocdSalesCard');
  if(!host)return;
  if(_OSA.ch!==_OCD.ch){_OSA.ch=_OCD.ch;_OSA.data=null;_OSA.err='';_OSA.showAll=false;_OSA.q='';_OSA.region='';_osaLoad();return;}
  host.innerHTML=_osaHtml();
}
async function _osaLoad(force){
  const req=++_OSA.req,args=_osaArgs();
  if(!args.channelId)return;
  _OSA.loading=true;_OSA.err='';_osaRender();
  try{
    const d=await _offlineCached('offline_getSalesBreakdown',args,force);
    if(req!==_OSA.req)return;
    _OSA.data=d;
    if(!d.hasInst&&_OSA.measure==='inst'){_OSA.measure='sale';_OSA.loading=false;_osaLoad();return;} // 설치완료가 없는 채널로 옮겨 왔을 때
  }catch(e){if(req!==_OSA.req)return;_OSA.err=e.message;_OSA.data=null;}
  _OSA.loading=false;_osaRender();
}
function _osaSet(k,v){
  if((k==='from'||k==='to')&&!/^\d{4}-\d{2}$/.test(v))return;
  _OSA[k]=v;
  if(k==='preset'&&v==='custom'&&!_OSA.from){const r=_osaRange();_OSA.from=r.from;_OSA.to=r.to;}
  if(_OSA.preset==='custom'&&_OSA.from>_OSA.to){showToast('시작 월이 끝 월보다 늦습니다.',{type:'error'});_osaRender();return;}
  if(k==='q'||k==='region'||k==='showAll'){_osaRenderStores();return;}
  _osaLoad();
}

// 색 — 많이 팔린 순(서버가 정렬한 keys 순서)으로 팔레트, 9개 이상이면 8번째부터 '그 외'
function _osaColors(keys){
  const m={},fold=keys.length>OSA_COLORS.length;
  keys.forEach((k,i)=>{m[k.key]=fold&&i>=OSA_COLORS.length-1?OSA_OTHER_COLOR:OSA_COLORS[i];});
  return m;
}
function _osaUnitLabel(){return _OSA.unit==='sku'?'SKU':'모델';}
const _osaQty=v=>_ofNum(v)+'대';

function _osaHtml(){
  const d=_OSA.data,r=_osaRange();
  const tog=(k,opts)=>`<span class="axis-toggle">${opts.map(([v,l])=>`<button type="button" class="${_OSA[k]===v?'on':''}" onclick="_osaSet('${k}','${v}')">${l}</button>`).join('')}</span>`;
  const catOpts=[['','본품 + 필터'],['*','전체(기타 포함)']].concat(PRODUCT_CATEGORIES.map(c=>[c,c]));
  const ctl=`<div class="cm-filters osa-ctl">
      ${tog('preset',[['month','이번 달'],['3m','최근 3개월'],['year','올해'],['custom','직접 선택']])}
      ${_OSA.preset==='custom'?`<input type="month" class="f-inp of-month" value="${_escAttr(_OSA.from)}" onchange="_osaSet('from',this.value)">~<input type="month" class="f-inp of-month" value="${_escAttr(_OSA.to)}" onchange="_osaSet('to',this.value)">`:''}
      ${tog('unit',[['model','모델'],['sku','SKU']])}
      <label class="of-fl"><span>대분류</span><select class="f-inp f-sel" onchange="_osaSet('category',this.value)">${catOpts.map(([v,l])=>`<option value="${_escAttr(v)}"${_OSA.category===v?' selected':''}>${_escHtml(l)}</option>`).join('')}</select></label>
      ${d&&d.hasInst?tog('measure',[['sale','판매등록'],['inst','설치완료']]):''}
      ${_OSA.loading?'<span class="up-progress">불러오는 중…</span>':''}
    </div>`;
  const head=`<div class="card-hd"><span>판매 분석 <span class="of-sub">${_escHtml(r.from===r.to?r.from:r.from+' ~ '+r.to)} · 판매원장 ${_OSA.measure==='inst'?'설치완료':'판매 등록'} 기준</span></span>
    <span class="card-hd-r">${d?`합계 <b>${_osaQty(d.totals.qty)}</b>${d.totals.unmatchedQty?` · 미매칭 ${_osaQty(d.totals.unmatchedQty)} 포함`:''}`:''}</span></div>`;
  if(_OSA.err)return head+ctl+`<div class="up-err">${_escHtml(_OSA.err)}</div>`;
  if(!d)return head+ctl+'<div class="mp-empty">불러오는 중…</div>';
  if(!d.totals.qty)return head+ctl+'<div class="of-chart-empty">이 기간에 판매 기록이 없습니다.</div>';
  const col=_osaColors(d.keys);
  return head+ctl+`<div class="osa-grid"><div>${_osaRankHtml(d,col)}</div><div>${_osaMonthHtml(d)}</div></div>
    <div id="osaStores">${_osaStoresHtml(d,col)}</div>${_osaOnlineHtml(d)}`;
}

// ── 모델별 판매량 — 순위 막대 ──
function _osaRankHtml(d,col){
  const max=Math.max(1,...d.keys.map(k=>k.total));
  return `<div class="f-lbl">${_osaUnitLabel()}별 판매량 <span class="of-sub">많이 팔린 순</span></div><div class="osa-rank">${d.keys.map(k=>
    `<div class="osa-row" title="${_escAttr(k.label+(k.name?' — '+k.name:'')+' '+_ofNum(k.total)+'대')}"><span class="osa-lb">${_escHtml(k.label)}${k.unmatched&&k.name?` <span class="of-sub">${_escHtml(k.name)}</span>`:''}</span>
      <span class="osa-track"><span class="osa-bar" style="width:${(k.total/max*100).toFixed(1)}%;background:${col[k.key]}"></span></span><span class="osa-v">${_ofNum(k.total)}</span></div>`).join('')}</div>`;
}
// ── 월별 표 — 행 = 모델, 열 = 월 + 합계 + 평균. 셀 색 농도 = 판매량, 🏆 = 그 달 1위 ──
function _osaMonthHtml(d){
  const months=d.months,max=Math.max(1,...d.keys.flatMap(k=>months.map(m=>k.byMonth[m]||0)));
  const top={};months.forEach(m=>{const best=Math.max(0,...d.keys.map(k=>k.byMonth[m]||0));top[m]=best;});
  const cell=(v,m)=>{
    if(!v)return '<td class="num-col"><span class="of-dim">—</span></td>';
    const a=(0.08+0.52*v/max).toFixed(3);
    return `<td class="num-col osa-heat" style="background:rgba(42,120,214,${a})">${v===top[m]?'<span class="osa-trophy" title="이 기간 1위">🏆</span>':''}${_ofNum(v)}</td>`;
  };
  const rows=d.keys.map(k=>`<tr><td>${_escHtml(k.label)}</td>${months.map(m=>cell(k.byMonth[m]||0,m)).join('')}<td class="num-col"><b>${_ofNum(k.total)}</b></td><td class="num-col">${_ofNum(Math.round(k.total/months.length*10)/10)}</td></tr>`).join('');
  const colTot=months.map(m=>d.keys.reduce((s,k)=>s+(k.byMonth[m]||0),0));
  return `<div class="f-lbl">월별 ${_osaUnitLabel()}별 판매량</div>
    <div class="tbl-wrap"><table class="of-tbl osa-mtbl"><thead><tr><th>${_osaUnitLabel()}</th>${months.map(m=>`<th class="num-col">${+m.slice(5)}월</th>`).join('')}<th class="num-col">합계</th><th class="num-col">평균</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr class="of-lv-total"><td>합계</td>${colTot.map(v=>`<td class="num-col">${_ofNum(v)}</td>`).join('')}<td class="num-col">${_ofNum(d.totals.qty)}</td><td class="num-col">${_ofNum(Math.round(d.totals.qty/months.length*10)/10)}</td></tr></tfoot></table></div>
    <div class="of-sub osa-note">월별 모델별 판매량 · 색이 짙을수록 많이 팔린 기간, 트로피는 그 기간의 1위 모델</div>`;
}

// ── 지점별 판매량 — 점포별 가로 누적 막대(모델 색), 합계 많은 순, 상위 15 / 전체 ──
function _osaStoreList(d){
  const q=String(_OSA.q||'').trim().toLowerCase();
  return d.stores.filter(s=>(!_OSA.region||s.region===_OSA.region)&&(!q||[s.storeName,s.store,s.region].join(' ').toLowerCase().indexOf(q)>=0));
}
function _osaStoresHtml(d,col){
  const list=_osaStoreList(d),shown=_OSA.showAll?list:list.slice(0,OSA_TOP_STORES);
  const max=Math.max(1,...list.map(s=>s.total));
  const byLabel={};d.keys.forEach(k=>{byLabel[k.key]=k.label;});
  const fold=d.keys.length>OSA_COLORS.length;
  const legend=d.keys.slice(0,fold?OSA_COLORS.length-1:d.keys.length).map(k=>`<span class="osa-leg"><span class="home-dot" style="background:${col[k.key]}"></span>${_escHtml(k.label)}</span>`).join('')+
    (fold?`<span class="osa-leg"><span class="home-dot" style="background:${OSA_OTHER_COLOR}"></span>그 외 ${d.keys.length-OSA_COLORS.length+1}개</span>`:'');
  const row=s=>{
    const parts=d.keys.filter(k=>s.byKey[k.key]).map(k=>({k,v:s.byKey[k.key]}));
    const segs=parts.map(p=>`<span class="osa-seg" style="width:${(p.v/s.total*100).toFixed(2)}%;background:${col[p.k.key]}"></span>`).join('');
    const detail=parts.slice().sort((a,b)=>b.v-a.v).map(p=>_escHtml(byLabel[p.k.key])+' '+_ofNum(p.v)+'대').join(' · ');
    return `<div class="osa-store" onclick="this.classList.toggle('pin')"><div class="osa-row"><span class="osa-lb">${_escHtml(s.storeName||s.store)} <span class="of-sub">${_escHtml(s.region)}${s.storeType==='온라인'?' · 온라인':''}</span></span>
      <span class="osa-track"><span class="osa-stack" style="width:${(s.total/max*100).toFixed(1)}%">${segs}</span></span><span class="osa-v">${_ofNum(s.total)}</span></div>
      <div class="osa-detail">${detail}</div></div>`;
  };
  return `<div class="f-lbl osa-sec">지점별 판매량 <span class="of-sub">${_ofNum(list.length)}곳 · 합계 많은 순 · 점포를 가리키거나 누르면 ${_osaUnitLabel()} 내역</span></div>
    <div class="cm-filters">
      <input class="f-inp" type="search" placeholder="점포명·코드·지역 검색" value="${_escAttr(_OSA.q)}" oninput="_osaSet('q',this.value)">
      <select class="f-sel" onchange="_osaSet('region',this.value)"><option value="">전체 지역</option>${d.regions.map(r=>`<option value="${_escAttr(r)}"${_OSA.region===r?' selected':''}>${_escHtml(r)}</option>`).join('')}</select>
      <button type="button" class="btn-cancel up-btn" onclick="_osaStoreCsv()">CSV 다운로드 (${_ofNum(list.length)}곳)</button>
    </div>
    <div class="osa-legend">${legend}</div>
    <div class="osa-stores">${shown.map(row).join('')||'<div class="mp-empty">조건에 맞는 점포가 없습니다.</div>'}</div>
    ${list.length>OSA_TOP_STORES?`<div class="mp-foot"><button type="button" class="btn-cancel up-btn" onclick="_osaSet('showAll',${!_OSA.showAll})">${_OSA.showAll?'상위 '+OSA_TOP_STORES+'개만':'전체 보기 ('+_ofNum(list.length)+'곳)'}</button></div>`:''}`;
}
// 검색·지역·전체 보기는 지점 부분만 다시 그린다(검색칸 포커스 유지 — 입력칸이 있는 줄은 그대로 두고 목록만)
function _osaRenderStores(){
  const el=document.getElementById('osaStores'),d=_OSA.data;
  if(!el||!d)return _osaRender();
  const active=document.activeElement,wasSearch=active&&active.type==='search'&&el.contains&&el.contains(active);
  el.innerHTML=_osaStoresHtml(d,_osaColors(d.keys));
  if(wasSearch){const inp=el.querySelector('input[type="search"]');if(inp){inp.focus();try{inp.setSelectionRange(inp.value.length,inp.value.length);}catch(e){}}}
}
function _osaStoreCsv(){
  const d=_OSA.data;if(!d)return;
  const ci=_ofChannelInv(_OCD.inv,_OCD.ch)||{};
  const head=['채널','기간','점포코드','점포명','지역','점포유형','합계'].concat(d.keys.map(k=>k.label));
  const lines=[head].concat(_osaStoreList(d).map(s=>[ci.name||_OCD.ch,d.from===d.to?d.from:d.from+'~'+d.to,s.store,s.storeName,s.region,s.storeType,s.total]
    .concat(d.keys.map(k=>s.byKey[k.key]||0)))).map(a=>a.map(_ocdCsvCell).join(','));
  const blob=new Blob(['﻿'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=`판매분석_지점_${_OCD.ch}_${d.from}_${d.to}.csv`;
  document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},0);
}

// ── 온라인/오프라인 — 점포마스터 점포유형에 온라인 점포가 있는 채널에만 ──
function _osaOnlineHtml(d){
  if(!d.online)return '';
  const o=d.online,t=Math.max(1,o.online+o.offline);
  const bar=(lb,v,c)=>`<div class="osa-row"><span class="osa-lb">${lb}</span><span class="osa-track"><span class="osa-bar" style="width:${(v/t*100).toFixed(1)}%;background:${c}"></span></span><span class="osa-v">${_ofNum(v)} <span class="of-sub">${_ofPct(v/t)}</span></span></div>`;
  return `<div class="f-lbl osa-sec">온라인 / 오프라인 판매량</div>
    <div class="osa-rank">${bar('온라인',o.online,OSA_COLORS[0])}${bar('오프라인',o.offline,OSA_COLORS[1])}</div>
    <div class="of-sub osa-note">온라인 점포: ${_escHtml(o.stores.join(', '))} — 점포마스터의 점포유형 열(시트에서 고칠 수 있음)</div>`;
}
