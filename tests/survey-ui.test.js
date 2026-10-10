/* 설문 화면 — 공용 양식(survey-common.js)·공개 응답 페이지(form.html·form.js)·설문 관리(survey-admin.js·survey-results.js)

   지키려는 성질:
     · 안내문 렌더러: 허용 블록·서식만, 글자는 이스케이프(HTML 주입 불가), javascript: 링크 제거, 목록 묶기·색 클래스
     · 양식: 유형별 입력·동의 표 기본 문구·칩/목록·기타(직접 입력)·주소 검색·함정 칸, 미리보기는 제출 막힘, 제목 이스케이프
     · 검증: 프론트 validate = GAS _svCleanAnswers(같은 항목·같은 문구) — 같은 입력을 양쪽에 넣어 비교, 전화번호 자동 하이픈
     · form.html: 절대경로만(/s/{주소}로 서빙), 대시보드 스크립트 없음, noindex / build-public 허용 목록·상대경로 검사
     · form.js: /s/{주소} → slug, ?f= → id, 이전 주소면 주소창만 새 주소로, 마감 안내, 제출 본문(설문ID·토큰·sid·함정 칸·사진 base64),
       서버 검증 오류 → 항목 표시, 네트워크 실패 → 같은 sid로 다시, 성공 → 감사 문구, 최소 시간 대기
     · 설문 관리: 메뉴·페이지·해시, 목록 링크 = 설정 기본 주소 + /s/{주소}, QR 라이브러리 SRI, 편집 검증·저장 본문(보관 질문 제외·안내문 압축),
       유형 변경 시 ID 유지, 결과 엑셀 열(주소 3열·삭제된 질문·영수증 링크·처리상태), 필터, 마스킹 값 사용

   실행: node tests/survey-ui.test.js  (또는 node tests/run-all.js) */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { loadFrontend, readFrontSource } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
