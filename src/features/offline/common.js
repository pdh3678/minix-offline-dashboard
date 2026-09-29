'use strict';
/* 오프라인 화면 공용 — 채널 현황(#offline/channels)·채널 상세(#offline/channel/{id})·재고 현황(#offline/inventory)이 같이 쓴다.
   · 상단 필터 바(연월 · [월 / 연 누적] · [수량 / 금액] · 대분류) — 세 화면이 한 상태(OFFLINE_FILTER)를 공유한다
   · 데이터 기준일(채널별 판매·재고 최신 기준일, 지연 경고 배지 → 데이터 업로드 링크)
   · 목표·실적 합계 — offline_getMonthly의 월 합계를 선택 범위(그 달 / 1월~그 달)만큼 더한다. 달성률은 2-A 규칙 그대로
     (실적 ÷ 목표, 목표 0·빈칸이면 없음). 재고 지표는 계산하지 않는다 — 서버(offline_getInventory)가 준 값을 그대로 쓴다. */

const OFFLINE_FILTER={ym:'',mode:'month',unit:'qty',category:''};
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
const _ofDays=g=>g==null?'—':g.noSales?'판매 없음':g.days==null?'—':(g.days>=100?Math.round(g.days).toLocaleString('ko-KR'):(Math.round(g.days*10)/10))+'일';
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
/* 선택 범위·대분류 필터로 채널 합계 — mon = offline_getMonthly 응답(totalsOnly여도 됨).
   대분류 필터가 있으면 byCategory(대분류 단위 이관 행 포함), 없으면 byChannelMonth. ch를 비우면 전체 채널 */
