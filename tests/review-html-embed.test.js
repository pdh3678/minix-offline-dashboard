/* 회고 HTML 임베드 — GAS 첨부 원문 API(review_*) + 프론트 로직(review-app/src/htmlEmbed.js).

   지키려는 성질:
     · review_* 는 doPost 전용·세션 필수 — 세션 없음/위조면 Drive에 닿기 전에 AUTH_REQUIRED
     · 업로드: .html/.htm만, 20MB 상한, 전용 폴더(ID를 Script Properties에 기록)에 저장·조직 내 링크 공유,
       블록에는 Drive 다운로드 주소만 들어간다
     · 원문 조회: **회고 첨부 폴더 안의 파일만**(스크립트 소유자 권한이라 제한이 없으면 소유자 Drive 전체가 열린다),
       휴지통·없는 파일·잘못된 ID 거절, 5MB 초과는 TOO_LARGE, 폴더가 아직 없으면 만들지 않고 거절
     · 프론트: iframe은 sandbox="allow-scripts"만, blob URL로 여는 경로 없음, 높이 메시지는 그 iframe이 보낸
       숫자만 통과(200~1600으로 자름), 원문은 세션 캐시·실패는 캐시 안 함, 세션은 URL이 아니라 본문에

   실행: node tests/review-html-embed.test.js  (또는 node tests/run-all.js) */
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const { loadOfflineGas, PROJ } = require(path.join(__dirname, 'lib', 'offline-gas.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

// Drive 목 — 이 기능이 쓰는 메서드만. 파일은 부모 폴더 하나를 가진다.
function makeDrive() {
  const files = {}, folders = {};
  let seq = 0;
  const nextId = (p) => p + String(++seq).padStart(12, '0');
  const iter = (arr) => { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; };
  function mkFile(blob, parentId) {
    const id = nextId('FILE'), bytes = blob.getBytes();
    const f = {
      _parent: parentId, _trashed: false, _sharing: null,
      getId: () => id, getName: () => blob._name, getSize: () => bytes.length, isTrashed: () => f._trashed,
      getParents: () => iter(parentId && folders[parentId] ? [folders[parentId]] : []),
      getBlob: () => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
      setSharing(a, p) { f._sharing = [a, p]; }
    };
    files[id] = f;
    return f;
  }
  function mkFolder(name) {
    const id = nextId('FOLDER');
    const f = { getId: () => id, getName: () => name, createFile: (blob) => mkFile(blob, id) };
    folders[id] = f;
    return f;
  }
  const api = {
    Access: { DOMAIN_WITH_LINK: 'DOMAIN_WITH_LINK' }, Permission: { VIEW: 'VIEW' },
    createFolder: mkFolder,
    getFolderById: (id) => { if (!folders[id]) throw new Error('폴더 없음'); return folders[id]; },
    getFileById: (id) => { if (!files[id]) throw new Error('파일 없음'); return files[id]; }
  };
  return { api, files, folders, mkFolder, mkFile };
}

function session(ctx, email) {
  const sheet = ctx._sessionSheet(ctx.SpreadsheetApp.getActiveSpreadsheet());
  const now = Date.now(), sid = 'sid-' + Math.random().toString(36).slice(2);
  sheet.appendRow([sid, email, '작성자', now, now + 3600e3 * 12, now]);
  return ctx._signSessionToken({ sid, email, name: '작성자', exp: now + 3600e3 * 12, iat: now, kv: 1 });
}
function env() {
  const g = loadOfflineGas({});
  g.drive = makeDrive();
  g.ctx.DriveApp = g.drive.api;
  // 목 newBlob은 (데이터)만 받는다 — 이름을 기억하게만 감싼다(바이트 처리는 그대로)
  const orig = g.ctx.Utilities.newBlob;
  g.ctx.Utilities.newBlob = (v, type, name) => Object.assign(orig(v), { _name: name, _type: type });
  const token = session(g.ctx, 'writer@athomecorp.com');
  const post = (body) => JSON.parse(g.ctx.doPost({ postData: { contents: JSON.stringify(body) }, parameter: {} }));
  g.post = post;
  g.call = (action, data) => post({ action, session: token, data });
  g.props = () => g.ctx.PropertiesService.getScriptProperties();
  return g;
}

(async function main() {
  console.log('\n[1] 라우팅·인증');
  {
    const g = env();
    check('세션 없음 → AUTH_REQUIRED', g.post({ action: 'review_getFile', data: { fileId: 'x'.repeat(20) } }).error === 'AUTH_REQUIRED');
    check('위조 토큰 → AUTH_REQUIRED', g.post({ action: 'review_uploadFile', session: 'a.b', data: { name: 'a.html', content: 'x' } }).error === 'AUTH_REQUIRED');
    check('인증 실패면 Drive에 아무것도 안 만듦', !Object.keys(g.drive.files).length && !Object.keys(g.drive.folders).length);
    check('모르는 review_ 액션은 오류', /알 수 없는 회고 액션/.test(g.call('review_nope', {}).error));
    check('그 외 액션은 여전히 거절(GET으로 보내야)', /presence·offline_ 전용/.test(g.call('updateDeal', {}).error));
    check('응답에 서버 버전', g.call('review_nope', {}).version === g.ctx.SCRIPT_VERSION);
  }

  console.log('\n[2] review_uploadFile');
  {
    const g = env();
    check('HTML 아닌 이름 거절', /HTML\(\.html\/\.htm\) 파일만/.test(g.call('review_uploadFile', { name: 'a.pdf', content: 'x' }).error));
    check('내용 없음 거절', /파일 내용이 없습니다/.test(g.call('review_uploadFile', { name: 'a.html' }).error));
    const big = g.call('review_uploadFile', { name: 'big.html', content: 'x'.repeat(20 * 1024 * 1024 + 1) });
    check('20MB 초과 거절', /20MB 초과/.test(big.error), big.error);
    check('거절된 요청은 폴더도 파일도 안 만듦', !Object.keys(g.drive.files).length && !Object.keys(g.drive.folders).length);

    const html = '<!doctype html><meta charset="utf-8"><h1>러브지나 차트</h1><script>1</script>';
    const r = g.call('review_uploadFile', { name: 'chart1-lovejina-full-trend.html', content: html });
    check('성공 — fileId·이름·크기(바이트)', r.success && r.fileId && r.name === 'chart1-lovejina-full-trend.html' && r.size === Buffer.byteLength(html, 'utf8'), r);
    check('블록에 들어갈 url = Drive 다운로드 주소', r.url === 'https://drive.google.com/uc?export=download&id=' + r.fileId, r.url);
    const f = g.drive.files[r.fileId];
    const folderId = g.props().getProperty('REVIEW_FILE_FOLDER_ID');
    check('전용 폴더에 저장, 폴더 ID를 Script Properties에 기록', f && folderId && f._parent === folderId && g.drive.folders[folderId].getName() === '공동구매_회고_첨부파일');
    check('조직 내 링크 공유(보기)', f && JSON.stringify(f._sharing) === JSON.stringify(['DOMAIN_WITH_LINK', 'VIEW']), f && f._sharing);
    g.call('review_uploadFile', { name: 'b.HTM', content: 'x' });
    check('두 번째 업로드는 같은 폴더(폴더 1개)', Object.keys(g.drive.folders).length === 1);
    check('.HTM(대문자)도 허용', Object.keys(g.drive.files).length === 2);
  }

  console.log('\n[3] review_getFile — 회고 첨부 폴더 안의 파일만');
  {
    const g = env();
    check('폴더가 아직 없으면 거절(폴더를 만들지 않음)', g.call('review_getFile', { fileId: 'FILE000000000001' }).code === 'NOT_FOUND' && !Object.keys(g.drive.folders).length);
    const outsideFolder = g.drive.mkFolder('남의 폴더');
    const outside = outsideFolder.createFile(Object.assign(g.ctx.Utilities.newBlob('<p>secret</p>'), { _name: 'secret.html' }));
    check('첨부 폴더가 없을 때 남의 파일 → FORBIDDEN', g.call('review_getFile', { fileId: outside.getId() }).code === 'FORBIDDEN');

    const html = '<!doctype html><h1>한글 차트 ✓</h1>';
    const up = g.call('review_uploadFile', { name: 'c.html', content: html });
    const got = g.call('review_getFile', { fileId: up.fileId });
    check('올린 원문 그대로(UTF-8)', got.success && got.content === html && got.name === 'c.html', got);
    const sameName = g.drive.mkFolder('공동구매_회고_첨부파일').createFile(Object.assign(g.ctx.Utilities.newBlob('<p>x</p>'), { _name: 'x.html' }));
    check('같은 이름의 다른 폴더 파일 → FORBIDDEN(이름이 아니라 ID로 판정)', g.call('review_getFile', { fileId: sameName.getId() }).code === 'FORBIDDEN');
    check('첨부 폴더 밖 파일 → FORBIDDEN, 원문 없음', (() => { const r = g.call('review_getFile', { fileId: outside.getId() }); return r.code === 'FORBIDDEN' && r.content === undefined; })());
    check('잘못된 ID 형식 → BAD_ID', g.call('review_getFile', { fileId: '../x' }).code === 'BAD_ID' && g.call('review_getFile', {}).code === 'BAD_ID');
    check('없는 파일 → NOT_FOUND', g.call('review_getFile', { fileId: 'NOPE00000000000' }).code === 'NOT_FOUND');
    g.drive.files[up.fileId]._trashed = true;
    check('휴지통 파일 → NOT_FOUND', g.call('review_getFile', { fileId: up.fileId }).code === 'NOT_FOUND');
    const five = g.call('review_uploadFile', { name: 'five.html', content: 'x'.repeat(5 * 1024 * 1024) });
    check('정확히 5MB는 미리보기 허용', g.call('review_getFile', { fileId: five.fileId }).success === true);
    const over = g.call('review_uploadFile', { name: 'over.html', content: 'x'.repeat(5 * 1024 * 1024 + 1) });
    const r = g.call('review_getFile', { fileId: over.fileId });
    check('5MB 초과는 업로드는 되고 조회는 TOO_LARGE', over.success && r.code === 'TOO_LARGE' && r.content === undefined, r);
  }

  console.log('\n[4] 프론트 로직 — htmlEmbed.js');
  const M = await import(pathToFileURL(path.join(PROJ, 'review-app', 'src', 'htmlEmbed.js')).href);
  {
    check('isHtmlName: .html/.htm·대소문자·쿼리', M.isHtmlName('a.html') && M.isHtmlName('A.HTM') && M.isHtmlName('x/a.html?x=1') && !M.isHtmlName('a.html.pdf') && !M.isHtmlName(''));
    const blk = (props) => ({ type: 'file', props: Object.assign({ name: '', url: '' }, props) });
    check('운영의 file:/// HTML 블록도 임베드 대상', M.isHtmlFileBlock(blk({ name: 'chart1-lovejina-full-trend.html', url: 'file:///C:/Users/USER/Downloads/chart1-lovejina-full-trend.html' })));
    check('PDF·이미지 블록은 대상 아님', !M.isHtmlFileBlock(blk({ name: 'a.pdf', url: 'https://x/a.pdf' })) && !M.isHtmlFileBlock({ type: 'image', props: { name: 'a.html', url: '' } }));
    check('htmlSource: 업로드 주소 → drive', JSON.stringify(M.htmlSource('https://drive.google.com/uc?export=download&id=1AbC_def-GHIJ')) === '{"kind":"drive","fileId":"1AbC_def-GHIJ"}');
    check('htmlSource: /file/d/ 형식도', M.htmlSource('https://drive.google.com/file/d/1AbC_def-GHIJ/view').fileId === '1AbC_def-GHIJ');
    check('htmlSource: file:/// → local, 기타 → other', M.htmlSource('file:///C:/a.html').kind === 'local' && M.htmlSource('https://evil.example/a.html').kind === 'other' && M.htmlSource('https://drive.google.com.evil.example/uc?id=1AbC_def-GHIJ').kind === 'other');

    const doc = M.buildSrcdoc('<!doctype html><p>x</p>');
    check('srcdoc = 원문 + 끝에 높이 보고 스크립트', doc.startsWith('<!doctype html><p>x</p><script>') && doc.includes('ResizeObserver') && doc.includes('parent.postMessage') && doc.includes(M.HEIGHT_MSG_TYPE));
    const win = {}, other = {};
    const msg = (source, data) => ({ source, data });
    check('높이 메시지: 그 iframe이 보낸 숫자만', M.heightFromMessage(msg(win, { type: M.HEIGHT_MSG_TYPE, height: 523 }), win) === 523);
    check('다른 창이 보낸 같은 모양 → 무시', M.heightFromMessage(msg(other, { type: M.HEIGHT_MSG_TYPE, height: 523 }), win) === null);
    check('타입 다름·문자열·음수·NaN·iframe 없음 → 무시',
      M.heightFromMessage(msg(win, { type: 'x', height: 5 }), win) === null && M.heightFromMessage(msg(win, 'rv2-html-embed:height'), win) === null &&
      M.heightFromMessage(msg(win, { type: M.HEIGHT_MSG_TYPE, height: -4 }), win) === null && M.heightFromMessage(msg(win, { type: M.HEIGHT_MSG_TYPE, height: 'abc' }), win) === null &&
      M.heightFromMessage(msg(win, { type: M.HEIGHT_MSG_TYPE, height: 10 }), null) === null);
    check('clampHeight 200~1600', M.clampHeight(10) === 200 && M.clampHeight(99999) === 1600 && M.clampHeight(640.4) === 640);
  }
  {
    const calls = [];
    let failNext = false;
    const bridge = {
      getGasUrl: () => 'https://script.google.com/macros/s/X/exec', getToken: () => 'TOKEN-1',
      gasFetch: async (url, opts) => {
        calls.push({ url, opts, body: JSON.parse(opts.body) });
        const b = JSON.parse(opts.body);
        if (failNext) { failNext = false; return { error: '일시 오류' }; }
        if (b.action === 'review_getFile') return { success: true, content: '<p>' + b.data.fileId + '</p>' };
        if (b.action === 'review_uploadFile') return { success: true, name: b.data.name, url: 'https://drive.google.com/uc?export=download&id=UP' + calls.length + 'xxxxxxxxxx' };
        return { error: 'x' };
      }
    };
    M.setHtmlEmbedBridge(bridge);
    const u = 'https://drive.google.com/uc?export=download&id=FILEAAAAAAAAAA';
    const c1 = await M.loadHtmlContent(u);
    check('원문 조회 = doPost review_getFile, 세션은 본문에·URL엔 없음', c1 === '<p>FILEAAAAAAAAAA</p>' && calls[0].opts.method === 'POST' && calls[0].body.action === 'review_getFile' && calls[0].body.session === 'TOKEN-1' && !/session=/.test(calls[0].url));
    await M.loadHtmlContent(u);
    check('같은 파일은 세션 캐시(재요청 없음)', calls.length === 1);
    const u2 = 'https://drive.google.com/uc?export=download&id=FILEBBBBBBBBBB';
    failNext = true;
    let e1 = null; try { await M.loadHtmlContent(u2); } catch (e) { e1 = e; }
    await M.loadHtmlContent(u2);
    check('실패는 캐시하지 않음(다음에 다시 요청)', e1 && calls.length === 3);
    let e2 = null; try { await M.loadHtmlContent('file:///C:/Users/USER/Downloads/a.html'); } catch (e) { e2 = e; }
    check('file:/// 는 요청 없이 LOCAL 오류', e2 && e2.code === 'LOCAL' && calls.length === 3);

    const fakeFile = (name, size, text) => ({ name, size, type: 'text/html', text: async () => text });
    let e3 = null; try { await M.uploadHtmlFile(bridge, fakeFile('huge.html', 20 * 1024 * 1024 + 1, '')); } catch (e) { e3 = e; }
    check('20MB 초과는 요청 전에 거절', e3 && /20MB/.test(e3.message) && calls.length === 3);
    const r = await M.uploadHtmlFile(bridge, fakeFile('a.html', 100, '<p>방금 올림</p>'));
    check('업로드 = review_uploadFile(이름·원문)', calls[3].body.action === 'review_uploadFile' && calls[3].body.data.name === 'a.html' && calls[3].body.data.content === '<p>방금 올림</p>' && !r.tooLarge);
    check('방금 올린 원문은 캐시 — 미리보기에 재요청 없음', (await M.loadHtmlContent(r.url)) === '<p>방금 올림</p>' && calls.length === 4);
    const r2 = await M.uploadHtmlFile(bridge, fakeFile('b.html', 5 * 1024 * 1024 + 1, 'x'));
    check('5MB 초과는 tooLarge(파일 블록으로 첨부)', r2.tooLarge === true);
    const bridgeOld = Object.assign({}, bridge, { gasFetch: async () => ({ error: 'Error: doPost는 presence·offline_ 전용입니다(파트 홈 home_ 포함) — 그 외 액션(review_uploadFile)은 doGet(GET)으로 보내야 합니다.' }) });
    let e4 = null; try { await M.uploadHtmlFile(bridgeOld, fakeFile('c.html', 10, 'x')); } catch (e) { e4 = e; }
    check('옛 GAS 배포본이면 재배포 안내 문구', e4 && /새 버전 배포가 필요/.test(e4.message), e4 && e4.message);
  }

  console.log('\n[5] 보안 정적 검사 — review-app/src');
  {
    const dir = path.join(PROJ, 'review-app', 'src');
    const src = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    const block = fs.readFileSync(path.join(dir, 'htmlEmbedBlock.jsx'), 'utf8');
    const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); // 주석 제외(주석엔 금지 목록이 설명으로 적혀 있다)
    check("sandbox 값은 'allow-scripts' 하나", /const SANDBOX = 'allow-scripts';/.test(block) && (block.match(/sandbox=\{SANDBOX\}/g) || []).length === 2 && !/sandbox="/.test(code(block)));
    check('allow-same-origin·top-navigation·forms·popups가 코드에 없음', !/allow-(same-origin|top-navigation|forms|popups|modals)/.test(code(src)));
    check('blob URL·createObjectURL로 여는 경로 없음', !/createObjectURL|blob:/.test(code(src)));
    check('iframe은 srcDoc로만(src 속성 없음)', !/<iframe[^>]*\ssrc=/.test(block));
    check('새 창은 noopener', /window\.open\(url, '_blank', 'noopener,noreferrer'\)/.test(block));
    check('schema가 file 블록을 교체', /file: htmlAwareFileBlockSpec/.test(fs.readFileSync(path.join(dir, 'schema.js'), 'utf8')));
  }

  console.log('\n통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
