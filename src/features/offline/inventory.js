'use strict';
/* 재고 현황(#offline/inventory) — SKU × 채널 재고와 경보. 지표는 전부 offline_getInventory(서버 _offInventoryCompute) 값 그대로.
   · 매트릭스: 셀 = 재고수량(재고구분 토글 [정상 / 전시 / 리퍼 / 전체]) + 재고일수(항상 정상 기준), 경보 색. 대분류 필터
     열 = 재고 채널(채널대분류로 묶은 머리). 채널 대분류 필터가 걸리면 그 대분류 채널만 · '전체' 열도 그 채널의 합(경보 색은 채널 열에만)
     대분류 '전체'면 본품 → 합계(본품) → 구분선 → 본품 외(필터·기타)
   · 경보 목록: [과다 / 결품 위험 / 점포 결품] — 채널 상세(해당 SKU·점포)로 이동. 기타는 서버가 경보에서 뺀다(필터는 포함)
   · 재고 추이: 모델 또는 SKU → 채널별 선(offline_getInventoryTrend, 재고_채널일별)
   · 설정 모달(관리자): 재고일수 판매 기준일수·과다일수·결품위험일수·데이터 지연 경고일수 → offline_saveSettings */

const _OIV={inv:null,err:'',type:'정상',atab:'over',trend:{sel:'',from:'',to:'',data:null,err:''},set:{open:false,draft:null,busy:false,err:''}};
let _oivTrendChart=null;
const _OIV_TYPES=[['정상','정상'],['전시','전시'],['리퍼','리퍼'],['all','전체']];
const _OIV_SET_LABEL={'재고일수_판매기준일수':['재고일수 판매 기준일수','일평균 판매 = 최근 N일 판매 ÷ N — 그 N'],'재고경보_과다일수':['과다 경보 (재고일수 >)','이 일수보다 재고일수가 길면 과다'],
  '재고경보_결품위험일수':['결품 위험 경보 (재고일수 <)','이 일수보다 재고일수가 짧으면 결품 위험'],'데이터지연_경고일수':['데이터 지연 경고일수','판매·재고 기준일이 오늘보다 이만큼 넘게 오래되면 경고 배지']};

function mountInventoryPage(){
  _ofOnFilter=()=>_oivRender();
  if(!_OIV.trend.to){_OIV.trend.to=_ofToday();_OIV.trend.from=_ofAddDays(_OIV.trend.to,-89);}
  _oivRender();
  _oivLoad();
}
PAGE_MOUNTS['offline-inventory']=mountInventoryPage;

async function _oivLoad(force){
  try{
    const [,inv]=await Promise.all([_offlineLoadMasters(),_offlineCached('offline_getInventory',{},force)]);
    _OIV.inv=inv;_OIV.err='';
    if(!_OIV.trend.sel){ // 재고가 가장 많은 본품 모델로 시작
      const m=(inv.groups||[]).filter(g=>g.channelId==='*'&&g.level==='model'&&PRODUCT_MAIN_CATEGORIES.indexOf(g.category)>=0).sort((a,b)=>b.total-a.total)[0];
      _OIV.trend.sel=m?'model:'+m.key:'';
    }
  }catch(e){_OIV.err=e.message;}
  _oivRender();
  _oivLoadTrend(force);
}
function _oivIsAdmin(){
  try{
    const u=JSON.parse(sessionStorage.getItem('gp_user')||'null')||_decodeSessionPayload(_getToken())||{};
    return ADMIN_EMAILS.indexOf(String(u.email||'').toLowerCase())>=0;
  }catch(e){return false;}
}
function _oivSetType(v){_OIV.type=v;_oivRender();}
function _oivSetTab(v){_OIV.atab=v;_oivRender();}

