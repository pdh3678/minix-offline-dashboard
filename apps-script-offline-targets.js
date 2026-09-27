/**
 * 미닉스 오프라인 2-A — 월별 실적 해석, 목표·Sell-in 입력, 단가, 과거 실적 이관
 * apps-script.js · apps-script-offline.js 와 **같은 Apps Script 프로젝트의 세 번째 파일**이다(전역 공유).
 *
 * ★ 배포: Apps Script 편집기 → 파일 ＋ → 스크립트 → 이름 "offline_targets" → 이 파일 전체를 붙여넣기.
 *   탭 정의(OFF_TABS)·시트 입출력 헬퍼·락·캐시는 apps-script-offline.js 의 것을 그대로 쓴다.
 *
 * 월별 실적의 원천
 *   IN 목표·IN 실적·OUT 목표          목표실적_월(대시보드 입력 또는 이관)
 *   OUT 실적  연월 ≥ 채널 업로드시작월 → 판매원장 집계(원본코드 → 코드매핑 → sku → 품목군·모델)
 *             그 외(이전 달·업로드 없는 채널) → 목표실적_월의 OUT 실적수량
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 품목 카탈로그(모델) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 프론트 src/shared/constants/products.js PRODUCT_CATALOG 의 품목군 key → 모델 label 과 **같아야 한다**
// (tests/offline-monthly.test.js 가 대조한다). 목표·단가·SKU의 '모델'은 이 표기로 맞춰 집계한다.
var OFFLINE_PRODUCT_MODELS = {
  '더플렌더': ['더 플렌더 Basic', '더 플렌더 PRO', '더 플렌더 MAX', '더 플렌더 mini', '더 플렌더 NEXT', '더 플렌더 PLUS'],
  '더시프트': ['더 시프트', '더 시프트 PRO'],
  '더슬림': ['더 슬림'],
  '더에어드라이': ['더 에어드라이'],
  '미니건조기': ['미니 건조기', '미니 건조기 PRO', '미니 건조기 PRO+'],
  '미니식기세척기': ['미니 식기세척기', '미니 식기세척기 PRO']
};

// 비교용 표기 — 공백 제거·소문자('더플렌더 MINI' = '더 플렌더 mini')
function _offNorm(s) { return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase(); }

/* 품목군 안에서 모델 표기를 카탈로그 label로 맞춘다 → { model, known }
   · 같은 표기(공백·대소문자 무시)          '더플렌더 MAX' → '더 플렌더 MAX'
   · 품목군 이름을 뺀 표기                   'MAX' → '더 플렌더 MAX'
   · 빈 모델 + 품목군 이름과 같은 기본 모델    '' (더슬림) → '더 슬림'
   카탈로그에 없는 표기는 그대로 두고 known=false(집계는 하되 경고). */
function _offCanonModel(line, model) {
  var list = OFFLINE_PRODUCT_MODELS[line];
  var raw = String(model == null ? '' : model).trim();
  if (!list) return { model: raw, known: false };
  var n = _offNorm(raw), ln = _offNorm(line);
  for (var i = 0; i < list.length; i++) {
    var ml = _offNorm(list[i]);
    if (ml === n || (n && ml === ln + n) || (!n && ml === ln)) return { model: list[i], known: true };
  }
  return { model: raw, known: false };
}

