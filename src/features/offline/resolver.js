'use strict';
/* 오프라인 코드 해석(resolver) — 원본코드 → 표준 SKU·재고구분. 모든 오프라인 화면이 이것 하나만 쓴다.
   브라우저에서는 전역 OfflineResolver, node에서는 require()로 쓴다(scripts/test-offline-parsers.js 등).

   원장(판매원장·재고 탭)에는 원본코드만 저장돼 있다. SKU로 묶는 건 **읽을 때** 여기서 한다 —
   그래야 매핑을 나중에 추가·수정해도 과거 데이터에 바로 반영된다. 매핑의 유일한 키는
   (channel_id, 원본코드)이고, sku_id가 빈 매핑은 비활성화된 것이라 해석하지 않는다. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OfflineResolver = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const SEP = '\u0001';
  const STOCK_TYPES = ['정상', '전시', '리퍼'];

  /* 코드체계채널 — 코드매핑을 빌려 쓰는 채널(트레이더스 → emart). 매핑은 코드체계채널 한 벌이 두 채널에 같이 적용된다.
     masters.channels[].codeSystem(GAS offline_getMasters)이 없으면 자기 자신 */
  function codeSystemOf(masters) {
    const m = {};
    ((masters && masters.channels) || []).forEach(c => { if (c.channelId) m[c.channelId] = c.codeSystem || c.channelId; });
    return ch => m[ch] || ch;
  }

  // masters = offline_getMasters 응답({skus, mappings, channels, ...})
  function createResolver(masters) {
    const skuById = {};
    ((masters && masters.skus) || []).forEach(s => { skuById[s.skuId] = s; });
    const cs = codeSystemOf(masters);
    const byKey = {};
    ((masters && masters.mappings) || []).forEach(m => {
      if (m.channelId && m.code && m.skuId) byKey[cs(m.channelId) + SEP + m.code] = m;
    });
    return {
      // → { skuId, stockType, sku, mapping } | null(미매칭)
      resolve(channelId, code) {
        const m = byKey[cs(channelId) + SEP + String(code == null ? '' : code)];
        if (!m) return null;
        return { skuId: m.skuId, stockType: m.stockType || '정상', sku: skuById[m.skuId] || null, mapping: m };
      },
      isMapped(channelId, code) { return !!byKey[cs(channelId) + SEP + code]; },
      // 코드 목록 중 매핑 없는 것만(순서 유지)
      unmatched(channelId, codes) { return (codes || []).filter(c => !byKey[cs(channelId) + SEP + c]); },
      codeSystem: cs
    };
  }

  // 원본코드·상품명에서 미닉스 모델명(MNFD-200G, MNMD-110GR …)을 뽑는다.
  // (J) 접두어, _OFF / .DEMO 같은 채널별 꼬리는 [0-9A-Z]가 아니라서 자연히 떨어진다.
  function extractModel(text) {
    const m = /MN[A-Z]{2,3}-[0-9A-Z]+/i.exec(String(text || ''));
    return m ? m[0].toUpperCase() : '';
  }

  // 재고구분 추정 — 제안일 뿐이고 확정은 사용자가 한다
  function guessStockType(code, name) {
    const s = String(code || '') + ' ' + String(name || '');
    if (/\.DEMO|\(J\)|진열|전시/i.test(s)) return '전시';
    if (/리퍼/.test(s)) return '리퍼';
    return '정상';
  }

  // 상품명 비교용 — 앞의 '[이마트]'·'[국내]' 같은 대괄호 접두어, 공백, 대소문자를 무시한다
  function normName(s) { return String(s || '').replace(/^\s*(\[[^\]]*\]\s*)+/, '').replace(/\s+/g, '').toLowerCase(); }

  /* 미매칭 코드에 붙일 SKU 제안 — 같은 모델명이 이미 매핑된 SKU(다른 채널 포함), 제품마스터 '모델'이 그 모델명인 SKU,
     모델명이 안 맞으면 접두어를 뺀 상품명이 같은 매핑의 SKU. 많이 겹칠수록 앞에 온다. → [{ skuId, model, hits, via('model'|'name') }] */
  function suggestSkus(masters, code, name) {
    const model = extractModel(code) || extractModel(name), nn = normName(name);
    if (!model && nn.length < 4) return [];
    const hits = {}, via = {};
    const hit = (id, how) => { hits[id] = (hits[id] || 0) + 1; if (!via[id] || how === 'model') via[id] = how; };
    ((masters && masters.mappings) || []).forEach(m => {
      if (!m.skuId) return;
      if (model && (extractModel(m.code) || extractModel(m.name)) === model) hit(m.skuId, 'model');
      else if (nn.length >= 4 && normName(m.name) === nn) hit(m.skuId, 'name');
    });
    if (model) ((masters && masters.skus) || []).forEach(s => { if (extractModel(s.model) === model) hit(s.skuId, 'model'); });
    return Object.keys(hits).sort((a, b) => hits[b] - hits[a] || (a < b ? -1 : 1)).map(id => ({ skuId: id, model, hits: hits[id], via: via[id] }));
  }

  /* 대분류 제안 — SKU 제안이 없는 코드에. item = { name, brand?, cat?(본품/구성품) } → { category, line, model, reason } | null
     · 미닉스 외 브랜드(톰 등) → 기타. 브랜드를 모르면(코드 매핑 화면) 상품명에 미닉스·제품 이름·MN 모델명이 없으면 미닉스 외로 본다
     · 상품명에 '필터'가 든 구성품(카테고리를 모르면 본품만 아니면) → 필터. 모델은 하드락필터·하드필터 — MINI 전용이나
       그 밖의 필터(더 시프트 탈취 필터 등)는 카탈로그에 맞는 모델이 없어 빈칸(새 모델 추가가 필요)
     제안일 뿐이고 확정은 사용자가 한다(SKU 선택·새 SKU 만들기) */
  const MINIX_NAME = /미닉스|minix|플렌더|시프트|슬림|에어드라이|건조기|식기세척기|MN[A-Z]{2,3}-/i;
  function suggestCategory(item) {
    const it = item || {}, name = String(it.name || ''), brand = String(it.brand || '').trim();
    if (!name && !brand) return null;
    if (!(brand ? /미닉스|minix/i.test(brand) : MINIX_NAME.test(name))) {
      return { category: '기타', line: '기타', model: '기타', reason: brand ? '브랜드 ' + brand + ' — 미닉스 외' : '상품명이 미닉스 제품이 아님' };
    }
    if (/필터/.test(name) && it.cat !== '본품') {
      const n = name.replace(/\s+/g, '');
      const model = /mini|미니/i.test(n) ? '' : /하드락필터/.test(n) ? '하드락필터' : /하드필터/.test(n) ? '하드필터' : '';
      return { category: '필터', line: '필터', model, reason: (it.cat ? it.cat + ' · ' : '') + "상품명에 '필터'" + (model ? '' : ' — 카탈로그에 맞는 필터 모델 없음(새 모델 추가 필요)') };
    }
    return null;
  }

  return { createResolver, codeSystemOf, extractModel, guessStockType, suggestSkus, suggestCategory, normName, STOCK_TYPES };
});
