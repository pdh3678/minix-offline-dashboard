/* 본품 외 대분류(필터·기타) — 새 SKU 만들기, 본품 합계 분리, 화면 배치. index.html이 싣는 프론트 실코드 + GAS 실코드(목 시트).

   지키려는 성질:
     · 새 SKU 만들기: 필터(모델 하드락필터·하드필터, 표준명 "필터 {모델}") · 기타(모델 기타 자동, 옵션 필수 + 안내, 표준명 "기타 {옵션}")
       GAS도 옵션 없는 기타 SKU를 거절한다(제품마스터 수정 경로 포함)
     · 미매칭 코드 4개(필터 2 · 기타 2)를 필터·기타 SKU로 매핑해도 본품 수치는 그대로다 —
       GAS 채널 단위 재고 지표(정상재고·일평균·재고일수·진열·취급 점포·점포 결품)와 월별 채널·월 합계(목표·실적·금액),
       화면(채널 현황 KPI·카드, 채널 상세 채널 합계, 재고 현황 합계, 목표 관리 채널·전체 합계)
     · 필터는 대분류 합계·경보에 들어가고 카드·채널 상세에 "필터 판매 n개 · 필터 재고 n개"로 따로 보인다(0이면 숨김)
     · 기타는 경보(과다·결품 위험·점포 결품)에 나타나지 않는다
     · 필터·기타는 본품 뒤 구분선 아래(채널 상세 SKU 표·재고 현황 매트릭스), 대분류 필터로 그것만 볼 수 있다
     · 목표 관리: 필터·기타 행은 기본 숨김, "비본품 표시"로 채널 합계 아래에 — 채널·전체 합계는 켜도 본품 합계

   실행: node tests/offline-extra.test.js  (또는 node tests/run-all.js) */
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
const SHIM = 'get MP(){return _MP;}, get OF(){return OFFLINE_FILTER;}, get OCS(){return _OCS;}, get OCD(){return _OCD;}, get OIV(){return _OIV;}, get TG(){return _TG;}, get TGA(){return _TGA;}';
const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

// 프론트(매핑 패널) — 서버 호출은 GAS 실코드(목 시트)로 직결
function front(g) {
  const { ctx, X } = loadFrontend(PROJ, SHIM);
  const box = {};
  const el = id => (box[id] = box[id] || { id, innerHTML: '', value: '', textContent: '', dataset: {}, style: {}, getContext: () => ({}), scrollIntoView() {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } } });
  ctx.document.getElementById = el;
  const calls = [], toasts = [];
  ctx._getToken = () => 'T';
  ctx._gasFetch = async (url, opts) => { const b = JSON.parse(opts.body); calls.push({ action: b.action, data: b.data }); return g.call(b.action, b.data, 'admin'); };
  ctx.showToast = (msg, o) => toasts.push({ msg, type: o && o.type });
  ctx.Chart = function () { return { destroy() {} }; };
  ctx.sessionStorage.setItem('gp_user', J({ email: FX.ADMIN, name: '관리자' }));
  X.OF.ym = '2026-09';
  return { ctx, X, el, calls, toasts, page: id => el('page-' + id).innerHTML };
}

