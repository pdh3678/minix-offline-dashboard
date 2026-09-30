'use strict';
/* 파트 홈(#home) — 오프라인&특수파트 전체의 첫 화면. 공구와 오프라인을 같은 금액 기준으로 합산한다.
   매출 = 오프라인 Sell-in(IN 실적) × 공급가 + 공구 판매수량 × 공구가(총매출) — VAT 포함, 수수료 차감 전, 본품만(필터는 한 줄로 따로)
   목표 = 오프라인 IN 목표 금액(목표 관리) + 공구 목표 금액(공구목표_월)
   데이터: 서버 home_getSummary(오프라인 채널군 금액·공구 목표·필터·대분류별 OUT·오늘 챙길 것·데이터 기준일)
         + 브라우저 DATA(공구 실적·일정·미기입 — 공구 분석과 같은 함수, part-summary.js)
   섹션: ① 파트 실적 ② 연간 추이 ③ 오늘 챙길 것 ④ 공구 일정 ⑤ 대분류별 이번 달 판매.
   섹션마다 따로 그린다 — 한 섹션이 실패해도(서버 오류·그리기 오류) 나머지는 보인다. 불러오는 동안은 스켈레톤. */

const HOME={ym:'',mode:'month',category:'',sum:null,err:'',loading:false,week:'this',req:0};
let _homeTrendChart=null,_homeCatChart=null,_homeM=null;
const HOME_TARGET_COLOR='#5B6375'; // 목표 선 — 채널군 색이 아닌 보조 잉크(기준선)

function mountHomePage(){
  if(!HOME.ym)HOME.ym=_ofThisYm();
  _homeRender();
  _homeLoad();
}
PAGE_MOUNTS.home=mountHomePage;
// render()(공구 데이터가 바뀔 때마다)가 부른다 — 파트 홈을 보고 있을 때만 다시 그린다
function renderHomePage(){
  const el=document.getElementById('page-home');
  if(el&&el.classList&&el.classList.contains('active'))_homeRender();
}

async function _homeLoad(force){
  const req=++HOME.req,args={ym:HOME.ym,mode:HOME.mode,category:HOME.category};
  HOME.loading=true;HOME.err='';_homeRender();
  try{
    const s=await _offlineCached('home_getSummary',args,force);
    if(req!==HOME.req)return; // 그 사이 필터가 바뀜 — 새 요청이 그린다
    HOME.sum=s;
  }catch(e){
    if(req!==HOME.req)return;
    HOME.err=e.message;HOME.sum=null;
  }
  HOME.loading=false;_homeRender();
}
function _homeSet(k,v){
  if(k==='ym'&&!/^\d{4}-\d{2}$/.test(v))return;
  if(HOME[k]===v)return;
  HOME[k]=v;HOME.sum=null; // 다른 조건의 숫자를 새 머리글 아래 잠깐이라도 보이지 않게
  _homeLoad();
}
function _homeSetWeek(w){HOME.week=w;_homeRender();}

// ── 계산(서버 합계 + 브라우저 공구 실적) ──
const _homeSum=(a,b)=>a==null?b:(b==null?a:a+b);
function _homeModel(){
  const s=HOME.sum;
  if(!s)return null;
  const gm=partGonguMonthly(s.year,s.category),S={};
  PART_GROUPS.forEach(g=>{
    S[g.key]={};
    s.months.forEach(ym=>{
      const x=(s.series[g.key]||{})[ym]||{};
      S[g.key][ym]=g.key==='gongu'
        ?{target:x.target==null?null:x.target,actual:gm[ym].deals?gm[ym].rev:null,incomplete:false,qty:gm[ym].qty,targetQty:x.targetQty==null?null:x.targetQty}
        :{target:x.target==null?null:x.target,actual:x.actual==null?null:x.actual,incomplete:!!x.incomplete};
    });
  });
  const groups=PART_GROUPS.map(g=>{
    const o={key:g.key,label:g.label,color:g.color,target:null,actual:null,incomplete:false};
    s.range.forEach(ym=>{const x=S[g.key][ym];o.target=_homeSum(o.target,x.target);o.actual=_homeSum(o.actual,x.actual);if(x.incomplete)o.incomplete=true;});
    o.rate=_ofRate(o.actual,o.target);
    return o;
  });
  const part={target:null,actual:null,incomplete:false};
  groups.forEach(g=>{part.target=_homeSum(part.target,g.target);part.actual=_homeSum(part.actual,g.actual);if(g.incomplete)part.incomplete=true;});
  part.rate=_ofRate(part.actual,part.target);
  groups.forEach(g=>{g.share=part.actual?(g.actual||0)/part.actual:null;});
  const trend=s.months.map(ym=>{
    const o={ym,target:null,actual:null};
    PART_GROUPS.forEach(g=>{const x=S[g.key][ym];o[g.key]=x.actual;o.target=_homeSum(o.target,x.target);o.actual=_homeSum(o.actual,x.actual);});
    return o;
  });
  return {s,S,groups,part,trend};
}
function _homeRangeLabel(){
  const ym=HOME.ym;
  return HOME.mode==='ytd'?ym.slice(0,4)+'-01 ~ '+ym+' 누적':ym;
}
const _homeInc=on=>on?'<span class="of-inc" title="단가가 없는 모델·대분류 단위 이관 행은 금액에서 빠졌습니다">*</span>':'';
const _homeWonTitle=v=>v==null?'':` title="${_escAttr(_ofWon(v))}"`;

