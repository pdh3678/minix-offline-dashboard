/**
 * 미닉스 오프라인 데이터 원장 — Google Apps Script
 * apps-script.js 와 **같은 Apps Script 프로젝트의 두 번째 파일**이다(전역을 공유한다).
 *
 * ★ 배포 방법
 * 1. Apps Script 편집기 → 파일 ＋ → 스크립트 → 이름 "offline" → 이 파일 내용 전체 붙여넣기 후 저장
 *    (apps-script.js 의 _authRequest / _json / _cachePutJSON / _cacheGetJSON 을 그대로 쓴다)
 * 2. 프로젝트 설정 → 스크립트 속성에 OFFLINE_SHEET_ID = 오프라인 스프레드시트 ID 추가
 * 3. 편집기에서 offline_setupSheets 를 1회 실행(권한 승인) — 여러 번 실행해도 안전하다
 * 4. 배포 관리 → 기존 웹앱 배포 편집 → "새 버전"으로 업데이트(URL 유지)
 *
 * 핵심 설계: 원장(판매원장·재고 탭)에는 **원본코드만** 저장한다. sku_id·재고구분은 읽을 때
 * 코드매핑으로 해석한다(프론트 src/features/offline/resolver.js). 그래야 매핑을 나중에 추가·수정해도
 * 과거 데이터에 즉시 반영된다. 매핑이 없는 코드도 원장에는 그대로 저장하고 미매칭코드 탭에 쌓는다.
 *
 * 파일 판별·파싱은 브라우저가 한다(src/features/offline/parsers.js). 여기로는 정규화된 레코드만 온다.
 * 이 파일은 "원장에 어떻게 반영하는가"(교체 범위·하이마트 차이 계산)만 책임진다.
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 설정 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 스프레드시트 ID는 코드에 두지 않는다 — 이 파일은 저장소 루트에 있어 공개 URL로 서빙된다.
var OFFLINE_SHEET_ID_PROP = 'OFFLINE_SHEET_ID';

// 품목군 — 프론트 src/shared/constants/products.js 의 PRODUCT_CATALOG 품목군 key와 **같은 목록**이어야 한다
// (tests/offline-gas.test.js 가 두 목록이 같은지 확인한다). 제품마스터 품목군은 이 값만 허용.
var OFFLINE_PRODUCT_LINES = ['더플렌더', '더시프트', '더슬림', '더에어드라이', '미니건조기', '미니식기세척기', '필터', '기타'];
var OFF_STOCK_TYPES = ['정상', '전시', '리퍼'];

// 파일 유형 → 채널과 반영 방식. period = 기간 교체형, snapshot = 스냅샷형, himart = 스냅샷형 + 누적 차이 계산
// split = 한 파일에 같은 코드체계의 여러 채널이 섞인 파일(이마트 포털: 이마트·트레이더스). channelId는 그 코드체계 채널이고,
//         레코드마다 채널을 따로 정한다 — 'biz' = 레코드의 업태명 → 채널마스터 원천업태명
var OFF_FILE_TYPES = {
  // 'store' = 업태명이 없어 점포로 채널을 정한다(점포마스터 → 점포명접두어 → 코드체계 채널)
  EMART_STOCK:        { channelId: 'emart',  kind: 'snapshot', split: 'store' },
  EMART_DAILY_SALES_STORE: { channelId: 'emart', kind: 'period', split: 'biz' },
  // 트레이더스가 합쳐진 SKU별 합계 파일 — 반영 거절(판별은 브라우저가 해서 안내한다). 점포별 일별 매출을 쓴다
  EMART_DAILY_SALES:  { channelId: 'emart',  kind: 'period', blocked: "트레이더스가 합쳐진 합계 파일이라 반영할 수 없습니다. '기간별매출(상품별)_일별상세' 파일을 사용하세요" },
  ETLAND_SALES:       { channelId: 'etland', kind: 'period' },
  // ERP 매출이익리스트(백화점·폐쇄몰·렌탈) — channelId는 코드체계(erp). split 'customer' = 레코드의 거래처코드(점포코드) → 거래처매핑 → 채널
  ERP_SALES_PROFIT:   { channelId: 'erp', kind: 'period', split: 'customer' },
  ETLAND_STOCK:       { channelId: 'etland', kind: 'snapshot' },
  HIMART_SALES_STOCK: { channelId: 'himart', kind: 'himart' }
};

// 탭 정의 — headers 순서가 곧 시트 열 순서. text = 텍스트 서식(@)으로 고정하는 열(0-based).
// 날짜·코드 열을 텍스트로 두지 않으면 시트가 '2026-09-01'을 날짜로, 13자리 바코드를 지수표기로,
// '0012' 점포코드를 12로 바꿔 버린다.
var OFF_TABS = {
  readme:     { name: 'README', headers: ['탭', '설명'], text: [0, 1] },
  sku:        { name: '제품마스터', headers: ['sku_id', '표준명', '품목군', '모델', '옵션', '활성', '정렬순서', '비고'], text: [0, 1, 2, 3, 4, 5, 7] },
  // 원천업태명·점포명접두어·코드체계채널(6~8)은 트레이더스 분리(2026-09-28)에서 덧붙인 열 — 설명은 README·OFF_CHANNEL_SEED 주석
  // 재고기준일오프셋(9, 숫자)은 재고 기준일 보정(2026-09-29)에서 덧붙인 열 — OFF_STOCK_OFFSET_SEED 주석
  // IN실적원천(10)은 ERP 매출이익리스트(2026-09-30)에서 덧붙인 열 — upload / input. OFF_ERP_CHANNELS 주석
  // 채널대분류(2)는 옛 '유형' 열을 바꾼 것, 채널별칭(11)은 덧붙인 열(2026-10-02) — OFF_CHANNEL_CATEGORIES 주석
  channel:    { name: '채널마스터', headers: ['channel_id', '채널명', '채널대분류', '활성', '정렬순서', '업로드시작월', '원천업태명', '점포명접두어', '코드체계채널', '재고기준일오프셋', 'IN실적원천', '채널별칭'], text: [0, 1, 2, 3, 5, 6, 7, 8, 10, 11] },
  mapping:    { name: '코드매핑', headers: ['channel_id', '원본코드', 'sku_id', '재고구분', '원본상품명', '등록일', '등록자', '비고'], text: [0, 1, 2, 3, 4, 5, 6, 7] },
  // 점포유형(6)은 판매 분석(2026-09-29)에서 덧붙인 열 — 온라인/오프라인. OFF_ONLINE_STORE_RE 주석
  store:      { name: '점포마스터', headers: ['channel_id', '점포코드', '점포명', '지역', '최초등록일', '최근확인일', '점포유형'], text: [0, 1, 2, 3, 4, 5, 6] },
  // 금액·수수료(10~11, 숫자)는 ERP 매출이익리스트(2026-09-30)에서 덧붙인 열 — 파일에 금액이 있는 채널만 채운다(포털 채널은 빈칸)
  sales:      { name: '판매원장', headers: ['기간시작', '기간종료', '단위', 'channel_id', '점포코드', '원본코드', '수량', '설치완료수량', '출처', 'upload_id', '금액', '수수료'], text: [0, 1, 2, 3, 4, 5, 8, 9] },
  stockDaily: { name: '재고_채널일별', headers: ['기준일', 'channel_id', '원본코드', '재고수량', '이동중수량', '예약수량', 'upload_id'], text: [0, 1, 2, 6] },
  stockStore: { name: '재고_점포최신', headers: ['기준일', 'channel_id', '점포코드', '원본코드', '재고수량', '이동중수량', '예약수량', '당월입고', '당월판매', 'upload_id'], text: [0, 1, 2, 3, 9] },
  himartSnap: { name: '하이마트_누적스냅샷', headers: ['기준일', '점포코드', '원본코드', '당월실판매', '당월판매', '금주판매', '당일판매', '잔여재고', 'upload_id'], text: [0, 1, 2, 8] },
  uploadLog:  { name: '업로드로그', headers: ['upload_id', '업로드시각', '업로더', '파일명', '파일유형', 'channel_id', '기준일/기간', '원본행수', '반영행수', '미매칭코드수', '경고', '상태'], text: [0, 1, 2, 3, 4, 5, 6, 10, 11] },
  unmatched:  { name: '미매칭코드', headers: ['channel_id', '원본코드', '원본상품명', '최초발견일', '최근발견일', '발견횟수'], text: [0, 1, 2, 3, 4] },
  // 2-A단계(2026-09-27) — 목표·Sell-in 입력, 단가, 과거 실적 이관 (로직은 apps-script-offline-targets.js)
  // 대분류(11)는 뒤에 덧붙인 열 — 모델 단위 행은 대분류·품목군·모델 모두, 대분류 단위 행(이관 전용)은 대분류만 채운다
  targets:    { name: '목표실적_월', headers: ['연월', 'channel_id', '품목군', '모델', '구분', '목표수량', '실적수량', '출처', '수정일', '수정자', '비고', '대분류'], text: [0, 1, 2, 3, 4, 7, 8, 9, 10, 11] },
  prices:     { name: '단가마스터', headers: ['channel_id', '품목군', '모델', '공급가', '적용시작일', '비고', '수정일', '수정자'], text: [0, 1, 2, 4, 5, 6, 7] },
  migrationLog: { name: '이관로그', headers: ['실행시각', '실행자', '대상', '월 범위', '반영 행수', '미매핑 항목', '상태'], text: [0, 1, 2, 3, 5, 6] },
  // 2-B단계(2026-09-27) — 재고일수·경보 기준값(키-값). 값은 숫자 열
  settings:   { name: '설정', headers: ['키', '값', '설명'], text: [0, 2] },
  // 파트 홈(2026-09-29) — 공동구매 월 목표. 키 (연월, 벤더, 품목군, 모델). 로직은 apps-script-home.js
  gonguTargets: { name: '공구목표_월', headers: ['연월', '벤더', '대분류', '품목군', '모델', '목표수량', '목표금액', '출처', '수정일', '수정자'], text: [0, 1, 2, 3, 4, 7, 8, 9] },
  // ERP 매출이익리스트(2026-09-30) — ERP 거래처 → 채널. 거래처가 곧 그 채널의 점포(점포코드 = 거래처코드)
  customerMap: { name: '거래처매핑', headers: ['거래처코드', '거래처명', 'channel_id', '비고'], text: [0, 1, 2, 3] }
};
var OFF_TAB_ORDER = ['readme', 'sku', 'channel', 'mapping', 'store', 'sales', 'stockDaily', 'stockStore', 'himartSnap', 'uploadLog', 'unmatched',
  'targets', 'prices', 'migrationLog', 'settings', 'gonguTargets', 'customerMap'];

/* 설정 기본값 — 설정 탭에 없는 키는 setup이 이 값으로 채우고(있는 값은 덮어쓰지 않음), 읽을 때도 없거나 잘못된 값은 이 값을 쓴다.
   재고 지표(apps-script-offline-inventory.js)가 이 네 값을 읽는다. */
var OFF_SETTINGS_DEFAULT = [
  ['재고일수_판매기준일수', 28, '재고일수 = 정상재고 ÷ 최근 N일 일평균 판매 — 그 N(일). 기간은 채널별 판매 최신 기준일에서 거꾸로 센다'],
  ['재고경보_과다일수', 90, '재고일수가 이 값보다 크면 과다 경보'],
  ['재고경보_결품위험일수', 14, '재고일수가 이 값보다 작으면 결품 위험 경보'],
  ['데이터지연_경고일수', 3, '채널의 판매·재고 최신 기준일이 오늘보다 이 일수보다 더 오래되면 경고 배지']
];

// 업로드시작월 = 포털 업로드로 판매(OUT)를 집계하기 시작한 달. 비어 있으면 업로드 없는 채널(OUT 실적은 입력·이관 값).
var OFF_UPLOAD_START_SEED = { himart: '2026-09', etland: '2026-09', emart: '2026-09', traders: '2026-09' };
/* 원천업태명  한 파일에 여러 채널이 섞인 포털(이마트: 업태명 이마트·트레이더스)에서 행의 업태명 → 이 채널. 쉼표로 여러 개
   점포명접두어 업태명이 없는 파일(이마트 재고)에서 점포마스터에도 없는 점포를 점포명 앞부분으로 가를 때. 쉼표로 여러 개
   코드체계채널 코드매핑을 빌려 쓸 채널 — 트레이더스는 이마트와 같은 상품코드라 이마트 매핑을 그대로 쓴다(빈칸 = 자기 자신) */
var OFF_CHANNEL_SEED = [
  ['himart', '하이마트', '양판점', 'Y', 1, '2026-09', '', '', 'himart', 0, 'input', ''],
  ['etland', '전자랜드', '양판점', 'Y', 2, '2026-09', '', '', 'etland', -1, 'input', ''],
  ['emart', '이마트', '할인점', 'Y', 3, '2026-09', '이마트', 'EM', 'emart', -1, 'input', ''],
  ['traders', '트레이더스', '할인점', 'Y', 4, '2026-09', '트레이더스', 'TR', 'emart', -1, 'input', ''],
  ['shinsegae', '신세계백화점', '백화점', 'Y', 5, '2026-09', '', '', 'erp', 0, 'upload', '신세계'],
  ['theablen', '디에이블앤', '폐쇄몰', 'Y', 6, '2026-09', '', '', 'erp', 0, 'upload', ''],
  ['special', '기타 특판', '특판', 'N', 7, '', '', '', 'special', 0, 'input', ''],
  ['lotte_dept', '롯데백화점', '백화점', 'Y', 8, '2026-09', '', '', 'erp', 0, 'upload', ''],
  ['workshop8', '워크숍에이트', '폐쇄몰', 'Y', 9, '2026-09', '', '', 'erp', 0, 'upload', ''],
  ['dapara', '다파라솔루션', '렌탈', 'Y', 10, '2026-09', '', '', 'erp', 0, 'upload', '']
];
/* 채널대분류(2026-10-02) — 채널을 묶는 단계. 화면의 채널 목록·필터·소계와 파트 홈 채널군(apps-script-home.js OFF_CHANNEL_GROUPS)이 이 값을 쓴다.
   이 순서가 곧 화면 순서다(양판점 → 할인점 → 백화점 → 폐쇄몰 → 렌탈 → 특판). 목록 밖 값은 맨 뒤(파트 홈은 오프라인으로 더하고 경고).
   옛 '유형' 열은 setup이 한 번 채널대분류로 바꾼다 — 아는 채널은 위 초기값, 모르는 채널은 옛 이름을 바꿔서(OFF_CHANNEL_TYPE_RENAME).
   채널별칭 = 다른 이름(쉼표로 여러 개) — 진행현황·납품가 이관이 원본 채널명을 채널에 연결할 때 채널명과 함께 본다.
   채널별칭 열을 붙이는 이번 한 번만 신세계 채널명을 '신세계백화점'으로 바꾸고 별칭 '신세계'를 넣는다(OFF_CHANNEL_RENAME) — 이후 사람이 고친 값은 그대로.
   channel_id는 바꾸지 않는다(판매원장·재고·목표·매핑이 channel_id로 이어진다). */
