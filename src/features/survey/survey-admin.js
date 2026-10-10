'use strict';
/* 설문 관리(#admin/surveys) — 목록·링크·QR, 편집기(질문·안내문·미리보기), 결과는 survey-results.js.
   해시: #admin/surveys            목록
         #admin/surveys/new        새 설문
         #admin/surveys/{id}       편집
         #admin/surveys/{id}/results       결과
         #admin/surveys/{id}/r/{응답ID}    결과 + 그 응답의 영수증(엑셀의 '영수증 보기' 링크)
   서버는 apps-script-survey.js의 survey_* (doPost, 세션 필수). 응답 페이지 주소 = 설정 탭 '설문_공개기본주소' + /s/{주소}.
   안내문 편집은 회고 편집기 번들(review-assets/review.js)의 mountSurveyNote — 응답 페이지는 SurveyKit.blocksHtml로 그린다.
   편집 중 다른 메뉴로 갔다 와도 같은 설문이면 저장하지 않은 내용을 그대로 이어서 보여준다(메모리에만). */

const _SV={list:null,base:'',err:'',busy:'',ed:null,notes:{},drag:null,previewTimer:null,qr:null};
const SV_LONG_ACTIONS={survey_export:true,survey_images:true,survey_responses:true};

async function _svCall(action,data){
  if(!_getToken())throw new Error('로그인이 필요합니다.');
  const j=await _gasFetch(_getGasUrl(),{method:'POST',body:JSON.stringify({action,session:_getToken(),data:data||{}}),
    _timeoutMs:SV_LONG_ACTIONS[action]?90000:45000});
  if(!j)throw new Error('서버 응답이 비었습니다.');
  if(j.error){
    if(j.error==='AUTH_REQUIRED')throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.');
    // 설문 파일(survey)을 추가하기 전 배포본은 survey_ 액션을 모른다
    if(/_surveyHandle is not defined|presence·offline_ 전용/.test(j.error))throw new Error('Apps Script 배포본에 설문 기능이 아직 없습니다 — apps-script-survey.js(편집기 파일 survey) 추가 후 새 버전 배포가 필요합니다.');
    const e=new Error(j.error);e.code=j.code;e.data=j;throw e;
  }
  return j;
}

function mountSurveysPage(param){
  const host=document.getElementById('page-admin-surveys');
  if(!host)return;
  if(!host._svBound){_svBindEditor(host);host._svBound=true;}
  const p=String(param||'').split('/');
  if(!p[0]){_svUnmountNotes();_svListLoad();return;}
  if(p[1]==='results'||p[1]==='r'){_svUnmountNotes();_svrOpen(p[0],p[1]==='r'?p[2]:'');return;}
  _sveOpen(p[0]==='new'?'':p[0]);
}
PAGE_MOUNTS['admin-surveys']=mountSurveysPage;
// 설문 관리 안에서의 이동 — 저장하지 않은 편집이 있으면 묻는다
function _svGo(param){
  if(_SV.ed&&_SV.ed.dirty&&!String(param||'').startsWith(_SV.ed.s.id||'new')&&!confirm('저장하지 않은 변경이 있습니다. 나가시겠습니까?\n(나가도 이 창을 닫기 전까지는 같은 설문을 다시 열면 이어서 편집할 수 있습니다)'))return;
  navPage('admin-surveys',_findPageEl('admin-surveys'),param||null);
}
window.addEventListener('beforeunload',e=>{if(_SV.ed&&_SV.ed.dirty){e.preventDefault();e.returnValue='';}});

// ── 공용 ──
// open: true = 응답 중, false = 기간 밖, null = 표시 안 함(편집기)
const _svStatusBadge=(st,open)=>`<span class="sva-st sva-st-${st==='게시'?(open===false?'wait':'on'):st==='마감'?'end':'draft'}">${_escHtml(st)}${st==='게시'&&open!=null?(open?' · 응답 중':' · 기간 밖'):''}</span>`;
const _svUrl=slug=>(_SV.base||'https://minix-offlinepart-dashboard.onrender.com')+'/s/'+slug;
const _svDt=s=>s?String(s).replace('T',' ').slice(0,16):'';
function _svCopy(text,label){
  const done=()=>showToast((label||'링크')+'를 복사했습니다.',{type:'success'});
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,()=>_svCopyFallback(text,done));return;}
  _svCopyFallback(text,done);
}
function _svCopyFallback(text,done){
  const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();
  try{document.execCommand('copy');done();}catch(e){prompt('복사해서 쓰세요',text);}
  document.body.removeChild(ta);
}
// 개인정보 삭제 예정일 — GAS _svPurgeDueMs와 같은 규칙(마감 처리 시각과 마감일시 중 이른 쪽 + 보유기간)
function _svPurgeDue(s){
  const kst=v=>{const m=/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(v||''));return m?Date.UTC(+m[1],+m[2]-1,+m[3],+m[4]-9,+m[5]):null;};
  const en=kst(s.endAt),cl=s.status==='마감'?kst(s.closedAt):null;
  const base=cl!=null&&en!=null?Math.min(cl,en):(cl!=null?cl:en);
  if(base==null)return '';
  return new Date(base+9*3600000+(Number(s.retentionDays)||90)*86400000).toISOString().slice(0,10);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━ 목록 ━━━━━━━━━━━━━━━━━━━━━━━━━