// ── 그리기 ──
function _homeRender(){
  const host=document.getElementById('page-home');
  if(!host)return;
  _homeM=null;
  try{_homeM=_homeModel();}catch(e){console.error('[파트 홈] 합계 계산 실패',e);}
  const sec=(name,fn)=>{try{return fn();}catch(e){console.error('[파트 홈] '+name+' 그리기 실패',e);return _homeErrCard(name,e.message);}};
  host.innerHTML=_homeBarHtml()+
    sec('① 파트 실적',_homePartHtml)+
    sec('② 연간 추이',_homeTrendHtml)+
    `<div class="home-2col">${sec('③ 오늘 챙길 것',_homeTodayHtml)}${sec('④ 공구 일정',_homeScheduleHtml)}</div>`+
    sec('⑤ 대분류별 이번 달 판매',_homeCatHtml);
  try{_homeDrawTrend();}catch(e){console.error('[파트 홈] 연간 추이 차트 실패',e);}
  try{_homeDrawCat();}catch(e){console.error('[파트 홈] 대분류 차트 실패',e);}
}
function _homeErrCard(name,msg){return `<div class="card"><div class="card-hd">${_escHtml(name)}</div><div class="up-err">${_escHtml(msg)}</div></div>`;}
function _homeSkel(name,lines){return `<div class="card"><div class="card-hd">${_escHtml(name)}</div><div class="home-skel">${'<div class="home-skel-bar"></div>'.repeat(lines||3)}</div></div>`;}
// 서버 합계가 필요한 섹션의 공통 상태 — 오류·불러오는 중이면 그 카드, 아니면 null
function _homeWait(name,lines){
  if(HOME.err)return _homeErrCard(name,'파트 집계를 불러오지 못했습니다: '+HOME.err);
  if(!_homeM)return _homeSkel(name,lines);
  return null;
}

