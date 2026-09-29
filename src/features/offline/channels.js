'use strict';
/* 채널 현황(#offline/channels) — 채널별 목표 대비 실적(IN = Sell-in, OUT = Sell-out)과 재고 요약.
   데이터: offline_getMonthly(그 해 1~12월 합계만, totalsOnly — 월/연 누적은 여기서 더한다) + offline_getInventory(전체 채널)
   위: 요약 KPI / 가운데: 채널 카드(누르면 채널 상세) / 아래: 채널 × 대분류 매트릭스(달성률 색, IN/OUT 전환).
   재고 지표(정상재고·재고일수·진열 점포·경보)는 서버 계산값을 그대로 쓴다 — 채널 상세·재고 현황과 같은 정의.
   대분류 필터 '전체'의 숫자는 본품 합계(서버가 필터·기타를 뺀다) — 필터는 카드 아래 "필터 판매 · 필터 재고" 한 줄로 따로. */

const _OCS={mon:null,inv:null,err:'',year:'',mx:'out'};

function mountChannelsPage(){
  _ofOnFilter=()=>{if(_ofYear()!==_OCS.year)_ocsLoad();else _ocsRender();};
  _ocsRender();
  _ocsLoad();
}
PAGE_MOUNTS['offline-channels']=mountChannelsPage;

async function _ocsLoad(force){
  const y=_ofYear();
  _OCS.err='';
  if(_OCS.year!==y){_OCS.mon=null;_OCS.year=y;}
  _ocsRender();
  try{
    const [,mon,inv]=await Promise.all([_offlineLoadMasters(),
      _offlineCached('offline_getMonthly',{from:y+'-01',to:y+'-12',totalsOnly:true},force),_offlineCached('offline_getInventory',{},force)]);
    if(y!==_OCS.year)return; // 그 사이 다른 해로 옮겨 감
    _OCS.mon=mon;_OCS.inv=inv;
  }catch(e){_OCS.err=e.message;}
  _ocsRender();
}
function _ocsSetMx(v){_OCS.mx=v;_ocsRender();}

function _ocsRender(){
  const host=document.getElementById('page-offline-channels');
  if(!host)return;
  const bar=_ofFilterBarHtml(null,`<span class="of-bar-r"><button type="button" class="btn-cancel up-btn" onclick="_ocsLoad(true)">새로고침</button></span>`);
  if(_OCS.err){host.innerHTML=bar+_ofErrorHtml(_OCS.err);return;}
  if(!_OCS.mon||!_OCS.inv){host.innerHTML=bar+_ofLoadingHtml();return;}
  const chans=_ofShownChannels(_OCS.mon);
  const um=(_OCS.inv.channels||[]).reduce((s,c)=>s+(c.unmatchedStock||0),0);
  host.innerHTML=bar+_ofFreshnessHtml(_OCS.inv)+_ocsKpiHtml()+
    (OFFLINE_FILTER.category?'':_ofUnmatchedNote(um,0))+
    `<div class="of-cards">${chans.map(_ocsCardHtml).join('')||'<div class="mp-empty">보여 줄 채널이 없습니다.</div>'}</div>`+
    _ocsMatrixHtml(chans);
}

