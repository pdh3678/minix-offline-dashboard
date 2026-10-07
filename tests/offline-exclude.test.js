/* 코드 매핑 — 미매칭 코드 "제외" + ERP 제외 브랜드 규칙 (2026-10-07). GAS 실코드(목 시트) + 화면 실코드(서버 호출만 가짜).

   지키려는 성질:
     [1] 제외한 (코드체계채널, 원본코드)는 모든 집계(채널 현황·채널 상세·판매 분석·재고·파트 홈·목표 관리 실적)와 미매칭 목록·경고에서 빠진다.
         판매원장·재고 원본 행은 그대로(읽을 때 뺀다). 매핑된 코드의 숫자(본품 합계·파트 홈)는 제외 전후 같다
     [2] 해제하면 미매칭 목록으로 돌아오고 모든 조회가 제외 전과 같다. 같은 코드를 다시 제외해도 한 줄(멱등)
     [3] 매핑된 코드는 제외를 막는다("매핑을 먼저 해제하세요") · 제외된 코드는 매핑을 막는다 · 코드체계채널(트레이더스 → emart) 한 벌
     [4] ERP 브랜드 규칙 — 설정 ERP_제외브랜드(쉼표로 여러 개, 앞부분 일치·대소문자 무시)로 시작하는 브랜드의 상품코드는 업로드 때 제외코드에 자동 등록
         (사유: 브랜드 규칙) — 매핑된 코드·이미 제외된 코드는 그대로, 값을 비우면 규칙 없음, 제외코드 탭이 없으면(setup 전) 경고만
     [5] 포털 업로드 — 제외코드는 응답·업로드로그의 미매칭 수·미매칭코드 탭에 넣지 않는다 · 마스터에 excluded·excludeBrands
     [6] 화면 — resolver 미매칭에서 제외 · 코드 매핑 미매칭 행 [제외]·제외 체크 → [선택한 n건 제외] · [제외 목록] 탭(사유·등록, [제외 해제]) ·
         업로드 미리보기 "제외 브랜드 n행"·제외 브랜드 코드는 미매칭에 안 뜸 · 반영 결과에 등록 건수 · 외부 문자열은 HTML로 해석되지 않음

   실행: node tests/offline-exclude.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const vm = require('vm');
const { loadOfflineGas, dataRows } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const { loadFrontend } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
const FX = require(path.join(__dirname, 'lib', 'offline-2b-fixture.js'));
const PROJ = path.join(__dirname, '..');
const P = require(path.join(PROJ, 'src', 'features', 'offline', 'parsers.js'));
const R = require(path.join(PROJ, 'src', 'features', 'offline', 'resolver.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 700) : '')); }
}
const J = JSON.stringify;
const tick = () => new Promise(r => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 20; i++) await tick(); }
const err = fn => { try { fn(); return ''; } catch (e) { return e.message; } };

// 조회 묶음 — 실행 시간·버전·캐시 표시는 빼고 비교한다
const strip = o => { const c = JSON.parse(J(o)); delete c.cached; delete c.execMs; delete c.version; return c; };
function snap(g) {
  return {
    monthly: strip(g.call('offline_getMonthly', { from: '2026-09', to: '2026-09' })),
    inv: strip(g.call('offline_getInventory', {})),
    br: strip(g.call('offline_getSalesBreakdown', { channelId: 'himart', from: '2026-09', to: '2026-09' })),
    daily: strip(g.call('offline_getDailySales', { from: '2026-09-01', to: '2026-09-30' })),
    trend: strip(g.call('offline_getInventoryTrend', { from: '2026-09-01', to: '2026-09-30' })),
    home: strip(g.call('home_getSummary', { ym: '2026-09', mode: 'month' })),
    un: strip(g.call('offline_getUnmatched', {}))
  };
}
const ledger = g => J(['판매원장', '재고_채널일별', '재고_점포최신'].map(n => dataRows(g.tab(n))));
const himartOut = s => s.monthly.totals.byChannelMonth.find(x => x.channelId === 'himart').out;
const trendUm = s => s.trend.series.find(x => x.channelId === 'himart').points.find(p => p.date === '2026-09-24');

// ERP 반영 페이로드(파서 출력 모양) — 거래처 00476 = 신세계(setup 거래처매핑)
const TOM = '9812365001362', TOM2 = '9812365001318', MAX = '9812365001397';
function erpPayload(items) {
  return {
    meta: { fileName: 'erp.xlsx', fileType: 'ERP_SALES_PROFIT', channelId: 'erp', replaceStart: '2026-09-01', replaceEnd: '2026-09-30', rawRowCount: items.length, customers: [] },
    records: {
      sales: items.map(([code, , q], i) => ({ s: '2026-09-0' + (i + 1), e: '2026-09-0' + (i + 1), store: '00476', code, qty: q, inst: '', amt: q * 1000, fee: 0 })),
      storeStock: [], channelStock: [], himart: [], stores: [{ code: '00476', name: '신세계', region: '' }],
      names: Object.fromEntries(items.map(([c]) => [c, '상품 ' + c])), brands: Object.fromEntries(items.map(([c, b]) => [c, b]))
    }
  };
}
function erpEnv() {
  const g = loadOfflineGas({ setup: true, today: '2026-09-30' });
  const tok = FX.session(g.ctx, FX.ADMIN);
  g.call = (action, data) => JSON.parse(g.ctx.doPost({ postData: { contents: J({ action, session: tok, data: data || {} }) }, parameter: {} }));
  g.setBrands = v => { const st = g.tab('설정'); st._grid.forEach(r => { if (r[0] === 'ERP_제외브랜드') r[1] = v; }); };
  return g;
}

async function main() {
  console.log('\n[1] 제외 — 모든 집계·미매칭에서 빠지고 원장은 그대로, 매핑된 코드의 숫자는 같다');
  const g = FX.env();
  const before = snap(g), ledger0 = ledger(g);
  check('전제 — COFFEE(하이마트 미매칭): 판매 5·재고 7·미매칭 목록 1건', himartOut(before).unmatchedQty === 5 && before.un.items.some(u => u.code === 'COFFEE') &&
    before.inv.channels.find(c => c.channelId === 'himart').unmatchedStock === 8 && before.home.today.unmatched === 1, himartOut(before));
  const r = g.call('offline_saveExcluded', { items: [{ op: 'exclude', channelId: 'himart', code: 'COFFEE', name: '커피머신(타 브랜드)' }] }, 'admin');
  check('offline_saveExcluded 제외 1건', r.success && r.excluded === 1 && r.included === 0, r);
  check('제외코드 탭 — [코드체계채널, 원본코드, 원본상품명, 수동, 등록일, 등록자]', J(dataRows(g.tab('제외코드'))) === J([['himart', 'COFFEE', '커피머신(타 브랜드)', '수동', FX.TODAY, FX.ADMIN]]), dataRows(g.tab('제외코드')));
  check('미매칭코드 탭에서 빠짐', !dataRows(g.tab('미매칭코드')).some(r => r[1] === 'COFFEE'));
  check('판매원장·재고 원본 행은 그대로', ledger(g) === ledger0);
  const after = snap(g);
  check('미매칭 목록·파트 홈 미매칭 카드에서 사라짐', after.un.items.length === 0 && after.home.today.unmatched === 0, after.un);
  check('채널 현황·목표 관리 실적(월별) — 미매칭 수량 5 → 0, OUT 실적(매핑된 코드) 그대로', himartOut(after).unmatchedQty === 0 && himartOut(after).actual === himartOut(before).actual &&
    !after.monthly.unmatched.length && J(after.monthly.totals.byCategory) === J(before.monthly.totals.byCategory), himartOut(after));
  check('재고 — 미매칭 재고 8 → 1(COFFEE 7 빠지고 비활성 매핑 OLD 1은 그대로), 경보 그대로', after.inv.channels.find(c => c.channelId === 'himart').unmatchedStock === 1 &&
    J(after.inv.groups) === J(before.inv.groups), after.inv.channels.find(c => c.channelId === 'himart'));
  check('판매 분석 — "미매칭(원본코드) COFFEE" 항목이 빠지고 합계 139 → 134, 모델별 숫자 그대로', !after.br.keys.some(k => k.code === 'COFFEE') && after.br.totals.qty === before.br.totals.qty - 5 &&
    J(after.br.keys) === J(before.br.keys.filter(k => k.code !== 'COFFEE')), after.br.totals);
  check('일별 판매 — 미매칭에서 빠짐(합계 −5)', !after.daily.unmatched.length && after.daily.totals.qty === before.daily.totals.qty - 5 && after.daily.totals.unmatchedQty === 0, after.daily.totals);
  check('재고 추이 — 9/24 미매칭 8 → 1, 정상·전시·리퍼 그대로', trendUm(after).unmatched === 1 && trendUm(after)['정상'] === trendUm(before)['정상'] && trendUm(after).total === trendUm(before).total - 7, trendUm(after));
  check('파트 홈 — 본품 합계(대분류별 판매·채널 계열) 제외 전후 같음', J(after.home.categorySales) === J(before.home.categorySales) && J(after.home.series) === J(before.home.series));

  console.log('\n[2] 해제 — 미매칭으로 돌아오고 모든 조회가 제외 전과 같다 · 멱등');
  const r2 = g.call('offline_saveExcluded', { items: [{ op: 'include', channelId: 'himart', code: 'COFFEE' }] }, 'admin');
  check('offline_saveExcluded 해제 1건 — 제외코드 탭 비움', r2.success && r2.included === 1 && dataRows(g.tab('제외코드')).length === 0, r2);
  check('미매칭코드 탭에 다시(상품명은 제외 때 이름, 발견 0)', J(dataRows(g.tab('미매칭코드')).find(r => r[1] === 'COFFEE')) === J(['himart', 'COFFEE', '커피머신(타 브랜드)', FX.TODAY, FX.TODAY, 0]));
  const back = snap(g);
  const sameExceptUn = ['monthly', 'inv', 'br', 'daily', 'trend', 'home'].filter(k => J(back[k]) !== J(before[k]));
  check('채널 현황·재고·판매 분석·일별·추이·파트 홈 — 제외 전과 같음', !sameExceptUn.length, sameExceptUn);
  check('미매칭 목록에 다시 나타남', back.un.items.map(u => u.code).join() === 'COFFEE', back.un.items);
  g.call('offline_saveExcluded', { items: [{ op: 'exclude', channelId: 'himart', code: 'COFFEE' }] }, 'admin');
  const r3 = g.call('offline_saveExcluded', { items: [{ op: 'exclude', channelId: 'himart', code: 'COFFEE' }, { op: 'include', channelId: 'himart', code: 'NOPE' }] }, 'admin');
  check('다시 제외 — 이름은 미매칭코드 탭에서, 같은 코드를 또 제외해도 한 줄(없는 코드 해제는 무시)', r3.excluded === 0 && r3.included === 0 && J(dataRows(g.tab('제외코드'))) === J([['himart', 'COFFEE', '커피머신(타 브랜드)', '수동', FX.TODAY, FX.ADMIN]]), dataRows(g.tab('제외코드')));
  check('  ↳ 다시 제외한 뒤 조회 = 처음 제외했을 때와 같음', J(snap(g)) === J(after));

  console.log('\n[3] 막기 — 매핑된 코드는 제외 불가 · 제외된 코드는 매핑 불가 · 코드체계채널 한 벌 · 입력 검증');
  {
    const x0 = J(dataRows(g.tab('제외코드'))), u0 = J(dataRows(g.tab('미매칭코드')));
    const e1 = g.call('offline_saveExcluded', { items: [{ op: 'exclude', channelId: 'himart', code: 'OLD' }, { op: 'exclude', channelId: 'himart', code: 'MNFD-200G' }] }, 'admin');
    check('매핑된 코드(하이마트 MNFD-200G) — "매핑을 먼저 해제하세요", 같은 요청의 다른 코드도 쓰지 않음', /매핑된 코드입니다 — 매핑을 먼저 해제하세요: himart \/ MNFD-200G/.test(e1.error || '') &&
      J(dataRows(g.tab('제외코드'))) === x0 && J(dataRows(g.tab('미매칭코드'))) === u0, e1);
    const ok = g.call('offline_saveExcluded', { items: [{ op: 'exclude', channelId: 'himart', code: 'OLD', name: '옛 코드' }] }, 'admin');
    check('비활성화된 매핑(sku_id 빈칸) 코드는 제외할 수 있다', ok.success && ok.excluded === 1 && dataRows(g.tab('제외코드')).some(r => r[1] === 'OLD'), ok);
    const e2 = g.call('offline_saveMapping', { items: [{ op: 'upsert', channelId: 'himart', code: 'COFFEE', skuId: 'SKU-0001', stockType: '정상' }] }, 'admin');
    check('제외된 코드에 매핑 저장 — 막고 제외 해제 안내, 코드매핑 그대로', /제외된 코드입니다 — 코드 매핑 화면 \[제외 목록\]에서 제외를 해제한 뒤 매핑하세요/.test(e2.error || '') &&
      !dataRows(g.tab('코드매핑')).some(r => r[1] === 'COFFEE'), e2);
    check('입력 검증 — 빈 목록·없는 채널·빈 코드·모르는 작업', /제외·해제할 코드가 없습니다/.test(g.call('offline_saveExcluded', { items: [] }, 'admin').error) &&
      /채널마스터에 없는 channel_id/.test(g.call('offline_saveExcluded', { items: [{ op: 'exclude', channelId: 'nope', code: 'X' }] }, 'admin').error) &&
      /원본코드가 비었습니다/.test(g.call('offline_saveExcluded', { items: [{ op: 'exclude', channelId: 'himart', code: ' ' }] }, 'admin').error) &&
      /알 수 없는 작업/.test(g.call('offline_saveExcluded', { items: [{ op: 'drop', channelId: 'himart', code: 'X' }] }, 'admin').error));
  }
  {
    // 트레이더스 → emart 코드체계: 트레이더스로 제외해도 emart 한 벌, 두 채널의 판매가 함께 빠진다
    const t = FX.env(), T = t.ctx.OFF_TABS;
    const ch = t.tab('채널마스터');
    ch._grid.forEach((r, i) => { if (i && r[0]) r[8] = r[0] === 'traders' ? 'emart' : r[0]; if (i && r[0] === 'traders') r[3] = 'Y'; });
    const SL = (ch2, q) => ['2026-09-10', '2026-09-10', 'day', ch2, 'X1', 'TOMX', q, '', 'upload', 'U'];
    t.ctx._offWriteBlock(t.tab('판매원장'), T.sales, dataRows(t.tab('판매원장')).length + 2, [SL('emart', 2), SL('traders', 3)]);
    t.ctx._offInvalidateCache();
    const um = () => t.call('offline_getDailySales', { from: '2026-09-01', to: '2026-09-30' }).unmatched.filter(u => u.code === 'TOMX').map(u => u.channelId + ':' + u.qty).join();
    const um0 = um();
    t.call('offline_saveExcluded', { items: [{ op: 'exclude', channelId: 'traders', code: 'TOMX' }] }, 'admin');
    check('트레이더스로 제외 → 제외코드 emart 한 줄, 이마트·트레이더스 판매 모두 빠짐', um0 === 'emart:2,traders:3' && J(dataRows(t.tab('제외코드')).map(r => r.slice(0, 2))) === J([['emart', 'TOMX']]) && um() === '', [um0, um()]);
    t.call('offline_saveExcluded', { items: [{ op: 'include', channelId: 'emart', code: 'TOMX' }] }, 'admin');
    check('  ↳ emart로 해제하면 두 채널에 다시', um() === 'emart:2,traders:3', um());
  }

  console.log('\n[4] ERP 브랜드 규칙 — 업로드 때 제외코드에 자동 등록');
  {
    const e = erpEnv();
    const m0 = e.call('offline_getMasters');
    check('setup 기본값 — 설정 ERP_제외브랜드 = 톰, 마스터 excludeBrands = [톰], excluded = []', J(m0.excludeBrands) === J(['톰']) && J(m0.excluded) === J([]) &&
      dataRows(e.tab('설정')).some(r => r[0] === 'ERP_제외브랜드' && r[1] === '톰'), m0.excludeBrands);
    e.ctx._offWriteBlock(e.tab('제품마스터'), e.ctx.OFF_TABS.sku, 2, [['SKU-0001', '더 플렌더 MAX', '더플렌더', '', '', 'Y', '', '']]);
    e.call('offline_saveMapping', { items: [{ op: 'upsert', channelId: 'erp', code: TOM2, skuId: 'SKU-0001', stockType: '정상' }] });
    const mappedOk = dataRows(e.tab('코드매핑')).some(r => r[1] === TOM2 && r[2]);
    const r1 = e.ctx._offUpload(erpPayload([[MAX, '미닉스 더 플렌더', 2], [TOM, '톰 디바이스', 1], [TOM2, '톰', 1], ['9812365001201', ' 톰월드 ', 1], ['9812365001999', '토마토', 1]]), { email: FX.ADMIN });
    const xs = dataRows(e.tab('제외코드'));
    check('톰 디바이스·" 톰월드 "(앞부분 일치·공백 무시) → 브랜드 규칙으로 등록, 토마토(앞부분 다름)·매핑된 톰 코드는 등록 안 함', J(xs.map(r => r[1]).sort()) === J([TOM, '9812365001201'].sort()) &&
      xs.every(r => r[0] === 'erp' && r[3] === '브랜드 규칙' && r[4] === '2026-09-30' && r[5] === FX.ADMIN) && xs.find(r => r[1] === TOM)[2] === '상품 ' + TOM && mappedOk && r1.applied.excludedAdded === 2, xs);
    check('  ↳ 미매칭 = 제외·매핑 뺀 나머지(MAX·토마토), 업로드로그 미매칭 수도 같음, 판매원장에는 톰 행 그대로', J(r1.unmatched.map(u => u.code).sort()) === J([MAX, '9812365001999'].sort()) &&
      dataRows(e.tab('업로드로그')).pop()[9] === 2 && dataRows(e.tab('판매원장')).some(r => r[5] === TOM) && !dataRows(e.tab('미매칭코드')).some(r => r[1] === TOM), r1.unmatched);
    const r2 = e.ctx._offUpload(erpPayload([[TOM, '톰 디바이스', 1]]), { email: FX.ADMIN });
    check('같은 코드 다시 업로드 — 이미 제외라 추가 없음', dataRows(e.tab('제외코드')).length === 2 && !r2.applied.excludedAdded, r2.applied);
    e.call('offline_saveExcluded', { items: [{ op: 'include', channelId: 'erp', code: TOM }] });
    const un = e.call('offline_getUnmatched').items.map(u => u.code);
    check('브랜드 규칙 코드도 해제하면 미매칭으로(다음 ERP 업로드 때 규칙이 다시 등록한다)', un.indexOf(TOM) >= 0 && dataRows(e.tab('제외코드')).length === 1, un);
    e.ctx._offUpload(erpPayload([[TOM, '톰 디바이스', 1]]), { email: FX.ADMIN });
    check('  ↳ 다음 업로드 → 다시 브랜드 규칙으로 제외, 미매칭에서 빠짐', dataRows(e.tab('제외코드')).some(r => r[1] === TOM && r[3] === '브랜드 규칙') && e.call('offline_getUnmatched').items.every(u => u.code !== TOM));
    e.setBrands('dyson, 토마');
    e.ctx._offInvalidateCache();
    const r3 = e.ctx._offUpload(erpPayload([['C-DY', 'DYSON 코리아', 1], ['C-TM', '토마토', 1], ['C-TOM', '톰', 1]]), { email: FX.ADMIN });
    check('설정을 "dyson, 토마"로 — 쉼표로 여러 개·대소문자 무시(DYSON 코리아), 톰은 더 이상 규칙 아님', J(dataRows(e.tab('제외코드')).map(r => r[1]).filter(c => /^C-/.test(c)).sort()) === J(['C-DY', 'C-TM']) &&
      r3.unmatched.some(u => u.code === 'C-TOM') && J(e.call('offline_getMasters').excludeBrands) === J(['dyson', '토마']), dataRows(e.tab('제외코드')));
    e.setBrands('');
    const n0 = dataRows(e.tab('제외코드')).length;
    e.ctx._offUpload(erpPayload([['C-DY2', 'dyson', 1]]), { email: FX.ADMIN });
    check('값을 비우면 규칙 없음', dataRows(e.tab('제외코드')).length === n0 && J(e.ctx._offExcludeBrands([['ERP_제외브랜드', '', '']])) === J([]));
    check('설정 키가 없으면(setup 재실행 전) 기본값 톰', J(e.ctx._offExcludeBrands([])) === J(['톰']));
  }
  {
    const e = erpEnv();
    delete e.off._sheets['제외코드']; e.off._order.splice(e.off._order.indexOf('제외코드'), 1); // setup 재실행 전 모양
    const r = e.ctx._offUpload(erpPayload([[TOM, '톰 디바이스', 1]]), { email: FX.ADMIN });
    check('제외코드 탭이 없으면(setup 재실행 전) 반영은 성공, 경고로 안내', r.success && r.warnings.some(w => /제외코드 탭이 없어 등록하지 못했습니다.*offline_setupSheets/.test(w)) && dataRows(e.tab('판매원장')).some(x => x[5] === TOM), r.warnings);
    const m = e.call('offline_getMasters'), u = e.call('offline_getUnmatched'), mo = e.call('offline_getMonthly', { from: '2026-09', to: '2026-09' });
    check('  ↳ 탭이 없어도 조회는 된다(제외 없음으로)', m.success && J(m.excluded) === J([]) && u.success && mo.success && !mo.error, [m.error, u.error, mo.error]);
  }

  console.log('\n[5] 포털 업로드 — 제외코드는 미매칭 응답·로그·탭에 넣지 않는다');
  {
    const p = FX.env();
    p.call('offline_saveExcluded', { items: [{ op: 'exclude', channelId: 'etland', code: 'TOMX', name: '톰 상품' }] }, 'admin');
    const payload = { meta: { fileName: '판매내역.xls', fileType: 'ETLAND_SALES', channelId: 'etland', replaceStart: '2026-09-21', replaceEnd: '2026-09-21', rawRowCount: 2 },
      records: { sales: [{ s: '2026-09-21', e: '2026-09-21', store: 'E1', code: 'TOMX', qty: 1, inst: '' }, { s: '2026-09-21', e: '2026-09-21', store: 'E1', code: 'NEW1', qty: 1, inst: '' }],
        storeStock: [], channelStock: [], himart: [], stores: [], names: { TOMX: '톰 상품', NEW1: '새 코드' } } };
    const r = p.ctx._offUpload(payload, { email: FX.ADMIN });
    check('응답 미매칭 = NEW1만, 업로드로그 미매칭 1, 미매칭코드 탭에 TOMX 없음, 판매원장에는 TOMX 행 그대로', J(r.unmatched.map(u => u.code)) === J(['NEW1']) && dataRows(p.tab('업로드로그')).pop()[9] === 1 &&
      !dataRows(p.tab('미매칭코드')).some(x => x[1] === 'TOMX') && dataRows(p.tab('판매원장')).some(x => x[5] === 'TOMX'), r.unmatched);
    const m = p.call('offline_getMasters');
    check('마스터 excluded — 사유·등록일·등록자', J(m.excluded) === J([{ channelId: 'etland', code: 'TOMX', name: '톰 상품', reason: '수동', at: FX.TODAY, by: FX.ADMIN }]), m.excluded);
  }

  console.log('\n[6] 화면 — resolver · 코드 매핑 [제외]·[선택한 n건 제외]·[제외 목록]·[제외 해제] · 업로드 미리보기 제외 브랜드');
  {
    const masters = { channels: [{ channelId: 'emart', codeSystem: 'emart' }, { channelId: 'traders', codeSystem: 'emart' }],
      mappings: [{ channelId: 'emart', code: 'A', skuId: 'SKU-1' }], excluded: [{ channelId: 'emart', code: 'X' }] };
    const res = R.createResolver(masters);
    check('resolver — 제외코드는 미매칭이 아니다(코드체계채널: 트레이더스 X도 제외)', J(res.unmatched('traders', ['A', 'X', 'B'])) === J(['B']) && res.isExcluded('traders', 'X') && !res.isExcluded('emart', 'B') && !res.isMapped('emart', 'X'));
    check('P.brandExcluded — 앞부분·대소문자·공백 무시, 빈 브랜드·빈 단어는 해당 없음', P.brandExcluded(' 톰 디바이스', ['톰']) && P.brandExcluded('TOM', ['tom ']) && !P.brandExcluded('토마토', ['톰']) &&
      !P.brandExcluded('', ['톰']) && !P.brandExcluded('톰', ['', ' ']) && !P.brandExcluded('톰', undefined));
  }
  await codeMappingUi();
  await uploadUi();

  console.log('\n통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
}

const UI_SHIM = 'get UP(){return _UP;}, get MASTERS(){return OFFLINE_MASTERS;}, get CM(){return _CM;}, get MP(){return _MP;}';
const UI_MASTERS = () => ({
  success: true,
  skus: [{ skuId: 'SKU-0001', name: '더 플렌더 MAX 그레이지', line: '더플렌더', model: '더 플렌더 MAX', option: '그레이지', active: 'Y', order: 1 }],
  channels: [{ channelId: 'himart', name: '하이마트', channelCategory: '양판점', active: 'Y', order: 1, codeSystem: 'himart' },
    { channelId: 'shinsegae', name: '신세계백화점', channelCategory: '백화점', active: 'Y', order: 5, codeSystem: 'erp', inSource: 'upload' }],
  channelCategories: ['양판점', '백화점'], codeSystems: [{ id: 'erp', name: 'ERP (백화점·폐쇄몰·렌탈 공통)', channels: ['shinsegae'] }],
  customers: [{ code: '00476', name: '신세계(센텀시티점)', channelId: 'shinsegae' }],
  mappings: [{ channelId: 'erp', code: MAX, skuId: 'SKU-0001', stockType: '정상', name: 'MAX' }], stores: [], productLines: [], stockTypes: ['정상', '전시', '리퍼'],
  excluded: [{ channelId: 'erp', code: TOM2, name: '톰 <b>글로우</b>', reason: '브랜드 규칙', at: '2026-10-07', by: 'tester@athomecorp.com' },
    { channelId: 'himart', code: 'COFFEE', name: '커피머신', reason: '수동', at: '2026-10-06', by: 'a@athomecorp.com' }],
  excludeBrands: ['톰']
});
function uiSetup(over) {
  const { ctx, X } = loadFrontend(PROJ, UI_SHIM);
  const box = {};
  const el = id => (box[id] = box[id] || { id, innerHTML: '', value: '', textContent: '', className: '', style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); }, toggle() {} } });
  ctx.document.getElementById = el;
  const calls = [], toasts = [];
  const replies = Object.assign({
    offline_getStatus: () => ({ success: true, today: '2026-10-07', month: '2026-10', channels: [] }), offline_getUploadLog: () => ({ success: true, items: [] }),
    offline_getInboxStatus: () => ({ success: true, settings: {}, last: null }),
    offline_getMasters: () => UI_MASTERS(),
    offline_getUnmatched: () => ({ success: true, items: [{ channelId: 'himart', code: 'C1', name: '<i>가짜</i> 1', count: 2, lastSeen: '2026-10-06' }, { channelId: 'erp', code: 'C2', name: '가짜 2', count: 1, lastSeen: '2026-10-05' }] }),
    offline_saveExcluded: () => ({ success: true, excluded: 1, included: 0 }),
    offline_upload: () => ({ success: true, uploadId: 'U1', applied: { sales: 3, salesRemoved: 0, excludedAdded: 1, byChannel: {} }, replaceRange: { start: '2026-09-01', end: '2026-09-30' }, unmatched: [], warnings: [], channels: ['shinsegae'] })
  }, over || {});
  ctx._offlineCall = async (action, data) => { calls.push({ action, data }); const f = replies[action]; return f ? f(data || {}) : { success: true, items: [] }; };
  ctx.showToast = (m, o) => { toasts.push([m, o && o.type]); };
  return { ctx, X, el, calls, toasts, replies };
}

async function codeMappingUi() {
  const { ctx, X, el, calls, toasts, replies } = uiSetup();
  ctx.navPage('admin-code-mapping', null);
  await settle();
  const page = () => el('page-admin-code-mapping').innerHTML, panel = () => el('cmUnmatched').innerHTML;
  check('탭 — [코드 매핑 | 제외 목록 (2) | 제품마스터]', /코드 매핑<\/button><button[^>]*_cmSetTab\('excluded'\)">제외 목록 \(2\)<\/button><button[^>]*>제품마스터/.test(page()), page().slice(0, 600));
  const p = panel();
  check('미매칭 행마다 제외 체크 + [제외] 버튼, 머리글 "제외"', /<th[^>]*>제외<\/th>/.test(p) && p.indexOf("_mpExclude('cmUnmatched',0)") >= 0 && p.indexOf("_mpExclude('cmUnmatched',1)") >= 0 &&
    p.indexOf("_mpExCheck('cmUnmatched',0,this.checked)") >= 0);
  check('  ↳ [선택한 0건 제외]는 막힘, 상품명 HTML은 글자 그대로', /disabled onclick="_mpExcludeChecked\('cmUnmatched'\)">선택한 0건 제외/.test(p) && p.indexOf('<i>가짜</i>') < 0 && p.indexOf('&lt;i&gt;가짜&lt;/i&gt;') >= 0);
  calls.length = 0;
  await ctx._mpExclude('cmUnmatched', 0);
  await settle();
  const c1 = calls.find(c => c.action === 'offline_saveExcluded');
  check('[제외] → offline_saveExcluded 그 한 건(채널·코드·상품명) → 마스터·미매칭 다시 받기 · 알림', c1 && J(c1.data) === J({ items: [{ op: 'exclude', channelId: 'himart', code: 'C1', name: '<i>가짜</i> 1' }] }) &&
    calls.some(c => c.action === 'offline_getMasters') && calls.some(c => c.action === 'offline_getUnmatched') && /1건을 제외했습니다/.test(toasts.pop()[0]), calls.map(c => c.action));
  ctx._mpExCheck('cmUnmatched', 0, true); ctx._mpExCheck('cmUnmatched', 1, true);
  check('체크 2개 → [선택한 2건 제외] 켜짐', /<button type="button" class="btn-cancel up-btn"  onclick="_mpExcludeChecked\('cmUnmatched'\)">선택한 2건 제외/.test(panel()), panel().slice(panel().indexOf('mp-foot')));
  calls.length = 0;
  await ctx._mpExcludeChecked('cmUnmatched');
  await settle();
  const c2 = calls.find(c => c.action === 'offline_saveExcluded');
  check('[선택한 2건 제외] → 한 번에 2건', c2 && J(c2.data.items.map(x => x.op + ':' + x.channelId + ':' + x.code)) === J(['exclude:himart:C1', 'exclude:erp:C2']), c2 && c2.data);
  check('  ↳ 끝나면 체크 해제', /선택한 0건 제외/.test(panel()));
  replies.offline_saveExcluded = () => { throw new Error('매핑된 코드입니다 — 매핑을 먼저 해제하세요: himart / C1'); };
  toasts.length = 0;
  await ctx._mpExclude('cmUnmatched', 0);
  check('매핑된 코드 — 서버 안내를 오류 알림으로', toasts.length === 1 && /^제외 실패: 매핑된 코드입니다 — 매핑을 먼저 해제하세요/.test(toasts[0][0]) && toasts[0][1] === 'error', toasts);
  replies.offline_saveExcluded = () => ({ success: true, excluded: 0, included: 1 });

  ctx._cmSetTab('excluded');
  const h = page();
  check('[제외 목록] — 최근 등록 순, 채널·원본코드·상품명·사유·등록(일시·등록자)·[제외 해제]', h.indexOf('제외 목록 2개') >= 0 && h.indexOf(TOM2) < h.indexOf('COFFEE') &&
    /<td>브랜드 규칙<div class="cm-reg">해제해도 다음 ERP 업로드 때 다시 제외됩니다/.test(h) && /<td>수동<\/td>/.test(h) && h.indexOf('2026-10-07<br>tester@athomecorp.com') >= 0 &&
    h.indexOf('ERP (백화점·폐쇄몰·렌탈 공통)') >= 0 && h.indexOf('양판점 · 하이마트') >= 0 && (h.match(/_cmInclude\(\d\)">제외 해제/g) || []).length === 2, h.slice(0, 1500));
  check('  ↳ 브랜드 규칙 안내(설정 ERP_제외브랜드 = 톰), 상품명 HTML은 글자 그대로', h.indexOf('<b>톰</b>(으)로 시작하는 상품코드는 업로드 때 자동으로 제외') >= 0 && h.indexOf('톰 <b>글로우</b>') < 0 && h.indexOf('톰 &lt;b&gt;글로우&lt;/b&gt;') >= 0);
  calls.length = 0;
  await ctx._cmInclude(1);
  await settle();
  const c3 = calls.find(c => c.action === 'offline_saveExcluded');
  check('[제외 해제] → offline_saveExcluded include 그 코드 → 마스터·미매칭 다시 받기 · 알림', c3 && J(c3.data) === J({ items: [{ op: 'include', channelId: 'himart', code: 'COFFEE' }] }) &&
    calls.some(c => c.action === 'offline_getMasters') && calls.some(c => c.action === 'offline_getUnmatched') && /COFFEE 제외를 해제했습니다 — 다시 미매칭 코드로/.test(toasts.pop()[0]), calls.map(c => c.action));
  const empty = uiSetup({ offline_getMasters: () => Object.assign(UI_MASTERS(), { excluded: [] }) });
  empty.ctx.navPage('admin-code-mapping', null); await settle();
  empty.ctx._cmSetTab('excluded');
  check('제외한 코드가 없으면 안내, 탭 이름에 숫자 없음', /제외한 코드가 없습니다/.test(empty.el('page-admin-code-mapping').innerHTML) && />제외 목록<\/button>/.test(empty.el('page-admin-code-mapping').innerHTML));
  // 업로드 카드의 매핑 패널에는 제외 버튼이 없다(코드 매핑 화면에서만)
  vm.runInContext('OFFLINE_MASTERS = ' + J(UI_MASTERS()) + ';', ctx);
  ctx.renderMappingPanel('upMap-x', [{ channelId: 'himart', code: 'Z', name: 'z' }], {});
  check('업로드 카드 매핑 패널 — 제외 열·버튼 없음', el('upMap-x').innerHTML.indexOf('_mpExclude') < 0 && el('upMap-x').innerHTML.indexOf('건 제외') < 0);
}

async function uploadUi() {
  const { ctx, X, el, calls } = uiSetup();
  const byName = {};
  ctx._loadSheetJS = async () => ({});
  ctx.OfflineParsers.readWorkbookRows = (XLSX, bytes) => ({ rows: byName[bytes.__name] });
  ctx.Uint8Array = function (buf) { return { __name: buf.__name }; };
  const head = ['날짜', '거래처코드', '거래처명', '브랜드', '상품코드', '기본상품명', '카테고리', '수불구분', '수량', '금액', '수수료'];
  const row = (d, code, brand, q, amt) => [d, '00476', '(주)신세계', brand, code, '상품 ' + code, '본품', '매출출고', q, amt, 0];
  const name = '백화점, 폐쇄몰, 렌탈 매출이익리스트(2026-09-01~2026-09-30).xlsx';
  byName[name] = [head, row('2026-09-02', MAX, '미닉스 더 플렌더', 1, 330000), row('2026-09-03', TOM, '톰 디바이스', 2, 100000), row('2026-09-04', TOM, '톰 디바이스', 1, 50000),
    row('2026-09-05', '9812365001999', '<b>미닉스</b> 신상', 1, 10000), row('2026-09-06', 'COFFEE', '커피', 1, 5000)];
  await ctx._upRefreshSide();
  ctx._upAddFiles([{ name, arrayBuffer: async () => ({ __name: name }) }]);
  await settle();
  const f = X.UP.files[0], h = el('page-admin-upload').innerHTML;
  check('ERP 미리보기 — "제외 브랜드(톰) 2행 · 수량 3 · 금액 · 상품코드 1종"', f.parse && f.parse.type === 'ERP_SALES_PROFIT' && /제외 브랜드\(톰\) <b>2<\/b>행 · 수량 <b>3<\/b> · 금액 <b>₩150,000<\/b> · 상품코드 <b>1<\/b>종/.test(h), h.slice(h.indexOf('무상 동봉'), h.indexOf('무상 동봉') + 400));
  check('  ↳ 브랜드별 표 — 톰 디바이스에 "제외 브랜드" 칩, 브랜드 HTML은 글자 그대로', /<td>톰 디바이스 <span class="up-chip error">제외 브랜드<\/span>/.test(h) && h.indexOf('<b>미닉스</b> 신상') < 0);
  const um = ctx._upUnmatched(f).map(u => u.code);
  check('미매칭 — 제외 브랜드 코드(톰)·매핑된 코드(MAX)는 빠지고 새 코드만', J(um) === J(['9812365001999', 'COFFEE']), um);
  vm.runInContext('OFFLINE_MASTERS.excluded.push({ channelId: "erp", code: "COFFEE", name: "x", reason: "수동" });', ctx);
  check('  ↳ 제외코드에 있는 코드(erp COFFEE)도 미매칭에서 빠짐', J(ctx._upUnmatched(f).map(u => u.code)) === J(['9812365001999']));
  await ctx._upApply(f.id);
  const call = calls.find(c => c.action === 'offline_upload');
  check('반영 요청 — records.brands에 상품코드 → 브랜드(서버가 설정으로 판정), 톰 판매 행도 그대로 보낸다', call && call.data.records.brands[TOM] === '톰 디바이스' && call.data.records.brands[MAX] === '미닉스 더 플렌더' &&
    call.data.records.sales.filter(s => s.code === TOM).length === 2, call && call.data.records.brands);
  check('반영 결과 — "제외코드 등록(브랜드 규칙) 1건"', el('page-admin-upload').innerHTML.indexOf('제외코드 등록(브랜드 규칙) 1건') >= 0);
  vm.runInContext('OFFLINE_MASTERS.excludeBrands = [];', ctx);
  ctx._upRender();
  check('설정 ERP_제외브랜드가 비면 제외 브랜드 줄 없음, 톰 코드는 미매칭으로', el('page-admin-upload').innerHTML.indexOf('제외 브랜드(') < 0 && ctx._upUnmatched(f).some(u => u.code === TOM));
  check('포털 파일 페이로드에는 brands를 싣지 않는다', !('brands' in P.toUploadPayload({ type: 'ETLAND_SALES', channelId: 'etland', kind: 'period', split: '', period: { start: '2026-09-01', end: '2026-09-01' },
    summary: {}, records: { sales: [], storeStock: [], channelStock: [], himart: [], stores: [], names: {} } }).records));
}

main().catch(e => { console.error(e); process.exit(1); });
