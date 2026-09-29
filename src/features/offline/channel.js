'use strict';
/* 채널 상세(#offline/channel/{channelId}) — 채널 하나의 목표·실적·판매·재고. #offline/channel 로만 오면 첫 활성 채널로 옮긴다.
   (a) 월별 추이   offline_getMonthly(그 해 1~12월, 이 채널) — IN·OUT 실적 막대 + 목표 선, 대분류 필터
   (b) 일별 Sell-out offline_getDailySales(기본 최근 60일, SKU 단위) — day는 막대, period는 기간 전체를 덮는 블록(높이 = 일평균)
                    하이마트는 [판매등록 / 설치완료]
   (c) 모델·SKU 표 대분류 → 품목군 → 모델 → SKU. 목표·실적은 월별 해석(모델 단위), SKU 행 OUT 실적은 판매원장 기준,
                    재고 열은 offline_getInventory 그룹 지표 그대로. 채널 합계 = 본품 합계, 본품 외(필터·기타)는 그 아래 구분선 뒤
   (d) 점포 표     offline_getInventory(이 채널 점포 표) — 검색·정렬·지역·SKU 필터, 결품 강조, CSV 다운로드 */

const _OCD={ch:'',mon:null,inv:null,skuOut:null,daily:null,err:'',dailyErr:'',dailyRange:null,dmode:'qty',open:{},skuOpen:{},
  store:{q:'',region:'',sku:'',outOnly:false,sort:'storeName',dir:1,limit:300},focusSku:''};
let _ocdMonthlyChart=null,_ocdDailyChart=null;
const OCD_STORE_ROWS=300;

async function mountChannelPage(param){
  _ofOnFilter=()=>{_ocdRender();_ocdLoad();};
  if(!param){
    // #offline/channel → 첫 활성 채널(정렬순서)로
    try{await _offlineLoadMasters();}catch(e){_OCD.err=e.message;_ocdRender();return;}
    const first=((OFFLINE_MASTERS&&OFFLINE_MASTERS.channels)||[]).slice().sort((a,b)=>(Number(a.order)||99)-(Number(b.order)||99)).find(c=>c.active==='Y');
    if(first){_ofGo('offline-channel',first.channelId);return;}
  }
  if(param!==_OCD.ch){
    Object.assign(_OCD,{ch:param||'',mon:null,inv:null,skuOut:null,daily:null,err:'',dailyErr:'',dmode:'qty',open:{},skuOpen:{}});
    _OCD.store=Object.assign(_OCD.store,{q:_OCD.store.pendingQ||'',region:'',sku:'',outOnly:!!_OCD.store.pendingOut,limit:OCD_STORE_ROWS});
  }
  _OCD.store.pendingQ='';_OCD.store.pendingOut=false;
  _ocdRender();
  _ocdLoad();
}
PAGE_MOUNTS['offline-channel']=mountChannelPage;
// 다른 화면(재고 현황 경보 목록)에서 점포·SKU를 짚고 들어올 때
function _ocdOpenFocus(ch,o){
  o=o||{};
  if(o.store){_OCD.store.pendingQ=o.store;_OCD.store.pendingOut=!!o.outOnly;if(ch===_OCD.ch){_OCD.store.q=o.store;_OCD.store.outOnly=!!o.outOnly;}}
  _OCD.focusSku=o.skuId||'';
  _ofGo('offline-channel',ch);
}

// SKU 행 OUT 실적 범위 — 선택한 달(또는 1월~그 달)의 1일~말일
function _ocdSkuRange(){const m=_ofRangeMonths();return {from:m[0]+'-01',to:_ofMonthEnd(m[m.length-1])};}

