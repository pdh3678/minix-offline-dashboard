/* 오프라인 GAS API — doPost 라우팅부터 응답까지 실코드로(HTTP만 생략).

   지키려는 성질:
     · offline_* 는 세션 필수 — 세션 없음/위조면 오프라인 코드에 닿기 전에 AUTH_REQUIRED
     · 쓰기(업로드·SKU·매핑)는 요청 본문이 아니라 **세션의 이메일**을 기록한다
     · getMasters는 캐시되고, 쓰기 후에는 무효화돼 새 값이 나온다
     · SKU: SKU-0001부터 자동 번호, 품목군은 공유 상수(PRODUCT_CATALOG)의 값만 — 두 목록이 같아야 한다
     · 매핑: (채널, 원본코드) upsert·여러 건 한 번에·비활성화(sku_id 비움 + 미매칭 복귀)
     · 미매칭 목록·업로드 로그 최근 50건·상태(마지막 기준일, 이번 달 빈 날짜)
     · 프론트 클라이언트는 POST 본문(text/plain)에 세션을 싣고 URL에는 싣지 않는다

   실행: node tests/offline-api.test.js  (또는 node tests/run-all.js) */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { loadOfflineGas, dataRows, PROJ } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const P = require(path.join(PROJ, 'src', 'features', 'offline', 'parsers.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const TODAY = '2026-09-27';
const EMAIL = 'uploader@athomecorp.com';

// 유효한 세션을 하나 만들어 토큰을 돌려준다(로그인 경로는 session-auth.test.js가 따로 검증)
function session(ctx, email) {
  const sheet = ctx._sessionSheet(ctx.SpreadsheetApp.getActiveSpreadsheet());
  const now = Date.now(), sid = 'sid-' + Math.random().toString(36).slice(2);
  sheet.appendRow([sid, email, '업로더', now, now + 3600e3 * 12, now]);
  return ctx._signSessionToken({ sid, email, name: '업로더', exp: now + 3600e3 * 12, iat: now, kv: 1 });
}
function post(ctx, body) {
  return JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) }, parameter: {} }));
}
function env(today) {
  const g = loadOfflineGas({ setup: true, today: today || TODAY });
  const token = session(g.ctx, EMAIL);
  g.call = (action, data, extra) => post(g.ctx, Object.assign({ action, session: token, data }, extra || {}));
  return g;
}

