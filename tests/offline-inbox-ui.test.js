/* 데이터 업로드 화면 — "자동 반영" 상태 패널 · [지금 확인] · 업로드로그 방식 열 (2026-10-06)
   index.html이 싣는 실코드 그대로, 서버 호출(_offlineCall)만 가짜로 바꿔 돌린다.

   지키려는 성질:
     · 페이지에 들어오면 offline_getInboxStatus도 받아 맨 위 패널에 그린다 — 사용 여부·시각 범위·회당 최대·보관일수, 트리거 설치 여부,
       수신함 폴더 링크, 마지막 실행(언제·누가·반영·오류·건너뜀·다음 실행으로·휴지통·Sheets API 호출·한도 초과 대체), 경고(이동·휴지통 실패), 파일별 결과
     · 꺼짐·트리거 없음·폴더 미등록은 눈에 띄게, 폴더가 없으면 [지금 확인]을 막는다
     · [지금 확인] = offline_processInbox(긴 요청 타임아웃) → 결과 알림 → 상태·로그를 다시 받는다. 도는 동안 버튼은 "확인 중…"으로 막힌다
     · 업로드로그 표에 방식 열(자동 반영 / 수동)과 수신함처리 사유
     · 파일명·사유 같은 외부 문자열은 HTML로 해석되지 않는다

   실행: node tests/offline-inbox-ui.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadFrontend } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
const PROJ = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 700) : '')); }
}
const tick = () => new Promise(r => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 10; i++) await tick(); }
const SHIM = 'get UP(){return _UP;}, get LONG(){return OFFLINE_LONG_ACTIONS;}';

const LAST = { at: '2026-10-06 09:00:12', by: 'trigger', counts: { success: 3, error: 1, skipped: 2, deferred: 4 }, trashed: 1, apiCalls: 25, apiFallbacks: 2,
  note: '회당 최대 3개 — 남은 파일은 다음 실행에서', warnings: ['<b>a.xlsx</b> — 처리완료 폴더로 옮기지 못함(콘텐츠 관리자 권한 필요): denied'],
  files: [{ name: '기간별매출(상품별)_일별상세_<i>x</i>.xlsx', result: 'success', detail: '판매 467행 · 미매칭 2개' }, { name: '알수없는파일.xlsx', result: 'error', detail: '판별 불가 — 알 수 없는 파일 형식' },
    { name: 'dup.xlsx', result: 'skipped', detail: '이미 반영한 파일' }, { name: 'late.xlsx', result: 'deferred', detail: '다른 반영이 진행 중' }] };
const STATUS = (o) => Object.assign({ success: true, folderId: 'INBOX', folderUrl: 'https://drive.google.com/drive/folders/INBOX', triggerInstalled: true, apiPerMin: 30,
  settings: { enabled: true, startHour: 7, endHour: 22, keepDays: 30, maxFiles: 10 }, last: LAST }, o || {});

function setup(statusOver) {
  const { ctx, X } = loadFrontend(PROJ, SHIM);
  const box = {};
  ctx.document.getElementById = id => (box[id] = box[id] || { id, innerHTML: '', value: '', textContent: '', className: '', style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } } });
  const calls = [], toasts = [];
  let inboxStatus = STATUS(statusOver), release = null;
  const replies = {
    offline_getStatus: () => ({ success: true, today: '2026-10-06', month: '2026-10', channels: [] }),
    offline_getUploadLog: () => ({ success: true, items: [
      { uploadId: 'U2', at: '2026-10-06 09:00:10', uploader: 'partner@athomecorp.com', fileName: '판매재고현황_20261005.xlsx', fileType: 'HIMART_SALES_STOCK', channelId: 'himart', range: '2026-10-05',
        rawRows: 10, appliedRows: 8, unmatched: 0, warnings: '', status: '성공', mode: 'auto', inboxNote: '처리완료 폴더로 옮기지 못함(콘텐츠 관리자 권한 필요): <b>x</b>' },
      { uploadId: 'U1', at: '2026-10-05 18:00:00', uploader: 'tester@athomecorp.com', fileName: '현재고.xls', fileType: 'ETLAND_STOCK', channelId: 'etland', range: '2026-10-04',
        rawRows: 5, appliedRows: 5, unmatched: 0, warnings: '', status: '성공', mode: 'manual', inboxNote: '' }] }),
    offline_getMasters: () => ({ success: true, skus: [], channels: [], channelCategories: [], mappings: [], stores: [], productLines: [], stockTypes: [] }),
    offline_getInboxStatus: () => inboxStatus,
    offline_processInbox: () => new Promise(res => { release = () => res({ success: true, counts: { success: 2, error: 0, skipped: 1, deferred: 0 } }); })
  };
  ctx._offlineCall = async (action, data) => { calls.push(action); return replies[action](data || {}); };
  ctx.showToast = (m, o) => { toasts.push([m, o && o.type]); };
  return { ctx, X, calls, toasts, page: () => box['page-admin-upload'].innerHTML, setStatus: s => { inboxStatus = s; }, release: () => release && release() };
}

(async function main() {
  console.log('\n[1] 상태 패널 — 켜짐·트리거·폴더·마지막 실행·경고·파일별 결과');
  {
    const { ctx, calls, page } = setup();
    ctx.navPage('admin-upload', null);
    await settle();
    const h = page();
    check('들어오면 offline_getInboxStatus도 받는다', calls.indexOf('offline_getInboxStatus') >= 0, calls);
    check('맨 위 "자동 반영" 카드 — 데이터 현황보다 먼저', h.indexOf('자동 반영') >= 0 && h.indexOf('자동 반영') < h.indexOf('데이터 현황'));
    check('켜짐 · 7~22시 1시간마다 · 회당 최대 10개 · 처리완료 보관 30일 · 트리거 설치됨', /켜짐<\/span> · 7~22시 1시간마다 · 회당 최대 10개 · 처리완료 보관 30일 · 트리거 설치됨/.test(h));
    check('수신함 폴더 링크(새 탭)', h.indexOf('<a href="https://drive.google.com/drive/folders/INBOX" target="_blank" rel="noopener">수신함 폴더 열기</a>') >= 0);
    check('마지막 실행 — 시각·자동(1시간마다)·반영 3·오류 1·건너뜀 2·다음 실행으로 4·휴지통 1·Sheets API 25회·한도 초과 대체 2회',
      /마지막 실행 <b>2026-10-06 09:00:12<\/b> \(자동\(1시간마다\)\) · 반영 <b>3<\/b> · 오류 <b class="off-miss">1<\/b> · 건너뜀 <b>2<\/b> · 다음 실행으로 <b>4<\/b> · 보관일수 지나 휴지통 <b>1<\/b> · Sheets API <b>25<\/b>회 · <span class="off-miss">한도 초과로 이전 방식 대체 2회<\/span>/.test(h),
      h.slice(h.indexOf('마지막 실행'), h.indexOf('마지막 실행') + 400));
    check('안내(회당 최대)·경고(이동 실패)', h.indexOf('회당 최대 3개 — 남은 파일은 다음 실행에서') >= 0 && h.indexOf('처리완료 폴더로 옮기지 못함(콘텐츠 관리자 권한 필요)') >= 0);
    check('파일별 결과 칩 — 반영·오류·건너뜀·다음 실행', ['up-chip done">반영', 'up-chip error">오류', 'up-chip ready">건너뜀', 'up-chip applying">다음 실행'].every(s => h.indexOf(s) >= 0));
    check('파일명·경고의 HTML은 글자 그대로(<i>·<b>가 태그가 되지 않음)', h.indexOf('<i>x</i>') < 0 && h.indexOf('&lt;i&gt;x&lt;/i&gt;') >= 0 && h.indexOf('<b>a.xlsx</b>') < 0);
    check('[지금 확인] 버튼 + 콘텐츠 관리자 권한 안내', /onclick="_upInboxRun\(\)">지금 확인<\/button>/.test(h) && h.indexOf('콘텐츠 관리자 이상 권한') >= 0);
  }

  console.log('\n[2] 꺼짐 · 트리거 없음 · 폴더 미등록 · 실행 기록 없음 · 상태를 못 받음');
  {
    const a = setup({ settings: { enabled: false, startHour: 7, endHour: 22, keepDays: 30, maxFiles: 10 }, triggerInstalled: false, last: null });
    a.ctx.navPage('admin-upload', null); await settle();
    const h = a.page();
    check('꺼짐 — 설정 탭 자동반영_사용 = N ([지금 확인]은 된다) · 트리거 없음 안내', /off-miss">꺼짐<\/span> — 설정 탭 자동반영_사용 = N/.test(h) && h.indexOf('트리거 없음 — 편집기에서 offline_installInboxTrigger 실행') >= 0);
    check('실행 기록 없음 안내', h.indexOf('아직 실행 기록이 없습니다') >= 0);
    const b = setup({ folderId: '', folderUrl: '' });
    b.ctx.navPage('admin-upload', null); await settle();
    check('폴더 미등록 — 안내 + [지금 확인] 막힘', b.page().indexOf('수신함 폴더 미등록 — Script Properties OFFLINE_INBOX_FOLDER_ID') >= 0 && /disabled onclick="_upInboxRun\(\)"/.test(b.page()));
    const c = setup();
    c.ctx._offlineCall = async action => { if (action === 'offline_getInboxStatus') throw new Error('권한'); return { success: true, items: [], channels: [], month: '2026-10' }; };
    c.ctx.navPage('admin-upload', null); await settle();
    check('상태를 못 받아도 나머지 화면은 그린다(패널에 오류만)', c.page().indexOf('자동 반영 상태를 불러오지 못했습니다: 권한') >= 0 && c.page().indexOf('데이터 현황') >= 0);
  }

  console.log('\n[3] [지금 확인] — offline_processInbox(긴 요청) → 알림 → 상태·로그 다시 받기');
  {
    const { ctx, X, calls, toasts, page, setStatus, release } = setup();
    check('offline_processInbox는 긴 요청 타임아웃(업로드와 같은 5분)', X.LONG.offline_processInbox === true);
    ctx.navPage('admin-upload', null); await settle();
    const n0 = calls.length;
    const p = ctx._upInboxRun();
    await settle();
    check('도는 동안 "확인 중…"으로 막힘 · 두 번 눌러도 한 번만', /disabled onclick="_upInboxRun\(\)">확인 중… \(몇 분 걸릴 수 있음\)/.test(page()) &&
      (ctx._upInboxRun(), calls.filter(c => c === 'offline_processInbox').length === 1));
    setStatus(STATUS({ last: Object.assign({}, LAST, { at: '2026-10-06 10:31:00', by: 'manual:tester@athomecorp.com', counts: { success: 2, error: 0, skipped: 1, deferred: 0 } }) }));
    release(); await p; await settle();
    check('끝나면 결과 알림(반영 2 · 오류 0 · 건너뜀 1)', toasts.some(t => /수신함 확인 — 반영 2 · 오류 0 · 건너뜀 1 · 다음 실행으로 0/.test(t[0]) && t[1] === 'success'), toasts);
    check('  ↳ 상태·로그를 다시 받아 새 실행이 보인다(지금 확인 · 실행한 사람)', calls.slice(n0).indexOf('offline_getInboxStatus') >= 0 && calls.slice(n0).indexOf('offline_getUploadLog') >= 0 &&
      page().indexOf('2026-10-06 10:31:00') >= 0 && page().indexOf('지금 확인 · tester@athomecorp.com') >= 0);
    // 이미 실행 중이면
    const b = setup();
    b.ctx._offlineCall = async action => (action === 'offline_processInbox' ? { success: true, busy: true, message: '다른 수신함 확인이 진행 중입니다 — 잠시 후 다시 보세요.' } : (action === 'offline_getInboxStatus' ? STATUS() : { success: true, items: [], channels: [], month: '2026-10' }));
    b.ctx.navPage('admin-upload', null); await settle();
    await b.ctx._upInboxRun();
    check('서버가 이미 실행 중이라고 하면 그 안내', b.toasts.some(t => /다른 수신함 확인이 진행 중/.test(t[0])));
  }

  console.log('\n[4] 업로드로그 표 — 방식 열 · 수신함처리 사유');
  {
    const { ctx, page } = setup();
    ctx.navPage('admin-upload', null); await settle();
    const h = page(), log = h.slice(h.indexOf('최근 업로드 로그'));
    check('방식 열 머리 — 시각 다음', /<th>시각<\/th><th>방식<\/th><th>파일명<\/th>/.test(log));
    check('자동 반영 칩 / 수동', log.indexOf('<span class="up-chip done">자동 반영</span>') >= 0 && log.indexOf('<span class="off-muted">수동</span>') >= 0);
    check('수신함처리 사유를 경고 칸에(HTML은 글자 그대로)', log.indexOf('처리완료 폴더로 옮기지 못함(콘텐츠 관리자 권한 필요): &lt;b&gt;x&lt;/b&gt;') >= 0);
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})();
