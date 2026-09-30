// 회고 HTML 임베드 — React와 무관한 로직만 모음(블록 판정·srcdoc 조립·높이 메시지 검증·원문 로딩/업로드).
// 화면은 htmlEmbedBlock.jsx. 원문은 Drive(GAS 경유)에만 있고, 회고 본문에는 파일 참조(URL)만 저장한다
// — 45,000자 분할 저장되는 본문에 수 MB짜리 HTML이 들어가지 않게.

export const PREVIEW_MAX_BYTES = 5 * 1024 * 1024; // 넘으면 미리보기 없이 파일 블록으로(서버도 같은 값으로 거절)
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const HEIGHT_MIN = 200;
export const HEIGHT_MAX = 1600; // 넘는 내용은 iframe 안에서 스크롤
export const HEIGHT_INITIAL = 400; // 높이 메시지가 오기 전(또는 스크립트가 막힌 문서)의 높이
export const HEIGHT_MSG_TYPE = 'rv2-html-embed:height';
const UPLOAD_TIMEOUT_MS = 120000;
const LOAD_TIMEOUT_MS = 45000;

export function isHtmlName(s) {
  return /\.html?$/i.test(String(s || '').split(/[?#]/)[0]);
}

export function isHtmlFile(file) {
  return !!file && (file.type === 'text/html' || isHtmlName(file.name));
}

// 이름이나 URL이 .html/.htm이면 임베드 대상 — 예전에 올린(또는 링크로 넣은) HTML 파일 블록도 그대로 잡힌다
export function isHtmlFileBlock(block) {
  return !!block && block.type === 'file' && (isHtmlName(block.props.name) || isHtmlName(block.props.url));
}

// 원문을 읽을 수 있는 곳 — 'drive'만 실제로 읽는다. 'local'(file:///… 작성자 PC 경로)은 누구의 브라우저도
// 읽을 수 없고, 그 밖의 URL은 회고 첨부 폴더 밖이라 서버가 거절한다.
export function htmlSource(url) {
  const s = String(url || '');
  if (/^https:\/\/(drive|docs)\.google\.com\//.test(s)) {
    const m = s.match(/[?&]id=([A-Za-z0-9_-]{10,})/) || s.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
    if (m) return { kind: 'drive', fileId: m[1] };
  }
  if (/^file:/i.test(s)) return { kind: 'local' };
  return { kind: 'other' };
}

// srcdoc 끝에 붙이는 높이 보고 스크립트. iframe은 sandbox="allow-scripts"(allow-same-origin 없음)라
// 부모 DOM을 볼 수 없으므로, 문서가 스스로 재서 postMessage로 알린다. html의 실제 높이와 body의 스크롤
// 높이 중 큰 값 — documentElement.scrollHeight는 iframe 높이 밑으로 안 줄어들어 한 번 커지면 못 줄인다.
const HEIGHT_REPORTER =
  '<script>(function(){var last=0;function send(){var d=document.documentElement,b=document.body;' +
  'var h=Math.ceil(Math.max(d.getBoundingClientRect().height,b?b.scrollHeight:0));' +
  'if(h&&h!==last){last=h;parent.postMessage({type:"' + HEIGHT_MSG_TYPE + '",height:h},"*");}}' +
  'if(window.ResizeObserver){var ro=new ResizeObserver(send);ro.observe(document.documentElement);if(document.body)ro.observe(document.body);}' +
  'window.addEventListener("load",send);send();})();<\/script>';

export function buildSrcdoc(html) {
  return String(html) + HEIGHT_REPORTER;
}

// 부모가 받는 메시지 중 "그 iframe이 보낸 높이"만 통과 — 출처(event.source)가 다르거나 모양이 다르면 null.
// 높이 외의 값은 절대 쓰지 않는다(임베드된 HTML도 같은 모양의 메시지를 보낼 수 있으니 숫자로만 취급).
export function heightFromMessage(event, frameWindow) {
  if (!frameWindow || !event || event.source !== frameWindow) return null;
  const d = event.data;
  if (!d || typeof d !== 'object' || d.type !== HEIGHT_MSG_TYPE) return null;
  const h = Number(d.height);
  return Number.isFinite(h) && h > 0 ? h : null;
}

export function clampHeight(h) {
  return Math.min(HEIGHT_MAX, Math.max(HEIGHT_MIN, Math.round(h)));
}

// 블록 렌더는 BlockNote 스키마(모듈 전역)에서 만들어져 bridge를 props로 받을 수 없다 — main.jsx의 mount가 넣어준다
let _bridge = null;
export function setHtmlEmbedBridge(bridge) {
  _bridge = bridge;
}

// offline_*과 같은 doPost 창구(본문 JSON, 세션은 URL이 아니라 본문에). _gasFetch의 재시도·세션 연장을 그대로 탄다.
async function reviewPost(bridge, action, data, timeoutMs) {
  if (!bridge || !bridge.getGasUrl() || !bridge.getToken()) throw new Error('로그인이 필요합니다.');
  const body = JSON.stringify({ action, session: bridge.getToken(), data });
  const j = await bridge.gasFetch(bridge.getGasUrl(), { method: 'POST', body, _timeoutMs: timeoutMs });
  if (!j) throw new Error('서버 응답이 비었습니다.');
  if (j.error) {
    let msg = j.error;
    if (j.error === 'AUTH_REQUIRED') msg = '세션이 만료되었습니다. 다시 로그인해주세요.';
    // review_ 라우팅이 없는 옛 배포본은 doPost가 이 문구로 거절한다
    else if (/presence·offline_ 전용/.test(j.error)) msg = 'Apps Script 배포본에 회고 첨부 기능이 아직 없습니다 — apps-script.js 갱신 후 새 버전 배포가 필요합니다.';
    const err = new Error(msg);
    err.code = j.code || '';
    throw err;
  }
  return j;
}

// 세션 동안 같은 파일은 한 번만 받는다(블록을 옮기거나 편집기가 다시 만들어져도 재요청 없음). 실패는 캐시하지 않는다.
const contentCache = new Map(); // url → Promise<string>

export function loadHtmlContent(url) {
  if (contentCache.has(url)) return contentCache.get(url);
  const src = htmlSource(url);
  const p =
    src.kind === 'drive'
      ? reviewPost(_bridge, 'review_getFile', { fileId: src.fileId }, LOAD_TIMEOUT_MS).then((j) => {
          if (typeof j.content !== 'string') throw new Error('서버 응답이 올바르지 않습니다.');
          return j.content;
        })
      : Promise.reject(Object.assign(new Error('회고에 업로드된 파일이 아니라 원문을 읽을 수 없습니다.'), { code: src.kind === 'local' ? 'LOCAL' : 'OTHER' }));
  contentCache.set(url, p);
  p.catch(() => {
    if (contentCache.get(url) === p) contentCache.delete(url);
  });
  return p;
}

// BlockNote uploadFile에서 호출 — 반환값은 블록에 그대로 들어갈 props({url, name[, embedView]}).
export async function uploadHtmlFile(bridge, file) {
  if (file.size > UPLOAD_MAX_BYTES) throw new Error('HTML 파일이 너무 큽니다 (20MB 초과)');
  const content = await file.text();
  const j = await reviewPost(bridge, 'review_uploadFile', { name: file.name, content }, UPLOAD_TIMEOUT_MS);
  if (!j.url) throw new Error('서버 응답이 올바르지 않습니다.');
  const tooLarge = file.size > PREVIEW_MAX_BYTES;
  if (!tooLarge) contentCache.set(j.url, Promise.resolve(content)); // 방금 올린 원문 — 미리보기에 바로 씀
  return { url: j.url, name: j.name || file.name, tooLarge };
}