function _oivRender(){
  const host=document.getElementById('page-offline-inventory');
  if(!host)return;
  const right=`<span class="of-bar-r">${_oivIsAdmin()?'<button type="button" class="btn-cancel up-btn" onclick="_oivOpenSettings()">⚙ 경보 기준 설정</button>':''}<button type="button" class="btn-cancel up-btn" onclick="_oivLoad(true)">새로고침</button></span>`;
  const bar=_ofFilterBarHtml({category:true,chCat:true},right);
  if(_OIV.err&&!_OIV.inv){host.innerHTML=bar+_ofErrorHtml(_OIV.err);return;}
  if(!_OIV.inv){host.innerHTML=bar+_ofLoadingHtml();return;}
  const S=_OIV.inv.settings||{};
  const sc=(_OIV.inv.channels||[]).filter(c=>_ofInScope(c.channelId));
  const um=sc.reduce((s,c)=>s+(c.unmatchedStock||0),0),umQ=sc.reduce((s,c)=>s+(c.unmatchedQty||0),0);
  host.innerHTML=bar+_ofFreshnessHtml(_OIV.inv)+
    `<div class="of-note">재고일수 = 정상재고 ÷ 최근 <b>${S['재고일수_판매기준일수']}</b>일 일평균 판매(채널별 판매 최신 기준일에서 거꾸로) · 과다 &gt; <b>${S['재고경보_과다일수']}</b>일 · 결품 위험 &lt; <b>${S['재고경보_결품위험일수']}</b>일 · 데이터 지연 경고 &gt; <b>${S['데이터지연_경고일수']}</b>일</div>`+
    (OFFLINE_FILTER.category?'':_ofUnmatchedNote(um,umQ))+
    _oivMatrixHtml()+_oivAlertsHtml()+
    `<div class="card"><div class="card-hd"><span>재고 추이 <span class="of-sub">재고_채널일별 · ${_OIV.type==='all'?'전체':_escHtml(_OIV.type)}</span></span><span class="card-hd-r">선 = 채널</span></div><div id="oivTrendCtl">${_oivTrendCtlHtml()}</div><div id="oivTrendBody"><div class="mp-empty">불러오는 중…</div></div></div>`+
    (_OIV.set.open?_oivSettingsHtml():'');
  _oivDrawTrend();
}

