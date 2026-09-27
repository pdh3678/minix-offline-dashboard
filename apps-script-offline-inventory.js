/**
 * 미닉스 오프라인 2-B — 재고·판매 지표(채널 현황·채널 상세·재고 현황 화면), 설정 저장
 * apps-script.js · apps-script-offline.js · apps-script-offline-targets.js 와 **같은 Apps Script 프로젝트의 네 번째 파일**이다(전역 공유).
 *
 * ★ 배포: Apps Script 편집기 → 파일 ＋ → 스크립트 → 이름 "offline_inventory" → 이 파일 전체를 붙여넣기.
 *   탭 정의(OFF_TABS)·설정 기본값(OFF_SETTINGS_DEFAULT)·시트 입출력·락·캐시는 apps-script-offline.js,
 *   품목 카탈로그(OFFLINE_CATALOG·_offCanonModel)는 apps-script-offline-targets.js 의 것을 그대로 쓴다.
 *
 * 지표 정의는 **여기 한 곳**(_offInventoryCompute)에만 있다 — 세 화면이 같은 결과를 받아 그리기만 한다.
 *   정상재고     채널 최신 기준일(재고_채널일별) 재고 중 재고구분 '정상' 합계. 전시·리퍼는 따로
 *   일평균 판매  최근 N일(설정 재고일수_판매기준일수) 판매원장 수량 합 ÷ N
 *                창 = [판매 최신 기준일 − N + 1, 판매 최신 기준일] — 판매 최신 기준일은 업로드로그 기준(채널마다 다름).
 *                "오늘"이 아니라 데이터가 있는 마지막 날에서 세야 업로드가 며칠 밀려도 판매가 적게 잡히지 않는다.
 *                period 레코드는 기간종료일이 창 안이면 통째로 포함. 재고구분과 무관하게 합산
 *   재고일수     정상재고 ÷ 일평균 판매. 일평균이 0 이하면 null('판매 없음')
 *   진열 점포 수 재고_점포최신에서 '전시' 재고 > 0 인 점포 수
 *   취급 점포 수 재고구분 무관 재고 > 0 인 점포 수. 커버리지 = 취급 ÷ 점포마스터의 그 채널 점포 수
 *   점포 결품    당월판매 > 0 인데 현재 재고(재고구분 합) 0 인 점포 × SKU
 *                당월판매 = 재고_점포최신의 당월판매(이마트·하이마트 파일에 있음, 당월 누적), 그 열이 비어 있는 채널(전자랜드)은
 *                판매원장에서 재고 기준일이 속한 달의 점포 판매 합
 *   경보         재고일수 > 과다일수 → over(과다) / 재고일수 < 결품위험일수 → risk(결품 위험) / 점포 결품
 *   미매칭       매핑 없는 코드의 재고·판매는 합계에서 빼지 않고 unmatched 로 따로 준다(채널 전체 = SKU 합 + 미매칭).
 *                점포 수·점포 결품은 SKU로 해석된 코드만 센다(다른 브랜드 상품이 섞여 있어서)
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 공용 — 코드 해석·날짜 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

var OFF_INV_LEVELS = ['channel', 'category', 'line', 'model', 'sku'];

/* (channel_id, 원본코드) → { sku: {skuId, name, line, model, category, active, order}, stockType } | null
   _offMonthlyCompute와 같은 규칙: 활성 매핑(sku_id 있음) + 품목군이 있는 SKU만 해석한다. 비활성 SKU도 과거 집계에는 쓴다. */
function _offCodeResolver(skuRows, mappingRows) {
  var skus = {};
  skuRows.forEach(function (s) {
    if (!s[0] || !s[2]) return;
    skus[s[0]] = { skuId: s[0], name: s[1], line: s[2], model: _offCanonModel(s[2], s[3]).model, category: OFFLINE_LINE_CATEGORY[s[2]] || '',
      option: s[4], active: s[5] || 'Y', order: s[6] };
  });
  var byKey = {};
  mappingRows.forEach(function (m) { if (m[0] && m[1] && m[2] && skus[m[2]]) byKey[m[0] + OFF_KEY_SEP + m[1]] = m; });
  return {
    skus: skus,
    resolve: function (ch, code) {
      var m = byKey[ch + OFF_KEY_SEP + code];
      if (!m) return null;
      return { sku: skus[m[2]], stockType: OFF_STOCK_TYPES.indexOf(m[3]) >= 0 ? m[3] : '정상' };
    }
  };
}

