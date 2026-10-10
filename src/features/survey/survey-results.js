'use strict';
/* 설문 결과(#admin/surveys/{id}/results · #admin/surveys/{id}/r/{응답ID}) — survey-admin.js의 _svCall·_svGo를 쓴다.
   [요약] 질문별 막대(선택형 보기별 명·%), 척도 평균·분포, 주관식 목록, 일별 응답 수 — 전체 응답 기준
   [응답] 표: 제출시각·주요 답변·영수증 썸네일·중복·처리상태·메모. 필터(처리상태·중복·기간·질문 보기)는 표와 엑셀에만 적용된다
     · 이름·연락처·주소는 서버가 마스킹해서 준다. [개인정보 보기] = survey_revealPii(처리기록에 남음)
     · 영수증은 세션 확인 뒤 GAS가 전달(survey_images) — 썸네일은 보이는 줄만 12장씩, 확대는 한 장씩
     · 처리상태 일괄 변경(반려는 사유), 메모는 응답 상세에서
   [엑셀 다운로드] 전체 또는 지금 필터 — survey_export(다운로드로그에 남음) → SheetJS. 질문별 열(주소는 3열), 삭제된 질문 열, 영수증 보기 링크,
     중복·처리상태·반려사유·메모. 막대는 HTML(단일 계열이라 범례 없음 — 값은 막대 끝 글자, 표 대신 목록이 곧 값). */

const _SVR={id:'',survey:null,items:null,base:'',err:'',tab:'summary',pii:null,piiBusy:false,thumbs:{},thumbBusy:false,sel:{},page:0,
  f:{status:'',dup:'',from:'',to:'',q:'',opt:''},detail:null,busy:false,exporting:false};
const SVR_PAGE=50;
const SVR_STATUSES=['대기','승인','반려','발송완료'];

async function _svrOpen(id,responseId){
  const same=_SVR.id===id&&_SVR.items;
  if(!same)Object.assign(_SVR,{id,survey:null,items:null,err:'',pii:null,thumbs:{},sel:{},page:0,detail:null,tab:'summary',f:{status:'',dup:'',from:'',to:'',q:'',opt:''}});
  if(responseId){_SVR.tab='responses';_SVR.detail={id:responseId,img:0,full:{}};}
  _svrRender();
  if(same&&!responseId)return _svrReload();
  await _svrReload();
}
async function _svrReload(){
  try{
    const j=await _svCall('survey_responses',{id:_SVR.id});
    // 다시 받으면 개인정보는 다시 가린다(보려면 다시 [개인정보 보기] — 그때마다 처리기록에 남는다)
    _SVR.survey=j.survey;_SVR.items=j.items;_SVR.base=j.publicBase||_SVR.base;_SV.base=_SVR.base||_SV.base;_SVR.err='';_SVR.pii=null;
  }catch(e){_SVR.err=e.message;}
  _svrRender();
}
const _svrHost=()=>document.getElementById('page-admin-surveys');
const _svrQs=(withDeleted)=>((_SVR.survey&&_SVR.survey.questions)||[]).filter(q=>q.type!=='notice'&&(withDeleted||!q.deleted));
const _svrNum=n=>Number(n||0).toLocaleString('ko-KR');
const _svrPct=(n,d)=>d?Math.round(n/d*1000)/10+'%':'—';

function _svrRender(){
  const host=_svrHost();
  if(!host)return;
  const s=_SVR.survey,items=_SVR.items;
  const head=`<div class="sva-topbar">
    <button type="button" class="btn-cancel" onclick="_svGo('')">← 목록</button>
    <div class="sva-top-title">${_escHtml(s?s.title:'결과')}</div>${s?_svStatusBadge(s.status,null):''}
    <div class="sva-top-r">
      ${s?`<button type="button" class="btn-cancel sva-btn" onclick="_svGo('${_escHtml(s.id)}')">편집</button>`:''}
      <button type="button" class="btn-cancel sva-btn" onclick="_svrReload()">새로고침</button>
      <button type="button" class="btn-primary sva-btn" onclick="_svrExport('전체')" ${!items||!items.length||_SVR.exporting?'disabled':''}>${_SVR.exporting?'만드는 중…':'엑셀 다운로드(전체)'}</button>
    </div></div>`;
  if(!items){host.innerHTML=`<div class="sva-ed">${head}<div class="card">${_SVR.err?`<div class="up-err">${_escHtml(_SVR.err)}</div>`:'<div class="sva-empty">응답을 불러오는 중…</div>'}</div></div>`;return;}
  const tabs=`<div class="subtabs open">${[['summary','요약'],['responses','응답 '+_svrNum(items.length)]].map(([k,l])=>`<button type="button" class="stab${_SVR.tab===k?' sam':''}" onclick="_svrTab('${k}')">${l}</button>`).join('')}</div>`;
  host.innerHTML=`<div class="sva-ed">${head}${_SVR.err?`<div class="up-err">${_escHtml(_SVR.err)}</div>`:''}${tabs}
    ${_SVR.tab==='summary'?_svrSummaryHtml():_svrResponsesHtml()}${_svrDetailHtml()}</div>`;
  if(_SVR.tab==='responses')_svrLoadThumbs();
  if(_SVR.detail)_svrLoadFull();
}
function _svrTab(t){_SVR.tab=t;_svrRender();}