var OFF_CHANNEL_CATEGORIES = ['양판점', '할인점', '백화점', '폐쇄몰', '렌탈', '특판'];
var OFF_CHANNEL_TYPE_RENAME = { '전문점': '양판점', '창고형': '할인점' };
var OFF_CHANNEL_RENAME = { shinsegae: { from: '신세계', to: '신세계백화점', alias: '신세계' } };
function _offChannelCatRank(cat) { var i = OFF_CHANNEL_CATEGORIES.indexOf(String(cat == null ? '' : cat).trim()); return i < 0 ? 99 : i; }
function _offChannelAliases(r) { return _offSplitList(r ? r[11] : ''); }
/* ERP 매출이익리스트 채널(2026-09-30) — 백화점·폐쇄몰·렌탈. 우리 창고에서 고객에게 직접 출고한 기록이라 그 파일의 판매가 곧
   우리 매출(IN)이자 판매(OUT)다. 코드체계채널 erp = ERP 상품코드 매핑 한 벌을 다섯 채널이 같이 쓴다(erp는 채널이 아니라 코드체계 이름).
   IN실적원천 upload = 업로드시작월부터 IN 실적도 판매원장에서 집계(목표 관리의 IN 실적 칸은 읽기 전용), input = 목표 관리 입력·이관 값.
   IN실적원천 열을 붙이는 이번 한 번만 있던 신세계·디에이블앤을 위 값(활성 Y·업로드시작월 2026-09·erp·upload)으로 켠다 — 이후 사람이 고친 값은 그대로.
   채널마스터에 없는 ERP 채널(롯데백화점·워크숍에이트·다파라솔루션)은 setup이 돌 때마다 없으면 덧붙인다. */
var OFF_ERP_CODE_SYSTEM = 'erp';
var OFF_ERP_CHANNELS = ['shinsegae', 'theablen', 'lotte_dept', 'workshop8', 'dapara'];
// 채널이 아닌 코드체계의 표시 이름 — 코드 매핑 화면·미매칭 목록의 채널 칸(offline_getMasters codeSystems)
var OFF_CODE_SYSTEM_NAMES = { erp: 'ERP (백화점·폐쇄몰·렌탈 공통)' };
/* 거래처매핑 초기값 — ERP 거래처코드 → 채널. 거래처명은 법인 표기((주)·주식회사·옛 이름)를 뺀 이름이고 점포마스터 점포명이 된다.
   거래처매핑 탭에 데이터 행이 하나도 없을 때만 채운다. 업로드 미리보기에서 채널을 고른 새 거래처는 반영 때 덧붙는다. */
var OFF_CUSTOMER_SEED = [
  ['00476', '신세계(센텀시티점)', 'shinsegae', '초기값'], ['00440', '신세계(강남점)', 'shinsegae', '초기값'], ['00580', '대전신세계', 'shinsegae', '초기값'],
  ['00608', '신세계 동대구복합환승센터', 'shinsegae', '초기값'], ['00619', '신세계(청담점)', 'shinsegae', '초기값'],
  ['00604', '롯데백화점 본점', 'lotte_dept', '초기값'], ['00474', '디에이블앤', 'theablen', '초기값'],
  ['00260', '워크숍에이트', 'workshop8', '초기값'], ['00261', '다파라솔루션', 'dapara', '초기값']
];
function _offInSourceOf(r) { return String((r && r[10]) == null ? '' : r[10]).trim() === 'upload' ? 'upload' : 'input'; }
// 원천업태명·점포명접두어·코드체계채널 초기값(열을 덧붙일 때만 — 이미 있는 값은 덮어쓰지 않음)
var OFF_CHANNEL_SPLIT_SEED = { emart: ['이마트', 'EM', 'emart'], traders: ['트레이더스', 'TR', 'emart'] };
/* 재고기준일오프셋(일) — 재고 기준일 = 파일명 날짜 + 이 값. 전자랜드 현재고·이마트 재고현황_상세(트레이더스 포함)는
   받은 날의 전일 마감 재고라 −1, 하이마트 판매재고현황은 파일명 날짜가 곧 기준일(0). 열을 덧붙일 때만 채운다(없는 채널은 0).
   스냅샷형 파일에만 쓴다 — 하이마트(himart 유형)는 같은 기준일로 누적 판매 차이도 계산하므로 이 값과 무관하게 파일명 날짜 그대로. */
var OFF_STOCK_OFFSET_SEED = { himart: 0, etland: -1, emart: -1, traders: -1 };
// 업로드로그 경고 열에 남기는 재고 기준일 표시 — offline_fixStockDates는 이 표시가 있는 업로드(이미 새 기준)를 옮기지 않는다
var OFF_STOCK_BASIS_NOTE = '재고 기준일 ';
var OFF_STOCK_FIX_KEY = '재고기준일보정_완료';
/* 점포유형 — 점포마스터 행마다 '온라인' / '오프라인'. 채널 상세 판매 분석의 온라인/오프라인 판매량이 이 값을 쓴다(사람이 시트에서 고칠 수 있다).
   열을 덧붙일 때와 업로드로 새 점포가 생길 때만 이 규칙(점포명·지역에 온라인·인터넷·e몰·이몰·쇼핑몰·(ON))으로 채운다 — 있는 값은 덮어쓰지 않는다.
   2026-09-29 점포마스터: 전자랜드 '온라인쇼핑몰'(지역 온라인), 하이마트 '○○(ON)HM' 77곳(점포코드 끝 O — 같은 매장의 일반 점포는 끝 E).
   '롯데몰'처럼 몰 안의 실매장은 걸리지 않게 '몰' 한 글자는 규칙에 넣지 않는다. */
var OFF_ONLINE_STORE_RE = /온라인|인터넷|e\s*몰|이몰|쇼핑몰|\(ON\)/i;
function _offStoreTypeOf(name, region) { return OFF_ONLINE_STORE_RE.test(String(name || '')) || OFF_ONLINE_STORE_RE.test(String(region || '')) ? '온라인' : '오프라인'; }

// 하이마트 누적 스냅샷 보관 기간 — 차이 계산에는 "바로 이전 스냅샷"만 필요하다
var OFF_SNAPSHOT_KEEP_DAYS = 45;
var OFF_CACHE_TTL_SEC = 300;
var OFF_CACHE_KEYS = ['offline:masters', 'offline:status'];
// 공구 저장(_withStructLock)은 ScriptLock을 5초만 기다린다. 업로드가 그 락을 수십 초 잡으면 공구 저장이
// 실패하므로, 오프라인 쓰기는 **다른 락(DocumentLock)**으로 직렬화한다.
var OFF_LOCK_WAIT_MS = 30000;
var OFF_KEY_SEP = '\u0001';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 시트 준비 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/* 편집기에서 직접 실행. 탭이 없으면 헤더와 함께 만들고, 있으면 헤더만 검증한다(데이터는 건드리지 않음).
   여러 번 실행해도 안전하다. 반환값(과 실행 로그)에 만든 탭 / 확인한 탭 / 헤더가 다른 탭이 나온다.
   열이 뒤에 새로 붙은 탭(2-A: 채널마스터 업로드시작월)은 기존 헤더가 앞부분과 같고 뒤가 비어 있을 때만
   헤더를 덧붙이고 초기값을 채운다(extended). README 본문은 대시보드가 관리하는 설명이라 매번 새로 쓴다. */
function offline_setupSheets() {
  var ss = _offSS();
  var report = { created: [], verified: [], extended: [], mismatched: [], settingsAdded: [], channelsAdded: [], storesAdded: [], channelCategory: null, channelRenamed: [] };
  var ok = function (key) { return report.mismatched.every(function (m) { return m.tab !== OFF_TABS[key].name; }); };
  OFF_TAB_ORDER.forEach(function (key) {
    var def = OFF_TABS[key];
    var sheet = ss.getSheetByName(def.name);
    if (!sheet) {
      sheet = ss.insertSheet(def.name);
      _offFormatNewTab(sheet, def);
      report.created.push(def.name);
      if (key === 'readme') _offWriteBlock(sheet, def, 2, _offReadmeRows());
    } else {
      // 채널마스터 옛 '유형' 열 → 채널대분류(머리글이 '유형'일 때 한 번) — 아래 머리글 검증보다 먼저
      if (key === 'channel') report.channelCategory = _offMigrateChannelType(sheet, def);
      var W = def.headers.length;
      var actual = sheet.getRange(1, 1, 1, W).getValues()[0].map(function (v) { return String(v || '').trim(); });
      var n = 0;
      while (n < W && actual[n] === def.headers[n]) n++;
      var restBlank = actual.slice(n).every(function (v) { return v === ''; });
      if (n === W) report.verified.push(def.name);
      else if (n > 0 && restBlank) {
        var ext = _offExtendTab(sheet, def, n);
        report.extended.push({ tab: def.name, added: def.headers.slice(n) });
        if (ext && ext.renamed) report.channelRenamed = ext.renamed;
      } else report.mismatched.push({ tab: def.name, expected: def.headers, actual: actual });
      if (key === 'readme') {
        var prevRows = Math.max(0, sheet.getLastRow() - 1);
        _offWriteAll(sheet, def, _offReadmeRows(), prevRows);
      }
    }
    // 채널마스터 초기 데이터 — 데이터 행이 하나도 없을 때만(사람이 고친 값을 덮어쓰지 않는다)
    if (key === 'channel' && sheet.getLastRow() < 2) _offWriteBlock(sheet, def, 2, OFF_CHANNEL_SEED);
    // ERP 채널 중 채널마스터에 없는 것만 덧붙인다(있는 채널은 건드리지 않음)
    if (key === 'channel' && ok(key)) {
      var have0 = {};
      _offReadRows(sheet, def).forEach(function (r) { if (r[0]) have0[r[0]] = true; });
      var addCh = OFF_CHANNEL_SEED.filter(function (r) { return OFF_ERP_CHANNELS.indexOf(r[0]) >= 0 && !have0[r[0]]; });
      if (addCh.length) _offWriteBlock(sheet, def, sheet.getLastRow() + 1, addCh);
      report.channelsAdded = addCh.map(function (r) { return r[0]; });
    }
    // 거래처매핑 초기 데이터 — 데이터 행이 하나도 없을 때만
    if (key === 'customerMap' && ok(key) && sheet.getLastRow() < 2) _offWriteBlock(sheet, def, 2, OFF_CUSTOMER_SEED);
    // 설정 — 없는 키만 기본값으로 덧붙인다(사람이 고친 값·순서는 그대로)
    if (key === 'settings' && ok(key)) {
      var srows = _offReadRows(sheet, def), have = {};
      srows.forEach(function (r) { if (r[0]) have[r[0]] = true; });
      var add = OFF_SETTINGS_DEFAULT.filter(function (d) { return !have[d[0]]; });
      if (add.length) _offWriteBlock(sheet, def, sheet.getLastRow() + 1, add);
      report.settingsAdded = add.map(function (d) { return d[0]; });
    }
  });
  // 거래처 = 그 채널의 점포 — 거래처매핑의 거래처 중 점포마스터에 없는 것만 등록한다
  if (ok('channel') && ok('store') && ok('customerMap')) report.storesAdded = _offSeedCustomerStores(ss);
  _offInvalidateCache();
  Logger.log('[offline_setupSheets] ' + JSON.stringify(report));
  return report;
}

/* 재고 기준일 1회 보정 — 편집기에서 직접 1회 실행(offline_setupSheets로 채널마스터에 재고기준일오프셋 열을 붙인 뒤).
   이 보정 전에 올린 스냅샷형 재고는 파일명 날짜 그대로 저장돼 있다 → 채널 오프셋만큼 옮긴다(전자랜드·이마트·트레이더스 −1일).
     재고_채널일별·재고_점포최신  channel_id의 오프셋만큼 기준일을 옮긴다
     업로드로그                  스냅샷형 파일(전자랜드 현재고·이마트 재고현황_상세)의 기준일을 그 파일 채널(ft.channelId)의 오프셋만큼
   건드리지 않는 것: 판매원장, 하이마트(오프셋 0 · himart 유형), 이미 새 기준으로 올라온 업로드(업로드로그 경고에 "재고 기준일" 표시).
   옮긴 뒤 같은 (기준일, 채널)에 업로드가 둘 이상이면(옛 업로드를 옮긴 날짜에 새 업로드가 이미 있을 때) 업로드 시각이 늦은 업로드의 행만
   남긴다 — 스냅샷은 업로드 한 번이 그 날 그 채널의 재고 전체라, 코드별로 섞지 않고 업로드 단위로 고른다. 재고_점포최신은 채널마다
   가장 최근 기준일 한 벌만 남긴다(원래 규칙). 끝나면 설정 탭에 재고기준일보정_완료 = 1(설명에 시각·건수)을 적고, 이미 있으면 아무것도 하지 않는다. */
