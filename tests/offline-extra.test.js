/* 본품 외 대분류(필터·기타) — 새 SKU 만들기, 본품 합계 분리, 화면 배치. index.html이 싣는 프론트 실코드 + GAS 실코드(목 시트).

   지키려는 성질:
     · 새 SKU 만들기: 필터(모델 하드락필터·하드필터, 표준명 "필터 {모델}") · 기타(모델 기타 자동, 옵션 필수 + 안내, 표준명 "기타 {옵션}")
       GAS도 옵션 없는 기타 SKU를 거절한다(제품마스터 수정 경로 포함)

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
const SHIM = 'get MP(){return _MP;}';

// 프론트(매핑 패널) — 서버 호출은 GAS 실코드(목 시트)로 직결
function front(g) {
  const { ctx, X } = loadFrontend(PROJ, SHIM);
  const box = {};
  const el = id => (box[id] = box[id] || { id, innerHTML: '', value: '', textContent: '', dataset: {}, style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } } });
  ctx.document.getElementById = el;
  const calls = [], toasts = [];
  ctx._getToken = () => 'T';
  ctx._gasFetch = async (url, opts) => { const b = JSON.parse(opts.body); calls.push({ action: b.action, data: b.data }); return g.call(b.action, b.data, 'admin'); };
  ctx.showToast = (msg, o) => toasts.push({ msg, type: o && o.type });
  return { ctx, X, el, calls, toasts };
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

  console.log('\n통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
