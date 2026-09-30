/* ERP 매출이익리스트(2026-09-30) — 백화점(신세계·롯데백화점)·폐쇄몰(디에이블앤·워크숍에이트)·렌탈(다파라솔루션) 매출.
   우리 창고에서 고객에게 직접 출고한 기록이라 그 파일의 판매가 곧 우리 매출(IN)이자 판매(OUT)다.

   지키려는 성질:
     [1] 채널·거래처 설정 — 운영 모양(채널마스터 10열·7채널)에 setup: IN실적원천 열, 신세계·디에이블앤 켜기(erp·upload), 없는 ERP 채널 3개 추가,
         거래처매핑 초기값 9행, 거래처 = 점포마스터 점포. 재실행 불변·사람이 고친 값 그대로. 마스터에 codeSystems·customers·inSource,
         erp 코드체계로 매핑 저장, 채널군 렌탈 = 특수

   실행: node tests/offline-erp.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadOfflineGas, dataRows } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const { session } = require(path.join(__dirname, 'lib', 'offline-2b-fixture.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 800) : '')); }
}
const J = JSON.stringify;
const TODAY = '2026-09-30';
const EMAIL = 'tester@athomecorp.com';
const ERP_CHS = ['shinsegae', 'theablen', 'lotte_dept', 'workshop8', 'dapara'];

function env() {
  const g = loadOfflineGas({ setup: true, today: TODAY });
  g.rows = name => dataRows(g.tab(name));
  const tok = session(g.ctx, EMAIL);
  g.call = (action, data) => JSON.parse(g.ctx.doPost({ postData: { contents: J({ action, session: tok, data: data || {} }) }, parameter: {} }));
  return g;
}

(function main() {
  console.log('\n[1] 채널·거래처 설정 — 운영 모양(ERP 전) 시트에 setup');
  {
    const g = env(), T = g.ctx.OFF_TABS;
    // ERP 전 운영 모양: 채널마스터 10열·7채널(신세계·디에이블앤 비활성·자기 코드체계), 거래처매핑 탭 없음, 점포마스터에 ERP 점포 없음
    const ch = g.tab('채널마스터');
    ch._grid.length = 1; ch._grid[0].length = 10;
    g.ctx._offWriteBlock(ch, { headers: T.channel.headers.slice(0, 10), text: [0, 1, 2, 3, 5, 6, 7, 8] }, 2, [
      ['himart', '하이마트', '전문점', 'Y', 1, '2026-09', '', '', 'himart', 0], ['etland', '전자랜드', '전문점', 'Y', 2, '2026-09', '', '', 'etland', -1],
      ['emart', '이마트', '할인점', 'Y', 3, '2026-09', '이마트', 'EM', 'emart', -1], ['traders', '트레이더스', '창고형', 'N', 4, '2026-09', '트레이더스', 'TR', 'emart', -1],
      ['shinsegae', '신세계', '백화점', 'N', 5, '', '', '', 'shinsegae', 0], ['theablen', '디에이블앤(수정)', '폐쇄몰', 'N', 6, '', '', '', 'theablen', 0],
      ['special', '기타 특판', '특판', 'N', 7, '', '', '', 'special', 0]]);
    delete g.off._sheets['거래처매핑']; g.off._order.splice(g.off._order.indexOf('거래처매핑'), 1);
    g.tab('점포마스터')._grid.length = 1;
    g.ctx._offWriteBlock(g.tab('점포마스터'), T.store, 2, [['himart', 'S1', '강남점', '강남', '2026-09-01', '2026-09-01', '오프라인']]);
    const rep = g.ctx.offline_setupSheets();
    check('채널마스터 IN실적원천 열만 덧붙임 · 거래처매핑 탭 생성', J(rep.extended) === J([{ tab: '채널마스터', added: ['IN실적원천'] }]) && J(rep.created) === J(['거래처매핑']), rep);
    const rows = g.rows('채널마스터'), by = id => rows.find(r => r[0] === id);
    check('신세계·디에이블앤 = 활성 Y · 업로드시작월 2026-09 · 코드체계 erp · IN실적원천 upload (채널명 등 다른 값은 그대로)',
      ['shinsegae', 'theablen'].every(id => by(id)[3] === 'Y' && by(id)[5] === '2026-09' && by(id)[8] === 'erp' && by(id)[10] === 'upload') && by('theablen')[1] === '디에이블앤(수정)', rows);
    check('나머지 채널 = input, 사람이 끈 트레이더스는 그대로 N', ['himart', 'etland', 'emart', 'traders', 'special'].every(id => by(id)[10] === 'input') && by('traders')[3] === 'N' && by('special')[3] === 'N');
    check('없는 ERP 채널 3개 덧붙임(롯데백화점 백화점 · 워크숍에이트 폐쇄몰 · 다파라솔루션 렌탈)', J(rep.channelsAdded) === J(['lotte_dept', 'workshop8', 'dapara']) &&
      J(['lotte_dept', 'workshop8', 'dapara'].map(id => [by(id)[1], by(id)[2], by(id)[3], by(id)[5], by(id)[8], by(id)[10]])) ===
      J([['롯데백화점', '백화점', 'Y', '2026-09', 'erp', 'upload'], ['워크숍에이트', '폐쇄몰', 'Y', '2026-09', 'erp', 'upload'], ['다파라솔루션', '렌탈', 'Y', '2026-09', 'erp', 'upload']]), rows.slice(7));
    const cust = g.rows('거래처매핑');
    check('거래처매핑 초기값 9행(거래처코드 앞자리 0 보존)', cust.length === 9 && J(cust.map(r => r[0] + '=' + r[2])) === J(['00476=shinsegae', '00440=shinsegae', '00580=shinsegae', '00608=shinsegae', '00619=shinsegae',
      '00604=lotte_dept', '00474=theablen', '00260=workshop8', '00261=dapara']), cust);
    check('  ↳ 거래처명 = 법인 표기 뺀 이름', J(cust.map(r => r[1])) === J(['신세계(센텀시티점)', '신세계(강남점)', '대전신세계', '신세계 동대구복합환승센터', '신세계(청담점)', '롯데백화점 본점', '디에이블앤', '워크숍에이트', '다파라솔루션']));
    const st = g.rows('점포마스터');
    check('거래처 9곳 = 채널의 점포(점포코드 = 거래처코드, 점포명 = 거래처명), 있던 점포는 그대로', st.length === 10 && st[0][1] === 'S1' &&
      J(st.slice(1).map(r => [r[0], r[1], r[2], r[4]])) === J(cust.map(r => [r[2], r[0], r[1], TODAY])) && J(rep.storesAdded.slice(0, 2)) === J(['shinsegae:00476', 'shinsegae:00440']), st);
    const before = J(g.off.getSheets().map(s => s._grid));
    const rep2 = g.ctx.offline_setupSheets();
    check('다시 실행 — 확장·추가 없음, 시트 내용 그대로(멱등)', !rep2.extended.length && !rep2.created.length && !rep2.channelsAdded.length && !rep2.storesAdded.length &&
      J(g.off.getSheets().map(s => s._grid)) === before, rep2);
    // 사람이 고친 값은 다시 실행해도 그대로 — 신세계를 끄고, 거래처 하나를 채널을 바꾸고, 롯데백화점 행을 지움
    ch._grid.find(r => r[0] === 'shinsegae')[3] = 'N';
    g.tab('거래처매핑')._grid[1][1] = '센텀시티점';
    const rep3 = g.ctx.offline_setupSheets();
    check('사람이 끈 신세계는 다시 켜지 않음 · 고친 거래처명 그대로', g.rows('채널마스터').find(r => r[0] === 'shinsegae')[3] === 'N' && g.rows('거래처매핑')[0][1] === '센텀시티점' && !rep3.channelsAdded.length);
    const lotteRow = ch._grid.findIndex(r => r[0] === 'lotte_dept');
    ch._grid.splice(lotteRow, 1);
    check('지운 ERP 채널은 다음 setup이 다시 붙인다', J(g.ctx.offline_setupSheets().channelsAdded) === J(['lotte_dept']));
    check('README에 거래처매핑·IN실적원천 설명', g.rows('README').some(r => r[0] === '거래처매핑' && /거래처코드/.test(r[1])) && g.rows('README').some(r => r[0] === '채널마스터' && /IN실적원천/.test(r[1])));
  }

  console.log('\n[1-2] 마스터 — codeSystems · customers · inSource, erp 코드체계로 매핑 저장');
  {
    const g = env();
    const m = g.call('offline_getMasters');
    check('codeSystems = [erp — ERP (백화점·폐쇄몰·렌탈 공통), 채널 5개]', J(m.codeSystems) === J([{ id: 'erp', name: 'ERP (백화점·폐쇄몰·렌탈 공통)', channels: ['shinsegae', 'theablen', 'lotte_dept', 'workshop8', 'dapara'] }]), m.codeSystems);
    check('customers 9곳(거래처코드·이름·채널)', m.customers.length === 9 && J(m.customers[5]) === J({ code: '00604', name: '롯데백화점 본점', channelId: 'lotte_dept', note: '초기값' }), m.customers);
    check('채널 inSource — ERP 5채널 upload, 나머지 input', m.channels.every(c => c.inSource === (ERP_CHS.indexOf(c.channelId) >= 0 ? 'upload' : 'input')) && m.channels.filter(c => c.codeSystem === 'erp').length === 5);
    g.ctx._offWriteBlock(g.tab('제품마스터'), g.ctx.OFF_TABS.sku, 2, [['SKU-0001', '더 플렌더 MAX', '더플렌더', '더 플렌더 MAX', '', 'Y', '', '']]);
    const r1 = g.call('offline_saveMapping', { items: [{ op: 'upsert', channelId: 'erp', code: '9812365001397', skuId: 'SKU-0001', stockType: '정상', name: '미닉스 더 플렌더 MAX_그레이지 (MNFD-200G)' }] });
    const r2 = g.call('offline_saveMapping', { items: [{ op: 'upsert', channelId: 'dapara', code: '9812365001472', skuId: 'SKU-0001', stockType: '정상' }] });
    check('erp로 온 매핑 · ERP 채널(다파라솔루션)로 온 매핑 모두 erp 한 벌로 저장', r1.success && r2.success && J(g.rows('코드매핑').map(r => r[0] + ':' + r[1])) === J(['erp:9812365001397', 'erp:9812365001472']), [r1, r2, g.rows('코드매핑')]);
    check('채널도 코드체계도 아닌 id는 거절', /채널마스터에 없는/.test(g.call('offline_saveMapping', { items: [{ op: 'upsert', channelId: 'nope', code: 'X', skuId: 'SKU-0001' }] }).error || ''));
    check('채널군 — 백화점 = 오프라인, 폐쇄몰·렌탈 = 특수', g.ctx._offChannelGroup('백화점') === 'offline' && g.ctx._offChannelGroup('폐쇄몰') === 'closed' && g.ctx._offChannelGroup('렌탈') === 'closed');
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})();