function offline_fixStockDates() {
  return _offWithLock(function () {
    var ss = _offSS();
    var sDef = OFF_TABS.settings, sSheet = _offSheet(ss, 'settings'), sRows = _offReadRows(sSheet, sDef), sPrev = sRows.length;
    for (var i = 0; i < sRows.length; i++) {
      if (sRows[i][0] === OFF_STOCK_FIX_KEY && Number(sRows[i][1])) {
        var done = { skipped: true, reason: '이미 보정했습니다 — ' + sRows[i][2] };
        Logger.log('[offline_fixStockDates] ' + JSON.stringify(done));
        return done;
      }
    }
    var chSheet = _offSheet(ss, 'channel');
    if (String(chSheet.getRange(1, 10).getValues()[0][0] || '').trim() !== '재고기준일오프셋') {
      throw new Error('채널마스터에 재고기준일오프셋 열이 없습니다 — 편집기에서 offline_setupSheets를 먼저 실행하세요.');
    }
    var off = {};
    _offReadRows(chSheet, OFF_TABS.channel).forEach(function (r) { var o = _offStockOffsetOf(r); if (r[0] && o) off[r[0]] = o; });
    if (!Object.keys(off).length) {
      var none = { skipped: true, reason: '재고기준일오프셋이 0이 아닌 채널이 없어 옮길 것이 없습니다(완료 표시도 남기지 않음).' };
      Logger.log('[offline_fixStockDates] ' + JSON.stringify(none));
      return none;
    }
    var lDef = OFF_TABS.uploadLog, lSheet = _offSheet(ss, 'uploadLog'), logs = _offReadRows(lSheet, lDef);
    var newBasis = {}, logAt = {};
    // 업로드 시각이 같으면 로그의 뒤쪽 행(나중에 쓴 것)이 늦은 업로드
    logs.forEach(function (r, i) {
      if (!r[0]) return;
      logAt[r[0]] = String(r[1] || '') + '#' + ('000000' + i).slice(-6);
      if (String(r[10] || '').indexOf(OFF_STOCK_BASIS_NOTE) >= 0) newBasis[r[0]] = true;
    });
    var report = { channels: off, stockDaily: 0, stockStore: 0, uploadLog: 0, duplicates: [], storeDropped: 0 };
    // 1) 재고_채널일별 — 옮기고, 같은 (기준일, 채널)에 업로드가 둘 이상이면 늦은 업로드만
    var dDef = OFF_TABS.stockDaily, dSheet = _offSheet(ss, 'stockDaily'), dRows = _offReadRows(dSheet, dDef), dPrev = dRows.length;
    dRows.forEach(function (r) {
      var o = off[r[1]];
      if (!o || newBasis[r[6]] || !_offIsDate(r[0])) return;
      r[0] = _offAddDays(r[0], o); report.stockDaily++;
    });
    var ups = {};
    dRows.forEach(function (r) { var k = r[0] + OFF_KEY_SEP + r[1]; (ups[k] = ups[k] || {})[r[6]] = true; });
    var keepUp = {};
    Object.keys(ups).forEach(function (k) {
      var list = Object.keys(ups[k]);
      if (list.length < 2) return;
      list.sort(function (a, b) { var x = logAt[a] || '', y = logAt[b] || ''; return x < y ? -1 : x > y ? 1 : 0; });
      keepUp[k] = list[list.length - 1];
      var p = k.split(OFF_KEY_SEP);
      report.duplicates.push({ date: p[0], channelId: p[1], kept: keepUp[k], dropped: list.slice(0, -1) });
    });
    var dKept = dRows.filter(function (r) { var k = r[0] + OFF_KEY_SEP + r[1]; return !keepUp[k] || r[6] === keepUp[k]; });
    report.duplicateRows = dRows.length - dKept.length;
    // 2) 재고_점포최신 — 옮기고, 채널마다 가장 최근 기준일 한 벌만
    var tDef = OFF_TABS.stockStore, tSheet = _offSheet(ss, 'stockStore'), tRows = _offReadRows(tSheet, tDef), tPrev = tRows.length;
    tRows.forEach(function (r) {
      var o = off[r[1]];
      if (!o || newBasis[r[9]] || !_offIsDate(r[0])) return;
      r[0] = _offAddDays(r[0], o); report.stockStore++;
    });
    var latest = {};
    tRows.forEach(function (r) { if (_offIsDate(r[0]) && r[0] > (latest[r[1]] || '')) latest[r[1]] = r[0]; });
    var tKept = tRows.filter(function (r) { return !_offIsDate(r[0]) || r[0] === latest[r[1]]; });
    report.storeDropped = tRows.length - tKept.length;
    // 3) 업로드로그 — 스냅샷형 파일의 기준일
    logs.forEach(function (r) {
      var ft = OFF_FILE_TYPES[r[4]], o = ft && ft.kind === 'snapshot' ? off[ft.channelId] : 0;
      if (!o || newBasis[r[0]] || !_offIsDate(r[6])) return;
      r[6] = _offAddDays(r[6], o); report.uploadLog++;
    });
    _offWriteAll(dSheet, dDef, dKept, dPrev);
    _offWriteAll(tSheet, tDef, tKept, tPrev);
    _offWriteAll(lSheet, lDef, logs, logs.length);
    var at = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    var desc = at + ' 보정 — 재고_채널일별 ' + report.stockDaily + '행 · 재고_점포최신 ' + report.stockStore + '행 · 업로드로그 ' + report.uploadLog + '행' +
      (report.duplicateRows ? ' · 중복 정리 ' + report.duplicateRows + '행' : '') + (report.storeDropped ? ' · 점포최신 옛 기준일 ' + report.storeDropped + '행' : '') + ' (' + Object.keys(off).join('·') + ')';
    var hit = null;
    sRows.forEach(function (r) { if (r[0] === OFF_STOCK_FIX_KEY) hit = r; });
    if (!hit) { hit = [OFF_STOCK_FIX_KEY, '', '']; sRows.push(hit); }
    hit[1] = 1; hit[2] = desc;
    _offWriteAll(sSheet, sDef, sRows, sPrev);
    _offInvalidateCache();
    report.done = true; report.note = desc;
    Logger.log('[offline_fixStockDates] ' + JSON.stringify(report));
    return report;
  });
}

/* 채널마스터 '유형' → '채널대분류' — C열 머리글이 '유형'일 때만(한 번) 머리글을 바꾸고 값을 옮긴다(채널마스터 탭이 이미 있을 때).
   새 값 = 채널 초기값(OFF_CHANNEL_SEED)의 채널대분류, 초기값에 없는 채널은 옛 유형 이름을 바꿔서(전문점 → 양판점, 창고형 → 할인점, 그 외 그대로).
   반환 = 옮긴 결과 [{ channelId, from, to }] (setup 보고) | 이미 옮겼으면 null */
function _offMigrateChannelType(sheet, def) {
  var head = sheet.getRange(1, 3, 1, 1);
  if (String(head.getValues()[0][0] || '').trim() !== '유형') return null;
  head.setValues([[def.headers[2]]]);
  var seed = {};
  OFF_CHANNEL_SEED.forEach(function (r) { seed[r[0]] = r[2]; });
  var rows = _offReadRows(sheet, def), out = [];
  rows.forEach(function (r) {
    if (!r[0]) return;
    var from = r[2], to = seed[r[0]] || OFF_CHANNEL_TYPE_RENAME[from] || from;
    r[2] = to;
    out.push({ channelId: r[0], from: from, to: to });
  });
  _offWriteAll(sheet, def, rows, rows.length);
  return out;
}

// 기존 탭 뒤에 새 열(from부터)을 붙인다 — 헤더·텍스트 서식, 채널마스터면 새 열의 초기값.
// 반환 = 채널마스터에서 채널명을 바꿨으면 { renamed: [{ channelId, from, to }] } (setup 보고)
function _offExtendTab(sheet, def, from) {
  var W = def.headers.length, out = {};
  sheet.getRange(1, from + 1, 1, W - from).setValues([def.headers.slice(from)]).setFontWeight('bold');
  def.text.forEach(function (c) { if (c >= from) sheet.getRange(1, c + 1, sheet.getMaxRows(), 1).setNumberFormat('@'); });
  if (def === OFF_TABS.channel) {
    var rows = _offReadRows(sheet, def);
    // 업로드시작월(2-A) — 그 열을 이번에 붙일 때만
    if (from <= 5) rows.forEach(function (r) { if (!r[5] && OFF_UPLOAD_START_SEED[r[0]]) r[5] = OFF_UPLOAD_START_SEED[r[0]]; });
    // 트레이더스 분리 — 원천업태명·점포명접두어·코드체계채널을 붙이는 이번 한 번만 트레이더스를 활성 + 업로드시작월 2026-09로 켠다
    if (from <= 6) rows.forEach(function (r) {
      var sd = OFF_CHANNEL_SPLIT_SEED[r[0]];
      if (sd) { if (!r[6]) r[6] = sd[0]; if (!r[7]) r[7] = sd[1]; if (!r[8]) r[8] = sd[2]; }
      if (!r[8]) r[8] = r[0];
      if (r[0] === 'traders') { r[3] = 'Y'; if (!r[5]) r[5] = OFF_UPLOAD_START_SEED.traders; }
    });
    // 재고기준일오프셋 — 그 열을 이번에 붙일 때만(사람이 고친 값은 덮어쓰지 않음)
    if (from <= 9) rows.forEach(function (r) { if (r[9] === '' || r[9] == null) r[9] = OFF_STOCK_OFFSET_SEED[r[0]] || 0; });
    // IN실적원천 — 그 열을 붙이는 이번 한 번만 ERP 채널(신세계·디에이블앤)을 켜고 코드체계 erp·upload로, 나머지는 input
    if (from <= 10) rows.forEach(function (r) {
      if (!r[0]) return;
      var seed = null;
      OFF_CHANNEL_SEED.forEach(function (x) { if (x[0] === r[0] && OFF_ERP_CHANNELS.indexOf(x[0]) >= 0) seed = x; });
      if (!seed) { if (!r[10]) r[10] = 'input'; return; }
      r[3] = seed[3]; if (!r[5]) r[5] = seed[5]; r[8] = seed[8]; r[10] = seed[10];
    });
    // 채널별칭 — 그 열을 붙이는 이번 한 번만 채널명 변경(신세계 → 신세계백화점) + 옛 이름을 별칭으로(진행현황 재이관이 그대로 연결되게)
    if (from <= 11) {
      out.renamed = [];
      rows.forEach(function (r) {
        var rn = OFF_CHANNEL_RENAME[r[0]];
        if (!rn) return;
        if (r[1] === rn.from) { r[1] = rn.to; out.renamed.push({ channelId: r[0], from: rn.from, to: rn.to }); }
        if (_offChannelAliases(r).indexOf(rn.alias) < 0) r[11] = _offChannelAliases(r).concat([rn.alias]).join(', ');
      });
    }
    _offWriteAll(sheet, def, rows, rows.length);
  }
  // 목표실적_월 대분류 — 기존(모델 단위) 행은 품목군에서 채운다(OFFLINE_LINE_CATEGORY: apps-script-offline-targets.js)
  // 점포유형 — 기존 점포는 이름·지역 규칙으로 채운다
  if (def === OFF_TABS.store) {
    var srows = _offReadRows(sheet, def);
    srows.forEach(function (r) { if (r[0] && !r[6]) r[6] = _offStoreTypeOf(r[2], r[3]); });
    _offWriteAll(sheet, def, srows, srows.length);
  }
  if (def === OFF_TABS.targets) {
    var trows = _offReadRows(sheet, def);
    trows.forEach(function (r) { if (!r[11] && r[2]) r[11] = OFFLINE_LINE_CATEGORY[r[2]] || ''; });
    _offWriteAll(sheet, def, trows, trows.length);
  }
  return out;
}

/* 거래처매핑의 거래처를 그 채널의 점포로 등록 — 점포마스터에 (코드체계, 거래처코드)가 없는 것만. 점포명 = 거래처매핑 거래처명.
   있는 점포는 건드리지 않는다(최근확인일은 업로드가 갱신). 반환 = 추가한 'channel_id:거래처코드' 목록 */
function _offSeedCustomerStores(ss) {
  var chRows = _offReadRows(_offSheet(ss, 'channel'), OFF_TABS.channel), cs = _offCodeSystem(chRows), chIds = {};
  chRows.forEach(function (r) { if (r[0]) chIds[r[0]] = true; });
  var def = OFF_TABS.store, sheet = _offSheet(ss, 'store'), have = {};
  _offReadRows(sheet, def).forEach(function (r) { if (r[0] && r[1]) have[cs(r[0]) + OFF_KEY_SEP + r[1]] = true; });
  var today = _offToday(), add = [];
  _offReadRows(_offSheet(ss, 'customerMap'), OFF_TABS.customerMap).forEach(function (c) {
    var code = c[0], ch = c[2], k = cs(ch) + OFF_KEY_SEP + code;
    if (!code || !chIds[ch] || have[k]) return;
    have[k] = true;
    add.push([ch, code, c[1] || code, '', today, today, _offStoreTypeOf(c[1], '')]);
  });
  if (add.length) _offWriteBlock(sheet, def, sheet.getLastRow() + 1, add);
  return add.map(function (r) { return r[0] + ':' + r[1]; });
}