const { loadOfflineGas } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const PROJ = path.join(__dirname, '..');
const K = require(path.join(PROJ, 'src', 'features', 'survey', 'survey-common.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 600) : '')); }
}
const tick = () => new Promise(r => setTimeout(r, 0));
async function settle(n) { for (let i = 0; i < (n || 15); i++) await tick(); }

const Q = [
  { id: 'q_consent', type: 'consent', title: '개인정보 수집·이용 동의', required: true },
  { id: 'q_receipt', type: 'file', title: '영수증', required: true, maxFiles: 3 },
  { id: 'q_model', type: 'checkbox', title: '제품', required: true, options: ['MAX', 'PLUS'], style: 'list' },
  { id: 'q_reason', type: 'checkbox', title: '요인 <b>', options: ['가격', '디자인'], style: 'chips' },
  { id: 'q_age', type: 'radio', title: '연령대', options: ['20대', '30대'], allowOther: true, style: 'list' },
  { id: 'q_drop', type: 'dropdown', title: '경로', options: ['매장', '온라인'], allowOther: true },
  { id: 'q_name', type: 'name', title: '성함', required: true },
  { id: 'q_phone', type: 'phone', title: '연락처', required: true },
  { id: 'q_addr', type: 'address', title: '배송지', required: true },
  { id: 'q_date', type: 'date', title: '구매일' },
  { id: 'q_scale', type: 'scale', title: '만족도', minLabel: '별로', maxLabel: '최고' },
  { id: 'q_long', type: 'long', title: '의견' },
  { id: 'q_note', type: 'notice', title: '', blocks: [{ type: 'paragraph', content: [{ type: 'text', text: '중간 안내', styles: {} }] }] }
];

(async function main() {
  console.log('\n[1] 안내문 렌더러 — 허용 블록·서식만, 이스케이프');
  {
    const h = K.blocksHtml([
      { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: '🎁 이벤트', styles: {} }] },
      { type: 'paragraph', content: [{ type: 'text', text: '<img src=x onerror=alert(1)>', styles: { bold: true, underline: true, italic: true } }, { type: 'text', text: '빨강', styles: { textColor: 'red', backgroundColor: 'yellow' } }] },
      { type: 'bulletListItem', content: [{ type: 'text', text: '하나', styles: {} }] },
      { type: 'bulletListItem', content: [{ type: 'text', text: '둘', styles: {} }] },
      { type: 'numberedListItem', content: [{ type: 'text', text: '단계', styles: {} }] },
      { type: 'paragraph', content: [{ type: 'link', href: 'javascript:alert(1)', content: [{ type: 'text', text: '나쁜 링크', styles: {} }] }, { type: 'link', href: 'https://minix.co.kr', content: [{ type: 'text', text: '좋은 링크', styles: {} }] }] },
      { type: 'image', props: { url: 'https://x/y.png' } },
      { type: 'paragraph', props: { textColor: 'url(evil)' }, content: [{ type: 'text', text: 'x', styles: { textColor: 'expression(1)', onclick: 'x' } }] },
      { type: 'paragraph', content: [] }
    ]);
    check('제목 레벨 2 → h3', h.indexOf('<h3>🎁 이벤트</h3>') === 0, h.slice(0, 40));
    check('글자는 이스케이프(태그가 살지 않음)', h.indexOf('&lt;img src=x onerror=alert(1)&gt;') > 0 && h.indexOf('<img') < 0);
    check('굵게·기울임·밑줄', /<strong><em><u>&lt;img/.test(h));
    check('허용 색만 클래스로', h.indexOf('<span class="svb-c-red svb-bg-yellow">빨강</span>') > 0 && h.indexOf('expression') < 0 && h.indexOf('url(evil)') < 0);
    check('연속 글머리표는 한 ul, 번호 목록은 ol', /<ul><li>하나<\/li><li>둘<\/li><\/ul><ol><li>단계<\/li><\/ol>/.test(h));
    check('javascript: 링크는 글자만, https 링크는 새 창 noopener', h.indexOf('javascript') < 0 && h.indexOf('나쁜 링크') > 0 && h.indexOf('<a href="https://minix.co.kr" target="_blank" rel="noopener noreferrer">좋은 링크</a>') > 0);
    check('이미지 블록 등 허용 밖 블록은 버림', h.indexOf('y.png') < 0);
    check('빈 문단은 줄바꿈 유지', h.indexOf('<p><br></p>') > 0);
    const c = K.compactBlocks([{ id: 'abc', type: 'paragraph', props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' }, content: [{ type: 'text', text: 'a', styles: { bold: true } }], children: [] }]);
    check('저장 전 압축 — id·기본값 속성·빈 자식 제거', JSON.stringify(c) === '[{"type":"paragraph","content":[{"type":"text","text":"a","styles":{"bold":true}}]}]', c);
  }

  console.log('\n[2] 양식 HTML — 유형별 입력·동의 표·함정 칸·미리보기');
  {
    const h = K.formHtml({ title: '이벤트 <script>', notice: [{ type: 'paragraph', content: [{ type: 'text', text: '안내', styles: {} }] }], questions: Q.concat([{ id: 'q_old', type: 'short', title: '삭제됨', deleted: true }]) }, { uid: 't' });
    check('제목 이스케이프', h.indexOf('이벤트 &lt;script&gt;') > 0 && h.indexOf('<script>') < 0);
    check('질문 제목 이스케이프', h.indexOf('요인 &lt;b&gt;') > 0);
    check('보관(삭제)된 질문은 그리지 않음', h.indexOf('q_old') < 0);
    check('동의: 기본 문구 표(수집 항목·이용 목적·보유 기간·거부 권리와 불이익) + 필수 체크', ['수집 항목', '이용 목적', '보유 기간', '거부 권리와 불이익', K.CONSENT_DEFAULT.items, K.CONSENT_DEFAULT.refusal].every(t => h.indexOf(t) > 0) && /data-role="consent"/.test(h) && h.indexOf('(필수)') > 0);
    check('사진: 이미지만·여러 장·최대 장수 안내', /accept="image\/\*,\.heic,\.heif" multiple data-role="file"/.test(h) && h.indexOf('최대 3장') > 0);
    check('체크박스 목록/칩 모양', /class="svf-opt"><input type="checkbox" name="t-q_model"/.test(h) && /class="svf-chip"><input type="checkbox" name="t-q_reason"/.test(h));
    check('객관식 기타(직접 입력) + 입력칸', /svf-other"><input type="radio" name="t-q_age" value="" data-role="other"/.test(h) && /data-role="otherText"/.test(h));
    check('드롭다운 기타', h.indexOf('<option value="__other">기타(직접 입력)</option>') > 0);
    check('전화번호: 숫자 키패드·자동완성 tel', /type="tel" class="svf-in" data-role="phone" inputmode="numeric" autocomplete="tel"/.test(h));
    check('주소: 우편번호·기본주소는 검색으로(읽기 전용)·상세주소', /data-role="zip" placeholder="우편번호" readonly/.test(h) && /data-role="postcode"/.test(h) && /data-role="addr1"[^>]*readonly/.test(h) && /data-role="addr2"/.test(h));
    check('날짜·척도(1~5)·장문', /type="date"/.test(h) && (h.match(/data-role="scale"/g) || []).length === 5 && h.indexOf('<span>별로</span><span>최고</span>') > 0 && /<textarea class="svf-in svf-ta"/.test(h));
    check('중간 안내문 블록', h.indexOf('<p>중간 안내</p>') > 0);
    check('필수 표시는 필수 질문에만', (h.match(/class="svf-req"/g) || []).length === Q.filter(q => q.required && q.type !== 'notice').length);
    check('함정 칸(화면 밖·탭 제외·자동완성 끔)', /<div class="svf-hp" aria-hidden="true">.*name="website" tabindex="-1" autocomplete="off" data-role="hp"/.test(h));
    check('제출 버튼', /<button type="submit" class="svf-submit">제출하기<\/button>/.test(h));
    const pv = K.formHtml({ title: 'x', questions: Q }, { preview: true });
    check('미리보기는 제출 버튼이 막힘', /class="svf-submit" disabled>미리보기 — 제출되지 않습니다/.test(pv));
  }

  console.log('\n[3] 검증 — 프론트 validate = GAS _svCleanAnswers (같은 입력, 같은 항목·문구)');
  {
    const g = loadOfflineGas({});
    const gas = (answers, files) => {
      const a = g.ctx._svCleanAnswers(Q, JSON.parse(JSON.stringify(answers)));
      Object.keys(files || {}).forEach(k => { if (!files[k]) a.errors[k] = '사진을 1장 이상 올려주세요.'; });
      if (!files || files.q_receipt == null) a.errors.q_receipt = '사진을 1장 이상 올려주세요.';
      return a.errors;
    };
    const good = { q_consent: true, q_model: { sel: ['MAX'] }, q_name: '홍길동', q_phone: '010-1234-5678', q_addr: { zip: '06236', addr1: '서울 강남구', addr2: '1층' } };
    const cases = [
      ['모두 비움', {}, {}],
      ['정상', good, { q_receipt: 1 }],
      ['전화번호 형식', Object.assign({}, good, { q_phone: '02-123-4567' }), { q_receipt: 1 }],
      ['기타 빈 글', Object.assign({}, good, { q_age: { sel: [], other: '' } }), { q_receipt: 1 }],
      ['상세주소 없음', Object.assign({}, good, { q_addr: { zip: '06236', addr1: '서울', addr2: '' } }), { q_receipt: 1 }],
      ['우편번호 없음', Object.assign({}, good, { q_addr: { zip: '', addr1: '서울', addr2: '1' } }), { q_receipt: 1 }],
      ['장문 5000자 초과', Object.assign({}, good, { q_long: 'x'.repeat(5001) }), { q_receipt: 1 }],
      ['날짜 형식', Object.assign({}, good, { q_date: '2026-02-30' }), { q_receipt: 1 }],
      ['동의 안 함', Object.assign({}, good, { q_consent: false }), { q_receipt: 1 }]
    ];
    cases.forEach(([label, a, files]) => {
      const front = K.validate(Q, a, files);
      const back = gas(a, files.q_receipt ? files : null);
      check(label + ' — 같은 항목·같은 문구', JSON.stringify(Object.keys(front).sort().map(k => [k, front[k]])) === JSON.stringify(Object.keys(back).sort().map(k => [k, back[k]])), { front, back });
    });
    check('전화번호 입력 중 하이픈', K.formatPhoneTyping('0101234') === '010-1234' && K.formatPhoneTyping('01012345678') === '010-1234-5678' && K.formatPhoneTyping('0101234567') === '010-123-4567' && K.formatPhoneTyping('010-1234-56789') === '010-1234-5678');
    check('전화번호 확정 형식(휴대전화만)', K.formatPhone('010 1234 5678') === '010-1234-5678' && K.formatPhone('0212345678') === '' && K.formatPhone('010123') === '');
  }

  console.log('\n[4] form.html — 절대경로·공개 파일만·검색 제외, build-public 허용 목록');
  {
    const html = fs.readFileSync(path.join(PROJ, 'form.html'), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(r => !/^(https?:|\/\/|data:|#)/.test(r));
    check('로컬 자원은 전부 /로 시작(/s/{주소}에서 열려도 404 없음)', refs.length >= 5 && refs.every(r => r.charAt(0) === '/'), refs);
    check('  ↳ 모두 실제 파일', refs.every(r => fs.existsSync(path.join(PROJ, r.slice(1)))), refs.filter(r => !fs.existsSync(path.join(PROJ, r.slice(1)))));
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
    check('스크립트는 config.js·survey-common.js·form.js 셋뿐(대시보드·로그인 코드 없음)', JSON.stringify(scripts) === JSON.stringify(['/src/shared/config.js', '/src/features/survey/survey-common.js', '/src/features/survey/form.js']), scripts);
    check('검색 엔진 제외(noindex)', /<meta name="robots" content="noindex,nofollow">/.test(html));
    const sh = fs.readFileSync(path.join(PROJ, 'scripts', 'build-public.sh'), 'utf8');
    check('build-public: form.html 공개 허용 목록', /PUBLIC_FILES=\([\s\S]*?\n  form\.html\s/.test(sh));
    check('build-public: form.html 참조 파일 검사 + 상대경로 검사', /for html in index\.html dashboard\.html form\.html; do/.test(sh) && /form\.html 의 '\$ref' 가 상대경로입니다/.test(sh));
    check('build-public: 비공개 목록(apps-script*.js·tests 등)은 그대로', /FORBIDDEN=\(\n  'apps-script\*\.js' appsscript\.json render\.yaml/.test(sh));
  }

  console.log('\n[5] form.js — 주소 해석·이전 주소·마감·제출');
  async function runForm(o) {
    const calls = [], replaced = [], root = { innerHTML: '', querySelector: () => null };
    let ctl = null, mountArgs = null;
    const kit = Object.assign({}, K, {
      mountForm: (el, survey, opts) => {
        mountArgs = { survey, opts };
        ctl = { errors: null, formErr: '', busyLog: [], showErrors(e) { this.errors = e; }, setFormError(m) { this.formErr = m; }, busy(on, l) { this.busyLog.push([on, l]); } };
        return ctl;
      },
      blobToBase64: async b => Buffer.from(b.bytes).toString('base64')
    });
    const replies = o.replies;
    const sb = {
      console, Promise, Date, JSON, Math, Object, Array, String, Number, Error, encodeURIComponent, decodeURIComponent, URLSearchParams,
      setTimeout: (fn, ms) => { if (ms) o.waits && o.waits.push(ms); return setTimeout(fn, 0); }, clearTimeout,
      AbortController: function () { this.signal = {}; this.abort = () => {}; },
      document: { getElementById: id => (id === 'svfRoot' ? root : null), title: '' },
      location: { pathname: o.pathname, search: o.search || '', hash: '' },
      history: { replaceState: (a, b, u) => replaced.push(u) },
      crypto: { randomUUID: () => 'sid-fixed' },
      scrollTo() {},
      _getGasUrl: () => 'https://script.google.com/macros/s/TEST/exec',
      fetch: async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, body, headers: init.headers });
        const r = replies[body.action];
        const out = typeof r === 'function' ? r(body) : r;
        if (out instanceof Error) throw out;
        return { ok: true, json: async () => out };
      }
    };
    sb.window = sb; sb.SurveyKit = kit;
    vm.runInContext(fs.readFileSync(path.join(PROJ, 'src', 'features', 'survey', 'form.js'), 'utf8'), vm.createContext(sb), { filename: 'form.js' });
    await settle(30);
    return { calls, replaced, root, ctl: () => ctl, mountArgs: () => mountArgs, sb };
  }
  const SURVEY = { id: 'sv_1', slug: 'emart-oct', title: '이벤트', notice: [], questions: Q, thanks: '감사합니다 ❤️' };
  {
    const r = await runForm({ pathname: '/s/Emart-Oct', replies: { survey_getPublic: { success: true, survey: SURVEY, slug: 'emart-oct', token: '123.abc' } } });
    check('/s/{주소} → survey_getPublic {slug}(소문자) · 세션 없음 · 헤더 지정 없음', r.calls[0].body.action === 'survey_getPublic' && JSON.stringify(r.calls[0].body.data) === '{"slug":"emart-oct"}' && !('session' in r.calls[0].body) && r.calls[0].headers === undefined, r.calls[0]);
    check('  ↳ 양식을 붙이고 제목을 탭 이름으로', r.mountArgs() && r.mountArgs().survey.id === 'sv_1' && r.sb.document.title === '이벤트');
    check('  ↳ 주소가 같으면 주소창을 건드리지 않음', r.replaced.length === 0);
  }
  {
    const r = await runForm({ pathname: '/form.html', search: '?f=sv_1', replies: { survey_getPublic: { success: true, survey: SURVEY, slug: 'emart-oct', token: 't' } } });
    check('form.html?f=설문ID → {id}', JSON.stringify(r.calls[0].body.data) === '{"id":"sv_1"}' && r.replaced.length === 0);
  }
  {
    const r = await runForm({ pathname: '/s/emart-sept', replies: { survey_getPublic: { success: true, survey: SURVEY, slug: 'emart-oct', token: 't' } } });
    check('이전 주소 → 주소창만 /s/{지금 주소}(다시 받지 않음)', r.replaced[0] === '/s/emart-oct' && r.calls.length === 1 && !!r.mountArgs(), r.replaced);
  }
  {
    const r = await runForm({ pathname: '/s/draft-one', replies: { survey_getPublic: { success: true, closed: true } } });
    check('초안·없는 주소 → 마감되었습니다', r.root.innerHTML.indexOf('마감되었습니다') > 0 && !r.mountArgs());
    const r2 = await runForm({ pathname: '/s/emart-oct', replies: { survey_getPublic: { success: true, closed: true, title: '<b>이벤트</b>' } } });
    check('기간 밖 → 마감 + 제목(이스케이프)', r2.root.innerHTML.indexOf('&lt;b&gt;이벤트&lt;/b&gt;') > 0 && r2.root.innerHTML.indexOf('<b>이벤트') < 0);
    const r3 = await runForm({ pathname: '/', replies: {} });
    check('주소가 없으면 부르지 않고 마감 안내', r3.calls.length === 0 && r3.root.innerHTML.indexOf('마감되었습니다') > 0);
    const r4 = await runForm({ pathname: '/s/emart-oct', replies: { survey_getPublic: new Error('net') } });
    check('불러오기 실패 → 두 번 시도 후 [다시 시도]', r4.calls.length === 2 && r4.root.innerHTML.indexOf('다시 시도') > 0);
  }
  {
    let submitReply = { success: false, code: 'INVALID', error: '입력 내용을 확인해주세요.', fields: { q_phone: '010-0000-0000 형식으로 입력해주세요.' } };
    const waits = [];
    const r = await runForm({ pathname: '/s/emart-oct', waits, replies: { survey_getPublic: { success: true, survey: SURVEY, slug: 'emart-oct', token: '999.tok' }, survey_submit: () => submitReply } });
    const onSubmit = r.mountArgs().opts.onSubmit;
    const payload = { answers: { q_name: '홍길동' }, files: [{ q: 'q_receipt', blob: { bytes: [0xFF, 0xD8, 0xFF] }, type: 'image/jpeg' }], hp: '' };
    await onSubmit(payload); await settle(30);
    const sub = r.calls.find(c => c.body.action === 'survey_submit');
    check('제출 본문: 설문ID·토큰·sid·함정 칸·답·사진 base64', sub && sub.body.data.surveyId === 'sv_1' && sub.body.data.token === '999.tok' && sub.body.data.sid === 'sid-fixed' && sub.body.data.hp === '' &&
      sub.body.data.answers.q_name === '홍길동' && sub.body.data.files[0].q === 'q_receipt' && sub.body.data.files[0].data === Buffer.from([0xFF, 0xD8, 0xFF]).toString('base64'), sub && sub.body.data);
    check('  ↳ 표시 후 5.5초 전이면 남은 시간만큼 기다렸다 보냄', waits.some(ms => ms > 4000 && ms <= 5500), waits);
    check('  ↳ 제출 중 버튼 막음(사진 올리는 중…)', r.ctl().busyLog[0][0] === true && r.ctl().busyLog[0][1] === '사진 올리는 중…');
    check('서버 검증 오류 → 항목 표시 · 버튼 다시 열림', r.ctl().errors && r.ctl().errors.q_phone && r.ctl().busyLog.slice(-1)[0][0] === false);
    submitReply = new Error('net');
    await onSubmit(payload); await settle(30);
    check('네트워크 실패 → 안내 · 다시 누를 수 있음', /다시 눌러주세요/.test(r.ctl().formErr) && r.ctl().busyLog.slice(-1)[0][0] === false);
    submitReply = { success: true, thanks: '감사합니다 <3' };
    await onSubmit(payload); await settle(30);
    const subs = r.calls.filter(c => c.body.action === 'survey_submit');
    check('다시 보내도 같은 sid(서버가 한 번만 저장)', subs.length === 3 && subs.every(c => c.body.data.sid === 'sid-fixed'));
    check('성공 → 감사 문구(이스케이프)', r.root.innerHTML.indexOf('제출이 완료되었습니다') > 0 && r.root.innerHTML.indexOf('감사합니다 &lt;3') > 0);
    await onSubmit(payload); await settle(10);
    check('완료 뒤에는 다시 보내지 않음', r.calls.filter(c => c.body.action === 'survey_submit').length === 3);
    const r2 = await runForm({ pathname: '/s/emart-oct', replies: { survey_getPublic: { success: true, survey: SURVEY, slug: 'emart-oct', token: 't' }, survey_submit: { success: false, code: 'CLOSED', error: '마감되었습니다.' } } });
    await r2.mountArgs().opts.onSubmit({ answers: {}, files: [], hp: '' }); await settle(30);
    check('제출 중 마감 → 마감 화면', r2.root.innerHTML.indexOf('마감되었습니다') > 0);
  }

  console.log('\n[6] 설문 관리 — 메뉴·목록 링크·QR·편집 검증·저장 본문');
  {
    const html = readFrontSource(PROJ);
    check('사이드바 대시보드 관리 > 설문 관리(#admin/surveys)', /data-page="admin-targets"[\s\S]*?data-page="admin-surveys" onclick="navPage\('admin-surveys',this\)">.*설문 관리/.test(html));
    check('설문 화면 CSS·양식 CSS를 대시보드가 싣는다', html.indexOf('src/features/survey/survey-admin.css') > 0 && html.indexOf('src/features/survey/form.css') > 0);
    const SHIM = 'get SV(){return _SV;}, get SVR(){return _SVR;}, get SV_QR_SRI(){return SV_QR_SRI;}, get SV_QR_SRC(){return SV_QR_SRC;}';
    const { ctx, X } = loadFrontend(PROJ, SHIM);
    const box = {};
    ctx.document.getElementById = id => (box[id] = box[id] || { id, innerHTML: '', value: '', style: {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], children: [], insertBefore() {},
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle() {} } });
    const calls = [], toasts = [];
    const LIST = { success: true, publicBase: 'https://survey.example.com', items: [
      { id: 'sv_1', slug: 'emart-oct', oldSlugs: ['emart-sept'], title: '이마트 <이벤트>', status: '게시', open: true, responses: 12, limit: 300, retentionDays: 90, purgeDue: '2027-01-29', updatedAt: '2026-10-10 10:00:00' },
      { id: 'sv_2', slug: 'draft-x', oldSlugs: [], title: '초안', status: '초안', open: false, responses: 0, retentionDays: 90, purgeDue: '', updatedAt: '2026-10-09 10:00:00' }] };
    const SURVEY_FULL = { id: 'sv_1', slug: 'emart-oct', oldSlugs: [], title: '이마트', status: '게시', startAt: '2026-10-01 00:00', endAt: '2026-10-31 23:59', limit: '', retentionDays: 90, thanks: '감사',
      notice: [], updatedAt: '2026-10-10 10:00:00', publishedAt: '2026-10-01 00:00:00', closedAt: '',
      questions: [{ id: 'q_a', type: 'radio', title: '연령', options: ['20대'], style: 'list' }, { id: 'q_name', type: 'name', title: '성함', required: true }, { id: 'q_old', type: 'short', title: '옛 질문', deleted: true }] };
    let saved = null;
    ctx._svCall = async (action, data) => {
      calls.push([action, data]);
      if (action === 'survey_list') return LIST;
      if (action === 'survey_get') return { success: true, publicBase: 'https://survey.example.com', survey: SURVEY_FULL, responses: 5, answered: { q_a: 5 } };
      if (action === 'survey_save') { saved = data; return { success: true, survey: Object.assign({}, data.survey, { updatedAt: 'x', publishedAt: '2026-10-01', questions: data.survey.questions, oldSlugs: [] }), movedFrom: '' }; }
      return { success: true };
    };
    ctx.showToast = (m, o) => toasts.push([m, o && o.type]);
    ctx.navPage('admin-surveys', null);
    await settle();
    const page = box['page-admin-surveys'].innerHTML;
    check('목록 진입 → survey_list', calls[0][0] === 'survey_list');
    check('링크 복사 = 설정 기본 주소 + /s/{주소}', page.indexOf("_svCopy('https://survey.example.com/s/emart-oct')") > 0, page.slice(0, 300));
    check('제목 이스케이프·이전 주소 자동 이동 표시·삭제 예정일', page.indexOf('이마트 &lt;이벤트&gt;') > 0 && page.indexOf('/s/emart-sept → 자동 이동') > 0 && page.indexOf('개인정보 삭제 예정 2027-01-29') > 0);
    check('게시 중이면 [마감], 초안이면 [게시] · QR · 복제 · 응답 수 → 결과', /_svQuickStatus\('sv_1','마감'\)/.test(page) && /_svQuickStatus\('sv_2','게시'\)/.test(page) && /_svQrOpen\('sv_1'\)/.test(page) && /_svDuplicate\('sv_1'\)/.test(page) && /_svGo\('sv_1\/results'\)">12<\/a>/.test(page));
    check('QR 라이브러리: 버전 고정 원본 파일 + SRI(sha384)', X.SV_QR_SRC === 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js' && /^sha384-[A-Za-z0-9+/=]{64}$/.test(X.SV_QR_SRI));
    // 편집기
    ctx.navPage('admin-surveys', null, 'sv_1');
    await settle();
    const ed = box['page-admin-surveys'].innerHTML;
    check('편집: survey_get · 보관 질문은 편집 목록에서 빼고 안내', calls.some(c => c[0] === 'survey_get') && X.SV.ed.s.questions.length === 2 && X.SV.ed.archived.length === 1 && ed.indexOf('보관된 질문 1개') > 0);
    check('편집: 주소 입력에 기본 주소 접두어 · 응답 수 표시', ed.indexOf('https://survey.example.com/s/') > 0 && ed.indexOf('value="emart-oct"') > 0 && ed.indexOf('응답 5건') > 0);
    check('편집: 13가지 유형 추가 버튼', (ed.match(/onclick="_sveAdd\('/g) || []).length === 13);
    X.SV.ed.s.slug = 'Bad Slug';
    check('주소 형식 오류', /3~40자/.test(ctx._sveSlugError('bad slug')));
    check('다른 설문이 쓰는 주소는 못 씀 · 자기 이전 주소로는 돌아갈 수 있음', /쓰고 있거나 쓰던 주소/.test(ctx._sveSlugError('emart-sept')) === false && /쓰고 있거나 쓰던 주소/.test(ctx._sveSlugError('draft-x')), ctx._sveSlugError('draft-x'));
    X.SV.ed.s.slug = 'emart-oct';
    ctx.confirm = () => true;
    // 유형 변경(답 모양 같음) → ID 유지
    ctx._sveChangeType(0, 'dropdown');
    check('객관식 → 드롭다운: 질문 ID·보기 유지', X.SV.ed.s.questions[0].id === 'q_a' && X.SV.ed.s.questions[0].type === 'dropdown' && X.SV.ed.s.questions[0].options[0] === '20대');
    ctx._sveAdd('checkbox');
    const added = X.SV.ed.s.questions[2];
    check('질문 추가: 새 ID(q_ + 8자)·기본 보기', /^q_[0-9a-z]{8}$/.test(added.id) && added.options.length === 2);
    added.options = [];
    const chk = ctx._sveCheck();
    check('저장 전 검사: 보기 없는 선택형', chk.errs.some(e => /보기를 하나 이상/.test(e)), chk.errs);
    check('  ↳ 이름을 받는데 동의 질문이 없으면 경고', /동의 질문이 없습니다/.test(chk.warn));
    added.options = ['a', 'b'];
    check('  ↳ 제목 없는 질문도 막음', chk.errs.some(e => /3번 질문: 질문을 입력해주세요/.test(e)), chk.errs);
    added.title = '관심 제품';
    X.SV.ed.s.notice = [{ id: 'n1', type: 'paragraph', props: { textColor: 'default' }, content: [{ type: 'text', text: '안내', styles: {} }], children: [] }];
    await ctx._sveSave(true); await settle();
    check('저장 본문: 보관 질문 제외·안내문 압축·baseUpdatedAt', saved && saved.survey.questions.length === 3 && !saved.survey.questions.some(q => q.deleted) &&
      JSON.stringify(saved.survey.notice) === '[{"type":"paragraph","content":[{"type":"text","text":"안내","styles":{}}]}]' && saved.baseUpdatedAt === '2026-10-10 10:00:00', saved && saved.survey);
    check('  ↳ 저장 알림', toasts.some(t => t[1] === 'success'));
  }

  console.log('\n[7] 결과 — 엑셀 열·필터·주요 답변(마스킹 값)');
  {
    const SHIM = 'get SVR(){return _SVR;}';
    const { ctx, X } = loadFrontend(PROJ, SHIM);
    const survey = { id: 'sv_1', slug: 'emart-oct', questions: [
      { id: 'q_consent', type: 'consent', title: '동의' }, { id: 'q_receipt', type: 'file', title: '영수증' },
      { id: 'q_model', type: 'checkbox', title: '제품', options: ['MAX', 'PLUS'], required: true }, { id: 'q_age', type: 'radio', title: '연령', options: ['20대'], allowOther: true },
      { id: 'q_name', type: 'name', title: '성함' }, { id: 'q_phone', type: 'phone', title: '연락처' }, { id: 'q_addr', type: 'address', title: '배송지' },
      { id: 'q_note', type: 'notice', title: '' }, { id: 'q_old', type: 'short', title: '옛 질문', deleted: true }] };
    const items = [
      { id: 'r_1', at: '2026-10-05 10:00:00', answers: { q_consent: true, q_receipt: 2, q_model: { sel: ['MAX', 'PLUS'] }, q_age: { sel: [], other: '40대' }, q_name: '홍길동', q_phone: '010-1234-5678', q_addr: { zip: '06236', addr1: '서울 강남구', addr2: '1층' }, q_old: '옛 답' },
        files: [{ id: 'F1' }, { id: 'F2' }], dup: true, status: '반려', reason: '불일치', memo: '확인', purgedAt: '' },
      { id: 'r_2', at: '2026-10-07 09:00:00', answers: { q_model: { sel: ['PLUS'] }, q_name: '김*수', q_phone: '010-****-0000' }, files: [], dup: false, status: '승인', reason: '', memo: '', purgedAt: '' }];
    const { header, rows } = ctx._svrSheetRows(survey, items, 'https://survey.example.com');
    check('엑셀 열: 응답ID·제출시각·질문(안내문 제외)·주소 3열·삭제된 질문·영수증 보기·중복·처리상태·반려사유·메모·삭제일',
      JSON.stringify(header) === JSON.stringify(['응답ID', '제출시각', '동의', '영수증', '제품', '연령', '성함', '연락처', '배송지 우편번호', '배송지 기본주소', '배송지 상세주소', '(삭제된 질문) 옛 질문', '영수증 보기', '중복 여부', '처리상태', '반려사유', '메모', '개인정보삭제일']), header);
    check('엑셀 값: 동의·사진 장수·복수 선택·기타·주소 나눔·삭제된 질문 답·중복', JSON.stringify(rows[0].slice(2, 12)) === JSON.stringify(['동의', '사진 2장', 'MAX, PLUS', '기타: 40대', '홍길동', '010-1234-5678', '06236', '서울 강남구', '1층', '옛 답']) && rows[0][13] === '중복' && rows[0][14] === '반려' && rows[0][15] === '불일치', rows[0]);
    check('영수증 보기 = 대시보드 링크(#admin/surveys/{설문}/r/{응답}) — 사진 없으면 빈칸', rows[0][12].l === 'https://survey.example.com/#admin/surveys/sv_1/r/r_1' && rows[1][12] === '', rows[0][12]);
    Object.assign(X.SVR, { id: 'sv_1', survey, items, pii: null });
    const main = ctx._svrMain(items[1]);
    check('주요 답변: 선택형(필수 먼저) + 마스킹된 이름·연락처', main.indexOf('PLUS') === 0 && main.indexOf('김*수') > 0 && main.indexOf('010-****-0000') > 0, main);
    X.SVR.f = { status: '반려', dup: '', from: '', to: '', q: '', opt: '' };
    check('필터: 처리상태', ctx._svrFiltered().map(r => r.id).join() === 'r_1');
    X.SVR.f = { status: '', dup: 'nodup', from: '2026-10-06', to: '', q: '', opt: '' };
    check('필터: 중복 제외 + 기간', ctx._svrFiltered().map(r => r.id).join() === 'r_2');
    X.SVR.f = { status: '', dup: '', from: '', to: '', q: 'q_model', opt: 'MAX' };
    check('필터: 질문 보기(구매 모델)', ctx._svrFiltered().map(r => r.id).join() === 'r_1');
    X.SVR.f = { status: '', dup: '', from: '', to: '', q: 'q_age', opt: '__other' };
    check('필터: 기타 직접 입력', ctx._svrFiltered().map(r => r.id).join() === 'r_1' && /연령 = 기타/.test(ctx._svrFilterDesc()));
    X.SVR.f = { status: '', dup: '', from: '', to: '', q: '', opt: '' };
    check('필터 없음 = 최신 제출이 위', ctx._svrFiltered().map(r => r.id).join() === 'r_2,r_1');
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
