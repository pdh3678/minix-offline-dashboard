/* 채널 대분류(2026-10-02) — 채널마스터 채널대분류로 묶어 보이기·소계·필터. 프론트 실코드 + GAS 실코드(목 시트)를 HTTP만 빼고 직결한다.
   픽스처 = tests/lib/offline-2b-fixture.js(하이마트·전자랜드 양판점, 이마트·트레이더스 할인점 — 재고·판매) + 여기서 넣는 채널(신세계백화점 백화점,
   디에이블앤 폐쇄몰)·목표·단가.

   지키려는 성질:
     · 채널 현황: 카드를 채널대분류 순서(양판점 → 할인점 → 백화점 → 폐쇄몰)로 묶고 묶음 머리 = 소속 채널 합(IN·OUT 목표·실적·달성률),
       매트릭스는 채널대분류마다 '○○ 소계' 줄(= 소속 채널 합), 전체 = 소계 합
     · 채널 대분류 필터: KPI·카드·매트릭스·데이터 기준일·경보가 그 대분류 채널만. 전체 정상재고('*')는 그 대분류 재고 채널의 합 —
       재고 채널이 모두 그 대분류면 서버 '*'와 같다
     · 채널 상세: 탭을 채널대분류로 묶고, 필터를 바꾸면 그 대분류 채널로 옮긴다. 판매 분석 머리에 '채널대분류 · 채널명'
     · 재고 현황: 매트릭스 머리 위 줄 = 채널대분류 묶음, 필터가 걸리면 그 대분류 재고 채널만
     · 목표 관리 월별 입력·연간 보기: 채널대분류 머리 줄 + 소계 줄(= 소속 채널 합계의 합), 필터, 저장하지 않은 변경이 있으면 필터를 못 바꿈,
       필터가 걸리면 연간 보기의 공동구매·파트 합계 줄을 숨긴다
     · 데이터 업로드 현황은 채널대분류 머리 줄로 묶고, 업로드로그·코드 매핑 채널 칸은 '채널대분류 · 채널명'
     · 파트 홈 채널군 카드 아래 펼침 표 — 채널군 → 채널대분류(소계 = 소속 채널 합) → 채널

   실행: node tests/offline-channel-category.test.js  (또는 node tests/run-all.js) */
const path = require('path');
const { loadFrontend } = require(path.join(__dirname, 'lib', 'front-sandbox.js'));
const FX = require(path.join(__dirname, 'lib', 'offline-2b-fixture.js'));
const PROJ = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 600) : '')); }
}
const J = JSON.stringify;
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0)); };
const SHIM = 'get OF(){return OFFLINE_FILTER;}, get OCS(){return _OCS;}, get OCD(){return _OCD;}, get OIV(){return _OIV;}, get TG(){return _TG;}, get TGA(){return _TGA;}, get UP(){return _UP;}, tgaId(s){return _tgaId(s);}';
const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const rowOf = (h, label) => (String(h).split('<tr').find(x => x.indexOf(label) >= 0) || '');