function _homeBarHtml(){
  const tog=(k,opts)=>`<span class="axis-toggle">${opts.map(([v,l])=>`<button type="button" class="${HOME[k]===v?'on':''}" onclick="_homeSet('${k}','${v}')">${l}</button>`).join('')}</span>`;
  const s=HOME.sum;
  const fresh=s?(s.freshness||[]).map(c=>{
    const part=(lb,d,age,st)=>d?`${lb} <b>${_escHtml(_ofMD(d))}</b>${st?` <span class="of-stale" title="오늘보다 ${age}일 전 — 지연 경고 기준 ${s.staleDays}일 초과">⚠ ${age}일 전</span>`:''}`:`${lb} <span class="off-muted">없음</span>`;
    return `<span class="of-fresh-chip${c.staleSales||c.staleStock?' stale':''}"><span class="of-fresh-ch">${_escHtml(c.name)}</span> ${part('판매',c.salesDate,c.salesAge,c.staleSales)} · ${part('재고',c.stockDate,c.stockAge,c.staleStock)}</span>`;
  }).join(''):'';
  const live=typeof _lastLiveAt!=='undefined'&&_lastLiveAt?new Date(_lastLiveAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}):'';
  return `<div class="card of-bar">
      <label class="of-fl"><span>연월</span><input type="month" class="f-inp of-month" value="${_escAttr(HOME.ym)}" onchange="_homeSet('ym',this.value)"></label>
      ${tog('mode',[['month','월'],['ytd','연 누적']])}
      <label class="of-fl"><span>대분류</span><select class="f-inp f-sel dash-filter-select dash-pill-select" onchange="_homeSet('category',this.value)"><option value="">전체(본품)</option>${PRODUCT_MAIN_CATEGORIES.map(c=>`<option value="${_escAttr(c)}"${HOME.category===c?' selected':''}>${_escHtml(c)}</option>`).join('')}</select></label>
      <span class="of-range">${_escHtml(_homeRangeLabel())}</span>
      <span class="of-bar-r">${HOME.loading?'<span class="up-progress">불러오는 중…</span>':''}<button type="button" class="btn-cancel up-btn" onclick="_homeLoad(true)">새로고침</button></span>
    </div>
    <div class="of-fresh"><span class="of-fresh-lb">데이터 기준일</span>${fresh||(s?'<span class="off-muted">오프라인 업로드 데이터 없음</span>':'<span class="off-muted">—</span>')}
      <span class="of-fresh-chip"><span class="of-fresh-ch">공구</span> 실시간${live?` <span class="off-muted">(동기화 ${_escHtml(live)})</span>`:''}</span></div>`;
}

// ① 파트 실적
function _homePartHtml(){
  const name='① 파트 실적',w=_homeWait(name,4);
  if(w)return w;
  const {groups,part,s}=_homeM;
  const rateCls=r=>r==null?'':r>=1?'cok':r<0.8?'cw':'cm';
  const mini=groups.map(g=>`<div class="home-mini">
      <div class="home-mini-hd"><span class="home-dot" style="background:${g.color}"></span>${_escHtml(g.label)}</div>
      <div class="home-mini-v"${_homeWonTitle(g.actual)}>${_ofWonShort(g.actual)}${_homeInc(g.incomplete)}</div>
      <div class="home-mini-sub">목표 <span${_homeWonTitle(g.target)}>${_ofWonShort(g.target)}</span> · 달성률 <b class="${rateCls(g.rate)}">${_ofPct(g.rate)}</b></div>
      <div class="home-mini-sub">기여 비중 <b>${_ofPct(g.share)}</b></div>
    </div>`).join('');
  const f=s.filter||{};
  const filterLine=!s.category&&(f.amount||f.qty)?`<div class="of-extra" title="필터는 본품합계포함 N이라 파트 실적·목표에 들어가지 않습니다">필터 매출 ${f.amount!=null?_ofWonShort(f.amount):'— (단가 없음)'}${_homeInc(f.incomplete)} · Sell-in ${_ofNum(f.qty)}개 — 파트 합계에 들어가지 않습니다</div>`:'';
  const warn=(s.warnings||[]).length?`<div class="of-note of-note-warn">${s.warnings.map(x=>'⚠ '+_escHtml(x)).join('<br>')}</div>`:'';
  return `<div class="card home-part"><div class="card-hd"><span>① 파트 실적</span><span class="card-hd-r">${_escHtml(_homeRangeLabel())}${s.category?' · '+_escHtml(s.category):' · 본품'}</span></div>
    <div class="home-hero">
      <div><div class="home-hero-lb">파트 실적</div><div class="home-hero-v"${_homeWonTitle(part.actual)}>${_ofWonShort(part.actual)}${_homeInc(part.incomplete)}</div></div>
      <div><div class="home-hero-lb">파트 목표</div><div class="home-hero-v2"${_homeWonTitle(part.target)}>${_ofWonShort(part.target)}</div></div>
      <div><div class="home-hero-lb">달성률</div><div class="home-hero-v2 ${rateCls(part.rate)}">${_ofPct(part.rate)}</div></div>
    </div>
    <div class="home-mini-row">${mini}</div>
    ${filterLine}${warn}
    <div class="of-note">매출 기준: 오프라인 Sell-in × 공급가(ERP 매출이익리스트 채널은 파일의 금액) + 공구 판매 × 공구가 (VAT 포함, 수수료 차감 전) · 목표 = 오프라인 IN 목표 금액 + 공구 목표 금액</div></div>`;
}

