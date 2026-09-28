/* 오프라인 코드 해석(src/features/offline/resolver.js) — "읽을 때 해석" 설계의 한가운데.

   지키려는 성질:
     · (channel_id, 원본코드)가 유일한 키 — 채널이 다르면 같은 코드라도 다른 매핑
     · 한 SKU에 여러 코드(이마트 880·279 바코드)가 붙는다
     · sku_id가 빈 매핑(비활성화)은 해석하지 않는다 → 미매칭으로 돌아간다
     · 매핑을 바꾸면 같은 원장 행이 곧바로 새 SKU로 읽힌다(원장은 원본코드만 가짐)
     · 모델명 추출·재고구분 추정·SKU 제안이 실제 포털 코드 표기((J)·_OFF·.DEMO·리퍼)에서 동작
     · 브라우저 전역(OfflineResolver)과 node require 양쪽에서 같은 코드가 로드된다

   실행: node tests/offline-resolver.test.js  (또는 node tests/run-all.js) */
const fs = require('fs'), path = require('path'), vm = require('vm');
const FILE = path.join(__dirname, '..', 'src', 'features', 'offline', 'resolver.js');
const R = require(FILE);

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

const masters = {
  skus: [
    { skuId: 'SKU-0001', name: '더 플렌더 MAX 그레이지', line: '더플렌더', model: 'MNFD-200G', option: '그레이지' },
    { skuId: 'SKU-0002', name: '더 플렌더 PLUS 크림 화이트', line: '더플렌더', model: '더 플렌더 PLUS', option: '크림 화이트' },
    { skuId: 'SKU-0003', name: '더 시프트', line: '더시프트', model: 'MNKR-100G', option: '' }
  ],
  mappings: [
    { channelId: 'etland', code: 'MNFD-200G', skuId: 'SKU-0001', stockType: '정상', name: '미닉스 더플렌더 MAX' },
    { channelId: 'etland', code: 'MNFD-200G.DEMO', skuId: 'SKU-0001', stockType: '전시', name: '미닉스 더플렌더 MAX 전시' },
    { channelId: 'emart', code: '8809770080951', skuId: 'SKU-0002', stockType: '정상', name: '미닉스 더플렌더 PLUS(크림 화이트)' },
    { channelId: 'emart', code: '2790198892256', skuId: 'SKU-0002', stockType: '정상', name: '미닉스 더플렌더 PLUS 크림 화이트(진)' },
    { channelId: 'himart', code: 'MNVC-100G', skuId: '', stockType: '정상', name: '미닉스 무선청소기_더슬림', note: '비활성화 2026-09-27' }
  ]
};

console.log('\n[1] resolve — (channel_id, 원본코드) 키');
{
  const r = R.createResolver(masters);
  const a = r.resolve('etland', 'MNFD-200G');
  check('전자랜드 MNFD-200G → SKU-0001 정상', a && a.skuId === 'SKU-0001' && a.stockType === '정상' && a.sku.name === '더 플렌더 MAX 그레이지', a);
  const b = r.resolve('etland', 'MNFD-200G.DEMO');
  check('같은 SKU의 전시 코드 → SKU-0001 전시', b && b.skuId === 'SKU-0001' && b.stockType === '전시', b);
  check('같은 코드라도 다른 채널이면 미매칭', r.resolve('himart', 'MNFD-200G') === null);
  check('이마트 바코드 두 개가 한 SKU로', r.resolve('emart', '8809770080951').skuId === 'SKU-0002' && r.resolve('emart', '2790198892256').skuId === 'SKU-0002');
  check('비활성화(sku_id 빈) 매핑은 해석하지 않음', r.resolve('himart', 'MNVC-100G') === null && !r.isMapped('himart', 'MNVC-100G'));
  check('코드는 정확히 일치해야(앞뒤 공백·대소문자 변형은 다른 코드)', r.resolve('etland', 'mnfd-200g') === null && r.resolve('etland', ' MNFD-200G') === null);
  check('unmatched — 순서 유지', JSON.stringify(r.unmatched('etland', ['X1', 'MNFD-200G', 'X2'])) === '["X1","X2"]');
  check('빈 마스터도 안전', R.createResolver({}).resolve('emart', 'A') === null && R.createResolver(null).unmatched('emart', ['A']).length === 1);
}

console.log('\n[2] 읽을 때 해석 — 매핑을 바꾸면 같은 원장 행이 바로 새 SKU로');
{
  const ledger = [['2026-09-01', '2026-09-01', 'day', 'himart', 'A3833E', '(J)MNFD-200G', 2, 2]];
  const before = R.createResolver(masters).resolve(ledger[0][3], ledger[0][5]);
  const after = R.createResolver(Object.assign({}, masters, {
    mappings: masters.mappings.concat([{ channelId: 'himart', code: '(J)MNFD-200G', skuId: 'SKU-0001', stockType: '전시' }])
  })).resolve(ledger[0][3], ledger[0][5]);
  check('매핑 전: 미매칭', before === null);
  check('매핑 후: 과거 행도 SKU-0001 전시', after && after.skuId === 'SKU-0001' && after.stockType === '전시', after);
}

