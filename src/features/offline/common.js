'use strict';
/* 오프라인 화면 공용 — 채널 현황(#offline/channels)·채널 상세(#offline/channel/{id})·재고 현황(#offline/inventory)이 같이 쓴다.
   · 상단 필터 바(연월 · [월 / 연 누적] · [수량 / 금액] · 대분류 · 채널 대분류) — 세 화면이 한 상태(OFFLINE_FILTER)를 공유한다
     채널 대분류(chCat) = 채널마스터 채널대분류(양판점·할인점…). 걸리면 '전체' 합계·경보·재고·기준일 칩이 그 대분류 채널만이다(목표 관리도 같은 값)
   · 데이터 기준일(채널별 판매·재고 최신 기준일, 지연 경고 배지 → 데이터 업로드 링크)
   · 목표·실적 합계 — offline_getMonthly의 월 합계를 선택 범위(그 달 / 1월~그 달)만큼 더한다. 달성률은 2-A 규칙 그대로
     (실적 ÷ 목표, 목표 0·빈칸이면 없음). 재고 지표는 계산하지 않는다 — 서버(offline_getInventory)가 준 값을 그대로 쓴다. */

const OFFLINE_FILTER={ym:'',mode:'month',unit:'qty',category:'',chCat:''};
let _ofOnFilter=null; // 지금 보고 있는 화면이 등록한 "필터가 바뀌면 다시 그리기"
function _ofThisYm(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
function _ofToday(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function _ofYm(){if(!OFFLINE_FILTER.ym)OFFLINE_FILTER.ym=_ofThisYm();return OFFLINE_FILTER.ym;}
function _ofYear(){return _ofYm().slice(0,4);}
// 선택 범위의 연월 목록 — 월: [그 달], 연 누적: [1월 … 그 달]
function _ofRangeMonths(){
  const ym=_ofYm();
  if(OFFLINE_FILTER.mode!=='ytd')return [ym];
  const out=[];for(let m=1;m<=+ym.slice(5,7);m++)out.push(ym.slice(0,4)+'-'+String(m).padStart(2,'0'));
  return out;
}
function _ofSetFilter(k,v){
  if(k==='ym'&&!/^\d{4}-\d{2}$/.test(v))return;
  OFFLINE_FILTER[k]=v;
  if(_ofOnFilter)_ofOnFilter(k);
}
function _ofAddDays(s,n){const t=new Date(Date.UTC(+s.slice(0,4),+s.slice(5,7)-1,+s.slice(8,10)+n));return t.toISOString().slice(0,10);}
function _ofMonthEnd(ym){return new Date(Date.UTC(+ym.slice(0,4),+ym.slice(5,7),0)).toISOString().slice(0,10);} // 그 달 말일

// ── 숫자 표기 ──
const _ofNum=v=>v==null||v===''||!isFinite(v)?'—':Math.round(v).toLocaleString('ko-KR');
const _ofWon=v=>v==null||!isFinite(v)?'—':'₩'+Math.round(v).toLocaleString('ko-KR');
// 카드·KPI용 짧은 금액(1.2억 · 3,450만)
function _ofWonShort(v){
  if(v==null||!isFinite(v))return '—';
  const a=Math.abs(v);
  if(a>=1e8)return '₩'+(Math.round(v/1e7)/10).toLocaleString('ko-KR')+'억';
  if(a>=1e4)return '₩'+Math.round(v/1e4).toLocaleString('ko-KR')+'만';
  return _ofWon(v);
}
const _ofPct=r=>r==null||!isFinite(r)?'—':(Math.round(r*1000)/10)+'%';
// 취급 없음(idle — 재고 0·최근 판매 0)은 '판매 없음'이 아니라 '—'
const _ofDays=g=>g==null||g.idle?'—':g.noSales?'판매 없음':g.days==null?'—':(g.days>=100?Math.round(g.days).toLocaleString('ko-KR'):(Math.round(g.days*10)/10))+'일';
// 상태 배지 — 과다 / 결품 위험(판매가 있는데 재고일수가 짧을 때만) / 취급 없음(회색)
const _ofStatusBadge=g=>g.alert==='over'?'<span class="of-badge of-b-over">과다</span>':g.alert==='risk'?'<span class="of-badge of-b-risk">결품 위험</span>':g.idle?'<span class="of-badge of-b-none" title="재고 0이고 최근 판매도 없음">취급 없음</span>':'';
const _ofMD=s=>s?(+s.slice(5,7))+'/'+(+s.slice(8,10)):'';
function _ofRate(a,t){return (t&&a!=null)?a/t:null;}
// 달성률 색 — 100% 이상 초록, 80% 미만 빨강, 그 사이 노랑, 목표 없음 회색
function _ofRateCls(r){return r==null?'of-r-none':r>=1?'of-r-good':r>=0.8?'of-r-mid':'of-r-bad';}

// ── 목표·실적 합계 ──
function _ofSum(a,b){return a==null?b:(b==null?a:a+b);}
function _ofEmptyTot(){return {in:{target:null,actual:null,targetAmount:null,actualAmount:null,amountIncomplete:false},out:{target:null,actual:null,targetAmount:null,actualAmount:null,amountIncomplete:false,unmatchedQty:0}};}
function _ofAddTot(t,x){
  ['in','out'].forEach(side=>{
    const s=x[side]||{},d=t[side];
    ['target','actual','targetAmount','actualAmount'].forEach(f=>{d[f]=_ofSum(d[f],s[f]==null?null:s[f]);});
    if(s.amountIncomplete)d.amountIncomplete=true;
    if(side==='out'&&s.unmatchedQty)d.unmatchedQty+=s.unmatchedQty;
  });
  return t;
}
// 채널 대분류 필터 범위 안의 채널인지 — 필터가 없으면 전부
function _ofInScope(id){return !OFFLINE_FILTER.chCat||_offlineChannelCatOf(id)===OFFLINE_FILTER.chCat;}
/* 선택 범위·대분류 필터로 채널 합계 — mon = offline_getMonthly 응답(totalsOnly여도 됨).
   대분류 필터가 있으면 byCategory(대분류 단위 이관 행 포함), 없으면 byChannelMonth.
   ch = 채널 하나 | 채널 배열(채널대분류 소계) | '' = 전체(채널 대분류 필터 범위 안) */
function _ofTotals(mon,ch,months,category){
  const t=_ofEmptyTot(),mset={};(months||_ofRangeMonths()).forEach(m=>{mset[m]=true;});
  const tot=(mon&&mon.totals)||{};
  const list=category?(tot.byCategory||[]).filter(x=>x.category===category):(tot.byChannelMonth||[]);
  const hit=Array.isArray(ch)?(id=>ch.indexOf(id)>=0):ch?(id=>id===ch):_ofInScope;
  list.forEach(x=>{if(mset[x.ym]&&hit(x.channelId))_ofAddTot(t,x);});
  if(category)t.out.unmatchedQty=0; // 미매칭 코드는 대분류를 모른다
  return t;
}
// 수량/금액 토글에 맞는 값
function _ofPick(side,f){return OFFLINE_FILTER.unit==='amount'?side[f+'Amount']:side[f];}
function _ofFmtUnit(v){return OFFLINE_FILTER.unit==='amount'?_ofWonShort(v):_ofNum(v);}
function _ofSideRate(side){return _ofRate(_ofPick(side,'actual'),_ofPick(side,'target'));}
// 금액 모드에서 단가 없는 행이 섞였을 때 붙이는 표시
function _ofIncompleteMark(side){return OFFLINE_FILTER.unit==='amount'&&side.amountIncomplete?'<span class="of-inc" title="단가가 없는 모델·대분류 단위 이관 행은 금액에서 빠졌습니다">*</span>':'';}

// ── 재고 지표 조회(서버 값 그대로) ──
function _ofGroup(inv,ch,level,key){
  // 전체 채널('*') — 채널 대분류 필터가 걸리면 서버의 '*' 대신 그 대분류 채널을 더한 값
  if(ch==='*'&&OFFLINE_FILTER.chCat)return _ofScopeGroup(inv,level,key);
  return ((inv&&inv.groups)||[]).find(g=>g.channelId===ch&&g.level===level&&g.key===(key||''))||null;
}
/* 채널 대분류 필터 범위의 '전체' 그룹 — 서버 '*' 그룹과 같은 규칙으로 채널 그룹을 더한다: 재고가 있는 채널만(재고 없는 ERP 채널의
   판매는 '*'에 넣지 않는다), 일평균 = 판매 합 ÷ N, 재고일수 = 정상재고 ÷ 일평균, 점포 수·점포 결품은 채널마다 다른 점포라 그대로 더한다.
   경보 색(alert)은 서버만 정하므로 합친 값에는 없다. 범위에 재고 채널이 없으면 null */
function _ofScopeGroup(inv,level,key){
  const chans=((inv&&inv.channels)||[]).filter(c=>c.hasStock&&_ofInScope(c.channelId));
  const gs=chans.map(c=>((inv.groups||[]).find(g=>g.channelId===c.channelId&&g.level===level&&g.key===(key||''))||null)).filter(Boolean);
  if(!gs.length)return null;
  const f=gs[0],g={channelId:'*',level,key:key||'',category:f.category,line:f.line,model:f.model,skuId:f.skuId,name:f.name,active:f.active,
    stock:{'정상':0,'전시':0,'리퍼':0},windowQty:0,displayStores:0,handlingStores:0,storeOuts:0,alert:''};
  gs.forEach(x=>{['정상','전시','리퍼'].forEach(t=>{g.stock[t]+=x.stock[t]||0;});['windowQty','displayStores','handlingStores','storeOuts'].forEach(k=>{g[k]+=x[k]||0;});});
  g.total=g.stock['정상']+g.stock['전시']+g.stock['리퍼'];
  const hasSales=chans.some(c=>c.hasSales);
  g.dailyAvg=hasSales?g.windowQty/(inv.windowDays||1):null;
  g.idle=hasSales&&g.total===0&&!(g.windowQty>0);
  g.noSales=hasSales&&!g.idle&&!(g.dailyAvg>0);
  g.days=g.dailyAvg>0?g.stock['정상']/g.dailyAvg:null;
  return g;
}
// 대분류 필터가 있으면 그 대분류 그룹, 없으면 채널 전체
function _ofStockGroup(inv,ch){const c=OFFLINE_FILTER.category;return c?_ofGroup(inv,ch,'category',c):_ofGroup(inv,ch,'channel','');}
function _ofChannelInv(inv,ch){return ((inv&&inv.channels)||[]).find(c=>c.channelId===ch)||null;}
// 채널 × SKU 경보 건수(대분류 필터 적용) — ch '' = 전체(채널 대분류 필터 범위 안)
function _ofAlertCounts(inv,ch){
  const cat=OFFLINE_FILTER.category,o={over:0,risk:0,storeOut:0},chOk=id=>ch?id===ch:_ofInScope(id);
  ((inv&&inv.groups)||[]).forEach(g=>{if(g.level==='sku'&&g.channelId!=='*'&&chOk(g.channelId)&&(!cat||g.category===cat)&&g.alert)o[g.alert]++;});
  const skuCat={};((inv&&inv.groups)||[]).forEach(g=>{if(g.level==='sku')skuCat[g.skuId]=g.category;});
  ((inv&&inv.storeOuts)||[]).forEach(s=>{if(chOk(s.channelId)&&(!cat||skuCat[s.skuId]===cat))o.storeOut++;});
  return o;
}
/* 필터 따로 한 줄 — 필터는 본품합계포함 N이라 위의 본품 숫자(달성률·재고·재고일수)에 없다. ch '' = 전체 채널
   판매 = 선택 범위(월 / 연 누적) OUT 실적(월별 해석) · 재고 = 최신 기준일 재고(재고구분 합). 둘 다 0이면 숨김.
   대분류 필터가 걸려 있으면 숨긴다 — 그때 위 숫자는 이미 그 대분류다(필터를 고르면 필터 숫자) */
function _ofFilterLineHtml(mon,inv,ch){
  if(OFFLINE_FILTER.category)return '';
  const sold=_ofTotals(mon,ch,null,'필터').out.actual||0,g=_ofGroup(inv,ch||'*','category','필터'),stock=g?g.total:0;
  if(!sold&&!stock)return '';
  return `<div class="of-extra" title="필터는 본품 합계(달성률·IN−OUT 갭·정상재고·재고일수·진열 점포)에 들어가지 않습니다">필터 판매 ${_ofNum(sold)}개 · 필터 재고 ${_ofNum(stock)}개</div>`;
}
function _ofAlertBadges(a){
  const b=[];
  if(a.over)b.push(`<span class="of-badge of-b-over" title="재고일수가 과다일수를 넘은 SKU">과다 ${a.over}</span>`);
  if(a.risk)b.push(`<span class="of-badge of-b-risk" title="재고일수가 결품위험일수보다 짧은 SKU">결품 위험 ${a.risk}</span>`);
  if(a.storeOut)b.push(`<span class="of-badge of-b-out" title="당월판매가 있는데 재고 0인 점포·SKU">점포 결품 ${a.storeOut}</span>`);
  return b.join('');
}
// 화면에 보일 채널 — 활성 채널 + 비활성이어도 범위 안에 목표·실적 데이터가 있는 채널(목표 관리와 같은 규칙),
// 채널 대분류 필터 범위 안만, 채널대분류 순서 → 정렬순서
function _ofShownChannels(mon){
  const has={};((mon&&mon.totals&&mon.totals.byChannelMonth)||[]).forEach(x=>{
    if([x.in.target,x.in.actual,x.out.target,x.out.actual].some(v=>v!=null&&v!==0))has[x.channelId]=true;
  });
  return _offlineSortChannels(((OFFLINE_MASTERS&&OFFLINE_MASTERS.channels)||[]).filter(c=>(c.active==='Y'||has[c.channelId])&&_ofInScope(c.channelId)));
}

// ── 이동 ──
function _ofGo(pageId,param){navPage(pageId,_findPageEl(pageId),param);}

// ── 그리기 조각 ──
function _ofToggle(k,opts){
  return `<span class="axis-toggle">${opts.map(([v,l])=>`<button type="button" class="${OFFLINE_FILTER[k]===v?'on':''}" onclick="_ofSetFilter('${k}','${v}')">${l}</button>`).join('')}</span>`;
}
/* 상단 필터 바. opts: { ym, mode, unit, category, chCat } 중 보일 것만 true, extra = 오른쪽에 붙일 HTML */
function _ofFilterBarHtml(opts,extra){
  const o=opts||{ym:true,mode:true,unit:true,category:true,chCat:true};
  const parts=[];
  if(o.ym)parts.push(`<label class="of-fl"><span>연월</span><input type="month" class="f-inp of-month" value="${_escAttr(_ofYm())}" onchange="_ofSetFilter('ym',this.value)"></label>`);
  if(o.mode)parts.push(_ofToggle('mode',[['month','월'],['ytd','연 누적']]));
  if(o.unit)parts.push(_ofToggle('unit',[['qty','수량'],['amount','금액']]));
  if(o.category)parts.push(`<label class="of-fl"><span>대분류</span><select class="f-inp f-sel dash-filter-select dash-pill-select" onchange="_ofSetFilter('category',this.value)">`+
    `<option value="">전체</option>${PRODUCT_CATEGORIES.map(c=>`<option value="${_escAttr(c)}"${OFFLINE_FILTER.category===c?' selected':''}>${_escHtml(c)}</option>`).join('')}</select></label>`);
  if(o.chCat)parts.push(_ofChCatSelectHtml("_ofSetFilter('chCat',this.value)"));
  return `<div class="card of-bar">${parts.join('')}${o.mode?`<span class="of-range">${_escHtml(_ofRangeLabel())}</span>`:''}${extra||''}</div>`;
}
// 채널 대분류 선택 — 공통 필터 바와 목표 관리가 같은 값(OFFLINE_FILTER.chCat)을 쓴다. onchange = 바꿀 때 부를 코드(this.value)
function _ofChCatSelectHtml(onchange){
  return `<label class="of-fl"><span>채널 대분류</span><select class="f-inp f-sel dash-filter-select dash-pill-select" onchange="${onchange}">`+
    `<option value="">전체</option>${_offlineChannelCats().map(c=>`<option value="${_escAttr(c)}"${OFFLINE_FILTER.chCat===c?' selected':''}>${_escHtml(c)}</option>`).join('')}</select></label>`;
}
function _ofRangeLabel(){const m=_ofRangeMonths();return m.length>1?m[0]+' ~ '+m[m.length-1]+' 누적':m[0];}

/* 데이터 기준일 — 업로드 데이터가 있는 채널만('채널대분류 · 채널명', 채널 대분류 필터 범위 안). 기준일이 오늘보다 설정 일수(데이터지연_경고일수)보다
   오래되면 경고 배지 + 업로드 링크 */
function _ofFreshnessHtml(inv,only){
  if(!inv)return '';
  const lim=inv.settings?inv.settings['데이터지연_경고일수']:3;
  const chOk=c=>only?c.channelId===only:_ofInScope(c.channelId);
  const chips=(inv.channels||[]).filter(c=>(c.hasStock||c.hasSales)&&chOk(c)).map(c=>{
    const stale=c.staleStock||c.staleSales;
    const part=(lb,d,age,st)=>d?`${lb} <b>${_escHtml(_ofMD(d))}</b>${st?` <span class="of-stale" title="오늘보다 ${age}일 전 — 지연 경고 기준 ${lim}일 초과">⚠ ${age}일 전</span>`:''}`:`${lb} <span class="off-muted">없음</span>`;
    return `<span class="of-fresh-chip${stale?' stale':''}"><span class="of-fresh-ch">${_escHtml(_ofChLabel(c.channelCategory,c.name))}</span> ${part('판매',c.salesDate,c.salesAge,c.staleSales)} · ${part('재고',c.stockDate,c.stockAge,c.staleStock)}</span>`;
  });
  if(!chips.length)return `<div class="of-fresh"><span class="off-muted">업로드된 판매·재고 데이터가 없습니다.</span> <a class="of-link" onclick="_ofGo('admin-upload')">데이터 업로드 →</a></div>`;
  const anyStale=(inv.channels||[]).some(c=>chOk(c)&&(c.staleStock||c.staleSales));
  return `<div class="of-fresh"><span class="of-fresh-lb">데이터 기준일</span>${chips.join('')}${anyStale?`<a class="of-link" onclick="_ofGo('admin-upload')">데이터 업로드 →</a>`:''}</div>`;
}
// 미매칭 안내 — 수량이 합계에서 빠지지 않고 '미매칭'으로 따로 잡혔음을 알리고 코드 매핑으로 보낸다
function _ofUnmatchedNote(stock,qty){
  if(!stock&&!qty)return '';
  return `<div class="of-note of-note-warn">⚠ 매핑 안 된 코드 — 재고 ${_ofNum(stock)}${qty?` · 최근 판매 ${_ofNum(qty)}`:''}는 SKU 합계와 별도로 '미매칭'으로 표시됩니다. <a class="of-link" onclick="_ofGo('admin-code-mapping')">코드 매핑에서 연결 →</a></div>`;
}
function _ofLoadingHtml(){return '<div class="card"><div class="mp-empty">불러오는 중…</div></div>';}
function _ofErrorHtml(msg){return `<div class="card"><div class="up-err">${_escHtml(msg)}</div></div>`;}
// SKU·모델 이름(제품마스터 표준명 → 없으면 id)
function _ofSkuName(id){const s=((OFFLINE_MASTERS&&OFFLINE_MASTERS.skus)||[]).find(x=>x.skuId===id);return s?s.name:id;}
function _ofLineLabel(k){const l=PRODUCT_CATALOG.find(x=>x.key===k);return l?l.label:k;}