// ② 연간 추이 — 채널군별 누적 막대(실적) + 파트 월 목표 선. 막대를 누르면 그 달로
function _homeTrendHtml(){
  const name='② 연간 추이',w=_homeWait(name,5);
  if(w)return w;
  const {trend,s}=_homeM;
  const rows=trend.map(x=>`<tr class="${x.ym===HOME.ym?'home-sel':''}"><td>${+x.ym.slice(5)}월</td>${PART_GROUPS.map(g=>`<td class="num-col">${_ofWon(x[g.key])}</td>`).join('')}<td class="num-col"><b>${_ofWon(x.actual)}</b></td><td class="num-col">${_ofWon(x.target)}</td><td class="num-col">${_ofPct(_ofRate(x.actual,x.target))}</td></tr>`).join('');
  return `<div class="card"><div class="card-hd"><span>② 연간 추이 <span class="of-sub">${_escHtml(s.year)}년 · 채널군별 실적 + 파트 월 목표</span></span><span class="card-hd-r">막대를 누르면 그 달로 이동</span></div>
    <div class="home-chart"><canvas id="homeTrendCanvas" aria-label="월별 채널군 실적과 파트 목표"></canvas></div>
    <details class="home-tbl"><summary>월별 표</summary><div class="tbl-wrap"><table class="of-tbl"><thead><tr><th>월</th>${PART_GROUPS.map(g=>`<th class="num-col">${_escHtml(g.label)}</th>`).join('')}<th class="num-col">파트 실적</th><th class="num-col">파트 목표</th><th class="num-col">달성률</th></tr></thead><tbody>${rows}</tbody></table></div></details></div>`;
}
function _homeDrawTrend(){
  const el=document.getElementById('homeTrendCanvas');
  if(_homeTrendChart){_homeTrendChart.destroy();_homeTrendChart=null;}
  if(!el||!_homeM||typeof Chart==='undefined'||!el.getContext)return;
  const trend=_homeM.trend,sel=ym=>HOME.mode==='ytd'?ym<=HOME.ym:ym===HOME.ym;
  const top=i=>{let t=-1;PART_GROUPS.forEach((g,gi)=>{if(trend[i][g.key])t=gi;});return t;};
  const max=Math.max(1,...trend.map(x=>Math.max(x.actual||0,x.target||0)));
  const ds=PART_GROUPS.map((g,gi)=>({type:'bar',label:g.label,stack:'part',order:1,data:trend.map(x=>x[g.key]||0),
    // 선택한 범위(그 달 / 1월~그 달)는 진하게, 나머지는 옅게 — 위 ① 숫자가 어느 막대인지 보이게
    backgroundColor:trend.map(x=>sel(x.ym)?g.color:g.color+'66'),
    borderColor:'#FFFFFF',borderWidth:{top:2,right:0,bottom:0,left:0},borderSkipped:false,maxBarThickness:34,
    borderRadius:c=>top(c.dataIndex)===gi?{topLeft:4,topRight:4,bottomLeft:0,bottomRight:0}:0}));
  ds.push({type:'line',label:'파트 월 목표',order:0,data:trend.map(x=>x.target),borderColor:HOME_TARGET_COLOR,backgroundColor:HOME_TARGET_COLOR,
    borderWidth:2,pointRadius:4,pointHoverRadius:6,pointBorderColor:'#FFFFFF',pointBorderWidth:2,tension:0,spanGaps:true});
  const fmt=_axisMoneyFmt(max);
  _homeTrendChart=new Chart(el.getContext('2d'),{data:{labels:trend.map(x=>+x.ym.slice(5)+'월'),datasets:ds},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      scales:{x:{stacked:true,grid:{display:false}},y:{stacked:true,beginAtZero:true,grid:{color:'#EEF0F5'},border:{display:false},ticks:{callback:v=>fmt(v)}}},
      // 범례 색은 채널군 색 그대로(막대는 범위 밖 달이 옅어서 첫 칸 색을 쓰면 옅게 나온다), 순서는 채널군 → 목표 선
      plugins:{legend:{position:'bottom',labels:{boxWidth:10,boxHeight:10,usePointStyle:true,font:{size:11},sort:(a,b)=>a.datasetIndex-b.datasetIndex,
          generateLabels:chart=>Chart.defaults.plugins.legend.labels.generateLabels(chart).map(l=>{const g=PART_GROUPS[l.datasetIndex];if(g){l.fillStyle=g.color;l.strokeStyle=g.color;}return l;})}},
        tooltip:{callbacks:{label:c=>c.dataset.label+' '+_ofWonShort(c.raw),
          footer:items=>{const x=trend[items[0].dataIndex];return '파트 실적 '+_ofWonShort(x.actual)+' · 달성률 '+_ofPct(_ofRate(x.actual,x.target));}}}},
      onHover:(e,els)=>{const t=e&&e.native&&e.native.target;if(t&&t.style)t.style.cursor=els&&els.length?'pointer':'default';},
      onClick:(e,els,chart)=>{
        const pts=chart.getElementsAtEventForMode(e,'index',{intersect:false},false);
        if(pts&&pts.length)_homeSet('ym',trend[pts[0].index].ym);
      }}});
}