// ── SKU × 채널 매트릭스 ──
function _oivQty(g){if(!g)return null;return _OIV.type==='all'?g.total:g.stock[_OIV.type];}
function _oivMatrixHtml(){
  const inv=_OIV.inv,cat=OFFLINE_FILTER.category;
  // 열 = 재고가 있는 채널(채널 대분류 필터 범위), 채널대분류 묶음 순서 — 머리 위 줄(_oivHeadHtml)과 같은 순서
  const chans=_offlineGroupChannels((inv.channels||[]).filter(c=>c.hasStock&&_ofInScope(c.channelId))).reduce((a,g)=>a.concat(g.channels),[]);
  if(!chans.length)return '<div class="card"><div class="card-hd">SKU × 채널 재고</div><div class="mp-empty">재고 업로드 데이터가 없습니다. <a class="of-link" onclick="_ofGo(\'admin-upload\')">데이터 업로드 →</a></div></div>';
  const G=(ch,lv,k)=>_ofGroup(inv,ch,lv,k);
  const cell=(ch,g,skuId)=>{
    const q=_oivQty(g);
    if(!g||g.idle||(!g.total&&!g.windowQty))return '<td><span class="of-dim">—</span></td>';
    const cls=g.alert==='over'?' of-a-over':g.alert==='risk'?' of-a-risk':'';
    const click=skuId&&ch!=='*'?` clickable" onclick="_ocdOpenFocus('${_escAttr(ch)}',{skuId:'${_escAttr(skuId)}'})" title="채널 상세에서 보기`:'';
    return `<td><span class="of-mx-cell${cls}${click}"><span class="of-mx-main">${_ofNum(q)}</span><span class="of-mx-sub">${_ofDays(g)}${g.storeOuts?' · 결품 '+g.storeOuts:''}</span></span></td>`;
  };
  // 채널 대분류 필터가 걸리면 그 대분류 채널에 재고·판매가 있는 SKU만
  const skus=(inv.groups||[]).filter(g=>g.channelId==='*'&&g.level==='sku'&&(!cat||g.category===cat)).filter(g=>{if(!OFFLINE_FILTER.chCat)return true;const x=G('*','sku',g.key);return x&&(x.total||x.windowQty);});
  // 대분류 필터가 없으면 본품 → 미매칭 → 합계(본품) → 구분선 → 본품 외(필터·기타)
  const catRows=c=>{
    const list=skus.filter(g=>g.category===c);
    if(!list.length)return '';
    return `<tr class="of-lv-cat"><td>${_escHtml(c)}</td>${chans.map(ch=>cell(ch.channelId,G(ch.channelId,'category',c))).join('')}${cell('*',G('*','category',c))}</tr>`+
      list.map(s=>`<tr class="of-lv-sku"><td>${_escHtml(s.name)} <span class="of-sub">${_escHtml(s.skuId)}${s.active==='N'?' · 비활성':''}</span></td>${chans.map(ch=>cell(ch.channelId,G(ch.channelId,'sku',s.key),s.skuId)).join('')}${cell('*',G('*','sku',s.key))}</tr>`).join('');
  };
  let body=(cat?[cat]:PRODUCT_MAIN_CATEGORIES).map(catRows).join('');
  // 미매칭 — 재고구분을 몰라서 [전체]에서만 수량을 보여 준다
  if(!cat){
    const u=chans.map(ch=>{const ci=_ofChannelInv(inv,ch.channelId);return ci?ci.unmatchedStock:0;});
    const tot=u.reduce((s,v)=>s+v,0);
    if(tot)body+=`<tr class="of-lv-um"><td>미매칭 코드 <a class="of-link" onclick="_ofGo('admin-code-mapping')">매핑 →</a></td>${u.map(v=>`<td>${v?(_OIV.type==='all'?_ofNum(v):'<span class="of-dim" title="재고구분을 모름 — [전체]에서 보임">('+_ofNum(v)+')</span>'):'<span class="of-dim">—</span>'}</td>`).join('')}<td>${_OIV.type==='all'?_ofNum(tot):'<span class="of-dim">('+_ofNum(tot)+')</span>'}</td></tr>`;
    const totalG=G('*','channel','');
    const extra=PRODUCT_EXTRA_CATEGORIES.map(catRows).join('');
    const lb=extra?(_OIV.type==='all'?' (본품 + 미매칭)':' (본품)'):(_OIV.type==='all'?' (미매칭 포함)':'');
    body+=`<tr class="of-lv-total"><td>합계${lb}</td>${chans.map((ch,i)=>{const g=G(ch.channelId,'channel','');return `<td>${_ofNum((_oivQty(g)||0)+(_OIV.type==='all'?u[i]:0))}</td>`;}).join('')}<td>${_ofNum((_oivQty(totalG)||0)+(_OIV.type==='all'?tot:0))}</td></tr>`;
    if(extra)body+=`<tr class="of-lv-sep"><td colspan="${chans.length+2}">본품 외 — 위 합계에 들어가지 않습니다</td></tr>`+extra;
  }
  return `<div class="card"><div class="card-hd"><span>SKU × 채널 재고 <span class="axis-toggle">${_OIV_TYPES.map(([v,l])=>`<button type="button" class="${_OIV.type===v?'on':''}" onclick="_oivSetType('${v}')">${l}</button>`).join('')}</span></span>
      <span class="card-hd-r">셀 = 재고수량 · 아래 = 재고일수(정상 기준) · <span class="of-badge of-b-over">과다</span> <span class="of-badge of-b-risk">결품 위험</span> · 셀을 누르면 채널 상세</span></div>
    <div class="tbl-wrap"><table class="of-tbl of-mx"><thead>${_oivHeadHtml(chans)}</thead><tbody>${body||`<tr><td colspan="${chans.length+2}"><div class="mp-empty">재고가 있는 SKU가 없습니다.</div></td></tr>`}</tbody></table></div></div>`;
}

// 매트릭스 머리 — 위 줄 = 채널대분류 묶음, 아래 줄 = 채널(재고 기준일). chans는 묶음 순서로 정렬된 것
function _oivHeadHtml(chans){
  const groups=_offlineGroupChannels(chans);
  return `<tr><th rowspan="2">SKU</th>${groups.map(g=>`<th class="of-mx-grp" colspan="${g.channels.length}">${_escHtml(g.cat)}</th>`).join('')}<th rowspan="2">전체${OFFLINE_FILTER.chCat?`<div class="of-sub">${_escHtml(OFFLINE_FILTER.chCat)}</div>`:''}</th></tr>`+
    `<tr>${chans.map(c=>`<th>${_escHtml(c.name)}<div class="of-sub">${_escHtml(_ofMD(c.stockDate))}</div></th>`).join('')}</tr>`;
}