function _ocsKpiHtml(){
  const cat=OFFLINE_FILTER.category;
  const t=_ofTotals(_OCS.mon,'',null,cat);
  const g=_ofStockGroup(_OCS.inv,'*')||{stock:{'정상':0,'전시':0,'리퍼':0}};
  const a=_ofAlertCounts(_OCS.inv,'');
  const rateKpi=(lb,side)=>{
    const r=_ofSideRate(side);
    return `<div class="kpi"><div class="kpi-lbl">${lb}</div><div class="kpi-val ${r==null?'':r>=1?'cok':r<0.8?'cw':'cm'}">${_ofPct(r)}</div>`+
      `<div class="kpi-sub">실적 ${_ofFmtUnit(_ofPick(side,'actual'))}${_ofIncompleteMark(side)} / 목표 ${_ofFmtUnit(_ofPick(side,'target'))}</div></div>`;
  };
  const amt=(lb,side)=>`<div class="kpi"><div class="kpi-lbl">${lb}</div><div class="kpi-val">${_ofWonShort(side.actualAmount)}${side.amountIncomplete?'<span class="of-inc" title="단가가 없는 모델·대분류 단위 이관 행은 금액에서 빠졌습니다">*</span>':''}</div>`+
    `<div class="kpi-sub">목표 ${_ofWonShort(side.targetAmount)} · ${_ofPct(_ofRate(side.actualAmount,side.targetAmount))}</div></div>`;
  return `<div class="kpi-row">${rateKpi('전체 IN 달성률',t.in)}${rateKpi('전체 OUT 달성률',t.out)}${amt('IN 금액(실적)',t.in)}${amt('OUT 금액(실적)',t.out)}`+
    `<div class="kpi"><div class="kpi-lbl">전체 정상재고${cat?' · '+_escHtml(cat):''}</div><div class="kpi-val">${_ofNum(g.stock['정상'])}<span class="kpi-unit"> 대</span></div>`+
    `<div class="kpi-sub">재고일수 ${_ofDays(g)} · 전시 ${_ofNum(g.stock['전시'])} · 리퍼 ${_ofNum(g.stock['리퍼'])}</div></div>`+
    `<div class="kpi"><div class="kpi-lbl">경보</div><div class="kpi-val ${a.over+a.risk+a.storeOut?'cw':''}">${_ofNum(a.over+a.risk+a.storeOut)}<span class="kpi-unit"> 건</span></div>`+
    `<div class="kpi-sub">과다 ${a.over} · 결품 위험 ${a.risk} · 점포 결품 ${a.storeOut} <a class="of-link" onclick="_ofGo('offline-inventory')">재고 현황 →</a></div></div></div>`;
}

// 달성률 막대 한 줄 — 채움 = min(달성률, 100%)
function _ocsMeter(lb,side){
  const r=_ofSideRate(side),w=r==null?0:Math.max(0,Math.min(1,r))*100;
  return `<div class="of-meter-row"><span class="of-meter-lb">${lb}</span><div class="of-meter"><div class="of-meter-fill${r!=null&&r>=1?' over':''}" style="width:${w.toFixed(1)}%"></div></div>`+
    `<span class="of-meter-val ${r==null?'of-dim':''}">${_ofPct(r)}</span>`+
    `<span class="of-meter-sub">실적 ${_ofFmtUnit(_ofPick(side,'actual'))}${_ofIncompleteMark(side)} / 목표 ${_ofFmtUnit(_ofPick(side,'target'))}</span></div>`;
}
function _ocsCardHtml(c){
  const cat=OFFLINE_FILTER.category;
  const t=_ofTotals(_OCS.mon,c.channelId,null,cat);
  const ci=_ofChannelInv(_OCS.inv,c.channelId);
  const g=_ofStockGroup(_OCS.inv,c.channelId);
  const inA=_ofPick(t.in,'actual'),outA=_ofPick(t.out,'actual');
  const gap=inA==null&&outA==null?null:(inA||0)-(outA||0);
  const up=ci&&(ci.hasStock||ci.hasSales);
  const stock=up&&g?`<div class="of-kv">
      <div><div class="of-kv-lb">정상재고</div><div class="of-kv-v">${_ofNum(g.stock['정상'])}</div></div>
      <div><div class="of-kv-lb">재고일수</div><div class="of-kv-v${g.alert==='over'?' cw':g.alert==='risk'?' of-t-bad':''}">${_ofDays(g)}</div></div>
      <div><div class="of-kv-lb">진열 점포</div><div class="of-kv-v">${_ofNum(g.displayStores)} <small>/ ${_ofNum(ci.storeTotal)}</small></div></div>
    </div><div class="of-card-foot">기준일 재고 ${_escHtml(_ofMD(ci.stockDate))||'—'}${ci.staleStock?' <span class="of-stale">⚠</span>':''} · 판매 ${_escHtml(_ofMD(ci.salesDate))||'—'}${ci.staleSales?' <span class="of-stale">⚠</span>':''}${ci.unmatchedStock&&!cat?` · 미매칭 재고 ${_ofNum(ci.unmatchedStock)}`:''}</div>`
    :'<div class="of-nodata">업로드 데이터 없음 — 목표·실적만 표시합니다(OUT 실적은 목표 관리에서 입력·이관한 값).</div>';
  return `<div class="of-card" role="button" tabindex="0" onclick="_ofGo('offline-channel','${_escAttr(c.channelId)}')" onkeydown="if(event.key==='Enter')_ofGo('offline-channel','${_escAttr(c.channelId)}')">
    <div class="of-card-hd"><span class="of-card-name">${_escHtml(c.name)}</span><span class="of-card-type">${_escHtml(c.type||'')}${c.active==='Y'?'':' · 비활성'}</span><span class="of-badges">${up?_ofAlertBadges(_ofAlertCounts(_OCS.inv,c.channelId)):''}</span></div>
    ${_ocsMeter('IN',t.in)}${_ocsMeter('OUT',t.out)}
    <div class="of-gap" title="IN 실적 − OUT 실적. 양수가 계속 쌓이면 채널 재고가 늘고 있다는 신호">IN−OUT 갭 <b class="${gap>0?'of-gap-pos':''}">${gap==null?'—':(gap>0?'+':'')+_ofFmtUnit(gap)}</b></div>
    ${stock}${_ofFilterLineHtml(_OCS.mon,_OCS.inv,c.channelId)}</div>`;
}