function _ofTotals(mon,ch,months,category){
  const t=_ofEmptyTot(),mset={};(months||_ofRangeMonths()).forEach(m=>{mset[m]=true;});
  const tot=(mon&&mon.totals)||{};
  const list=category?(tot.byCategory||[]).filter(x=>x.category===category):(tot.byChannelMonth||[]);
  list.forEach(x=>{if(mset[x.ym]&&(!ch||x.channelId===ch))_ofAddTot(t,x);});
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
function _ofGroup(inv,ch,level,key){return ((inv&&inv.groups)||[]).find(g=>g.channelId===ch&&g.level===level&&g.key===(key||''))||null;}
// 대분류 필터가 있으면 그 대분류 그룹, 없으면 채널 전체
function _ofStockGroup(inv,ch){const c=OFFLINE_FILTER.category;return c?_ofGroup(inv,ch,'category',c):_ofGroup(inv,ch,'channel','');}
function _ofChannelInv(inv,ch){return ((inv&&inv.channels)||[]).find(c=>c.channelId===ch)||null;}
// 채널 × SKU 경보 건수(대분류 필터 적용)
function _ofAlertCounts(inv,ch){
  const cat=OFFLINE_FILTER.category,o={over:0,risk:0,storeOut:0};
  ((inv&&inv.groups)||[]).forEach(g=>{if(g.level==='sku'&&g.channelId!=='*'&&(!ch||g.channelId===ch)&&(!cat||g.category===cat)&&g.alert)o[g.alert]++;});
  const skuCat={};((inv&&inv.groups)||[]).forEach(g=>{if(g.level==='sku')skuCat[g.skuId]=g.category;});
  ((inv&&inv.storeOuts)||[]).forEach(s=>{if((!ch||s.channelId===ch)&&(!cat||skuCat[s.skuId]===cat))o.storeOut++;});
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
// 화면에 보일 채널 — 활성 채널 + 비활성이어도 범위 안에 목표·실적 데이터가 있는 채널(목표 관리와 같은 규칙), 정렬순서대로
function _ofShownChannels(mon){
  const has={};((mon&&mon.totals&&mon.totals.byChannelMonth)||[]).forEach(x=>{
    if([x.in.target,x.in.actual,x.out.target,x.out.actual].some(v=>v!=null&&v!==0))has[x.channelId]=true;
  });
  return ((OFFLINE_MASTERS&&OFFLINE_MASTERS.channels)||[]).slice().sort((a,b)=>(Number(a.order)||99)-(Number(b.order)||99))
    .filter(c=>c.active==='Y'||has[c.channelId]);
}

// ── 이동 ──
function _ofGo(pageId,param){navPage(pageId,_findPageEl(pageId),param);}

// ── 그리기 조각 ──
function _ofToggle(k,opts){
  return `<span class="axis-toggle">${opts.map(([v,l])=>`<button type="button" class="${OFFLINE_FILTER[k]===v?'on':''}" onclick="_ofSetFilter('${k}','${v}')">${l}</button>`).join('')}</span>`;
}
/* 상단 필터 바. opts: { ym, mode, unit, category } 중 보일 것만 true, extra = 오른쪽에 붙일 HTML */
function _ofFilterBarHtml(opts,extra){
  const o=opts||{ym:true,mode:true,unit:true,category:true};
  const parts=[];
  if(o.ym)parts.push(`<label class="of-fl"><span>연월</span><input type="month" class="f-inp of-month" value="${_escAttr(_ofYm())}" onchange="_ofSetFilter('ym',this.value)"></label>`);
  if(o.mode)parts.push(_ofToggle('mode',[['month','월'],['ytd','연 누적']]));
  if(o.unit)parts.push(_ofToggle('unit',[['qty','수량'],['amount','금액']]));
  if(o.category)parts.push(`<label class="of-fl"><span>대분류</span><select class="f-inp f-sel dash-filter-select dash-pill-select" onchange="_ofSetFilter('category',this.value)">`+
    `<option value="">전체</option>${PRODUCT_CATEGORIES.map(c=>`<option value="${_escAttr(c)}"${OFFLINE_FILTER.category===c?' selected':''}>${_escHtml(c)}</option>`).join('')}</select></label>`);
  return `<div class="card of-bar">${parts.join('')}${o.mode?`<span class="of-range">${_escHtml(_ofRangeLabel())}</span>`:''}${extra||''}</div>`;
}
function _ofRangeLabel(){const m=_ofRangeMonths();return m.length>1?m[0]+' ~ '+m[m.length-1]+' 누적':m[0];}

/* 데이터 기준일 — 업로드 데이터가 있는 채널만. 기준일이 오늘보다 설정 일수(데이터지연_경고일수)보다 오래되면 경고 배지 + 업로드 링크 */
function _ofFreshnessHtml(inv,only){
  if(!inv)return '';
  const lim=inv.settings?inv.settings['데이터지연_경고일수']:3;
  const chips=(inv.channels||[]).filter(c=>(c.hasStock||c.hasSales)&&(!only||c.channelId===only)).map(c=>{
    const stale=c.staleStock||c.staleSales;
    const part=(lb,d,age,st)=>d?`${lb} <b>${_escHtml(_ofMD(d))}</b>${st?` <span class="of-stale" title="오늘보다 ${age}일 전 — 지연 경고 기준 ${lim}일 초과">⚠ ${age}일 전</span>`:''}`:`${lb} <span class="off-muted">없음</span>`;
    return `<span class="of-fresh-chip${stale?' stale':''}"><span class="of-fresh-ch">${_escHtml(c.name)}</span> ${part('판매',c.salesDate,c.salesAge,c.staleSales)} · ${part('재고',c.stockDate,c.stockAge,c.staleStock)}</span>`;
  });
  if(!chips.length)return `<div class="of-fresh"><span class="off-muted">업로드된 판매·재고 데이터가 없습니다.</span> <a class="of-link" onclick="_ofGo('admin-upload')">데이터 업로드 →</a></div>`;
  const anyStale=(inv.channels||[]).some(c=>(!only||c.channelId===only)&&(c.staleStock||c.staleSales));
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
