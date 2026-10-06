/* 2-B 재고·판매 지표 GAS(apps-script-offline-inventory.js) + 2-B에서 늘린 기존 API.

   지키려는 성질(지표 정의 — 세 화면이 이 결과를 그대로 쓴다):
     · 정상재고 = 채널 최신 기준일(재고_채널일별)의 '정상' 합, 전시·리퍼 따로. 예전 기준일 행은 무시
     · 일평균 판매 = 창 [판매 최신 기준일 − N + 1, 판매 최신 기준일] 안에 기간종료일이 있는 레코드 합 ÷ N
       (period는 통째로, 재고구분 무관, 판매 최신 기준일은 업로드로그). 재고일수 = 정상 ÷ 일평균, 판매 0이면 null
     · 경보: 재고일수 > 과다 → over, < 결품위험 → risk (경계값은 경보 아님)
     · 진열 점포 = 전시 재고 > 0, 취급 점포 = 재고 > 0, 커버리지 = 취급 ÷ 점포마스터
     · 점포 결품 = 당월판매 > 0 인데 재고 0 — 당월판매는 재고 파일(하이마트·이마트) 또는 판매원장(전자랜드)
     · 미매칭 코드 재고·판매는 합계에서 빼지 않고 따로(비활성 매핑 포함), 점포 수·결품에는 넣지 않음
     · 데이터 지연: 오늘 − 기준일 > 설정 일수면 stale
   API: getInventory(채널별 점포 표·캐시·무효화) / getDailySales(day·period·설치완료·집계 단위) / getInventoryTrend /
        saveSettings(관리자·검증) / deletePrice(이관로그 기록) / saveSku 수정(비고 보존·연결 코드 수) /
        saveTargets 부분 저장 / getMonthly totalsOnly

   실행: node tests/offline-inventory.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadOfflineGas, dataRows } = require(path.join(__dirname, 'lib', 'offline-gas.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
const J = JSON.stringify;
const { TODAY, USER, SALES, compute, G, near, env } = require(path.join(__dirname, 'lib', 'offline-2b-fixture.js'));

(function main() {
  console.log('\n[1] 채널 재고 — 최신 기준일만, 재고구분별, 미매칭은 따로');
  const g0 = loadOfflineGas({ today: TODAY });
  const r = compute(g0);
  {
    const h = G(r, 'himart', 'channel');
    check('하이마트 정상 260 · 전시 4 · 리퍼 2 (09-23 행 999 무시)', J(h.stock) === J({ '정상': 260, '전시': 4, '리퍼': 2 }) && h.total === 266, h.stock);
    const a = G(r, 'himart', 'sku', 'SKU-0001');
    check('SKU-0001: 정상 50 · 전시 4 · 리퍼 2', J(a.stock) === J({ '정상': 50, '전시': 4, '리퍼': 2 }) && a.name === '더 플렌더 MAX' && a.model === '더 플렌더 MAX', a);
    const um = r.unmatched.filter(u => u.channelId === 'himart');
    check('미매칭: COFFEE 7(판매 5) · OLD 1(비활성 매핑) — 상품명 붙음', J(um.map(u => [u.code, u.stock, u.windowQty, u.name])) === J([['COFFEE', 7, 5, '커피머신(타 브랜드)'], ['OLD', 1, 0, '옛 코드']]), um);
    const c = r.channels.find(x => x.channelId === 'himart');
    check('채널 전체 = SKU 합 + 미매칭 (266 + 8 = 274)', h.total + c.unmatchedStock === 274 && c.unmatchedStock === 8, c);
    check('모델·품목군·대분류 그룹 — 키와 값', G(r, 'himart', 'model', '더플렌더|더 플렌더 MAX').total === 56 && G(r, 'himart', 'line', '미니건조기').stock['정상'] === 10 &&
      G(r, 'himart', 'category', '청소기').stock['정상'] === 200, r.groups.filter(x => x.channelId === 'himart').map(x => x.level + ':' + x.key));
    check('빈 모델 SKU(더 슬림)는 카탈로그 모델로', G(r, 'himart', 'sku', 'SKU-0003').model === '더 슬림' && G(r, 'himart', 'sku', 'SKU-0003').active === 'N');
  }

  console.log('\n[2] 일평균 판매·재고일수 — 창은 판매 최신 기준일(업로드로그)에서 N일');
  {
    const c = r.channels.find(x => x.channelId === 'himart');
    check('하이마트 창 = 08-28 ~ 09-24 (N=28)', c.salesFrom === '2026-08-28' && c.salesDate === '2026-09-24' && r.windowDays === 28, c);
    const a = G(r, 'himart', 'sku', 'SKU-0001');
    check('SKU-0001: period(9/1~9/23) 20 + day 8 = 28 → 일평균 1, 재고일수 50 (창 밖 100·50 제외)', a.windowQty === 28 && a.dailyAvg === 1 && a.days === 50 && a.alert === '', a);
    const b = G(r, 'himart', 'sku', 'SKU-0002');
    check('SKU-0002: 정상 10 ÷ 1 = 10일 < 14 → 결품 위험', b.days === 10 && b.alert === 'risk', b);
    const s = G(r, 'himart', 'sku', 'SKU-0003');
    check('SKU-0003: 200 ÷ 1 = 200일 > 90 → 과다', s.days === 200 && s.alert === 'over', s);
    const e = G(r, 'etland', 'sku', 'SKU-0001');
    check('전자랜드: 창 08-24~09-20(실패 업로드 무시) · 판매 4 → 정상 2 ÷ (4/28) = 14일 — 경계값은 경보 아님', near(e.days, 14) && e.alert === '' && r.channels.find(x => x.channelId === 'etland').salesDate === '2026-09-20', e);
    const em = G(r, 'emart', 'channel');
    check('데이터 없는 채널(이마트): 일평균·재고일수 null, 판매 없음 아님', em.dailyAvg === null && em.days === null && em.noSales === false && em.total === 0);
    const r2 = compute(g0, { sales: SALES.filter(x => x[5] !== 'MNMD-110G') });
    const b2 = G(r2, 'himart', 'sku', 'SKU-0002');
    check('판매 0 → 재고일수 null + noSales(판매 없음), 경보 없음', b2.days === null && b2.noSales === true && b2.dailyAvg === 0 && b2.alert === '', b2);
    const r3 = compute(g0, { settingsRows: [['재고일수_판매기준일수', 14, ''], ['재고경보_결품위험일수', 5, '']] });
    const a3 = G(r3, 'himart', 'sku', 'SKU-0001');
    check('설정 N=14 → 창 09-11~09-24: period 20 + 8 = 28 → 일평균 2, 결품위험 5 → SKU-0002(10 ÷ 0) 판매 없음', r3.windowDays === 14 && a3.dailyAvg === 2 && a3.days === 25 &&
      G(r3, 'himart', 'sku', 'SKU-0002').noSales === true, [a3, G(r3, 'himart', 'sku', 'SKU-0002')]);
  }

  console.log('\n[3] 점포 — 진열·취급·커버리지·점포 결품');
  {
    const a = G(r, 'himart', 'sku', 'SKU-0001');
    check('SKU-0001 진열 S1·S3 = 2, 취급 S1·S3 = 2 (S2 재고 0)', a.displayStores === 2 && a.handlingStores === 2 && a.storeOuts === 1, a);
    const h = G(r, 'himart', 'channel');
    check('하이마트 전체: 진열 2 · 취급 3(S1·S3·S5, 미매칭만 있는 S4 제외) · 커버리지 3/5', h.displayStores === 2 && h.handlingStores === 3 && near(h.coverage, 0.6), h);
    const outs = r.storeOuts.map(o => o.channelId + '/' + o.store + '/' + o.skuId + '/' + o.monthSale);
    check('점포 결품: 하이마트 S2(재고 파일 당월판매 2) · 전자랜드 E1(원장 9월 판매 3, 재고 행 없음) — 미매칭 S4 제외', J(outs) === J(['himart/S2/SKU-0001/2', 'etland/E1/SKU-0001/3']), outs);
    check('  ↳ 점포명·지역', r.storeOuts[0].storeName === 'S2점' && r.storeOuts[0].region === '강남');
    const ch = x => r.channels.find(c => c.channelId === x);
    check('당월판매 원천: 하이마트 재고 파일, 전자랜드 원장(9월)', ch('himart').monthSaleSource === 'stock' && ch('etland').monthSaleSource === 'ledger' && ch('etland').monthSaleMonth === '2026-09');
    const e = G(r, 'etland', 'sku', 'SKU-0001');
    check('전자랜드 SKU-0001: 진열 E3 · 취급 E2·E3 · 커버리지 2/4 · 결품 1', e.displayStores === 1 && e.handlingStores === 2 && near(e.coverage, 0.5) && e.storeOuts === 1, e);
    const all = G(r, '*', 'sku', 'SKU-0001');
    check('전체 채널 SKU-0001: 정상 52 · 진열 3 · 결품 2 · 재고일수 = 52 ÷ (32/28)', all.stock['정상'] === 52 && all.displayStores === 3 && all.storeOuts === 2 && near(all.days, 52 / (32 / 28)), all);
    check('점포 표는 요청한 채널만', r.stores.length === 0 && r.storeChannel === '');
    const rs = compute(g0, { storeChannel: 'himart' });
    const rows = rs.stores.map(x => [x.store, x.skuId || x.code, x['정상'], x['전시'], x.other, x.total, x.monthSale, x.display, x.out].join(':'));
    check('하이마트 점포 표: 점포 × SKU(미매칭은 코드, 재고구분 모름 → other)', J(rows) === J(['S1:SKU-0001:3:1:0:4:5:true:false', 'S2:SKU-0001:0:0:0:0:2:false:true',
      'S3:SKU-0001:0:1:0:1:0:true:false', 'S3:SKU-0002:0:0:0:0:0:false:false', 'S4:COFFEE:0:0:7:7:1:false:false', 'S5:SKU-0003:5:0:0:5:0:false:false']), rows);
  }

  console.log('\n[4] 데이터 기준일·지연');
  {
    const ch = x => r.channels.find(c => c.channelId === x);
    check('하이마트 재고 09-24(3일 전) — 지연 아님(3일 초과부터)', ch('himart').stockDate === '2026-09-24' && ch('himart').stockAge === 3 && !ch('himart').staleStock);
    check('전자랜드 판매 09-20(7일 전) → 지연', ch('etland').salesAge === 7 && ch('etland').staleSales === true);
    check('업로드 없는 채널: 기준일 없음, 지연 아님', !ch('traders').hasStock && !ch('traders').hasSales && !ch('traders').staleStock && ch('traders').stockDate === '');
    check('점포마스터 점포 수', ch('himart').storeTotal === 5 && ch('etland').storeTotal === 4);
    check('채널 순서 = 정렬순서', r.channels.map(c => c.channelId).join() === 'himart,etland,emart,traders');
  }

  console.log('\n[5] offline_getInventory — 세션, 채널별 점포 표, 캐시와 무효화');
  {
    const g = env();
    const a = g.call('offline_getInventory', { channelId: 'himart' });
    check('성공 + 점포 표(하이마트)', a.success && a.stores.length === 6 && a.storeChannel === 'himart' && G(a, 'himart', 'channel').total === 266, a.error || a.stores.length);
    check('설정 기본값을 씀', a.settings['재고경보_과다일수'] === 90 && a.windowDays === 28);
    const b = g.call('offline_getInventory', { channelId: 'himart' });
    check('두 번째는 캐시', b.cached === true && b.stores.length === 6);
    const c = g.call('offline_getInventory', {});
    check('채널 없이 → 점포 표 없음(캐시 키가 다름)', !c.cached && c.stores.length === 0);
    const up = g.call('offline_saveMapping', { items: [{ op: 'upsert', channelId: 'himart', code: 'COFFEE', skuId: 'SKU-0003', stockType: '정상' }] });
    const d = g.call('offline_getInventory', { channelId: 'himart' });
    check('매핑 저장 뒤에는 새로 계산(COFFEE → 더 슬림)', up.success && !d.cached && G(d, 'himart', 'sku', 'SKU-0003').stock['정상'] === 207, d.error);
  }

  console.log('\n[6] offline_getDailySales — day와 period를 나눠, 집계 단위별, 하이마트 설치완료');
  {
    const g = env();
    const d = g.call('offline_getDailySales', { from: '2026-09-01', to: '2026-09-24', channelId: 'himart', level: 'model' });
    check('성공, 단위 model', d.success && d.level === 'model', d.error);
    check('period 1건: 9/1~9/23 더 플렌더 MAX 20 · 설치 18', J(d.periods.map(p => [p.start, p.end, p.key, p.qty, p.inst])) === J([['2026-09-01', '2026-09-23', '더플렌더|더 플렌더 MAX', 20, 18]]), d.periods);
    const days = d.days.map(x => x.date + ':' + (x.key || '미매칭') + ':' + x.qty);
    check('day: 9/10 건조기 28 · 9/15 슬림 28 · 9/24 미매칭 5 · 9/24 MAX 8 (8/20·9/25 제외)', J(days) === J(['2026-09-10:미니건조기|미니 건조기 PRO:28', '2026-09-15:더슬림|더 슬림:28',
      '2026-09-24:미매칭:5', '2026-09-24:더플렌더|더 플렌더 MAX:8']), days);
    check('키 목록은 카탈로그 순(음식물처리기 → 청소기 → 건조기)', d.keys.map(k => k.key).join() === '더플렌더|더 플렌더 MAX,더슬림|더 슬림,미니건조기|미니 건조기 PRO', d.keys);
    check('하이마트는 설치완료수량 있음 · 합계', d.hasInst.himart === true && d.totals.qty === 89 && d.totals.unmatchedQty === 5 && d.totals.inst === 81, d.totals);
    check('미매칭 목록', J(d.unmatched) === J([{ channelId: 'himart', code: 'COFFEE', qty: 5, inst: 0 }]), d.unmatched);
    const c = g.call('offline_getDailySales', { from: '2026-09-01', to: '2026-09-30', level: 'category' });
    check('채널 없이 대분류 단위 — 전자랜드 포함, 전자랜드는 설치완료 없음', c.keys.map(k => k.key).join() === '음식물처리기,청소기,건조기' &&
      c.days.some(x => x.channelId === 'etland' && x.key === '음식물처리기' && x.qty === 3) && !c.hasInst.etland, c.keys);
    const s = g.call('offline_getDailySales', { from: '2026-09-01', to: '2026-09-30', channelId: 'himart', level: 'sku' });
    check('SKU 단위 — 이름·skuId', s.keys.some(k => k.key === 'SKU-0002' && k.name === '미니 건조기 PRO 그레이지'), s.keys);
    check('기간 검증', /기간이 올바르지/.test(g.call('offline_getDailySales', { from: '2026-09-30', to: '2026-09-01' }).error) &&
      /400일/.test(g.call('offline_getDailySales', { from: '2025-01-01', to: '2026-09-01' }).error));
  }

  console.log('\n[7] offline_getInventoryTrend — 기준일마다 채널별 재고');
  {
    const g = env();
    const t = g.call('offline_getInventoryTrend', { from: '2026-09-01', to: '2026-09-30', skuId: 'SKU-0001' });
    const h = t.series.find(s => s.channelId === 'himart');
    check('SKU-0001 하이마트: 09-23 999 → 09-24 56(정상 50·전시 4·리퍼 2)', J(h.points.map(p => p.date + ':' + p.total)) === J(['2026-09-23:999', '2026-09-24:56']) && h.points[1]['전시'] === 4, h.points);
    check('전자랜드 09-25 3 · 날짜 목록', t.series.find(s => s.channelId === 'etland').points[0].total === 3 && t.dates.join() === '2026-09-23,2026-09-24,2026-09-25', t.dates);
    const m = g.call('offline_getInventoryTrend', { from: '2026-09-24', to: '2026-09-24', model: '미니건조기|미니 건조기 PRO' });
    check('모델 필터', m.series.length === 1 && m.series[0].points[0].total === 10, m.series);
    const all = g.call('offline_getInventoryTrend', { from: '2026-09-24', to: '2026-09-24', channelId: 'himart' });
    check('필터 없으면 미매칭 포함(274)', all.series[0].points[0].total === 274 && all.series[0].points[0].unmatched === 8, all.series[0].points[0]);
  }

  console.log('\n[8] offline_saveSettings — 관리자만, 1~365 정수, 결품위험 < 과다, 저장하면 지표 다시 계산');
  {
    const g = env();
    check('일반 사용자 거절', /관리자만/.test(g.call('offline_saveSettings', { settings: { '재고경보_과다일수': 60 } }).error));
    check('모르는 키 거절', /모르는 설정 키/.test(g.call('offline_saveSettings', { settings: { x: 1 } }, 'admin').error));
    check('소수·0·빈칸 거절', /정수/.test(g.call('offline_saveSettings', { settings: { '재고경보_과다일수': 1.5 } }, 'admin').error) &&
      /정수/.test(g.call('offline_saveSettings', { settings: { '재고경보_과다일수': 0 } }, 'admin').error) && /정수/.test(g.call('offline_saveSettings', { settings: { '재고경보_과다일수': '' } }, 'admin').error));
    check('결품위험 ≥ 과다 거절', /작아야/.test(g.call('offline_saveSettings', { settings: { '재고경보_결품위험일수': 90 } }, 'admin').error));
    const before = g.call('offline_getInventory', {});
    const s = g.call('offline_saveSettings', { settings: { '재고경보_과다일수': 40, '재고일수_판매기준일수': 14 } }, 'admin');
    check('관리자 저장 — 탭 값 갱신, 설명·다른 키 그대로(자동반영_사용 Y도 글자 그대로 — 0으로 덮이지 않음)', s.success && s.settings['재고경보_과다일수'] === 40 &&
      J(dataRows(g.tab('설정')).map(r => r[0] + '=' + r[1])) === J(['재고일수_판매기준일수=14', '재고경보_과다일수=40', '재고경보_결품위험일수=14', '데이터지연_경고일수=3', '자동반영_사용=Y', '자동반영_시작시각=7', '자동반영_종료시각=22', '처리완료_보관일수=30', '자동반영_회당최대파일수=10']) && dataRows(g.tab('설정'))[1][2], dataRows(g.tab('설정')));
    const after = g.call('offline_getInventory', {});
    check('저장 뒤 지표 재계산(캐시 무효) — N=14, SKU-0001 하이마트 50 ÷ 2 = 25일', before.windowDays === 28 && !after.cached && after.windowDays === 14 && G(after, 'himart', 'sku', 'SKU-0001').days === 25, after.windowDays);
    check('마스터에도 설정이 실린다', g.call('offline_getMasters').settings['재고경보_과다일수'] === 40);
  }

  console.log('\n[9] offline_deletePrice — 행 삭제, 이관로그에 누가·무엇을');
  {
    const g = env();
    g.call('offline_savePrices', { items: [{ channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', price: 300000, startDate: '2026-01-01' },
      { channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', price: 374220, startDate: '2026-04-09', note: '이관' }] });
    const res = g.call('offline_deletePrice', { channelId: 'himart', line: '더플렌더', model: '더플렌더 MAX', startDate: '2026-04-09' });
    const rows = dataRows(g.tab('단가마스터'));
    check('삭제 성공 — 그 행만 없어짐(모델 표기는 카탈로그로 맞춰 찾음)', res.success && rows.length === 1 && rows[0][4] === '2026-01-01' && res.deleted.price === 374220, rows);
    const log = dataRows(g.tab('이관로그')).pop();
    check('이관로그: 삭제자(세션 이메일)·대상 단가 삭제·원래 값', log[1] === USER && log[2] === '단가 삭제' && log[3] === '2026-04-09' && /374220/.test(log[5]) && /비고 이관/.test(log[5]) && log[6] === '성공', log);
    check('없는 행 → 오류', /없는 행/.test(g.call('offline_deletePrice', { channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', startDate: '2026-04-09' }).error));
    check('잘못된 입력 → 오류', /올바르지/.test(g.call('offline_deletePrice', { channelId: 'himart', line: 'x', model: '', startDate: '2026' }).error));
  }

  console.log('\n[10] offline_saveSku 수정 — 보내지 않은 필드는 그대로, 연결 코드 수·품목군 변경 표시');
  {
    const g = env();
    g.ctx._offWriteAll(g.tab('제품마스터'), g.ctx.OFF_TABS.sku, [['SKU-0001', '더 플렌더 MAX', '더플렌더', '더 플렌더 MAX', '', 'Y', 3, '메모']], 3);
    const a = g.call('offline_saveSku', { sku: { skuId: 'SKU-0001', name: '더 플렌더 MAX 그레이지', line: '더플렌더', model: '더 플렌더 MAX', option: '그레이지', active: 'Y', order: 1 } });
    const row = dataRows(g.tab('제품마스터'))[0];
    check('수정 — 비고(안 보냄)는 그대로', a.success && row[1] === '더 플렌더 MAX 그레이지' && row[4] === '그레이지' && row[6] === 1 && row[7] === '메모', row);
    check('연결 코드 수(하이마트 3 + 전자랜드 2 = 5), 품목군 안 바뀜', a.mappedCodes === 5 && a.lineChanged === false, a);
    const b = g.call('offline_saveSku', { sku: { skuId: 'SKU-0001', name: 'x', line: '더슬림', active: 'N' } });
    check('품목군 변경 → lineChanged, 비활성화', b.lineChanged === true && dataRows(g.tab('제품마스터'))[0][5] === 'N' && dataRows(g.tab('제품마스터'))[0][3] === '더 플렌더 MAX', b);
    check('활성 값 검증', /Y 또는 N/.test(g.call('offline_saveSku', { sku: { skuId: 'SKU-0001', name: 'x', line: '더슬림', active: '예' } }).error));
    const n = g.call('offline_saveSku', { sku: { name: '새 SKU', line: '더시프트' } });
    check('새 SKU는 예전처럼 빈 필드 기본값(활성 Y)', n.success && n.sku.active === 'Y' && n.sku.model === '' && n.lineChanged === false, n.sku);
  }

  console.log('\n[11] offline_saveTargets 부분 저장 · offline_getMonthly totalsOnly');
  {
    const g = env();
    g.call('offline_saveTargets', { items: [{ ym: '2026-08', channelId: 'traders', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 10, actual: 7 }] });
    const res = g.call('offline_saveTargets', { items: [{ ym: '2026-08', channelId: 'traders', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 12 }] });
    const row = dataRows(g.tab('목표실적_월')).find(r => r[0] === '2026-08' && r[4] === 'IN');
    check('목표만 보내면 실적은 그대로(연간 보기)', res.success && row[5] === 12 && row[6] === 7, row);
    g.call('offline_saveTargets', { items: [{ ym: '2026-08', channelId: 'traders', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 12, actual: '' }] });
    check('빈칸(\'\')은 예전처럼 지우기', dataRows(g.tab('목표실적_월')).find(r => r[0] === '2026-08' && r[4] === 'IN')[6] === '');
    const full = g.call('offline_getMonthly', { from: '2026-08', to: '2026-09' });
    const t = g.call('offline_getMonthly', { from: '2026-08', to: '2026-09', totalsOnly: true });
    check('totalsOnly — 행 없이 합계는 같음, 캐시 키 분리', t.totalsOnly && !t.rows.length && full.rows.length > 0 && !t.cached &&
      J(t.totals) === J(full.totals) && J(t.unmatched) === J(full.unmatched), [t.rows.length, full.rows.length]);
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})();