function setup() {
  const g = FX.env();
  const T = g.ctx.OFF_TABS;
  const append = (key, rows) => { const sh = g.tab(T[key].name); g.ctx._offWriteBlock(sh, T[key], sh.getLastRow() + 1, rows); };
  append('channel', [['shinsegae', '신세계백화점', '백화점', 'Y', 5, '', '', '', 'shinsegae', 0, 'input', '신세계'],
    ['theablen', '디에이블앤', '폐쇄몰', 'Y', 6, '', '', '', 'theablen', 0, 'input', '']]);
  const PR = (ch, line, model, p) => [ch, line, model, p, '2026-01-01', '', '', ''];
  append('prices', [PR('himart', '더플렌더', '더 플렌더 MAX', 400000), PR('etland', '더플렌더', '더 플렌더 MAX', 390000),
    PR('shinsegae', '더슬림', '더 슬림', 200000), PR('theablen', '더슬림', '더 슬림', 150000), PR('traders', '더시프트', '더 시프트', 300000)]);
  const it = (ch, line, model, type, target, actual) => Object.assign({ ym: '2026-09', channelId: ch, line, model, type, target }, actual === undefined ? {} : { actual });
  g.call('offline_saveTargets', { items: [
    it('himart', '더플렌더', '더 플렌더 MAX', 'IN', 100, 90), it('himart', '더플렌더', '더 플렌더 MAX', 'OUT', 60),
    it('etland', '더플렌더', '더 플렌더 MAX', 'IN', 50, 40), it('etland', '더플렌더', '더 플렌더 MAX', 'OUT', 30),
    it('traders', '더시프트', '더 시프트', 'OUT', 30, 20),
    it('shinsegae', '더슬림', '더 슬림', 'IN', 20, 15), it('shinsegae', '더슬림', '더 슬림', 'OUT', 10, 8),
    it('theablen', '더슬림', '더 슬림', 'IN', 10, 5), it('theablen', '더슬림', '더 슬림', 'OUT', 5, 5)] }, 'admin');
  g.ctx._offInvalidateCache();

  const { ctx, X } = loadFrontend(PROJ, SHIM);
  const box = {};
  const el = id => (box[id] = box[id] || { id, innerHTML: '', value: '', textContent: '', dataset: {}, style: {},
    getContext: () => ({}), scrollIntoView() {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } } });
  ctx.document.getElementById = el;
  const charts = [];
  ctx.Chart = function (_el, cfg) { charts.push(cfg); return { destroy() {} }; };
  const toasts = [];
  ctx.showToast = (m, o) => { toasts.push({ m, type: o && o.type }); };
  ctx._getToken = () => 'T';
  ctx._gasFetch = async (url, opts) => { const b = JSON.parse(opts.body); return g.call(b.action, b.data, 'admin'); };
  ctx.sessionStorage.setItem('gp_user', J({ email: FX.ADMIN, name: '관리자' }));
  X.OF.ym = '2026-09';
  return { g, ctx, X, el, box, charts, toasts, page: id => el('page-' + id).innerHTML, urls: ctx.history._urls };
}