async function _ocdLoad(force){
  const ch=_OCD.ch,y=_ofYear(),rng=_ocdSkuRange();
  if(!ch)return;
  try{
    const [,mon,inv,skuOut]=await Promise.all([_offlineLoadMasters(),
      _offlineCached('offline_getMonthly',{from:y+'-01',to:y+'-12',channelId:ch},force),
      _offlineCached('offline_getInventory',{channelId:ch},force),
      _offlineCached('offline_getDailySales',{from:rng.from,to:rng.to,channelId:ch,level:'sku'},force)]);
    if(ch!==_OCD.ch)return;
    Object.assign(_OCD,{mon,inv,skuOut,err:''});
  }catch(e){if(ch===_OCD.ch)_OCD.err=e.message;}
  _ocdRender();
  _ocdLoadDaily(force);
}
async function _ocdLoadDaily(force){
  const ch=_OCD.ch;
  if(!_OCD.dailyRange){const to=_ofToday();_OCD.dailyRange={from:_ofAddDays(to,-59),to};}
  const r=_OCD.dailyRange;
  try{
    const d=await _offlineCached('offline_getDailySales',{from:r.from,to:r.to,channelId:ch,level:'sku'},force);
    if(ch!==_OCD.ch)return;
    _OCD.daily=d;_OCD.dailyErr='';
  }catch(e){if(ch===_OCD.ch)_OCD.dailyErr=e.message;}
  _ocdRenderDaily();
}
function _ocdSetRange(which,v){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v))return;
  _OCD.dailyRange[which]=v;
  if(_OCD.dailyRange.from>_OCD.dailyRange.to){showToast('시작일이 끝일보다 늦습니다.',{type:'error'});return;}
  _ocdLoadDaily();
}
function _ocdPreset(days){const to=_ofToday();_OCD.dailyRange={from:_ofAddDays(to,-(days-1)),to};_ocdRenderDailyCtl();_ocdLoadDaily();}
function _ocdSetDmode(v){_OCD.dmode=v;_ocdRenderDaily();}

// ── 그리기 ──
function _ocdRender(){
  const host=document.getElementById('page-offline-channel');
  if(!host)return;
  const chans=((OFFLINE_MASTERS&&OFFLINE_MASTERS.channels)||[]).slice().sort((a,b)=>(Number(a.order)||99)-(Number(b.order)||99))
    .filter(c=>c.active==='Y'||c.channelId===_OCD.ch);
  const tabs=`<div class="of-tabs">${chans.map(c=>`<button type="button" class="of-tab${c.channelId===_OCD.ch?' on':''}" onclick="_ofGo('offline-channel','${_escAttr(c.channelId)}')">${_escHtml(c.name)}${c.active==='Y'?'':'<span class="of-sub">비활성</span>'}</button>`).join('')}</div>`;
  const bar=_ofFilterBarHtml(null,`<span class="of-bar-r"><button type="button" class="btn-cancel up-btn" onclick="_ocdLoad(true)">새로고침</button></span>`);
  if(_OCD.err&&!_OCD.mon){host.innerHTML=tabs+bar+_ofErrorHtml(_OCD.err);return;}
  if(!_OCD.ch){host.innerHTML=tabs+'<div class="card"><div class="mp-empty">활성 채널이 없습니다 — 채널마스터를 확인하세요.</div></div>';return;}
  if(!_OCD.mon||!_OCD.inv){host.innerHTML=tabs+bar+_ofLoadingHtml();return;}
  const ci=_ofChannelInv(_OCD.inv,_OCD.ch)||{};
  const up=ci.hasStock||ci.hasSales;
  host.innerHTML=tabs+bar+_ofFreshnessHtml(_OCD.inv,_OCD.ch)+_ofFilterLineHtml(_OCD.mon,_OCD.inv,_OCD.ch)+
    `<div class="of-row2">
      <div class="card"><div class="card-hd"><span>월별 추이 <span class="of-sub">${_escHtml(_ofYear())}년 · ${OFFLINE_FILTER.unit==='amount'?'금액':'수량'}${OFFLINE_FILTER.category?' · '+_escHtml(OFFLINE_FILTER.category):''}</span></span><span class="card-hd-r">막대 = 실적 · 선 = 목표</span></div>
        <div class="of-chart"><canvas id="ocdMonthlyCanvas"></canvas></div></div>
      <div class="card"><div class="card-hd"><span>일별 Sell-out</span><span class="card-hd-r" id="ocdDailyNote"></span></div>
        <div id="ocdDailyCtl"></div><div id="ocdDailyBody">${up?'<div class="mp-empty">불러오는 중…</div>':'<div class="of-chart-empty">업로드 데이터 없음 — 이 채널은 판매원장이 없습니다.</div>'}</div></div>
    </div>`+
    `<div class="card"><div class="card-hd"><span>모델·SKU <span class="of-sub">${_escHtml(_ofRangeLabel())}</span></span>
      <span class="card-hd-r">▸ 누르면 펼침 · 재고는 최신 기준일${ci.stockDate?' '+_escHtml(ci.stockDate):''} · SKU 행 OUT 실적은 판매원장 기준</span></div>${_ocdTableHtml(ci)}</div>`+
    `<div class="card" id="ocdStoreCard">${up?_ocdStoreHtml(ci):'<div class="card-hd">점포</div><div class="of-chart-empty">업로드 데이터 없음</div>'}</div>`;
  _ocdDrawMonthly();
  if(up){_ocdRenderDailyCtl();_ocdRenderDaily();}
  if(_OCD.focusSku){const el=document.getElementById('ocdSku-'+_OCD.focusSku);if(el&&el.scrollIntoView)el.scrollIntoView({block:'center'});}
}