function _offIsYm(s) { return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s); }
function _offYmList(from, to) {
  var out = [], y = +from.slice(0, 4), m = +from.slice(5, 7);
  while (true) {
    var ym = y + '-' + _pad(m);
    if (ym > to) break;
    out.push(ym);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}
function _offPrevYm(ym) {
  var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1;
  if (m < 1) { m = 12; y--; }
  return y + '-' + _pad(m);
}
var _OFF_LINE_ORDER = Object.keys(OFFLINE_PRODUCT_MODELS);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 월별 실적 해석 (2-B 화면도 이 함수를 쓴다) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/* 단가 조회 — 금액 = 수량 × (그 달 1일 기준 가장 최근 적용시작일의 공급가). 없으면 null */
function _offPriceLookup(priceRows) {
  var byKey = {};
  priceRows.forEach(function (r) {
    if (!r[0] || !r[1] || !_offIsDate(r[4]) || r[3] === '' || r[3] == null) return;
    var k = [r[0], r[1], _offCanonModel(r[1], r[2]).model].join(OFF_KEY_SEP);
    (byKey[k] = byKey[k] || []).push({ start: r[4], price: Number(r[3]) });
  });
  Object.keys(byKey).forEach(function (k) { byKey[k].sort(function (a, b) { return a.start < b.start ? -1 : 1; }); });
  return function (ch, line, model, ym) {
    var list = byKey[[ch, line, model].join(OFF_KEY_SEP)];
    if (!list) return null;
    var day1 = ym + '-01', hit = null;
    for (var i = 0; i < list.length && list[i].start <= day1; i++) hit = list[i].price;
    return hit;
  };
}

function _offSumOrNull(a, b) { return a == null ? b : (b == null ? a : a + b); }
function _offRate(actual, target) { return (target && actual != null) ? actual / target : null; }

/* 순수 계산 — 시트 없이 행 배열만 받는다(테스트·2-B 재사용).
   input: { from, to, channelId?, channels[], targets[], prices[], sales[], mappings[], skus[] } (각 탭의 _offReadRows 행)
   반환: { months, channels, rows[], totals{byChannelMonth[], byMonth[]}, unmatched[], warnings[] }
   행 하나 = 연월 × 채널 × 품목군 × 모델
     in  { target, actual, rate, targetAmount, actualAmount }
     out { target, actual, source(upload|manual|migration|''), byType{정상,전시,리퍼}|null, rate, targetAmount, actualAmount } */
function _offMonthlyCompute(input) {
  var from = input.from, to = input.to, onlyCh = input.channelId || '';
  var months = _offYmList(from, to);
  var inRange = {};
  months.forEach(function (m) { inRange[m] = true; });
  var warnings = [], warned = {};
  function warn(key, msg) { if (!warned[key]) { warned[key] = true; warnings.push(msg); } }

  var channels = input.channels.filter(function (r) { return r[0] && (!onlyCh || r[0] === onlyCh); }).map(function (r) {
    return { channelId: r[0], name: r[1], active: r[3], order: r[4], uploadStartMonth: _offIsYm(r[5]) ? r[5] : '' };
  });
  var chInfo = {};
  channels.forEach(function (c) { chInfo[c.channelId] = c; });
  function isUploadMonth(ch, ym) { var s = chInfo[ch] && chInfo[ch].uploadStartMonth; return !!s && ym >= s; }

  var rows = {}, order = [];
  function row(ym, ch, line, model) {
    var k = [ym, ch, line, model].join(OFF_KEY_SEP);
    if (!rows[k]) {
      var canon = _offCanonModel(line, model);
      rows[k] = { ym: ym, channelId: ch, line: line, model: model, knownModel: canon.known,
        'in': { target: null, actual: null }, out: { target: null, actual: null, source: '', byType: null } };
      order.push(k);
      if (!canon.known) warn('model' + OFF_KEY_SEP + line + OFF_KEY_SEP + model, '카탈로그에 없는 모델: ' + line + ' / ' + (model || '(빈칸)'));
    }
    return rows[k];
  }
  var num = function (v) { return (v === '' || v == null) ? null : Number(v); };

  // 1) 목표실적_월
  input.targets.forEach(function (t) {
    var ym = t[0], ch = t[1], line = t[2], type = t[4];
    if (!inRange[ym] || !chInfo[ch] || !line || (type !== 'IN' && type !== 'OUT')) return;
    var model = _offCanonModel(line, t[3]).model;
    var r = row(ym, ch, line, model);
    if (type === 'IN') { r['in'].target = num(t[5]); r['in'].actual = num(t[6]); return; }
    r.out.target = num(t[5]);
    if (!isUploadMonth(ch, ym) && num(t[6]) != null) {
      r.out.actual = num(t[6]);
      r.out.source = t[7] === 'migration' ? 'migration' : 'manual';
    }
  });

  // 2) 판매원장 → OUT 실적(업로드 달만). day는 그 날, period는 기간종료일이 속한 달
  var skuById = {};
  input.skus.forEach(function (s) { if (s[0]) skuById[s[0]] = s; });
  var mapByKey = {};
  input.mappings.forEach(function (m) { if (m[0] && m[1] && m[2]) mapByKey[m[0] + OFF_KEY_SEP + m[1]] = m; });
  var unmatched = {};
  input.sales.forEach(function (s) {
    var ch = s[3], ym = String(s[1] || '').slice(0, 7);
    if (!inRange[ym] || !chInfo[ch] || !isUploadMonth(ch, ym)) return;
    var qty = Number(s[6]) || 0;
    if (!qty) return;
    var m = mapByKey[ch + OFF_KEY_SEP + s[5]];
    var sku = m && skuById[m[2]];
    if (!sku || !sku[2]) {
      var uk = [ym, ch, s[5]].join(OFF_KEY_SEP);
      unmatched[uk] = (unmatched[uk] || 0) + qty;
      return;
    }
    var r = row(ym, ch, sku[2], _offCanonModel(sku[2], sku[3]).model);
    var st = OFF_STOCK_TYPES.indexOf(m[3]) >= 0 ? m[3] : '정상';
    r.out.byType = r.out.byType || { '정상': 0, '전시': 0, '리퍼': 0 };
    r.out.byType[st] += qty;
    r.out.actual = (r.out.actual || 0) + qty;
    r.out.source = 'upload';
  });
  // 업로드 달인데 원장에 판매가 없는 행 = 0 (목표만 있는 행도 원천은 upload)
  order.forEach(function (k) {
    var r = rows[k];
    if (isUploadMonth(r.channelId, r.ym) && r.out.source !== 'upload') {
      r.out.actual = 0; r.out.source = 'upload'; r.out.byType = { '정상': 0, '전시': 0, '리퍼': 0 };
    }
  });

  // 3) 금액·달성률
  var priceFor = _offPriceLookup(input.prices);
  order.forEach(function (k) {
    var r = rows[k];
    var p = priceFor(r.channelId, r.line, r.model, r.ym);
    r.price = p;
    ['in', 'out'].forEach(function (side) {
      var s = r[side];
      s.targetAmount = (p != null && s.target != null) ? s.target * p : null;
      s.actualAmount = (p != null && s.actual != null) ? s.actual * p : null;
      s.rate = _offRate(s.actual, s.target);
      if (p == null && (s.target || s.actual)) {
        warn('price' + OFF_KEY_SEP + r.channelId + OFF_KEY_SEP + r.line + OFF_KEY_SEP + r.model,
          '단가 없음(금액 미계산): ' + r.channelId + ' / ' + r.model + ' (' + r.ym + '~)');
      }
    });
  });

  // 4) 정렬 — 연월 → 채널 정렬순서 → 품목군(카탈로그 순) → 모델(카탈로그 순, 없는 모델은 뒤)
  function modelIdx(line, model) { var l = OFFLINE_PRODUCT_MODELS[line] || []; var i = l.indexOf(model); return i < 0 ? 99 : i; }
  function lineIdx(line) { var i = _OFF_LINE_ORDER.indexOf(line); return i < 0 ? 99 : i; }
  var list = order.map(function (k) { return rows[k]; }).sort(function (a, b) {
    return (a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : 0) ||
      ((Number(chInfo[a.channelId].order) || 99) - (Number(chInfo[b.channelId].order) || 99)) ||
      (lineIdx(a.line) - lineIdx(b.line)) || (modelIdx(a.line, a.model) - modelIdx(b.line, b.model)) ||
      (a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
  });

  // 5) 합계 — 채널×월, 월. null만 있으면 null. 금액은 단가 없는 행이 섞이면 incomplete
  var unmatchedList = Object.keys(unmatched).sort().map(function (k) {
    var p = k.split(OFF_KEY_SEP);
    return { ym: p[0], channelId: p[1], code: p[2], qty: unmatched[k] };
  });
  function emptyTot() {
    return { 'in': { target: null, actual: null, targetAmount: null, actualAmount: null, amountIncomplete: false },
      out: { target: null, actual: null, targetAmount: null, actualAmount: null, amountIncomplete: false, unmatchedQty: 0 } };
  }
  function add(tot, r) {
    ['in', 'out'].forEach(function (side) {
      var s = r[side], t = tot[side];
      t.target = _offSumOrNull(t.target, s.target); t.actual = _offSumOrNull(t.actual, s.actual);
      t.targetAmount = _offSumOrNull(t.targetAmount, s.targetAmount); t.actualAmount = _offSumOrNull(t.actualAmount, s.actualAmount);
      if (r.price == null && (s.target || s.actual)) t.amountIncomplete = true;
    });
  }
  var byCM = {}, byM = {};
  list.forEach(function (r) {
    var k = r.ym + OFF_KEY_SEP + r.channelId;
    add(byCM[k] = byCM[k] || emptyTot(), r);
    add(byM[r.ym] = byM[r.ym] || emptyTot(), r);
  });
  unmatchedList.forEach(function (u) {
    var k = u.ym + OFF_KEY_SEP + u.channelId;
    (byCM[k] = byCM[k] || emptyTot()).out.unmatchedQty += u.qty;
    (byM[u.ym] = byM[u.ym] || emptyTot()).out.unmatchedQty += u.qty;
  });
  function finish(t) { t['in'].rate = _offRate(t['in'].actual, t['in'].target); t.out.rate = _offRate(t.out.actual, t.out.target); return t; }
  var byChannelMonth = Object.keys(byCM).sort().map(function (k) {
    var p = k.split(OFF_KEY_SEP), t = finish(byCM[k]);
    return { ym: p[0], channelId: p[1], 'in': t['in'], out: t.out };
  });
  var byMonth = Object.keys(byM).sort().map(function (ym) { var t = finish(byM[ym]); return { ym: ym, 'in': t['in'], out: t.out }; });
  if (unmatchedList.length) {
    var q = unmatchedList.reduce(function (s, u) { return s + u.qty; }, 0);
    warnings.push('매핑 안 된 코드 ' + unmatchedList.length + '건(수량 ' + q + ')은 OUT 실적 합계에 들어가지 않았습니다 — 코드 매핑에서 연결하세요.');
  }
  return { months: months, channels: channels, rows: list, totals: { byChannelMonth: byChannelMonth, byMonth: byMonth },
    unmatched: unmatchedList, warnings: warnings };
}

// 시트를 읽어 계산 — 캐시(offline: 캐시 세대가 바뀌면 자동 무효)
function _offGetMonthly(data) {
  var from = data.from, to = data.to || data.from;
  if (!_offIsYm(from) || !_offIsYm(to) || from > to) throw new Error('연월 범위가 올바르지 않습니다: ' + from + ' ~ ' + to);
  if (_offYmList(from, to).length > 36) throw new Error('한 번에 36개월까지만 조회할 수 있습니다.');
  var ch = String(data.channelId || '');
  var cache = CacheService.getScriptCache();
  var key = 'offline:monthly:' + _offCacheGen() + ':' + from + ':' + to + ':' + ch;
  var hit = _cacheGetJSON(cache, key);
  if (hit) { hit.cached = true; return hit; }
  var ss = _offSS();
  var read = function (k) { return _offReadRows(_offSheet(ss, k), OFF_TABS[k]); };
  var out = _offMonthlyCompute({ from: from, to: to, channelId: ch,
    channels: read('channel'), targets: read('targets'), prices: read('prices'),
    sales: read('sales'), mappings: read('mapping'), skus: read('sku') });
  out.success = true;
  _cachePutJSON(cache, key, out, OFF_CACHE_TTL_SEC);
  return out;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 목표·실적 입력 (목표실적_월) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _offTargetKey(ym, ch, line, model, type) { return [ym, ch, line, model, type].join(OFF_KEY_SEP); }
function _offQty(v, what) {
  if (v === '' || v == null) return '';
  var n = Number(v);
  if (typeof v === 'boolean' || !isFinite(n)) throw new Error(what + '은(는) 숫자여야 합니다: ' + v);
  return n;
}
function _offChannelRows(ss) { return _offReadRows(_offSheet(ss, 'channel'), OFF_TABS.channel).filter(function (r) { return r[0]; }); }
// 품목군·모델 검증 — 카탈로그에 있는 모델만(표기는 카탈로그 label로 맞춰 저장)
function _offCatalogModel(line, model, what) {
  if (OFFLINE_PRODUCT_LINES.indexOf(line) < 0) throw new Error(what + ' 품목군이 올바르지 않습니다: ' + line);
  var c = _offCanonModel(line, model);
  if (!c.known) throw new Error(what + ' 모델이 품목 상수에 없습니다: ' + line + ' / ' + model);
  return c.model;
}

/* 목표실적_월 upsert — 대시보드 입력은 출처 input(이관이 덮어쓰지 않는다).
   items: [{ ym, channelId, line, model, type:'IN'|'OUT', target, actual, note }] — 빈칸('')은 값 지우기.
   업로드시작월 이후의 OUT 실적은 원장에서 집계하므로 입력을 받지 않는다. */
function _offSaveTargets(data, auth) {
  var items = data.items || [];
  if (!items.length) throw new Error('저장할 목표·실적이 없습니다.');
  return _offWithLock(function () {
    var ss = _offSS();
    var chs = {};
    _offChannelRows(ss).forEach(function (r) { chs[r[0]] = r; });
    var def = OFF_TABS.targets, sheet = _offSheet(ss, 'targets');
    var rows = _offReadRows(sheet, def), prev = rows.length;
    var idx = {};
    rows.forEach(function (r) { idx[_offTargetKey(r[0], r[1], r[2], r[3], r[4])] = r; });
    var today = _offToday();
    items.forEach(function (it, i) {
      var what = (i + 1) + '번째 항목';
      if (!_offIsYm(it.ym)) throw new Error(what + ' 연월이 올바르지 않습니다: ' + it.ym);
      var ch = chs[it.channelId];
      if (!ch) throw new Error(what + ' 채널마스터에 없는 channel_id 입니다: ' + it.channelId);
      if (it.type !== 'IN' && it.type !== 'OUT') throw new Error(what + ' 구분은 IN 또는 OUT 이어야 합니다: ' + it.type);
      var model = _offCatalogModel(it.line, it.model, what);
      var target = _offQty(it.target, what + ' 목표수량'), actual = _offQty(it.actual, what + ' 실적수량');
      if (it.type === 'OUT' && actual !== '' && _offIsYm(ch[5]) && it.ym >= ch[5]) {
        throw new Error(what + ': ' + it.channelId + ' ' + it.ym + ' OUT 실적은 판매원장에서 집계됩니다(업로드시작월 ' + ch[5] + ' 이후) — 입력할 수 없습니다.');
      }
      var k = _offTargetKey(it.ym, it.channelId, it.line, model, it.type);
      var row = idx[k];
      if (!row) { row = [it.ym, it.channelId, it.line, model, it.type, '', '', '', '', '', '']; rows.push(row); idx[k] = row; }
      row[5] = target; row[6] = actual; row[7] = 'input'; row[8] = today; row[9] = (auth && auth.email) || '';
      if (it.note !== undefined) row[10] = String(it.note || '').trim();
    });
    _offWriteAll(sheet, def, rows, prev);
    _offInvalidateCache();
    return { success: true, saved: items.length };
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 단가 (단가마스터) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _offPriceObj(r) { return { channelId: r[0], line: r[1], model: r[2], price: r[3], startDate: r[4], note: r[5], updatedAt: r[6], updatedBy: r[7] }; }
function _offGetPrices() {
  var ss = _offSS();
  var chOrder = {};
  _offChannelRows(ss).forEach(function (r) { chOrder[r[0]] = Number(r[4]) || 99; });
  var items = _offReadRows(_offSheet(ss, 'prices'), OFF_TABS.prices).filter(function (r) { return r[0] && r[1]; }).map(_offPriceObj);
  items.sort(function (a, b) {
    return ((chOrder[a.channelId] || 99) - (chOrder[b.channelId] || 99)) || (_OFF_LINE_ORDER.indexOf(a.line) - _OFF_LINE_ORDER.indexOf(b.line)) ||
      ((OFFLINE_PRODUCT_MODELS[a.line] || []).indexOf(a.model) - (OFFLINE_PRODUCT_MODELS[b.line] || []).indexOf(b.model)) ||
      (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0);
  });
  return { success: true, items: items };
}

/* 단가마스터 upsert — 키 (channel_id, 품목군, 모델, 적용시작일).
   items: [{ channelId, line, model, price, startDate, note, origStartDate }] — origStartDate가 있고 다르면
   원래 행을 새 적용시작일로 옮긴다(적용시작일 수정). */
function _offSavePrices(data, auth) {
  var items = data.items || [];
  if (!items.length) throw new Error('저장할 단가가 없습니다.');
  return _offWithLock(function () {
    var ss = _offSS();
    var n = _offUpsertPrices(ss, items, auth);
    _offInvalidateCache();
    return { success: true, saved: n };
  });
}
function _offUpsertPrices(ss, items, auth) {
  var chs = {};
  _offChannelRows(ss).forEach(function (r) { chs[r[0]] = true; });
  var def = OFF_TABS.prices, sheet = _offSheet(ss, 'prices');
  var rows = _offReadRows(sheet, def), prev = rows.length;
  var key = function (r) { return [r[0], r[1], r[2], r[4]].join(OFF_KEY_SEP); };
  var today = _offToday(), email = (auth && auth.email) || '';
  // 검증을 먼저 끝낸다 — 한 건이라도 틀리면 아무것도 쓰지 않는다
  var clean = items.map(function (it, i) {
    var what = (i + 1) + '번째 단가';
    if (!chs[it.channelId]) throw new Error(what + ': 채널마스터에 없는 channel_id 입니다: ' + it.channelId);
    var model = _offCatalogModel(it.line, it.model, what);
    var price = _offQty(it.price, what + ' 공급가');
    if (price === '' || price < 0) throw new Error(what + ': 공급가를 0 이상 숫자로 입력하세요.');
    if (!_offIsDate(it.startDate)) throw new Error(what + ': 적용시작일이 올바르지 않습니다: ' + it.startDate);
    if (it.origStartDate && !_offIsDate(it.origStartDate)) throw new Error(what + ': 원래 적용시작일이 올바르지 않습니다: ' + it.origStartDate);
    return { channelId: it.channelId, line: it.line, model: model, price: price, startDate: it.startDate, note: it.note, origStartDate: it.origStartDate || '' };
  });
  clean.forEach(function (it) {
    if (it.origStartDate && it.origStartDate !== it.startDate) {
      var ok = [it.channelId, it.line, it.model, it.origStartDate].join(OFF_KEY_SEP);
      rows = rows.filter(function (r) { return key(r) !== ok; });
    }
    var k = [it.channelId, it.line, it.model, it.startDate].join(OFF_KEY_SEP);
    var row = null;
    for (var j = 0; j < rows.length; j++) if (key(rows[j]) === k) { row = rows[j]; break; }
    if (!row) { row = [it.channelId, it.line, it.model, '', it.startDate, '', '', '']; rows.push(row); }
    row[3] = it.price; row[6] = today; row[7] = email;
    if (it.note !== undefined) row[5] = String(it.note || '').trim();
  });
  _offWriteAll(sheet, def, rows, prev);
  return clean.length;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 기존 스프레드시트 이관 (진행현황 · 납품가 수수료) — 원본은 **읽기만** 한다 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

var LEGACY_PROGRESS_SHEET_ID_PROP = 'LEGACY_PROGRESS_SHEET_ID';
var LEGACY_PROGRESS_TAB = '26년 진행현황';
var LEGACY_PRICE_TAB = '납품가 수수료';
// 진행현황의 품목 행 중 이관하지 않는 합계 행
var LEGACY_SKIP_PRODUCTS = { '소계': true, '합계': true, '총계': true, 'total': true };
// 모델 정보가 없는 품목명 → 품목군만(모델은 사용자가 고른다)
var LEGACY_LINE_SYNONYMS = { '건조기': '미니건조기', '식세기': '미니식기세척기', '식기세척기': '미니식기세척기' };

function _offLegacySS() {
  var id = PropertiesService.getScriptProperties().getProperty(LEGACY_PROGRESS_SHEET_ID_PROP);
  if (!id) throw new Error('Script Properties에 ' + LEGACY_PROGRESS_SHEET_ID_PROP + ' 가 없습니다 — 기존 진행현황 스프레드시트 ID를 등록하세요.');
  return SpreadsheetApp.openById(id);
}
/* 탭 전체 값 + 병합 셀 채움 — 병합 셀은 왼쪽 위 칸에만 값이 있어서, 병합 범위의 나머지 칸에 그 값을 채워 준다.
   (getValues / getMergedRanges만 쓴다 — 원본에는 어떤 쓰기도 하지 않는다) */
function _offLegacyGrid(ss, tabName) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) throw new Error('기존 스프레드시트에 "' + tabName + '" 탭이 없습니다.');
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return { name: tabName, values: [] };
  var range = sheet.getRange(1, 1, lastRow, lastCol);
  var values = range.getValues();
  range.getMergedRanges().forEach(function (m) {
    var r0 = m.getRow() - 1, c0 = m.getColumn() - 1, v = values[r0] ? values[r0][c0] : '';
    for (var r = r0; r < r0 + m.getNumRows() && r < values.length; r++)
      for (var c = c0; c < c0 + m.getNumColumns() && c < values[r].length; c++) if (values[r][c] === '' || values[r][c] == null) values[r][c] = v;
  });
  return { name: tabName, values: values };
}
function _offLegacyNum(v, bad) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  var s = String(v).replace(/[,\s]/g, '');
  if (!s) return null;
  var n = Number(s);
  if (isFinite(n)) return n;
  bad.n++; // '#REF!', 'Loading...' 같은 오류·로딩 표시
  return null;
}

/* '26년 진행현황' 파싱(순수) — 월 블록 헤더 행(채널·품목과 같은 행)과 그 아래 세부 헤더 행을 읽어
   월별 열을 동적으로 찾는다(월마다 블록 폭이 다르고 1월은 IN만 있다).
   반환: { year, months[{ym, cols{inT,inA,outT,outA}}], rows[{rowNo, group, channel, product, values{ym:{inT,inA,outT,outA}}}], badCells } */
function _offParseLegacyProgress(grid) {
  var v = grid.values, hr = -1, colCh = -1, colProd = -1, colGroup = -1;
  for (var r = 0; r < Math.min(10, v.length) && hr < 0; r++) {
    var row = v[r].map(function (x) { return _offNorm(x); });
    if (row.indexOf('채널') >= 0 && row.indexOf('품목') >= 0) { hr = r; colCh = row.indexOf('채널'); colProd = row.indexOf('품목'); colGroup = row.indexOf('구분'); }
  }
  if (hr < 0) throw new Error('"' + grid.name + '"에서 채널·품목 헤더 행을 찾지 못했습니다.');
  var ym = /(\d{2,4})년/.exec(grid.name);
  var year = ym ? (ym[1].length === 2 ? 2000 + Number(ym[1]) : Number(ym[1])) : Number(_offToday().slice(0, 4));
  var head = v[hr], sub = v[hr + 1] || [];
  var starts = [];
  // 월 라벨은 블록 폭만큼 병합돼 있어 채우고 나면 같은 라벨이 연달아 나온다 — 라벨이 바뀌는 칸만 블록 시작
  var prevLabel = null;
  head.forEach(function (x, c) {
    var t = String(x == null ? '' : x).trim(), m = /^(\d{1,2})월$/.exec(t);
    if (m && t !== prevLabel && +m[1] >= 1 && +m[1] <= 12) starts.push({ m: +m[1], c: c });
    prevLabel = t;
  });
  var names = { '목표(in)': 'inT', '실적(in)': 'inA', '목표(out)': 'outT', '실적(out)': 'outA' };
  var months = starts.map(function (s, k) {
    var end = k + 1 < starts.length ? starts[k + 1].c : head.length, cols = {};
    for (var c = s.c; c < end; c++) { var key = names[_offNorm(sub[c])]; if (key && cols[key] == null) cols[key] = c; }
    return { ym: year + '-' + _pad(s.m), cols: cols };
  });
  var bad = { n: 0 }, rows = [];
  for (var i = hr + 2; i < v.length; i++) {
    var ch = String(v[i][colCh] == null ? '' : v[i][colCh]).trim(), prod = String(v[i][colProd] == null ? '' : v[i][colProd]).trim();
    if (!ch || !prod || LEGACY_SKIP_PRODUCTS[_offNorm(prod)]) continue;
    var vals = {};
    months.forEach(function (mo) {
      var o = {};
      ['inT', 'inA', 'outT', 'outA'].forEach(function (k) { o[k] = mo.cols[k] == null ? null : _offLegacyNum(v[i][mo.cols[k]], bad); });
      vals[mo.ym] = o;
    });
    rows.push({ rowNo: i + 1, group: colGroup >= 0 ? String(v[i][colGroup] || '').trim() : '', channel: ch, product: prod, values: vals });
  }
  return { year: year, months: months, rows: rows, badCells: bad.n };
}

/* '납품가 수수료' 파싱(순수) — 헤더(채널·품목·모델명·공급가) 행을 찾고, 그 위 제목에서 기준일('2026. 4. 9일자')을 읽는다 */
function _offParseLegacyPrices(grid) {
  var v = grid.values, hr = -1, col = {};
  for (var r = 0; r < Math.min(10, v.length) && hr < 0; r++) {
    var row = v[r].map(function (x) { return _offNorm(x); });
    if (row.indexOf('채널') >= 0 && row.indexOf('품목') >= 0 && row.indexOf('공급가') >= 0) {
      hr = r;
      col = { ch: row.indexOf('채널'), prod: row.indexOf('품목'), code: row.indexOf('모델명'), sale: row.indexOf('판매가'), supply: row.indexOf('공급가') };
    }
  }
  if (hr < 0) throw new Error('"' + grid.name + '"에서 채널·품목·공급가 헤더 행을 찾지 못했습니다.');
  var baseDate = '';
  for (var t = 0; t < hr && !baseDate; t++) v[t].forEach(function (x) {
    var m = /(\d{4})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})/.exec(String(x == null ? '' : x));
    if (m && !baseDate) baseDate = m[1] + '-' + _pad(+m[2]) + '-' + _pad(+m[3]);
  });
  var bad = { n: 0 }, rows = [];
  for (var i = hr + 1; i < v.length; i++) {
    var ch = String(v[i][col.ch] == null ? '' : v[i][col.ch]).trim(), prod = String(v[i][col.prod] == null ? '' : v[i][col.prod]).trim();
    var supply = _offLegacyNum(v[i][col.supply], bad);
    if (!ch || !prod || supply == null) continue;
    rows.push({ rowNo: i + 1, channel: ch, product: prod, modelCode: col.code >= 0 ? String(v[i][col.code] || '').trim() : '',
      salePrice: col.sale >= 0 ? _offLegacyNum(v[i][col.sale], bad) : null, supplyPrice: supply });
  }
  return { baseDate: baseDate, rows: rows, badCells: bad.n };
}

// 채널명 → channel_id 제안: 같은 이름 > 원문이 채널명을 포함(이마트할인점 ⊃ 이마트) > 채널명이 원문을 포함(기타 특판 ⊃ 특판)
function _offSuggestChannel(name, channelRows) {
  var n = _offNorm(name), best = '', bestScore = 0;
  channelRows.forEach(function (c) {
    var cn = _offNorm(c[1]), score = 0;
    if (!cn) return;
    if (cn === n || _offNorm(c[0]) === n) score = 1000;
    else if (n.indexOf(cn) >= 0) score = 500 + cn.length;
    else if (cn.indexOf(n) >= 0) score = 100 + n.length;
    if (score > bestScore) { bestScore = score; best = c[0]; }
  });
  return best;
}
/* 품목명 → { line, model, ambiguous } 제안(대소문자·띄어쓰기 무시)
   · 모델 label과 같음 → 확정 제안 ('더플렌더 MAX' → 더플렌더 / 더 플렌더 MAX)
   · 모델 label이 그 이름으로 끝남 → 품목군이 모델 하나뿐이면 확정, 여럿이면 품목군만('건조기' → 미니건조기, 모델 빈칸)
   · 동의어('식세기') → 품목군만 */
function _offSuggestProduct(name) {
  var n = _offNorm(name);
  if (!n) return { line: '', model: '', ambiguous: true };
  var cands = [];
  for (var i = 0; i < _OFF_LINE_ORDER.length; i++) {
    var ln = _OFF_LINE_ORDER[i], ms = OFFLINE_PRODUCT_MODELS[ln];
    for (var j = 0; j < ms.length; j++) {
      var mn = _offNorm(ms[j]);
      if (mn === n) return { line: ln, model: ms[j], ambiguous: false };
      if (n.length >= 2 && mn.slice(-n.length) === n) cands.push({ line: ln, model: ms[j] });
    }
  }
  var line = cands.length ? cands[0].line : (LEGACY_LINE_SYNONYMS[n] || '');
  if (cands.some(function (c) { return c.line !== line; })) return { line: '', model: '', ambiguous: true };
  if (!line) return { line: '', model: '', ambiguous: true };
  var models = OFFLINE_PRODUCT_MODELS[line];
  return models.length === 1 ? { line: line, model: models[0], ambiguous: false } : { line: line, model: '', ambiguous: true };
}

function _offMigrationLog(ss, auth, target, range, count, unmapped, status) {
  var def = OFF_TABS.migrationLog, sheet = _offSheet(ss, 'migrationLog');
  _offWriteBlock(sheet, def, sheet.getLastRow() + 1, [[
    Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'), (auth && auth.email) || '', target, range, count,
    String(unmapped || '').slice(0, 2000), status
  ]]);
}
function _offRecentMigrationLog(ss) {
  var def = OFF_TABS.migrationLog, sheet = _offSheet(ss, 'migrationLog');
  var last = sheet.getLastRow(), n = Math.min(20, Math.max(0, last - 1));
  if (!n) return [];
  return sheet.getRange(last - n + 1, 1, n, def.headers.length).getValues().map(function (r) {
    return { at: _offStr(r[0]), by: _offStr(r[1]), target: _offStr(r[2]), range: _offStr(r[3]), count: Number(r[4]) || 0, unmapped: _offStr(r[5]), status: _offStr(r[6]) };
  }).filter(function (x) { return x.at; }).reverse();
}

/* 진행현황 → 목표실적_월 이관 계획. mapping 없으면 제안값을 쓴다.
   mapping = { channels: {원문 채널명: channel_id}, products: {원문 품목명: {line, model}} }
   이관 대상: 모든 월의 IN 목표·IN 실적·OUT 목표 + OUT 실적은 채널 업로드시작월 이전 달만(업로드 없는 채널은 전부).
   같은 키(연월·채널·품목군·모델·구분)로 모이는 원문 행은 합산한다. */
function _offProgressPlan(parsed, channelRows, mapping) {
  var chById = {};
  channelRows.forEach(function (c) { chById[c[0]] = c; });
  var chNames = {}, chOrder = [], prodNames = {}, prodOrder = [];
  parsed.rows.forEach(function (r) {
    if (!chNames[r.channel]) { chNames[r.channel] = { legacy: r.channel, group: r.group, rows: 0 }; chOrder.push(r.channel); }
    chNames[r.channel].rows++;
    if (!prodNames[r.product]) { prodNames[r.product] = { legacy: r.product, channels: [] }; prodOrder.push(r.product); }
    if (prodNames[r.product].channels.indexOf(r.channel) < 0) prodNames[r.product].channels.push(r.channel);
  });
  var mc = (mapping && mapping.channels) || null, mp = (mapping && mapping.products) || null;
  var channels = chOrder.map(function (k) {
    var c = chNames[k];
    c.suggest = _offSuggestChannel(k, channelRows);
    c.channelId = mc ? String(mc[k] || '') : c.suggest;
    if (c.channelId && !chById[c.channelId]) throw new Error('채널마스터에 없는 channel_id 입니다: ' + c.channelId);
    return c;
  });
  var products = prodOrder.map(function (k) {
    var p = prodNames[k], s = _offSuggestProduct(k);
    p.suggest = s; p.ambiguous = s.ambiguous;
    var m = mp ? (mp[k] || {}) : s;
    p.line = m.line || ''; p.model = m.model || '';
    if (p.line && OFFLINE_PRODUCT_LINES.indexOf(p.line) < 0) throw new Error('품목명 "' + k + '": 품목군이 올바르지 않습니다: ' + p.line);
    if (p.line && p.model) p.model = _offCatalogModel(p.line, p.model, '품목명 "' + k + '"');
    return p;
  });
  var chMap = {}, prMap = {};
  channels.forEach(function (c) { chMap[c.legacy] = c.channelId; });
  products.forEach(function (p) { if (p.line && p.model) prMap[p.legacy] = { line: p.line, model: p.model }; });
  var agg = {}, order = [], unmapped = [], seenUnmapped = {}, outSkipped = 0;
  function put(ym, ch, line, model, type, target, actual) {
    if (target == null && actual == null) return;
    var k = _offTargetKey(ym, ch, line, model, type);
    if (!agg[k]) { agg[k] = [ym, ch, line, model, type, null, null]; order.push(k); }
    if (target != null) agg[k][5] = (agg[k][5] || 0) + target;
    if (actual != null) agg[k][6] = (agg[k][6] || 0) + actual;
  }
  parsed.rows.forEach(function (r) {
    var ch = chMap[r.channel], pm = prMap[r.product];
    if (!ch || !pm) {
      var u = !ch ? '채널 ' + r.channel : '품목 ' + r.product + '(' + r.channel + ')';
      if (!seenUnmapped[u]) { seenUnmapped[u] = true; unmapped.push(u); }
      return;
    }
    var start = _offIsYm(chById[ch][5]) ? chById[ch][5] : '';
    parsed.months.forEach(function (mo) {
      var o = r.values[mo.ym];
      put(mo.ym, ch, pm.line, pm.model, 'IN', o.inT, o.inA);
      var outA = o.outA;
      if (outA != null && start && mo.ym >= start) { outA = null; outSkipped++; }
      put(mo.ym, ch, pm.line, pm.model, 'OUT', o.outT, outA);
    });
  });
  return { channels: channels, products: products, rows: order.map(function (k) { return agg[k]; }), unmapped: unmapped, outSkipped: outSkipped };
}

/* 업로드시작월 대조 리포트 — 업로드 채널의 그 달 OUT 실적: 진행현황 값 vs 원장 집계(이관하지 않는다) */
function _offCompareUploadStart(ss, parsed, plan, channelRows) {
  var chMap = {}, prMap = {};
  plan.channels.forEach(function (c) { chMap[c.legacy] = c.channelId; });
  plan.products.forEach(function (p) { if (p.line && p.model) prMap[p.legacy] = p; });
  var targets = {}, months = {};
  parsed.months.forEach(function (m) { months[m.ym] = true; });
  channelRows.forEach(function (c) { if (_offIsYm(c[5]) && months[c[5]]) targets[c[0]] = c[5]; });
  var legacy = {};
  parsed.rows.forEach(function (r) {
    var ch = chMap[r.channel], pm = prMap[r.product];
    if (!ch || !pm || !targets[ch]) return;
    var k = [ch, pm.line, pm.model].join(OFF_KEY_SEP);
    legacy[k] = _offSumOrNull(legacy[k] == null ? null : legacy[k], r.values[targets[ch]].outA);
  });
  var read = function (k) { return _offReadRows(_offSheet(ss, k), OFF_TABS[k]); };
  var sales = read('sales'), mappings = read('mapping'), skus = read('sku');
  var out = [];
  Object.keys(targets).forEach(function (ch) {
    var ym = targets[ch];
    var mon = _offMonthlyCompute({ from: ym, to: ym, channelId: ch, channels: channelRows, targets: [], prices: [], sales: sales, mappings: mappings, skus: skus });
    var ledger = {};
    mon.rows.forEach(function (r) { ledger[[ch, r.line, r.model].join(OFF_KEY_SEP)] = r.out.actual; });
    var keys = [];
    Object.keys(legacy).concat(Object.keys(ledger)).forEach(function (k) { if (k.indexOf(ch + OFF_KEY_SEP) === 0 && keys.indexOf(k) < 0) keys.push(k); });
    if (!keys.length) return; // 원본에도 원장에도 없는 채널은 대조할 게 없다
    keys.sort(function (a, b) {
      var pa = a.split(OFF_KEY_SEP), pb = b.split(OFF_KEY_SEP);
      return (_OFF_LINE_ORDER.indexOf(pa[1]) - _OFF_LINE_ORDER.indexOf(pb[1])) ||
        ((OFFLINE_PRODUCT_MODELS[pa[1]] || []).indexOf(pa[2]) - (OFFLINE_PRODUCT_MODELS[pb[1]] || []).indexOf(pb[2]));
    });
    var sumL = null, sumD = 0;
    keys.forEach(function (k) {
      var p = k.split(OFF_KEY_SEP), l = legacy[k] == null ? null : legacy[k], d = ledger[k] == null ? 0 : ledger[k];
      out.push({ ym: ym, channelId: ch, line: p[1], model: p[2], legacy: l, ledger: d, diff: d - (l || 0) });
      sumL = _offSumOrNull(sumL, l); sumD += d;
    });
    var um = mon.totals.byChannelMonth.length ? mon.totals.byChannelMonth[0].out.unmatchedQty : 0;
    out.push({ ym: ym, channelId: ch, line: '', model: '(채널 합계)', legacy: sumL, ledger: sumD, diff: sumD - (sumL || 0), unmatchedQty: um, total: true });
  });
  return out;
}

/* offline_migrateProgress — mode 'preview'(쓰기 없음) | 'apply'
   반영: 목표실적_월에서 출처 migration 이면서 이관 월 범위 안인 행만 지우고 다시 넣는다(여러 번 실행해도 같음).
   출처 input(대시보드 입력) 행이 있는 키는 건드리지 않는다. */
function _offMigrateProgress(data, auth) {
  var apply = data.mode === 'apply';
  var run = function () {
    var ss = _offSS(), legacy = _offLegacySS();
    var parsed = _offParseLegacyProgress(_offLegacyGrid(legacy, LEGACY_PROGRESS_TAB));
    var channelRows = _offChannelRows(ss);
    var plan = _offProgressPlan(parsed, channelRows, data.mapping || null);
    var months = parsed.months.map(function (m) { return m.ym; });
    var range = months.length ? months[0] + '~' + months[months.length - 1] : '';
    var def = OFF_TABS.targets, sheet = _offSheet(ss, 'targets');
    var existing = _offReadRows(sheet, def);
    var inputKeys = {};
    existing.forEach(function (r) { if (r[7] === 'input') inputKeys[_offTargetKey(r[0], r[1], r[2], r[3], r[4])] = true; });
    var today = _offToday(), email = (auth && auth.email) || '';
    var newRows = [], skippedInput = 0;
    plan.rows.forEach(function (r) {
      if (inputKeys[_offTargetKey(r[0], r[1], r[2], r[3], r[4])]) { skippedInput++; return; }
      newRows.push([r[0], r[1], r[2], r[3], r[4], r[5] == null ? '' : r[5], r[6] == null ? '' : r[6], 'migration', today, email, '진행현황 이관']);
    });
    var monthSet = {};
    months.forEach(function (m) { monthSet[m] = true; });
    var res = { success: true, mode: apply ? 'apply' : 'preview', sheetName: LEGACY_PROGRESS_TAB, year: parsed.year, months: months,
      channels: plan.channels, products: plan.products, planRows: newRows.length, skippedInput: skippedInput,
      outSkippedUploadMonths: plan.outSkipped, unmapped: plan.unmapped, badCells: parsed.badCells,
      legacyRows: parsed.rows.length, compare: _offCompareUploadStart(ss, parsed, plan, channelRows) };
    if (apply) {
      var rr = _offReplaceRows(sheet, def, existing, function (r) { return !(r[7] === 'migration' && monthSet[r[0]]); }, newRows);
      res.written = newRows.length; res.removed = rr.removed;
      _offMigrationLog(ss, auth, '진행현황', range, newRows.length, plan.unmapped.join(', '), '성공' + (skippedInput ? ' (입력값 보존 ' + skippedInput + '건)' : ''));
      _offInvalidateCache();
    }
    res.recentLog = _offRecentMigrationLog(ss);
    return res;
  };
  return apply ? _offWithLock(run) : run();
}

/* offline_migratePrices — mode 'preview' | 'apply'
   apply 입력: { startDate, rows: [{ rowNo, channelId, line, model }] } — 비어 있는 행은 미매핑으로 건너뛴다.
   단가마스터에 (채널, 품목군, 모델, 적용시작일) 키로 upsert — 여러 번 실행해도 같은 결과 */
function _offMigratePrices(data, auth) {
  var apply = data.mode === 'apply';
  var run = function () {
    var ss = _offSS(), legacy = _offLegacySS();
    var parsed = _offParseLegacyPrices(_offLegacyGrid(legacy, LEGACY_PRICE_TAB));
    var channelRows = _offChannelRows(ss);
    // 모델명(MN 코드) → 이미 매핑된 SKU의 품목군·모델 (예: MNMD-120G → 미니 건조기 PRO+)
    var skus = {}, byModelCode = {};
    _offReadRows(_offSheet(ss, 'sku'), OFF_TABS.sku).forEach(function (s) { skus[s[0]] = s; });
    _offReadRows(_offSheet(ss, 'mapping'), OFF_TABS.mapping).forEach(function (m) {
      var mc = (/MN[A-Z]{2,3}-[0-9A-Z]+/i.exec(String(m[1] || '')) || [''])[0].toUpperCase(), s = skus[m[2]];
      if (mc && s && s[2] && !byModelCode[mc]) byModelCode[mc] = { line: s[2], model: _offCanonModel(s[2], s[3]).model };
    });
    var rows = parsed.rows.map(function (r) {
      var byCode = byModelCode[String(r.modelCode || '').toUpperCase()];
      var s = byCode ? { line: byCode.line, model: byCode.model, ambiguous: false, from: 'model-code' } : _offSuggestProduct(r.product);
      return { rowNo: r.rowNo, legacyChannel: r.channel, product: r.product, modelCode: r.modelCode, salePrice: r.salePrice, supplyPrice: r.supplyPrice,
        suggest: { channelId: _offSuggestChannel(r.channel, channelRows), line: s.line, model: s.model, ambiguous: !!s.ambiguous, from: s.from || 'name' } };
    });
    var res = { success: true, mode: apply ? 'apply' : 'preview', sheetName: LEGACY_PRICE_TAB, baseDate: parsed.baseDate, rows: rows, badCells: parsed.badCells, warnings: [] };
    if (apply) {
      var startDate = data.startDate || parsed.baseDate;
      if (!_offIsDate(startDate)) throw new Error('적용시작일이 올바르지 않습니다: ' + startDate);
      var pick = {};
      (data.rows || []).forEach(function (x) { pick[x.rowNo] = x; });
      var items = [], unmapped = [], seen = {};
      rows.forEach(function (r) {
        var p = pick[r.rowNo];
        if (!p || !p.channelId || !p.line || !p.model) { unmapped.push(r.legacyChannel + ' ' + r.product + (r.modelCode ? '(' + r.modelCode + ')' : '')); return; }
        var k = [p.channelId, p.line, _offCanonModel(p.line, p.model).model].join(OFF_KEY_SEP);
        if (seen[k]) res.warnings.push('같은 채널·모델이 두 번 나와 뒤 행(' + r.rowNo + '행) 값을 썼습니다: ' + p.channelId + ' / ' + p.model);
        seen[k] = true;
        items.push({ channelId: p.channelId, line: p.line, model: p.model, price: r.supplyPrice, startDate: startDate,
          note: LEGACY_PRICE_TAB + ' 이관 · 모델명 ' + (r.modelCode || '-') + (r.salePrice != null ? ' · 판매가 ' + r.salePrice : '') + ' · 부가세포함' });
      });
      res.written = items.length ? _offUpsertPrices(ss, items, auth) : 0;
      res.unmapped = unmapped; res.startDate = startDate;
      _offMigrationLog(ss, auth, '단가', startDate, res.written, unmapped.join(', '), '성공');
      _offInvalidateCache();
    }
    res.recentLog = _offRecentMigrationLog(ss);
    return res;
  };
  return apply ? _offWithLock(run) : run();
}
