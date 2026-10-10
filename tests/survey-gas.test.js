/* 설문 GAS(apps-script-survey.js) — 저장소·공개 액션·관리 액션·보유기간. apps-script.js doPost를 실코드 그대로 거친다.

   지키려는 성질:
     · survey_setup: 공유 드라이브 설문 폴더 안에 스프레드시트(탭 4개·텍스트 서식)·영수증 폴더 — supportsAllDrives·includeItemsFromAllDrives·corpora drive,
       HMAC 키·설정 탭 설문_공개기본주소·초기 설문(emart-oct 초안)은 없을 때만. 다시 실행해도 그대로
     · 공개 액션은 survey_getPublic·survey_submit 두 이름뿐 — 나머지 survey_*는 세션 없이 AUTH_REQUIRED(시트·드라이브에 닿기 전)
     · getPublic: 초안·없는 주소는 똑같이 closed, 기간 밖은 closed(+제목), 표시용 정보만, 이전 주소 → 지금 주소
     · submit: 필수·형식·보기·동의·주소, 함정 칸·최소 시간(서명 토큰)·분당 제한·응답 수 제한·마감, 같은 제출 키는 한 번만,
       사진은 앞 바이트로 형식 판정·장수·용량, 영수증 폴더에 비공개 저장(공유 호출 없음·파일명에 개인정보 없음), 중복키는 HMAC
     · 관리: 목록·링크(설정 탭 기본 주소)·주소 규칙(형식·중복·이전 주소)·이력, 동시 수정 충돌, 질문 ID 유지·삭제 질문 보관·유형 변경, 복제
     · 결과: 이름·연락처·주소 마스킹, [개인정보 보기]·[엑셀] 기록, 처리상태·반려 사유·메모, 영수증은 그 설문 첨부만
     · 보유기간: 마감 + N일이 지나면 개인정보·영수증 삭제, 선택형만 남김, 기록, 다시 돌려도 그대로. 트리거 설치
     · Sheets API(대시보드와 같이 쓰는 한도)를 쓰지 않는다 · 로그에 응답 내용이 남지 않는다 · 수식 주입 막기

   실행: node tests/survey-gas.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadOfflineGas, dataRows, installDrive, installScriptApp, makeOfflineSS } = require(path.join(__dirname, 'lib', 'offline-gas.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 600) : '')); }
}

const SHEET = 'application/vnd.google-apps.spreadsheet';
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(2000, 7)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(500, 1)]);
const PDF = Buffer.from('%PDF-1.4 not an image at all');
const b64 = b => b.toString('base64');

// 이 파일의 모든 env는 같은 global을 쓴다 — 한 env의 확인을 다 끝낸 뒤 다음 env를 만든다(memory: offline-gas-test-globals)
function env(opts) {
  opts = opts || {};
  const g = loadOfflineGas({ setup: true });
  g.d = installDrive();
  g.triggers = installScriptApp();
  g.d.add({ id: 'SURVEY-FOLDER', name: '설문', mimeType: g.d.FOLDER, parents: ['SHARED-ROOT'] });
  if (!opts.noFolder) g.scriptProps.SURVEY_FOLDER_ID = 'SURVEY-FOLDER';
  const books = {};
  const open0 = g.ctx.SpreadsheetApp.openById;
  g.ctx.SpreadsheetApp.openById = id => {
    const f = g.d.files[id];
    if (f && f.mimeType === SHEET) {
      if (!books[id]) { books[id] = makeOfflineSS(); books[id].deleteSheet = sh => { delete books[id]._sheets[sh.getName()]; books[id]._order.splice(books[id]._order.indexOf(sh.getName()), 1); }; }
      return books[id];
    }
    return open0(id);
  };
  g.books = books;
  g.logs = [];
  g.ctx.Logger = { log: s => g.logs.push(String(s)) };
  const ss = g.ctx.SpreadsheetApp.getActiveSpreadsheet();
  g.session = email => {
    const sheet = g.ctx._sessionSheet(ss), now = Date.now(), sid = 'sid-' + Math.random().toString(36).slice(2);
    sheet.appendRow([sid, email, '담당자', now, now + 3600e3 * 12, now]);
    return g.ctx._signSessionToken({ sid, email, name: '담당자', exp: now + 3600e3 * 12, iat: now, kv: 1 });
  };
  g.post = body => JSON.parse(g.ctx.doPost({ postData: { contents: JSON.stringify(body) }, parameter: {} }));
  const token = g.session('staff@athomecorp.com');
  g.call = (action, data) => g.post({ action, session: token, data });
  g.pub = (action, data) => g.post({ action, data });
  g.book = () => books[g.scriptProps.SURVEY_SHEET_ID];
  g.rows = tab => dataRows(g.book().getSheetByName(tab));
  g.kst = ms => g.ctx._svNowStr(ms).slice(0, 16);
  g.token = (id, agoMs) => g.ctx._svFormToken(id, Date.now() - (agoMs == null ? 10000 : agoMs));
  if (!opts.noSetup) g.setup = g.ctx.survey_setup();
  return g;
}
// emart-oct를 게시하고 { id, survey } — 날짜는 비워 둔 채(기간 제한 없음)
function publishEmart(g) {
  const list = g.call('survey_list', {});
  const it = list.items.find(x => x.slug === 'emart-oct');
  const r = g.call('survey_setStatus', { id: it.id, status: '게시' });
  return { id: it.id, survey: r.survey };
}
function goodAnswers(o) {
  return Object.assign({
    q_consent: true, q_model: { sel: ['더 플렌더 MAX'] }, q_reason: { sel: ['합리적인 가격', '이벤트·사은품'] }, q_known: { sel: [] },
    q_age: { sel: ['25-34'] }, q_house: { sel: [], other: '셰어하우스' }, q_name: '홍길동', q_phone: '01012345678',
    q_addr: { zip: '06236', addr1: '서울 강남구 테헤란로 123', addr2: '4층' }
  }, o || {});
}
function submit(g, id, over) {
  over = over || {};
  return g.pub('survey_submit', Object.assign({ surveyId: id, token: g.token(id), hp: '', sid: 'sid-' + Math.random().toString(36).slice(2),
    answers: goodAnswers(over.answers), files: [{ q: 'q_receipt', data: b64(JPEG) }] }, over.top || {}));
}

(async function main() {
  console.log('\n[1] survey_setup — 공유 드라이브 폴더 안에 스프레드시트·영수증 폴더, 설정 키, 초기 설문(멱등)');
  {
    const g0 = env({ noFolder: true, noSetup: true });
    let err = '';
    try { g0.ctx.survey_setup(); } catch (e) { err = e.message; }
    check('SURVEY_FOLDER_ID가 없으면 만들지 않고 안내', /SURVEY_FOLDER_ID/.test(err) && Object.keys(g0.books).length === 0, err);
  }
  {
    const g = env();
    const rep = g.setup;
    const ssFile = g.d.files[g.scriptProps.SURVEY_SHEET_ID], fFolder = g.d.files[g.scriptProps.SURVEY_FILES_FOLDER_ID];
    check('스프레드시트 "미닉스 설문 응답"이 설문 폴더 안에', ssFile && ssFile.name === '미닉스 설문 응답' && ssFile.mimeType === SHEET && ssFile.parents[0] === 'SURVEY-FOLDER', ssFile);
    check('하위 폴더 "영수증·첨부"가 설문 폴더 안에', fFolder && fFolder.name === '영수증·첨부' && fFolder.mimeType === g.d.FOLDER && fFolder.parents[0] === 'SURVEY-FOLDER', fFolder);
    check('  ↳ 공유 드라이브 인자(create·get에 supportsAllDrives — 목은 없으면 실패)', g.d.calls.filter(c => c.op === 'create').every(c => c.opt.supportsAllDrives === true));
    check('  ↳ 목록 조회는 includeItemsFromAllDrives·corpora drive·driveId', g.d.calls.filter(c => c.op === 'list').length >= 2 &&
      g.d.calls.filter(c => c.op === 'list').every(c => c.opt.includeItemsFromAllDrives && c.opt.corpora === 'drive' && c.opt.driveId === g.d.DRIVE_ID));
    const book = g.book();
    check('탭 4개(설문목록·응답·처리기록·다운로드로그)', ['설문목록', '응답', '처리기록', '다운로드로그'].every(n => book.getSheetByName(n)), book._order);
    check('  ↳ 설문목록 머리글', JSON.stringify(book.getSheetByName('설문목록')._grid[0].slice(0, 14)) === JSON.stringify(['설문ID', '주소', '이전주소', '제목', '상태', '시작일시', '마감일시', '응답수제한', '안내문', '질문목록', '감사문구', '개인정보보유기간(일)', '수정일', '수정자']));
    check('  ↳ 응답 머리글', JSON.stringify(book.getSheetByName('응답')._grid[0]) === JSON.stringify(['응답ID', '설문ID', '제출시각', '답변', '첨부파일ID', '중복키', '처리상태', '메모', '반려사유', '개인정보삭제일']));
    check('  ↳ 전 열 텍스트 서식(@)', ['설문목록', '응답', '처리기록', '다운로드로그'].every(n => book.getSheetByName(n)._formats.some(f => f.f === '@' && f.c === 1)));
    check('HMAC 키를 만들어 Script Properties에', rep.secret === 'created' && String(g.scriptProps.SURVEY_HASH_SECRET || '').length >= 20);
    const settings = dataRows(g.tab('설정'));
    const base = settings.filter(r => r[0] === '설문_공개기본주소');
    check('오프라인 설정 탭에 설문_공개기본주소 = 지금 서비스 주소', base.length === 1 && base[0][1] === 'https://minix-offlinepart-dashboard.onrender.com', base);
    const surveys = g.rows('설문목록');
    const s = g.ctx._svSurveyObj(surveys[0], 0);
    check('초기 설문: 제목·주소·초안', surveys.length === 1 && s.title === '[미닉스X이마트] 10월 사은품 이벤트' && s.slug === 'emart-oct' && s.status === '초안', [s.title, s.slug, s.status]);
    check('  ↳ 설문ID는 추측할 수 없는 무작위 문자열', /^sv_[0-9a-z]{20}$/.test(s.id), s.id);
    check('  ↳ 질문 10개 — 동의·영수증·제품·결정요인·인지·연령·가구·성함·연락처·배송지',
      JSON.stringify(s.questions.map(q => q.type)) === JSON.stringify(['consent', 'file', 'checkbox', 'checkbox', 'checkbox', 'radio', 'radio', 'name', 'phone', 'address']), s.questions.map(q => q.type));
    const byId = {}; s.questions.forEach(q => { byId[q.id] = q; });
    check('  ↳ 영수증 필수 1~3장, 제품 필수 3개 보기, 결정 요인·인지 칩 스타일',
      byId.q_receipt.required && byId.q_receipt.maxFiles === 3 && byId.q_model.required && byId.q_model.options.length === 3 &&
      byId.q_reason.style === 'chips' && byId.q_reason.options.length === 6 && byId.q_known.style === 'chips' && byId.q_known.options.length === 4);
    check('  ↳ 연령대·가구 형태는 기타(직접 입력)', byId.q_age.allowOther && byId.q_house.allowOther && byId.q_age.options.length === 5 && byId.q_house.options.length === 5);
    check('  ↳ 성함·연락처·배송지 필수', byId.q_name.required && byId.q_phone.required && byId.q_addr.required);
    check('  ↳ 동의 안내 표 기본 문구(수집 항목·목적·보유 기간·거부 권리)', byId.q_consent.required && byId.q_consent.items && byId.q_consent.purpose && byId.q_consent.period && byId.q_consent.refusal);
    check('  ↳ 감사 문구', s.thanks === '이벤트에 참여해주셔서 감사합니다 ❤️');
    const noticeText = JSON.stringify(s.notice);
    check('  ↳ 안내문: 하드락 필터·전국 지점·MAX·트레이더스 기간·참여 3단계·날짜 입력 필요 표시',
      ['리필전용 하드락 필터 1개(35,000원 상당)', '전국 지점', '더 플렌더 MAX', '10/1(목) ~ 10/31(토)', '구매 영수증 촬영', '영수증 사진 업로드', '성함·연락처·배송지 입력', '날짜 입력 필요'].every(t => noticeText.indexOf(t) >= 0));
    // 다시 실행
    const files0 = Object.keys(g.d.files).length;
    const rep2 = g.ctx.survey_setup();
    check('다시 실행: 파일을 새로 만들지 않음', Object.keys(g.d.files).length === files0 && rep2.spreadsheet.status === 'exists' && rep2.filesFolder.status === 'exists', rep2);
    check('  ↳ 탭은 확인만, 키·설정·초기 설문은 그대로', rep2.tabs.verified.length === 4 && rep2.secret === 'exists' && rep2.setting === 'exists' && rep2.seeded === 'exists' &&
      g.rows('설문목록').length === 1 && dataRows(g.tab('설정')).filter(r => r[0] === '설문_공개기본주소').length === 1, rep2);
    // Script Properties가 지워져도 폴더에서 이름으로 다시 찾는다
    delete g.scriptProps.SURVEY_SHEET_ID;
    const rep3 = g.ctx.survey_setup();
    check('ID를 잃어도 폴더에서 이름으로 찾음(새로 만들지 않음)', rep3.spreadsheet.status === 'found' && Object.keys(g.d.files).length === files0, rep3.spreadsheet);
  }

  console.log('\n[2] 라우팅·인증 — 공개는 두 이름뿐, 나머지는 세션 없이 거절(시트·드라이브에 닿기 전)');
  {
    const g = env();
    const before = g.d.calls.length, reads = JSON.stringify(g.book().getSheetByName('응답')._grid);
    ['survey_list', 'survey_get', 'survey_save', 'survey_setStatus', 'survey_duplicate', 'survey_responses', 'survey_revealPii', 'survey_export', 'survey_images', 'survey_updateResponses', 'survey_getPublicX', 'survey_submitX'].forEach(a => {
      const j = g.pub(a, { id: 'x' });
      check(a + ' 세션 없음 → AUTH_REQUIRED', j.error === 'AUTH_REQUIRED', j);
    });
    const forged = g.post({ action: 'survey_list', session: 'eyJzaWQiOiJ4In0.AAAA', data: {} });
    check('위조 세션 → AUTH_REQUIRED', forged.error === 'AUTH_REQUIRED', forged);
    check('  ↳ 거절 경로는 드라이브·응답 시트를 건드리지 않음', g.d.calls.length === before && JSON.stringify(g.book().getSheetByName('응답')._grid) === reads);
    const pubOk = g.pub('survey_getPublic', { slug: 'emart-oct' });
    check('survey_getPublic은 세션 없이 응답(초안이라 closed)', pubOk.success && pubOk.closed === true, pubOk);
    const viaGet = JSON.parse(g.ctx.doGet({ parameter: { action: 'survey_getPublic', payload: '{}' } }));
    check('GET으로는 공개 경로가 열리지 않음(AUTH_REQUIRED)', viaGet.error === 'AUTH_REQUIRED', viaGet);
    const listed = g.call('survey_list', {});
    check('세션이 있으면 survey_list', listed.success && listed.items.length === 1 && listed.items[0].slug === 'emart-oct', listed);
  }

  console.log('\n[3] survey_getPublic — 초안·없는 주소 = 같은 closed, 기간, 표시용 정보만, 이전 주소 → 지금 주소');
  {
    const g = env();
    const draft = g.pub('survey_getPublic', { slug: 'emart-oct' }), none = g.pub('survey_getPublic', { slug: 'no-such-survey' });
    const strip = j => { const o = Object.assign({}, j); delete o.execMs; return JSON.stringify(o); };
    check('초안과 없는 주소의 응답이 똑같음(존재를 드러내지 않음)', strip(draft) === strip(none) && draft.closed && !draft.title && !draft.survey, [draft, none]);
    const bad = g.pub('survey_getPublic', { slug: '../../etc' });
    check('주소 형식이 아니면 closed', bad.closed === true && !bad.survey);
    const { id } = publishEmart(g);
    const p = g.pub('survey_getPublic', { slug: 'emart-oct' });
    check('게시 → 설문 표시 정보 + 토큰', p.success && p.survey && p.survey.id === id && p.survey.title === '[미닉스X이마트] 10월 사은품 이벤트' && /^\d+\.[0-9a-f]{32}$/.test(p.token), p);
    check('  ↳ 관리 정보 없음(상태·수정자·제한·이전 주소·보유기간)', ['status', 'updatedBy', 'limit', 'oldSlugs', 'retentionDays', 'createdAt', 'publishedAt'].every(k => !(k in p.survey)), Object.keys(p.survey));
    check('  ↳ 질문·안내문·감사 문구', p.survey.questions.length === 10 && p.survey.notice.length > 5 && p.survey.thanks.indexOf('감사') >= 0);
    const byId = g.pub('survey_getPublic', { id });
    check('form.html?f=설문ID 형식(설문ID로 조회)', byId.survey && byId.survey.id === id);
    check('대문자로 와도 같은 주소', (g.pub('survey_getPublic', { slug: 'EMART-OCT' }).survey || {}).id === id);
    // 기간
    const sv = g.call('survey_get', { id }).survey;
    const save = (o) => g.call('survey_save', { survey: Object.assign({}, sv, o), baseUpdatedAt: g.call('survey_get', { id }).survey.updatedAt });
    let r = save({ startAt: g.kst(Date.now() + 86400000) });
    check('시작 전 저장', r.success, r);
    const early = g.pub('survey_getPublic', { slug: 'emart-oct' });
    check('시작 전 → closed(제목은 보여줌)', early.closed && early.title === sv.title && !early.survey && !early.token, early);
    r = save({ startAt: g.kst(Date.now() - 2 * 86400000), endAt: g.kst(Date.now() - 86400000) });
    check('마감일시가 지나면 closed', r.success && g.pub('survey_getPublic', { slug: 'emart-oct' }).closed === true);
    r = save({ startAt: '', endAt: g.kst(Date.now() + 86400000) });
    check('기간 안이면 다시 열림', !!g.pub('survey_getPublic', { slug: 'emart-oct' }).survey);
    // 주소 변경(게시 이후) → 이전 주소 이력
    r = save({ slug: 'emart-october' });
    check('게시 후 주소 변경 → movedFrom·이전주소 이력', r.success && r.movedFrom === 'emart-oct' && JSON.stringify(r.survey.oldSlugs) === '["emart-oct"]', r);
    const old = g.pub('survey_getPublic', { slug: 'emart-oct' });
    check('  ↳ 이전 주소로 오면 설문 + 지금 주소(slug)', old.survey && old.survey.id === id && old.slug === 'emart-october', old);
    check('  ↳ 처리기록에 이전 주소', g.rows('처리기록').some(x => x[4] === '설문 수정' && /이전 주소 emart-oct/.test(x[5])));
    // 초안 동안의 주소 변경은 이력을 남기지 않는다
    const nd = g.call('survey_save', { survey: { title: '새 설문', slug: 'draft-a', questions: [{ id: 'q_a1', type: 'short', title: '의견' }] } });
    const nd2 = g.call('survey_save', { survey: Object.assign({}, nd.survey, { slug: 'draft-b' }), baseUpdatedAt: nd.survey.updatedAt });
    check('게시 전 주소 변경은 이력 없음', nd2.success && nd2.survey.oldSlugs.length === 0 && !nd2.movedFrom, nd2.survey && nd2.survey.oldSlugs);
    // 응답 수 제한
    save({ limit: 1 });
    check('응답 수 제한 전에는 열림', !!g.pub('survey_getPublic', { slug: 'emart-october' }).survey);
    const s1 = submit(g, id);
    check('  ↳ 1건 제출', s1.success, s1);
    const full = g.pub('survey_getPublic', { slug: 'emart-october' });
    check('  ↳ 제한에 닿으면 closed', full.closed === true && !full.survey, full);
  }

  console.log('\n[4] survey_submit — 검증·스팸 방지·마감·제출 키');
  {
    const g = env();
    const { id } = publishEmart(g);
    const fails = (label, over, code, field) => {
      const j = submit(g, id, over);
      check(label, j.code === code && (!field || (j.fields && j.fields[field])), j);
      return j;
    };
    const n0 = g.rows('응답').length;
    fails('필수 동의 없음', { answers: { q_consent: false } }, 'INVALID', 'q_consent');
    fails('필수 이름 없음', { answers: { q_name: '  ' } }, 'INVALID', 'q_name');
    let j = fails('전화번호 형식 오류', { answers: { q_phone: '02-123-4567' } }, 'INVALID', 'q_phone');
    check('  ↳ 안내 문구에 입력값이 없음', JSON.stringify(j).indexOf('02-123-4567') < 0);
    fails('필수 제품 선택 없음', { answers: { q_model: { sel: [] } } }, 'INVALID', 'q_model');
    fails('없는 보기', { answers: { q_model: { sel: ['더 플렌더 ULTRA'] } } }, 'INVALID', 'q_model');
    fails('객관식에 둘 선택', { answers: { q_age: { sel: ['18-24', '25-34'] } } }, 'INVALID', 'q_age');
    fails('기타 선택 + 빈 글', { answers: { q_house: { sel: [], other: ' ' } } }, 'INVALID', 'q_house');
    fails('기타가 없는 질문에 기타 → 무시되고 필수 미선택', { answers: { q_model: { sel: [], other: '다른 제품' } } }, 'INVALID', 'q_model');
    fails('주소 검색 없이 기본주소만', { answers: { q_addr: { zip: '', addr1: '서울', addr2: '1층' } } }, 'INVALID', 'q_addr');
    fails('상세주소 없음', { answers: { q_addr: { zip: '06236', addr1: '서울 강남구', addr2: '' } } }, 'INVALID', 'q_addr');
    fails('영수증 사진 없음(필수)', { top: { files: [] } }, 'INVALID', 'q_receipt');
    fails('사진 4장(최대 3장)', { top: { files: [1, 2, 3, 4].map(() => ({ q: 'q_receipt', data: b64(JPEG) })) } }, 'INVALID', 'q_receipt');
    fails('이미지가 아닌 파일(PDF를 jpg로 보내도 앞 바이트로 판정)', { top: { files: [{ q: 'q_receipt', data: b64(PDF), name: 'a.jpg', type: 'image/jpeg' }] } }, 'INVALID', 'q_receipt');
    fails('10MB 초과 사진', { top: { files: [{ q: 'q_receipt', data: b64(Buffer.concat([JPEG, Buffer.alloc(10 * 1048576)])) }] } }, 'INVALID', 'q_receipt');
    fails('함정 칸이 채워짐', { top: { hp: 'http://spam' } }, 'REJECTED');
    fails('페이지 표시 후 2초 만에 제출', { top: { token: g.token(id, 2000) } }, 'TOO_FAST');
    fails('다른 설문의 토큰', { top: { token: g.ctx._svFormToken('sv_other', Date.now() - 10000) } }, 'TOKEN');
    fails('서명이 틀린 토큰', { top: { token: (Date.now() - 10000) + '.' + 'a'.repeat(32) } }, 'TOKEN');
    fails('없는 설문', { top: { surveyId: 'sv_nope' } }, 'CLOSED');
    check('실패한 제출은 한 줄도 남기지 않음 · 사진도 남기지 않음', g.rows('응답').length === n0 && g.d.in(g.scriptProps.SURVEY_FILES_FOLDER_ID).length === 0);

    const ok = submit(g, id, { answers: { q_phone: '010 1234 5678' } });
    check('정상 제출 → 감사 문구', ok.success && ok.thanks === '이벤트에 참여해주셔서 감사합니다 ❤️', ok);
    const row = g.rows('응답')[0];
    const ans = JSON.parse(row[3]);
    check('응답 행: 응답ID·설문ID·제출시각·처리상태 대기', /^r_[0-9a-z]{16}$/.test(row[0]) && row[1] === id && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row[2]) && row[6] === '대기', row.slice(0, 7));
    check('  ↳ 답변은 질문ID 기준 · 연락처 자동 하이픈 · 기타 직접 입력 · 사진 장수', ans.q_phone === '010-1234-5678' && ans.q_house.other === '셰어하우스' && ans.q_receipt === 1 && ans.q_model.sel[0] === '더 플렌더 MAX', ans);
    const att = JSON.parse(row[4]);
    const f = g.d.files[att[0].id];
    check('  ↳ 영수증은 영수증·첨부 폴더에 · 첨부파일ID 목록에 질문ID', att.length === 1 && att[0].q === 'q_receipt' && f && f.parents[0] === g.scriptProps.SURVEY_FILES_FOLDER_ID && f.bytes.equals(JPEG), att);
    check('  ↳ 파일명에 개인정보 없음(설문ID_응답ID_번호)', f.name === id + '_' + row[0] + '_1.jpg', f.name);
    check('  ↳ 공유 설정을 바꾸는 호출이 없음(공개 링크 없음)', !g.d.calls.some(c => c.op === 'update' && c.res && (c.res.permissions || c.res.copyRequiresWriterPermission === false)) &&
      !g.d.calls.some(c => /permission/i.test(c.op)));
    check('  ↳ 중복키 = HMAC(번호가 그대로 보이지 않음)', /^[0-9a-f]{32}$/.test(row[5]) && row[5].indexOf('01012345678') < 0, row[5]);

    // HEIC(압축 못 하는 원본)
    const heic = submit(g, id, { top: { files: [{ q: 'q_receipt', data: b64(HEIC) }] }, answers: { q_phone: '010-2222-3333' } });
    const hrow = g.rows('응답')[1];
    check('HEIC 원본도 받음(.heic)', heic.success && JSON.parse(hrow[4])[0].type === 'image/heic' && /\.heic$/.test(g.d.files[JSON.parse(hrow[4])[0].id].name), heic);
    // 같은 번호 = 같은 중복키
    submit(g, id, { answers: { q_phone: '010-1234-5678', q_name: '홍길순' } });
    const dupRows = g.rows('응답');
    check('같은 연락처 → 같은 중복키', dupRows[2][5] === dupRows[0][5] && dupRows[1][5] !== dupRows[0][5]);
    // 같은 제출 키 재시도
    const sid = 'retry-key-1';
    const a = submit(g, id, { top: { sid } }), filesBefore = Object.keys(g.d.files).length;
    const b = submit(g, id, { top: { sid } });
    check('같은 제출 키로 다시 보내면 한 번만 저장(duplicate)', a.success && b.success && b.duplicate === true && g.rows('응답').length === 4, b);
    check('  ↳ 두 번째 요청은 사진을 올리기 전에 끝남', Object.keys(g.d.files).length === filesBefore);
    // 분당 제한
    const cache = g.cacheStore, minute = Math.floor(Date.now() / 60000);
    cache['survey:rate:' + id + ':' + minute] = '30';
    fails('설문별 분당 제출 상한(30)', {}, 'RATE');
    delete cache['survey:rate:' + id + ':' + minute];
    // 마감
    g.call('survey_setStatus', { id, status: '마감' });
    fails('마감 후 제출', {}, 'CLOSED');
    check('  ↳ 마감 후 getPublic도 closed', g.pub('survey_getPublic', { slug: 'emart-oct' }).closed === true);
    check('로그에 이름·연락처·주소·자유 입력이 없음', !g.logs.some(l => /홍길|1234-5678|01012345678|테헤란로|셰어하우스|2222-3333/.test(l)), g.logs.filter(l => /홍|1234|테헤란/.test(l)));
    check('설문은 Sheets API를 쓰지 않음(대시보드 한도와 분리)', !g.api.calls.some(c => JSON.stringify(c).indexOf('설문') >= 0 || JSON.stringify(c).indexOf('응답') >= 0), g.api.calls.slice(-3));
  }

  console.log('\n[5] 관리 — 목록·링크·주소 규칙·충돌·질문 ID 유지·삭제 질문 보관·유형 변경·복제');
  {
    const g = env();
    const { id } = publishEmart(g);
    // 설정 탭 기본 주소
    const st = g.tab('설정'), rowIdx = st._grid.findIndex(r => r[0] === '설문_공개기본주소');
    st._grid[rowIdx][1] = 'https://survey.example.com/';
    delete g.cacheStore['survey:base'];
    const list = g.call('survey_list', {});
    const it = list.items[0];
    check('링크 = 설정 탭 설문_공개기본주소 + /s/{주소}(끝 / 정리)', list.publicBase === 'https://survey.example.com' && it.publicUrl === 'https://survey.example.com/s/emart-oct', [list.publicBase, it.publicUrl]);
    check('목록: 상태·응답 수·질문 수(안내문 제외)', it.status === '게시' && it.responses === 0 && it.questionCount === 10 && !('questions' in it), it);
    submit(g, id);
    submit(g, id, { answers: { q_phone: '010-9999-0000', q_name: '김철수' } });
    const got = g.call('survey_get', { id });
    check('survey_get: 질문별 답변 수', got.responses === 2 && got.answered.q_name === 2 && got.answered.q_receipt === 2 && !got.answered.q_known, got.answered);
    // 주소 규칙
    const base = got.survey;
    const save = (o, extra) => g.call('survey_save', Object.assign({ survey: Object.assign({}, g.call('survey_get', { id }).survey, o), baseUpdatedAt: g.call('survey_get', { id }).survey.updatedAt }, extra || {}));
    ['ab', 'Emart_Oct', 'a'.repeat(41), '한글주소'].forEach(bad => {
      const r = save({ slug: bad });
      check(`주소 '${bad.slice(0, 12)}' 거절`, r.code === 'SLUG', r);
    });
    const other = g.call('survey_save', { survey: { title: '다른 설문', slug: 'other-one', questions: [{ id: 'q_o1', type: 'short', title: 'x' }] } });
    check('새 설문 저장(주소 지정)', other.success && other.survey.slug === 'other-one' && other.survey.status === '초안', other);
    const auto = g.call('survey_save', { survey: { title: '주소 없음', questions: [] } });
    check('주소를 비우면 무작위 기본값', auto.success && /^[0-9a-z]{8}$/.test(auto.survey.slug), auto.survey && auto.survey.slug);
    check('다른 설문이 쓰는 주소 → 거절', save({ slug: 'other-one' }).code === 'SLUG');
    const moved = save({ slug: 'emart-oct-2' });
    check('주소 변경 → 이전 주소 이력', moved.success && moved.survey.oldSlugs.indexOf('emart-oct') >= 0);
    const clash = g.call('survey_save', { survey: Object.assign({}, other.survey, { slug: 'emart-oct' }), baseUpdatedAt: other.survey.updatedAt });
    check("다른 설문의 이전 주소('emart-oct') → 거절(배포한 링크가 이동해야 하므로)", clash.code === 'SLUG' && /이전 주소/.test(clash.error), clash);
    const back = save({ slug: 'emart-oct' });
    check('자기 이전 주소로 되돌리면 이력에서 빠짐', back.success && back.survey.slug === 'emart-oct' && back.survey.oldSlugs.indexOf('emart-oct') < 0 && back.survey.oldSlugs.indexOf('emart-oct-2') >= 0, back.survey && back.survey.oldSlugs);
    // 기간·값 검증
    check('마감일시가 시작보다 앞 → 거절', /뒤여야/.test(save({ startAt: '2026-10-10 10:00', endAt: '2026-10-09 10:00' }).error || ''));
    check('응답 수 제한 0 → 거절', /응답 수 제한/.test(save({ limit: 0 }).error || ''));
    check('보유기간 0 → 거절', /보유기간/.test(save({ retentionDays: 0 }).error || ''));
    // 충돌
    const stale = got.survey.updatedAt;
    const conflict = g.call('survey_save', { survey: Object.assign({}, g.call('survey_get', { id }).survey, { title: '늦은 저장' }), baseUpdatedAt: stale === g.call('survey_get', { id }).survey.updatedAt ? 'old' : stale });
    check('다른 사람이 먼저 저장했으면 CONFLICT', conflict.code === 'CONFLICT' && conflict.updatedBy === 'staff@athomecorp.com', conflict);
    const forced = g.call('survey_save', { survey: Object.assign({}, g.call('survey_get', { id }).survey, { title: '덮어쓰기' }), baseUpdatedAt: 'old', force: true });
    check('  ↳ force면 덮어씀', forced.success && forced.survey.title === '덮어쓰기');
    // 게시 중 문구 수정·보기 추가 → 기존 응답 유지
    let cur = g.call('survey_get', { id }).survey;
    let qs = cur.questions.map(q => q.id === 'q_model' ? Object.assign({}, q, { title: '구매하신 제품(수정)', options: q.options.concat(['더 플렌더 신모델']) }) : q);
    const edited = save({ questions: qs });
    const resp = g.call('survey_responses', { id });
    check('게시 중 질문 문구 수정·보기 추가 → 저장', edited.success && edited.survey.questions.find(q => q.id === 'q_model').options.length === 4, edited.error);
    check('  ↳ 기존 응답은 같은 질문ID에 그대로', resp.items.length === 2 && resp.items.every(x => x.answers.q_model.sel[0] === '더 플렌더 MAX'));
    // 답이 있는 질문 삭제 → 보관, 답이 없는 질문 삭제 → 사라짐
    cur = g.call('survey_get', { id }).survey;
    qs = cur.questions.filter(q => q.id !== 'q_age' && q.id !== 'q_known');
    const del = save({ questions: qs });
    const qAge = del.survey.questions.find(q => q.id === 'q_age'), qKnown = del.survey.questions.find(q => q.id === 'q_known');
    check('답이 있는 질문 삭제 → deleted로 보관(결과·엑셀 열 유지)', qAge && qAge.deleted === true && del.survey.questions.indexOf(qAge) === del.survey.questions.length - 1, qAge);
    check('답이 없는 질문 삭제 → 정의에서 빠짐', !qKnown);
    check('  ↳ 공개 화면에는 보관 질문이 없음', !g.pub('survey_getPublic', { slug: 'emart-oct' }).survey.questions.some(q => q.id === 'q_age'));
    const again = save({ questions: g.call('survey_get', { id }).survey.questions.filter(q => !q.deleted) });
    check('  ↳ 다음 저장에도 보관 질문은 남음', again.survey.questions.some(q => q.id === 'q_age' && q.deleted));
    // 유형 변경
    cur = g.call('survey_get', { id }).survey;
    qs = cur.questions.filter(q => !q.deleted).map(q => q.id === 'q_house' ? Object.assign({}, q, { type: 'dropdown' }) : q.id === 'q_name' ? Object.assign({}, q, { type: 'short' }) : q);
    const tc = save({ questions: qs });
    const ids = tc.survey.questions.map(q => q.id + (q.deleted ? '(삭제)' : '') + ':' + q.type);
    check('답 모양이 같은 유형(객관식→드롭다운)은 질문ID 유지', ids.indexOf('q_house:dropdown') >= 0, ids);
    check('답 모양이 다른 유형(이름→단답형)은 새 ID + 옛 질문 보관', ids.indexOf('q_name(삭제):name') >= 0 && tc.survey.questions.some(q => !q.deleted && q.type === 'short' && q.title === '성함' && q.id !== 'q_name'), ids);
    // 질문 검증
    const badQ = save({ questions: [{ id: 'q_x1', type: 'checkbox', title: '보기 없음', options: [] }] });
    check('보기 없는 선택형 → 거절', /보기를 하나 이상/.test(badQ.error || ''), badQ);
    const dupOpt = save({ questions: [{ id: 'q_x1', type: 'radio', title: '중복', options: ['a', 'a'] }] });
    check('같은 보기 두 번 → 거절', /두 번/.test(dupOpt.error || ''), dupOpt);
    const unk = save({ questions: [{ id: 'q_x1', type: 'video', title: '?' }] });
    check('모르는 유형 → 거절', /알 수 없는 유형/.test(unk.error || ''));
    // 안내문 블록 정리
    const xss = save({ notice: [{ type: 'paragraph', content: [{ type: 'text', text: '<img src=x onerror=alert(1)>', styles: { bold: true, onclick: 'x' } }, { type: 'link', href: 'javascript:alert(1)', content: 'x' }] }, { type: 'image', props: { url: 'http://x' } }] });
    const nb = xss.survey.notice;
    check('안내문: 허용 블록·서식만 저장(이미지 블록·javascript: 링크·모르는 서식 제거, 글자는 그대로)', nb.length === 1 && nb[0].content.length === 1 && nb[0].content[0].text === '<img src=x onerror=alert(1)>' &&
      JSON.stringify(nb[0].content[0].styles) === '{"bold":true}', nb);
    // 복제
    const dup = g.call('survey_duplicate', { id, slug: 'emart-nov' });
    check('복제: 새 ID·초안·새 주소·기간 비움·보관 질문 제외', dup.success && dup.survey.id !== id && dup.survey.status === '초안' && dup.survey.slug === 'emart-nov' &&
      !dup.survey.startAt && !dup.survey.questions.some(q => q.deleted) && dup.survey.title.indexOf('(복사)') === 0, dup.survey);
    check('  ↳ 복제본은 응답 0건', g.call('survey_get', { id: dup.survey.id }).responses === 0);
    check('  ↳ 쓰는 주소로 복제 → 거절', g.call('survey_duplicate', { id, slug: 'emart-nov' }).code === 'SLUG');
    check('질문 없는 설문은 게시 거절', /게시할 수 없습니다/.test(g.call('survey_setStatus', { id: auto.survey.id, status: '게시' }).error || ''));
    check('처리기록: 생성·수정·상태·복제', ['설문 생성', '설문 수정', '상태 변경', '설문 복제'].every(a => g.rows('처리기록').some(r => r[4] === a && r[1])));
  }

  console.log('\n[6] 결과 — 마스킹·개인정보 보기 기록·엑셀 기록·처리상태·영수증');
  {
    const g = env();
    const { id } = publishEmart(g);
    submit(g, id);
    submit(g, id, { answers: { q_name: '남궁민수', q_phone: '010-987-6543' }, top: { files: [{ q: 'q_receipt', data: b64(HEIC) }, { q: 'q_receipt', data: b64(JPEG) }] } });
    submit(g, id, { answers: { q_name: '이몽룡' } }); // 첫 응답과 같은 번호 → 중복
    const r = g.call('survey_responses', { id });
    const [a, b, c] = r.items;
    check('이름 마스킹 홍*동 · 남**수', a.answers.q_name === '홍*동' && b.answers.q_name === '남**수', [a.answers.q_name, b.answers.q_name]);
    check('연락처 마스킹 010-****-5678 · 010-***-6543', a.answers.q_phone === '010-****-5678' && b.answers.q_phone === '010-***-6543', [a.answers.q_phone, b.answers.q_phone]);
    check('주소 마스킹(시·구까지만)', a.answers.q_addr.zip === '*****' && a.answers.q_addr.addr1 === '서울 강남구 ***' && a.answers.q_addr.addr2 === '***', a.answers.q_addr);
    check('응답 JSON 어디에도 실제 값 없음', JSON.stringify(r).indexOf('홍길동') < 0 && JSON.stringify(r).indexOf('1234-5678') < 0 && JSON.stringify(r).indexOf('테헤란로') < 0);
    check('선택형 답은 그대로', a.answers.q_model.sel[0] === '더 플렌더 MAX' && a.answers.q_house.other === '셰어하우스');
    check('중복 표시(같은 연락처)', a.dup && c.dup && !b.dup, [a.dup, b.dup, c.dup]);
    check('첨부 목록(질문ID·형식)', b.files.length === 2 && b.files[0].type === 'image/heic' && b.files[1].type === 'image/jpeg');
    const rv = g.call('survey_revealPii', { id, responseIds: [a.id] });
    check('[개인정보 보기] → 그 응답의 이름·연락처·주소 전체 값만', rv.items[a.id].q_name === '홍길동' && rv.items[a.id].q_phone === '010-1234-5678' && rv.items[a.id].q_addr.addr1.indexOf('테헤란로') > 0 &&
      !rv.items[a.id].q_model && !rv.items[b.id], rv.items);
    const log = g.rows('처리기록').find(x => x[4] === '개인정보 보기');
    check('  ↳ 처리기록: 누가·언제·몇 건', log && log[1] === 'staff@athomecorp.com' && log[5] === '1건' && log[3] === a.id, log);
    const ex = g.call('survey_export', { id, responseIds: [a.id, c.id], scope: '필터', filterDesc: '처리상태 대기', fileName: '설문.xlsx' });
    check('[엑셀] → 지정한 응답 전체 값', ex.items.length === 2 && ex.items[0].answers.q_name === '홍길동' && ex.items[0].dup === true, ex.items && ex.items.length);
    const dl = g.rows('다운로드로그')[0];
    check('  ↳ 다운로드로그: 누가·건수·범위·파일명', dl && dl[1] === 'staff@athomecorp.com' && String(dl[3]) === '2' && /필터 — 처리상태 대기/.test(dl[4]) && dl[5] === '설문.xlsx', dl);
    const all = g.call('survey_export', { id });
    check('  ↳ 범위 없으면 전체', all.items.length === 3 && g.rows('다운로드로그')[1][4] === '전체');
    // 처리상태
    let u = g.call('survey_updateResponses', { id, responseIds: [a.id, b.id], status: '반려' });
    check('반려는 사유 필수', /반려 사유/.test(u.error || ''), u);
    u = g.call('survey_updateResponses', { id, responseIds: [a.id, b.id], status: '반려', reason: '영수증 불일치' });
    check('여러 건 일괄 반려(사유)', u.success && u.updated.length === 2, u);
    u = g.call('survey_updateResponses', { id, responseIds: [b.id], status: '승인' });
    const rows = g.rows('응답');
    check('  ↳ 승인으로 바꾸면 사유가 지워짐', rows[0][6] === '반려' && rows[0][8] === '영수증 불일치' && rows[1][6] === '승인' && rows[1][8] === '', rows.map(x => x.slice(6, 9)));
    u = g.call('survey_updateResponses', { id, responseIds: [c.id], memo: '=HYPERLINK("http://evil","x")' });
    check('메모 저장 — 수식으로 해석되지 않게 앞에 \'', u.success && g.rows('응답')[2][7] === '\'=HYPERLINK("http://evil","x")', g.rows('응답')[2][7]);
    check('메모는 한 건씩', /한 건씩/.test(g.call('survey_updateResponses', { id, responseIds: [a.id, b.id], memo: 'x' }).error || ''));
    check('없는 상태 → 거절', /처리상태는/.test(g.call('survey_updateResponses', { id, responseIds: [a.id], status: '보류' }).error || ''));
    check('처리기록: 상태 변경·메모', g.rows('처리기록').some(x => x[4] === '처리상태 변경' && /반려 \(사유: 영수증 불일치\) · 2건/.test(x[5])) && g.rows('처리기록').some(x => x[4] === '메모'));
    // 영수증
    const fa = a.files[0].id, fb = b.files[0].id, fb2 = b.files[1].id;
    g.d.files[fa].thumbnailLink = 'https://lh3.googleusercontent.com/drive-storage/abc=s220';
    const fetched = [];
    g.ctx.UrlFetchApp = { fetch: (url, o) => { fetched.push({ url, auth: o.headers.Authorization }); return { getResponseCode: () => 200, getBlob: () => ({ getContentType: () => 'image/jpeg', getBytes: () => [1, 2, 3] }) }; } };
    const im = g.call('survey_images', { id, files: [fa, fb, fb2, 'SURVEY-FOLDER'] });
    check('썸네일: Drive 미리보기(=s240) · OAuth 헤더', im.images[fa].data === Buffer.from([1, 2, 3]).toString('base64') && fetched[0].url === 'https://lh3.googleusercontent.com/drive-storage/abc=s240' && fetched[0].auth === 'Bearer mock-oauth-token', [im.images[fa], fetched]);
    check('  ↳ 미리보기 없는 HEIC → NO_PREVIEW', im.images[fb].error === 'NO_PREVIEW', im.images[fb]);
    check('  ↳ 미리보기 없는 JPG → 원본', im.images[fb2].mime === 'image/jpeg' && Buffer.from(im.images[fb2].data, 'base64').equals(JPEG), im.images[fb2] && im.images[fb2].error);
    check('  ↳ 그 설문 첨부가 아닌 파일 → FORBIDDEN', im.images['SURVEY-FOLDER'].error === 'FORBIDDEN');
    const big = g.call('survey_images', { id, files: [fa, fb], size: 'full' });
    check('  ↳ 확대 보기는 한 장씩 1600px', Object.keys(big.images).length === 1 && fetched[fetched.length - 1].url.slice(-6) === '=s1600');
    const otherSurvey = g.call('survey_duplicate', { id, slug: 'copy-x' }).survey;
    check('  ↳ 다른 설문 ID로는 이 설문 영수증을 못 봄', g.call('survey_images', { id: otherSurvey.id, files: [fa] }).images[fa].error === 'FORBIDDEN');
  }

  console.log('\n[7] 개인정보 보유기간 — 마감 + N일 지나면 개인정보·영수증 삭제, 선택형만 남김');
  {
    const g = env();
    const { id } = publishEmart(g);
    submit(g, id);
    submit(g, id, { answers: { q_phone: '010-5555-6666' } });
    g.call('survey_updateResponses', { id, responseIds: [g.rows('응답')[0][0]], memo: '홍길동님 재발송' });
    g.call('survey_updateResponses', { id, responseIds: [g.rows('응답')[1][0]], status: '발송완료' });
    // 다른 설문(보유기간 안) — 그대로여야
    const keep = g.call('survey_duplicate', { id, slug: 'keep-me' }).survey;
    g.call('survey_setStatus', { id: keep.id, status: '게시' });
    submit(g, keep.id);
    const cur = g.call('survey_get', { id }).survey;
    g.call('survey_save', { survey: Object.assign({}, cur, { retentionDays: 1 }), baseUpdatedAt: cur.updatedAt });
    const closed = g.call('survey_setStatus', { id, status: '마감' }).survey;
    const lst = g.call('survey_list', {}).items.find(x => x.id === id);
    check('삭제 예정일 = 마감 처리일 + 1일', closed.purgeDue === g.ctx._svDateOf(g.ctx._svParseKst(closed.closedAt) + 86400000) && lst.purgeDue === closed.purgeDue, [closed.closedAt, closed.purgeDue]);
    const nothing = g.ctx._svRunRetention(Date.now(), 'test');
    check('예정일 전에는 아무것도 지우지 않음', nothing.responses === 0);
    const filesBefore = g.rows('응답').map(r => JSON.parse(r[4]).map(f => f.id));
    g.d.deny.remove = false;
    const rep = g.ctx._svRunRetention(Date.now() + 2 * 86400000, 'test');
    const rows = g.rows('응답');
    const a = JSON.parse(rows[0][3]);
    check('대상 설문 응답 2건 처리 · 영수증 2개', rep.responses === 2 && rep.files === 2 && rep.surveys.length === 1, rep);
    check('이름·연락처·주소 답변 삭제', !('q_name' in a) && !('q_phone' in a) && !('q_addr' in a) && !('q_receipt' in a), a);
    check('통계용 선택형은 남음(제품·결정 요인·연령대·동의)', a.q_model.sel[0] === '더 플렌더 MAX' && a.q_reason.sel.length === 2 && a.q_age.sel[0] === '25-34' && a.q_consent === true, a);
    check('기타 직접 입력 글은 지움(선택했다는 사실만)', a.q_house.other === '(삭제됨)');
    check('중복키·메모·첨부 목록 비움, 처리상태는 남음, 개인정보삭제일', rows[0][5] === '' && rows[0][7] === '' && rows[0][4] === '[]' && rows[1][6] === '발송완료' && /^\d{4}-/.test(rows[0][9]), rows[0]);
    check('영수증 파일 영구 삭제', filesBefore[0].concat(filesBefore[1]).every(fid => !g.d.files[fid]) && g.d.calls.filter(c => c.op === 'remove').every(c => c.opt.supportsAllDrives));
    check('다른 설문(기간 안) 응답은 그대로', JSON.parse(rows[2][3]).q_name === '홍길동' && rows[2][9] === '' && g.d.files[JSON.parse(rows[2][4])[0].id]);
    const log = g.rows('처리기록').find(x => x[4] === '개인정보 삭제');
    check('처리기록: 개인정보 삭제(건수) — 내용에 개인정보 없음', log && log[2] === id && /응답 2건 · 영수증 2개 삭제/.test(log[5]) && log[1] === 'test' && !/홍길동/.test(log.join('')), log);
    const rerun = g.ctx._svRunRetention(Date.now() + 3 * 86400000, 'test');
    check('다시 돌려도 이미 처리한 응답은 건드리지 않음', rerun.responses === 0 && g.rows('처리기록').filter(x => x[4] === '개인정보 삭제').length === 1, rerun);
    // 권한이 없어 영구 삭제가 안 되면 휴지통
    const g2keep = g.call('survey_get', { id: keep.id }).survey;
    g.call('survey_save', { survey: Object.assign({}, g2keep, { endAt: g.kst(Date.now() + 60000), retentionDays: 1 }), baseUpdatedAt: g2keep.updatedAt });
    g.d.deny.remove = true;
    const fid = JSON.parse(g.rows('응답')[2][4])[0].id;
    const rep2 = g.ctx._svRunRetention(Date.now() + 3 * 86400000, 'test');
    check('영구 삭제 권한이 없으면 휴지통으로', rep2.responses === 1 && g.d.files[fid] && g.d.files[fid].trashed === true && rep2.failedFiles.length === 0, rep2);
    // 트리거
    let t = g.ctx.survey_installRetentionTrigger();
    t = g.ctx.survey_installRetentionTrigger();
    check('트리거: 매일 4시(한국 시각) 하나만', g.triggers.length === 1 && g.triggers[0].handler === 'survey_retentionDaily' && g.triggers[0].days === 1 && g.triggers[0].atHour === 4 && g.triggers[0].tz === 'Asia/Seoul' && t.replaced === 1, g.triggers);
    const daily = g.ctx.survey_retentionDaily();
    check('트리거 진입점 실행(대상 없음)', daily.responses === 0);
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