// 그룹 키 — 모델은 품목군 안에서만 유일하므로 '품목군|모델'
function _offGroupKey(level, sku) {
  if (level === 'channel') return '';
  if (level === 'category') return sku.category;
  if (level === 'line') return sku.line;
  if (level === 'model') return sku.line + '|' + sku.model;
  return sku.skuId;
}
// 카탈로그 순서(대분류 → 품목군 → 모델 → SKU 정렬순서·이름) — 화면 표 순서
function _offCatalogRank(sku) {
  var li = _OFF_LINE_ORDER.indexOf(sku.line), mi = (OFFLINE_PRODUCT_MODELS[sku.line] || []).indexOf(sku.model);
  return [OFFLINE_CATEGORIES.indexOf(sku.category), li < 0 ? 99 : li, mi < 0 ? 99 : mi, Number(sku.order) || 9999];
}
function _offDaysBetween(a, b) { // b − a (일), 'YYYY-MM-DD'
  var t = function (s) { return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); };
  return Math.round((t(b) - t(a)) / 86400000);
}
function _offChannelInfo(channelRows) {
  return channelRows.filter(function (r) { return r[0]; }).map(function (r) {
    return { channelId: r[0], name: r[1], type: r[2], active: r[3], order: r[4], uploadStartMonth: _offIsYm(r[5]) ? r[5] : '' };
  }).sort(function (a, b) { return (Number(a.order) || 99) - (Number(b.order) || 99); });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 재고 지표 (순수 계산 — 시트 없이 행 배열만 받는다) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/* input: { today, settings{키:값}, storeChannel(점포 표를 줄 채널, 선택),
            channels, skus, mappings, stores, sales, stockDaily, stockStore, uploadLog, unmatchedTab } (각 탭 _offReadRows 행)
   반환:
     channels[]  채널별 기준일·지연·점포 수·당월판매 원천
     groups[]    채널(channelId '*' = 전체 채널) × 단계(channel·category·line·model·sku) 지표
                 { stock{정상,전시,리퍼}, total, windowQty, dailyAvg, days, noSales, displayStores, handlingStores, coverage, storeOuts, alert }
     unmatched[] 채널 × 미매칭 코드 { stock, windowQty }
     storeOuts[] 점포 결품 { channelId, store, storeName, region, skuId, monthSale }
     stores[]    storeChannel 의 점포 × SKU(미매칭 코드는 skuId '' + code) 재고·당월판매·진열·결품 */
function _offInventoryCompute(input) {
  var S = _offSettingsFrom(input.settingsRows || []);
  if (input.settings) Object.keys(input.settings).forEach(function (k) { S[k] = input.settings[k]; });
  var N = Math.max(1, Math.round(S['재고일수_판매기준일수']));
  var OVER = S['재고경보_과다일수'], RISK = S['재고경보_결품위험일수'], STALE = S['데이터지연_경고일수'];
  var today = input.today, storeFor = input.storeChannel || '';
  var R = _offCodeResolver(input.skus, input.mappings);

  // 채널 — 재고 최신 기준일(재고_채널일별), 판매 최신 기준일(업로드로그)
  var chans = _offChannelInfo(input.channels), chIdx = {};
  chans.forEach(function (c) { c.salesLast = ''; c.stockLast = ''; chIdx[c.channelId] = c; });
  _offLogCoverage(input.uploadLog || [], chIdx);
  var stockDate = {};
  input.stockDaily.forEach(function (r) { if (chIdx[r[1]] && _offIsDate(r[0]) && r[0] > (stockDate[r[1]] || '')) stockDate[r[1]] = r[0]; });
  // 업로드로그가 비어 있으면(수기 복구 등) 원장의 마지막 기간종료일로 대신한다
  var ledgerLast = {};
  input.sales.forEach(function (r) { if (chIdx[r[3]] && _offIsDate(r[1]) && r[1] > (ledgerLast[r[3]] || '')) ledgerLast[r[3]] = r[1]; });
  var storeTotal = {};
  input.stores.forEach(function (r) { if (r[0] && r[1]) storeTotal[r[0]] = (storeTotal[r[0]] || 0) + 1; });

  // 그룹 누적
  var G = {}, gOrder = [];
  function grp(ch, level, sku) {
    var k = ch + OFF_KEY_SEP + level + OFF_KEY_SEP + (sku ? _offGroupKey(level, sku) : '');
    if (!G[k]) {
      var g = { channelId: ch, level: level, key: sku ? _offGroupKey(level, sku) : '', category: '', line: '', model: '', skuId: '', name: '',
        stock: { '정상': 0, '전시': 0, '리퍼': 0 }, windowQty: 0, _disp: {}, _hand: {}, storeOuts: 0 };
      if (sku && level !== 'channel') {
        g.category = sku.category;
        if (level !== 'category') g.line = sku.line;
        if (level === 'model' || level === 'sku') g.model = sku.model;
        if (level === 'sku') { g.skuId = sku.skuId; g.name = sku.name; g.active = sku.active; g.option = sku.option; }
        g._rank = _offCatalogRank(sku);
      }
      G[k] = g; gOrder.push(k);
    }
    return G[k];
  }
  // 한 SKU 값이 들어가는 모든 그룹(그 채널 + 전체 채널 × 다섯 단계)
  function each(ch, sku, fn) {
    [ch, '*'].forEach(function (c) { OFF_INV_LEVELS.forEach(function (lv) { fn(grp(c, lv, lv === 'channel' ? null : sku)); }); });
  }
  chans.forEach(function (c) { grp(c.channelId, 'channel', null); });
  grp('*', 'channel', null);
  var UM = {}, umOrder = [];
  function um(ch, code) {
    var k = ch + OFF_KEY_SEP + code;
    if (!UM[k]) { UM[k] = { channelId: ch, code: code, name: '', stock: 0, windowQty: 0 }; umOrder.push(k); }
    return UM[k];
  }

  // 1) 채널 재고 — 최신 기준일 행만
  input.stockDaily.forEach(function (r) {
    var ch = r[1];
    if (!chIdx[ch] || r[0] !== stockDate[ch]) return;
    var qty = Number(r[3]) || 0, res = R.resolve(ch, r[2]);
    if (!res) { um(ch, r[2]).stock += qty; return; }
    each(ch, res.sku, function (g) { g.stock[res.stockType] += qty; });
  });

  // 2) 최근 N일 판매 — 기간종료일이 창 안인 레코드(day·period 모두)
  var win = {};
  chans.forEach(function (c) {
    var end = c.salesLast || ledgerLast[c.channelId] || '';
    if (end) win[c.channelId] = { from: _offAddDays(end, -(N - 1)), to: end };
  });
  input.sales.forEach(function (r) {
    var ch = r[3], w = win[ch];
    if (!w || !(r[1] >= w.from && r[1] <= w.to)) return;
    var qty = Number(r[6]) || 0;
    if (!qty) return;
    var res = R.resolve(ch, r[5]);
    if (!res) { um(ch, r[5]).windowQty += qty; return; }
    each(ch, res.sku, function (g) { g.windowQty += qty; });
  });

  // 3) 점포 — 재고_점포최신(채널당 최신 1벌) × SKU, 당월판매
  var cell = {}, cellOrder = [], monthSrc = {}, month = {};
  function sc(ch, store, skuId, code) {
    var k = [ch, store, skuId || '', skuId ? '' : code].join(OFF_KEY_SEP);
    // other = 미매칭 코드의 재고(재고구분을 모름)
    if (!cell[k]) { cell[k] = { channelId: ch, store: store, skuId: skuId || '', code: skuId ? '' : code, stock: { '정상': 0, '전시': 0, '리퍼': 0 }, other: 0, monthSale: 0 }; cellOrder.push(k); }
    return cell[k];
  }
  var storeDate = {};
  input.stockStore.forEach(function (r) {
    if (!chIdx[r[1]]) return;
    if (r[0] > (storeDate[r[1]] || '')) storeDate[r[1]] = r[0];
    if (r[8] !== '' && r[8] != null) monthSrc[r[1]] = 'stock';
  });
  chans.forEach(function (c) {
    var d = storeDate[c.channelId] || stockDate[c.channelId] || '';
    if (d && !monthSrc[c.channelId]) monthSrc[c.channelId] = 'ledger';
    month[c.channelId] = d.slice(0, 7);
  });
  input.stockStore.forEach(function (r) {
    var ch = r[1];
    if (!chIdx[ch] || r[0] !== storeDate[ch]) return;
    var res = R.resolve(ch, r[3]);
    var c = sc(ch, r[2], res ? res.sku.skuId : '', r[3]);
    if (res) c.stock[res.stockType] += Number(r[4]) || 0; else c.other += Number(r[4]) || 0;
    if (monthSrc[ch] === 'stock') c.monthSale += Number(r[8]) || 0;
  });
  // 당월판매가 재고 파일에 없는 채널 — 판매원장에서 그 달 점포 판매(점포코드가 있는 레코드만)
  input.sales.forEach(function (r) {
    var ch = r[3];
    if (monthSrc[ch] !== 'ledger' || !r[4] || String(r[1]).slice(0, 7) !== month[ch]) return;
    var qty = Number(r[6]) || 0;
    if (!qty) return;
    var res = R.resolve(ch, r[5]);
    sc(ch, r[4], res ? res.sku.skuId : '', r[5]).monthSale += qty;
  });
  var storeInfo = {};
  input.stores.forEach(function (r) { if (r[0] && r[1]) storeInfo[r[0] + OFF_KEY_SEP + r[1]] = { name: r[2], region: r[3] }; });
  var storeOuts = [], storeRows = [];
  cellOrder.forEach(function (k) {
    var c = cell[k], total = c.stock['정상'] + c.stock['전시'] + c.stock['리퍼'] + c.other;
    var info = storeInfo[c.channelId + OFF_KEY_SEP + c.store] || { name: '', region: '' };
    var out = !!c.skuId && c.monthSale > 0 && total === 0;
    if (c.skuId) {
      var sku = R.skus[c.skuId];
      each(c.channelId, sku, function (g) {
        if (c.stock['전시'] > 0) g._disp[c.channelId + OFF_KEY_SEP + c.store] = true;
        if (total > 0) g._hand[c.channelId + OFF_KEY_SEP + c.store] = true;
        if (out) g.storeOuts++;
      });
      if (out) storeOuts.push({ channelId: c.channelId, store: c.store, storeName: info.name, region: info.region, skuId: c.skuId, monthSale: c.monthSale });
    }
    if (c.channelId === storeFor) {
      storeRows.push({ store: c.store, storeName: info.name, region: info.region, skuId: c.skuId, code: c.code,
        '정상': c.stock['정상'], '전시': c.stock['전시'], '리퍼': c.stock['리퍼'], other: c.other, total: total, monthSale: c.monthSale, display: c.stock['전시'] > 0, out: out });
    }
  });

  // 4) 마무리 — 합계·일평균·재고일수·점포 수·경보
  var totalStores = 0;
  chans.forEach(function (c) { totalStores += storeTotal[c.channelId] || 0; });
  var groups = gOrder.map(function (k) {
    var g = G[k], ch = g.channelId;
    var hasSales = ch === '*' ? Object.keys(win).length > 0 : !!win[ch];
    g.total = g.stock['정상'] + g.stock['전시'] + g.stock['리퍼'];
    g.dailyAvg = hasSales ? g.windowQty / N : null;
    g.noSales = hasSales && !(g.dailyAvg > 0);
    g.days = g.dailyAvg > 0 ? g.stock['정상'] / g.dailyAvg : null;
    g.displayStores = Object.keys(g._disp).length;
    g.handlingStores = Object.keys(g._hand).length;
    var st = ch === '*' ? totalStores : (storeTotal[ch] || 0);
    g.coverage = st ? g.handlingStores / st : null;
    g.alert = g.days == null ? '' : (g.days > OVER ? 'over' : (g.days < RISK ? 'risk' : ''));
    delete g._disp; delete g._hand;
    return g;
  });
  var chRank = {};
  chans.forEach(function (c, i) { chRank[c.channelId] = i; });
  chRank['*'] = 999;
  groups.sort(function (a, b) {
    var d = (chRank[a.channelId] - chRank[b.channelId]) || (OFF_INV_LEVELS.indexOf(a.level) - OFF_INV_LEVELS.indexOf(b.level));
    if (d) return d;
    var x = a._rank || [], y = b._rank || [];
    for (var i = 0; i < 4; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return String(a.name || a.key) < String(b.name || b.key) ? -1 : 1;
  });
  groups.forEach(function (g) { delete g._rank; });

  var names = {};
  (input.unmatchedTab || []).forEach(function (r) { if (r[0] && r[1] && r[2]) names[r[0] + OFF_KEY_SEP + r[1]] = r[2]; });
  input.mappings.forEach(function (m) { var k = m[0] + OFF_KEY_SEP + m[1]; if (m[4] && !names[k]) names[k] = m[4]; });
  var unmatched = umOrder.map(function (k) { var u = UM[k]; u.name = names[k] || ''; return u; })
    .filter(function (u) { return u.stock || u.windowQty; })
    .sort(function (a, b) { return (chRank[a.channelId] - chRank[b.channelId]) || (b.stock - a.stock) || (a.code < b.code ? -1 : 1); });

  var channelsOut = chans.map(function (c) {
    var sd = stockDate[c.channelId] || '', sl = win[c.channelId] ? win[c.channelId].to : '';
    var um0 = unmatched.filter(function (u) { return u.channelId === c.channelId; });
    return { channelId: c.channelId, name: c.name, type: c.type, active: c.active, order: c.order, uploadStartMonth: c.uploadStartMonth,
      stockDate: sd, salesDate: sl, salesFrom: win[c.channelId] ? win[c.channelId].from : '',
      stockAge: sd ? _offDaysBetween(sd, today) : null, salesAge: sl ? _offDaysBetween(sl, today) : null,
      staleStock: !!sd && _offDaysBetween(sd, today) > STALE, staleSales: !!sl && _offDaysBetween(sl, today) > STALE,
      hasStock: !!sd, hasSales: !!sl, storeDate: storeDate[c.channelId] || '', storeTotal: storeTotal[c.channelId] || 0,
      monthSaleSource: monthSrc[c.channelId] || '', monthSaleMonth: month[c.channelId] || '',
      unmatchedStock: um0.reduce(function (s, u) { return s + u.stock; }, 0), unmatchedQty: um0.reduce(function (s, u) { return s + u.windowQty; }, 0) };
  });
  storeOuts.sort(function (a, b) { return (chRank[a.channelId] - chRank[b.channelId]) || (b.monthSale - a.monthSale) || (a.store < b.store ? -1 : 1); });
  storeRows.sort(function (a, b) { return (a.storeName < b.storeName ? -1 : a.storeName > b.storeName ? 1 : 0) || (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0) || (a.code < b.code ? -1 : 1); });
  return { today: today, settings: S, windowDays: N, channels: channelsOut, groups: groups, unmatched: unmatched, storeOuts: storeOuts,
    storeChannel: storeFor, stores: storeFor ? storeRows : [] };
}

// 재고 지표에 필요한 탭을 한 번씩 읽는다
function _offInventoryInput(ss) {
  var read = function (k) { return _offReadRows(_offSheet(ss, k), OFF_TABS[k]); };
  var st = ss.getSheetByName(OFF_TABS.settings.name);
  return { today: _offToday(), settingsRows: st ? _offReadRows(st, OFF_TABS.settings) : [],
    channels: read('channel'), skus: read('sku'), mappings: read('mapping'), stores: read('store'), sales: read('sales'),
    stockDaily: read('stockDaily'), stockStore: read('stockStore'), uploadLog: read('uploadLog'), unmatchedTab: read('unmatched') };
}

/* offline_getInventory — data.channelId 를 주면 그 채널의 점포 표(stores)도 준다.
   캐시 키 = 세대 + 채널(점포 표가 채널마다 다르고 하이마트는 1,600여 줄이라 채널별로 나눠 둔다). 쓰기가 세대를 바꾸면 자동 무효 */
function _offGetInventory(data) {
  var ch = String(data.channelId || '');
  var cache = CacheService.getScriptCache();
  var key = 'offline:inv:' + _offCacheGen() + ':' + ch;
  var hit = _cacheGetJSON(cache, key);
  if (hit) { hit.cached = true; return hit; }
  var input = _offInventoryInput(_offSS());
  input.storeChannel = ch;
  var out = _offInventoryCompute(input);
  out.success = true;
  _cachePutJSON(cache, key, out, OFF_CACHE_TTL_SEC);
  return out;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 일별 판매 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

var OFF_SALES_LEVELS = ['category', 'line', 'model', 'sku'];
var OFF_MAX_RANGE_DAYS = 400;
function _offCheckRange(from, to) {
  if (!_offIsDate(from) || !_offIsDate(to) || from > to) throw new Error('기간이 올바르지 않습니다: ' + from + ' ~ ' + to);
  if (_offDaysBetween(from, to) > OFF_MAX_RANGE_DAYS) throw new Error('한 번에 ' + OFF_MAX_RANGE_DAYS + '일까지만 조회할 수 있습니다.');
}

/* input: { from, to, channelId?, level(category|line|model|sku), channels, skus, mappings, sales }
   기간종료일이 [from, to] 안인 레코드를 day(하루치)와 period(여러 날 합)로 나눠 집계 단위별로 준다 — 월별 해석과 같은 규칙
   (period는 기간종료일 기준). 하이마트는 설치완료수량(inst)도 같이. 매핑 없는 코드는 key '' + unmatched 목록. */
function _offDailySalesCompute(input) {
  var level = OFF_SALES_LEVELS.indexOf(input.level) >= 0 ? input.level : 'model';
  var onlyCh = input.channelId || '';
  var chans = _offChannelInfo(input.channels), chIdx = {};
  chans.forEach(function (c) { chIdx[c.channelId] = c; });
  var R = _offCodeResolver(input.skus, input.mappings);
  var keys = {}, days = {}, periods = {}, um = {}, hasInst = {};
  var tot = { qty: 0, inst: 0, unmatchedQty: 0 };
  input.sales.forEach(function (r) {
    var ch = r[3];
    if (!chIdx[ch] || (onlyCh && ch !== onlyCh) || !(r[1] >= input.from && r[1] <= input.to)) return;
    var qty = Number(r[6]) || 0, inst = (r[7] === '' || r[7] == null) ? null : (Number(r[7]) || 0);
    if (!qty && !inst) return;
    if (inst != null) hasInst[ch] = true;
    var res = R.resolve(ch, r[5]), key = '';
    if (res) {
      key = _offGroupKey(level, res.sku);
      if (!keys[key]) keys[key] = { key: key, category: res.sku.category, line: level === 'category' ? '' : res.sku.line,
        model: level === 'model' || level === 'sku' ? res.sku.model : '', skuId: level === 'sku' ? res.sku.skuId : '',
        name: level === 'sku' ? res.sku.name : '', _rank: _offCatalogRank(res.sku) };
    } else {
      var uk = ch + OFF_KEY_SEP + r[5];
      um[uk] = um[uk] || { channelId: ch, code: r[5], qty: 0, inst: 0 };
      um[uk].qty += qty; um[uk].inst += inst || 0;
      tot.unmatchedQty += qty;
    }
    tot.qty += qty; tot.inst += inst || 0;
    var isDay = r[2] === 'day' || r[0] === r[1];
    var bucket = isDay ? days : periods;
    var bk = (isDay ? r[1] : r[0] + '~' + r[1]) + OFF_KEY_SEP + ch + OFF_KEY_SEP + key;
    var b = bucket[bk] || (bucket[bk] = isDay ? { date: r[1], channelId: ch, key: key, qty: 0, inst: 0 } : { start: r[0], end: r[1], channelId: ch, key: key, qty: 0, inst: 0 });
    b.qty += qty; b.inst += inst || 0;
  });
  var keyList = Object.keys(keys).map(function (k) { return keys[k]; }).sort(function (a, b) {
    for (var i = 0; i < 4; i++) if (a._rank[i] !== b._rank[i]) return a._rank[i] - b._rank[i];
    return a.key < b.key ? -1 : 1;
  });
  keyList.forEach(function (k) { delete k._rank; });
  var list = function (o, f) { return Object.keys(o).map(function (k) { return o[k]; }).sort(function (a, b) { return a[f] < b[f] ? -1 : a[f] > b[f] ? 1 : (a.key < b.key ? -1 : 1); }); };
  return { from: input.from, to: input.to, level: level, channelId: onlyCh, keys: keyList,
    days: list(days, 'date'), periods: list(periods, 'end'), unmatched: Object.keys(um).map(function (k) { return um[k]; }),
    hasInst: hasInst, totals: tot };
}

function _offGetDailySales(data) {
  var from = String(data.from || ''), to = String(data.to || '');
  _offCheckRange(from, to);
  var level = OFF_SALES_LEVELS.indexOf(data.level) >= 0 ? data.level : 'model';
  var ch = String(data.channelId || '');
  var cache = CacheService.getScriptCache();
  var key = 'offline:daily:' + _offCacheGen() + ':' + from + ':' + to + ':' + ch + ':' + level;
  var hit = _cacheGetJSON(cache, key);
  if (hit) { hit.cached = true; return hit; }
  var ss = _offSS();
  var read = function (k) { return _offReadRows(_offSheet(ss, k), OFF_TABS[k]); };
  var out = _offDailySalesCompute({ from: from, to: to, channelId: ch, level: level,
    channels: read('channel'), skus: read('sku'), mappings: read('mapping'), sales: read('sales') });
  out.success = true;
  _cachePutJSON(cache, key, out, OFF_CACHE_TTL_SEC);
  return out;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 재고 추이 (재고_채널일별) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/* input: { from, to, channelId?, skuId?, model('품목군|모델')?, line?, category?, channels, skus, mappings, stockDaily }
   기준일마다 채널별 재고(재고구분별)를 준다. 품목 필터가 하나라도 있으면 그 품목으로 해석된 코드만, 없으면 전부(미매칭 포함). */
function _offInventoryTrendCompute(input) {
  var chans = _offChannelInfo(input.channels), chIdx = {};
  chans.forEach(function (c) { chIdx[c.channelId] = c; });
  var R = _offCodeResolver(input.skus, input.mappings);
  var f = { skuId: input.skuId || '', model: input.model || '', line: input.line || '', category: input.category || '' };
  var filtered = !!(f.skuId || f.model || f.line || f.category);
  var pts = {}, dates = {};
  input.stockDaily.forEach(function (r) {
    var ch = r[1];
    if (!chIdx[ch] || (input.channelId && ch !== input.channelId) || !(r[0] >= input.from && r[0] <= input.to)) return;
    var res = R.resolve(ch, r[2]);
    if (filtered) {
      if (!res) return;
      var s = res.sku;
      if ((f.skuId && s.skuId !== f.skuId) || (f.model && s.line + '|' + s.model !== f.model) || (f.line && s.line !== f.line) || (f.category && s.category !== f.category)) return;
    }
    var k = ch + OFF_KEY_SEP + r[0];
    var p = pts[k] || (pts[k] = { date: r[0], '정상': 0, '전시': 0, '리퍼': 0, unmatched: 0, total: 0 });
    var qty = Number(r[3]) || 0;
    if (res) p[res.stockType] += qty; else p.unmatched += qty;
    p.total += qty;
    dates[r[0]] = true;
  });
  var series = chans.filter(function (c) { return !input.channelId || c.channelId === input.channelId; }).map(function (c) {
    var points = Object.keys(pts).filter(function (k) { return k.indexOf(c.channelId + OFF_KEY_SEP) === 0; }).map(function (k) { return pts[k]; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return { channelId: c.channelId, name: c.name, points: points };
  }).filter(function (s) { return s.points.length; });
  return { from: input.from, to: input.to, filter: f, dates: Object.keys(dates).sort(), series: series };
}

function _offGetInventoryTrend(data) {
  var from = String(data.from || ''), to = String(data.to || '');
  _offCheckRange(from, to);
  var args = { from: from, to: to, channelId: String(data.channelId || ''), skuId: String(data.skuId || ''), model: String(data.model || ''),
    line: String(data.line || ''), category: String(data.category || '') };
  var cache = CacheService.getScriptCache();
  var key = 'offline:trend:' + _offCacheGen() + ':' + [args.from, args.to, args.channelId, args.skuId, args.model, args.line, args.category].join(':');
  var hit = _cacheGetJSON(cache, key);
  if (hit) { hit.cached = true; return hit; }
  var ss = _offSS();
  var read = function (k) { return _offReadRows(_offSheet(ss, k), OFF_TABS[k]); };
  args.channels = read('channel'); args.skus = read('sku'); args.mappings = read('mapping'); args.stockDaily = read('stockDaily');
  var out = _offInventoryTrendCompute(args);
  out.success = true;
  _cachePutJSON(cache, key, out, OFF_CACHE_TTL_SEC);
  return out;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 설정 저장 (관리자) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/* offline_saveSettings — data.settings = { 키: 값 }. 관리자(ADMIN_EMAILS)만. 값은 1~365 정수, 결품위험일수 < 과다일수.
   설정 탭에 키 행이 없으면 덧붙이고, 있으면 값만 바꾼다(설명은 그대로). 저장하면 캐시 세대가 바뀌어 모든 지표가 다시 계산된다. */
function _offSaveSettings(data, auth) {
  if (!_isAdminEmail(auth && auth.email)) throw new Error('설정은 관리자만 바꿀 수 있습니다.');
  var input = data.settings || {};
  var known = {};
  OFF_SETTINGS_DEFAULT.forEach(function (d) { known[d[0]] = d; });
  var keys = Object.keys(input);
  if (!keys.length) throw new Error('저장할 설정이 없습니다.');
  var clean = {};
  keys.forEach(function (k) {
    if (!known[k]) throw new Error('모르는 설정 키입니다: ' + k);
    var v = Number(input[k]);
    if (input[k] === '' || input[k] == null || !isFinite(v) || v !== Math.round(v) || v < 1 || v > 365) throw new Error(k + ' 값은 1~365 사이 정수여야 합니다: ' + input[k]);
    clean[k] = v;
  });
  return _offWithLock(function () {
    var ss = _offSS();
    var def = OFF_TABS.settings, sheet = _offSheet(ss, 'settings');
    var rows = _offReadRows(sheet, def), prev = rows.length;
    var next = _offSettingsFrom(rows);
    Object.keys(clean).forEach(function (k) { next[k] = clean[k]; });
    if (next['재고경보_결품위험일수'] >= next['재고경보_과다일수']) throw new Error('결품위험일수(' + next['재고경보_결품위험일수'] + ')는 과다일수(' + next['재고경보_과다일수'] + ')보다 작아야 합니다.');
    Object.keys(clean).forEach(function (k) {
      var row = null;
      for (var i = 0; i < rows.length; i++) if (rows[i][0] === k) { row = rows[i]; break; }
      if (!row) { row = [k, '', known[k][2]]; rows.push(row); }
      row[1] = clean[k];
    });
    _offWriteAll(sheet, def, rows, prev);
    _offInvalidateCache();
    Logger.log('[오프라인] 설정 저장 ' + JSON.stringify(clean) + ' by ' + auth.email);
    return { success: true, settings: _offSettingsFrom(rows) };
  });
}