// ③ 오늘 챙길 것 — 항목별 건수 카드(0건은 "이상 없음"), 누르면 그 화면으로
function _homeTodayHtml(){
  const s=HOME.sum,t=s&&s.today,wait=!s&&!HOME.err;
  const card=(title,n,sub,go,unit)=>{
    const bad=n!=null&&n>0;
    const v=n==null?(wait?'<span class="off-muted">…</span>':'<span class="off-muted">불러오지 못함</span>'):bad?`<span class="home-todo-n">⚠ ${n}<small>${unit}</small></span>`:'<span class="home-todo-ok">✓ 이상 없음</span>';
    return `<div class="home-todo${bad?' bad':''}" role="button" tabindex="0" onclick="${go}" onkeydown="if(event.key==='Enter'){${go}}">
      <div class="home-todo-t">${_escHtml(title)}</div><div class="home-todo-v">${v}</div><div class="home-todo-sub">${bad?sub:''}</div></div>`;
  };
  const delayed=t?t.delayed:null,a=t?t.alerts:null;
  const dSub=delayed?delayed.slice(0,3).map(c=>_escHtml(c.name)+' '+[c.staleSales?'판매 '+c.salesAge+'일 전':'',c.staleStock?'재고 '+c.stockAge+'일 전':''].filter(Boolean).join('·')).join(', ')+(delayed.length>3?` 외 ${delayed.length-3}`:''):'';
  const aN=a?a.over+a.risk+a.storeOut:null;
  const pend=partPendingDoneCount();
  return `<div class="card"><div class="card-hd"><span>③ 오늘 챙길 것</span><span class="card-hd-r">누르면 해당 화면</span></div>
    ${HOME.err?`<div class="up-err">오프라인 항목을 불러오지 못했습니다: ${_escHtml(HOME.err)}</div>`:''}
    <div class="home-todo-grid">
      ${card('데이터 업로드 — 지연 채널',delayed?delayed.length:null,dSub,"_ofGo('admin-upload')",'채널')}
      ${card('미기입 목록 — 종료·실적 미기입 공구',pend,'종료됐는데 판매수량·총매출이 비어 있는 공구건',"navPage('management',_findPageEl('management'))",'건')}
      ${card('코드 매핑 — 미매칭 코드',t?t.unmatched:null,'매핑하지 않은 원본코드 — 판매·재고 합계에서 빠집니다',"_ofGo('admin-code-mapping')",'개')}
      ${card('재고 현황 — 재고 경보',aN,a?`과다 ${a.over} · 결품 위험 ${a.risk} · 점포 결품 ${a.storeOut}`:'','_homeGoInventory()','건')}
    </div></div>`;
}
// 재고 현황으로 — 파트 홈의 대분류 필터를 그대로 넘겨 경보 건수가 같게 보이도록
function _homeGoInventory(){OFFLINE_FILTER.category=HOME.category;_ofGo('offline-inventory');}