// ━━━━━━━━━━━━━━━━━━━━━━━━━ 요약 ━━━━━━━━━━━━━━━━━━━━━━━━━
// 가로 막대 한 줄 — 단일 계열(브랜드 파랑), 막대 두께 14px·끝 4px 둥글게, 값은 막대 끝(글자색은 본문색)
function _svrBar(label,n,d,max,muted){
  const w=max?Math.max(n?1.5:0,n/max*100):0;
  return `<div class="svr-row" title="${_escHtml(label)} — ${_svrNum(n)}명 (${_svrPct(n,d)})"><div class="svr-lb">${_escHtml(label)}</div>
    <div class="svr-track"><div class="svr-bar${muted?' muted':''}" style="width:${w}%"></div><span class="svr-val"><b>${_svrNum(n)}</b> · ${_svrPct(n,d)}</span></div></div>`;
}
function _svrSummaryHtml(){
  const items=_SVR.items,s=_SVR.survey;
  if(!items.length)return '<div class="card"><div class="sva-empty">아직 응답이 없습니다.</div></div>';
  const st={};SVR_STATUSES.forEach(k=>{st[k]=0;});
  let dup=0;items.forEach(r=>{st[r.status]=(st[r.status]||0)+1;if(r.dup)dup++;});
  const tile=(l,v,sub)=>`<div class="svr-tile"><div class="svr-tile-l">${l}</div><div class="svr-tile-v">${v}</div>${sub?`<div class="svr-tile-s">${sub}</div>`:''}</div>`;
  const tiles=`<div class="svr-tiles">${tile('총 응답',_svrNum(items.length),s.limit?'제한 '+_svrNum(s.limit)+'건':'')}${tile('중복 의심',_svrNum(dup),'같은 연락처 2건 이상')}
    ${SVR_STATUSES.map(k=>tile(k,_svrNum(st[k]),'')).join('')}</div>`;
  const cards=_svrQs(true).map(q=>_svrQSummary(q,items)).join('');
  return `${tiles}<div class="card"><div class="card-hd">일별 응답 수<span class="card-hd-r">제출시각(한국 시각) 기준</span></div>${_svrDailyHtml(items)}</div>
    <div class="svr-grid">${cards}</div>`;
}
// 일별 세로 막대 — 첫 응답일 ~ 마지막 응답일(빈 날 0). 값은 가장 많은 날과 마지막 날만 글자로, 나머지는 막대에 마우스를 올리면
function _svrDailyHtml(items){
  const by={};items.forEach(r=>{const d=String(r.at).slice(0,10);by[d]=(by[d]||0)+1;});
  const days=Object.keys(by).sort();
  if(!days.length)return '';
  const out=[];
  for(let t=Date.parse(days[0]+'T00:00:00Z'),end=Date.parse(days[days.length-1]+'T00:00:00Z');t<=end&&out.length<400;t+=86400000)out.push(new Date(t).toISOString().slice(0,10));
  const max=Math.max(...out.map(d=>by[d]||0)),maxDay=out.find(d=>(by[d]||0)===max),last=out[out.length-1];
  const every=Math.ceil(out.length/12);
  return `<div class="svr-cols" role="img" aria-label="일별 응답 수">${out.map((d,i)=>{const n=by[d]||0,lbl=(+d.slice(5,7))+'/'+(+d.slice(8,10));
    return `<div class="svr-col" title="${lbl} — ${_svrNum(n)}건" tabindex="0"><span class="svr-col-v">${(d===maxDay||d===last)&&n?_svrNum(n):''}</span>
      <div class="svr-col-bar" style="height:${max?Math.max(n?3:0,n/max*100):0}%"></div><span class="svr-col-x">${i%every===0||d===last?lbl:''}</span></div>`;}).join('')}</div>
    <details class="svr-table"><summary>표로 보기</summary><table class="sva-tbl"><thead><tr><th>날짜</th><th>응답</th></tr></thead><tbody>${out.filter(d=>by[d]).map(d=>`<tr><td>${d}</td><td class="sva-num">${_svrNum(by[d])}</td></tr>`).join('')}</tbody></table></details>`;
}
function _svrQSummary(q,items){
  const t=q.type,title=(q.deleted?'(삭제된 질문) ':'')+q.title;
  const ans=items.map(r=>r.answers[q.id]).filter(v=>v!=null&&v!=='');
  const n=ans.length;
  let body='';
  if(SV_CHOICE_T[t]){
    const cnt={},extra=[],others=[];
    (q.options||[]).forEach(o=>{cnt[o]=0;});
    ans.forEach(a=>{(a.sel||[]).forEach(o=>{if(!(o in cnt)){cnt[o]=0;extra.push(o);}cnt[o]++;});if(a.other!=null)others.push(a.other);});
    const rows=(q.options||[]).map(o=>[o,cnt[o],false]).concat(extra.map(o=>['(이전 보기) '+o,cnt[o],true]));
    if(q.allowOther||others.length)rows.push(['기타(직접 입력)',others.length,false]);
    const max=Math.max(0,...rows.map(r=>r[1]));
    body=rows.map(r=>_svrBar(r[0],r[1],n,max,r[2])).join('')+
      (others.length?`<details class="svr-others"><summary>기타 직접 입력 ${others.length}건</summary><ul>${others.map(o=>`<li>${_escHtml(o)}</li>`).join('')}</ul></details>`:'');
    if(t==='checkbox')body+=`<div class="svr-note">복수 선택 — %는 이 질문에 답한 ${_svrNum(n)}명 기준</div>`;
  }else if(t==='scale'){
    const c=[0,0,0,0,0];ans.forEach(v=>{if(v>=1&&v<=5)c[v-1]++;});
    const avg=n?ans.reduce((a,b)=>a+Number(b),0)/n:null,max=Math.max(...c);
    body=`<div class="svr-avg"><b>${avg==null?'—':(Math.round(avg*100)/100).toFixed(2)}</b><span>점 평균 · 5점 만점</span></div>`+
      [5,4,3,2,1].map(k=>_svrBar(k+'점'+(k===1&&q.minLabel?' · '+q.minLabel:k===5&&q.maxLabel?' · '+q.maxLabel:''),c[k-1],n,max)).join('');
  }else if(t==='consent'){
    body=`<div class="svr-avg"><b>${_svrNum(n)}</b><span>명 동의 (${_svrPct(n,items.length)})</span></div>`;
  }else if(t==='file'){
    const pics=ans.reduce((a,b)=>a+Number(b||0),0);
    body=`<div class="svr-avg"><b>${_svrNum(n)}</b><span>명이 사진 ${_svrNum(pics)}장 첨부 — [응답] 탭에서 확인</span></div>`;
  }else if(SurveyKit.PII[t]){
    body=`<div class="svr-avg"><b>${_svrNum(n)}</b><span>명 입력 — 개인정보라 요약에 싣지 않습니다([응답] 탭)</span></div>`;
  }else{
    body=`<div class="svr-texts">${ans.length?ans.slice().reverse().map(v=>`<div class="svr-text">${_escHtml(v)}</div>`).join(''):'<div class="sva-empty">답변 없음</div>'}</div>`;
  }
  return `<div class="card svr-q${q.deleted?' svr-deleted':''}"><div class="card-hd"><span>${_escHtml(title)}</span><span class="card-hd-r">${_escHtml(SurveyKit.TYPE_LABEL[t]||t)} · 응답 ${_svrNum(n)}명</span></div>${body}</div>`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━ 응답 ━━━━━━━━━━━━━━━━━━━━━━━━━
function _svrFiltered(){
  const f=_SVR.f,q=f.q?_svrQs(true).find(x=>x.id===f.q):null;
  return _SVR.items.filter(r=>{
    if(f.status&&r.status!==f.status)return false;
    if(f.dup==='dup'&&!r.dup)return false;
    if(f.dup==='nodup'&&r.dup)return false;
    const d=String(r.at).slice(0,10);
    if(f.from&&d<f.from)return false;
    if(f.to&&d>f.to)return false;
    if(q&&f.opt){
      const a=r.answers[q.id];
      if(!a)return false;
      if(f.opt==='__other')return a.other!=null;
      if((a.sel||[]).indexOf(f.opt)<0)return false;
    }
    return true;
  }).slice().reverse(); // 최신 제출이 위
}
function _svrFilterDesc(){
  const f=_SVR.f,out=[];
  if(f.status)out.push('처리상태 '+f.status);
  if(f.dup)out.push(f.dup==='dup'?'중복만':'중복 제외');
  if(f.from||f.to)out.push('기간 '+(f.from||'…')+' ~ '+(f.to||'…'));
  if(f.q&&f.opt){const q=_svrQs(true).find(x=>x.id===f.q);out.push((q?q.title:f.q)+' = '+(f.opt==='__other'?'기타':f.opt));}
  return out.join(' · ');
}
// 표의 '주요 답변' — 선택형(필수 먼저) 두 개 + 이름·연락처(마스킹 또는 [개인정보 보기] 값)
function _svrMain(r){
  const qs=_svrQs(false),parts=[];
  qs.filter(q=>SV_CHOICE_T[q.type]).sort((a,b)=>(b.required?1:0)-(a.required?1:0)).slice(0,2).forEach(q=>{
    const a=r.answers[q.id];if(a)parts.push(_escHtml((a.sel||[]).concat(a.other!=null?['기타: '+a.other]:[]).join(', ')));
  });
  qs.filter(q=>q.type==='name'||q.type==='phone').forEach(q=>{
    const v=_svrPiiVal(r,q);if(v)parts.push(`<span class="svr-pii">${_escHtml(v)}</span>`);
  });
  return parts.join(' · ')||'<span class="sva-muted">—</span>';
}
function _svrPiiVal(r,q){
  const raw=_SVR.pii&&_SVR.pii[r.id]&&_SVR.pii[r.id][q.id];
  const v=raw!=null?raw:r.answers[q.id];
  if(v==null)return '';
  if(q.type==='address')return [v.zip?'('+v.zip+')':'',v.addr1,v.addr2].filter(Boolean).join(' ');
  return String(v);
}
function _svrResponsesHtml(){
  const list=_svrFiltered(),f=_SVR.f,qs=_svrQs(true).filter(q=>SV_CHOICE_T[q.type]);
  const pages=Math.max(1,Math.ceil(list.length/SVR_PAGE));
  if(_SVR.page>=pages)_SVR.page=pages-1;
  const rows=list.slice(_SVR.page*SVR_PAGE,(_SVR.page+1)*SVR_PAGE);
  const fq=qs.find(q=>q.id===f.q);
  const selN=Object.keys(_SVR.sel).filter(k=>_SVR.sel[k]).length;
  const filters=`<div class="svr-filters">
    <select class="f-inp f-sel sva-small" onchange="_svrSetF('status',this.value)"><option value="">처리상태 전체</option>${SVR_STATUSES.map(k=>`<option ${f.status===k?'selected':''}>${k}</option>`).join('')}</select>
    <select class="f-inp f-sel sva-small" onchange="_svrSetF('dup',this.value)"><option value="">중복 전체</option><option value="dup" ${f.dup==='dup'?'selected':''}>중복만</option><option value="nodup" ${f.dup==='nodup'?'selected':''}>중복 제외</option></select>
    <label class="svr-flab">기간 <input type="date" class="f-inp sva-small" value="${_escHtml(f.from)}" onchange="_svrSetF('from',this.value)"> ~ <input type="date" class="f-inp sva-small" value="${_escHtml(f.to)}" onchange="_svrSetF('to',this.value)"></label>
    <select class="f-inp f-sel sva-small" onchange="_svrSetF('q',this.value)"><option value="">질문 보기 전체</option>${qs.map(q=>`<option value="${_escHtml(q.id)}" ${f.q===q.id?'selected':''}>${_escHtml((q.deleted?'(삭제) ':'')+q.title)}</option>`).join('')}</select>
    ${fq?`<select class="f-inp f-sel sva-small" onchange="_svrSetF('opt',this.value)"><option value="">보기 선택</option>${(fq.options||[]).map(o=>`<option value="${_escHtml(o)}" ${f.opt===o?'selected':''}>${_escHtml(o)}</option>`).join('')}${fq.allowOther?`<option value="__other" ${f.opt==='__other'?'selected':''}>기타(직접 입력)</option>`:''}</select>`:''}
    ${_svrFilterDesc()?`<button type="button" class="btn-cancel sva-btn" onclick="_svrClearF()">필터 지우기</button>`:''}
    <span class="svr-fcount">${_svrNum(list.length)}건</span>
    <span class="svr-fr">
      <button type="button" class="btn-cancel sva-btn" onclick="_svrTogglePii()" ${_SVR.piiBusy?'disabled':''}>${_SVR.pii?'개인정보 가리기':_SVR.piiBusy?'불러오는 중…':'개인정보 보기'}</button>
      <button type="button" class="btn-cancel sva-btn" onclick="_svrExport('필터')" ${!list.length||!_svrFilterDesc()||_SVR.exporting?'disabled':''} title="지금 필터 결과만">엑셀(필터 결과)</button>
    </span></div>`;
  const bulk=`<div class="svr-bulk${selN?' on':''}"><b>${selN}건 선택</b>
    <select class="f-inp f-sel sva-small" id="svrBulkSt">${SVR_STATUSES.map(k=>`<option>${k}</option>`).join('')}</select>
    <button type="button" class="btn-primary sva-btn" onclick="_svrBulk()" ${!selN||_SVR.busy?'disabled':''}>처리상태 변경</button>
    ${selN?`<button type="button" class="btn-cancel sva-btn" onclick="_SVR.sel={};_svrRender()">선택 해제</button>`:''}</div>`;
  const fileQ=_svrQs(false).some(q=>q.type==='file');
  const allOn=rows.length&&rows.every(r=>_SVR.sel[r.id]);
  const trs=rows.map(r=>{
    const th=r.files.slice(0,3).map(fl=>{const d=_SVR.thumbs[fl.id];
      return `<button type="button" class="svr-th" onclick="_svrOpenDetail('${_escHtml(r.id)}',${r.files.indexOf(fl)})" title="크게 보기">${d&&d!=='err'&&d!=='none'?`<img src="${d}" alt="영수증">`:d==='none'?'<span>HEIC</span>':d==='err'?'<span>!</span>':'<span class="svf-spin svr-sp"></span>'}</button>`;}).join('');
    return `<tr class="${_SVR.sel[r.id]?'sel':''}">
      <td><input type="checkbox" ${_SVR.sel[r.id]?'checked':''} onchange="_svrSel('${_escHtml(r.id)}',this.checked)" aria-label="선택"></td>
      <td class="sva-nowrap"><a class="sva-link" href="#" onclick="event.preventDefault();_svrOpenDetail('${_escHtml(r.id)}',0)">${_escHtml(String(r.at).slice(0,16))}</a></td>
      <td class="sva-wrap svr-main">${_svrMain(r)}${r.purgedAt?`<div class="sva-sub">개인정보 삭제됨 ${_escHtml(String(r.purgedAt).slice(0,10))}</div>`:''}</td>
      ${fileQ?`<td class="svr-ths">${th||'<span class="sva-muted">—</span>'}${r.files.length>3?`<span class="sva-sub">+${r.files.length-3}</span>`:''}</td>`:''}
      <td>${r.dup?'<span class="svr-dup" title="같은 연락처로 2건 이상">중복</span>':''}</td>
      <td><span class="svr-st svr-st-${SVR_STATUSES.indexOf(r.status)}">${_escHtml(r.status)}</span>${r.status==='반려'&&r.reason?`<div class="sva-sub">${_escHtml(r.reason)}</div>`:''}</td>
      <td class="sva-wrap svr-memo"><a href="#" onclick="event.preventDefault();_svrOpenDetail('${_escHtml(r.id)}',0,true)">${r.memo?_escHtml(r.memo):'<span class="sva-muted">메모</span>'}</a></td></tr>`;
  }).join('');
  const pager=pages>1?`<div class="svr-pager"><button type="button" class="btn-cancel sva-btn" ${_SVR.page===0?'disabled':''} onclick="_svrPage(-1)">‹ 이전</button>
    <span>${_SVR.page+1} / ${pages}</span><button type="button" class="btn-cancel sva-btn" ${_SVR.page>=pages-1?'disabled':''} onclick="_svrPage(1)">다음 ›</button></div>`:'';
  return `<div class="card">${filters}${bulk}
    ${rows.length?`<div class="tbl-wrap"><table class="sva-tbl svr-tbl"><thead><tr><th><input type="checkbox" ${allOn?'checked':''} onchange="_svrSelPage(this.checked)" aria-label="이 페이지 전체 선택"></th>
      <th>제출시각</th><th>주요 답변</th>${fileQ?'<th>영수증</th>':''}<th>중복</th><th>처리상태</th><th>메모</th></tr></thead><tbody>${trs}</tbody></table></div>${pager}`
      :'<div class="sva-empty">조건에 맞는 응답이 없습니다.</div>'}
    <div class="sva-sub">이름·연락처·주소는 가려서 보여줍니다. [개인정보 보기]와 엑셀 다운로드는 처리기록·다운로드로그에 누가·언제·몇 건인지 남습니다.</div></div>`;
}
function _svrSetF(k,v){_SVR.f[k]=v;if(k==='q')_SVR.f.opt='';_SVR.page=0;_svrRender();}
function _svrClearF(){_SVR.f={status:'',dup:'',from:'',to:'',q:'',opt:''};_SVR.page=0;_svrRender();}
function _svrPage(d){_SVR.page+=d;_svrRender();}
function _svrSel(id,on){_SVR.sel[id]=on;_svrRender();}
function _svrSelPage(on){const list=_svrFiltered().slice(_SVR.page*SVR_PAGE,(_SVR.page+1)*SVR_PAGE);list.forEach(r=>{_SVR.sel[r.id]=on;});_svrRender();}

async function _svrTogglePii(){
  if(_SVR.pii){_SVR.pii=null;_svrRender();return;}
  if(!confirm('이 설문의 이름·연락처·주소를 가리지 않고 표시합니다.\n누가·언제 봤는지 처리기록에 남습니다. 계속할까요?'))return;
  _svrRevealPii(false);
}
async function _svrRevealPii(silent){
  _SVR.piiBusy=true;if(!silent)_svrRender();
  try{const j=await _svCall('survey_revealPii',{id:_SVR.id});_SVR.pii=j.items||{};}
  catch(e){showToast('개인정보를 불러오지 못했습니다: '+e.message,{type:'error'});}
  _SVR.piiBusy=false;_svrRender();
}
async function _svrBulk(){
  const ids=Object.keys(_SVR.sel).filter(k=>_SVR.sel[k]),st=(document.getElementById('svrBulkSt')||{}).value;
  if(!ids.length||!st||_SVR.busy)return;
  let reason='';
  if(st==='반려'){reason=prompt(ids.length+'건을 반려합니다. 반려 사유를 입력해주세요.','');if(reason===null)return;reason=reason.trim();if(!reason){showToast('반려 사유를 입력해주세요.',{type:'error'});return;}}
  await _svrUpdate({responseIds:ids,status:st,reason});
  _SVR.sel={};_svrRender();
}
async function _svrUpdate(data){
  _SVR.busy=true;
  try{
    const j=await _svCall('survey_updateResponses',Object.assign({id:_SVR.id},data));
    const set={};(j.updated||[]).forEach(id=>{set[id]=true;});
    _SVR.items.forEach(r=>{
      if(!set[r.id])return;
      if(data.status!=null){r.status=data.status;r.reason=data.status==='반려'?data.reason:'';}
      if(data.memo!=null)r.memo=data.memo;
    });
    showToast((j.updated||[]).length+'건 저장했습니다.',{type:'success'});
  }catch(e){showToast('저장 실패: '+e.message,{type:'error'});}
  _SVR.busy=false;
}

// ── 영수증 — 썸네일은 지금 페이지에 보이는 것만 12장씩, 실패하면 그 자리에 표시 ──
async function _svrLoadThumbs(){
  if(_SVR.thumbBusy)return;
  const rows=_svrFiltered().slice(_SVR.page*SVR_PAGE,(_SVR.page+1)*SVR_PAGE);
  const need=[];rows.forEach(r=>r.files.slice(0,3).forEach(f=>{if(_SVR.thumbs[f.id]==null)need.push(f.id);}));
  if(!need.length)return;
  _SVR.thumbBusy=true;
  const batch=need.slice(0,12);
  try{
    const j=await _svCall('survey_images',{id:_SVR.id,files:batch,size:'thumb'});
    batch.forEach(id=>{const im=j.images&&j.images[id];_SVR.thumbs[id]=im&&im.data?'data:'+im.mime+';base64,'+im.data:im&&im.error==='NO_PREVIEW'?'none':'err';});
  }catch(e){batch.forEach(id=>{_SVR.thumbs[id]='err';});}
  _SVR.thumbBusy=false;
  if(_SVR.tab==='responses'&&_svrHost()&&document.querySelector('.svr-tbl'))_svrRender();
}

// ── 응답 상세(모든 답 · 영수증 크게 · 메모) ──
function _svrOpenDetail(id,img,memo){_SVR.detail={id,img:img||0,full:(_SVR.detail&&_SVR.detail.id===id?_SVR.detail.full:{}),focusMemo:!!memo};_svrRender();}
function _svrCloseDetail(){
  _SVR.detail=null;
  // 엑셀 링크(#…/r/{응답ID})로 들어왔으면 주소를 결과 화면으로 정리
  if(/\/r\//.test(location.hash))history.replaceState(null,'',location.pathname+location.search+'#admin/surveys/'+_SVR.id+'/results');
  _svrRender();
}
function _svrAnswerText(q,v){
  if(v==null||v==='')return '';
  const t=q.type;
  if(t==='consent')return v===true?'동의':'';
  if(t==='file')return '사진 '+v+'장';
  if(SV_CHOICE_T[t])return (v.sel||[]).concat(v.other!=null?['기타: '+v.other]:[]).join(', ');
  if(t==='address')return [v.zip?'('+v.zip+')':'',v.addr1,v.addr2].filter(Boolean).join(' ');
  return String(v);
}
function _svrDetailHtml(){
  const d=_SVR.detail;
  if(!d||!_SVR.items)return '';
  const r=_SVR.items.find(x=>x.id===d.id);
  if(!r)return `<div class="sva-ov" onclick="if(event.target===this)_svrCloseDetail()"><div class="sva-modal"><div class="sva-modal-hd"><b>응답</b><button type="button" class="sva-x" onclick="_svrCloseDetail()">✕</button></div><div class="sva-empty">응답을 찾을 수 없습니다(${_escHtml(d.id)}).</div></div></div>`;
  const rows=_svrQs(true).map(q=>{
    const v=SurveyKit.PII[q.type]?_svrPiiVal(r,q):_svrAnswerText(q,r.answers[q.id]);
    return `<tr><th>${_escHtml((q.deleted?'(삭제된 질문) ':'')+q.title)}</th><td>${v?_escHtml(v):'<span class="sva-muted">—</span>'}</td></tr>`;
  }).join('');
  const f=r.files[d.img],full=f?d.full[f.id]:null;
  const img=!r.files.length?'':`<div class="svr-viewer">
    <div class="svr-viewer-img">${!full?'<span class="svf-spin"></span>':full==='err'?'<div class="sva-empty">이미지를 불러오지 못했습니다.</div>':full==='none'
      ?`<div class="sva-empty">이 형식(${_escHtml(f.type)})은 아직 미리보기가 없습니다.<br><a class="sva-link" href="https://drive.google.com/file/d/${_escHtml(f.id)}/view" target="_blank" rel="noopener">드라이브에서 원본 열기</a> (공유 드라이브 권한 필요)</div>`
      :`<img src="${full}" alt="영수증 ${d.img+1}">`}</div>
    <div class="svr-viewer-nav"><button type="button" class="btn-cancel sva-btn" ${d.img<=0?'disabled':''} onclick="_svrImg(-1)">‹</button>
      <span>사진 ${d.img+1} / ${r.files.length} · ${_escHtml(SurveyKit.fmtBytes(Number(f.size)||0))}</span>
      <button type="button" class="btn-cancel sva-btn" ${d.img>=r.files.length-1?'disabled':''} onclick="_svrImg(1)">›</button></div></div>`;
  return `<div class="sva-ov" onclick="if(event.target===this)_svrCloseDetail()"><div class="sva-modal svr-detail" role="dialog" aria-label="응답 상세">
    <div class="sva-modal-hd"><b>응답 · ${_escHtml(String(r.at).slice(0,16))}</b>${r.dup?' <span class="svr-dup">중복</span>':''}<button type="button" class="sva-x" onclick="_svrCloseDetail()" aria-label="닫기">✕</button></div>
    <div class="svr-detail-body">${img}
      <div class="svr-detail-ans"><table class="svr-kv">${rows}</table>
        ${!_SVR.pii?'<div class="sva-sub">이름·연락처·주소는 가려져 있습니다 — [응답] 탭의 [개인정보 보기]</div>':''}
        <div class="svr-detail-st"><span class="f-lbl">처리상태</span>
          ${SVR_STATUSES.map(k=>`<button type="button" class="svr-stb${r.status===k?' on':''}" onclick="_svrSetOne('${_escHtml(r.id)}','${k}')" ${_SVR.busy?'disabled':''}>${k}</button>`).join('')}
          ${r.status==='반려'&&r.reason?`<div class="sva-sub">반려 사유: ${_escHtml(r.reason)}</div>`:''}</div>
        <label class="f-grp"><span class="f-lbl">메모</span><textarea class="f-inp" rows="3" id="svrMemo" maxlength="1000">${_escHtml(r.memo)}</textarea></label>
        <div class="sva-modal-ft"><span class="sva-sub">응답ID ${_escHtml(r.id)}</span><button type="button" class="btn-primary sva-btn" onclick="_svrSaveMemo('${_escHtml(r.id)}')" ${_SVR.busy?'disabled':''}>메모 저장</button></div>
      </div></div></div></div>`;
}
function _svrImg(dd){const d=_SVR.detail;d.img+=dd;_svrRender();}
async function _svrLoadFull(){
  const d=_SVR.detail,r=d&&_SVR.items&&_SVR.items.find(x=>x.id===d.id),f=r&&r.files[d.img];
  if(d&&d.focusMemo){d.focusMemo=false;const m=document.getElementById('svrMemo');if(m)m.focus();}
  if(!f||d.full[f.id]||d.loading===f.id)return;
  d.loading=f.id;
  try{
    const j=await _svCall('survey_images',{id:_SVR.id,files:[f.id],size:'full'});
    const im=j.images&&j.images[f.id];
    d.full[f.id]=im&&im.data?'data:'+im.mime+';base64,'+im.data:im&&im.error==='NO_PREVIEW'?'none':'err';
  }catch(e){d.full[f.id]='err';}
  d.loading='';
  if(_SVR.detail===d)_svrRender();
}
async function _svrSetOne(id,st){
  const r=_SVR.items.find(x=>x.id===id);
  if(!r||r.status===st)return;
  let reason='';
  if(st==='반려'){reason=prompt('반려 사유를 입력해주세요.',r.reason||'');if(reason===null)return;reason=reason.trim();if(!reason){showToast('반려 사유를 입력해주세요.',{type:'error'});return;}}
  await _svrUpdate({responseIds:[id],status:st,reason});
  _svrRender();
}
async function _svrSaveMemo(id){
  const m=document.getElementById('svrMemo');
  if(!m)return;
  await _svrUpdate({responseIds:[id],memo:m.value.trim()});
  _svrRender();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━ 엑셀 ━━━━━━━━━━━━━━━━━━━━━━━━━
/* 열: 응답ID · 제출시각 · 질문별(주소는 우편번호·기본주소·상세주소 3열, 선택형은 ', '로, 기타는 '기타: 글') · (삭제된 질문) 열 ·
   영수증 보기(대시보드 링크 — 로그인한 사람만 열림) · 중복 여부 · 처리상태 · 반려사유 · 메모 · 개인정보삭제일 */
function _svrSheetRows(survey,items,base){
  const qs=(survey.questions||[]).filter(q=>q.type!=='notice');
  const ordered=qs.filter(q=>!q.deleted).concat(qs.filter(q=>q.deleted));
  const header=['응답ID','제출시각'],cols=[];
  ordered.forEach(q=>{
    const t=(q.deleted?'(삭제된 질문) ':'')+q.title;
    if(q.type==='address'){['우편번호','기본주소','상세주소'].forEach((l,k)=>{header.push(t+' '+l);cols.push(r=>{const v=r.answers[q.id];return v?[v.zip,v.addr1,v.addr2][k]||'':'';});});}
    else{header.push(t);cols.push(r=>_svrAnswerText(q,r.answers[q.id]));}
  });
  const hasFiles=qs.some(q=>q.type==='file');
  if(hasFiles)header.push('영수증 보기');
  header.push('중복 여부','처리상태','반려사유','메모','개인정보삭제일');
  const link=r=>(base||'')+'/#admin/surveys/'+survey.id+'/r/'+r.id;
  const rows=items.map(r=>{
    const row=[r.id,String(r.at)].concat(cols.map(fn=>fn(r)));
    if(hasFiles)row.push(r.files.length?{v:'영수증 '+r.files.length+'장 보기',l:link(r)}:'');
    row.push(r.dup?'중복':'',r.status,r.reason||'',r.memo||'',r.purgedAt?String(r.purgedAt).slice(0,10):'');
    return row;
  });
  return {header,rows};
}
async function _svrExport(scope){
  if(_SVR.exporting||!_SVR.items)return;
  const list=scope==='필터'?_svrFiltered():null;
  const s=_SVR.survey,stamp=new Date(Date.now()+9*3600000).toISOString().slice(0,16).replace(/[-:]/g,'').replace('T','_');
  const fileName=`설문_${s.slug}_${scope==='필터'?'필터_':''}${stamp}.xlsx`;
  _SVR.exporting=true;_svrRender();
  try{
    const [XLSX,j]=await Promise.all([_loadSheetJS(),_svCall('survey_export',{id:_SVR.id,responseIds:list?list.map(r=>r.id):undefined,scope,filterDesc:scope==='필터'?_svrFilterDesc():'',fileName})]);
    const order={};(list||j.items.slice().reverse()).forEach((r,i)=>{order[r.id]=i;});
    const items=j.items.slice().sort((a,b)=>(order[a.id]||0)-(order[b.id]||0));
    const {header,rows}=_svrSheetRows(j.survey,items,j.publicBase||_SVR.base);
    const aoa=[header].concat(rows.map(r=>r.map(c=>c&&typeof c==='object'?c.v:c)));
    const ws=XLSX.utils.aoa_to_sheet(aoa);
    rows.forEach((r,i)=>r.forEach((c,k)=>{if(c&&typeof c==='object'){const ref=XLSX.utils.encode_cell({r:i+1,c:k});if(ws[ref])ws[ref].l={Target:c.l,Tooltip:'대시보드에서 영수증 보기(로그인 필요)'};}}));
    ws['!cols']=header.map(h=>({wch:Math.min(40,Math.max(10,String(h).length*2))}));
    const wb=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb,ws,'응답');
    XLSX.writeFile(wb,fileName);
    showToast(_svrNum(items.length)+'건을 내려받았습니다 — 다운로드로그에 기록됩니다.',{type:'success'});
  }catch(e){showToast('엑셀 다운로드 실패: '+e.message,{type:'error'});}
  _SVR.exporting=false;_svrRender();
}