// 채널 × 대분류 — 셀 = 표시 중인 쪽(IN/OUT) 달성률, 색도 그 달성률(100% 이상 초록 · 80% 미만 빨강)
// 열은 본품 대분류(합계 = 본품 합계). 필터·기타는 대분류 필터로 골랐을 때만 그 한 열
function _ocsMatrixHtml(chans){
  const side=_OCS.mx,cat=OFFLINE_FILTER.category;
  const cats=cat?[cat]:PRODUCT_MAIN_CATEGORIES;
  const cell=(ch,c)=>{
    const t=_ofTotals(_OCS.mon,ch,null,c)[side];
    const a=_ofPick(t,'actual'),tg=_ofPick(t,'target'),r=_ofRate(a,tg);
    if(a==null&&tg==null)return '<td><span class="of-dim">—</span></td>';
    return `<td><span class="of-mx-cell ${_ofRateCls(r)}"><span class="of-mx-main">${_ofPct(r)}</span><span class="of-mx-sub">${_ofFmtUnit(a)}${_ofIncompleteMark(t)} / ${_ofFmtUnit(tg)}</span></span></td>`;
  };
  const rows=chans.map(c=>`<tr><td><a class="of-link" onclick="_ofGo('offline-channel','${_escAttr(c.channelId)}')">${_escHtml(c.name)}</a></td>${cats.map(k=>cell(c.channelId,k)).join('')}${cat?'':cell(c.channelId,'')}</tr>`).join('');
  const total=`<tr class="of-lv-total"><td>전체</td>${cats.map(k=>cell('',k)).join('')}${cat?'':cell('','')}</tr>`;
  return `<div class="card"><div class="card-hd"><span>채널 × 대분류 달성률
      <span class="axis-toggle"><button type="button" class="${side==='in'?'on':''}" onclick="_ocsSetMx('in')">IN</button><button type="button" class="${side==='out'?'on':''}" onclick="_ocsSetMx('out')">OUT</button></span></span>
      <span class="card-hd-r">${_escHtml(_ofRangeLabel())} · 셀 = 달성률(실적 / 목표) · 초록 100%↑ · 노랑 80~100% · 빨강 80% 미만</span></div>
    <div class="tbl-wrap"><table class="of-tbl of-mx"><thead><tr><th>채널</th>${cats.map(k=>`<th>${_escHtml(k)}</th>`).join('')}${cat?'':'<th>합계</th>'}</tr></thead><tbody>${rows}${total}</tbody></table></div></div>`;
}