(async function main() {
  console.log('\n[1] 새 SKU 만들기 — 필터·기타');
  {
    const g = FX.env();
    const { ctx, X, el, calls, toasts } = front(g);
    await ctx._offlineLoadMasters(true);
    const host = 'mpTest';
    ctx.renderMappingPanel(host, [{ channelId: 'himart', code: 'MNFD-RF3', name: '미닉스 더플렌더 프로 전용 필터' }], {});
    const html = () => el(host).innerHTML;
    // 목 DOM은 다시 그려도 입력칸 값이 남는다 — 브라우저처럼 다시 그린 입력칸 값을 상태(ns)에서 채운다
    const sync = () => { const ns = X.MP[host].ns; ['Line', 'Model', 'Option', 'Name'].forEach(k => { el('mpNs' + k + '-' + host).value = ns[k.toLowerCase()]; }); };
    const open = i => { ctx._mpOpenNewSku(host, i); sync(); };
    const pick = line => { el('mpNsLine-' + host).value = line; ctx._mpNsInput(host, true); sync(); };
    open(0);
    const datalist = () => { const h = html(); const dl = h.slice(h.indexOf('<datalist'), h.indexOf('</datalist>')); return (dl.match(/<option value="([^"]+)">/g) || []).map(s => s.slice(15, -2)); };
    check('품목군 선택지에 필터·기타(본품 뒤, 필터 → 기타)', /<option value="미니식기세척기"[^]*<option value="필터">필터<\/option><option value="기타">기타<\/option><\/select>/.test(html()));

    pick('필터');
    check('필터 → 모델 목록 하드락필터·하드필터', J(datalist()) === J(['하드락필터', '하드필터']), datalist());
    check('필터는 옵션 필수 아님(안내 없음)', html().indexOf('(필수)') < 0);
    el('mpNsModel-' + host).value = '하드락필터'; ctx._mpNsInput(host);
    check('표준명 자동 = "필터 하드락필터"', el('mpNsName-' + host).value === '필터 하드락필터', el('mpNsName-' + host).value);
    await ctx._mpCreateSku(host);
    await settle();
    const s1 = calls.filter(c => c.action === 'offline_saveSku').pop();
    check('필터 SKU 저장 요청', s1 && J(s1.data.sku) === J({ name: '필터 하드락필터', line: '필터', model: '하드락필터', option: '', active: 'Y' }), s1 && s1.data);
    const made = (X.MP[host].sel['himart\u0001MNFD-RF3'] || {}).skuId;
    check('만든 SKU가 그 코드 줄에 골라지고, SKU 드롭다운에 "필터" 묶음으로 나온다',
      made && /<optgroup label="필터"><option value="SKU-0004" selected>필터 하드락필터 · SKU-0004<\/option><\/optgroup>/.test(html()), made);

    open(0);
    pick('기타');
    check('기타 → 모델 "기타" 자동', el('mpNsModel-' + host).value === '기타' && X.MP[host].ns.model === '기타', X.MP[host].ns);
    check('기타 → 옵션 (필수) + 안내 "품명 입력 (예: 3kg 건조기 전시대)"',
      html().indexOf('옵션 <span class="off-miss">(필수)</span>') >= 0 && html().indexOf('placeholder="품명 입력 (예: 3kg 건조기 전시대)"') >= 0);
    const n0 = calls.length;
    await ctx._mpCreateSku(host);
    check('옵션이 비면 만들지 않는다(요청 없음, 안내)', calls.length === n0 && /옵션에 품명을 입력하세요/.test((toasts.pop() || {}).msg || ''));
    el('mpNsOption-' + host).value = '3kg 건조기 전시대'; ctx._mpNsInput(host);
    check('표준명 자동 = "기타 3kg 건조기 전시대"', el('mpNsName-' + host).value === '기타 3kg 건조기 전시대', el('mpNsName-' + host).value);
    await ctx._mpCreateSku(host);
    await settle();
    const s2 = calls.filter(c => c.action === 'offline_saveSku').pop();
    check('기타 SKU 저장 요청(모델 기타·옵션 = 품명)', s2 && J(s2.data.sku) === J({ name: '기타 3kg 건조기 전시대', line: '기타', model: '기타', option: '3kg 건조기 전시대', active: 'Y' }), s2 && s2.data);

    open(-1);
    pick('기타'); pick('더플렌더');
    check('기타 → 다른 품목군으로 옮기면 자동으로 채운 모델을 비운다', X.MP[host].ns.model === '' && el('mpNsName-' + host).value === '더 플렌더', X.MP[host].ns);

    console.log('\n[2] GAS — 필터·기타 SKU 저장, 옵션 없는 기타 거절');
    const skus = g.call('offline_getMasters').skus;
    check('제품마스터에 필터·기타 SKU가 저장됨', J(skus.filter(s => s.line === '필터' || s.line === '기타').map(s => [s.skuId, s.name, s.line, s.model, s.option])) ===
      J([['SKU-0004', '필터 하드락필터', '필터', '하드락필터', ''], ['SKU-0005', '기타 3kg 건조기 전시대', '기타', '기타', '3kg 건조기 전시대']]), skus);
    const bad = g.call('offline_saveSku', { sku: { name: '기타', line: '기타', model: '기타', option: '' } }, 'admin');
    check('옵션 없는 기타 SKU → 오류', /기타 품목군은 옵션에 품명을 입력해야 합니다/.test(bad.error || ''), bad);
    const edit = g.call('offline_saveSku', { sku: { skuId: 'SKU-0005', name: '기타 3kg 건조기 전시대', line: '기타', option: '' } }, 'admin');
    check('제품마스터 수정으로 기타 옵션을 비워도 거절(시트 그대로)', /옵션에 품명/.test(edit.error || '') &&
      g.call('offline_getMasters').skus.find(s => s.skuId === 'SKU-0005').option === '3kg 건조기 전시대', edit);
    const off = g.call('offline_saveSku', { sku: { skuId: 'SKU-0005', name: '기타 3kg 건조기 전시대', line: '기타', active: 'N' } }, 'admin');
    check('옵션을 보내지 않는 비활성화는 된다(옵션 유지)', off.success && off.sku.active === 'N' && off.sku.option === '3kg 건조기 전시대', off);
  }


  // ── 미매칭 4건(하이마트 실파일에 있는 코드와 같은 모양): 필터 2 · 전시대 · 타 브랜드 리퍼 ──
  // 숨은 함정: 전시대가 있는 S4는 원래 미매칭(COFFEE)뿐이라 취급·진열 점포가 아니고, S3의 전시대는 팔렸는데 재고 0(기타 결품 후보)
  // 한 프로세스에 목 GAS를 두 벌 띄우면 세션이 섞이므로 한 벌로: 매핑 전 GAS·화면 값을 받아 두고 → 매핑 → 다시 받아 비교
  const g = FX.env();
  const T = g.ctx.OFF_TABS;
  const append = (key, rows) => { const sh = g.tab(T[key].name); g.ctx._offWriteBlock(sh, T[key], sh.getLastRow() + 1, rows); };
  append('stockDaily', [['2026-09-24', 'himart', 'MNFD-RF3', 158, '', '', 'U'], ['2026-09-24', 'himart', 'MNFD-RF5', 367, '', '', 'U'],
    ['2026-09-24', 'himart', '(J)MNMD-FN', 243, '', '', 'U'], ['2026-09-24', 'himart', 'MW74017_264837', 1, '', '', 'U']]);
  const SS = (store, code, q, ms) => ['2026-09-24', 'himart', store, code, q, '', '', '', ms, 'U'];
  append('stockStore', [SS('S1', 'MNFD-RF5', 3, 5), SS('S2', 'MNFD-RF5', 0, 2), SS('S1', 'MNFD-RF3', 158, 0),
    SS('S3', '(J)MNMD-FN', 0, 1), SS('S4', '(J)MNMD-FN', 243, 0), SS('S5', 'MW74017_264837', 1, 0)]);
  append('sales', [['2026-09-10', '2026-09-10', 'day', 'himart', 'S1', 'MNFD-RF5', 45, '', 'upload', 'U'], ['2026-09-12', '2026-09-12', 'day', 'himart', 'S3', '(J)MNMD-FN', 1, '', 'upload', 'U']]);
  append('unmatched', [['himart', 'MNFD-RF3', '미닉스 더플렌더 프로 전용 필터', '2026-09-24', '2026-09-24', 1], ['himart', 'MNFD-RF5', '미닉스 더플렌더 맥스 전용 필터', '2026-09-24', '2026-09-24', 1],
    ['himart', '(J)MNMD-FN', '(진열,판매X)미닉스 3Kg 건조기 전시대', '2026-09-24', '2026-09-24', 1], ['himart', 'MW74017_264837', '[리퍼 A급] 커피머신', '2026-09-24', '2026-09-24', 1]]);
  // 목표 — 본품(더 플렌더 MAX) + 필터 하드필터 IN(목표 관리 비본품 행 · 본품 합계에 안 들어가야 함)
  g.call('offline_saveTargets', { items: [
    { ym: '2026-09', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'IN', target: 100, actual: 90 },
    { ym: '2026-09', channelId: 'himart', line: '더플렌더', model: '더 플렌더 MAX', type: 'OUT', target: 60 },
    { ym: '2026-09', channelId: 'himart', line: '필터', model: '하드필터', type: 'IN', target: 40, actual: 30 }] }, 'admin');
  const newSku = sku => g.call('offline_saveSku', { sku }, 'admin').sku.skuId;
  const RF3 = newSku({ name: '필터 하드락필터', line: '필터', model: '하드락필터' }), RF5 = newSku({ name: '필터 하드필터', line: '필터', model: '하드필터' });
  const FN = newSku({ name: '기타 3kg 건조기 전시대', line: '기타', model: '기타', option: '3kg 건조기 전시대' }), MW = newSku({ name: '기타 커피머신 리퍼', line: '기타', model: '기타', option: '커피머신 리퍼' });
  const mapItems = [['MNFD-RF3', RF3, '정상'], ['MNFD-RF5', RF5, '정상'], ['(J)MNMD-FN', FN, '전시'], ['MW74017_264837', MW, '리퍼']]
    .map(([code, skuId, stockType]) => ({ op: 'upsert', channelId: 'himart', code, skuId, stockType }));

  const CH_KEYS = ['stock', 'total', 'windowQty', 'dailyAvg', 'days', 'noSales', 'displayStores', 'handlingStores', 'coverage', 'storeOuts', 'alert'];
  const chPick = inv => ['himart', 'etland', '*'].map(ch => { const x = FX.G(inv, ch, 'channel'); const o = {}; CH_KEYS.forEach(k => { o[k] = x[k]; }); return o; });
  const monPick = mon => mon.totals.byChannelMonth.concat(mon.totals.byMonth).map(t => J([t.ym, t.channelId, t['in'], Object.assign({}, t.out, { unmatchedQty: 0 })]));
  const hmUm = mon => mon.totals.byChannelMonth.find(x => x.channelId === 'himart').out.unmatchedQty;
  const umStock = inv => inv.channels.find(c => c.channelId === 'himart').unmatchedStock;
  const skuG = (inv, id) => FX.G(inv, 'himart', 'sku', id);

  // ── 화면 값 뽑기 ──
  const F = front(g), P = id => F.page(id);
  const card = name => { const h = P('offline-channels'), i = h.indexOf('of-card-name">' + name);
    return h.slice(i, [h.indexOf('<div class="of-card" ', i), h.indexOf('<div class="card">', i)].filter(x => x > 0).sort((x, y) => x - y)[0]); };
  const cardBody = name => { const c = card(name); return text(c.slice(c.indexOf('of-meter-row'), c.indexOf('of-card-foot'))); };
  const kpis = () => P('offline-channels').split('<div class="kpi">').slice(1, 6).map(text);
  // 미매칭 수량(unmatchedQty)은 매핑한 만큼 줄어드는 게 맞으므로 비교에서 뺀다 — [3]에서 따로 본다
  const tot = () => J(['', 'himart'].map(ch => { const t = F.ctx._ofTotals(F.X.OCS.mon, ch, null, ''); t.out.unmatchedQty = 0; return t; }));
  const rowText = (h, cls) => { const i = h.indexOf('<tr class="' + cls + '">'); return text(h.slice(i, h.indexOf('</tr>', i))); };
  const alerts = () => { const h = P('offline-inventory'); return text(h.slice(h.indexOf('of-atabs'), h.indexOf('id="oivTrendCtl"'))); };
  const tgT = () => { const t = F.ctx._tgTotals(); return J([t['ch:himart'], t.all]); };
  const aT = () => { const t = F.ctx._tgaTotals(); return J([t['ch:himart'], t.all]); };
  const TGM = '<td class="tg-model">하드필터</td>';
  async function screens() {
    const o = {};
    F.ctx.navPage('offline-channels', null); await settle();
    Object.assign(o, { tot: tot(), kpis: kpis(), himart: cardBody('하이마트'), himartCard: text(card('하이마트')), etlandCard: card('전자랜드'), alerts: F.ctx._ofAlertCounts(F.X.OCS.inv, '') });
    F.ctx._ofGo('offline-channel', 'himart'); await settle();
    Object.assign(o, { chPage: P('offline-channel'), chTotal: rowText(P('offline-channel'), 'of-lv-total') });
    F.ctx.navPage('offline-inventory', null); await settle();
    Object.assign(o, { invTotal: rowText(P('offline-inventory'), 'of-lv-total').replace(/^ ?합계( \([^)]*\))? ?/, '') });
    F.X.TG.ym = '2026-09'; F.X.TG.tab = 'monthly'; F.ctx.navPage('admin-targets', null); await settle();
    Object.assign(o, { tgT: tgT() });
    F.X.TGA.data = null; F.ctx._tgSetTab('annual'); await settle();
    Object.assign(o, { aT: aT() });
    return o;
  }

  console.log('\n[3] GAS — 매핑 전후 본품 수치 불변, 필터·기타는 대분류에만');
  await F.ctx._offlineLoadMasters(true);
  const inv0 = g.call('offline_getInventory', { channelId: 'himart' }), mon0 = g.call('offline_getMonthly', { from: '2026-09', to: '2026-09' });
  check('매핑 전: 4개 코드는 미매칭(재고 769, 최근 판매 46)', umStock(inv0) === 7 + 1 + 769 &&
    inv0.unmatched.filter(u => /RF|MNMD-FN|MW74017/.test(u.code)).reduce((s, u) => s + u.windowQty, 0) === 46, inv0.unmatched);
  const B = await screens(); // 매핑 전 화면
  const sv = await F.ctx._offlineCall('offline_saveMapping', { items: mapItems }); // 화면 쪽 조회 메모도 비워진다
  await F.ctx._offlineLoadMasters(true);
  check('4건 매핑 저장', sv.success && sv.saved === 4, sv);
  const inv1 = g.call('offline_getInventory', { channelId: 'himart' }), mon1 = g.call('offline_getMonthly', { from: '2026-09', to: '2026-09' });
  check('채널 단위(본품) 재고 지표 — 하이마트·전자랜드·전체: 정상·전시·리퍼·일평균·재고일수·진열·취급·커버리지·점포 결품·경보가 매핑 전과 같다',
    J(chPick(inv0)) === J(chPick(inv1)), { before: chPick(inv0), after: chPick(inv1) });
  check('월별 채널·월 합계(본품) — IN·OUT 목표·실적·금액이 매핑 전과 같다(필터 IN 목표 40·실적 30도 안 들어감)', J(monPick(mon0)) === J(monPick(mon1)), { before: monPick(mon0), after: monPick(mon1) });
  check('미매칭 OUT 수량은 매핑한 만큼(46), 미매칭 재고는 769 줄어든다', hmUm(mon0) - hmUm(mon1) === 46 && umStock(inv0) - umStock(inv1) === 769);
  const bc = cat => mon1.totals.byCategory.find(x => x.channelId === 'himart' && x.category === cat);
  check('대분류 합계(byCategory): 필터 OUT 45 · IN 목표 40, 기타 OUT 1', bc('필터').out.actual === 45 && bc('필터')['in'].target === 40 && bc('기타').out.actual === 1);
  const fc = FX.G(inv1, 'himart', 'category', '필터'), ec = FX.G(inv1, 'himart', 'category', '기타');
  check('필터 대분류 그룹: 정상 525 · 최근 판매 45 · 재고일수 326.7 · 점포 결품 1(S2)', fc.stock['정상'] === 525 && fc.windowQty === 45 && FX.near(fc.days, 525 / (45 / 28)) && fc.storeOuts === 1, fc);
  check('필터는 경보 대상: 하드필터 SKU 과다(228.4일) · 판매 없는 하드락필터는 재고일수 없음', skuG(inv1, RF5).alert === 'over' && skuG(inv1, RF3).alert === '' && skuG(inv1, RF3).noSales);
  check('기타는 경보 제외: 정상 0이라 재고일수 0일이어도 결품 위험 아님, S3 전시대(당월판매 1·재고 0)도 점포 결품 아님',
    ec.days === 0 && ec.alert === '' && skuG(inv1, FN).alert === '' && skuG(inv1, MW).alert === '' && ec.storeOuts === 0 &&
    !inv1.storeOuts.some(s => s.skuId === FN || s.skuId === MW) && inv1.storeOuts.some(s => s.skuId === RF5 && s.store === 'S2'), { ec, outs: inv1.storeOuts });
  check('점포 표: S3 전시대 줄은 결품 표시 없음, S2 하드필터 줄은 결품', !inv1.stores.find(r => r.store === 'S3' && r.skuId === FN).out && inv1.stores.find(r => r.store === 'S2' && r.skuId === RF5).out);
  check('기타 전시대는 기타 대분류의 진열 점포(S4)로만 센다', ec.displayStores === 1 && FX.G(inv1, 'himart', 'channel').displayStores === FX.G(inv0, 'himart', 'channel').displayStores);

  const A = await screens(); // 매핑 후 화면(마지막으로 연간 보기 탭에 있다)

  console.log('\n[4] 채널 현황 — 본품 수치 불변, 필터 한 줄, 대분류 필터');
  check('KPI·카드의 목표·실적 합계(전체·하이마트)가 매핑 전과 같다', B.tot === A.tot, { before: B.tot, after: A.tot });
  check('KPI 5칸(IN·OUT 달성률, IN·OUT 금액, 전체 정상재고·재고일수)이 매핑 전과 글자까지 같다', J(B.kpis) === J(A.kpis), { before: B.kpis, after: A.kpis });
  check('하이마트 카드 IN·OUT 달성률·IN−OUT 갭·정상재고·재고일수·진열 점포가 매핑 전과 같다', B.himart === A.himart, { before: B.himart, after: A.himart });
  check('매핑 전 필터 줄 없음 → 매핑 후 하이마트 카드 "필터 판매 45개 · 필터 재고 525개"', !/필터 판매/.test(B.himartCard) && /필터 판매 45개 · 필터 재고 525개/.test(A.himartCard), A.himartCard);
  check('필터가 없는 전자랜드 카드는 필터 줄 숨김(0)', A.etlandCard.indexOf('of-extra') < 0);
  check('경보 수: 필터만 더해진다(과다 +1 하드필터 · 점포 결품 +1 S2), 기타는 0', A.alerts.over - B.alerts.over === 1 && A.alerts.risk === B.alerts.risk && A.alerts.storeOut - B.alerts.storeOut === 1, { B: B.alerts, A: A.alerts });
  F.ctx.navPage('offline-channels', null); await settle();
  const mxHead = (() => { const h = P('offline-channels'), m = h.slice(h.indexOf('of-mx'), h.indexOf('</thead>', h.indexOf('of-mx'))); return (m.match(/<th>([^<]+)<\/th>/g) || []).map(x => x.slice(4, -5)); })();
  check('채널 × 대분류 매트릭스 열 = 본품 5개 + 합계(필터·기타 열 없음)', J(mxHead) === J(['채널', '음식물처리기', '김치냉장고', '청소기', '건조기', '식세기', '합계']), mxHead);
  const opts = (() => { const h = P('offline-channels'), s0 = h.indexOf("_ofSetFilter('category'"); return (h.slice(s0, h.indexOf('</select>', s0)).match(/<option value="([^"]*)"/g) || []).map(x => x.slice(15, -1)); })();
  check('대분류 필터 목록: 전체 → 본품 5개 → 필터 → 기타', J(opts) === J(['', '음식물처리기', '김치냉장고', '청소기', '건조기', '식세기', '필터', '기타']), opts);
  F.ctx._ofSetFilter('category', '필터'); await settle();
  const t1 = text(P('offline-channels'));
  check('대분류 필터 = 필터: KPI 정상재고 525 · 필터 줄은 숨김(위 숫자가 이미 필터)', /전체 정상재고 · 필터 525 대/.test(t1) && P('offline-channels').indexOf('of-extra') < 0, t1.slice(0, 700));
  F.ctx._ofSetFilter('category', '');

  console.log('\n[5] 채널 상세 — 필터 한 줄, 채널 합계(본품) 아래 구분선 뒤 필터·기타');
  const h1 = A.chPage;
  check('필터 한 줄 "필터 판매 45개 · 필터 재고 525개"(매핑 전에는 없음)', /필터 판매 45개 · 필터 재고 525개/.test(text(h1)) && B.chPage.indexOf('of-extra') < 0);
  check('채널 합계 (본품) 줄 숫자가 매핑 전과 같다', A.chTotal === B.chTotal && /채널 합계 \(본품\)/.test(A.chTotal), { before: B.chTotal, after: A.chTotal });
  const iTot = h1.indexOf('of-lv-total'), iSep = h1.indexOf('of-lv-sep'), iF = h1.indexOf('</button>필터</td>'), iE = h1.indexOf('</button>기타</td>');
  check('순서: 본품 대분류 → 채널 합계 → 구분선 → 필터 → 기타', iTot > h1.indexOf('</button>음식물처리기</td>') && iSep > iTot && iF > iSep && iE > iF, { iTot, iSep, iF, iE });
  F.ctx._ofGo('offline-channel', 'himart'); await settle();
  F.ctx._ocdToggleSku('himart|기타|기타'); F.ctx._ocdToggleSku('himart|필터|하드필터');
  const row = id => { const h = P('offline-channel'), i = h.indexOf('id="ocdSku-' + id + '"'); return i < 0 ? null : h.slice(i, h.indexOf('</tr>', i)); };
  check('기타 SKU 줄(전시대·리퍼)은 경보 배지 없음, 필터 하드필터 SKU 줄은 과다', row(FN) != null && row(MW) != null && row(FN).indexOf('of-badge') < 0 && row(MW).indexOf('of-badge') < 0 && row(RF5).indexOf('of-b-over') >= 0);
  F.ctx._ofSetFilter('category', '기타'); await settle();
  const hE = P('offline-channel');
  check('대분류 필터 = 기타: 기타만, 구분선 없음, "기타 합계"', hE.indexOf('</button>기타</td>') >= 0 && hE.indexOf('</button>음식물처리기</td>') < 0 && hE.indexOf('of-lv-sep') < 0 && /기타 합계/.test(text(hE)));
  F.ctx._ofSetFilter('category', '');

  console.log('\n[6] 재고 현황 — 합계(본품) 불변, 구분선 뒤 필터·기타, 경보에 기타 없음');
  F.ctx.navPage('offline-inventory', null); await settle();
  const i1 = P('offline-inventory');
  check('[정상] 합계 줄 숫자가 매핑 전과 같다', A.invTotal === B.invTotal, { before: B.invTotal, after: A.invTotal });
  check('합계 라벨 "합계 (본품)" → 구분선 → 필터(하드락필터·하드필터) → 기타', /합계 \(본품\)/.test(text(i1)) && i1.indexOf('of-lv-sep') > i1.indexOf('of-lv-total') &&
    i1.indexOf('필터 하드락필터') > i1.indexOf('of-lv-sep') && i1.indexOf('기타 3kg 건조기 전시대') > i1.indexOf('필터 하드필터'));
  check('경보 [과다]에 필터 하드필터는 있고 기타는 없다', /필터 하드필터/.test(alerts()) && !/기타 3kg|기타 커피머신/.test(alerts()), alerts().slice(0, 400));
  F.ctx._oivSetTab('risk');
  check('경보 [결품 위험]에 기타 없음(기타 재고일수 0일)', !/기타 3kg|기타 커피머신/.test(alerts()));
  F.ctx._oivSetTab('storeOut');
  check('경보 [점포 결품]: S2 필터 하드필터 있음, S3 전시대 없음', /S2점 S2 강남 필터 하드필터/.test(alerts()) && !/기타 3kg/.test(alerts()), alerts().slice(0, 400));
  F.ctx._oivSetTab('over');
  F.ctx._ofSetFilter('category', '필터'); await settle();
  const iF1 = P('offline-inventory');
  check('대분류 필터 = 필터: 필터 SKU만, 구분선 없음', iF1.indexOf('필터 하드필터') >= 0 && iF1.indexOf('더 플렌더 MAX') < 0 && iF1.indexOf('of-lv-sep') < 0 && iF1.indexOf('기타 3kg') < 0);
  F.ctx._ofSetFilter('category', '');

  console.log('\n[7] 목표 관리 — 필터·기타 행 기본 숨김, "비본품 표시", 채널·전체 합계는 본품');
  check('월별 입력: 하이마트·전체 합계가 매핑 전과 같다(필터 IN 목표 40 · OUT 45 안 들어감)', B.tgT === A.tgT, { before: B.tgT, after: A.tgT });
  check('연간 보기: 하이마트·전체 합계가 매핑 전과 같다', B.aT === A.aT, { before: B.aT, after: A.aT });
  F.X.TG.tab = 'monthly'; F.ctx.navPage('admin-targets', null); await settle();
  let p1 = P('admin-targets');
  check('월별 입력: 필터·기타 행 기본 숨김 + "비본품 표시" 토글', p1.indexOf(TGM) < 0 && p1.indexOf('tg-sep') < 0 && /비본품 표시/.test(text(p1)) && !F.X.TG.nonMain);
  F.ctx._tgSetNonMain(true);
  p1 = P('admin-targets');
  const iCh = p1.indexOf('하이마트 합계'), iS = p1.indexOf('tg-sep'), iHF = p1.indexOf(TGM);
  check('비본품 표시: 하이마트 합계 → 구분선 → 필터(하드락필터·하드필터) → 기타', iCh > 0 && iS > iCh && iHF > iS && p1.indexOf('<td class="tg-model">기타</td>') > iHF, { iCh, iS, iHF });
  const cf = F.ctx._tgTotals()['cat:himart|필터'];
  check('비본품 표시를 켜도 채널·전체 합계는 그대로, 필터 대분류 합계는 IN 목표 40 · OUT 실적 45', tgT() === A.tgT && cf.inT === 40 && cf.outA === 45, cf);
  F.ctx._tgSetNonMain(false);
  F.ctx._tgSetTab('annual'); await settle();
  check('연간 보기: 필터·기타 행 기본 숨김', P('admin-targets').indexOf(TGM) < 0 && P('admin-targets').indexOf('tg-sep') < 0);
  F.ctx._tgSetNonMain(true);
  const pa = P('admin-targets');
  check('연간 보기 "비본품 표시"(월별 입력과 공유): 구분선 뒤 필터 행 + 필터 합계 9월 IN 목표 40, 채널 합계 그대로',
    pa.indexOf('tg-sep') > pa.indexOf('하이마트 합계') && pa.indexOf(TGM) > pa.indexOf('tg-sep') && F.ctx._tgaTotals()['cat:himart|필터']['2026-09'].t === 40 && aT() === A.aT);

  console.log('\n통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