(function main() {
  console.log('\n[1] 라우팅·인증');
  {
    const g = env();
    check('세션 없음 → AUTH_REQUIRED', post(g.ctx, { action: 'offline_getMasters' }).error === 'AUTH_REQUIRED');
    check('위조 토큰 → AUTH_REQUIRED', post(g.ctx, { action: 'offline_getMasters', session: 'x.y' }).error === 'AUTH_REQUIRED');
    const m = g.call('offline_getMasters');
    check('세션 있으면 offline_getMasters 성공', m.success === true && Array.isArray(m.channels), m);
    check('모르는 offline_ 액션은 오류', /알 수 없는 오프라인 액션/.test(g.call('offline_nope').error));
    check('presence는 그대로 doPost', g.call('presence').success === true);
    check('그 외 액션은 여전히 거절(GET으로 보내야)', /presence·offline_ 전용/.test(g.call('updateDeal').error));
    check('응답에 서버 버전', m.version === g.ctx.SCRIPT_VERSION);
  }

  console.log('\n[2] offline_getMasters — 캐시와 무효화');
  {
    const g = env();
    const m1 = g.call('offline_getMasters');
    check('채널 10개·빈 제품/매핑·점포는 ERP 거래처 9곳뿐·품목군·재고구분', m1.channels.length === 10 && !m1.skus.length && !m1.mappings.length && m1.stores.length === 9 && m1.stores.every(x => ['shinsegae', 'lotte_dept', 'theablen', 'workshop8', 'dapara'].indexOf(x.channelId) >= 0) &&
      m1.productLines.length === 8 && m1.stockTypes.join() === '정상,전시,리퍼', m1);
    check('채널 객체 모양(업로드시작월·원천업태명·점포명접두어·코드체계채널·재고기준일오프셋)', JSON.stringify(m1.channels[0]) === JSON.stringify({ channelId: 'himart', name: '하이마트', channelCategory: '양판점', active: 'Y', order: 1, uploadStartMonth: '2026-09', bizNames: '', storePrefix: '', codeSystem: 'himart', stockOffset: 0, inSource: 'input', aliases: [] }), m1.channels[0]);
    check('트레이더스 = 이마트 코드체계, 업태명 트레이더스', JSON.stringify(m1.channels.find(c => c.channelId === 'traders')) === JSON.stringify({ channelId: 'traders', name: '트레이더스', channelCategory: '할인점', active: 'Y', order: 4, uploadStartMonth: '2026-09', bizNames: '트레이더스', storePrefix: 'TR', codeSystem: 'emart', stockOffset: -1, inSource: 'input', aliases: [] }));
    check('업로드 없는 채널은 업로드시작월 빈칸', m1.channels.find(c => c.channelId === 'special').uploadStartMonth === '');
    check('두 번째는 캐시', g.call('offline_getMasters').cached === true);
    g.call('offline_saveSku', { sku: { name: '더 플렌더 MAX 그레이지', line: '더플렌더', model: '더 플렌더 MAX', option: '그레이지' } });
    const m3 = g.call('offline_getMasters');
    check('쓰기 후에는 캐시가 아니라 새 값', !m3.cached && m3.skus.length === 1, m3.skus);
  }

  console.log('\n[3] offline_saveSku');
  {
    const g = env();
    const a = g.call('offline_saveSku', { sku: { name: '더 플렌더 MAX 그레이지', line: '더플렌더', model: '더 플렌더 MAX', option: '그레이지', order: 3 } });
    const b = g.call('offline_saveSku', { sku: { name: '미니 건조기', line: '미니건조기' } });
    check('SKU-0001, SKU-0002 자동 번호', a.sku.skuId === 'SKU-0001' && b.sku.skuId === 'SKU-0002', [a, b]);
    check('기본 활성 Y', a.sku.active === 'Y' && b.sku.active === 'Y');
    const u = g.call('offline_saveSku', { sku: { skuId: 'SKU-0001', name: '더 플렌더 MAX (그레이지)', line: '더플렌더', model: '더 플렌더 MAX', option: '그레이지', active: 'N' } });
    const rows = dataRows(g.tab('제품마스터'));
    check('수정: 같은 행을 고침(행 수 2)', u.success && rows.length === 2 && rows[0][1] === '더 플렌더 MAX (그레이지)' && rows[0][5] === 'N', rows);
    check('정렬순서 숫자', typeof rows[0][6] === 'number' || rows[0][6] === '', rows[0]);
    check('공유 상수에 없는 품목군 거절', /품목군/.test(g.call('offline_saveSku', { sku: { name: 'x', line: '더 플렌더' } }).error));
    check('없는 sku_id 수정 거절', /없는 sku_id/.test(g.call('offline_saveSku', { sku: { skuId: 'SKU-0099', name: 'x', line: '더슬림' } }).error));
    check('표준명 빈칸 거절', /표준명/.test(g.call('offline_saveSku', { sku: { name: ' ', line: '더슬림' } }).error));
    check('거절된 요청은 행을 늘리지 않음', dataRows(g.tab('제품마스터')).length === 2);
    g.tab('제품마스터')._grid[2][0] = 'SKU-0010';
    check('번호는 최댓값 다음(SKU-0011)', g.call('offline_saveSku', { sku: { name: 'y', line: '더슬림' } }).sku.skuId === 'SKU-0011');
  }

  console.log('\n[4] 품목군 목록이 프론트 PRODUCT_CATALOG와 같다');
  {
    const g = env();
    const box = { console };
    vm.runInContext(fs.readFileSync(path.join(PROJ, 'src', 'shared', 'constants', 'products.js'), 'utf8') + '\n;globalThis.__C = PRODUCT_CATALOG;', vm.createContext(box));
    const front = box.__C.map(l => l.key);
    check('OFFLINE_PRODUCT_LINES == PRODUCT_CATALOG 품목군 key', JSON.stringify(g.ctx.OFFLINE_PRODUCT_LINES) === JSON.stringify(front), { gas: g.ctx.OFFLINE_PRODUCT_LINES, front });
  }

  console.log('\n[5] offline_saveMapping — upsert·여러 건·비활성화');
  {
    const g = env();
    g.call('offline_saveSku', { sku: { name: '더 플렌더 MAX', line: '더플렌더' } });
    // 미매칭 코드를 먼저 만든다(업로드 경로)
    const rows = [['판매내역'], ['거래처코드', '거래처명', '지부', '지점코드', '지점명', '품목', '상품구분', '모델명', '설명', '판매수량', '단가', '금액', '판매일자', '구분'],
      ['1', 'x', '충청', '300001', '점', 'a', 'b', 'MNFD-200G', '가상 MAX', '1', '1', '1', '2026-09-02', '판매(계약)'],
      ['1', 'x', '충청', '300001', '점', 'a', 'b', 'MNFD-200G.DEMO', '가상 MAX 전시', '1', '1', '1', '2026-09-02', '판매(계약)'],
      ['1', 'x', '충청', '300001', '점', 'a', 'b', 'MNVC-100G', '가상 슬림', '1', '1', '1', '2026-09-02', '판매(계약)']];
    const up = g.call('offline_upload', P.toUploadPayload(P.parseRows(rows, { fileName: '판매내역_2026-09-25.xls', today: TODAY }), { fileName: '판매내역_2026-09-25.xls' }));
    check('업로드 성공, 미매칭 3', up.success && up.unmatched.length === 3, up);
    check('업로드로그 업로더 = 세션 이메일(본문에 다른 값을 넣어도)', dataRows(g.tab('업로드로그'))[0][2] === EMAIL);
    const s = g.call('offline_saveMapping', { items: [
      { op: 'upsert', channelId: 'etland', code: 'MNFD-200G', skuId: 'SKU-0001', stockType: '정상', name: '가상 MAX', registeredBy: 'hacker@x.com' },
      { op: 'upsert', channelId: 'etland', code: 'MNFD-200G.DEMO', skuId: 'SKU-0001', stockType: '전시', name: '가상 MAX 전시' }
    ] });
    check('두 건 저장', s.success && s.saved === 2, s);
    const map = dataRows(g.tab('코드매핑'));
    check('매핑 행: 채널·코드·SKU·재고구분·상품명·등록일·등록자(세션)', map.length === 2 && JSON.stringify(map[1].slice(0, 7)) ===
      JSON.stringify(['etland', 'MNFD-200G.DEMO', 'SKU-0001', '전시', '가상 MAX 전시', TODAY, EMAIL]), map);
    const un = g.call('offline_getUnmatched');
    check('매핑된 두 코드는 미매칭에서 빠짐', un.items.map(x => x.code).join() === 'MNVC-100G', un.items);
    g.call('offline_saveMapping', { items: [{ op: 'upsert', channelId: 'etland', code: 'MNFD-200G', skuId: 'SKU-0001', stockType: '리퍼' }] });
    check('같은 키는 수정(행 수 그대로, 상품명 유지)', dataRows(g.tab('코드매핑')).length === 2 && dataRows(g.tab('코드매핑'))[0][3] === '리퍼' && dataRows(g.tab('코드매핑'))[0][4] === '가상 MAX');
    const d = g.call('offline_saveMapping', { items: [{ op: 'deactivate', channelId: 'etland', code: 'MNFD-200G.DEMO' }] });
    const drow = dataRows(g.tab('코드매핑'))[1];
    check('비활성화: sku_id 비움, 비고에 날짜·이메일, 행은 남음', d.deactivated === 1 && drow[2] === '' && /비활성화 2026-09-27 uploader@/.test(drow[7]), drow);
    check('  ↳ 미매칭 목록으로 복귀(상품명 유지)', g.call('offline_getUnmatched').items.some(x => x.code === 'MNFD-200G.DEMO' && x.name === '가상 MAX 전시'));
    check('  ↳ getMasters의 매핑에는 sku_id 빈 채로 보임', g.call('offline_getMasters').mappings.find(m => m.code === 'MNFD-200G.DEMO').skuId === '');
    g.call('offline_saveMapping', { items: [{ op: 'upsert', channelId: 'etland', code: 'MNFD-200G.DEMO', skuId: 'SKU-0001', stockType: '전시' }] });
    check('다시 매핑하면 활성·미매칭에서 제거', dataRows(g.tab('코드매핑'))[1][2] === 'SKU-0001' && !g.call('offline_getUnmatched').items.some(x => x.code === 'MNFD-200G.DEMO'));
    check('없는 채널 거절', /채널마스터에 없는/.test(g.call('offline_saveMapping', { items: [{ channelId: 'coupang', code: 'A', skuId: 'SKU-0001' }] }).error));
    check('없는 SKU 거절', /제품마스터에 없는/.test(g.call('offline_saveMapping', { items: [{ channelId: 'etland', code: 'A', skuId: 'SKU-0404' }] }).error));
    check('재고구분 값 거절', /재고구분/.test(g.call('offline_saveMapping', { items: [{ channelId: 'etland', code: 'A', skuId: 'SKU-0001', stockType: '반품' }] }).error));
    check('매핑 없는 코드 비활성화 거절', /매핑이 없는/.test(g.call('offline_saveMapping', { items: [{ op: 'deactivate', channelId: 'etland', code: 'ZZ' }] }).error));
    check('빈 요청 거절', /저장할 매핑/.test(g.call('offline_saveMapping', { items: [] }).error));
    check('한 건이라도 잘못되면 아무것도 쓰지 않음', (() => {
      const before = JSON.stringify(dataRows(g.tab('코드매핑')));
      g.call('offline_saveMapping', { items: [{ channelId: 'etland', code: 'NEW1', skuId: 'SKU-0001' }, { channelId: 'etland', code: 'NEW2', skuId: 'SKU-0404' }] });
      return JSON.stringify(dataRows(g.tab('코드매핑'))) === before;
    })());
  }

  console.log('\n[6] offline_getUnmatched — 발견횟수 순');
  {
    const g = env();
    g.ctx._offWriteBlock(g.tab('미매칭코드'), g.ctx.OFF_TABS.unmatched, 2, [
      ['emart', 'A', 'a', '2026-09-01', '2026-09-20', 1], ['himart', 'B', 'b', '2026-09-01', '2026-09-25', 5], ['etland', 'C', 'c', '2026-09-01', '2026-09-26', 1]]);
    const items = g.call('offline_getUnmatched').items;
    check('발견횟수 내림차순, 같으면 최근발견일 최신 먼저', items.map(x => x.code).join() === 'B,C,A', items);
    check('항목 모양', JSON.stringify(items[0]) === JSON.stringify({ channelId: 'himart', code: 'B', name: 'b', firstSeen: '2026-09-01', lastSeen: '2026-09-25', count: 5 }), items[0]);
  }

  console.log('\n[7] offline_getUploadLog — 최근 50건, 최신 먼저');
  {
    const g = env();
    const rows = [];
    for (let i = 1; i <= 55; i++) rows.push(['U' + i, '2026-09-27 10:00:' + String(i).padStart(2, '0'), EMAIL, 'f' + i + '.xls', 'ETLAND_STOCK', 'etland', '2026-09-25', 1, 1, 0, '', '성공']);
    g.ctx._offWriteBlock(g.tab('업로드로그'), g.ctx.OFF_TABS.uploadLog, 2, rows);
    const items = g.call('offline_getUploadLog').items;
    check('50건', items.length === 50, items.length);
    check('최신(U55)이 먼저, 마지막은 U6', items[0].uploadId === 'U55' && items[49].uploadId === 'U6', [items[0].uploadId, items[49].uploadId]);
    check('필드', items[0].fileName === 'f55.xls' && items[0].rawRows === 1 && items[0].status === '성공' && items[0].range === '2026-09-25');
    check('빈 로그도 안전', env().call('offline_getUploadLog').items.length === 0);
  }

  console.log('\n[8] offline_getStatus — 마지막 기준일, 이번 달 빈 날짜(업로드로그 기준)');
  {
    const g = env();
    const log = (type, ch, range, status) => ['U', '2026-09-27 10:00:00', EMAIL, 'f', type, ch, range, 1, 1, 0, '', status || '성공'];
    g.ctx._offWriteBlock(g.tab('업로드로그'), g.ctx.OFF_TABS.uploadLog, 2, [
      log('ETLAND_SALES', 'etland', '2026-09-01~2026-09-24'), log('ETLAND_STOCK', 'etland', '2026-09-25'),
      log('HIMART_SALES_STOCK', 'himart', '2026-09-23'), log('HIMART_SALES_STOCK', 'himart', '2026-09-24'),
      log('HIMART_SALES_STOCK', 'himart', '2026-09-26', '실패: x'),
      log('EMART_STOCK', 'emart', '2026-09-25'), log('ETLAND_SALES', 'etland', '2026-08-01~2026-08-31')]);
    const st = g.call('offline_getStatus');
    const by = {}; st.channels.forEach(c => { by[c.channelId] = c; });
    check('이번 달 = 2026-09', st.month === '2026-09' && st.today === TODAY);
    check('활성 채널만(데이터 없는 비활성 채널 생략), 채널대분류 순서 → 정렬순서', st.channels.map(c => c.channelId).join() === 'himart,etland,emart,traders,shinsegae,lotte_dept,theablen,workshop8,dapara', st.channels.map(c => c.channelId));
    check('  ↳ 채널마다 채널대분류', st.channels.map(c => c.channelCategory).join() === '양판점,양판점,할인점,할인점,백화점,백화점,폐쇄몰,폐쇄몰,렌탈', st.channels.map(c => c.channelCategory));
    check('전자랜드: 판매 9/24, 재고 9/25, 빈 날 9/25·9/26', by.etland.salesLast === '2026-09-24' && by.etland.stockLast === '2026-09-25' && by.etland.missingDays.join() === '2026-09-25,2026-09-26', by.etland);
    check('하이마트: 실패한 9/26은 없는 셈 — 판매·재고 9/24', by.himart.salesLast === '2026-09-24' && by.himart.stockLast === '2026-09-24', by.himart);
    check('  ↳ 빈 날 = 9/1~9/22, 9/25, 9/26 (24일)', by.himart.missingDays.length === 24 && by.himart.missingDays[0] === '2026-09-01' && by.himart.missingDays.indexOf('2026-09-23') < 0 && by.himart.missingDays.slice(-2).join() === '2026-09-25,2026-09-26', by.himart.missingDays);
    check('이마트: 판매 업로드 없음 → 9/1~9/26 전부 빈 날, 재고 9/25', by.emart.salesLast === '' && by.emart.missingDays.length === 26 && by.emart.stockLast === '2026-09-25', by.emart);
    check('두 번째는 캐시', g.call('offline_getStatus').cached === true);
    const first = env('2026-10-01').call('offline_getStatus');
    check('매월 1일에는 빈 날짜 없음', first.channels.every(c => c.missingDays.length === 0));
  }

  console.log('\n[9] 프론트 클라이언트(src/features/offline/api.js)');
  {
    const sent = [];
    const box = {
      console, JSON, Promise, Error,
      _getToken: () => 'TOKEN.SIG', _getGasUrl: () => 'https://script.google.com/macros/s/X/exec',
      _gasFetch: async (url, opts) => { sent.push({ url, opts }); return box.__reply; }
    };
    vm.runInContext(fs.readFileSync(path.join(PROJ, 'src', 'features', 'offline', 'api.js'), 'utf8') +
      '\n;globalThis.__api = { call: _offlineCall, masters: _offlineLoadMasters };', vm.createContext(box));
    (async () => {
      box.__reply = { success: true, channels: [] };
      await box.__api.call('offline_upload', { meta: { a: 1 } });
      const req = sent[0], body = JSON.parse(req.opts.body);
      check('POST, 본문 = {action, session, data}', req.opts.method === 'POST' && body.action === 'offline_upload' && body.session === 'TOKEN.SIG' && body.data.meta.a === 1, body);
      check('세션을 URL에 싣지 않음', req.url.indexOf('session=') < 0 && req.url.indexOf('TOKEN') < 0, req.url);
      check('헤더를 지정하지 않음(text/plain 단순 요청 — 프리플라이트 없음)', !req.opts.headers);
      check('업로드는 5분 타임아웃, 그 외 45초', req.opts._timeoutMs === 300000 && (await box.__api.call('offline_getStatus'), sent[1].opts._timeoutMs === 45000));
      box.__reply = { error: 'Error: doPost는 presence 전용입니다 — 그 외 액션(offline_getMasters)은 doGet(GET)으로 보내야 합니다.' };
      let e1 = null; try { await box.__api.call('offline_getMasters'); } catch (e) { e1 = e; }
      check('옛 배포본 응답 → 재배포 안내', e1 && /재배포/.test(e1.message), e1 && e1.message);
      box.__reply = { error: '품목군은 ...' };
      let e2 = null; try { await box.__api.call('offline_saveSku'); } catch (e) { e2 = e; }
      check('서버 오류 문구는 그대로 던짐', e2 && e2.message === '품목군은 ...');
      box.__reply = { success: true, skus: [1] };
      const m1 = await box.__api.masters(); box.__reply = { success: true, skus: [2] };
      const m2 = await box.__api.masters(); const m3 = await box.__api.masters(true);
      check('마스터는 한 번 받아 재사용, force면 다시', m1 === m2 && m3.skus[0] === 2);

      console.log('\n' + '─'.repeat(50));
      console.log('통과 ' + pass + ' / 실패 ' + fail);
      process.exit(fail ? 1 : 0);
    })().catch(e => { console.log('  FAIL  예외: ' + e.stack); process.exit(1); });
  }
})();