// ── 경보 목록 ──
function _oivAlertsHtml(){
  const inv=_OIV.inv,cat=OFFLINE_FILTER.category,N=inv.windowDays;
  const chName=id=>{const c=_ofChannelInv(inv,id);return c?_ofChLabel(c.channelCategory,c.name):id;};
  const skuG=(inv.groups||[]).filter(g=>g.level==='sku'&&g.channelId!=='*'&&_ofInScope(g.channelId)&&(!cat||g.category===cat));
  const over=skuG.filter(g=>g.alert==='over').sort((a,b)=>b.days-a.days),risk=skuG.filter(g=>g.alert==='risk').sort((a,b)=>a.days-b.days);
  const skuCat={};(inv.groups||[]).forEach(g=>{if(g.level==='sku')skuCat[g.skuId]=g.category;});
  const outs=(inv.storeOuts||[]).filter(s=>_ofInScope(s.channelId)&&(!cat||skuCat[s.skuId]===cat));
  const t=_OIV.atab;
  const tabs=`<span class="of-atabs"><button type="button" class="${t==='over'?'on':''}" onclick="_oivSetTab('over')">과다 ${over.length}</button><button type="button" class="${t==='risk'?'on':''}" onclick="_oivSetTab('risk')">결품 위험 ${risk.length}</button><button type="button" class="${t==='storeOut'?'on':''}" onclick="_oivSetTab('storeOut')">점포 결품 ${outs.length}</button></span>`;
  let tbl;
  if(t==='storeOut'){
    tbl=outs.length?`<table class="of-tbl"><thead><tr><th>채널</th><th>점포</th><th>지역</th><th>SKU</th><th class="num-col">당월판매</th><th class="num-col">현재 재고</th></tr></thead><tbody>${outs.map(s=>
      `<tr><td><a class="of-link" onclick="_ofGo('offline-channel','${_escAttr(s.channelId)}')">${_escHtml(chName(s.channelId))}</a></td>
        <td><a class="of-link" onclick="_ocdOpenFocus('${_escAttr(s.channelId)}',{store:'${_escAttr(s.storeName||s.store)}',outOnly:true})">${_escHtml(s.storeName||s.store)}</a> <span class="of-sub">${_escHtml(s.store)}</span></td>
        <td>${_escHtml(s.region)}</td><td><a class="of-link" onclick="_ocdOpenFocus('${_escAttr(s.channelId)}',{skuId:'${_escAttr(s.skuId)}'})">${_escHtml(_ofSkuName(s.skuId))}</a></td><td class="num-col">${_ofNum(s.monthSale)}</td><td class="num-col">0</td></tr>`).join('')}</tbody></table>`
      :'<div class="mp-empty">점포 결품이 없습니다.</div>';
  }else{
    const list=t==='over'?over:risk;
    tbl=list.length?`<table class="of-tbl"><thead><tr><th>채널</th><th>SKU</th><th class="num-col">정상재고</th><th class="num-col">최근 ${N}일 판매</th><th class="num-col">일평균</th><th class="num-col">재고일수</th><th class="num-col">진열 점포</th><th class="num-col">점포 결품</th></tr></thead><tbody>${list.map(g=>
      `<tr><td><a class="of-link" onclick="_ofGo('offline-channel','${_escAttr(g.channelId)}')">${_escHtml(chName(g.channelId))}</a></td>
        <td><a class="of-link" onclick="_ocdOpenFocus('${_escAttr(g.channelId)}',{skuId:'${_escAttr(g.skuId)}'})">${_escHtml(g.name)}</a> <span class="of-sub">${_escHtml(g.skuId)}</span></td>
        <td class="num-col">${_ofNum(g.stock['정상'])}</td><td class="num-col">${_ofNum(g.windowQty)}</td><td class="num-col">${g.dailyAvg==null?'—':Math.round(g.dailyAvg*100)/100}</td>
        <td class="num-col ${t==='over'?'cw':'of-t-bad'}"><b>${_ofDays(g)}</b></td><td class="num-col">${_ofNum(g.displayStores)}</td><td class="num-col">${g.storeOuts||''}</td></tr>`).join('')}</tbody></table>`
      :`<div class="mp-empty">${t==='over'?'과다':'결품 위험'} 경보가 없습니다.</div>`;
  }
  return `<div class="card"><div class="card-hd"><span>경보 ${tabs}</span><span class="card-hd-r">${t==='storeOut'?'당월판매 > 0 인데 재고 0인 점포 × SKU':t==='over'?'재고일수 > '+inv.settings['재고경보_과다일수']+'일':'재고일수 < '+inv.settings['재고경보_결품위험일수']+'일'} · 판매 없는 SKU는 재고일수를 셀 수 없어 경보에서 빠집니다</span></div><div class="tbl-wrap">${tbl}</div></div>`;
}