function _offFormatNewTab(sheet, def) {
  var W = def.headers.length;
  sheet.getRange(1, 1, 1, W).setValues([def.headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  _offTextRuns(def).forEach(function (run) {
    sheet.getRange(1, run[0] + 1, sheet.getMaxRows(), run[1]).setNumberFormat('@');
  });
}

function _offReadmeRows() {
  return [
    ['⚠ 원장 탭은 직접 수정 금지', '판매원장·재고_채널일별·재고_점포최신·하이마트_누적스냅샷·업로드로그는 대시보드(데이터 업로드)에서만 반영한다. 손으로 고치면 다음 업로드가 그 범위를 다시 덮어쓴다.'],
    ['제품마스터', '표준 SKU. sku_id(SKU-0001)는 자동 부여. 품목군은 대시보드 품목 분류 상수의 값만 허용. 대시보드 코드 매핑 화면에서 만든다.'],
    ['채널마스터', '채널 목록. channel_id는 바꾸지 말 것(판매원장·재고·목표·매핑이 이 값으로 이어진다). 채널대분류 = 양판점·할인점·백화점·폐쇄몰·렌탈·특판 중 하나 — 화면의 채널 묶음·필터·소계 순서이고, 파트 홈 채널군은 양판점·할인점·백화점 = 오프라인, 폐쇄몰·렌탈·특판 = 특수. 채널별칭 = 채널의 다른 이름(쉼표로 여러 개, 예: 신세계백화점의 "신세계") — 진행현황·납품가 이관이 원본 채널명을 연결할 때 채널명과 함께 본다. 업로드시작월(YYYY-MM) = 포털 업로드로 판매(OUT)를 집계하기 시작한 달 — 비어 있으면 업로드 없는 채널이라 OUT 실적은 목표 관리에서 입력·이관한 값을 쓴다. 활성=N 채널은 목표 관리 화면에 데이터가 있을 때만 보인다. 원천업태명 = 한 파일에 여러 채널이 섞인 포털 파일(이마트 점포별 일별 매출)의 업태명 값(쉼표로 여러 개). 점포명접두어 = 업태명이 없는 파일(이마트 재고)에서 점포마스터에 없는 점포를 가를 점포명 앞부분(쉼표로 여러 개). 코드체계채널 = 코드매핑을 빌려 쓸 채널(트레이더스 = emart, 빈칸 = 자기 자신 — ERP 매출이익리스트 채널 신세계백화점·롯데백화점·디에이블앤·워크숍에이트·다파라솔루션 = erp, ERP 상품코드 매핑 한 벌을 같이 씀). 재고기준일오프셋(일) = 재고 파일의 기준일 = 파일명 날짜 + 이 값(전자랜드·이마트·트레이더스 −1 = 받은 날의 전일 마감 재고, 하이마트 0). 스냅샷형 재고 파일에만 쓰인다. IN실적원천 = upload면 업로드시작월부터 IN 실적도 판매원장에서 집계(우리 창고에서 직접 출고하는 ERP 채널 — 판매가 곧 매출, 목표 관리의 IN 실적 칸은 읽기 전용), input이면 목표 관리 입력·이관 값.'],
    ['코드매핑', '(channel_id, 원본코드) → sku_id·재고구분(정상/전시/리퍼). 한 SKU에 여러 코드 가능. sku_id가 빈 행은 비활성화된 매핑.'],
    ['점포마스터', '업로드 때 자동 추가·갱신. 지역 = 지부·지사. 점포유형 = 온라인/오프라인 — 새 점포는 점포명·지역 규칙(온라인·인터넷·e몰·쇼핑몰·(ON))으로 채우고, 사람이 고친 값은 그대로 둔다. 채널 상세 판매 분석의 온라인/오프라인 판매량이 이 값을 쓴다.'],
    ['판매원장', '판매 수량. 단위 day = 하루치(기간시작=기간종료), period = 여러 날 합. 원본코드만 저장하고 SKU는 읽을 때 코드매핑으로 해석. 설치완료수량은 하이마트만. 금액·수수료는 파일에 금액이 있는 채널만(ERP 매출이익리스트 — 원, 반품·취소는 음수) — 금액이 있는 행은 그 값, 빈 행은 수량 × 단가마스터 공급가로 금액을 계산한다.'],
    ['재고_채널일별', '채널 전체 합계 재고, 기준일마다 누적(이력).'],
    ['재고_점포최신', '채널별 최신 기준일 1벌만 유지(0 재고 포함). 당월입고·당월판매는 파일에 있을 때만.'],
    ['하이마트_누적스냅샷', '하이마트 당월 누적 판매 스냅샷(판매 값이 있는 행만). 일별 판매 = 이웃 스냅샷의 차이. 최근 45일만 보관.'],
    ['업로드로그', '업로드 1건 = 1행. 반영 행수·미매칭 코드 수·경고.'],
    ['미매칭코드', '코드매핑이 없는 원본코드. 매핑하면 목록에서 빠진다.'],
    ['목표실적_월', '채널×품목군×모델×월 목표·실적(구분 IN=Sell-in, OUT=Sell-out). 출처 input = 대시보드 목표 관리에서 입력(이관이 덮어쓰지 않음), migration = 기존 진행현황에서 이관. OUT 실적은 업로드시작월 이전 달·업로드 없는 채널만 쓰고, 그 뒤로는 판매원장에서 집계한다. 대분류 열: 모델 단위 행은 대분류·품목군·모델 모두, 대분류 단위 행(모델 구분이 없는 과거 수치 — 예: 진행현황의 "건조기" 행)은 대분류만 채운다.'],
    ['단가마스터', '채널×품목군×모델 공급가 이력. 금액 = 수량 × 그 달 1일 기준 가장 최근 적용시작일의 공급가.'],
    ['이관로그', '기존 스프레드시트(진행현황·납품가 수수료) 이관 1회 = 1행. 대시보드에서 단가 행을 삭제한 기록(대상 "단가 삭제")도 여기에 남는다.'],
    ['설정', '재고 지표 기준값(키-값). 재고일수_판매기준일수·재고경보_과다일수·재고경보_결품위험일수·데이터지연_경고일수. 대시보드 재고 현황의 설정(관리자)에서 고친다 — 키 이름은 바꾸지 말 것.'],
    ['공구목표_월', '공동구매 월 목표(벤더×품목군×모델, 목표수량·목표금액 — 원, VAT 포함). 출처 input = 대시보드 목표 관리 [공구 목표]에서 입력(이관이 덮어쓰지 않음), migration = 기존 \'공동구매 26년 목표\' 탭에서 이관. 파트 홈의 파트 목표 = 오프라인 IN 목표 금액 + 이 탭의 목표금액.'],
    ['거래처매핑', 'ERP 매출이익리스트의 거래처코드 → channel_id(코드체계 erp 채널만). 거래처 = 그 채널의 점포(점포마스터 점포코드 = 거래처코드, 점포명 = 이 탭의 거래처명). 업로드 미리보기에서 채널을 고른 새 거래처는 반영 때 여기에 덧붙는다. 채널을 바꾸면 다음 업로드부터 그 채널로 들어간다.']
  ];
}

/* 설정 탭 → { 키: 값 } — 탭이 없거나(setup 재실행 전) 값이 비었거나 양수가 아니면 기본값 */
function _offSettingsFrom(rows) {
  var got = {};
  (rows || []).forEach(function (r) { if (r[0]) got[r[0]] = r[1]; });
  var out = {};
  OFF_SETTINGS_DEFAULT.forEach(function (d) {
    var v = Number(got[d[0]]);
    out[d[0]] = (got[d[0]] !== '' && got[d[0]] != null && isFinite(v) && v > 0) ? v : d[1];
  });
  return out;
}
function _offReadSettings(ss) {
  var sheet = ss.getSheetByName(OFF_TABS.settings.name);
  return _offSettingsFrom(sheet ? _offReadRows(sheet, OFF_TABS.settings) : []);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 시트 입출력 헬퍼 (탭마다 한 번에 읽고 한 번에 쓴다 — 행 단위 쓰기 금지) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _offSS() {
  var id = PropertiesService.getScriptProperties().getProperty(OFFLINE_SHEET_ID_PROP);
  if (!id) throw new Error('Script Properties에 ' + OFFLINE_SHEET_ID_PROP + ' 가 없습니다 — 오프라인 스프레드시트 ID를 등록하세요.');
  return SpreadsheetApp.openById(id);
}

function _offSheet(ss, key) {
  var sheet = ss.getSheetByName(OFF_TABS[key].name);
  if (!sheet) throw new Error('오프라인 시트에 "' + OFF_TABS[key].name + '" 탭이 없습니다 — 편집기에서 offline_setupSheets를 먼저 실행하세요.');
  return sheet;
}

// 텍스트 열 인덱스를 연속 구간 [시작, 개수]로 묶는다 — 서식 지정 호출 수를 줄이려고
function _offTextRuns(def) {
  var runs = [];
  def.text.forEach(function (c) {
    var last = runs[runs.length - 1];
    if (last && last[0] + last[1] === c) last[1]++;
    else runs.push([c, 1]);
  });
  return runs;
}

function _offIsTextCol(def) {
  var t = {};
  def.text.forEach(function (c) { t[c] = true; });
  return t;
}

function _offStr(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd');
  return v == null ? '' : String(v).trim();
}

// 데이터 행 전체 → 2차원 배열. 텍스트 열은 문자열로, 숫자 열은 숫자(빈칸은 '' 유지 — '없음'과 0을 구분)
function _offReadRows(sheet, def) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var W = def.headers.length;
  var isText = _offIsTextCol(def);
  return sheet.getRange(2, 1, last - 1, W).getValues().map(function (r) {
    var o = [];
    for (var c = 0; c < W; c++) {
      var v = r[c];
      if (isText[c]) o.push(_offStr(v));
      else o.push(v === '' || v == null ? '' : (Number(v) || 0));
    }
    return o;
  });
}

function _offBlankRow(r) {
  for (var i = 0; i < r.length; i++) if (r[i] !== '' && r[i] != null) return false;
  return true;
}

// startRow(1-based)부터 rows를 한 번에 쓴다. 텍스트 열은 먼저 '@' 서식을 걸고 문자열로 넣는다.
function _offWriteBlock(sheet, def, startRow, rows) {
  if (!rows.length) return;
  var W = def.headers.length;
  var need = startRow + rows.length - 1;
  var max = sheet.getMaxRows();
  if (need > max) sheet.insertRowsAfter(max, need - max);
  var isText = _offIsTextCol(def);
  var out = rows.map(function (r) {
    var o = [];
    for (var c = 0; c < W; c++) {
      var v = r[c];
      o.push(v == null ? '' : (isText[c] ? String(v) : v));
    }
    return o;
  });
  _offTextRuns(def).forEach(function (run) {
    sheet.getRange(startRow, run[0] + 1, rows.length, run[1]).setNumberFormat('@');
  });
  sheet.getRange(startRow, 1, rows.length, W).setValues(out);
}

// 데이터 영역 전체를 rows로 바꾼다(작은 마스터 탭용). prevCount = 기존 데이터 행 수
function _offWriteAll(sheet, def, rows, prevCount) {
  _offWriteBlock(sheet, def, 2, rows);
  if (prevCount > rows.length) sheet.getRange(2 + rows.length, 1, prevCount - rows.length, def.headers.length).clearContent();
}

/* 원장 교체 — keep(row)가 false인 기존 행을 지우고 newRows를 뒤에 붙인다.
   전체를 다시 쓰지 않고 **처음으로 지워지는 행부터 끝까지만** 다시 쓴다. 업로드는 대개 최근 날짜라
   지워지는 행이 뒤쪽에 몰려 있어서, 원장이 커져도 쓰는 양은 거의 늘지 않는다.
   결과는 항상 "keep을 통과한 기존 행(원래 순서) + newRows"라, 같은 입력을 몇 번 넣어도 같다.
   완전히 빈 행(사람이 지운 흔적)은 이 기회에 같이 걷어낸다. */
function _offReplaceRows(sheet, def, oldRows, keep, newRows) {
  var ok = function (r) { return !_offBlankRow(r) && keep(r); };
  var first = 0;
  while (first < oldRows.length && ok(oldRows[first])) first++;
  var tail = [];
  for (var i = first; i < oldRows.length; i++) if (ok(oldRows[i])) tail.push(oldRows[i]);
  var removed = (oldRows.length - first) - tail.length;
  tail = tail.concat(newRows);
  var startRow = 2 + first;
  _offWriteBlock(sheet, def, startRow, tail);
  var oldTail = oldRows.length - first;
  if (oldTail > tail.length) sheet.getRange(startRow + tail.length, 1, oldTail - tail.length, def.headers.length).clearContent();
  return { removed: removed, added: newRows.length };
}

// ── 날짜 (모두 'YYYY-MM-DD' 문자열, 타임존 영향 없는 UTC 산술) ──
function _offToday() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'); }
function _offIsDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function _offAddDays(s, n) {
  var d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10) + n));
  return d.getUTCFullYear() + '-' + _pad(d.getUTCMonth() + 1) + '-' + _pad(d.getUTCDate());
}

// ── 락 / 캐시 ──
function _offWithLock(fn) {
  var lock = LockService.getDocumentLock() || LockService.getScriptLock();
  if (!lock.tryLock(OFF_LOCK_WAIT_MS)) throw new Error('다른 오프라인 반영이 진행 중입니다. 잠시 후 다시 시도해주세요.');
  try {
    var out = fn();
    SpreadsheetApp.flush(); // 락을 풀기 전에 반영을 끝낸다 — 다음 실행이 반쯤 쓰인 시트를 읽지 않게
    return out;
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

function _offInvalidateCache() {
  try {
    var cache = CacheService.getScriptCache();
    cache.removeAll(OFF_CACHE_KEYS.map(function (k) { return k + ':meta'; }));
    cache.put('offline:gen', String(Date.now()), 21600);
  }
  catch (e) { Logger.log('오프라인 캐시 무효화 실패 (무시): ' + e); }
}
// 조회 인자가 붙는 캐시(월별 집계 등)는 키를 다 알 수 없어서, 키에 "세대"를 넣고 무효화 때 세대를 바꾼다
function _offCacheGen() {
  try { return CacheService.getScriptCache().get('offline:gen') || '0'; } catch (e) { return '0'; }
}

/* 코드체계채널 — 코드매핑을 빌려 쓰는 채널(트레이더스 → emart)을 매핑의 주인 채널로 바꾼다.
   코드매핑·미매칭코드는 코드체계채널 기준 한 벌만 둔다(같은 이마트 상품코드가 트레이더스로 두 번 뜨지 않게).
   channelRows = 채널마스터 _offReadRows 행. 열이 없거나 빈칸이면 자기 자신 */
function _offCodeSystem(channelRows) {
  var m = {};
  (channelRows || []).forEach(function (r) { if (r[0]) m[r[0]] = String(r[8] == null ? '' : r[8]).trim() || r[0]; });
  return function (ch) { return m[ch] || ch; };
}
function _offCodeSystemOf(ss) { return _offCodeSystem(_offReadRows(_offSheet(ss, 'channel'), OFF_TABS.channel)); }
/* 채널이 아닌 코드체계(erp) — 여러 채널이 코드체계채널로 가리키지만 그 이름의 채널은 없다. 코드매핑·미매칭코드는 이 이름으로 쌓인다.
   → [{ id, name, channels[] }] (코드 매핑 화면의 그룹·채널 칸 표시용) */
function _offVirtualCodeSystems(channelRows) {
  var ids = {}, out = [], byId = {};
  (channelRows || []).forEach(function (r) { if (r[0]) ids[r[0]] = true; });
  (channelRows || []).forEach(function (r) {
    var c = String(r[8] == null ? '' : r[8]).trim();
    if (!r[0] || !c || ids[c]) return;
    if (!byId[c]) { byId[c] = { id: c, name: OFF_CODE_SYSTEM_NAMES[c] || c, channels: [] }; out.push(byId[c]); }
    byId[c].channels.push(r[0]);
  });
  return out;
}
/* 채널마스터 행의 재고기준일오프셋(일) — 열이 없거나(setup 전) 빈칸·정수가 아니면 0. ±7일까지만 받는다(잘못 적은 큰 값이 기준일을 멀리 보내지 않게) */
function _offStockOffsetOf(r) {
  var v = r ? r[9] : '';
  if (v === '' || v == null) return 0;
  var n = Number(v);
  return isFinite(n) && n === Math.round(n) && Math.abs(n) <= 7 ? n : 0;
}
function _offSplitList(v) { return String(v == null ? '' : v).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; }); }
/* split 파일 반영용 채널마스터 요약 — codeSys(코드체계채널), byBiz{원천업태명: 채널}, prefixes[{channelId, prefix}](긴 접두어 먼저) */
function _offChannelMeta(ss) {
  var rows = _offReadRows(_offSheet(ss, 'channel'), OFF_TABS.channel).filter(function (r) { return r[0]; });
  var byBiz = {}, prefixes = [];
  rows.forEach(function (r) {
    _offSplitList(r[6]).forEach(function (b) { byBiz[b] = r[0]; });
    _offSplitList(r[7]).forEach(function (x) { prefixes.push({ channelId: r[0], prefix: x }); });
  });
  prefixes.sort(function (a, b) { return b.prefix.length - a.prefix.length; });
  return { rows: rows, codeSys: _offCodeSystem(rows), byBiz: byBiz, prefixes: prefixes };
}