console.log('\n[3] 모델명 추출 — 포털별 표기');
[
  ['(J)MNMD-110G_OFF', 'MNMD-110G'], ['MNMD-110GR_OFF', 'MNMD-110GR'], ['MNFD-200G.DEMO', 'MNFD-200G'],
  ['MNDW-110CG', 'MNDW-110CG'], ['(J)MNMD-FN', 'MNMD-FN'], ['MNFD-RF3', 'MNFD-RF3'],
  ['8809770080951', ''], ['미닉스 더플렌더 MAX(그레이지)', ''], ['', '']
].forEach(([s, want]) => check(`"${s}" → "${want}"`, R.extractModel(s) === want, R.extractModel(s)));

console.log('\n[4] 재고구분 추정');
[
  ['MNFD-200G.DEMO', '미닉스 더플렌더 MAX 전시', '전시'], ['(J)MNDW-100G', '', '전시'],
  ['(J)MNMD-110G_OFF', '(진열) 미닉스 3KG 건조기 그레이지', '전시'], ['MNVC-100G.DEMO', '미닉스 더슬림 (무선청소기) (전시)', '전시'],
  ['MNKR-100G', '미닉스 김치냉장고 더시프트', '정상'], ['MW74017_264837', '[리퍼 A급] 빈프레소 3세대 전자동 커피머신', '리퍼'],
  ['8809770080951', '미닉스 더플렌더 PLUS(크림 화이트)', '정상']
].forEach(([code, name, want]) => check(`${code} → ${want}`, R.guessStockType(code, name) === want, R.guessStockType(code, name)));

console.log('\n[5] SKU 제안 — 같은 모델이 이미 매핑된 SKU');
{
  const s1 = R.suggestSkus(masters, '(J)MNFD-200G', '미닉스 음식물처리기_더플렌더 MAX_전시');
  check('하이마트 (J)MNFD-200G → SKU-0001(전자랜드 매핑 2건 + 모델)', s1.length === 1 && s1[0].skuId === 'SKU-0001' && s1[0].hits === 3 && s1[0].model === 'MNFD-200G', s1);
  const s2 = R.suggestSkus(masters, 'MNKR-100G.DEMO', '');
  check('제품마스터 모델 = MNKR-100G → SKU-0003', s2.length === 1 && s2[0].skuId === 'SKU-0003', s2);
  check('모델명이 없는 바코드는 제안 없음', R.suggestSkus(masters, '8809770080968', '미닉스 더플렌더 MAX(그레이지)').length === 0);
  check('비활성화 매핑은 제안 근거가 아님', R.suggestSkus(masters, 'MNVC-100G_OFF', '').length === 0);
}

console.log('\n[5-2] 코드체계채널 — 트레이더스는 이마트 매핑을 그대로 쓴다');
{
  const m = { skus: masters.skus, channels: [{ channelId: 'emart', codeSystem: 'emart' }, { channelId: 'traders', codeSystem: 'emart' }, { channelId: 'etland', codeSystem: 'etland' }],
    mappings: [{ channelId: 'emart', code: '8809770080968', skuId: 'SKU-0001', stockType: '정상' }, { channelId: 'emart', code: '2790198885265', skuId: 'SKU-0001', stockType: '전시' }] };
  const r = R.createResolver(m);
  check('트레이더스 코드 → 이마트 매핑(SKU·재고구분)', r.resolve('traders', '8809770080968').skuId === 'SKU-0001' && r.resolve('traders', '2790198885265').stockType === '전시');
  check('이마트는 그대로', r.resolve('emart', '8809770080968').skuId === 'SKU-0001');
  check('다른 코드체계(전자랜드)는 이마트 매핑을 보지 않음', r.resolve('etland', '8809770080968') === null);
  check('미매칭 판정도 코드체계 기준', r.isMapped('traders', '8809770080968') && JSON.stringify(r.unmatched('traders', ['8809770080968', 'X'])) === '["X"]');
  check('codeSystem 함수', r.codeSystem('traders') === 'emart' && r.codeSystem('etland') === 'etland' && r.codeSystem('모르는채널') === '모르는채널');
  check('channels가 없는 옛 응답이면 자기 자신', R.createResolver({ mappings: m.mappings }).resolve('traders', '8809770080968') === null);
}

console.log('\n[6] 브라우저 로드 — 전역 OfflineResolver');
{
  const sandbox = {};
  sandbox.window = sandbox;
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), vm.createContext(sandbox), { filename: 'resolver.js' });
  check('module 없으면 전역에 붙는다', sandbox.OfflineResolver && typeof sandbox.OfflineResolver.createResolver === 'function');
  check('같은 결과', sandbox.OfflineResolver.extractModel('(J)MNFD-120G') === 'MNFD-120G');
}

console.log('\n' + '─'.repeat(50));
console.log('통과 ' + pass + ' / 실패 ' + fail);
process.exit(fail ? 1 : 0);