// ── 재고 추이 ──
function _oivTrendCtlHtml(){
  const inv=_OIV.inv,tr=_OIV.trend,cat=OFFLINE_FILTER.category;
  const models=((inv&&inv.groups)||[]).filter(g=>g.channelId==='*'&&g.level==='model'&&(!cat||g.category===cat));
  const skus=((inv&&inv.groups)||[]).filter(g=>g.channelId==='*'&&g.level==='sku'&&(!cat||g.category===cat));
  const opt=(v,l)=>`<option value="${_escAttr(v)}"${tr.sel===v?' selected':''}>${_escHtml(l)}</option>`;
  return `<div class="of-ctl"><select class="f-sel" onchange="_oivTrendSet('sel',this.value)">
      <optgroup label="모델">${models.map(g=>opt('model:'+g.key,g.model)).join('')}</optgroup>
      <optgroup label="SKU">${skus.map(g=>opt('sku:'+g.key,g.name)).join('')}</optgroup></select>
    <input type="date" class="f-inp" value="${_escAttr(tr.from)}" onchange="_oivTrendSet('from',this.value)">~<input type="date" class="f-inp" value="${_escAttr(tr.to)}" onchange="_oivTrendSet('to',this.value)"></div>`;
}
function _oivTrendSet(k,v){
  if((k==='from'||k==='to')&&!/^\d{4}-\d{2}-\d{2}$/.test(v))return;
  _OIV.trend[k]=v;
  if(_OIV.trend.from>_OIV.trend.to){showToast('시작일이 끝일보다 늦습니다.',{type:'error'});return;}
  _oivLoadTrend();
}
// 선택('model:품목군|모델' / 'sku:SKU-…') + 기간 → offline_getInventoryTrend 인자
function _oivTrendArgs(){
  const tr=_OIV.trend,i=tr.sel.indexOf(':'),args={from:tr.from,to:tr.to};
  args[tr.sel.slice(0,i)==='sku'?'skuId':'model']=tr.sel.slice(i+1);
  return args;
}
async function _oivLoadTrend(force){
  const tr=_OIV.trend;
  if(!tr.sel||!tr.from){_oivDrawTrend();return;}
  const want=JSON.stringify(_oivTrendArgs());
  try{
    const d=await _offlineCached('offline_getInventoryTrend',_oivTrendArgs(),force);
    if(want!==JSON.stringify(_oivTrendArgs()))return; // 그 사이 선택·기간이 바뀜 — 새 요청이 그린다
    tr.data=d;tr.err='';
  }catch(e){tr.err=e.message;}
  _oivDrawTrend();
}
const _OIV_LINE_COLORS=['#3B56E5','#F59E0B','#0A7C5E','#E11D48','#7C3AED','#0D9488','#6B7280'];
function _oivDrawTrend(){
  const body=document.getElementById('oivTrendBody');
  if(!body)return;
  const tr=_OIV.trend;
  if(tr.err){body.innerHTML=`<div class="up-err">${_escHtml(tr.err)}</div>`;return;}
  if(!tr.sel){body.innerHTML='<div class="of-chart-empty">재고가 있는 모델이 없습니다.</div>';return;}
  const d=tr.data;
  if(!d){body.innerHTML='<div class="mp-empty">불러오는 중…</div>';return;}
  const series=d.series.filter(x=>_ofInScope(x.channelId)); // 채널 대분류 필터 범위의 채널만
  if(!series.length){body.innerHTML='<div class="of-chart-empty">이 기간에 재고 기록이 없습니다.</div>';if(_oivTrendChart){_oivTrendChart.destroy();_oivTrendChart=null;}return;}
  body.innerHTML='<div class="of-chart"><canvas id="oivTrendCanvas"></canvas></div><div class="of-sub" style="margin-top:6px">점 = 재고 파일 기준일. 업로드가 없는 날은 선으로 이어 그립니다.</div>';
  const el=document.getElementById('oivTrendCanvas');
  if(!el||typeof Chart==='undefined')return;
  const f=_OIV.type==='all'?'total':_OIV.type;
  if(_oivTrendChart)_oivTrendChart.destroy();
  _oivTrendChart=new Chart(el.getContext('2d'),{type:'line',
    data:{labels:d.dates.map(_ofMD),datasets:series.map((s,i)=>{
      const by={};s.points.forEach(p=>{by[p.date]=p[f];});
      const c=_OIV_LINE_COLORS[i%_OIV_LINE_COLORS.length];
      return {label:_ofChLabel(_offlineChannelCatOf(s.channelId),s.name),data:d.dates.map(x=>x in by?by[x]:null),borderColor:c,backgroundColor:c,spanGaps:true,tension:.2,pointRadius:3};
    })},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      plugins:{tooltip:{callbacks:{label:c=>c.dataset.label+' '+_ofNum(c.raw)}}},scales:{y:{beginAtZero:true}}}});
}

