/**
 * 미닉스 파트 홈 — 공구 목표(공구목표_월) · 공구 목표 이관 · 파트 통합 집계(home_getSummary)
 * apps-script.js · apps-script-offline.js · apps-script-offline-targets.js · apps-script-offline-inventory.js 와
 * **같은 Apps Script 프로젝트의 다섯 번째 파일**이다(전역 공유).
 *
 * ★ 배포: Apps Script 편집기 → 파일 ＋ → 스크립트 → 이름 "home" → 이 파일 전체를 붙여넣기.
 *   탭 정의(OFF_TABS.gonguTargets)는 apps-script-offline.js 에 있다 — 붙여넣은 뒤 offline_setupSheets 를 한 번 실행해
 *   '공구목표_월' 탭을 만든다. 시트 입출력·락·캐시·이관로그는 apps-script-offline*.js 의 것을 그대로 쓴다.
 *
 * 금액 기준(파트 홈 모든 섹션 공통 — 원, VAT 포함, 수수료 차감 전)
 *   파트 매출 = 오프라인 IN 실적 × 공급가(월별 해석 _offMonthlyCompute 의 in.actualAmount) + 공구 판매수량 × 공구가(실적통합 '총매출')
 *   파트 목표 = 오프라인 IN 목표 금액(목표 관리) + 공구 목표 금액(공구목표_월)
 *   본품만 — 본품합계포함 N 대분류(필터·기타)는 합계에서 빠지고, 필터 IN 금액은 filter 로 따로 준다
 *   원본의 '26년 목표 합' 탭은 쓰지 않는다(공구 계획 + 오프라인 목표 합과 맞지 않는 별도 계획)
 *
 * 공구 실적(판매·매출)·공구 일정·실적 미기입 건수는 여기서 계산하지 않는다. 공구 분석의 집계(시작일 월 귀속, 완료+진행중,
 * KST 날짜 판정)는 브라우저(DATA · _isRevStatus)에만 있어서, 같은 조건에서 같은 숫자를 보장하려면 브라우저가 그 함수로
 * 계산해 더해야 한다(src/features/home/home.js). 여기는 오프라인 금액 · 공구 목표 · 오프라인 쪽 "오늘 챙길 것"만 맡는다.
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 채널군 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/* 채널마스터 '유형' → 채널군. 공동구매는 채널마스터 채널이 아니라 공구 데이터(실적통합)라 types가 비어 있다.
   목록에 없는 유형은 '' — 파트 홈은 그 채널을 오프라인으로 더하고 경고를 남긴다(합계에서 조용히 빠지지 않게).
   key 'closed'는 그대로 두고 표시명만 넓혔다(2026-09-30 렌탈 추가) — 화면·캐시가 이 key를 쓴다. */