// 활성 매핑(sku_id가 있는 행)의 (코드체계채널, 원본코드) 집합
function _offMappedKeys(mappingRows, codeSys) {
  var cs = codeSys || function (c) { return c; };
  var set = {};
  mappingRows.forEach(function (r) { if (r[0] && r[1] && r[2]) set[cs(r[0]) + OFF_KEY_SEP + r[1]] = true; });
  return set;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 업로드 반영 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/* 파일 1개 단위.
   data.meta    = { fileName, fileType, channelId, baseDate(스냅샷형) | replaceStart·replaceEnd(기간 교체형), rawRowCount }
   data.records = { sales[], storeStock[], channelStock[], himart[], stores[], names{code: 상품명} }
                  (파서 출력 그대로 — src/features/offline/parsers.js 의 toUploadPayload) */
function _offUpload(data, auth) {
  var meta = data.meta || {}, rec = data.records || {};
  var ft = OFF_FILE_TYPES[meta.fileType];
  if (!ft) throw new Error('알 수 없는 파일 유형입니다: ' + meta.fileType);
  if (ft.blocked) throw new Error(ft.blocked);
  if (meta.channelId !== ft.channelId) throw new Error(meta.fileType + ' 파일의 채널은 ' + ft.channelId + ' 여야 합니다 (받은 값: ' + meta.channelId + ')');
  if (ft.kind === 'period') {
    if (!_offIsDate(meta.replaceStart) || !_offIsDate(meta.replaceEnd) || meta.replaceStart > meta.replaceEnd) {
      throw new Error('교체 기간이 올바르지 않습니다: ' + meta.replaceStart + ' ~ ' + meta.replaceEnd);
    }
  } else if (!_offIsDate(meta.baseDate)) {
    throw new Error('기준일이 올바르지 않습니다: ' + meta.baseDate);
  }
  _offValidateRecords(rec);

  return _offWithLock(function () {
    var ctx = {
      ss: _offSS(), today: _offToday(), warnings: [], applied: {}, email: (auth && auth.email) || '',
      uploadId: 'U' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 4),
      // split 파일 — 반영한 채널 목록(업로드로그 channel_id = 'emart,traders')과 점포코드 → 채널(점포마스터 기록용)
      channels: null, storeChannel: null
    };
    ctx.chMeta = _offChannelMeta(ctx.ss);
    if (ft.kind === 'snapshot') _offStockBasis(ctx, meta, ft);
    try {
      var range = {};
      if (ft.split === 'customer') range = _offApplyErpSales(ctx, meta, rec);
      else if (ft.kind === 'period') range = _offApplyPeriodSales(ctx, meta, rec, ft);
      else {
        range = _offApplyStock(ctx, meta, rec, ft);
        if (ft.kind === 'himart') range.himart = _offApplyHimart(ctx, meta, rec);
      }
      _offUpsertStores(ctx, meta.channelId, rec.stores || []);
      var unmatched = _offUpdateUnmatched(ctx, meta.channelId, _offCodesOf(rec));
      _offAppendLog(ctx, meta, auth, '성공', unmatched.length);
      _offInvalidateCache();
      return { success: true, uploadId: ctx.uploadId, applied: ctx.applied, replaceRange: range, unmatched: unmatched, warnings: ctx.warnings,
        channels: ctx.channels || [meta.channelId] };
    } catch (e) {
      // 실패도 로그에 남긴다(다음 업로드가 같은 범위를 교체하므로 재시도하면 복구된다)
      try { _offAppendLog(ctx, meta, auth, '실패: ' + String((e && e.message) || e).slice(0, 300), 0); } catch (e2) {}
      throw e;
    }
  });
}

function _offValidateRecords(rec) {
  function num(v, what) {
    if (v === '' || v == null) return;
    if (typeof v !== 'number' || !isFinite(v)) throw new Error(what + ' 값이 숫자가 아닙니다: ' + v);
  }
  function code(v, what) { if (typeof v !== 'string' || !v) throw new Error(what + '이(가) 비었습니다.'); }
  (rec.sales || []).forEach(function (r) {
    if (!_offIsDate(r.s) || !_offIsDate(r.e) || r.s > r.e) throw new Error('판매 레코드 기간이 올바르지 않습니다: ' + r.s + ' ~ ' + r.e);
    code(r.code, '판매 레코드 원본코드'); num(r.qty, '수량'); num(r.inst, '설치완료수량'); num(r.amt, '금액'); num(r.fee, '수수료');
  });
  (rec.storeStock || []).forEach(function (r) {
    code(r.code, '점포 재고 원본코드');
    ['stock', 'transit', 'reserved', 'monthIn', 'monthSale'].forEach(function (k) { num(r[k], '점포 재고 ' + k); });
  });
  (rec.channelStock || []).forEach(function (r) {
    code(r.code, '채널 재고 원본코드');
    ['stock', 'transit', 'reserved'].forEach(function (k) { num(r[k], '채널 재고 ' + k); });
  });
  (rec.himart || []).forEach(function (r) {
    code(r.code, '하이마트 원본코드');
    ['real', 'sale', 'week', 'day', 'stock'].forEach(function (k) { num(r[k], '하이마트 ' + k); });
  });
}

/* A. 기간 교체형 — 이 채널의 판매원장 중 교체 기간 안의 행을 지우고 새 행을 넣는다.
   split 'biz'(이마트 점포별 일별 매출) — 레코드의 업태명 → 채널마스터 원천업태명으로 채널(이마트·트레이더스)을 정하고,
   파일에 들어 있는 채널마다 교체 기간의 행을 점포 유무와 관계없이 전부 지운 뒤 넣는다(예전 점포 빈칸 합계 행도 이때 정리).
   채널마스터에 없는 업태명(또는 다른 코드체계 채널)의 행은 반영하지 않고 경고로 남긴다. */
function _offApplyPeriodSales(ctx, meta, rec, ft) {
  var ch = meta.channelId, s = meta.replaceStart, e = meta.replaceEnd;
  var split = ft && ft.split === 'biz', cm = ctx.chMeta;
  var rows = [], outside = 0, unknown = {}, byCh = {};
  var chOfBiz = function (biz) { var c = cm.byBiz[String(biz == null ? '' : biz).trim()]; return c && cm.codeSys(c) === cm.codeSys(ch) ? c : ''; };
  (rec.sales || []).forEach(function (r) {
    if (r.s < s || r.e > e) { outside++; return; } // 교체 범위 밖을 넣으면 재업로드 때 중복된다
    var rc = ch;
    if (split) {
      rc = chOfBiz(r.biz);
      if (!rc) { var b = String(r.biz == null ? '' : r.biz).trim() || '(빈칸)'; unknown[b] = (unknown[b] || 0) + 1; return; }
    }
    var qty = Number(r.qty) || 0;
    var inst = (r.inst === '' || r.inst == null) ? '' : (Number(r.inst) || 0);
    if (!qty && !inst) return;
    var o = byCh[rc] || (byCh[rc] = { rows: 0, qty: 0 });
    o.rows++; o.qty += qty;
    rows.push([r.s, r.e, r.s === r.e ? 'day' : 'period', rc, r.store || '', r.code, qty, inst, 'upload', ctx.uploadId]);
  });
  if (outside) ctx.warnings.push('교체 기간(' + s + '~' + e + ') 밖의 레코드 ' + outside + '건은 반영하지 않았습니다');
  var unk = Object.keys(unknown);
  if (unk.length) ctx.warnings.push('채널마스터 원천업태명에 없는 업태명 ' + unk.map(function (b) { return '"' + b + '" ' + unknown[b] + '건'; }).join(', ') + '은 반영을 보류했습니다 — 채널마스터 원천업태명을 확인하세요');
  var replace = {};
  if (split) Object.keys(byCh).forEach(function (c) { replace[c] = true; });
  else replace[ch] = true;
  var def = OFF_TABS.sales, sheet = _offSheet(ctx.ss, 'sales');
  var res = _offReplaceRows(sheet, def, _offReadRows(sheet, def), function (r) {
    return !(replace[r[3]] && r[0] >= s && r[1] <= e);
  }, rows);
  ctx.applied.sales = rows.length;
  ctx.applied.salesRemoved = res.removed;
  if (split) {
    ctx.channels = Object.keys(replace);
    ctx.applied.byChannel = byCh;
    // 점포 → 채널(점포마스터 기록) — 판매가 0이어서 레코드가 없는 점포도 업태명으로 정한다
    ctx.storeChannel = {};
    (rec.stores || []).forEach(function (st) { var c = chOfBiz(st.biz); if (st.code && c) ctx.storeChannel[String(st.code).trim()] = c; });
  }
  return { start: s, end: e };
}

/* A-2. ERP 매출이익리스트(백화점·폐쇄몰·렌탈) — 기간 교체형 + 거래처 → 채널.
   레코드의 점포코드 = ERP 거래처코드 → 거래처매핑 → 채널(코드체계 erp 채널만). 미리보기에서 채널을 고른 새 거래처(meta.customers)는
   먼저 거래처매핑에 저장한다. 교체: 교체 기간 동안 코드체계 erp 채널 전부의 판매원장 행을 지우고 넣는다 — 그 기간에 판매가 없던 채널의
   예전 행도 정리되고, 포털 채널은 건드리지 않는다. 거래처매핑에 없는(또는 ERP 채널이 아닌 채널로 매핑된) 거래처의 행은 보류하고 경고.
   금액·수수료는 파일 값 그대로(반품·취소 음수). 점포마스터 점포명 = 거래처매핑의 거래처명 */
function _offApplyErpSales(ctx, meta, rec) {
  var s = meta.replaceStart, e = meta.replaceEnd, cm = ctx.chMeta;
  var erp = {}, rank = {};
  cm.rows.forEach(function (r, i) { if (cm.codeSys(r[0]) === OFF_ERP_CODE_SYSTEM) { erp[r[0]] = true; rank[r[0]] = (Number(r[4]) || 99) * 1000 + i; } });
  if (!Object.keys(erp).length) throw new Error('코드체계채널이 erp인 채널이 채널마스터에 없습니다 — 편집기에서 offline_setupSheets를 먼저 실행하세요.');
  var cust = _offErpCustomers(ctx, erp, meta.customers || []);
  var rows = [], outside = 0, held = {}, byCh = {};
  Object.keys(erp).forEach(function (c) { byCh[c] = { rows: 0, qty: 0, amount: 0, fee: 0 }; });
  (rec.sales || []).forEach(function (r) {
    if (r.s < s || r.e > e) { outside++; return; }
    var code = String(r.store || '').trim(), cu = cust[code], ch = cu && erp[cu.channelId] ? cu.channelId : '';
    if (!ch) { held[code] = (held[code] || 0) + 1; return; }
    var qty = Number(r.qty) || 0, amt = _offOpt(r.amt), fee = _offOpt(r.fee);
    if (!qty && !amt && !fee) return;
    var o = byCh[ch];
    o.rows++; o.qty += qty; o.amount += Number(amt) || 0; o.fee += Number(fee) || 0;
    rows.push([r.s, r.e, r.s === r.e ? 'day' : 'period', ch, code, r.code, qty, '', 'upload', ctx.uploadId, amt, fee]);
  });
  if (outside) ctx.warnings.push('교체 기간(' + s + '~' + e + ') 밖의 레코드 ' + outside + '건은 반영하지 않았습니다');
  var hk = Object.keys(held);
  if (hk.length) ctx.warnings.push('거래처매핑에 없는(또는 ERP 채널이 아닌 채널로 매핑된) 거래처 ' + hk.map(function (k) { return k + ' ' + held[k] + '건'; }).join(', ') + '은 반영을 보류했습니다 — 업로드 미리보기에서 채널을 고르거나 거래처매핑 탭을 확인하세요');
  var def = OFF_TABS.sales, sheet = _offSheet(ctx.ss, 'sales');
  var res = _offReplaceRows(sheet, def, _offReadRows(sheet, def), function (r) {
    return !(erp[r[3]] && r[0] >= s && r[1] <= e);
  }, rows);
  ctx.applied.sales = rows.length;
  ctx.applied.salesRemoved = res.removed;
  ctx.applied.byChannel = byCh;
  // 업로드로그 channel_id = 교체한 채널 전부(판매가 없던 채널도 그 기간이 덮였다 — 데이터 현황이 빈 날로 세지 않게)
  ctx.channels = Object.keys(erp).sort(function (a, b) { return rank[a] - rank[b]; });
  ctx.storeChannel = {};
  (rec.stores || []).forEach(function (st) {
    var code = String(st.code || '').trim(), cu = cust[code];
    if (!code || !cu || !erp[cu.channelId]) return;
    ctx.storeChannel[code] = cu.channelId;
    if (cu.name) st.name = cu.name;
  });
  return { start: s, end: e };
}