(async function main() {
  const S = setup();
  const { g, ctx, X, el, charts, toasts, page, urls } = S;

  console.log('\n[1] 채널 현황 — 채널대분류 묶음·묶음 합계·매트릭스 소계');
  {
    ctx.navPage('offline-channels', null);
    await settle();
    const h = page('offline-channels');
    const grps = [...h.matchAll(/<span class="of-grp-name">([^<]+)</g)].map(m => m[1]);
    check('묶음 순서 = 양판점 → 할인점 → 백화점 → 폐쇄몰(채널 없는 특판은 없음)', J(grps) === J(['양판점', '할인점', '백화점', '폐쇄몰']), grps);
    const grpBlocks = h.split('<div class="of-grp">').slice(1);
    const cardsIn = b => [...b.matchAll(/<span class="of-card-name">([^<]+)</g)].map(m => m[1]);
    check('묶음마다 소속 채널 카드(정렬순서)', J(grpBlocks.map(cardsIn)) === J([['하이마트', '전자랜드'], ['이마트', '트레이더스'], ['신세계백화점'], ['디에이블앤']]), grpBlocks.map(cardsIn));
    const hd = b => text(b.slice(0, b.indexOf('<div class="of-cards">')));
    check('양판점 머리 = 하이마트 + 전자랜드: IN 130 / 150 = 86.7% · OUT 138(원장 134 + 4) / 90 = 153.3%', hd(grpBlocks[0]) === '양판점 채널 2개 합계 IN 86.7% 실적 130 / 목표 150 OUT 153.3% 실적 138 / 목표 90', hd(grpBlocks[0]));
    check('할인점 머리 = 트레이더스 OUT 20 / 30(이마트는 목표·실적 없음) · 백화점 IN 15 / 20 = 75%', /IN — 실적 — \/ 목표 — OUT 66\.7% 실적 20 \/ 목표 30/.test(hd(grpBlocks[1])) && /IN 75% 실적 15 \/ 목표 20 OUT 80% 실적 8 \/ 목표 10/.test(hd(grpBlocks[2])), [hd(grpBlocks[1]), hd(grpBlocks[2])]);
    // 묶음 합계 = 소속 채널 _ofTotals 합(수량·금액 모두)
    const tot = ids => ctx._ofTotals(X.OCS.mon, ids, null, '');
    const sumOf = ids => ids.map(id => tot(id)).reduce((a, t) => { ['in', 'out'].forEach(s => ['target', 'actual', 'targetAmount', 'actualAmount'].forEach(f => { if (t[s][f] != null) a[s][f] = (a[s][f] || 0) + t[s][f]; })); return a; }, { in: {}, out: {} });
    const pick = t => ['in', 'out'].map(s => ['target', 'actual', 'targetAmount', 'actualAmount'].map(f => t[s][f] == null ? null : t[s][f]));
    check('묶음 합계 = 소속 채널 합(목표·실적 수량·금액) — 양판점·할인점·백화점·폐쇄몰', [['himart', 'etland'], ['emart', 'traders'], ['shinsegae'], ['theablen']].every(ids => J(pick(tot(ids))) === J(pick(sumOf(ids)))));
    // 매트릭스(기본 OUT) — 소계 줄
    const mx = h.slice(h.indexOf('채널 × 대분류 달성률'));
    const subs = [...mx.matchAll(/<tr class="of-lv-sub"><td>([^<]+)</g)].map(m => m[1]);
    check('매트릭스 소계 줄 = 채널대분류마다(소속 채널 줄 뒤)', J(subs) === J(['양판점 소계', '할인점 소계', '백화점 소계', '폐쇄몰 소계']) &&
      mx.indexOf('>전자랜드</a>') < mx.indexOf('양판점 소계') && mx.indexOf('양판점 소계') < mx.indexOf('>이마트</a>'), subs);
    const lastCell = row => { const m = [...row.matchAll(/<span class="of-mx-sub">([^<]*)</g)]; return m.length ? m[m.length - 1][1] : ''; };
    check('양판점 소계 합계 칸 = OUT 138 / 90 · 전체 = 소계 합 171 / 135', lastCell(rowOf(mx, '양판점 소계')) === '138 / 90' && lastCell(rowOf(mx, '<td>전체</td>')) === '171 / 135',
      [lastCell(rowOf(mx, '양판점 소계')), lastCell(rowOf(mx, '<td>전체</td>'))]);
    check('카드 머리의 채널대분류 표시(type 대신 channelCategory)', /<span class="of-card-name">신세계백화점<\/span><span class="of-card-type">백화점</.test(h));

    console.log('\n[2] 채널 대분류 필터 — 채널 현황');
    ctx._ofSetFilter('chCat', '양판점');
    const h2 = page('offline-channels'), t2 = text(h2);
    check('필터 바에 채널 대분류 선택(6개 + 전체)', /<span>채널 대분류<\/span><select[^>]*><option value="">전체<\/option><option value="양판점" selected>양판점<\/option><option value="할인점">/.test(h2) && h2.indexOf('<option value="특판">특판</option>') > 0);
    check('KPI = 양판점만: IN 86.7% (130 / 150) · OUT 153.3% (138 / 90)', /전체 IN 달성률 · 양판점 86\.7% 실적 130 \/ 목표 150/.test(t2) && /전체 OUT 달성률 · 양판점 153\.3% 실적 138 \/ 목표 90/.test(t2), t2.slice(0, 400));
    check('카드·묶음 = 양판점(하이마트·전자랜드)만', J([...h2.matchAll(/<span class="of-card-name">([^<]+)</g)].map(m => m[1])) === J(['하이마트', '전자랜드']) && J([...h2.matchAll(/<span class="of-grp-name">([^<]+)</g)].map(m => m[1])) === J(['양판점']));
    check('매트릭스 = 양판점 줄 + 소계 + 전체(양판점) — 전체 = 소계', rowOf(h2, '전체 (양판점)') && lastCell(rowOf(h2, '전체 (양판점)')) === lastCell(rowOf(h2, '양판점 소계')) && h2.indexOf('할인점 소계') < 0);
    check('데이터 기준일 칩 = 양판점 채널(채널대분류 · 채널명)', J([...h2.matchAll(/<span class="of-fresh-ch">([^<]+)</g)].map(m => m[1])) === J(['양판점 · 하이마트', '양판점 · 전자랜드']));
    // 재고 채널(하이마트·전자랜드)이 모두 양판점 → 합친 '*' = 서버 '*'
    const inv = X.OCS.inv, server = inv.groups.find(x => x.channelId === '*' && x.level === 'channel'), scoped = ctx._ofGroup(inv, '*', 'channel', '');
    check('전체 재고(*) — 양판점 채널 합 = 서버 전체(정상·전시·리퍼·최근 판매·일평균·재고일수·진열 점포·결품)', J([scoped.stock, scoped.windowQty, scoped.dailyAvg, scoped.days, scoped.displayStores, scoped.storeOuts]) ===
      J([server.stock, server.windowQty, server.dailyAvg, server.days, server.displayStores, server.storeOuts]) && /전체 정상재고 · 양판점 262 대/.test(t2), [scoped, server]);
    const sku1 = ctx._ofGroup(inv, '*', 'sku', 'SKU-0001'), sku1s = inv.groups.find(x => x.channelId === '*' && x.level === 'sku' && x.key === 'SKU-0001');
    check('  ↳ SKU 단위도 같음(SKU-0001)', J([sku1.stock, sku1.windowQty, sku1.days]) === J([sku1s.stock, sku1s.windowQty, sku1s.days]));
    ctx._ofSetFilter('chCat', '백화점');
    const t3 = text(page('offline-channels'));
    check('백화점 — KPI IN 75% (15 / 20), 재고 채널 없음 → 정상재고 0 · 경보 0 · 기준일 칩 없음', /전체 IN 달성률 · 백화점 75% 실적 15 \/ 목표 20/.test(t3) && /전체 정상재고 · 백화점 0 대/.test(t3) &&
      /경보 0 건/.test(t3) && /업로드된 판매·재고 데이터가 없습니다/.test(t3) && ctx._ofGroup(X.OCS.inv, '*', 'channel', '') === null, t3.slice(0, 500));
    ctx._ofSetFilter('chCat', '');
    check('필터 해제 — 다시 네 묶음', [...page('offline-channels').matchAll(/<span class="of-grp-name">/g)].length === 4);
  }

  console.log('\n[3] 채널 상세 — 탭 묶음 · 필터를 바꾸면 그 대분류 채널로 · 판매 분석 머리');
  {
    ctx.navPage('offline-channel', null);
    await settle();
    check('#offline/channel → 첫 활성 채널(양판점 하이마트)', urls[urls.length - 1] === '/#offline/channel/himart', urls.slice(-2));
    await settle();
    const h = page('offline-channel');
    check('탭 = 채널대분류 묶음(양판점·할인점·백화점·폐쇄몰), 비활성 트레이더스는 없음', J([...h.matchAll(/<span class="of-tab-grp-lb">([^<]+)</g)].map(m => m[1])) === J(['양판점', '할인점', '백화점', '폐쇄몰']) &&
      h.indexOf('>트레이더스<') < 0 && /<span class="of-tab-grp-lb">양판점<\/span><button[^>]*class="of-tab on"[^>]*>하이마트<\/button><button[^>]*>전자랜드</.test(h), h.slice(0, 800));
    check('판매 분석 머리 = 양판점 · 하이마트', page('offline-channel').indexOf('판매 분석 <span class="of-sub">양판점 · 하이마트 · ') >= 0 || el('ocdSalesCard').innerHTML.indexOf('판매 분석 <span class="of-sub">양판점 · 하이마트 · ') >= 0);
    ctx._ofSetFilter('chCat', '백화점');
    await settle();
    check('필터 백화점 → 신세계백화점으로 이동', urls[urls.length - 1] === '/#offline/channel/shinsegae', urls.slice(-2));
    await settle();
    const h2 = page('offline-channel');
    check('  ↳ 탭 = 백화점(신세계백화점)만', J([...h2.matchAll(/<span class="of-tab-grp-lb">([^<]+)</g)].map(m => m[1])) === J(['백화점']) && /class="of-tab on"[^>]*>신세계백화점</.test(h2));
    const n = urls.length;
    ctx._ofSetFilter('chCat', '');
    check('필터 해제 — 지금 채널이 범위 안이면 옮기지 않음', urls.length === n && [...page('offline-channel').matchAll(/of-tab-grp-lb/g)].length === 4);
  }

  console.log('\n[4] 재고 현황 — 머리 묶음 · 필터');
  {
    ctx.navPage('offline-inventory', null);
    await settle();
    const h = page('offline-inventory');
    check('필터 바 = 대분류 + 채널 대분류', h.indexOf('<span>대분류</span>') > 0 && h.indexOf('<span>채널 대분류</span>') > 0);
    check('매트릭스 머리 위 줄 = 채널대분류 묶음(재고 채널 하이마트·전자랜드 = 양판점 2칸)', /<th rowspan="2">SKU<\/th><th class="of-mx-grp" colspan="2">양판점<\/th><th rowspan="2">전체<\/th><\/tr><tr><th>하이마트/.test(h), h.slice(h.indexOf('<thead>'), h.indexOf('<thead>') + 300));
    const body = x => text(x.slice(x.indexOf('<tbody>'), x.indexOf('</tbody>')));
    ctx._ofSetFilter('chCat', '양판점');
    const h2 = page('offline-inventory');
    check('양판점 — 재고 채널이 모두 양판점이라 표 숫자 같음, 전체 머리에 양판점', body(h2) === body(h) && /<th rowspan="2">전체<div class="of-sub">양판점<\/div><\/th>/.test(h2));
    check('경보 목록 채널 칸 = 채널대분류 · 채널명', h2.indexOf('>양판점 · 하이마트</a>') > 0);
    ctx._ofSetFilter('chCat', '할인점');
    const h3 = page('offline-inventory');
    check('할인점 — 재고 채널 없음 안내, 경보 0', h3.indexOf('재고 업로드 데이터가 없습니다') > 0 && /과다 0<\/button><button[^>]*>결품 위험 0<\/button><button[^>]*>점포 결품 0/.test(h3));
    ctx._ofSetFilter('chCat', '');
  }

  console.log('\n[5] 목표 관리 — 월별 입력 묶음·소계·필터');
  {
    ctx.navPage('admin-targets', null);
    await settle();
    X.TG.ym = '2026-09';
    await ctx._tgLoad();
    await settle();
    const h = page('admin-targets');
    check('채널대분류 머리 줄 순서 = 양판점 → 할인점 → 백화점 → 폐쇄몰', J([...h.matchAll(/<tr class="tg-chcat"><td colspan="8">([^ <]+)/g)].map(m => m[1])) === J(['양판점', '할인점', '백화점', '폐쇄몰']));
    check('소계 줄 = 채널들 뒤', h.indexOf('양판점 소계') > h.indexOf('전자랜드 합계') && h.indexOf('양판점 소계') < h.indexOf('<tr class="tg-chcat"><td colspan="8">할인점'));
    const v = (scope, f) => el(ctx._tgTotalId(scope, f)).innerHTML;
    check('양판점 소계 = 하이마트 + 전자랜드: IN 목표 150 · 실적 130 · OUT 목표 90 · 실적 138', v('grp:양판점', 'inT') === '150' && v('grp:양판점', 'inA') === '130' && v('grp:양판점', 'outT') === '90' && v('grp:양판점', 'outA') === '138',
      ['inT', 'inA', 'outT', 'outA'].map(f => v('grp:양판점', f)));
    const T = ctx._tgTotals();
    check('소계 = 소속 채널 합계의 합(모든 칸·금액) · 전체 = 소계 합', ['inT', 'inA', 'outT', 'outA', 'inAAmt', 'outAAmt'].every(f =>
      (T['grp:양판점'][f] || 0) === (T['ch:himart'][f] || 0) + (T['ch:etland'][f] || 0) &&
      (T.all[f] || 0) === ['양판점', '할인점', '백화점', '폐쇄몰'].reduce((a, c) => a + ((T['grp:' + c] || {})[f] || 0), 0)), [T['grp:양판점'], T.all]);
    check('채널 선택지 = 채널대분류 묶음(optgroup)', /<option value="">활성 채널 전체<\/option><optgroup label="양판점"><option value="himart">하이마트<\/option><option value="etland">전자랜드<\/option><\/optgroup><optgroup label="할인점">/.test(h));
    ctx._tgSetChCat('백화점');
    const h2 = page('admin-targets');
    check('필터 백화점 — 신세계백화점만, 전체 합계 (백화점) = IN 15 / 20', J([...h2.matchAll(/<tr class="tg-ch"><td colspan="8">([^ <]+)/g)].map(m => m[1])) === J(['신세계백화점']) &&
      h2.indexOf('전체 합계 (백화점)') > 0 && v('all', 'inA') === '15' && v('all', 'inT') === '20' && X.OF.chCat === '백화점');
    ctx._tgSetEdit(X.TG.view[0], 'inT', '999');
    ctx._tgSetChCat('');
    check('저장하지 않은 변경이 있으면 채널 대분류를 바꾸지 않음(안내)', X.OF.chCat === '백화점' && toasts.some(t => t.type === 'error' && /저장하지 않은 변경 1칸/.test(t.m)), toasts.slice(-1));
    ctx._tgRevert();
    ctx._tgSetChCat('');
    check('되돌린 뒤에는 바뀜', X.OF.chCat === '' && [...page('admin-targets').matchAll(/<tr class="tg-chcat">/g)].length === 4);
  }

  console.log('\n[6] 목표 관리 — 연간 보기 묶음·소계·필터(공동구매 줄)');
  {
    ctx._tgSetTab('annual');
    await settle();
    const h = page('admin-targets');
    const v = (scope, ym) => el(X.tgaId(scope) + '_' + ym).innerHTML;
    check('연간 — 채널대분류 머리 줄·소계 줄, 양판점 9월 IN 목표 소계 150 = 하이마트 100 + 전자랜드 50', J([...h.matchAll(/<tr class="tg-chcat"><td colspan="14">([^ <]+)/g)].map(m => m[1])) === J(['양판점', '할인점', '백화점', '폐쇄몰']) &&
      v('grp:양판점', '09') === '150' && v('ch:himart', '09') === '100' && v('ch:etland', '09') === '50' && v('all', '09') === '180', [v('grp:양판점', '09'), v('all', '09')]);
    check('필터 없을 때 공동구매·파트 합계 줄', h.indexOf('tga-gongu-sep') > 0 && h.indexOf('파트 합계 (IN + 공동구매)') > 0);
    ctx._tgSetChCat('폐쇄몰');
    await settle();
    const h2 = page('admin-targets');
    check('필터 폐쇄몰 — 디에이블앤만, 공동구매·파트 합계 줄 숨김, 전체 = 10', h2.indexOf('tga-gongu-sep') < 0 && h2.indexOf('파트 합계') < 0 && v('all', '09') === '10' &&
      J([...h2.matchAll(/<tr class="tg-ch"><td colspan="14">([^ <]+)/g)].map(m => m[1])) === J(['디에이블앤']));
    ctx._tgSetChCat('');
    ctx._tgSetTab('monthly');
  }

  console.log('\n[7] 데이터 업로드 현황·업로드로그 · 코드 매핑 — 채널대분류');
  {
    ctx.navPage('admin-upload', null);
    await ctx._upRefreshSide();
    const h = page('admin-upload');
    const st = h.slice(h.indexOf('off-status'), h.indexOf('</table>', h.indexOf('off-status')));
    check('데이터 현황 — 채널대분류 머리 줄(양판점 → 할인점 → 백화점 → 폐쇄몰)', J([...st.matchAll(/<tr class="off-grp"><td colspan="4">([^<]+)/g)].map(m => m[1])) === J(['양판점', '할인점', '백화점', '폐쇄몰']), st.slice(0, 300));
    check('업로드로그 — 채널 칸 = 채널대분류 · 채널명', /<th>유형<\/th><th>채널<\/th>/.test(h) && h.indexOf('<td>양판점 · 하이마트</td>') > 0 && h.indexOf('<td>양판점 · 전자랜드</td>') > 0);
    check('여러 채널 업로드 = 채널대분류로 묶은 이름', ctx._offlineChannelsLabel('himart,emart,etland,traders') === '양판점 · 하이마트·전자랜드 / 할인점 · 이마트·트레이더스' &&
      ctx._offlineChannelsLabel('erp') === 'erp');
    ctx.navPage('admin-code-mapping', null);
    await settle();
    const cm = page('admin-code-mapping');
    check('코드 매핑 — 표 채널 칸·채널 필터 = 채널대분류 · 채널명(대분류 순서)', cm.indexOf('<option value="himart">양판점 · 하이마트</option><option value="etland">양판점 · 전자랜드</option><option value="emart">할인점 · 이마트</option>') > 0 &&
      el('cmTable').innerHTML.indexOf('<td>양판점 · 하이마트</td>') >= 0, cm.slice(cm.indexOf('_cmSetFilter'), cm.indexOf('_cmSetFilter') + 400));
  }

  console.log('\n[8] 파트 홈 — 채널군 카드 아래 채널대분류 → 채널 펼침 표');
  {
    const s = g.call('home_getSummary', { ym: '2026-09', mode: 'month' });
    const h = ctx._homeChannelDetailHtml(s);
    const rows = [...h.matchAll(/<tr class="(home-dt-[a-z]+)"><td>(?:<span[^>]*><\/span>)?([^<]+)<\/td><td class="num-col"[^>]*>([^<]+)<\/td><td class="num-col"[^>]*>([^<]+)</g)].map(m => [m[1].slice(8), m[2], m[3], m[4]]);
    check('줄 순서 = 채널군 → 채널대분류 → 채널(활성 + 값 있는 비활성 트레이더스), 금액 = IN 목표 / 실적(₩, 짧게)', J(rows) === J([
      ['grp', '오프라인', '₩6,350만', '₩5,460만'], ['cat', '양판점', '₩5,950만', '₩5,160만'], ['ch', '하이마트', '₩4,000만', '₩3,600만'], ['ch', '전자랜드', '₩1,950만', '₩1,560만'],
      ['cat', '할인점', '—', '—'], ['ch', '이마트', '—', '—'], ['ch', '트레이더스', '—', '—'], ['cat', '백화점', '₩400만', '₩300만'], ['ch', '신세계백화점', '₩400만', '₩300만'],
      ['grp', '특수(폐쇄몰·렌탈·특판)', '₩150만', '₩75만'], ['cat', '폐쇄몰', '₩150만', '₩75만'], ['ch', '디에이블앤', '₩150만', '₩75만']]), rows);
    check('채널군 줄 = 위 카드(채널군 9월 목표·실적)', s.series.offline['2026-09'].actual === 54600000 && s.series.closed['2026-09'].actual === 750000);
    check('펼침(details) — 기본은 접힘', /^<details class="home-tbl home-dt"><summary>채널 대분류별 실적/.test(h));
  }

  console.log('\n통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('  FAIL  예외: ' + (e && e.stack || e)); console.log('\n통과 ' + pass + ' / 실패 ' + (fail + 1)); process.exit(1); });