// ④ 공구 일정 — 오늘(KST) 기준 이번 주·다음 주(월~일)에 걸친 진행중·예정 공구
function _homeWeekRange(which){
  const today=_kstTodayDate(),dow=(today.getDay()+6)%7;
  const mon=new Date(today.getFullYear(),today.getMonth(),today.getDate()-dow+(which==='next'?7:0));
  const sun=new Date(mon.getFullYear(),mon.getMonth(),mon.getDate()+6);
  const f=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  return {from:f(mon),to:f(sun)};
}
function _homeScheduleDeals(which){
  const r=_homeWeekRange(which);
  return DATA.filter(d=>{
    if(!d.start||d.start>r.to||(d.end||d.start)<r.from)return false;
    if(HOME.category&&partGonguCategory(d.product)!==HOME.category)return false;
    const st=_displayStatus(d);
    return st==='진행중'||st==='예정';
  }).sort((a,b)=>String(a.start).localeCompare(String(b.start))||String(a.ch||'').localeCompare(String(b.ch||'')));
}
function _homeScheduleHtml(){
  const cur=HOME.week,list=_homeScheduleDeals(cur),r=_homeWeekRange(cur);
  const n={this:_homeScheduleDeals('this').length,next:_homeScheduleDeals('next').length};
  const tabs=`<span class="of-atabs">${[['this','이번 주'],['next','다음 주']].map(([k,l])=>`<button type="button" class="${cur===k?'on':''}" onclick="_homeSetWeek('${k}')">${l} ${n[k]}</button>`).join('')}</span>`;
  const rows=list.map(d=>`<tr class="home-click" onclick="_homeGoCalendar('${_escAttr(d.start)}')" title="공구 캘린더 ${_escAttr(d.start)}로 이동">
      <td>${fmtS(d.start)} ~ ${fmtS(d.end||d.start)}</td><td>${_escHtml(d.ch||d.influencer||'')}</td><td>${productBadge(d.product)}</td>
      <td class="num-col">${won(d.s&&d.s.sale)}</td><td>${bdg(_displayStatus(d))}</td></tr>`).join('');
  return `<div class="card"><div class="card-hd"><span>④ 공구 일정 ${tabs}</span><span class="card-hd-r">${_escHtml(fmtS(r.from))} ~ ${_escHtml(fmtS(r.to))}${HOME.category?' · '+_escHtml(HOME.category):''} · 누르면 공구 캘린더</span></div>
    ${list.length?`<div class="tbl-wrap"><table class="of-tbl"><thead><tr><th>기간</th><th>채널</th><th>품목·모델</th><th class="num-col">공구가</th><th>상태</th></tr></thead><tbody>${rows}</tbody></table></div>`
      :`<div class="mp-empty">${cur==='this'?'이번 주':'다음 주'}에 진행중·예정 공구가 없습니다.</div>`}</div>`;
}
// 공구 캘린더의 그 달을 펼치고 그 달로 스크롤(캘린더의 "현재 달 자동 스크롤"은 이번만 건너뛴다)
function _homeGoCalendar(ymd){
  if(!_calStateLoaded){calLoadState();_calStateLoaded=true;}
  const ym=String(ymd).slice(0,7);
  CAL_STATE.years.add(ym.slice(0,4));CAL_STATE.months.add(ym);calSaveState();
  _calScrolled=true;
  navPage('calendar',_findPageEl('calendar'));
  renderCalendarPage();
  requestAnimationFrame(()=>{const el=document.querySelector(`[data-ym="${ym}"]`);if(el&&el.scrollIntoView)el.scrollIntoView({block:'start'});});
}