/* 거래처매핑 → { 거래처코드: { name, channelId } }. picks(미리보기에서 채널을 고른 새 거래처 {code, name, channelId})를 먼저 저장한다 —
   채널은 코드체계 erp 채널만 받는다(포털 채널로 잘못 고르면 그 채널의 판매원장을 지우게 되므로 저장 전에 거절). */
function _offErpCustomers(ctx, erp, picks) {
  var def = OFF_TABS.customerMap, sheet = _offSheet(ctx.ss, 'customerMap');
  var rows = _offReadRows(sheet, def), prev = rows.length, idx = {};
  rows.forEach(function (r) { if (r[0]) idx[r[0]] = r; });
  var clean = picks.map(function (p) {
    var code = String(p.code == null ? '' : p.code).trim(), ch = String(p.channelId || '').trim();
    if (!code) throw new Error('채널을 고른 거래처의 거래처코드가 비었습니다.');
    if (!erp[ch]) throw new Error('거래처 ' + code + '의 채널은 ERP 채널(코드체계 erp)이어야 합니다: ' + (ch || '(빈칸)'));
    return { code: code, name: String(p.name || '').trim() || code, channelId: ch };
  });
  clean.forEach(function (p) {
    var row = idx[p.code];
    if (!row) { row = [p.code, p.name, '', '']; rows.push(row); idx[p.code] = row; }
    row[2] = p.channelId;
    row[3] = ('업로드 미리보기에서 지정 ' + ctx.today + ' ' + ctx.email).trim();
  });
  if (clean.length) _offWriteAll(sheet, def, rows, prev);
  ctx.applied.customersAdded = clean.length;
  var out = {};
  rows.forEach(function (r) { if (r[0]) out[r[0]] = { name: r[1], channelId: r[2] }; });
  return out;
}

// B. 스냅샷형 — 재고_채널일별은 (기준일, 채널) 교체, 재고_점포최신은 더 최신일 때만 채널 통째 교체
function _offApplyStock(ctx, meta, rec, ft) {
  if (ft && ft.split === 'store') return _offApplyStockSplit(ctx, meta, rec);
  var ch = meta.channelId, D = meta.baseDate;
  var dDef = OFF_TABS.stockDaily, dSheet = _offSheet(ctx.ss, 'stockDaily');
  var dRows = (rec.channelStock || []).map(function (r) {
    return [D, ch, r.code, Number(r.stock) || 0, _offOpt(r.transit), _offOpt(r.reserved), ctx.uploadId];
  });
  _offReplaceRows(dSheet, dDef, _offReadRows(dSheet, dDef), function (r) { return !(r[0] === D && r[1] === ch); }, dRows);
  ctx.applied.stockDaily = dRows.length;

  var sDef = OFF_TABS.stockStore, sSheet = _offSheet(ctx.ss, 'stockStore');
  var sOld = _offReadRows(sSheet, sDef);
  var current = '';
  sOld.forEach(function (r) { if (r[1] === ch && r[0] > current) current = r[0]; });
  if (current && D < current) {
    ctx.warnings.push('재고_점포최신은 더 최신 기준일(' + current + ') 데이터가 있어 갱신하지 않았습니다');
    ctx.applied.stockStore = 0;
  } else {
    var sRows = (rec.storeStock || []).map(function (r) {
      return [D, ch, r.store || '', r.code, Number(r.stock) || 0, _offOpt(r.transit), _offOpt(r.reserved), _offOpt(r.monthIn), _offOpt(r.monthSale), ctx.uploadId];
    });
    _offReplaceRows(sSheet, sDef, sOld, function (r) { return r[1] !== ch; }, sRows);
    ctx.applied.stockStore = sRows.length;
  }
  return { baseDate: D };
}

/* 스냅샷형 재고 기준일. 새 화면은 파일명 날짜 + 채널 재고기준일오프셋을 미리보기에서 정해 meta.baseDate로, 파일명 날짜를 meta.fileDate로
   보낸다 — 그대로 쓴다(사람이 고친 날짜일 수도 있다). meta.fileDate가 없으면 옛 화면(오프셋을 모름 — 새로고침 전 탭)이라
   파일명 날짜로 온 기준일에 그 파일 채널(ft.channelId — 이마트 파일은 이마트·트레이더스가 섞여도 이마트 값)의 오프셋을 더한다.
   어느 쪽이든 업로드로그 경고 열에 "재고 기준일 …" 표시를 남긴다 — offline_fixStockDates가 이미 새 기준인 업로드를 다시 옮기지 않게. */
function _offStockBasis(ctx, meta, ft) {
  var row = null;
  ctx.chMeta.rows.forEach(function (r) { if (r[0] === ft.channelId) row = r; });
  var off = _offStockOffsetOf(row);
  if (meta.fileDate === undefined) {
    if (!off) return;
    var d0 = meta.baseDate;
    meta.baseDate = _offAddDays(d0, off);
    ctx.warnings.push(OFF_STOCK_BASIS_NOTE + meta.baseDate + ' (파일명 날짜 ' + d0 + ' ' + off + '일 — 채널마스터 재고기준일오프셋)');
    return;
  }
  var f = _offIsDate(meta.fileDate) ? meta.fileDate : '';
  ctx.warnings.push(OFF_STOCK_BASIS_NOTE + meta.baseDate + (f ? (f === meta.baseDate ? ' (파일명 날짜 그대로)' : ' (파일명 날짜 ' + f + ')') : ''));
}

// 파일에 없는 값은 빈칸('없음')으로 — 0(있는데 0개)과 구분한다
function _offOpt(v) { return (v === '' || v == null) ? '' : (Number(v) || 0); }

/* B-2. 스냅샷형 + 채널 분리(이마트 재고 '재고현황_상세' — 이마트·트레이더스 점포가 한 파일).
   점포마다 채널: ① 점포마스터에 그 점포코드가 있는 채널(같은 코드체계 안에서) ② 점포명이 채널마스터 점포명접두어로 시작하는 채널
   ③ 둘 다 없으면 코드체계 채널(이마트)로 두고 경고. 그 뒤 채널마다 기존 규칙 그대로 —
   재고_채널일별은 (기준일, 채널) 교체(채널 합계는 점포 재고를 채널별로 다시 더한 값), 재고_점포최신은 그 채널의 최신 기준일보다
   과거가 아닐 때만 채널 통째 교체. 파일 속 채널 합계(channelStock)는 채널이 섞여 있어 쓰지 않는다. */
function _offApplyStockSplit(ctx, meta, rec) {
  var root = meta.channelId, D = meta.baseDate, cm = ctx.chMeta, cs = cm.codeSys;
  var master = {};
  _offReadRows(_offSheet(ctx.ss, 'store'), OFF_TABS.store).forEach(function (r) { if (r[0] && r[1] && cs(r[0]) === cs(root)) master[r[1]] = r[0]; });
  var names = {};
  (rec.stores || []).forEach(function (s) { if (s.code) names[String(s.code).trim()] = String(s.name || ''); });
  var prefixes = cm.prefixes.filter(function (p) { return cs(p.channelId) === cs(root); });
  var chOf = {}, via = { master: 0, prefix: 0, fallback: 0 }, fallback = [];
  function storeCh(code) {
    if (chOf[code]) return chOf[code];
    var c = master[code];
    if (c) via.master++;
    else {
      var nm = names[code] || '', hit = null;
      for (var i = 0; i < prefixes.length && !hit; i++) if (nm.indexOf(prefixes[i].prefix) === 0) hit = prefixes[i];
      if (hit) { c = hit.channelId; via.prefix++; }
      else { c = root; via.fallback++; if (fallback.length < 5) fallback.push(code + (nm ? ' ' + nm : '')); }
    }
    return (chOf[code] = c);
  }
  var sRowsByCh = {}, agg = {}, order = [], sum = {};
  function add(c, r) {
    var k = c + OFF_KEY_SEP + r.code;
    var o = agg[k];
    if (!o) { o = agg[k] = { ch: c, code: r.code, stock: 0, transit: r.transit === '' || r.transit == null ? '' : 0, reserved: r.reserved === '' || r.reserved == null ? '' : 0 }; order.push(k); }
    o.stock += Number(r.stock) || 0;
    if (o.transit !== '') o.transit += Number(r.transit) || 0;
    if (o.reserved !== '') o.reserved += Number(r.reserved) || 0;
  }
  (rec.storeStock || []).forEach(function (r) {
    var code = String(r.store || '').trim(), c = code ? storeCh(code) : root;
    (sRowsByCh[c] = sRowsByCh[c] || []).push([D, c, r.store || '', r.code, Number(r.stock) || 0, _offOpt(r.transit), _offOpt(r.reserved), _offOpt(r.monthIn), _offOpt(r.monthSale), ctx.uploadId]);
    add(c, r);
    var s = sum[c] || (sum[c] = { stores: {}, stock: 0 });
    if (code) s.stores[code] = true;
    s.stock += Number(r.stock) || 0;
  });
  (rec.stores || []).forEach(function (s) { var code = String(s.code || '').trim(); if (code) storeCh(code); });
  // 채널 순서 = 채널마스터 정렬순서
  var rank = {};
  cm.rows.forEach(function (r, i) { rank[r[0]] = Number(r[4]) || 99 + i; });
  var chans = Object.keys(sRowsByCh).sort(function (a, b) { return (rank[a] || 99) - (rank[b] || 99); });
  if (!chans.length) chans = [root];
  var inFile = {};
  chans.forEach(function (c) { inFile[c] = true; });

  var dDef = OFF_TABS.stockDaily, dSheet = _offSheet(ctx.ss, 'stockDaily');
  var dRows = [];
  chans.forEach(function (c) { order.forEach(function (k) { var o = agg[k]; if (o.ch === c) dRows.push([D, c, o.code, o.stock, o.transit, o.reserved, ctx.uploadId]); }); });
  _offReplaceRows(dSheet, dDef, _offReadRows(dSheet, dDef), function (r) { return !(r[0] === D && inFile[r[1]]); }, dRows);
  ctx.applied.stockDaily = dRows.length;

  var sDef = OFF_TABS.stockStore, sSheet = _offSheet(ctx.ss, 'stockStore');
  var sOld = _offReadRows(sSheet, sDef);
  var current = {};
  sOld.forEach(function (r) { if (inFile[r[1]] && r[0] > (current[r[1]] || '')) current[r[1]] = r[0]; });
  var replace = {}, sRows = [];
  chans.forEach(function (c) {
    if (current[c] && D < current[c]) { ctx.warnings.push(_offChName(cm, c) + ' 재고_점포최신은 더 최신 기준일(' + current[c] + ') 데이터가 있어 갱신하지 않았습니다'); return; }
    replace[c] = true;
    sRows = sRows.concat(sRowsByCh[c] || []);
  });
  _offReplaceRows(sSheet, sDef, sOld, function (r) { return !replace[r[1]]; }, sRows);
  ctx.applied.stockStore = sRows.length;

  var byCh = {};
  chans.forEach(function (c) { var s = sum[c] || { stores: {}, stock: 0 }; byCh[c] = { stores: Object.keys(s.stores).length, stock: s.stock }; });
  ctx.applied.byChannel = byCh;
  ctx.applied.channelVia = via;
  if (via.fallback) ctx.warnings.push('점포마스터·점포명접두어로 채널을 정하지 못한 점포 ' + via.fallback + '곳은 ' + _offChName(cm, root) + '로 반영했습니다(예: ' + fallback.join(', ') + ') — 점포별 일별 매출 파일을 먼저 올리면 점포마스터로 정해집니다');
  ctx.channels = chans;
  ctx.storeChannel = chOf;
  return { baseDate: D };
}
function _offChName(cm, id) { for (var i = 0; i < cm.rows.length; i++) if (cm.rows[i][0] === id) return cm.rows[i][1] || id; return id; }

/* C. 하이마트 판매 계산 — 당월 누적(당월판매·당월실판매) 스냅샷의 차이로 판매를 만든다.
   1) 누적스냅샷에 기준일 D0 교체 저장
   2) 영향 날짜 = D0 + D0 바로 다음에 존재하는 스냅샷 날짜(그 날의 "이전 스냅샷"이 D0로 바뀌므로)
   3) 영향 날짜마다 _offHimartSalesFor로 다시 계산, 판매원장의 하이마트 행 중 기간종료가 영향 날짜인 것을 교체
   스냅샷에는 판매 값(당월실판매·당월판매·금주판매·당일판매)이 하나라도 있는 행만 둔다. 없는 행은
   "0으로 본다"는 계산 규칙과 결과가 같고, 점포×상품 전부(하루 1,600여 행)를 45일 쌓으면 매 업로드가
   수십만 셀을 읽고 쓰게 된다. */