// (a) 월별 추이
function _ocdDrawMonthly(){
  const el=document.getElementById('ocdMonthlyCanvas');
  if(!el||typeof Chart==='undefined')return;
  const y=_ofYear(),months=[];for(let m=1;m<=12;m++)months.push(y+'-'+String(m).padStart(2,'0'));
  const t=months.map(m=>_ofTotals(_OCD.mon,_OCD.ch,[m],OFFLINE_FILTER.category));
  const v=(side,f)=>t.map(x=>{const n=_ofPick(x[side],f);return n==null?null:n;});
  const money=OFFLINE_FILTER.unit==='amount';
  const fmt=n=>money?_ofWonShort(n):_ofNum(n);
  if(_ocdMonthlyChart)_ocdMonthlyChart.destroy();
  _ocdMonthlyChart=new Chart(el.getContext('2d'),{
    type:'bar',
    data:{labels:months.map(m=>+m.slice(5)+'월'),datasets:[
      {type:'bar',label:'IN 실적',data:v('in','actual'),backgroundColor:'#B7C0F2',order:3},
      {type:'bar',label:'OUT 실적',data:v('out','actual'),backgroundColor:'#3B56E5',order:3},
      {type:'line',label:'IN 목표',data:v('in','target'),borderColor:'#8B93A7',backgroundColor:'#8B93A7',borderDash:[5,4],pointRadius:3,tension:0,spanGaps:false,order:1},
      {type:'line',label:'OUT 목표',data:v('out','target'),borderColor:'#1B2B6B',backgroundColor:'#1B2B6B',borderDash:[5,4],pointRadius:3,tension:0,spanGaps:false,order:1}]},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+' '+fmt(c.raw),afterBody:items=>{
        const i=items[0].dataIndex,x=t[i];return ['IN 달성률 '+_ofPct(_ofSideRate(x.in)),'OUT 달성률 '+_ofPct(_ofSideRate(x.out))];}}}},
      scales:{y:{beginAtZero:true,ticks:{callback:n=>money?_ofWonShort(n):Number(n).toLocaleString('ko-KR')}}}}
  });
}