// ⑤ 대분류별 이번 달 판매 — 오프라인·특수(폐쇄몰·특판·렌탈) Sell-out(서버) + 공구 판매(브라우저), 선택 연월 기준
function _homeCatRows(){
  const s=HOME.sum,g=partGonguByCategory(HOME.ym);
  const cats=s?s.categorySales:(HOME.category?[HOME.category]:PRODUCT_MAIN_CATEGORIES).map(c=>({category:c}));
  const rows=cats.map(c=>{
    const gg=g[c.category]||{qty:0,rev:0,deals:0},off=c.offline||{},cl=c.closed||{};
    return {category:c.category,offline:off.qty==null?null:off.qty,closed:cl.qty==null?null:cl.qty,gongu:gg.deals?gg.qty:null,
      amount:_homeSum(_homeSum(off.amount==null?null:off.amount,cl.amount==null?null:cl.amount),gg.deals?gg.rev:null),incomplete:!!(off.incomplete||cl.incomplete)};
  });
  if(!HOME.category&&g['']&&g[''].deals)rows.push({category:'카탈로그 밖 제품',offline:null,closed:null,gongu:g[''].qty,amount:g[''].rev,incomplete:false,other:true});
  rows.forEach(r=>{r.total=_homeSum(_homeSum(r.offline,r.closed),r.gongu);});
  return rows;
}
function _homeCatHtml(){
  const name='⑤ 대분류별 이번 달 판매';
  if(!HOME.sum&&!HOME.err)return _homeSkel(name,4);
  const rows=_homeCatRows();
  const body=rows.map(r=>`<tr${r.other?' class="of-lv-um"':''}><td>${_escHtml(r.category)}</td>${['offline','closed','gongu'].map(k=>`<td class="num-col">${_ofNum(r[k])}</td>`).join('')}<td class="num-col"><b>${_ofNum(r.total)}</b></td><td class="num-col"${_homeWonTitle(r.amount)}>${_ofWonShort(r.amount)}${_homeInc(r.incomplete)}</td></tr>`).join('');
  return `<div class="card"><div class="card-hd"><span>⑤ 대분류별 이번 달 판매 <span class="of-sub">${_escHtml(HOME.ym)} · 수량</span></span><span class="card-hd-r">판매 기준: 오프라인 Sell-out + 공구 판매</span></div>
    ${HOME.err?`<div class="up-err">오프라인 판매를 불러오지 못했습니다 — 공구 판매만 표시합니다: ${_escHtml(HOME.err)}</div>`:''}
    <div class="home-chart home-chart-cat"><canvas id="homeCatCanvas" aria-label="대분류별 채널군 판매 수량"></canvas></div>
    <div class="tbl-wrap"><table class="of-tbl"><thead><tr><th>대분류</th>${PART_GROUPS.map(g=>`<th class="num-col"><span class="home-dot" style="background:${g.color}"></span>${_escHtml(g.label)}</th>`).join('')}<th class="num-col">합계</th><th class="num-col">금액</th></tr></thead><tbody>${body}</tbody></table></div>
    <div class="of-note">오프라인·특수(폐쇄몰·특판·렌탈) = 판매원장·목표 관리의 OUT(Sell-out) 실적 · 공구 = 시작일이 이 달인 완료·진행중 공구의 판매수량 · 금액 = 오프라인 OUT × 공급가(ERP 매출이익리스트 채널은 파일의 금액) + 공구가 × 판매수량(총매출)</div></div>`;
}
function _homeDrawCat(){
  const el=document.getElementById('homeCatCanvas');
  if(_homeCatChart){_homeCatChart.destroy();_homeCatChart=null;}
  if(!el||typeof Chart==='undefined'||!el.getContext)return;
  const rows=_homeCatRows();
  const end=i=>{let t=-1;PART_GROUPS.forEach((g,gi)=>{if(rows[i][g.key])t=gi;});return t;};
  _homeCatChart=new Chart(el.getContext('2d'),{type:'bar',
    data:{labels:rows.map(r=>r.category),datasets:PART_GROUPS.map((g,gi)=>({label:g.label,data:rows.map(r=>r[g.key]||0),backgroundColor:g.color,stack:'s',
      borderColor:'#FFFFFF',borderWidth:{top:0,right:2,bottom:0,left:0},borderSkipped:false,maxBarThickness:22,
      borderRadius:c=>end(c.dataIndex)===gi?{topRight:4,bottomRight:4,topLeft:0,bottomLeft:0}:0}))},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      scales:{x:{stacked:true,beginAtZero:true,grid:{color:'#EEF0F5'},border:{display:false},ticks:{precision:0}},y:{stacked:true,grid:{display:false}}},
      plugins:{legend:{position:'bottom',labels:{boxWidth:10,boxHeight:10,usePointStyle:true,font:{size:11}}},
        tooltip:{callbacks:{label:c=>c.dataset.label+' '+_ofNum(c.raw)+'개',footer:items=>'합계 '+_ofNum(rows[items[0].dataIndex].total)+'개'}}}}});
}