function _offApplyHimart(ctx, meta, rec) {
  var D0 = meta.baseDate;
  var snapDef = OFF_TABS.himartSnap, snapSheet = _offSheet(ctx.ss, 'himartSnap');
  var oldSnap = _offReadRows(snapSheet, snapDef);
  var newSnap = [];
  (rec.himart || []).forEach(function (r) {
    if (!(r.real || r.sale || r.week || r.day)) return;
    newSnap.push([D0, r.store || '', r.code, Number(r.real) || 0, Number(r.sale) || 0, Number(r.week) || 0, Number(r.day) || 0, Number(r.stock) || 0, ctx.uploadId]);
  });
  // 판매 값이 하나도 없는 날(월초 등)도 "이 날 스냅샷이 있었다"는 사실은 남겨야 다음 날이 day로 계산된다
  if (!newSnap.length) newSnap.push([D0, '', '', 0, 0, 0, 0, 0, ctx.uploadId]);

  var merged = oldSnap.filter(function (r) { return r[0] !== D0 && _offIsDate(r[0]); }).concat(newSnap);
  var byDate = {};
  merged.forEach(function (r) {
    var m = byDate[r[0]] || (byDate[r[0]] = {});
    m[r[1] + OFF_KEY_SEP + r[2]] = { real: Number(r[3]) || 0, sale: Number(r[4]) || 0, day: Number(r[6]) || 0 };
  });
  var dates = Object.keys(byDate).sort();
  var affected = [D0];
  for (var i = 0; i < dates.length; i++) if (dates[i] > D0) { affected.push(dates[i]); break; }

  var newSales = [], recomputed = [], affectedSet = {};
  affected.forEach(function (D) {
    affectedSet[D] = true;
    var res = _offHimartSalesFor(D, byDate, dates, ctx.uploadId);
    newSales = newSales.concat(res.rows);
    recomputed.push({ date: D, unit: res.unit, start: res.start, rows: res.rows.length });
    if (res.mismatch) ctx.warnings.push('하이마트 ' + D + ' 당일판매 불일치 ' + res.mismatch + '건 (예: ' + res.samples.join(', ') + ')');
  });

  var sDef = OFF_TABS.sales, sSheet = _offSheet(ctx.ss, 'sales');
  var res2 = _offReplaceRows(sSheet, sDef, _offReadRows(sSheet, sDef), function (r) {
    return !(r[3] === 'himart' && affectedSet[r[1]]);
  }, newSales);
  ctx.applied.sales = newSales.length;
  ctx.applied.salesRemoved = res2.removed;

  var cutoff = _offAddDays(ctx.today, -OFF_SNAPSHOT_KEEP_DAYS);
  var keepSnap = newSnap.filter(function (r) { return r[0] >= cutoff; });
  _offReplaceRows(snapSheet, snapDef, oldSnap, function (r) { return r[0] !== D0 && r[0] >= cutoff; }, keepSnap);
  ctx.applied.himartSnap = keepSnap.length;
  return { recomputed: recomputed };
}

/* 영향 날짜 D 하나의 하이마트 판매 레코드(점포코드 × 원본코드).
   prev = D보다 이전의 가장 최근 스냅샷(같은 달일 때만 유효 — 당월 누적은 매달 1일에 0부터 다시 쌓인다)
     prev = D-1           → day    [D, D]        수량 = 당월판매(D) − 당월판매(prev)
     prev가 같은 달, D-1 아님 → period [prev+1, D]   (같은 식)
     같은 달에 prev 없음    → D가 1일이면 day, 아니면 period [그 달 1일, D]   수량 = 당월판매(D)
   설치완료수량은 같은 식을 당월실판매로. 한쪽 스냅샷에 없는 점포·코드는 0으로 본다.
   day 레코드는 파일의 당일판매(D)와 대조해 불일치 건수를 센다(검증용 — 값은 차이 계산 결과를 쓴다). */
function _offHimartSalesFor(D, byDate, dates, uploadId) {
  var prev = null;
  for (var i = 0; i < dates.length && dates[i] < D; i++) prev = dates[i];
  if (prev && prev.slice(0, 7) !== D.slice(0, 7)) prev = null;
  var start = prev ? _offAddDays(prev, 1) : D.slice(0, 8) + '01';
  var unit = start === D ? 'day' : 'period';
  var cur = byDate[D] || {}, base = prev ? (byDate[prev] || {}) : {};
  var keys = {};
  Object.keys(cur).forEach(function (k) { keys[k] = true; });
  Object.keys(base).forEach(function (k) { keys[k] = true; });
  var ZERO = { real: 0, sale: 0, day: 0 };
  var rows = [], mismatch = 0, samples = [];
  Object.keys(keys).sort().forEach(function (k) {
    var p = k.split(OFF_KEY_SEP);
    if (!p[0] && !p[1]) return; // 판매 없는 날 표시용 빈 행
    var c = cur[k] || ZERO, b = base[k] || ZERO;
    var qty = c.sale - b.sale, inst = c.real - b.real;
    if (qty || inst) rows.push([start, D, unit, 'himart', p[0], p[1], qty, inst, 'upload', uploadId]);
    if (unit === 'day' && qty !== c.day) {
      mismatch++;
      if (samples.length < 3) samples.push(p[0] + '/' + p[1] + ' 계산 ' + qty + '≠당일 ' + c.day);
    }
  });
  return { rows: rows, unit: unit, start: start, mismatch: mismatch, samples: samples };
}

/* 점포마스터 upsert — 새 점포는 추가, 있던 점포는 이름·지역(값이 있을 때만)과 최근확인일 갱신.
   점포코드는 코드체계(이마트·트레이더스 = emart) 안에서 한 채널에만 속한다 — split 파일이 점포의 채널을 정하면
   (ctx.storeChannel) 같은 코드체계의 다른 채널로 있던 행을 그 채널로 옮긴다(최초등록일 유지). 채널을 못 정한 점포는 건드리지 않는다. */
function _offUpsertStores(ctx, ch, stores) {
  if (!stores.length) return;
  var cs = (ctx.chMeta && ctx.chMeta.codeSys) || function (c) { return c; };
  var def = OFF_TABS.store, sheet = _offSheet(ctx.ss, 'store');
  var rows = _offReadRows(sheet, def);
  var prev = rows.length;
  var idx = {};
  rows.forEach(function (r) { idx[cs(r[0]) + OFF_KEY_SEP + r[1]] = r; });
  var added = 0, moved = 0;
  stores.forEach(function (s) {
    var code = String(s.code || '').trim();
    if (!code) return;
    var target = ctx.storeChannel ? ctx.storeChannel[code] : ch;
    if (!target) return;
    var k = cs(target) + OFF_KEY_SEP + code, row = idx[k];
    if (!row) {
      row = [target, code, s.name || '', s.region || '', ctx.today, ctx.today, _offStoreTypeOf(s.name, s.region)];
      rows.push(row); idx[k] = row; added++;
      return;
    }
    if (row[0] !== target) { row[0] = target; moved++; }
    if (s.name) row[2] = s.name;
    if (s.region) row[3] = s.region;
    if (ctx.today > row[5]) row[5] = ctx.today;
    if (!row[6]) row[6] = _offStoreTypeOf(row[2], row[3]); // 점포유형은 비어 있을 때만 — 사람이 고친 값은 그대로
  });
  _offWriteAll(sheet, def, rows, prev);
  ctx.applied.storesAdded = added;
  if (moved) ctx.applied.storesMoved = moved;
}

// 레코드에 나온 원본코드 → 상품명
function _offCodesOf(rec) {
  var names = rec.names || {}, out = {};
  function add(code) { if (code && !(code in out)) out[code] = String(names[code] || ''); }
  (rec.sales || []).forEach(function (r) { add(r.code); });
  (rec.storeStock || []).forEach(function (r) { add(r.code); });
  (rec.channelStock || []).forEach(function (r) { add(r.code); });
  (rec.himart || []).forEach(function (r) { add(r.code); });
  return out;
}

// 미매칭코드 갱신 — 이번 업로드에서 매핑 없는 코드를 누적(발견횟수 = 나온 업로드 수), 매핑된 코드는 정리.
// ch가 다른 채널의 코드체계를 빌려 쓰면(트레이더스) 그 코드체계채널(emart) 이름으로 쌓는다
function _offUpdateUnmatched(ctx, ch, codes) {
  var cs = _offCodeSystemOf(ctx.ss);
  ch = cs(ch);
  var mapped = _offMappedKeys(_offReadRows(_offSheet(ctx.ss, 'mapping'), OFF_TABS.mapping), cs);
  var def = OFF_TABS.unmatched, sheet = _offSheet(ctx.ss, 'unmatched');
  var rows = _offReadRows(sheet, def);
  var prev = rows.length;
  var idx = {};
  rows.forEach(function (r) { idx[cs(r[0]) + OFF_KEY_SEP + r[1]] = r; });
  var list = [];
  Object.keys(codes).sort().forEach(function (code) {
    var k = ch + OFF_KEY_SEP + code;
    if (mapped[k]) return;
    list.push({ code: code, name: codes[code] });
    var row = idx[k];
    if (row) {
      if (codes[code]) row[2] = codes[code];
      row[4] = ctx.today;
      row[5] = (Number(row[5]) || 0) + 1;
    } else {
      row = [ch, code, codes[code], ctx.today, ctx.today, 1];
      rows.push(row); idx[k] = row;
    }
  });
  _offWriteAll(sheet, def, rows.filter(function (r) { return !mapped[cs(r[0]) + OFF_KEY_SEP + r[1]]; }), prev);
  return list;
}