async function _svListLoad(){
  _SV.err='';_svListRender();
  try{const j=await _svCall('survey_list');_SV.list=j.items;_SV.base=j.publicBase||_SV.base;}
  catch(e){_SV.err=e.message;}
  _svListRender();
}
function _svListRender(){
  const host=document.getElementById('page-admin-surveys');
  if(!host)return;
  const list=_SV.list;
  const rows=(list||[]).slice().sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))).map(s=>{
    const url=_svUrl(s.slug);
    const due=s.purgeDue?`<div class="sva-sub">개인정보 삭제 예정 ${_escHtml(s.purgeDue)}${s.purged?` · 삭제 ${s.purged}건`:''}</div>`:`<div class="sva-sub">개인정보: 마감 후 ${_escHtml(s.retentionDays)}일 보관</div>`;
    return `<tr>
      <td class="sva-wrap"><a class="sva-link" href="#admin/surveys/${_escHtml(s.id)}" onclick="event.preventDefault();_svGo('${_escHtml(s.id)}')">${_escHtml(s.title)}</a>${due}</td>
      <td>${_svStatusBadge(s.status,s.open)}</td>
      <td class="sva-nowrap">${s.startAt||s.endAt?`${_escHtml(_svDt(s.startAt)||'—')}<br>~ ${_escHtml(_svDt(s.endAt)||'—')}`:'<span class="sva-muted">제한 없음</span>'}</td>
      <td class="sva-num"><a class="sva-link" href="#admin/surveys/${_escHtml(s.id)}/results" onclick="event.preventDefault();_svGo('${_escHtml(s.id)}/results')">${Number(s.responses||0).toLocaleString('ko-KR')}</a>${s.limit?`<div class="sva-sub">/ ${Number(s.limit).toLocaleString('ko-KR')}</div>`:''}</td>
      <td class="sva-wrap"><code class="sva-slug">/s/${_escHtml(s.slug)}</code>${(s.oldSlugs||[]).length?`<div class="sva-sub">이전 주소 ${s.oldSlugs.map(x=>'/s/'+_escHtml(x)).join(', ')} → 자동 이동</div>`:''}</td>
      <td class="sva-acts">
        <button type="button" class="btn-cancel sva-btn" onclick="_svCopy('${_escHtml(url)}')">링크 복사</button>
        <button type="button" class="btn-cancel sva-btn" onclick="_svQrOpen('${_escHtml(s.id)}')">QR</button>
        <button type="button" class="btn-cancel sva-btn" onclick="_svDuplicate('${_escHtml(s.id)}')" ${_SV.busy?'disabled':''}>복제</button>
        ${s.status==='게시'?`<button type="button" class="btn-cancel sva-btn" onclick="_svQuickStatus('${_escHtml(s.id)}','마감')" ${_SV.busy?'disabled':''}>마감</button>`
          :`<button type="button" class="btn-primary sva-btn" onclick="_svQuickStatus('${_escHtml(s.id)}','게시')" ${_SV.busy?'disabled':''}>게시</button>`}
      </td></tr>`;
  }).join('');
  host.innerHTML=`<div class="card">
    <div class="card-hd">설문 관리<span class="card-hd-r">응답 페이지는 로그인 없이 열립니다 · 링크 = ${_escHtml(_SV.base||'설정 탭 설문_공개기본주소')}/s/{주소}
      <button type="button" class="btn-primary sva-new" onclick="_svGo('new')">＋ 새 설문</button></span></div>
    ${_SV.err?`<div class="up-err">${_escHtml(_SV.err)}</div>`:''}
    ${!list?(_SV.err?'':'<div class="sva-empty">불러오는 중…</div>'):list.length?`<div class="tbl-wrap"><table class="sva-tbl"><thead><tr><th>제목</th><th>상태</th><th>기간</th><th>응답</th><th>주소</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
      :'<div class="sva-empty">아직 설문이 없습니다 — [＋ 새 설문]으로 시작하세요.</div>'}
  </div>${_svQrHtml()}`;
}
async function _svQuickStatus(id,status){
  const s=(_SV.list||[]).find(x=>x.id===id);
  if(!s||_SV.busy)return;
  if(status==='마감'&&!confirm(`'${s.title}' 설문을 마감할까요? 응답 페이지가 바로 "마감되었습니다"로 바뀝니다.`))return;
  _SV.busy=id;_svListRender();
  try{await _svCall('survey_setStatus',{id,status});showToast(status==='게시'?'게시했습니다 — 링크·QR로 응답을 받을 수 있습니다.':'마감했습니다.',{type:'success'});}
  catch(e){showToast((status==='게시'?'게시':'마감')+' 실패: '+e.message,{type:'error'});}
  _SV.busy='';_svListLoad();
}
async function _svDuplicate(id){
  const s=(_SV.list||[]).find(x=>x.id===id);
  if(!s||_SV.busy)return;
  const slug=prompt(`'${s.title}'을(를) 복제합니다.\n새 설문의 주소를 정해주세요(영문 소문자·숫자·하이픈 3~40자, 비우면 무작위).`,'');
  if(slug===null)return;
  _SV.busy=id;_svListRender();
  try{
    const j=await _svCall('survey_duplicate',{id,slug:slug.trim().toLowerCase()});
    showToast('복제했습니다(초안) — 기간·안내문 날짜를 확인하고 게시하세요.',{type:'success'});
    _SV.busy='';_svGo(j.survey.id);return;
  }catch(e){showToast('복제 실패: '+e.message,{type:'error'});}
  _SV.busy='';_svListRender();
}

// ── QR — qrcode-generator(MIT)를 처음 열 때만 받는다(SRI 고정, jsDelivr의 자동 압축본이 아닌 원본 파일 — 압축본은 해시가 바뀔 수 있다) ──
const SV_QR_SRC='https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const SV_QR_SRI='sha384-8FWZA6BGMXhsfO+BLtrJK0We6gg5o1JyO8xQm6peWDEUs17ACA5ziE/NIAkl9z2k';
let _svQrLib=null;
function _svLoadQr(){
  if(window.qrcode)return Promise.resolve(window.qrcode);
  if(_svQrLib)return _svQrLib;
  _svQrLib=new Promise((resolve,reject)=>{
    const s=document.createElement('script');
    s.src=SV_QR_SRC;s.integrity=SV_QR_SRI;s.crossOrigin='anonymous';s.async=true;
    s.onload=()=>window.qrcode?resolve(window.qrcode):reject(new Error('QR 라이브러리를 불러왔지만 qrcode 전역이 없습니다.'));
    s.onerror=()=>{_svQrLib=null;reject(new Error('QR 라이브러리를 불러오지 못했습니다 — 네트워크를 확인하세요.'));};
    document.head.appendChild(s);
  });
  return _svQrLib;
}
// QR → canvas(모듈 10px, 여백 4모듈) — 인쇄해도 깨지지 않게 크게 그린다
function _svQrCanvas(lib,text){
  const qr=lib(0,'M');qr.addData(text,'Byte');qr.make();
  const n=qr.getModuleCount(),cell=10,margin=4,size=(n+margin*2)*cell;
  const c=document.createElement('canvas');c.width=size;c.height=size;
  const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,size,size);g.fillStyle='#000';
  for(let r=0;r<n;r++)for(let k=0;k<n;k++)if(qr.isDark(r,k))g.fillRect((k+margin)*cell,(r+margin)*cell,cell,cell);
  return c;
}
function _svQrHtml(){
  const q=_SV.qr;
  if(!q)return '';
  return `<div class="sva-ov" onclick="if(event.target===this)_svQrClose()"><div class="sva-modal" role="dialog" aria-label="QR 코드">
    <div class="sva-modal-hd"><b>QR 코드</b><button type="button" class="sva-x" onclick="_svQrClose()" aria-label="닫기">✕</button></div>
    <div class="sva-qr-title">${_escHtml(q.title)}</div>
    <div class="sva-qr-box">${q.err?`<div class="up-err">${_escHtml(q.err)}</div>`:q.dataUrl?`<img src="${q.dataUrl}" alt="QR 코드" class="sva-qr-img">`:'<div class="sva-empty">만드는 중…</div>'}</div>
    <div class="sva-qr-url"><code>${_escHtml(q.url)}</code></div>
    <div class="sva-modal-ft"><button type="button" class="btn-cancel" onclick="_svCopy('${_escHtml(q.url)}')">링크 복사</button>
      ${q.dataUrl?`<a class="btn-primary sva-dl" href="${q.dataUrl}" download="${_escHtml('QR_'+q.slug+'.png')}">PNG 저장</a>`:''}</div>
  </div></div>`;
}
async function _svQrOpen(id){
  const s=(_SV.list||[]).find(x=>x.id===id)||(_SV.ed&&_SV.ed.s.id===id?_SV.ed.s:null);
  if(!s)return;
  _SV.qr={title:s.title,slug:s.slug,url:_svUrl(s.slug),dataUrl:'',err:''};
  _svRerender();
  try{const lib=await _svLoadQr();_SV.qr.dataUrl=_svQrCanvas(lib,_SV.qr.url).toDataURL('image/png');}
  catch(e){if(_SV.qr)_SV.qr.err=e.message;}
  _svRerender();
}
function _svQrClose(){_SV.qr=null;_svRerender();}
function _svRerender(){
  if(_SV.ed&&document.getElementById('sveRoot')){const box=document.getElementById('sveQr');if(box)box.innerHTML=_svQrHtml();return;}
  _svListRender();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━ 편집기 ━━━━━━━━━━━━━━━━━━━━━━━━━
const SV_CHOICE_T={checkbox:true,radio:true,dropdown:true};
const SV_SHAPE={checkbox:'choice',radio:'choice',dropdown:'choice',short:'text',long:'text'};
// 무작위 8자(영문 소문자·숫자) — 새 설문 주소 기본값·질문 ID
function _svRandSlug(){let r='';while(r.length<8)r+=Math.random().toString(36).slice(2);return r.slice(0,8);}
function _svNewQid(){
  const taken={};((_SV.ed&&_SV.ed.s.questions)||[]).concat((_SV.ed&&_SV.ed.archived)||[]).forEach(q=>{taken[q.id]=true;});
  for(;;){const id='q_'+_svRandSlug();if(!taken[id])return id;}
}
function _svNewQuestion(type){
  const q={id:_svNewQid(),type,title:'',desc:'',required:false};
  if(type==='notice')q.blocks=[];
  if(type==='consent')Object.assign(q,{title:'개인정보 수집·이용 동의',required:true},SurveyKit.CONSENT_DEFAULT);
  if(type==='file')Object.assign(q,{title:'사진 첨부',maxFiles:3,maxMB:10});
  if(SV_CHOICE_T[type])Object.assign(q,{options:['보기 1','보기 2'],allowOther:false},type==='dropdown'?{}:{style:'list'});
  if(type==='name')q.title='성함';
  if(type==='phone')q.title='연락처';
  if(type==='address')q.title='배송지';
  if(type==='scale')Object.assign(q,{minLabel:'전혀 아니다',maxLabel:'매우 그렇다'});
  return q;
}
function _sveBlank(){
  return{id:'',title:'',slug:'',status:'초안',startAt:'',endAt:'',limit:'',retentionDays:90,thanks:'참여해주셔서 감사합니다.',notice:[],questions:[],oldSlugs:[],updatedAt:'',publishedAt:''};
}
async function _sveOpen(id){
  // 다른 메뉴에 갔다 온 같은 설문 — 저장하지 않은 편집을 이어서
  if(_SV.ed&&(_SV.ed.s.id||'')===id&&_SV.ed.dirty){_sveRender();return;}
  _svUnmountNotes();
  _SV.ed={s:_sveBlank(),archived:[],answered:{},responses:0,base:'',dirty:false,saving:false,loading:!!id,err:'',slugErr:'',prevSlug:''};
  _sveRender();
  if(!_SV.list)_svCall('survey_list').then(j=>{_SV.list=j.items;_SV.base=j.publicBase||_SV.base;}).catch(()=>{});
  if(!id){_SV.ed.s.slug=_svRandSlug();_sveRender();return;}
  try{
    const j=await _svCall('survey_get',{id});
    _SV.base=j.publicBase||_SV.base;
    _sveLoad(j);
  }catch(e){_SV.ed.loadErr=e.message;}
  _SV.ed.loading=false;
  _sveRender();
}
function _sveLoad(j){
  const s=JSON.parse(JSON.stringify(j.survey));
  _SV.ed.archived=(s.questions||[]).filter(q=>q.deleted);
  s.questions=(s.questions||[]).filter(q=>!q.deleted);
  s.startAt=_svDt(s.startAt);s.endAt=_svDt(s.endAt);
  _SV.ed.s=s;_SV.ed.answered=j.answered||_SV.ed.answered||{};_SV.ed.responses=j.responses!=null?j.responses:_SV.ed.responses;
  _SV.ed.prevSlug=s.slug;_SV.ed.dirty=false;
}
function _sveDirty(){
  if(!_SV.ed)return;
  if(!_SV.ed.dirty){_SV.ed.dirty=true;const d=document.getElementById('sveDirty');if(d)d.style.display='';}
  _svePreviewSoon();
}
function _sveRender(){
  const host=document.getElementById('page-admin-surveys'),ed=_SV.ed;
  if(!host||!ed)return;
  _svUnmountNotes();
  if(ed.loading){host.innerHTML='<div class="card"><div class="sva-empty">설문을 불러오는 중…</div></div>';return;}
  if(ed.loadErr){
    host.innerHTML=`<div class="card"><div class="card-hd">설문</div><div class="up-err">${_escHtml(ed.loadErr)}</div><button type="button" class="btn-cancel" onclick="_svGo('')">← 목록</button></div>`;return;
  }
  const s=ed.s;
  host.innerHTML=`<div class="sva-ed" id="sveRoot">
    <div class="sva-topbar">
      <button type="button" class="btn-cancel" onclick="_svGo('')">← 목록</button>
      <div class="sva-top-title">${_escHtml(s.id?(s.title||'제목 없음'):'새 설문')}</div>
      ${s.id?_svStatusBadge(s.status,null):''}
      <div class="sva-top-r">
        <span class="sva-dirty" id="sveDirty" style="${ed.dirty?'':'display:none'}">저장하지 않은 변경</span>
        ${s.id?`<button type="button" class="btn-cancel sva-btn" onclick="_svCopy('${_escHtml(_svUrl(ed.prevSlug||s.slug))}')">링크 복사</button>
          <button type="button" class="btn-cancel sva-btn" onclick="_svQrOpen('${_escHtml(s.id)}')">QR</button>
          <button type="button" class="btn-cancel sva-btn" onclick="_svGo('${_escHtml(s.id)}/results')">결과 ${Number(ed.responses||0).toLocaleString('ko-KR')}건</button>`:''}
        <button type="button" class="btn-primary" id="sveSaveBtn" onclick="_sveSave()" ${ed.saving?'disabled':''}>${ed.saving?'저장 중…':'저장'}</button>
      </div>
    </div>
    ${ed.err?`<div class="up-err">${_escHtml(ed.err)}</div>`:''}
    <div class="sva-cols">
      <div class="sva-mainc">
        ${_sveSettingsHtml()}
        <div class="card"><div class="card-hd">상단 안내문<span class="card-hd-r">굵게·기울임·밑줄은 글자를 선택하면 나오는 도구 · 이모지는 ':' 입력 · '/'로 제목·목록</span></div>
          <div class="sva-note" id="sveNote_top"></div></div>
        <div id="sveQs">${_sveQsHtml()}</div>
        ${ed.archived.length?`<div class="sva-archived">보관된 질문 ${ed.archived.length}개 — 응답이 있어 삭제 후에도 결과·엑셀에 '(삭제된 질문)' 열로 남습니다: ${ed.archived.map(q=>_escHtml(q.title||q.id)).join(', ')}</div>`:''}
        <div class="card sva-add"><div class="card-hd">＋ 질문 추가</div><div class="sva-types">${SurveyKit.TYPES.map(t=>`<button type="button" class="sva-type" onclick="_sveAdd('${t.type}')"><span>${t.icon}</span>${_escHtml(t.label)}</button>`).join('')}</div></div>
      </div>
      <div class="sva-side"><div class="sva-phone"><div class="sva-phone-hd">미리보기 · 모바일 폭(375px)</div><div class="sva-phone-body svf-preview" id="svePreview"></div></div></div>
    </div>
    <div id="sveQr">${_svQrHtml()}</div>
  </div>`;
  _sveMountNotes();
  _svePreviewNow();
}
function _sveSlugMsgHtml(){
  const ed=_SV.ed,s=ed.s,moved=s.id&&s.publishedAt&&ed.prevSlug&&s.slug!==ed.prevSlug;
  return (ed.slugErr?`<div class="sva-slug-err">${_escHtml(ed.slugErr)}</div>`:'')+
    (moved?`<div class="sva-moved">⚠ 이미 배포한 링크·QR 은 이전 주소(/s/${_escHtml(ed.prevSlug)})로 남아 있습니다(자동 이동됨). 저장하면 이전 주소 이력에 남습니다.</div>`:'');
}
function _sveSettingsHtml(){
  const ed=_SV.ed,s=ed.s;
  const due=_svPurgeDue(s);
  return `<div class="card sva-set"><div class="card-hd">기본 정보</div>
    <div class="sva-grid">
      <label class="f-grp sva-span2"><span class="f-lbl">제목</span><input class="f-inp" data-f="title" maxlength="200" value="${_escHtml(s.title)}" placeholder="예: [미닉스X이마트] 10월 사은품 이벤트"></label>
      <div class="f-grp sva-span2"><span class="f-lbl">설문 주소 <span class="sva-muted">영문 소문자·숫자·하이픈 3~40자</span></span>
        <div class="sva-slug-row"><span class="sva-slug-pre" title="${_escHtml((_SV.base||'')+'/s/')}">${_escHtml(String(_SV.base||'').replace(/^https?:\/\//,'')+'/s/')}</span><input class="f-inp" data-f="slug" maxlength="40" value="${_escHtml(s.slug)}" spellcheck="false" autocomplete="off">
          <button type="button" class="btn-cancel sva-btn" onclick="_sveRandomSlug()">무작위</button></div>
        <div class="sva-slug-msg" id="sveSlugMsg">${_sveSlugMsgHtml()}</div>
        ${(s.oldSlugs||[]).length?`<div class="sva-sub">이전 주소(자동 이동): ${s.oldSlugs.map(x=>'/s/'+_escHtml(x)).join(', ')}</div>`:''}</div>
      <div class="f-grp"><span class="f-lbl">상태</span><div class="sva-seg">${['초안','게시','마감'].map(x=>`<label class="sva-seg-i${s.status===x?' on':''}"><input type="radio" name="sveStatus" data-f="status" value="${x}" ${s.status===x?'checked':''}>${x}</label>`).join('')}</div>
        <span class="sva-sub">게시이고 기간 안일 때만 응답을 받습니다</span></div>
      <label class="f-grp"><span class="f-lbl">응답 수 제한 <span class="sva-muted">비우면 제한 없음</span></span><input class="f-inp" type="number" min="1" data-f="limit" value="${_escHtml(s.limit)}" placeholder="제한 없음"></label>
      <label class="f-grp"><span class="f-lbl">시작일시 <span class="sva-muted">비우면 게시 즉시</span></span><input class="f-inp" type="datetime-local" data-f="startAt" value="${_escHtml(String(s.startAt||'').replace(' ','T'))}"></label>
      <label class="f-grp"><span class="f-lbl">마감일시 <span class="sva-muted">비우면 직접 마감할 때까지</span></span><input class="f-inp" type="datetime-local" data-f="endAt" value="${_escHtml(String(s.endAt||'').replace(' ','T'))}"></label>
      <label class="f-grp"><span class="f-lbl">개인정보 보유기간(일) <span class="sva-muted">마감 후</span></span><input class="f-inp" type="number" min="1" max="3650" data-f="retentionDays" value="${_escHtml(s.retentionDays)}"></label>
      <div class="f-grp"><span class="f-lbl">개인정보 삭제 예정일</span><div class="sva-due" id="sveDue">${due?_escHtml(due)+' <span class="sva-muted">— 이름·연락처·주소·영수증 삭제, 선택형 답만 남김</span>':'<span class="sva-muted">마감(마감일시 또는 마감 처리) 후 '+_escHtml(s.retentionDays||90)+'일</span>'}</div></div>
      <label class="f-grp sva-span2"><span class="f-lbl">감사 문구 <span class="sva-muted">제출 완료 화면</span></span><textarea class="f-inp" rows="2" data-f="thanks" maxlength="500">${_escHtml(s.thanks)}</textarea></label>
    </div></div>`;
}
function _sveQsHtml(){
  const qs=_SV.ed.s.questions;
  if(!qs.length)return '<div class="card sva-empty">질문이 없습니다 — 아래 [＋ 질문 추가]에서 유형을 고르세요.</div>';
  return qs.map((q,i)=>_sveQHtml(q,i,qs.length)).join('');
}
function _sveQHtml(q,i,n){
  const ans=_SV.ed.answered[q.id]||0,t=q.type;
  const typeSel=`<select class="f-inp f-sel sva-tsel" data-qf="type">${SurveyKit.TYPES.map(x=>`<option value="${x.type}" ${x.type===t?'selected':''}>${x.icon} ${_escHtml(x.label)}</option>`).join('')}</select>`;
  let body='';
  if(t==='notice')body=`<div class="sva-note" id="sveNote_${_escHtml(q.id)}"></div>`;
  else if(t==='consent'){
    const f=(k,l,rows)=>`<label class="f-grp"><span class="f-lbl">${l}</span><textarea class="f-inp" rows="${rows}" data-qf="${k}" maxlength="1000">${_escHtml(q[k])}</textarea></label>`;
    body=`<div class="sva-grid">${f('items','수집 항목',2)}${f('purpose','이용 목적',2)}${f('period','보유 기간',2)}${f('refusal','거부 권리와 불이익',2)}
      <label class="f-grp sva-span2"><span class="f-lbl">동의 문구(체크박스, 항상 필수)</span><input class="f-inp" data-qf="agreeLabel" maxlength="200" value="${_escHtml(q.agreeLabel)}"></label></div>
      <button type="button" class="btn-cancel sva-btn" onclick="_sveConsentDefault(${i})">기본 문구로</button>
      <span class="sva-sub">보유 기간 문구는 위 '개인정보 보유기간(일)'과 맞춰 주세요.</span>`;
  }else if(t==='file'){
    body=`<div class="sva-inline"><label class="f-grp"><span class="f-lbl">최대 장수</span><input class="f-inp sva-n" type="number" min="1" max="10" data-qf="maxFiles" value="${_escHtml(q.maxFiles||3)}"></label>
      <label class="f-grp"><span class="f-lbl">원본 용량 상한(MB) <span class="sva-muted">줄일 수 없는 HEIC 등</span></span><input class="f-inp sva-n" type="number" min="1" max="10" data-qf="maxMB" value="${_escHtml(q.maxMB||10)}"></label></div>
      <div class="sva-sub">사진은 응답자 브라우저에서 긴 변 2000px·JPEG 품질 0.8로 줄여 올립니다(촬영 위치 등 메타데이터도 빠짐). 영수증 폴더는 공유 드라이브 구성원만 볼 수 있습니다.</div>`;
  }else if(SV_CHOICE_T[t]){
    body=`<label class="f-grp"><span class="f-lbl">보기 <span class="sva-muted">한 줄에 하나${ans?' · 응답이 있는 보기 이름을 바꾸면 기존 응답은 옛 이름으로 집계됩니다':''}</span></span>
      <textarea class="f-inp sva-opts" rows="${Math.min(10,Math.max(3,(q.options||[]).length+1))}" data-qf="optionsText">${_escHtml((q.options||[]).join('\n'))}</textarea></label>
      <div class="sva-inline"><label class="sva-chk"><input type="checkbox" data-qf="allowOther" ${q.allowOther?'checked':''}> '기타(직접 입력)' 보기 추가</label>
      ${t!=='dropdown'?`<label class="sva-chk">모양 <select class="f-inp f-sel sva-small" data-qf="style"><option value="list" ${q.style!=='chips'?'selected':''}>목록</option><option value="chips" ${q.style==='chips'?'selected':''}>칩</option></select></label>`:''}</div>`;
  }else if(t==='scale'){
    body=`<div class="sva-inline"><label class="f-grp"><span class="f-lbl">1점 설명</span><input class="f-inp" data-qf="minLabel" maxlength="50" value="${_escHtml(q.minLabel)}"></label>
      <label class="f-grp"><span class="f-lbl">5점 설명</span><input class="f-inp" data-qf="maxLabel" maxlength="50" value="${_escHtml(q.maxLabel)}"></label></div>`;
  }else if(t==='phone')body='<div class="sva-sub">010-0000-0000 형식 검증·자동 하이픈. 설문의 첫 전화번호 질문으로 중복 응답을 표시합니다.</div>';
  else if(t==='address')body='<div class="sva-sub">카카오 우편번호 검색 → 우편번호·기본주소 자동 입력 + 상세주소(필수일 때 세 칸 모두 필요).</div>';
  return `<div class="card sva-q" data-qi="${i}" ondragover="_sveDragOver(event,${i})" ondrop="_sveDrop(event,${i})" ondragleave="_sveDragLeave(event)">
    <div class="sva-q-hd">
      <span class="sva-handle" draggable="true" ondragstart="_sveDragStart(event,${i})" ondragend="_sveDragEnd()" title="끌어서 순서 바꾸기">⋮⋮</span>
      <span class="sva-qno">${i+1}</span>${typeSel}
      ${t!=='notice'&&t!=='consent'?`<label class="sva-chk sva-req"><input type="checkbox" data-qf="required" ${q.required?'checked':''}> 필수</label>`:t==='consent'?'<span class="sva-sub">항상 필수</span>':''}
      ${ans?`<span class="sva-ans" title="이 질문의 답변 수">응답 ${ans}건</span>`:''}
      <span class="sva-q-acts">
        <button type="button" class="sva-ib" onclick="_sveMove(${i},-1)" ${i===0?'disabled':''} title="위로">↑</button>
        <button type="button" class="sva-ib" onclick="_sveMove(${i},1)" ${i===n-1?'disabled':''} title="아래로">↓</button>
        <button type="button" class="sva-ib" onclick="_sveDup(${i})" title="복제">⧉</button>
        <button type="button" class="sva-ib sva-del" onclick="_sveDel(${i})" title="삭제">🗑</button></span>
    </div>
    <div class="sva-q-body">
      <input class="f-inp sva-qtitle" data-qf="title" maxlength="300" value="${_escHtml(q.title)}" placeholder="${t==='notice'?'안내문 제목(선택)':'질문'}">
      ${t!=='notice'?`<input class="f-inp sva-qdesc" data-qf="desc" maxlength="1000" value="${_escHtml(q.desc)}" placeholder="설명(선택)">`:''}
      ${body}
    </div></div>`;
}
// 입력 위임 — 글자를 칠 때마다 전체를 다시 그리지 않는다(포커스 유지). 구조가 바뀌는 것(유형·보기 모양)만 다시 그린다
function _svBindEditor(host){
  const onField=(e)=>{
    const el=e.target,ed=_SV.ed;
    if(!ed||!document.getElementById('sveRoot')||!host.contains(el))return;
    if(el.dataset.f){
      const k=el.dataset.f,s=ed.s;
      let v=el.type==='checkbox'?el.checked:el.value;
      if(k==='startAt'||k==='endAt')v=String(v||'').replace('T',' ');
      if(k==='slug'){v=String(v).toLowerCase();if(el.value!==v)el.value=v;}
      s[k]=v;
      if(k==='slug'){ed.slugErr=_sveSlugError(v);const m=document.getElementById('sveSlugMsg');if(m)m.innerHTML=_sveSlugMsgHtml();}
      if(k==='status'||k==='endAt'||k==='retentionDays'){const d=document.getElementById('sveDue');if(d){const due=_svPurgeDue(s);d.innerHTML=due?_escHtml(due)+' <span class="sva-muted">— 이름·연락처·주소·영수증 삭제, 선택형 답만 남김</span>':'<span class="sva-muted">마감(마감일시 또는 마감 처리) 후 '+_escHtml(s.retentionDays||90)+'일</span>';}
        if(k==='status')document.querySelectorAll('.sva-seg-i').forEach(x=>x.classList.toggle('on',x.querySelector('input').checked));}
      _sveDirty();return;
    }
    if(el.dataset.qf){
      const card=el.closest('.sva-q'),i=Number(card&&card.dataset.qi),q=ed.s.questions[i];
      if(!q)return;
      const k=el.dataset.qf;
      if(k==='type'){if(e.type==='change')_sveChangeType(i,el.value);return;}
      if(k==='optionsText')q.options=el.value.split('\n').map(x=>x.trim()).filter(Boolean);
      else if(k==='required'||k==='allowOther')q[k]=el.checked;
      else if(k==='maxFiles'||k==='maxMB')q[k]=Math.max(1,Math.min(10,Number(el.value)||(k==='maxFiles'?3:10)));
      else q[k]=el.value;
      _sveDirty();
    }
  };
  host.addEventListener('input',onField);
  host.addEventListener('change',e=>{const el=e.target;if(el.dataset&&(el.dataset.qf==='type'||el.type==='checkbox'||el.type==='radio'||el.tagName==='SELECT'))onField(e);});
}
function _sveSlugError(v){
  if(!/^[a-z0-9-]{3,40}$/.test(v))return '영문 소문자·숫자·하이픈(-) 3~40자로 정해주세요.';
  const taken=(_SV.list||[]).find(o=>o.id!==_SV.ed.s.id&&(o.slug===v||(o.oldSlugs||[]).indexOf(v)>=0));
  if(taken)return `'${v}'는 다른 설문(${taken.title})이 쓰고 있거나 쓰던 주소입니다.`;
  return '';
}
function _sveRandomSlug(){
  const s=_SV.ed.s;s.slug=_svRandSlug();_SV.ed.slugErr=_sveSlugError(s.slug);_sveDirty();
  const i=document.querySelector('[data-f="slug"]');if(i)i.value=s.slug;
  const m=document.getElementById('sveSlugMsg');if(m)m.innerHTML=_sveSlugMsgHtml();
}
function _sveRerenderQs(){
  _svUnmountNotes();
  const box=document.getElementById('sveQs');
  if(box)box.innerHTML=_sveQsHtml();
  _sveMountNotes();
  _sveDirty();
}
function _sveAdd(type){
  _SV.ed.s.questions.push(_svNewQuestion(type));
  _sveRerenderQs();
  const cards=document.querySelectorAll('.sva-q');
  const last=cards[cards.length-1];
  if(last&&last.scrollIntoView)last.scrollIntoView({behavior:'smooth',block:'center'});
}
function _sveMove(i,d){
  const qs=_SV.ed.s.questions,j=i+d;
  if(j<0||j>=qs.length)return;
  [qs[i],qs[j]]=[qs[j],qs[i]];
  _sveRerenderQs();
}
function _sveDup(i){
  const qs=_SV.ed.s.questions,c=JSON.parse(JSON.stringify(qs[i]));
  c.id=_svNewQid();if(c.title)c.title+=' (복사)';
  qs.splice(i+1,0,c);
  _sveRerenderQs();
}
function _sveDel(i){
  const q=_SV.ed.s.questions[i],ans=_SV.ed.answered[q.id]||0;
  const msg=ans?`'${q.title||'이 질문'}'에 응답 ${ans}건이 있습니다.\n삭제해도 기존 답변은 결과·엑셀에 '(삭제된 질문)' 열로 남습니다. 삭제할까요?`:`'${q.title||SurveyKit.TYPE_LABEL[q.type]}' 질문을 삭제할까요?`;
  if(!confirm(msg))return;
  _SV.ed.s.questions.splice(i,1);
  _sveRerenderQs();
}
function _sveChangeType(i,type){
  const q=_SV.ed.s.questions[i],ans=_SV.ed.answered[q.id]||0;
  if(type===q.type)return;
  if(ans){
    const same=SV_SHAPE[q.type]&&SV_SHAPE[q.type]===SV_SHAPE[type];
    const msg=same?`이 질문에 응답 ${ans}건이 있습니다. 유형을 바꿔도 기존 답변은 그대로 이 질문에 남습니다. 바꿀까요?`
      :`이 질문에 응답 ${ans}건이 있습니다. 답 형식이 다른 유형으로 바꾸면 기존 답변은 결과·엑셀에 '(삭제된 질문)' 열로 따로 남고, 저장하면 새 질문이 됩니다. 바꿀까요?`;
    if(!confirm(msg)){_sveRerenderQs();return;}
  }
  const n=_svNewQuestion(type);
  n.id=q.id;
  if(type!=='notice'&&q.title&&!(q.type==='consent'))n.title=q.title;
  n.desc=q.desc||'';n.required=type==='consent'?true:!!q.required&&type!=='notice';
  if(SV_CHOICE_T[type]&&SV_CHOICE_T[q.type]){n.options=(q.options||[]).slice();n.allowOther=!!q.allowOther;if(type!=='dropdown')n.style=q.style||'list';}
  _SV.ed.s.questions[i]=n;
  _sveRerenderQs();
}
function _sveConsentDefault(i){
  Object.assign(_SV.ed.s.questions[i],SurveyKit.CONSENT_DEFAULT);
  _sveRerenderQs();
}
// 끌어서 순서 바꾸기 — 손잡이(⋮⋮)를 끌어 다른 질문 카드 위/아래에 놓는다
function _sveDragStart(e,i){_SV.drag=i;try{e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(i));}catch(x){}}
function _sveDragOver(e,i){
  if(_SV.drag==null)return;
  e.preventDefault();
  const card=e.currentTarget,r=card.getBoundingClientRect(),after=e.clientY>r.top+r.height/2;
  card.classList.toggle('sva-drop-before',!after);card.classList.toggle('sva-drop-after',after);
}
function _sveDragLeave(e){e.currentTarget.classList.remove('sva-drop-before','sva-drop-after');}
function _sveDrop(e,i){
  e.preventDefault();
  const from=_SV.drag,card=e.currentTarget,after=card.classList.contains('sva-drop-after');
  card.classList.remove('sva-drop-before','sva-drop-after');
  _SV.drag=null;
  if(from==null)return;
  const qs=_SV.ed.s.questions,[m]=qs.splice(from,1);
  let to=i+(after?1:0);if(from<to)to--;
  qs.splice(to,0,m);
  if(to!==from)_sveRerenderQs();
}
function _sveDragEnd(){_SV.drag=null;document.querySelectorAll('.sva-q').forEach(c=>c.classList.remove('sva-drop-before','sva-drop-after'));}

// ── 안내문 편집기(BlockNote) — 회고 번들이 아직 안 왔으면 올 때까지 기다린다(5MB defer 스크립트) ──
function _svUnmountNotes(){
  Object.keys(_SV.notes).forEach(k=>{try{_SV.notes[k].unmount();}catch(e){}});
  _SV.notes={};
}
function _sveMountNotes(tries){
  const ed=_SV.ed;
  if(!ed||!document.getElementById('sveRoot'))return;
  const targets=[{key:'top',get:()=>ed.s.notice,set:v=>{ed.s.notice=v;}}]
    .concat(ed.s.questions.filter(q=>q.type==='notice').map(q=>({key:q.id,get:()=>q.blocks,set:v=>{q.blocks=v;}})));
  if(!window.ReviewApp||!window.ReviewApp.mountSurveyNote){
    const failed=typeof _reviewBundleState!=='undefined'&&_reviewBundleState==='failed';
    targets.forEach(t=>{
      const el=document.getElementById('sveNote_'+t.key);
      if(el)el.innerHTML=failed?`<div class="up-err">안내문 편집기를 불러오지 못했습니다 — 새로고침해주세요. (저장된 안내문은 그대로입니다)</div><div class="svf-blocks sva-note-ro">${SurveyKit.blocksHtml(t.get())}</div>`
        :'<div class="sva-empty">안내문 편집기를 불러오는 중…</div>';
    });
    if(!failed&&(tries||0)<60)setTimeout(()=>_sveMountNotes((tries||0)+1),500);
    return;
  }
  targets.forEach(t=>{
    const el=document.getElementById('sveNote_'+t.key);
    if(!el||_SV.notes[t.key])return;
    el.innerHTML='';
    try{
      _SV.notes[t.key]=window.ReviewApp.mountSurveyNote(el,{initialBlocks:t.get(),onChange:blocks=>{t.set(SurveyKit.compactBlocks(blocks));_sveDirty();}});
    }catch(err){
      console.error('[설문] 안내문 편집기 마운트 실패:',err);
      el.innerHTML=`<div class="up-err">안내문 편집기를 열지 못했습니다: ${_escHtml(err.message)}</div>`;
    }
  });
}

// ── 미리보기 — 응답 페이지와 같은 코드(SurveyKit.mountForm)로 그린다. 제출만 막는다 ──
function _svePreviewSoon(){clearTimeout(_SV.previewTimer);_SV.previewTimer=setTimeout(_svePreviewNow,350);}
function _svePreviewNow(){
  const el=document.getElementById('svePreview'),ed=_SV.ed;
  if(!el||!ed)return;
  const s=ed.s;
  try{SurveyKit.mountForm(el,{title:s.title||'(제목 없음)',notice:s.notice,questions:s.questions},{preview:true,uid:'svp'});}
  catch(e){el.innerHTML=`<div class="up-err">미리보기를 그리지 못했습니다: ${_escHtml(e.message)}</div>`;}
}

// ── 저장 ──
function _sveCheck(){
  const s=_SV.ed.s,errs=[];
  if(!String(s.title||'').trim())errs.push('제목을 입력해주세요.');
  const se=_sveSlugError(s.slug);if(se)errs.push('설문 주소: '+se);
  s.questions.forEach((q,i)=>{
    const no=(i+1)+'번 질문';
    if(q.type!=='notice'&&!String(q.title||'').trim())errs.push(no+': 질문을 입력해주세요.');
    if(SV_CHOICE_T[q.type]){
      if(!(q.options||[]).length)errs.push(no+': 보기를 하나 이상 입력해주세요.');
      const seen={};(q.options||[]).forEach(o=>{if(seen[o])errs.push(no+`: 보기 '${o}'가 두 번 있습니다.`);seen[o]=true;});
    }
  });
  if(s.startAt&&s.endAt&&s.endAt<=s.startAt)errs.push('마감일시는 시작일시보다 뒤여야 합니다.');
  if(s.status==='게시'&&!s.questions.some(q=>q.type!=='notice'))errs.push('질문이 하나도 없는 설문은 게시할 수 없습니다.');
  const hasPii=s.questions.some(q=>SurveyKit.PII[q.type]||q.type==='file'),hasConsent=s.questions.some(q=>q.type==='consent');
  return {errs,warn:hasPii&&!hasConsent?'이름·연락처·주소·사진을 받는데 개인정보 수집·이용 동의 질문이 없습니다.':''};
}
async function _sveSave(force){
  const ed=_SV.ed;
  if(!ed||ed.saving)return;
  const chk=_sveCheck();
  if(chk.errs.length){showToast(chk.errs[0],{type:'error'});ed.err=chk.errs.join('\n');_sveShowErr();return;}
  if(chk.warn&&!force&&!confirm(chk.warn+'\n그래도 저장할까요?'))return;
  const s=ed.s;
  if(s.id&&s.publishedAt&&ed.prevSlug&&s.slug!==ed.prevSlug&&!confirm(`설문 주소를 /s/${ed.prevSlug} → /s/${s.slug} 로 바꿉니다.\n이미 배포한 링크·QR 은 이전 주소로 남아 있고, 접속하면 새 주소로 자동 이동합니다. 저장할까요?`))return;
  ed.saving=true;ed.err='';_sveSaveBtn();
  const payload={survey:{id:s.id||'',title:s.title,slug:s.slug,status:s.status,startAt:s.startAt,endAt:s.endAt,limit:s.limit===''||s.limit==null?'':Number(s.limit),
    retentionDays:Number(s.retentionDays)||90,thanks:s.thanks,notice:SurveyKit.compactBlocks(s.notice),questions:s.questions},baseUpdatedAt:s.id?s.updatedAt:undefined,force:force===true};
  try{
    const j=await _svCall('survey_save',payload);
    const wasNew=!s.id;
    _SV.base=j.survey.publicUrl?j.survey.publicUrl.replace(/\/s\/[^/]+$/,''):_SV.base;
    _sveLoad({survey:j.survey,answered:j.answered,responses:ed.responses});
    ed.saving=false;
    showToast(j.movedFrom?`저장했습니다 — 이전 주소 /s/${j.movedFrom}로 들어오면 /s/${j.survey.slug}로 이동합니다.`:'저장했습니다.',{type:'success'});
    _SV.list=null;
    if(wasNew){_SV.ed.dirty=false;navPage('admin-surveys',_findPageEl('admin-surveys'),j.survey.id);return;}
    _sveRender();
  }catch(e){
    ed.saving=false;
    if(e.code==='CONFLICT'){
      if(confirm(e.message+'\n\n내 편집 내용으로 덮어쓸까요? (취소하면 저장하지 않습니다 — 새로고침하면 상대의 수정본을 볼 수 있습니다)')){_sveSave(true);return;}
    }else if(e.code==='SLUG'){ed.slugErr=e.message;const m=document.getElementById('sveSlugMsg');if(m)m.innerHTML=_sveSlugMsgHtml();}
    ed.err=e.message;_sveShowErr();_sveSaveBtn();
    showToast('저장 실패: '+e.message,{type:'error'});
  }
}
function _sveSaveBtn(){const b=document.getElementById('sveSaveBtn');if(b){b.disabled=!!_SV.ed.saving;b.textContent=_SV.ed.saving?'저장 중…':'저장';}}
function _sveShowErr(){
  const root=document.getElementById('sveRoot');
  if(!root)return;
  let box=root.querySelector(':scope > .up-err');
  if(!box){box=document.createElement('div');box.className='up-err';root.insertBefore(box,root.children[1]);}
  box.textContent=_SV.ed.err||'';box.style.display=_SV.ed.err?'':'none';
}