// (b) 일별 Sell-out
function _ocdRenderDailyCtl(){
  const el=document.getElementById('ocdDailyCtl');
  if(!el||!_OCD.dailyRange)return;
  const r=_OCD.dailyRange,d=_OCD.daily;
  const inst=d&&d.hasInst&&d.hasInst[_OCD.ch];
  el.innerHTML=`<div class="of-ctl"><input type="date" class="f-inp" value="${_escAttr(r.from)}" onchange="_ocdSetRange('from',this.value)">~<input type="date" class="f-inp" value="${_escAttr(r.to)}" onchange="_ocdSetRange('to',this.value)">
    <button type="button" class="btn-cancel up-btn" onclick="_ocdPreset(30)">30일</button><button type="button" class="btn-cancel up-btn" onclick="_ocdPreset(60)">60일</button><button type="button" class="btn-cancel up-btn" onclick="_ocdPreset(90)">90일</button>
    ${inst?`<span class="axis-toggle"><button type="button" class="${_OCD.dmode==='qty'?'on':''}" onclick="_ocdSetDmode('qty')">판매등록</button><button type="button" class="${_OCD.dmode==='inst'?'on':''}" onclick="_ocdSetDmode('inst')">설치완료</button></span>`:''}</div>`;
}
function _ocdRenderDaily(){
  _ocdRenderDailyCtl();
  const body=document.getElementById('ocdDailyBody'),note=document.getElementById('ocdDailyNote');
  if(!body)return;
  if(_OCD.dailyErr){body.innerHTML=`<div class="up-err">${_escHtml(_OCD.dailyErr)}</div>`;return;}
  const d=_OCD.daily;
  if(!d){body.innerHTML='<div class="mp-empty">불러오는 중…</div>';return;}
  const cat=OFFLINE_FILTER.category,f=_OCD.dmode==='inst'?'inst':'qty';
  const keyCat={};(d.keys||[]).forEach(k=>{keyCat[k.key]=k.category;});
  const ok=x=>!cat||keyCat[x.key]===cat; // 미매칭(key '')은 대분류 필터가 있으면 빠진다
  const labels=[];for(let s=d.from;s<=d.to;s=_ofAddDays(s,1))labels.push(s);
  const idx={};labels.forEach((s,i)=>{idx[s]=i;});
  const dayVals=labels.map(()=>0);
  (d.days||[]).forEach(x=>{if(ok(x)&&x.date in idx)dayVals[idx[x.date]]+=x[f]||0;});
  const pmap={};
  (d.periods||[]).forEach(x=>{if(!ok(x))return;const k=x.start+'~'+x.end;(pmap[k]=pmap[k]||{start:x.start,end:x.end,qty:0}).qty+=x[f]||0;});
  const periods=Object.keys(pmap).sort().map(k=>pmap[k]).filter(p=>p.qty);
  const dayTotal=dayVals.reduce((s,v)=>s+v,0),perTotal=periods.reduce((s,p)=>s+p.qty,0);
  if(note)note.textContent=`합계 ${_ofNum(dayTotal+perTotal)}${periods.length?` (일별 ${_ofNum(dayTotal)} + 기간 합산 ${_ofNum(perTotal)})`:''}${cat?' · '+cat:''}`;
  if(!dayTotal&&!perTotal){body.innerHTML='<div class="of-chart-empty">이 기간에 판매 기록이 없습니다.</div>';if(_ocdDailyChart){_ocdDailyChart.destroy();_ocdDailyChart=null;}return;}
  body.innerHTML=`<div class="of-chart of-chart-sm"><canvas id="ocdDailyCanvas"></canvas></div>${periods.length?'<div class="of-sub" style="margin-top:6px">주황 블록 = 여러 날을 합친 기록(period) — 높이는 그 기간의 일평균, 툴팁에 기간·합계. 하이마트는 이전 스냅샷이 없는 날(월초·업로드 공백)이 period로 잡힙니다.</div>':''}`;
  const el=document.getElementById('ocdDailyCanvas');
  if(!el||typeof Chart==='undefined')return;
  const ds=[{type:'bar',label:'일별',data:dayVals,backgroundColor:'#3B56E5',order:2}];
  periods.forEach(p=>{
    const n=Math.round((Date.UTC(+p.end.slice(0,4),+p.end.slice(5,7)-1,+p.end.slice(8,10))-Date.UTC(+p.start.slice(0,4),+p.start.slice(5,7)-1,+p.start.slice(8,10)))/86400000)+1;
    const avg=p.qty/n;
    ds.push({type:'line',label:'기간 '+_ofMD(p.start)+'~'+_ofMD(p.end),_p:Object.assign({days:n,avg},p),data:labels.map(s=>s>=p.start&&s<=p.end?avg:null),
      fill:'origin',backgroundColor:'rgba(245,158,11,.22)',borderColor:'#F59E0B',borderWidth:1.5,pointRadius:0,pointHitRadius:8,tension:0,spanGaps:false,order:1});
  });
  if(_ocdDailyChart)_ocdDailyChart.destroy();
  _ocdDailyChart=new Chart(el.getContext('2d'),{type:'bar',data:{labels:labels.map(_ofMD),datasets:ds},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'nearest',intersect:false,axis:'x'},
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>{
        const p=c.dataset._p;
        if(p)return `기간 ${_ofMD(p.start)}~${_ofMD(p.end)} (${p.days}일) 합계 ${_ofNum(p.qty)} · 일평균 ${Math.round(p.avg*10)/10}`;
        return '일별 '+_ofNum(c.raw);}}}},
      scales:{x:{ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:12}},y:{beginAtZero:true}}}});
}