// ── 설정 모달(관리자) ──
function _oivOpenSettings(){
  const S=(_OIV.inv&&_OIV.inv.settings)||{};
  _OIV.set={open:true,busy:false,err:'',draft:Object.assign({},S)};
  _oivRender();
}
function _oivCloseSettings(){_OIV.set.open=false;_oivRender();}
function _oivSettingsHtml(){
  const st=_OIV.set;
  return `<div class="ov open" onclick="if(event.target===this)_oivCloseSettings()"><div class="modal">
    <div class="m-top"><div><div class="m-title">경보 기준 설정</div><div class="m-sub">오프라인 스프레드시트 '설정' 탭에 저장 · 모든 재고 지표가 다시 계산됩니다(관리자)</div></div><button class="m-cls" onclick="_oivCloseSettings()">✕</button></div>
    <div class="of-set-grid">${Object.keys(_OIV_SET_LABEL).map(k=>`<div><div class="f-lbl">${_escHtml(_OIV_SET_LABEL[k][0])}</div><div class="of-set-desc">${_escHtml(_OIV_SET_LABEL[k][1])}</div></div>
      <input class="f-inp" type="number" min="1" max="365" step="1" value="${_escAttr(st.draft[k])}" oninput="_OIV.set.draft['${k}']=this.value">`).join('')}</div>
    ${st.err?`<div class="up-err">${_escHtml(st.err)}</div>`:''}
    <div class="form-footer"><button class="btn-cancel" onclick="_oivCloseSettings()">취소</button><button class="btn-primary" ${st.busy?'disabled':''} onclick="_oivSaveSettings()">${st.busy?'저장 중…':'저장'}</button></div>
  </div></div>`;
}
async function _oivSaveSettings(){
  const st=_OIV.set;
  if(st.busy)return;
  const out={};
  for(const k of Object.keys(_OIV_SET_LABEL)){
    const v=Number(st.draft[k]);
    if(!isFinite(v)||v!==Math.round(v)||v<1||v>365){st.err=_OIV_SET_LABEL[k][0]+': 1~365 사이 정수를 입력하세요.';_oivRender();return;}
    out[k]=v;
  }
  if(out['재고경보_결품위험일수']>=out['재고경보_과다일수']){st.err='결품 위험 일수는 과다 일수보다 작아야 합니다.';_oivRender();return;}
  st.busy=true;st.err='';_oivRender();
  try{
    await _offlineCall('offline_saveSettings',{settings:out});
    showToast('경보 기준을 저장했습니다 — 지표를 다시 계산합니다.',{type:'success'});
    st.open=false;st.busy=false;
    await Promise.all([_offlineLoadMasters(true),_oivLoad(true)]);
  }catch(e){st.busy=false;st.err=e.message;_oivRender();}
}