var OFF_CHANNEL_GROUPS = [
  { key: 'offline', label: '오프라인', types: ['전문점', '할인점', '창고형', '백화점'] },
  { key: 'closed', label: '특수(폐쇄몰·특판·렌탈)', types: ['폐쇄몰', '특판', '렌탈'] },
  { key: 'gongu', label: '공동구매', types: [] }
];
function _offChannelGroup(type) {
  var t = String(type == null ? '' : type).trim();
  for (var i = 0; i < OFF_CHANNEL_GROUPS.length; i++) if (OFF_CHANNEL_GROUPS[i].types.indexOf(t) >= 0) return OFF_CHANNEL_GROUPS[i].key;
  return '';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 공구 목표 (공구목표_월) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 행 = [연월, 벤더, 대분류, 품목군, 모델, 목표수량, 목표금액, 출처, 수정일, 수정자] · 키 (연월, 벤더, 품목군, 모델)

var GT_VENDOR_MAX = 40;
function _gtCat(r) { return r[2] || OFFLINE_LINE_CATEGORY[r[3]] || ''; }
function _gtKey(ym, vendor, line, model) { return [ym, vendor, line, model].join(OFF_KEY_SEP); }
function _gtRowKey(r) { return _gtKey(r[0], r[1], r[3], _offCanonModel(r[3], r[4]).model); }
function _gtNum(v) { return v === '' || v == null ? null : Number(v); }
function _gtObj(r) {
  return { ym: r[0], vendor: r[1], category: _gtCat(r), line: r[3], model: _offCanonModel(r[3], r[4]).model,
    qty: _gtNum(r[5]), amount: _gtNum(r[6]), source: r[7], updatedAt: r[8], updatedBy: r[9] };
}
function _gtVendor(v, what) {
  var s = String(v == null ? '' : v).trim();
  if (!s) throw new Error(what + ' 벤더가 비었습니다.');
  if (s.length > GT_VENDOR_MAX) throw new Error(what + ' 벤더 이름이 너무 깁니다(' + GT_VENDOR_MAX + '자까지): ' + s);
  return s;
}

/* offline_getGonguTargets — data.year 의 행. vendors = 탭 전체(모든 해)의 벤더(처음 나온 순) — 새 해에도 벤더 줄이 그대로 보이게 */
function _gtGet(data) {
  var y = String(data.year || '');
  if (!/^\d{4}$/.test(y)) throw new Error('연도가 올바르지 않습니다: ' + data.year);
  var rows = _offReadRows(_offSheet(_offSS(), 'gonguTargets'), OFF_TABS.gonguTargets).filter(function (r) { return r[0] && r[1] && r[3]; });
  var vendors = [];
  rows.forEach(function (r) { if (vendors.indexOf(r[1]) < 0) vendors.push(r[1]); });
  return { success: true, year: y, vendors: vendors,
    items: rows.filter(function (r) { return String(r[0]).slice(0, 4) === y; }).map(_gtObj) };
}

/* offline_saveGonguTargets — upsert. items: [{ ym, vendor, line, model, qty, amount }] — '' = 값 지우기, 키가 없으면(undefined) 그 칸은 그대로.
   저장한 행은 출처 input — 이관(migration)이 덮어쓰지 않는다. 검증을 먼저 끝내고 한 건이라도 틀리면 아무것도 쓰지 않는다. */
function _gtSave(data, auth) {
  var items = data.items || [];
  if (!items.length) throw new Error('저장할 공구 목표가 없습니다.');
  var clean = items.map(function (it, i) {
    var what = (i + 1) + '번째 공구 목표';
    if (!_offIsYm(it.ym)) throw new Error(what + ' 연월이 올바르지 않습니다: ' + it.ym);
    var vendor = _gtVendor(it.vendor, what);
    var model = _offCatalogModel(it.line, it.model, what);
    return { ym: it.ym, vendor: vendor, line: it.line, model: model,
      qty: it.qty === undefined ? undefined : _offQty(it.qty, what + ' 목표수량'),
      amount: it.amount === undefined ? undefined : _offQty(it.amount, what + ' 목표금액') };
  });
  return _offWithLock(function () {
    var ss = _offSS(), def = OFF_TABS.gonguTargets, sheet = _offSheet(ss, 'gonguTargets');
    var rows = _offReadRows(sheet, def), prev = rows.length, idx = {};
    rows.forEach(function (r) { idx[_gtRowKey(r)] = r; });
    var today = _offToday(), email = (auth && auth.email) || '';
    clean.forEach(function (it) {
      var k = _gtKey(it.ym, it.vendor, it.line, it.model), row = idx[k];
      if (!row) { row = [it.ym, it.vendor, '', it.line, it.model, '', '', '', '', '']; rows.push(row); idx[k] = row; }
      if (it.qty !== undefined) row[5] = it.qty;
      if (it.amount !== undefined) row[6] = it.amount;
      row[2] = OFFLINE_LINE_CATEGORY[it.line] || ''; row[7] = 'input'; row[8] = today; row[9] = email;
    });
    _offWriteAll(sheet, def, rows, prev);
    _offInvalidateCache();
    return { success: true, saved: clean.length };
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 공구 목표 이관 — 기존 '공동구매 26년 목표' 탭(읽기만 한다) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

var LEGACY_GONGU_TAB = '공동구매 26년 목표';
var GT_SUBTOTAL = { '소계': true };
var GT_CHANNEL_TOTAL = { '채널합계': true, '합계': true, '총계': true, '총합계': true };

/* 월 머리글 칸 → 'YYYY-MM' | '' — 날짜 칸(Date), 엑셀 날짜 일련번호, '2026-01'·'2026. 1'·'26년 1월', '1월'(연도는 yearHint) */
function _gtMonthOf(x, yearHint) {
  if (x instanceof Date && !isNaN(x.getTime())) return _offStr(x).slice(0, 7);
  if (typeof x === 'number' && x > 20000 && x < 80000) {
    var d = new Date(Math.round((x - 25569) * 86400000));
    return d.getUTCFullYear() + '-' + _pad(d.getUTCMonth() + 1);
  }
  var s = String(x == null ? '' : x).trim(), m;
  if ((m = /^(\d{2}|\d{4})\s*(?:년|[.\-\/])\s*(\d{1,2})\s*월?\.?$/.exec(s)) && +m[2] >= 1 && +m[2] <= 12) return (m[1].length === 2 ? '20' + m[1] : m[1]) + '-' + _pad(+m[2]);
  if ((m = /^(\d{1,2})\s*월$/.exec(s)) && yearHint && +m[1] >= 1 && +m[1] <= 12) return yearHint + '-' + _pad(+m[1]);
  return '';
}

/* 제목(titleRe)이 있는 행부터 6행 안에서 머리글 두 줄을 찾는다 — 윗줄 '구분'(+ 월), 아랫줄 '채널'·'상품명'·'수량'·'매출'.
   행 번호가 아니라 글자로 찾으므로 원본에 행이 끼어들어도 된다. 반환 { titleRow, head, sub } (0-based) | null */
function _gtFindBlock(v, titleRe) {
  for (var r = 0; r < v.length; r++) {
    var hit = false;
    for (var c = 0; c < v[r].length && !hit; c++) if (titleRe.test(String(v[r][c] == null ? '' : v[r][c]))) hit = true;
    if (!hit) continue;
    for (var h = r; h < Math.min(v.length - 1, r + 6); h++) {
      var up = v[h].map(_offNorm), dn = v[h + 1].map(_offNorm);
      if (up.indexOf('구분') >= 0 && dn.indexOf('채널') >= 0 && dn.indexOf('상품명') >= 0 && dn.indexOf('수량') >= 0 && dn.indexOf('매출') >= 0) {
        return { titleRow: r, head: h, sub: h + 1 };
      }
    }
  }
  return null;
}

/* 블록 하나 — 월 열(수량·매출)과 행을 읽는다.
   행 종류: 벤더 상품 행(채널 = 벤더) / 소계(그 위 벤더의 합계) / 채널 합계 상품 행 / 채널 합계 뒤 소계(= 전체 합계, 블록 끝).
   병합 셀은 _offLegacyGrid가 채워 두지만, 채워지지 않은 벤더 칸(빈칸)은 위 벤더를 이어 쓴다.
   반환 { months[{ym, qtyCol, amtCol}], rows[{rowNo, vendor, product, unitPrice, values{ym:{qty, amt}}, total}],
          vendorOrder[], vendorTotals{벤더: {rowNo, values, total}}, channelTotalRows[], grand|null } */
function _gtParseBlock(v, blk, yearHint, bad) {
  var head = v[blk.head], sub = v[blk.sub].map(_offNorm);
  var col = { ch: sub.indexOf('채널'), prod: sub.indexOf('상품명'), unit: sub.indexOf('매출금액') };
  // 월 블록 시작 — 병합을 채우면 같은 월 머리글이 두 칸(수량·매출)에 반복되므로 값이 바뀌는 칸만 시작
  var starts = [], prevKey = null;
  head.forEach(function (x, c) {
    var n = _offNorm(x), key = _gtMonthOf(x, yearHint) || (n === '총합계' || n === '합계' ? 'TOTAL' : '');
    if (key && key !== prevKey) starts.push({ key: key, c: c });
    prevKey = key || null;
  });
  var months = [], total = null;
  starts.forEach(function (s, k) {
    var end = k + 1 < starts.length ? starts[k + 1].c : head.length, q = -1, a = -1;
    for (var c = s.c; c < end; c++) { if (q < 0 && sub[c] === '수량') q = c; else if (a < 0 && sub[c] === '매출') a = c; }
    if (q < 0 && a < 0) return;
    if (s.key === 'TOTAL') { if (!total) total = { qtyCol: q, amtCol: a }; }
    else if (!months.some(function (m) { return m.ym === s.key; })) months.push({ ym: s.key, qtyCol: q, amtCol: a });
  });
  var text = function (i, c) { return c < 0 ? '' : String(v[i][c] == null ? '' : v[i][c]).trim(); };
  var num = function (i, c) { return c < 0 ? null : _offLegacyNum(v[i][c], bad); };
  var vals = function (i) { var o = {}; months.forEach(function (m) { o[m.ym] = { qty: num(i, m.qtyCol), amt: num(i, m.amtCol) }; }); return o; };
  var tot = function (i) { return total ? { qty: num(i, total.qtyCol), amt: num(i, total.amtCol) } : null; };
  var rows = [], vendorOrder = [], vendorTotals = {}, chRows = [], grand = null, carry = '', group = '', inTotal = false;
  for (var i = blk.sub + 1; i < v.length; i++) {
    var first = text(i, 0);
    if (/^\d+\.\s*/.test(first) || /^ㄴ/.test(first) || _offNorm(first) === '구분') break; // 다음 제목·블록
    var ch = text(i, col.ch), prod = text(i, col.prod);
    if (GT_SUBTOTAL[_offNorm(ch)] || (!ch && GT_SUBTOTAL[_offNorm(prod)])) {
      var st = { rowNo: i + 1, values: vals(i), total: tot(i) };
      carry = '';
      if (inTotal) { grand = st; break; } // 채널 합계 뒤 소계 = 전체 합계 — 블록 끝
      if (group && !vendorTotals[group]) vendorTotals[group] = st;
      continue;
    }
    if (!prod) continue;
    if (ch) carry = ch; else ch = carry;
    if (!ch) continue;
    if (GT_CHANNEL_TOTAL[_offNorm(ch)]) { inTotal = true; chRows.push({ rowNo: i + 1, product: prod, values: vals(i), total: tot(i) }); continue; }
    group = ch;
    if (vendorOrder.indexOf(ch) < 0) vendorOrder.push(ch);
    rows.push({ rowNo: i + 1, vendor: ch, product: prod, unitPrice: num(i, col.unit), values: vals(i), total: tot(i) });
  }
  return { months: months, rows: rows, vendorOrder: vendorOrder, vendorTotals: vendorTotals, channelTotalRows: chRows, grand: grand };
}

// 표 어디든 label 정규식에 맞는 칸 → 같은 행 오른쪽의 첫 숫자. 반환 { 첫 그룹(없으면 'v'): 값 } — 같은 키는 처음 것만
function _gtLabeled(v, re) {
  var out = {};
  v.forEach(function (row) {
    row.forEach(function (x, c) {
      var m = re.exec(String(x == null ? '' : x).trim());
      if (!m) return;
      var k = m[1] || 'v';
      if (k in out) return;
      for (var j = c + 1; j < row.length; j++) { var n = _offLegacyNum(row[j], { n: 0 }); if (n != null) { out[k] = n; return; } }
    });
  });
  return out;
}

/* '공동구매 26년 목표' 파싱(순수) — "월별 품목 매출 계획" 블록(이관 대상)과 "월별 품목 마감 매출" 블록(대조 참고용),
   '1분기 목표'~'4분기 목표'·'26년 목표', '1분기 마감'~·'26년 마감' 값 */
function _gtParseLegacy(grid) {
  var v = grid.values, bad = { n: 0 };
  var planBlk = _gtFindBlock(v, /매출\s*계획/);
  if (!planBlk) throw new Error('"' + grid.name + '"에서 월별 품목 매출 계획 블록(제목 + 구분·채널·상품명·수량·매출 머리글)을 찾지 못했습니다.');
  var closeBlk = _gtFindBlock(v, /마감\s*매출/);
  var ym = /(\d{2,4})년/.exec(grid.name);
  var yearHint = ym ? (ym[1].length === 2 ? '20' + ym[1] : ym[1]) : _offToday().slice(0, 4);
  var plan = _gtParseBlock(v, planBlk, yearHint, bad);
  if (!plan.months.length) throw new Error('"' + grid.name + '" 매출 계획 블록에서 월 머리글을 읽지 못했습니다.');
  return {
    plan: plan, close: closeBlk ? _gtParseBlock(v, closeBlk, yearHint, bad) : null,
    quarters: _gtLabeled(v, /^([1-4])\s*분기\s*목표$/), yearTarget: _gtLabeled(v, /^\d{2,4}\s*년\s*목표$/).v,
    closeQuarters: _gtLabeled(v, /^([1-4])\s*분기\s*마감$/), yearClose: _gtLabeled(v, /^\d{2,4}\s*년\s*마감$/).v,
    badCells: bad.n
  };
}

/* 이관 계획 — 벤더별 상품 행만(소계·채널 합계 행은 합계라 넣으면 두 번 센다), 값이 있는 월만(수량·금액이 둘 다 비었거나 0이면 뺀다).
   mapping = { products: { 원문 상품명: { line, model } } } — 없으면 제안값(대소문자·띄어쓰기 무시, 모호하면 빈칸).
   같은 키(연월·벤더·품목군·모델)로 모이는 원문 행은 더한다. 금액은 원본 매출 값 그대로(수량 × 매출금액이 아닌 칸이 있다). */
function _gtPlan(parsed, mapping) {
  var P = parsed.plan, mp = (mapping && mapping.products) || null;
  var names = [], info = {};
  P.rows.forEach(function (r) {
    if (!info[r.product]) { info[r.product] = { legacy: r.product, vendors: [] }; names.push(r.product); }
    if (info[r.product].vendors.indexOf(r.vendor) < 0) info[r.product].vendors.push(r.vendor);
  });
  var products = names.map(function (k) {
    var p = info[k], s = _offSuggestProduct(k, true);
    p.suggest = { line: s.line, model: s.model, ambiguous: !!s.ambiguous };
    var m = mp ? (mp[k] || {}) : s;
    p.line = m.line || ''; p.model = m.model || '';
    if (p.line && OFFLINE_PRODUCT_LINES.indexOf(p.line) < 0) throw new Error('상품명 "' + k + '": 품목군이 올바르지 않습니다: ' + p.line);
    if (p.line && p.model) p.model = _offCatalogModel(p.line, p.model, '상품명 "' + k + '"');
    p.mapped = !!(p.line && p.model);
    p.category = p.mapped ? OFFLINE_LINE_CATEGORY[p.line] : '';
    return p;
  });
  var byName = {};
  products.forEach(function (p) { byName[p.legacy] = p; });
  var agg = {}, order = [], unmapped = [];
  P.rows.forEach(function (r) {
    var p = byName[r.product];
    if (!p.mapped) { var u = r.vendor + ' ' + r.product; if (unmapped.indexOf(u) < 0) unmapped.push(u); return; }
    P.months.forEach(function (mo) {
      var x = r.values[mo.ym];
      if (!x || (!x.qty && !x.amt)) return; // 빈칸·0만 있는 달은 목표가 아니다
      var k = _gtKey(mo.ym, r.vendor, p.line, p.model);
      if (!agg[k]) { agg[k] = { ym: mo.ym, vendor: r.vendor, category: p.category, line: p.line, model: p.model, qty: null, amount: null }; order.push(k); }
      if (x.qty != null) agg[k].qty = (agg[k].qty || 0) + x.qty;
      if (x.amt != null) agg[k].amount = (agg[k].amount || 0) + x.amt;
    });
  });
  return { products: products, rows: order.map(function (k) { return agg[k]; }), unmapped: unmapped };
}

/* 대조(반영 전) — 이관 예정 합계 vs 원본의 채널 합계 행(월·연)·벤더 소계·'26년 목표'·'1~4분기 목표'.
   마감 매출 블록의 월별 합계(채널 합계 뒤 소계)도 같이 준다 — 공구 시트 실적과의 비교는 브라우저가 한다(이관하지 않음). */
function _gtCompare(parsed, planRows) {
  var P = parsed.plan, months = P.months.map(function (m) { return m.ym; });
  var r0 = function (x) { return x == null ? 0 : Math.round(x); };
  var same = function (a, b) { return r0(a) === r0(b); };
  var byYm = {}, byVendor = {}, all = { qty: null, amt: null };
  var add = function (o, r) { if (r.qty != null) o.qty = (o.qty || 0) + r.qty; if (r.amount != null) o.amt = (o.amt || 0) + r.amount; };
  planRows.forEach(function (r) {
    add(byYm[r.ym] = byYm[r.ym] || { qty: null, amt: null }, r);
    add(byVendor[r.vendor] = byVendor[r.vendor] || { qty: null, amt: null }, r);
    add(all, r);
  });
  var g = P.grand;
  var monthRows = months.map(function (ym) {
    var p = byYm[ym] || { qty: null, amt: null }, l = g ? g.values[ym] : null;
    return { ym: ym, planQty: p.qty, planAmt: p.amt, legacyQty: l ? l.qty : null, legacyAmt: l ? l.amt : null,
      ok: !!l && same(p.amt, l.amt) && same(p.qty, l.qty) };
  });
  var gt = g && g.total ? g.total : null;
  var quarters = [1, 2, 3, 4].map(function (q) {
    var amt = null;
    months.forEach(function (ym) { var m = +ym.slice(5, 7); if (m > 3 * (q - 1) && m <= 3 * q && byYm[ym] && byYm[ym].amt != null) amt = (amt || 0) + byYm[ym].amt; });
    var l = parsed.quarters[String(q)];
    return { q: q, planAmt: amt, legacyAmt: l == null ? null : l, ok: l != null && same(amt, l) };
  });
  var vendors = P.vendorOrder.map(function (v) {
    var p = byVendor[v] || { qty: null, amt: null }, st = P.vendorTotals[v], l = st && st.total ? st.total : null;
    return { vendor: v, planQty: p.qty, planAmt: p.amt, legacyQty: l ? l.qty : null, legacyAmt: l ? l.amt : null, ok: !!l && same(p.amt, l.amt) && same(p.qty, l.qty) };
  });
  var C = parsed.close;
  var closeMonths = C && C.grand ? C.months.map(function (m) { var x = C.grand.values[m.ym]; return { ym: m.ym, qty: x.qty, amt: x.amt }; }) : [];
  return {
    months: monthRows,
    total: { planQty: all.qty, planAmt: all.amt, legacyQty: gt ? gt.qty : null, legacyAmt: gt ? gt.amt : null, ok: !!gt && same(all.amt, gt.amt) && same(all.qty, gt.qty) },
    year: { planAmt: all.amt, legacyAmt: parsed.yearTarget == null ? null : parsed.yearTarget, ok: parsed.yearTarget != null && same(all.amt, parsed.yearTarget) },
    quarters: quarters, vendors: vendors,
    close: { months: closeMonths, quarters: parsed.closeQuarters, year: parsed.yearClose == null ? null : parsed.yearClose, found: !!(C && C.grand) }
  };
}

/* offline_migrateGonguTargets — mode 'preview'(쓰기 없음) | 'apply'
   반영: 공구목표_월에서 출처 migration 이면서 이관 월 범위 안인 행만 지우고 다시 넣는다(여러 번 실행해도 같음).
   출처 input(대시보드 입력) 행이 있는 키는 건드리지 않는다. 원본 스프레드시트는 읽기만 한다. */
function _gtMigrate(data, auth) {
  var apply = data.mode === 'apply';
  var run = function () {
    var ss = _offSS(), legacy = _offLegacySS();
    var parsed = _gtParseLegacy(_offLegacyGrid(legacy, LEGACY_GONGU_TAB));
    var plan = _gtPlan(parsed, data.mapping || null);
    var months = parsed.plan.months.map(function (m) { return m.ym; }), monthSet = {};
    months.forEach(function (m) { monthSet[m] = true; });
    var range = months.length ? months[0] + '~' + months[months.length - 1] : '';
    var def = OFF_TABS.gonguTargets, sheet = _offSheet(ss, 'gonguTargets');
    var existing = _offReadRows(sheet, def), inputKeys = {};
    existing.forEach(function (r) { if (r[7] === 'input') inputKeys[_gtRowKey(r)] = true; });
    var today = _offToday(), email = (auth && auth.email) || '';
    var newRows = [], skippedInput = 0;
    plan.rows.forEach(function (r) {
      if (inputKeys[_gtKey(r.ym, r.vendor, r.line, r.model)]) { skippedInput++; return; }
      newRows.push([r.ym, r.vendor, r.category, r.line, r.model, r.qty == null ? '' : r.qty, r.amount == null ? '' : r.amount, 'migration', today, email]);
    });
    var res = { success: true, mode: apply ? 'apply' : 'preview', sheetName: LEGACY_GONGU_TAB, months: months,
      products: plan.products, vendors: parsed.plan.vendorOrder, legacyRows: parsed.plan.rows.length,
      planRows: newRows.length, skippedInput: skippedInput, unmapped: plan.unmapped, badCells: parsed.badCells,
      compare: _gtCompare(parsed, plan.rows) };
    if (apply) {
      var rr = _offReplaceRows(sheet, def, existing, function (r) { return !(r[7] === 'migration' && monthSet[r[0]]); }, newRows);
      res.written = newRows.length; res.removed = rr.removed;
      _offMigrationLog(ss, auth, '공구 목표', range, newRows.length, plan.unmapped.join(', '), '성공' + (skippedInput ? ' (입력값 보존 ' + skippedInput + '건)' : ''));
      _offInvalidateCache();
    }
    res.recentLog = _offRecentMigrationLog(ss);
    return res;
  };
  return apply ? _offWithLock(run) : run();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 파트 통합 집계 (home_getSummary) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/* 순수 계산 — 시트 없이 결과만 받는다(테스트).
   input: { ym, mode('month'|'ytd'), category('' = 본품 전체), monthly(_offMonthlyCompute 결과 — totals만 씀),
            inventory(_offInventoryCompute 결과), channels(채널마스터 행), gonguTargets(공구목표_월 행), unmatchedCount }
   반환 series[채널군][연월] = { target, actual, incomplete } — 1~12월 전부. 공동구매는 target(·targetQty)만(실적은 브라우저).
   채널 현황 화면과 같은 합계(byChannelMonth = 본품 합계 · 대분류 필터면 byCategory)를 채널 유형으로 나눈 것이라
   오프라인 + 폐쇄몰·특판 = 채널 현황의 IN 금액. */
function _homeSummaryCompute(input) {
  var ym = input.ym, y = ym.slice(0, 4), cat = input.category || '', mode = input.mode === 'ytd' ? 'ytd' : 'month';
  var months = _offYmList(y + '-01', y + '-12');
  var range = mode === 'ytd' ? months.filter(function (m) { return m <= ym; }) : [ym];
  var sum = _offSumOrNull, warnings = [];
  var chInfo = {}, unknown = {};
  (input.channels || []).forEach(function (r) { if (r[0]) chInfo[r[0]] = { name: r[1] || r[0], type: r[2] || '' }; });
  var groupOf = function (ch) {
    var info = chInfo[ch] || { name: ch, type: '' }, g = _offChannelGroup(info.type);
    if (!g) { unknown[ch] = info; g = 'offline'; }
    return g;
  };
  var series = {};
  OFF_CHANNEL_GROUPS.forEach(function (g) { series[g.key] = {}; months.forEach(function (m) { series[g.key][m] = { target: null, actual: null, incomplete: false }; }); });
  months.forEach(function (m) { series.gongu[m].targetQty = null; });

  // 1) 오프라인·폐쇄몰·특판 — IN 목표·실적 금액
  var tot = (input.monthly && input.monthly.totals) || {};
  var list = cat ? (tot.byCategory || []).filter(function (x) { return x.category === cat; }) : (tot.byChannelMonth || []);
  list.forEach(function (x) {
    var s = series[groupOf(x.channelId)][x.ym];
    if (!s) return;
    s.target = sum(s.target, x['in'].targetAmount);
    s.actual = sum(s.actual, x['in'].actualAmount);
    if (x['in'].amountIncomplete) s.incomplete = true;
  });
  // 2) 공동구매 목표 — 공구목표_월(본품만, 대분류 필터면 그 대분류)
  (input.gonguTargets || []).forEach(function (r) {
    if (!r[0] || !r[3]) return;
    var s = series.gongu[r[0]];
    if (!s) return;
    var c = _gtCat(r);
    if (cat ? c !== cat : !_offCatMain(c)) return;
    s.target = sum(s.target, _gtNum(r[6]));
    s.targetQty = sum(s.targetQty, _gtNum(r[5]));
  });

  // 3) 필터 — 본품 합계에 없는 필터 IN 실적 금액(대분류 필터가 걸리면 위 숫자가 이미 그 대분류라 주지 않는다)
  var filter = { byMonth: {}, qty: null, amount: null, incomplete: false };
  if (!cat) {
    (tot.byCategory || []).forEach(function (x) {
      if (x.category !== '필터') return;
      var f = filter.byMonth[x.ym] || (filter.byMonth[x.ym] = { qty: null, amount: null, incomplete: false });
      f.qty = sum(f.qty, x['in'].actual); f.amount = sum(f.amount, x['in'].actualAmount);
      if (x['in'].amountIncomplete) f.incomplete = true;
    });
    range.forEach(function (m) {
      var f = filter.byMonth[m];
      if (!f) return;
      filter.qty = sum(filter.qty, f.qty); filter.amount = sum(filter.amount, f.amount);
      if (f.incomplete) filter.incomplete = true;
    });
  }

  // 4) 대분류별 그 달 판매 — 채널군별 OUT(Sell-out) 수량·금액(공구 판매는 브라우저가 더한다)
  var cats = cat ? [cat] : OFFLINE_CATEGORIES.filter(_offCatMain);
  var cs = {};
  cats.forEach(function (c) {
    cs[c] = { category: c };
    ['offline', 'closed'].forEach(function (k) { cs[c][k] = { qty: null, amount: null, incomplete: false }; });
  });
  (tot.byCategory || []).forEach(function (x) {
    if (x.ym !== ym || !cs[x.category]) return;
    var o = cs[x.category][groupOf(x.channelId)];
    o.qty = sum(o.qty, x.out.actual); o.amount = sum(o.amount, x.out.actualAmount);
    if (x.out.amountIncomplete) o.incomplete = true;
  });
  Object.keys(unknown).forEach(function (ch) { warnings.push('채널군을 모르는 채널 유형 — 오프라인으로 더했습니다: ' + unknown[ch].name + '(' + (unknown[ch].type || '유형 없음') + ')'); });

  // 5) 오늘 챙길 것(오프라인 쪽) — 재고 현황·코드 매핑 화면과 같은 정의
  var inv = input.inventory || {}, invCh = inv.channels || [];
  var alerts = { over: 0, risk: 0, storeOut: 0 }, skuCat = {};
  (inv.groups || []).forEach(function (g) {
    if (g.level !== 'sku') return;
    skuCat[g.skuId] = g.category;
    if (g.channelId !== '*' && (!cat || g.category === cat) && g.alert) alerts[g.alert]++;
  });
  (inv.storeOuts || []).forEach(function (s) { if (!cat || skuCat[s.skuId] === cat) alerts.storeOut++; });
  var chView = function (c) {
    return { channelId: c.channelId, name: c.name, salesDate: c.salesDate, stockDate: c.stockDate, salesAge: c.salesAge, stockAge: c.stockAge,
      staleSales: !!c.staleSales, staleStock: !!c.staleStock };
  };
  return {
    ym: ym, year: y, mode: mode, category: cat, months: months, range: range,
    groups: OFF_CHANNEL_GROUPS.map(function (g) { return { key: g.key, label: g.label, types: g.types }; }),
    series: series, filter: filter, categorySales: cats.map(function (c) { return cs[c]; }),
    today: { delayed: invCh.filter(function (c) { return c.staleSales || c.staleStock; }).map(chView), unmatched: input.unmatchedCount || 0, alerts: alerts },
    freshness: invCh.filter(function (c) { return c.hasStock || c.hasSales; }).map(chView),
    staleDays: inv.settings ? inv.settings['데이터지연_경고일수'] : null,
    warnings: warnings
  };
}

/* home_getSummary — data = { ym, mode, category }. 캐시 5분(키에 오프라인 캐시 세대 — 업로드·목표 저장·매핑·공구 목표 저장/이관이
   세대를 바꾸면 자동 무효). 월별 해석·재고 지표는 채널 현황이 쓰는 것과 같은 조회(같은 캐시)를 그대로 부른다. */
function _homeGetSummary(data) {
  var ym = String(data.ym || ''), mode = data.mode === 'ytd' ? 'ytd' : 'month', cat = String(data.category || '');
  if (!_offIsYm(ym)) throw new Error('연월이 올바르지 않습니다: ' + data.ym);
  if (cat && OFFLINE_CATEGORIES.indexOf(cat) < 0) throw new Error('대분류가 올바르지 않습니다: ' + cat);
  var cache = CacheService.getScriptCache();
  var key = 'home:summary:' + _offCacheGen() + ':' + ym + ':' + mode + ':' + cat;
  var hit = _cacheGetJSON(cache, key);
  if (hit) { hit.cached = true; return hit; }
  var ss = _offSS(), y = ym.slice(0, 4);
  var out = _homeSummaryCompute({ ym: ym, mode: mode, category: cat,
    monthly: _offGetMonthly({ from: y + '-01', to: y + '-12', totalsOnly: true }),
    inventory: _offGetInventory({}),
    channels: _offChannelRows(ss),
    gonguTargets: _offReadRows(_offSheet(ss, 'gonguTargets'), OFF_TABS.gonguTargets),
    unmatchedCount: _offGetUnmatched().items.length });
  out.success = true;
  _cachePutJSON(cache, key, out, OFF_CACHE_TTL_SEC);
  return out;
}