// (c) 모델·SKU 표
function _ocdRowsSum(rows){
  const s=_ofEmptyTot();rows.forEach(r=>_ofAddTot(s,{in:r.in,out:Object.assign({},r.out,{unmatchedQty:0})}));return s;
}
function _ocdCells(t,g,opt){
  opt=opt||{};
  const c=(side,f)=>t?_ofFmtUnit(_ofPick(t[side],f)):'<span class="of-dim">—</span>';
  const rate=side=>{if(!t)return '<td class="num-col"></td>';const r=_ofSideRate(t[side]);return `<td class="num-col"><span class="of-cell-rate ${_ofRateCls(r)}">${_ofPct(r)}</span></td>`;};
  const outA=opt.skuOut!==undefined?`<td class="num-col" title="판매원장 기준(SKU 단위)">${OFFLINE_FILTER.unit==='amount'?'<span class="of-dim">—</span>':_ofNum(opt.skuOut)}</td>`:`<td class="num-col">${c('out','actual')}${t?_ofIncompleteMark(t.out):''}</td>`;
  const stock=g?`<td class="num-col">${_ofNum(g.stock['정상'])}</td><td class="num-col">${_ofNum(g.stock['전시'])}</td><td class="num-col">${_ofNum(g.stock['리퍼'])}</td>
    <td class="num-col${g.alert==='over'?' cw':g.alert==='risk'?' of-t-bad':''}">${_ofDays(g)}</td><td class="num-col">${_ofNum(g.displayStores)}</td>
    <td>${g.alert==='over'?'<span class="of-badge of-b-over">과다</span>':g.alert==='risk'?'<span class="of-badge of-b-risk">결품 위험</span>':''}${g.storeOuts?` <span class="of-badge of-b-out" title="당월판매가 있는데 재고 0인 점포">결품 ${g.storeOuts}</span>`:''}</td>`
    :'<td class="num-col of-dim">—</td><td class="num-col of-dim">—</td><td class="num-col of-dim">—</td><td class="num-col of-dim">—</td><td class="num-col of-dim">—</td><td></td>';
  return `<td class="num-col">${c('in','target')}</td><td class="num-col">${c('in','actual')}${t?_ofIncompleteMark(t.in):''}</td>${rate('in')}
    <td class="num-col">${c('out','target')}</td>${outA}${opt.skuOut!==undefined?'<td></td>':rate('out')}${stock}`;
}
function _ocdTableHtml(ci){
  const ch=_OCD.ch,cat=OFFLINE_FILTER.category,mset={};_ofRangeMonths().forEach(m=>{mset[m]=true;});
  const rows=(_OCD.mon.rows||[]).filter(r=>r.channelId===ch&&mset[r.ym]);
  const catRows=(_OCD.mon.categoryRows||[]).filter(r=>r.channelId===ch&&mset[r.ym]);
  const groups=(_OCD.inv.groups||[]).filter(g=>g.channelId===ch);
  const G=(lv,k)=>groups.find(g=>g.level===lv&&g.key===k)||null;
  // SKU OUT(원장) — 선택 범위, day+period
  const skuOut={};((_OCD.skuOut&&_OCD.skuOut.days)||[]).concat((_OCD.skuOut&&_OCD.skuOut.periods)||[]).forEach(x=>{if(x.key)skuOut[x.key]=(skuOut[x.key]||0)+x.qty;});
  const hasAny=(t,g)=>(t&&[t.in.target,t.in.actual,t.out.target,t.out.actual].some(v=>v!=null))||(g&&(g.total||g.windowQty));
  // 본품 대분류는 채널 합계 위, 본품 외(필터·기타)는 채널 합계(= 본품 합계) 아래 구분선 뒤에. 대분류 필터가 있으면 그 대분류만
  const main=[],extra=[];
  PRODUCT_CATEGORIES.filter(c=>!cat||c===cat).forEach(c=>{
    const buf=cat||PRODUCT_CATEGORY_ATTR[c].main==='Y'?main:extra;
    const ct=_ofTotals(_OCD.mon,ch,null,c),cg=G('category',c);
    const crs=catRows.filter(x=>x.category===c);
    const lines=PRODUCT_CATALOG.filter(l=>l.category===c);
    const lineHtml=[];
    lines.forEach(line=>{
      const models=line.models.map(m=>m.label);
      rows.forEach(r=>{if(r.line===line.key&&models.indexOf(r.model)<0)models.push(r.model);});
      groups.forEach(g=>{if(g.level==='model'&&g.line===line.key&&models.indexOf(g.model)<0)models.push(g.model);});
      const mHtml=[];
      models.forEach(model=>{
        const mr=rows.filter(r=>r.line===line.key&&r.model===model);
        const mt=mr.length?_ocdRowsSum(mr):null,mg=G('model',line.key+'|'+model);
        const skus=groups.filter(g=>g.level==='sku'&&g.line===line.key&&g.model===model);
        // 재고 지표 그룹이 없는(재고 0·최근 판매 없음) SKU라도 선택 범위에 판매가 있으면 보여 준다
        const sk=((_OCD.skuOut&&_OCD.skuOut.keys)||[]).filter(k=>k.line===line.key&&k.model===model&&skuOut[k.key]&&!skus.some(g=>g.skuId===k.skuId));
        if(!hasAny(mt,mg)&&!sk.length)return;
        const mk=ch+'|'+line.key+'|'+model;
        const open=_OCD.skuOpen[mk]||(_OCD.focusSku&&skus.some(g=>g.skuId===_OCD.focusSku));
        const nSku=skus.length+sk.length;
        mHtml.push(`<tr class="of-lv-model"><td>${nSku?`<button type="button" class="of-fold" onclick="_ocdToggleSku('${_escAttr(mk)}')">${open?'▾':'▸'}</button>`:'<span class="of-fold"> </span>'}${_escHtml(model)}${nSku?` <span class="of-sub">SKU ${nSku}</span>`:''}</td>${_ocdCells(mt,mg)}</tr>`);
        if(open){
          skus.forEach(g=>mHtml.push(`<tr class="of-lv-sku${g.skuId===_OCD.focusSku?' of-focus':''}" id="ocdSku-${_escAttr(g.skuId)}"><td>${_escHtml(g.name)} <span class="of-sub">${_escHtml(g.skuId)}${g.active==='N'?' · 비활성':''}</span></td>${_ocdCells(null,g,{skuOut:skuOut[g.skuId]||0})}</tr>`));
          sk.forEach(k=>mHtml.push(`<tr class="of-lv-sku"><td>${_escHtml(k.name||k.skuId)} <span class="of-sub">${_escHtml(k.skuId)}</span></td>${_ocdCells(null,null,{skuOut:skuOut[k.key]})}</tr>`));
        }
      });
      if(!mHtml.length)return;
      if(lines.length>1)lineHtml.push(`<tr class="of-lv-line"><td>${_escHtml(line.label)}</td>${_ocdCells(_ocdRowsSum(rows.filter(r=>r.line===line.key)),G('line',line.key))}</tr>`);
      lineHtml.push(mHtml.join(''));
    });
    if(!hasAny(ct,cg)&&!lineHtml.length&&!crs.length)return;
    const open=_OCD.open[c]!==false;
    buf.push(`<tr class="of-lv-cat"><td><button type="button" class="of-fold" onclick="_ocdToggleCat('${_escAttr(c)}')">${open?'▾':'▸'}</button>${_escHtml(c)}</td>${_ocdCells(ct,cg)}</tr>`);
    if(!open)return;
    // 대분류 단위 이관 행이 있는 달 — 모델 행을 더해도 대분류 합계가 안 나온다(모델 구분 없는 과거 수치)
    if(crs.length){
      const ms=[...new Set(crs.map(x=>x.ym))].sort();
      buf.push(`<tr class="of-lv-note"><td colspan="13">ⓘ ${_escHtml(ms.map(m=>+m.slice(5)+'월').join('·'))}은(는) 대분류 합계만 존재 — 모델 구분 없는 이관 수치라 모델 행에는 나오지 않고 위 ${_escHtml(c)} 합계에만 들어 있습니다.${crs.some(x=>x.duplicateFields&&x.duplicateFields.length)?' ⚠ 같은 달에 모델 단위 입력도 있어 중복 가능.':''}</td></tr>`);
    }
    buf.push(lineHtml.join(''));
  });
  const tt=_ofTotals(_OCD.mon,ch,null,cat),tg=cat?G('category',cat):G('channel','');
  const um=!cat?`<tr class="of-lv-um"><td>미매칭 코드 <a class="of-link" onclick="_ofGo('admin-code-mapping')">매핑 →</a></td><td class="num-col"></td><td class="num-col"></td><td></td><td class="num-col"></td>
    <td class="num-col" title="매핑 안 된 코드의 판매 — OUT 실적 합계에 들어가지 않은 수량">${tt.out.unmatchedQty?_ofNum(tt.out.unmatchedQty):'—'}</td><td></td>
    <td class="num-col" title="매핑 안 된 코드의 재고(재고구분 모름)">${ci.unmatchedStock?_ofNum(ci.unmatchedStock):'—'}</td><td colspan="5"></td></tr>`:'';
  if(!main.length&&!extra.length)return '<div class="mp-empty">이 범위에 목표·실적·재고가 없습니다.</div>';
  const sep=extra.length?'<tr class="of-lv-sep"><td colspan="13">본품 외 — 위 채널 합계(본품)에 들어가지 않습니다</td></tr>'+extra.join(''):'';
  return `<div class="tbl-wrap"><table class="of-tbl"><thead><tr><th>대분류 / 품목군 / 모델 / SKU</th><th class="num-col">IN 목표</th><th class="num-col">IN 실적</th><th class="num-col">IN 달성률</th>
    <th class="num-col">OUT 목표</th><th class="num-col">OUT 실적</th><th class="num-col">OUT 달성률</th><th class="num-col">정상재고</th><th class="num-col">전시재고</th><th class="num-col">리퍼재고</th>
    <th class="num-col">재고일수</th><th class="num-col">진열 점포</th><th>경보</th></tr></thead>
    <tbody>${main.join('')}${um}<tr class="of-lv-total"><td>${cat?_escHtml(cat)+' 합계':'채널 합계'+(extra.length?' (본품)':'')}</td>${_ocdCells(tt,tg)}</tr>${sep}</tbody></table></div>`;
}
function _ocdToggleCat(c){_OCD.open[c]=_OCD.open[c]===false;_ocdRender();}
function _ocdToggleSku(k){_OCD.skuOpen[k]=!_OCD.skuOpen[k];_OCD.focusSku='';_ocdRender();}