function _offAppendLog(ctx, meta, auth, status, unmatchedCount) {
  var ft = OFF_FILE_TYPES[meta.fileType] || {};
  var range = ft.kind === 'period' ? (meta.replaceStart + '~' + meta.replaceEnd) : (meta.baseDate || '');
  var a = ctx.applied;
  var appliedRows = (a.sales || 0) + (a.stockDaily || 0) + (a.stockStore || 0) + (a.himartSnap || 0);
  var def = OFF_TABS.uploadLog, sheet = _offSheet(ctx.ss, 'uploadLog');
  _offWriteBlock(sheet, def, sheet.getLastRow() + 1, [[
    ctx.uploadId, Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'), (auth && auth.email) || '',
    String(meta.fileName || '').slice(0, 200), meta.fileType, (ctx.channels && ctx.channels.length ? ctx.channels.join(',') : meta.channelId), range,
    Number(meta.rawRowCount) || 0, appliedRows, unmatchedCount, ctx.warnings.join(' / ').slice(0, 2000), status
  ]]);
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── API 라우팅 (doPost → 여기) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// apps-script.js 의 doPost가 세션을 확인한 뒤 action이 offline_ · home_ 으로 시작하면 여기로 보낸다.
function _offlineHandle(action, data, auth) {
  try {
    var out;
    if (action === 'offline_getMasters') out = _offGetMasters();
    else if (action === 'offline_upload') out = _offUpload(data || {}, auth);
    else if (action === 'offline_saveSku') out = _offSaveSku(data || {}, auth);
    else if (action === 'offline_saveMapping') out = _offSaveMapping(data || {}, auth);
    else if (action === 'offline_getUnmatched') out = _offGetUnmatched();
    else if (action === 'offline_getUploadLog') out = _offGetUploadLog();
    else if (action === 'offline_getStatus') out = _offGetStatus();
    // 2-A (apps-script-offline-targets.js)
    else if (action === 'offline_getMonthly') out = _offGetMonthly(data || {});
    else if (action === 'offline_saveTargets') out = _offSaveTargets(data || {}, auth);
    else if (action === 'offline_getPrices') out = _offGetPrices();
    else if (action === 'offline_savePrices') out = _offSavePrices(data || {}, auth);
    else if (action === 'offline_migrateProgress') out = _offMigrateProgress(data || {}, auth);
    else if (action === 'offline_migratePrices') out = _offMigratePrices(data || {}, auth);
    else if (action === 'offline_deletePrice') out = _offDeletePrice(data || {}, auth);
    // 2-B (apps-script-offline-inventory.js)
    else if (action === 'offline_getInventory') out = _offGetInventory(data || {});
    else if (action === 'offline_getDailySales') out = _offGetDailySales(data || {});
    else if (action === 'offline_getInventoryTrend') out = _offGetInventoryTrend(data || {});
    else if (action === 'offline_getSalesBreakdown') out = _offGetSalesBreakdown(data || {});
    else if (action === 'offline_saveSettings') out = _offSaveSettings(data || {}, auth);
    // 파트 홈 (apps-script-home.js)
    else if (action === 'offline_getGonguTargets') out = _gtGet(data || {});
    else if (action === 'offline_saveGonguTargets') out = _gtSave(data || {}, auth);
    else if (action === 'offline_migrateGonguTargets') out = _gtMigrate(data || {}, auth);
    else if (action === 'home_getSummary') out = _homeGetSummary(data || {});
    else throw new Error('알 수 없는 오프라인 액션: ' + action);
    return _json(out);
  } catch (err) {
    Logger.log('[오프라인 실패] action=' + action + ' / ' + err + '\n' + (err && err.stack));
    return _json({ error: String((err && err.message) || err), action: action });
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 마스터 읽기 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _offSkuObj(r) { return { skuId: r[0], name: r[1], line: r[2], model: r[3], option: r[4], active: r[5] || 'Y', order: r[6], note: r[7] }; }
function _offMappingObj(r) { return { channelId: r[0], code: r[1], skuId: r[2], stockType: r[3], name: r[4], registeredAt: r[5], registeredBy: r[6], note: r[7] }; }

function _offGetMasters() {
  var cache = CacheService.getScriptCache();
  var hit = _cacheGetJSON(cache, 'offline:masters');
  if (hit) { hit.cached = true; return hit; }
  var ss = _offSS();
  var chRows = _offReadRows(_offSheet(ss, 'channel'), OFF_TABS.channel).filter(function (r) { return r[0]; });
  var custSheet = ss.getSheetByName(OFF_TABS.customerMap.name); // setup 재실행 전이면 없다
  var out = {
    success: true,
    skus: _offReadRows(_offSheet(ss, 'sku'), OFF_TABS.sku).filter(function (r) { return r[0]; }).map(_offSkuObj),
    channels: chRows.map(function (r) {
      return { channelId: r[0], name: r[1], channelCategory: r[2], active: r[3], order: r[4], uploadStartMonth: r[5] || '',
        bizNames: r[6] || '', storePrefix: r[7] || '', codeSystem: r[8] || r[0], stockOffset: _offStockOffsetOf(r), inSource: _offInSourceOf(r),
        aliases: _offChannelAliases(r) };
    }),
    channelCategories: OFF_CHANNEL_CATEGORIES,
    codeSystems: _offVirtualCodeSystems(chRows),
    customers: (custSheet ? _offReadRows(custSheet, OFF_TABS.customerMap) : []).filter(function (r) { return r[0]; }).map(function (r) {
      return { code: r[0], name: r[1], channelId: r[2], note: r[3] };
    }),
    mappings: _offReadRows(_offSheet(ss, 'mapping'), OFF_TABS.mapping).filter(function (r) { return r[0] && r[1]; }).map(_offMappingObj),
    stores: _offReadRows(_offSheet(ss, 'store'), OFF_TABS.store).filter(function (r) { return r[0] && r[1]; }).map(function (r) {
      return { channelId: r[0], code: r[1], name: r[2], region: r[3], firstSeen: r[4], lastSeen: r[5], storeType: r[6] || _offStoreTypeOf(r[2], r[3]) };
    }),
    productLines: OFFLINE_PRODUCT_LINES,
    stockTypes: OFF_STOCK_TYPES,
    settings: _offReadSettings(ss)
  };
  _cachePutJSON(cache, 'offline:masters', out, OFF_CACHE_TTL_SEC);
  return out;
}

function _offGetUnmatched() {
  var ss = _offSS();
  var cs = _offCodeSystemOf(ss);
  var mapped = _offMappedKeys(_offReadRows(_offSheet(ss, 'mapping'), OFF_TABS.mapping), cs);
  var items = _offReadRows(_offSheet(ss, 'unmatched'), OFF_TABS.unmatched)
    .filter(function (r) { return r[0] && r[1] && !mapped[cs(r[0]) + OFF_KEY_SEP + r[1]]; })
    .map(function (r) { return { channelId: r[0], code: r[1], name: r[2], firstSeen: r[3], lastSeen: r[4], count: Number(r[5]) || 0 }; });
  items.sort(function (a, b) { return (b.count - a.count) || (b.lastSeen < a.lastSeen ? -1 : b.lastSeen > a.lastSeen ? 1 : 0); });
  return { success: true, items: items };
}

// 최근 50건 — 로그 전체를 읽지 않고 끝부분만 읽는다
function _offGetUploadLog() {
  var ss = _offSS();
  var def = OFF_TABS.uploadLog;
  var sheet = _offSheet(ss, 'uploadLog');
  var last = sheet.getLastRow();
  var n = Math.min(50, Math.max(0, last - 1));
  if (!n) return { success: true, items: [] };
  var rows = sheet.getRange(last - n + 1, 1, n, def.headers.length).getValues();
  var items = rows.map(function (r) {
    return {
      uploadId: _offStr(r[0]), at: _offStr(r[1]), uploader: _offStr(r[2]), fileName: _offStr(r[3]),
      fileType: _offStr(r[4]), channelId: _offStr(r[5]), range: _offStr(r[6]),
      rawRows: Number(r[7]) || 0, appliedRows: Number(r[8]) || 0, unmatched: Number(r[9]) || 0,
      warnings: _offStr(r[10]), status: _offStr(r[11])
    };
  }).filter(function (x) { return x.uploadId; });
  items.reverse();
  return { success: true, items: items };
}

/* 채널·데이터유형별 마지막 기준일과 이번 달 빈 날짜.
   원장이 아니라 **업로드로그**로 판단한다 — 판매가 0인 날은 판매원장에 행이 없어서, 원장만 보면
   "업로드는 했는데 판매가 없었던 날"과 "파일을 안 올린 날"을 구분할 수 없다.
   빈 날짜 = 이번 달 1일 ~ 어제 중 어떤 업로드도 덮지 않은 날(하이마트는 스냅샷 기준일이 없는 날). */
function _offGetStatus() {
  var cache = CacheService.getScriptCache();
  var hit = _cacheGetJSON(cache, 'offline:status');
  if (hit) { hit.cached = true; return hit; }
  var ss = _offSS();
  var channels = _offReadRows(_offSheet(ss, 'channel'), OFF_TABS.channel).filter(function (r) { return r[0]; });
  var logRows = _offReadRows(_offSheet(ss, 'uploadLog'), OFF_TABS.uploadLog);
  var today = _offToday();
  var monthStart = today.slice(0, 8) + '01';
  var yesterday = _offAddDays(today, -1);
  var byCh = {};
  channels.forEach(function (r) { byCh[r[0]] = { channelId: r[0], name: r[1], channelCategory: r[2], active: r[3], order: r[4], salesLast: '', stockLast: '', covered: {} }; });
  _offLogCoverage(logRows, byCh);
  var out = { success: true, today: today, month: today.slice(0, 7), channels: [] };
  Object.keys(byCh).forEach(function (id) {
    var st = byCh[id];
    if (st.active !== 'Y' && !st.salesLast && !st.stockLast) return; // 안 쓰는 채널은 생략
    var missing = [];
    for (var d = monthStart; d <= yesterday; d = _offAddDays(d, 1)) if (!st.covered[d]) missing.push(d);
    out.channels.push({ channelId: id, name: st.name, channelCategory: st.channelCategory, salesLast: st.salesLast, stockLast: st.stockLast, missingDays: missing, order: st.order });
  });
  // 채널대분류 순서 → 정렬순서 (화면이 대분류로 묶어 보여 준다)
  out.channels.sort(function (x, y) { return (_offChannelCatRank(x.channelCategory) - _offChannelCatRank(y.channelCategory)) || ((Number(x.order) || 99) - (Number(y.order) || 99)); });
  _cachePutJSON(cache, 'offline:status', out, OFF_CACHE_TTL_SEC);
  return out;
}

/* 업로드로그(성공 행) → byCh[채널]의 salesLast(판매 업로드가 덮은 마지막 날)·stockLast(재고 마지막 기준일)·covered{날짜}.
   byCh에 없는 채널은 건너뛴다. 데이터 현황(_offGetStatus)과 재고 지표(판매 최신 기준일)가 같이 쓴다. */
// channel_id가 'emart,traders'(한 파일에 여러 채널 — split 파일)면 각 채널에 같은 범위를 준다
function _offLogCoverage(logRows, byCh) {
  logRows.forEach(function (r) {
    var ft = OFF_FILE_TYPES[r[4]];
    if (!ft || r[11] !== '성공') return;
    var parts = String(r[6] || '').split('~');
    var a = parts[0], b = parts[1] || parts[0];
    if (!_offIsDate(a) || !_offIsDate(b)) return;
    _offSplitList(r[5]).forEach(function (ch) {
      var st = byCh[ch];
      if (!st) return;
      if (ft.kind === 'period' || ft.kind === 'himart') {
        if (b > st.salesLast) st.salesLast = b;
        if (st.covered) for (var d = a; d <= b; d = _offAddDays(d, 1)) st.covered[d] = true;
      }
      if (ft.kind === 'snapshot' || ft.kind === 'himart') {
        if (a > st.stockLast) st.stockLast = a;
      }
    });
  });
  return byCh;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 마스터 쓰기 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _offNextSkuId(rows) {
  var max = 0;
  rows.forEach(function (r) {
    var m = /^SKU-(\d+)$/.exec(r[0]);
    if (m && +m[1] > max) max = +m[1];
  });
  var n = String(max + 1);
  while (n.length < 4) n = '0' + n;
  return 'SKU-' + n;
}

/* 제품마스터 추가(sku.skuId 없음) / 수정(sku.skuId 있음)
   수정할 때 보내지 않은 필드(undefined)는 그대로 둔다 — 제품마스터 화면이 비고를 안 보내도 지워지지 않게.
   삭제는 없다: 활성=N(비활성)이면 새 매핑 드롭다운에서만 숨고, 과거 집계에는 그대로 쓰인다.
   응답의 mappedCodes = 이 SKU에 연결된 활성 매핑 수(품목군을 바꾸면 그만큼의 코드 집계가 옮겨 간다). */
function _offSaveSku(data, auth) {
  var s = data.sku || {};
  var line = String(s.line || '').trim();
  if (OFFLINE_PRODUCT_LINES.indexOf(line) < 0) throw new Error('품목군은 ' + OFFLINE_PRODUCT_LINES.join(', ') + ' 중 하나여야 합니다 (받은 값: ' + line + ')');
  var name = String(s.name || '').trim();
  if (!name) throw new Error('표준명이 비었습니다.');
  var order = (s.order === '' || s.order == null) ? '' : Number(s.order);
  if (order !== '' && !isFinite(order)) throw new Error('정렬순서는 숫자여야 합니다.');
  if (s.active !== undefined && s.active !== 'Y' && s.active !== 'N') throw new Error('활성은 Y 또는 N 이어야 합니다: ' + s.active);
  return _offWithLock(function () {
    var ss = _offSS();
    var def = OFF_TABS.sku;
    var sheet = _offSheet(ss, 'sku');
    var rows = _offReadRows(sheet, def);
    var prev = rows.length;
    var id = String(s.skuId || '').trim();
    var row = null, isNew = !id;
    if (id) {
      for (var i = 0; i < rows.length; i++) if (rows[i][0] === id) { row = rows[i]; break; }
      if (!row) throw new Error('없는 sku_id 입니다: ' + id);
    } else {
      id = _offNextSkuId(rows);
      row = [id, '', '', '', '', '', '', ''];
      rows.push(row);
    }
    var prevLine = row[2];
    var keep = function (v) { return !isNew && v === undefined; };
    row[1] = name; row[2] = line;
    if (!keep(s.model)) row[3] = String(s.model || '').trim();
    if (!keep(s.option)) row[4] = String(s.option || '').trim();
    if (!keep(s.active)) row[5] = s.active === 'N' ? 'N' : 'Y';
    if (!keep(s.order)) row[6] = order;
    if (!keep(s.note)) row[7] = String(s.note || '').trim();
    // 기타 품목군은 모델이 '기타' 하나뿐이라 옵션이 곧 품명이다(예: 3kg 건조기 전시대) — 비면 무엇인지 알 수 없다
    if (line === '기타' && !row[4]) throw new Error('기타 품목군은 옵션에 품명을 입력해야 합니다 (예: 3kg 건조기 전시대).');
    _offWriteAll(sheet, def, rows, prev);
    var mappedCodes = _offReadRows(_offSheet(ss, 'mapping'), OFF_TABS.mapping).filter(function (m) { return m[0] && m[1] && m[2] === id; }).length;
    _offInvalidateCache();
    Logger.log('[오프라인] SKU 저장 ' + id + ' by ' + auth.email + (!isNew && prevLine !== line ? ' (품목군 ' + prevLine + ' → ' + line + ')' : ''));
    return { success: true, sku: _offSkuObj(row), mappedCodes: mappedCodes, lineChanged: !isNew && prevLine !== line };
  });
}

/* 코드매핑 추가·수정·비활성화 (여러 건 한 번에).
   items: [{ op: 'upsert'|'deactivate', channelId, code, skuId, stockType, name, note }]
   비활성화 = sku_id를 비우고 비고에 기록 — 행(이력)은 남기고, 코드는 다시 미매칭 목록으로 올린다.
   channelId는 코드체계채널로 바꿔 저장한다(트레이더스로 와도 emart 매핑 한 벌 — 두 채널에 같이 적용된다). */
function _offSaveMapping(data, auth) {
  var items = data.items || [];
  if (!items.length) throw new Error('저장할 매핑이 없습니다.');
  return _offWithLock(function () {
    var ss = _offSS();
    var today = _offToday();
    var skuIds = {}, channelIds = {};
    _offReadRows(_offSheet(ss, 'sku'), OFF_TABS.sku).forEach(function (r) { if (r[0]) skuIds[r[0]] = true; });
    var chRows = _offReadRows(_offSheet(ss, 'channel'), OFF_TABS.channel);
    chRows.forEach(function (r) { if (r[0]) channelIds[r[0]] = true; });
    // 채널이 아닌 코드체계(erp)로 온 매핑도 받는다 — 미매칭 목록이 그 이름으로 뜬다
    _offVirtualCodeSystems(chRows).forEach(function (c) { channelIds[c.id] = true; });
    var cs = _offCodeSystem(chRows);

    var mDef = OFF_TABS.mapping, mSheet = _offSheet(ss, 'mapping');
    var mRows = _offReadRows(mSheet, mDef);
    var mPrev = mRows.length;
    var idx = {};
    mRows.forEach(function (r) { idx[cs(r[0]) + OFF_KEY_SEP + r[1]] = r; });
    var mappedNow = {}, deactivated = [];
    items.forEach(function (it) {
      var ch = String(it.channelId || '').trim(), code = String(it.code || '').trim();
      if (!channelIds[ch]) throw new Error('채널마스터에 없는 channel_id 입니다: ' + ch);
      if (!code) throw new Error('원본코드가 비었습니다.');
      ch = cs(ch);
      var k = ch + OFF_KEY_SEP + code;
      var row = idx[k];
      if (it.op === 'deactivate') {
        if (!row) throw new Error('매핑이 없는 코드입니다: ' + ch + ' / ' + code);
        row[2] = '';
        row[7] = ('비활성화 ' + today + ' ' + auth.email + (row[7] ? ' · ' + row[7] : '')).slice(0, 500);
        deactivated.push(row);
        return;
      }
      var sku = String(it.skuId || '').trim();
      if (!skuIds[sku]) throw new Error('제품마스터에 없는 sku_id 입니다: ' + sku);
      var st = it.stockType || '정상';
      if (OFF_STOCK_TYPES.indexOf(st) < 0) throw new Error('재고구분은 ' + OFF_STOCK_TYPES.join('/') + ' 중 하나여야 합니다: ' + st);
      if (!row) { row = [ch, code, '', '', '', '', '', '']; mRows.push(row); idx[k] = row; }
      row[2] = sku; row[3] = st;
      if (it.name) row[4] = String(it.name).trim();
      row[5] = today; row[6] = auth.email;
      if (it.note !== undefined) row[7] = String(it.note || '').trim();
      mappedNow[k] = true;
    });
    _offWriteAll(mSheet, mDef, mRows, mPrev);

    // 미매칭코드 — 매핑된 코드는 빼고, 비활성화된 코드는 다시 올린다
    var uDef = OFF_TABS.unmatched, uSheet = _offSheet(ss, 'unmatched');
    var uRows = _offReadRows(uSheet, uDef);
    var uPrev = uRows.length;
    var kept = uRows.filter(function (r) { return !mappedNow[cs(r[0]) + OFF_KEY_SEP + r[1]]; });
    var inList = {};
    kept.forEach(function (r) { inList[cs(r[0]) + OFF_KEY_SEP + r[1]] = true; });
    deactivated.forEach(function (r) {
      if (!inList[cs(r[0]) + OFF_KEY_SEP + r[1]]) kept.push([cs(r[0]), r[1], r[4], today, today, 0]);
    });
    _offWriteAll(uSheet, uDef, kept, uPrev);
    _offInvalidateCache();
    Logger.log('[오프라인] 매핑 저장 ' + items.length + '건 by ' + auth.email);
    return { success: true, saved: Object.keys(mappedNow).length, deactivated: deactivated.length };
  });
}
