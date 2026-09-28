/* 오프라인 화면 3종(2-B) — 채널 현황·채널 상세·재고 현황. index.html이 싣는 프론트 실코드 + GAS 실코드(목 시트)를
   HTTP만 빼고 직결한다(_gasFetch → doPost). 픽스처는 tests/lib/offline-2b-fixture.js(재고·판매) + 여기서 넣는 목표.

   지키려는 성질:
     · 진입 훅이 필요한 API만 부른다(채널 현황: 그 해 월별 합계 totalsOnly + 전체 재고), 화면을 오갈 때는 메모를 쓰고
       쓰기(설정 저장 등)가 성공하면 메모를 비운다
     · 채널 현황: KPI 달성률 = 실적 ÷ 목표(월 / 연 누적), 대분류 필터는 대분류 단위 이관 행까지, 활성 + 데이터 있는 비활성 채널 카드,
       업로드 없는 채널은 "업로드 데이터 없음", 카드 → 채널 상세, 데이터 지연 배지 + 업로드 링크
     · 채널 상세: #offline/channel → 첫 활성 채널, 모델·SKU 표(SKU OUT = 원장), 대분류 합계만 있는 달 안내, 미매칭 줄,
       period 블록, 하이마트 설치완료 토글, 점포 표 검색·결품·정렬·CSV, 이마트 당월 누적 안내
     · 재고 현황: 재고구분 토글, 미매칭은 [전체]에서만 수량, 경보 3탭, 관리자만 설정 버튼, 설정 검증·저장 후 재계산

   실행: node tests/offline-screens-ui.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadFrontend } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
const FX = require(path.join(__dirname, 'lib', 'offline-2b-fixture.js'));
const { dataRows } = require(path.join(__dirname, 'lib', 'offline-gas.js'));
const PROJ = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 600) : '')); }
}
const J = JSON.stringify;
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0)); };
const SHIM = 'get OF(){return OFFLINE_FILTER;}, get OCS(){return _OCS;}, get OCD(){return _OCD;}, get OIV(){return _OIV;}, get PAGE_MOUNTS(){return PAGE_MOUNTS;}, get MEMO(){return _OFFLINE_MEMO;}';
const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

function setup() {
  const g = FX.env();
  // 목표: 하이마트 9월·8월(더 플렌더 MAX), 트레이더스(비활성, 업로드 없음) 9월, 하이마트 8월 건조기 대분류 단위 이관 행
  g.call('offline_saveTargets', { items: [
    { ym: '2026-09', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 100, actual: 90 },
    { ym: '2026-09', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'OUT', target: 60 },
    { ym: '2026-08', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 80, actual: 80 },
    { ym: '2026-08', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'OUT', target: 50, actual: 40 },
    { ym: '2026-09', channelId: 'traders', line: '더시프트', model: '더 시프트', type: 'OUT', target: 30, actual: 20 }] });
  const T = g.ctx.OFF_TABS, tg = g.tab(T.targets.name);
  g.ctx._offWriteBlock(tg, T.targets, tg.getLastRow() + 1, [['2026-08', 'himart', '', '', 'IN', 20, 15, 'migration', '2026-09-27', 'a', '진행현황 이관(모델 구분 없음)', '건조기']]);
  g.ctx._offInvalidateCache();

  const { ctx, X } = loadFrontend(PROJ, SHIM);
  const box = {};
  const el = id => (box[id] = box[id] || { id, innerHTML: '', value: '', textContent: '', dataset: {}, style: {},
    getContext: () => ({}), scrollIntoView() { this.scrolled = true; },
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } } });
  ctx.document.getElementById = el;
  const charts = [];
  ctx.Chart = function (_el, cfg) { charts.push(cfg); return { destroy() {} }; };
  const blobs = [];
  ctx.Blob = function (parts) { blobs.push(parts.join('')); };
  ctx.URL.createObjectURL = () => 'blob:x'; ctx.URL.revokeObjectURL = () => {};
  const calls = [];
  ctx._getToken = () => 'T';
  ctx._gasFetch = async (url, opts) => { const b = JSON.parse(opts.body); calls.push({ action: b.action, data: b.data }); return g.call(b.action, b.data, 'admin'); };
  ctx.sessionStorage.setItem('gp_user', J({ email: FX.ADMIN, name: '관리자' }));
  X.OF.ym = '2026-09';
  const page = id => el('page-' + id).innerHTML;
  const urls = ctx.history._urls;
  return { g, ctx, X, el, charts, blobs, calls, page, urls };
}

(async function main() {
  console.log('\n[1] 채널 현황 — 진입·KPI·카드·매트릭스');
  const S = setup();
  {
    const { ctx, X, calls, page } = S;
    check('PAGE_MOUNTS에 화면 3종', ['offline-channels', 'offline-channel', 'offline-inventory'].every(p => typeof X.PAGE_MOUNTS[p] === 'function'));
    ctx.navPage('offline-channels', null);
    await settle();
    const acts = calls.map(c => c.action + (c.action === 'offline_getMonthly' ? J(c.data) : ''));
    check('부른 API: 마스터 · 그 해 1~12월 합계(totalsOnly) · 전체 재고', acts.indexOf('offline_getMasters') >= 0 && acts.indexOf('offline_getMonthly{"from":"2026-01","to":"2026-12","totalsOnly":true}') >= 0 &&
      acts.indexOf('offline_getInventory') >= 0 && calls.length === 3, acts);
    const h = page('offline-channels'), t = text(h);
    // 9월 IN: 하이마트 MAX 목표 100 · 실적 90 → 90%
    check('KPI 전체 IN 달성률 90% (실적 90 / 목표 100)', /전체 IN 달성률 90% 실적 90 \/ 목표 100/.test(t), t.slice(0, 400));
    // 9월 OUT: 하이마트 원장 134(9/25 50 포함 — 월별 해석은 기간종료일의 달) + 전자랜드 4 + 트레이더스 입력 20 = 158, 목표 60 + 30 = 90
    check('KPI 전체 OUT 달성률 175.6% (158 / 90) — 원장은 월 기준, 입력값 합산', /전체 OUT 달성률 175\.6% 실적 158 \/ 목표 90/.test(t), t.slice(0, 400));
    check('KPI 정상재고 = 전체 채널 정상(260 + 2)', /전체 정상재고 262 대/.test(t), t.slice(0, 600));
    check('KPI 경보 = 과다 1 · 결품 위험 1 · 점포 결품 2', /경보 4 건 과다 1 · 결품 위험 1 · 점포 결품 2/.test(t), t.slice(0, 700));
    const names = [...h.matchAll(/<span class="of-card-name">([^<]+)</g)].map(m => m[1]);
    check('카드 = 활성(하이마트·전자랜드·이마트) + 데이터 있는 비활성(트레이더스), 정렬순서대로', J(names) === J(['하이마트', '전자랜드', '이마트', '트레이더스']), names);
    const card = ch => { const i = h.indexOf(`_ofGo('offline-channel','${ch}')`); return text(h.slice(i, h.indexOf('<div class="of-card"', i + 10) < 0 ? h.length : h.indexOf('<div class="of-card"', i + 10))); };
    check('하이마트 카드: 정상재고 260 · 재고일수 · 진열 2 / 5 · 경보 배지', /정상재고 260/.test(card('himart')) && /진열 점포 2 \/ 5/.test(card('himart')) && /과다 1/.test(card('himart')) && /결품 위험 1/.test(card('himart')), card('himart'));
    check('하이마트 IN−OUT 갭 = 90 − 134 = −44', /IN−OUT 갭 -44/.test(card('himart')), card('himart'));
    check('트레이더스(업로드 없음): 목표·실적만 + "업로드 데이터 없음"', /업로드 데이터 없음/.test(card('traders')) && /실적 20 \/ 목표 30/.test(card('traders')) && !/정상재고/.test(card('traders')), card('traders'));
    check('데이터 기준일 — 전자랜드 판매 7일 전 지연 배지 + 데이터 업로드 링크', /전자랜드 판매 9\/20 ⚠ 7일 전/.test(t) && h.indexOf(`_ofGo('admin-upload')`) > 0, t.slice(0, 300));
    check('미매칭 재고 안내 + 코드 매핑 링크', /매핑 안 된 코드 — 재고 8/.test(t) && h.indexOf(`_ofGo('admin-code-mapping')`) > 0);
    check('매트릭스: 하이마트 음식물처리기 OUT 223.3% (MAX 78+... / 60)', /채널 × 대분류 달성률/.test(t) && h.indexOf('of-mx-cell of-r-good') > 0, '');
    ctx._ocsSetMx('in');
    check('매트릭스 IN 전환', /class="on" onclick="_ocsSetMx\('in'\)"/.test(page('offline-channels')));
    ctx._ofSetFilter('mode', 'ytd');
    await settle();
    const t2 = text(page('offline-channels'));
    check('연 누적: IN 목표 100 + 80 + 대분류 이관 20 = 200, 실적 90 + 80 + 15 = 185 → 92.5%', /전체 IN 달성률 92\.5% 실적 185 \/ 목표 200/.test(t2) && /2026-01 ~ 2026-09 누적/.test(t2), t2.slice(0, 500));
    ctx._ofSetFilter('category', '건조기');
    const t3 = text(page('offline-channels'));
    check('대분류 필터(건조기) — 대분류 단위 이관 행 포함: IN 15 / 20 = 75%', /전체 IN 달성률 75% 실적 15 \/ 목표 20/.test(t3) && /전체 정상재고 · 건조기 10 대/.test(t3), t3.slice(0, 500));
    ctx._ofSetFilter('category', ''); ctx._ofSetFilter('mode', 'month'); ctx._ofSetFilter('unit', 'amount');
    const t4 = text(page('offline-channels'));
    check('금액 모드 — 단가 없으면 금액 없음(—) + 미완 표시(*)', /전체 IN 달성률 — 실적 — \* \/ 목표 —/.test(t4) && /IN 금액\(실적\) — \*/.test(t4), t4.slice(0, 300));
    ctx._ofSetFilter('unit', 'qty');
    const before = calls.length;
    ctx.navPage('offline-channels', null);
    await settle();
    check('다시 들어오면 메모 재사용(마스터만 다시 받지 않고 API 0회)', calls.length === before, calls.slice(before).map(c => c.action));
  }

  console.log('\n[2] 채널 상세 — 첫 채널 이동·표·일별·점포');
  {
    const { ctx, X, calls, page, urls, charts, blobs } = S;
    X.OCD.dailyRange = { from: '2026-08-01', to: '2026-09-30' };
    ctx.navPage('offline-channel', null);
    await settle();
    check('#offline/channel → 첫 활성 채널(#offline/channel/himart)', /#offline\/channel\/himart$/.test(urls[urls.length - 1]) && X.OCD.ch === 'himart', urls.slice(-2));
    const h = page('offline-channel'), t = text(h);
    check('채널 탭: 활성 채널만(트레이더스 없음)', /of-tab on[^>]*>하이마트/.test(h) && h.indexOf("_ofGo('offline-channel','etland')") > 0 && h.indexOf("_ofGo('offline-channel','traders')") < 0);
    check('모델 행: 더 플렌더 MAX IN 100 / 90 / 90% · OUT 60 / 78 / 130% · 정상 50 · 전시 4 · 리퍼 2 · 50일 · 진열 2',
      /더 플렌더 MAX SKU 1 100 90 90% 60 78 130% 50 4 2 50일 2/.test(t), t.slice(t.indexOf('음식물처리기'), t.indexOf('음식물처리기') + 200));
    check('미매칭 줄: 판매 5 · 재고 8 + 코드 매핑 링크', /미매칭 코드 매핑 → 5 8/.test(t), t.slice(t.indexOf('미매칭 코드'), t.indexOf('미매칭 코드') + 60));
    check('채널 합계: IN 100 / 90 · OUT 60 / 134 · 정상 260', /채널 합계 100 90 90% 60 134 223\.3% 260 4 2/.test(t), t.slice(t.indexOf('채널 합계'), t.indexOf('채널 합계') + 80));
    ctx._ocdToggleSku('himart|더플렌더|더 플렌더 MAX');
    const t2 = text(page('offline-channel'));
    check('SKU 펼침: SKU-0001 OUT 실적 = 원장 9월(20 + 8 + 50 = 78)', /더 플렌더 MAX SKU-0001 — — — 78 50 4 2 50일 2/.test(t2), t2.slice(t2.indexOf('SKU-0001') - 20, t2.indexOf('SKU-0001') + 80));
    const monthly = charts.filter(c => c.data.datasets.some(d => d.label === 'OUT 목표')).pop();
    check('월별 추이 차트: 1~12월, OUT 실적 9월 134 · OUT 목표 8월 50', monthly && monthly.data.labels.length === 12 && monthly.data.datasets[1].data[8] === 134 && monthly.data.datasets[3].data[7] === 50, monthly && monthly.data.datasets.map(d => d.data));
    const daily = charts.filter(c => c.data.datasets[0].label === '일별').pop();
    const per = daily && daily.data.datasets.find(d => d._p);
    check('일별 차트: period 9/1~9/23 = 20 → 블록 높이 20/23, 9/24 막대 13(MAX 8 + 미매칭 5), 9/25 50', per && per.label === '기간 9/1~9/23' && Math.abs(per.data[31] - 20 / 23) < 1e-9 && per.data[30] === null &&
      daily.data.datasets[0].data[54] === 13 && daily.data.datasets[0].data[55] === 50, per && [per.data[31], daily.data.datasets[0].data.slice(53, 56)]);
    check('하이마트 [판매등록 / 설치완료] 토글', /판매등록/.test(S.el('ocdDailyCtl').innerHTML) && /설치완료/.test(S.el('ocdDailyCtl').innerHTML));
    ctx._ocdSetDmode('inst');
    const di = charts.filter(c => c.data.datasets[0].label === '일별').pop();
    check('  ↳ 설치완료 — 9/24 7 · period 18', di.data.datasets[0].data[54] === 7 && di.data.datasets.find(d => d._p)._p.qty === 18);
    ctx._ocdSetDmode('qty');
    // 점포 표
    const st = S.el('ocdStoreCard').innerHTML || h;
    check('점포 표: 결품 배지 1 · 당월판매 원천 안내(재고 파일)', /점포 결품 1/.test(text(page('offline-channel'))) && /당월판매 = 재고 파일의 당월 누적 판매/.test(text(page('offline-channel'))));
    ctx._ocdStoreSet('q', 'S2', true);
    const tb = text(S.el('ocdStoreTbl').innerHTML);
    check('검색 S2 → 1행, 결품 강조', /S2점 S2 강남 더 플렌더 MAX 0 0 0 0 2 결품/.test(tb) && (S.el('ocdStoreTbl').innerHTML.match(/<tr class="of-out">/g) || []).length === 1, tb);
    ctx._ocdStoreSet('q', '', true); ctx._ocdStoreSet('outOnly', true);
    check('결품만 → 1행', (S.el('ocdStoreCard').innerHTML.match(/<tbody>([\s\S]*?)<\/tbody>/)[1].match(/<tr /g) || []).length === 1);
    ctx._ocdStoreSet('outOnly', false);
    ctx._ocdStoreSort('total');
    const firstRow = text((S.el('ocdStoreTbl').innerHTML.match(/<tbody><tr[^>]*>([\s\S]*?)<\/tr>/) || [])[1] || '');
    check('합계 정렬(내림차순) — 미매칭 S4(7)가 맨 위', /^ ?S4점 S4 강북 미매칭 COFFEE/.test(firstRow), firstRow);
    ctx._ocdStoreCsv();
    const csv = blobs.pop() || '';
    const lines = csv.replace(/^﻿/, '').split('\r\n');
    check('CSV — BOM, 헤더, 6행(미매칭 포함), 결품 Y', csv[0] === '﻿' && lines[0].indexOf('점포코드,점포명,지역,sku_id') > 0 && lines.length === 7 && lines.some(l => /,S2,S2점,강남,SKU-0001,.*,Y$/.test(l)), lines);
    // 이마트 안내 · 전자랜드 원장 안내 · 업로드 없는 채널
    X.OCD.ch = 'emart';
    const emartNote = ctx._ocdStoreHtml({ monthSaleSource: 'ledger', monthSaleMonth: '2026-09', storeTotal: 3 });
    check('이마트: "당월 누적 기준" 안내 없이 점포별 일별 판매 합(트레이더스 분리 후)', !/당월 누적/.test(emartNote) && /판매원장의 2026-09 점포별 일별 판매 합/.test(emartNote), emartNote.slice(0, 400));
    X.OCD.ch = 'himart';
    ctx._ofGo('offline-channel', 'etland');
    await settle();
    check('전자랜드: 당월판매 = 판매원장 9월 점포 판매 안내', /당월판매 = 판매원장의 2026-09 점포별 일별 판매 합/.test(text(page('offline-channel'))), text(page('offline-channel')).slice(-600));
    ctx._ofGo('offline-channel', 'traders');
    await settle();
    const tt = text(page('offline-channel'));
    check('트레이더스(업로드 없음): 일별·점포 "업로드 데이터 없음", 목표 표는 그대로', (tt.match(/업로드 데이터 없음/g) || []).length === 2 && /더 시프트 — — — 30 20 66\.7%/.test(tt), tt.slice(0, 900));
    ctx._ofGo('offline-channel', 'himart');
    await settle();
    ctx._ofSetFilter('mode', 'ytd');
    await settle();
    const ty = text(page('offline-channel'));
    check('연 누적: 8월 건조기 대분류 합계만 존재 안내', /8월은\(는\) 대분류 합계만 존재/.test(ty), ty.slice(ty.indexOf('건조기'), ty.indexOf('건조기') + 200));
    check('  ↳ SKU OUT 범위 = 1/1~9/30 로 다시 조회', calls.some(c => c.action === 'offline_getDailySales' && c.data.from === '2026-01-01' && c.data.to === '2026-09-30' && c.data.level === 'sku'));
    ctx._ofSetFilter('mode', 'month');
  }

  console.log('\n[3] 재고 현황 — 매트릭스·경보·추이·설정');
  {
    const { ctx, X, calls, page, charts } = S;
    const n0 = calls.length;
    ctx.navPage('offline-inventory', null);
    await settle();
    check('전체 재고는 메모(채널 현황에서 받음) — 추가 호출은 추이뿐', calls.slice(n0).map(c => c.action).join() === 'offline_getInventoryTrend', calls.slice(n0).map(c => c.action));
    const tr = calls.filter(c => c.action === 'offline_getInventoryTrend').pop();
    check('추이 기본 = 재고 가장 많은 모델(더 슬림 200)', tr.data.model === '더슬림|더 슬림' && !tr.data.skuId, tr.data);
    let h = page('offline-inventory'), t = text(h);
    check('매트릭스(정상): 하이마트 SKU-0001 50 · 50일 / 전자랜드 2 · 14일', /더 플렌더 MAX SKU-0001 50 50일 · 결품 1 2 14일 · 결품 1 52/.test(t), t.slice(t.indexOf('SKU-0001') - 20, t.indexOf('SKU-0001') + 80));
    check('  ↳ 과다·결품 위험 셀 색, 셀 → 채널 상세', h.indexOf('of-mx-cell of-a-over') > 0 && h.indexOf('of-mx-cell of-a-risk') > 0 && h.indexOf(`_ocdOpenFocus('himart',{skuId:'SKU-0001'})`) > 0);
    check('  ↳ 미매칭은 [정상]에서 (8) — 재고구분 모름', /미매칭 코드 매핑 → \(8\)/.test(t));
    ctx._oivSetType('전시');
    check('[전시] 토글 → 하이마트 SKU-0001 4', /더 플렌더 MAX SKU-0001 4 50일/.test(text(page('offline-inventory'))));
    ctx._oivSetType('all');
    t = text(page('offline-inventory'));
    check('[전체] → 56 · 미매칭 8 · 합계(미매칭 포함) 하이마트 274', /더 플렌더 MAX SKU-0001 56/.test(t) && /미매칭 코드 매핑 → 8/.test(t) && /합계 \(미매칭 포함\) 274/.test(t), t.slice(t.indexOf('합계 (')));
    ctx._oivSetType('정상');
    check('경보 [과다]: 하이마트 더 슬림 200일', /과다 1/.test(t) && /하이마트 더 슬림 SKU-0003 200 28 1 200일/.test(text(page('offline-inventory'))), '');
    ctx._oivSetTab('risk');
    check('경보 [결품 위험]: 미니 건조기 PRO 10일', /하이마트 미니 건조기 PRO 그레이지 SKU-0002 10 28 1 10일/.test(text(page('offline-inventory'))));
    ctx._oivSetTab('storeOut');
    h = page('offline-inventory');
    check('경보 [점포 결품]: S2점 · E1점 + 점포로 이동 링크(결품만)', /S2점/.test(h) && /E1점/.test(h) && h.indexOf(`_ocdOpenFocus('himart',{store:'S2점',outOnly:true})`) > 0);
    check('관리자 → 설정 버튼', h.indexOf('_oivOpenSettings()') > 0);
    ctx.sessionStorage.setItem('gp_user', J({ email: FX.USER }));
    ctx._oivRender();
    check('일반 사용자 → 설정 버튼 없음', page('offline-inventory').indexOf('_oivOpenSettings()') < 0);
    ctx.sessionStorage.setItem('gp_user', J({ email: FX.ADMIN }));
    ctx._oivOpenSettings();
    check('설정 모달: 현재 값 4개', /경보 기준 설정/.test(page('offline-inventory')) && X.OIV.set.draft['재고경보_과다일수'] === 90);
    X.OIV.set.draft['재고경보_결품위험일수'] = '95';
    const n1 = calls.length;
    await ctx._oivSaveSettings();
    check('검증: 결품 위험 ≥ 과다 → 오류, 저장 안 함', /결품 위험 일수는 과다 일수보다 작아야/.test(page('offline-inventory')) && calls.length === n1);
    X.OIV.set.draft['재고경보_결품위험일수'] = '14'; X.OIV.set.draft['재고일수_판매기준일수'] = '14';
    await ctx._oivSaveSettings();
    await settle();
    const save = calls.slice(n1).find(c => c.action === 'offline_saveSettings');
    check('저장 → offline_saveSettings(숫자) → 메모 비우고 다시 조회(N=14)', save && save.data.settings['재고일수_판매기준일수'] === 14 &&
      calls.slice(n1).some(c => c.action === 'offline_getInventory') && X.OIV.inv.windowDays === 14 && !X.OIV.set.open, calls.slice(n1).map(c => c.action));
    check('  ↳ 시트 설정 탭 값', dataRows(S.g.tab('설정')).find(r => r[0] === '재고일수_판매기준일수')[1] === 14);
    check('  ↳ 설명 문구도 새 값', /최근 14 일 일평균/.test(text(page('offline-inventory'))));
    // 경보 목록 → 채널 상세 점포 필터
    ctx._ocdOpenFocus('himart', { store: 'S2점', outOnly: true });
    await settle();
    check('점포 결품 링크 → 채널 상세 하이마트, 검색어·결품만 채워짐', X.OCD.ch === 'himart' && X.OCD.store.q === 'S2점' && X.OCD.store.outOnly === true, X.OCD.store);
    ctx._ocdOpenFocus('himart', { skuId: 'SKU-0003' });
    await settle();
    check('SKU 링크 → 그 모델 펼침 + 강조', /<tr class="of-lv-sku of-focus" id="ocdSku-SKU-0003">/.test(page('offline-channel')));
    const trend = charts.filter(c => c.type === 'line').pop();
    check('추이 차트: 채널별 선', trend && trend.data.datasets.map(d => d.label).join() === '하이마트', trend && trend.data.datasets.map(d => d.label));
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL  예외: ' + e.stack); process.exit(1); });