// (d) 점포 표
function _ocdStoreRows(){
  const s=_OCD.store,cat=OFFLINE_FILTER.category,q=String(s.q||'').trim().toLowerCase();
  const skuCat={};((_OCD.inv&&_OCD.inv.groups)||[]).forEach(g=>{if(g.level==='sku')skuCat[g.skuId]=g.category;});
  const rows=((_OCD.inv&&_OCD.inv.stores)||[]).filter(r=>{
    if(s.region&&r.region!==s.region)return false;
    if(s.sku==='-'){if(r.skuId)return false;}else if(s.sku&&r.skuId!==s.sku)return false;
    if(cat&&(!r.skuId||skuCat[r.skuId]!==cat))return false;
    if(s.outOnly&&!r.out)return false;
    if(q&&[r.storeName,r.store,r.region].join(' ').toLowerCase().indexOf(q)<0)return false;
    return true;
  });
  const k=s.sort,dir=s.dir;
  const val=r=>k==='sku'?(r.skuId?_ofSkuName(r.skuId):'~'+r.code):r[k];
  rows.sort((a,b)=>{const x=val(a),y=val(b);return (typeof x==='number'&&typeof y==='number'?x-y:String(x||'').localeCompare(String(y||''),'ko'))*dir;});
  return rows;
}
function _ocdStoreHtml(ci){
  const s=_OCD.store,all=(_OCD.inv.stores||[]);
  const regions=[...new Set(all.map(r=>r.region).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ko'));
  const skus=[...new Set(all.map(r=>r.skuId).filter(Boolean))];
  const rows=_ocdStoreRows(),shown=rows.slice(0,s.limit);
  const nOut=all.filter(r=>r.out).length;
  const src=ci.monthSaleSource==='ledger'?`당월판매 = 판매원장의 ${_escHtml(ci.monthSaleMonth)} 점포별 일별 판매 합`
    :`당월판매 = 재고 파일의 당월 누적 판매(${_escHtml(ci.monthSaleMonth)})`;
  return `<div class="card-hd"><span>점포 <span class="of-sub">재고 기준일 ${_escHtml(ci.storeDate||ci.stockDate||'')} · 점포마스터 ${_ofNum(ci.storeTotal)}곳</span></span>
      <span class="card-hd-r">${nOut?`<span class="of-badge of-b-out">점포 결품 ${nOut}</span> `:''}결품 = 당월판매 > 0 인데 재고 0</span></div>
    <div class="of-note" style="margin-bottom:10px">${src}</div>
    <div class="cm-filters">
      <input class="f-inp" type="search" placeholder="점포명·코드·지역 검색" value="${_escAttr(s.q)}" oninput="_ocdStoreSet('q',this.value,true)">
      <select class="f-sel" onchange="_ocdStoreSet('region',this.value)"><option value="">전체 지역</option>${regions.map(r=>`<option value="${_escAttr(r)}"${s.region===r?' selected':''}>${_escHtml(r)}</option>`).join('')}</select>
      <select class="f-sel" onchange="_ocdStoreSet('sku',this.value)"><option value="">전체 SKU</option>${skus.map(id=>`<option value="${_escAttr(id)}"${s.sku===id?' selected':''}>${_escHtml(_ofSkuName(id))}</option>`).join('')}<option value="-"${s.sku==='-'?' selected':''}>미매칭 코드</option></select>
      <label class="of-fl"><input type="checkbox"${s.outOnly?' checked':''} onchange="_ocdStoreSet('outOnly',this.checked)"> 결품만</label>
      <button type="button" class="btn-cancel up-btn" onclick="_ocdStoreCsv()">CSV 다운로드 (${_ofNum(rows.length)}행)</button>
    </div>
    <div id="ocdStoreTbl">${_ocdStoreTableHtml(rows,shown)}</div>`;
}
function _ocdStoreTableHtml(rows,shown){
  const s=_OCD.store;
  const th=(k,lb,num)=>`<th class="sortable${s.sort===k?' sorted':''}${num?' num-col':''}" onclick="_ocdStoreSort('${k}')">${lb}<span class="sort-ic">${s.sort===k?(s.dir>0?'▲':'▼'):'⇕'}</span></th>`;
  if(!rows.length)return '<div class="mp-empty">조건에 맞는 점포가 없습니다.</div>';
  return `<div class="tbl-wrap"><table class="of-tbl"><thead><tr>${th('storeName','점포')}${th('region','지역')}${th('sku','SKU')}${th('정상','정상',1)}${th('전시','전시',1)}${th('리퍼','리퍼',1)}${th('total','합계',1)}${th('monthSale','당월판매',1)}<th>진열</th><th></th></tr></thead><tbody>${
    shown.map(r=>`<tr class="${r.out?'of-out':''}"><td>${_escHtml(r.storeName||r.store)} <span class="of-sub">${_escHtml(r.store)}</span></td><td>${_escHtml(r.region)}</td>
      <td>${r.skuId?_escHtml(_ofSkuName(r.skuId)):`<span class="off-miss">미매칭</span> <span class="mp-code">${_escHtml(r.code)}</span>`}</td>
      <td class="num-col">${r.skuId?_ofNum(r['정상']):''}</td><td class="num-col">${r.skuId?_ofNum(r['전시']):''}</td><td class="num-col">${r.skuId?_ofNum(r['리퍼']):''}</td><td class="num-col"><b>${_ofNum(r.total)}</b></td>
      <td class="num-col">${_ofNum(r.monthSale)}</td><td>${r.display?'✓':''}</td><td>${r.out?'<span class="of-badge of-b-out">결품</span>':''}</td></tr>`).join('')}</tbody></table></div>`+
    (rows.length>shown.length?`<div class="mp-foot"><span class="off-muted">${_ofNum(shown.length)} / ${_ofNum(rows.length)}행 표시</span><button type="button" class="btn-cancel up-btn" onclick="_ocdStoreMore()">더 보기</button><span class="off-muted">CSV에는 전부 들어갑니다</span></div>`:'');
}
function _ocdStoreRefresh(){
  const el=document.getElementById('ocdStoreTbl');
  const rows=_ocdStoreRows();
  if(el)el.innerHTML=_ocdStoreTableHtml(rows,rows.slice(0,_OCD.store.limit));
}
// 검색어 입력 중에는 표만 다시 그린다(입력칸 포커스 유지)
function _ocdStoreSet(k,v,tableOnly){
  _OCD.store[k]=v;_OCD.store.limit=OCD_STORE_ROWS;
  if(tableOnly){_ocdStoreRefresh();return;}
  const card=document.getElementById('ocdStoreCard');
  if(card)card.innerHTML=_ocdStoreHtml(_ofChannelInv(_OCD.inv,_OCD.ch)||{});
}
function _ocdStoreSort(k){const s=_OCD.store;if(s.sort===k)s.dir=-s.dir;else{s.sort=k;s.dir=(k==='storeName'||k==='region'||k==='sku')?1:-1;}_ocdStoreRefresh();}
function _ocdStoreMore(){_OCD.store.limit+=OCD_STORE_ROWS;_ocdStoreRefresh();}
function _ocdCsvCell(v){const s=String(v==null?'':v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}
function _ocdStoreCsv(){
  const ci=_ofChannelInv(_OCD.inv,_OCD.ch)||{};
  const head=['채널','기준일','점포코드','점포명','지역','sku_id','SKU','원본코드(미매칭)','정상','전시','리퍼','미매칭 재고','합계','당월판매','진열','결품'];
  const lines=[head].concat(_ocdStoreRows().map(r=>[ci.name,ci.storeDate||ci.stockDate,r.store,r.storeName,r.region,r.skuId,r.skuId?_ofSkuName(r.skuId):'',r.code,
    r['정상'],r['전시'],r['리퍼'],r.other||0,r.total,r.monthSale,r.display?'Y':'',r.out?'Y':''])).map(a=>a.map(_ocdCsvCell).join(','));
  // 엑셀이 한글을 깨뜨리지 않도록 BOM
  const blob=new Blob(['﻿'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=`점포재고_${_OCD.ch}_${ci.storeDate||ci.stockDate||_ofToday()}.csv`;
  document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},0);
}
