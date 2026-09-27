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
