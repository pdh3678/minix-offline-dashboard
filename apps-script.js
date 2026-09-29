/**
 * 미닉스 공동구매 자동화 대시보드 — Google Apps Script 연동 코드
 * 데이터 소스: 새 스프레드시트("앳홈 공동구매 총괄 시트 대시보드 연결용") → "실적통합" 탭 하나만 사용.
 * (구버전은 브랜드 시트 3개 + 실적통합, 총 4개 시트를 매칭/조인해서 썼으나, 이제 사용자가 시트 자체를
 *  단일 탭으로 통합해서 그 매칭 로직 전부가 필요 없어짐 — 이 파일은 그 단일 시트 기준으로 새로 작성됨)
 * 캘린더 "프로모션/이벤트 일정"은 같은 스프레드시트의 "캘린더이벤트" 탭에 별도 저장(최초 저장 시 자동 생성).
 *
 * ★ 배포 방법 (반드시 새 스프레드시트에서):
 * 1. 새 스프레드시트 → 확장 프로그램 → Apps Script
 * 2. 이 파일 내용 전체 붙여넣기 후 저장
 * 3. 배포 → 새 배포 → 웹 앱으로 배포 → 새 URL 발급
 * 4. 대시보드 연결 설정에 새 URL 입력
 * 오프라인 원장 기능은 같은 프로젝트의 두 번째 파일(apps-script-offline.js → 편집기 파일명 "offline")에 있다.
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── CONFIGURATION ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 배포본 확인용 버전 문자열 — 이 파일을 수정할 때마다 값을 바꿔서, doGet 응답에 포함시켜
// 프론트(REQUIRED_SCRIPT_VERSION — DASHBOARD_VERSION이 아님, 그쪽은 프론트 전용 버전이라 이 값과
// 더 이상 짝을 맞추지 않음)와 대조하면 "로컬 파일 = 실제 배포본"인지 바로 확인 가능
var SCRIPT_VERSION = 'stock-date-2026-09-29-01';

// 메인 데이터 시트명 — 새 스프레드시트의 실제 탭명
var MAIN_SHEET = '실적통합';

// 데이터 시작 행 (2행이 헤더 → 3행부터 데이터, 0-based index = 2)
var DATA_START_ROW = 2;

// 열 인덱스 (0-based: A=0, B=1, C=2 ...) — ⚠ 2026-09-14부터 고정 숫자가 아니라 **2행 헤더 텍스트에서
// 매 실행마다 해석**함(_resolveCols). 과거엔 여기 숫자를 손으로 박아뒀는데, 시트에 열이 하나
// 삽입될 때마다 뒤쪽 수십 개가 통째로 밀려서 그때마다 전부 재확정해야 했고(2026-07-24 마케팅링크/
// 상품코드 삽입, 2026-09-14 매출등급/팔로워등급 삽입) 한 칸만 틀려도 "엉뚱한 열에 값을 쓰는"
// 사고로 이어졌음. 이제 열 위치의 유일한 근거는 시트 2행 헤더 텍스트 하나뿐이고, 코드에는
// "어떤 헤더를 찾을지"만 있음 → 열을 옮기거나 삽입해도 코드는 손댈 필요 없음. 헤더 문구 자체를
// 바꿀 때만 아래 목록을 고칠 것.
var HEADER_ROW = 2;

// 논리 열 이름 → 2행에서 찾을 헤더 후보 텍스트(앞에서부터 순서대로 시도).
// ⚠ 배열의 **순서가 곧 해석 순서**이며, 한 번 어떤 논리 열이 차지한 시트 열은 뒤에 오는 논리 열이
//   다시 가져가지 못함(선점). 이 규칙이 실제로 필요한 이유:
//   · '비고'가 두 열에 있음 — 구 비고 자리(지금은 적립금)와 신규 자유입력 비고.
//     note가 ['적립금','비고']로 먼저 해석되어 왼쪽을 선점하므로, note2['비고']는 자연히 오른쪽을 잡음.
//   · '구성'·'목표수량'도 레거시 중복 헤더가 오른쪽에 하나씩 더 있는데, 실제로 쓰는 열이 항상 더
//     왼쪽이라 "왼쪽 우선" 규칙만으로 정리됨.
// 세 번째 원소가 true면 선택 열(없어도 에러 없이 -1) — 읽지도 쓰지도 않는 레거시 열에만 붙임.
// 나머지는 전부 필수라 못 찾으면 명시적으로 던짐: 없는 열에 쓰기를 시도해 시트를 망가뜨리는 것보다
// 통째로 실패하는 쪽이 훨씬 안전하기 때문(실패 메시지에 실제 2행 헤더 전체를 같이 실어 보냄).
var COL_HEADER_SPECS = [
  ['brand',         ['브랜드']],
  ['product',       ['제품명']],
  // ⚠ 시트 실제 헤더가 '소속 (밴더사)' — '밴'은 시트 쪽 오타지만 고치면 이 매핑이 깨지므로 그대로 둠.
  // (헤더 비교는 공백을 무시하므로 괄호 앞 공백 유무는 상관없음)
  ['vendor',        ['소속 (밴더사)', '소속(벤더사)', '소속', '벤더사']],
  ['channel',       ['채널명(인플루언서)', '채널명', '인플루언서', '채널']],
  ['platform',      ['플랫폼']],
  // 2026-09-14 신규 — 대시보드가 산정 결과를 되비추는 열(사람이 입력하는 열이 아님).
  ['salesTier',     ['매출등급']],
  ['followerTier',  ['팔로워 등급']],
  ['marketingLink', ['마케팅 링크']],
  ['code',          ['상품코드']],
  ['salePrice',     ['공동구매가']],
  ['qty',           ['판매수량']],
  ['revenue',       ['총매출']],
  ['commission',    ['수수료', '수수료율']],   // 0.35 = 35% 형태의 소수로 저장됨
  ['year',          ['연도']],
  ['startMD',       ['시작일']],
  ['endMD',         ['종료일']],
  ['status',        ['진행상태']],
  ['format',        ['포맷']],
  ['composition',   ['구성']],
  // ⚠ 2026-08-18 사은품/오픈시간/선착순/적립금 드롭다운 개편으로 "값의 의미"가 바뀐 열들.
  // 필드명(JS 프로퍼티)은 기존 프론트 호환을 위해 그대로 두고, 찾는 헤더만 새 의미를 따라감.
  ['option1',       ['추가옵션1']],  // (레거시, 더 이상 안 씀) 과거 자유텍스트 보존용
  ['option2',       ['오픈시간', '추가옵션2']],
  ['firstCome',     ['선착순 품목', '선착순 품목명', '선착순']], // 헤더는 '정확히 일치'로만 매칭하므로 '선착순 수량'과 안 섞임
  ['targetQty',     ['목표수량']],
  ['extraQty',      ['추가물량']],
  ['note',          ['적립금', '비고']],       // 위 주석 참고 — 반드시 note2보다 먼저 해석되어야 함
  ['views',         ['조회수', '조회수 합계']], // 병합 헤더의 왼쪽 끝(합계). 오른쪽 10칸이 릴스 슬롯
  ['link',          ['채널 링크', '인플루언서 링크', '링크']],
  ['thumbs',        ['릴스 썸네일(JSON)', '릴스 썸네일', '썸네일']],
  ['source',        ['출처(내부용, 수동 수정 금지)', '출처'], true], // 레거시 — 읽지도 쓰지도 않음
  ['dealId',        ['dealId(내부용, 수동 수정 금지)', 'dealId']],
  ['codeSeq',       ['코드순번(내부용, 수동 수정 금지)', '코드순번']],
  ['giftItem1',     ['사은품 품목1']],
  ['giftQty1',      ['사은품 수량1']],
  ['giftItem2',     ['사은품 품목2']],
  ['giftQty2',      ['사은품 수량2']],
  ['giftItem3',     ['사은품 품목3']],
  ['giftQty3',      ['사은품 수량3']],
  ['firstComeQty',  ['선착순 수량']],
  ['note2',         ['비고']],
  ['tier',          ['등급(수동)', '등급']],   // 자동 산정을 덮어쓸 때만 값을 넣는 '수동 지정' 열
  ['followers',     ['팔로워 수']],
  /* 2026-09-15 신규 — 채널 단위 속성(플랫폼 ID). 선택 열로 둔 이유:
     시트에 열을 추가하는 건 사람이 하는 일이고, 그 전에 배포가 나가도 대시보드가 멈추면 안 된다.
     열이 없으면 -1이 되어 관련 기능만 조용히 꺼지고, 열을 만드는 순간 재배포 없이 켜진다. */
  ['igId',          ['인스타 ID', '인스타그램 ID', '인스타그램ID'], true],
  ['ytId',          ['유튜브 ID', '유튜브ID'], true]
];

/* 채널 단위 필드 정의 — "이 값은 공구건이 아니라 채널에 속한다"는 것들.
   같은 채널명(앞뒤 공백만 제거한 완전 일치)의 모든 행에 같은 값이 유지돼야 하며,
   전파·자동 채움·불일치 검사가 전부 이 목록 하나를 기준으로 돈다.
   col이 -1(시트에 열 없음)인 필드는 모든 경로에서 자동으로 건너뛴다. */
// link(인플루언서 링크)도 채널 단위 속성이다 — 같은 채널이면 프로필 주소가 같다
var CHANNEL_FIELD_KEYS = ['igId', 'ytId', 'followers', 'link'];
function _channelFieldCols() {
  var out = [];
  for (var i = 0; i < CHANNEL_FIELD_KEYS.length; i++) {
    var k = CHANNEL_FIELD_KEYS[i];
    if (COL[k] != null && COL[k] >= 0) out.push(k);
  }
  return out;
}
// 채널 단위 필드 값 정규화 — 시트에 들어가기 직전에 항상 통과시킨다
function _normalizeChannelFieldValue(key, v) {
  if (key === 'followers') {
    var n = _normalizeFollowers(v);
    return n == null ? '' : n;
  }
  // 링크는 주소 그대로 — @를 떼면 안 된다(ID 규칙을 주소에 적용하면 값이 망가진다)
  if (key === 'link') return String(v == null ? '' : v).trim();
  // 플랫폼 ID: 앞의 @와 공백만 정리(대소문자는 플랫폼에 따라 의미가 있으므로 건드리지 않음)
  return String(v == null ? '' : v).trim().replace(/^@+/, '');
}

// 해석 결과가 담기는 객체 — 코드 전체는 예전과 똑같이 COL.xxx로 참조함(바뀐 건 "값이 어디서
// 오는가"뿐이라 호출부는 한 줄도 안 바뀜). _resolveCols 전에는 비어 있으므로, 메인 시트를 만지는
// 모든 진입점은 반드시 _mainSheet(ss)를 거쳐야 함.
var COL = {};

// 릴스별 조회수/링크를 담는 열 범위(1-based 시작 열, 10칸). 조회수 합계 열 바로 오른쪽에 붙어 있어서
// 고정값이 아니라 COL.views에서 파생시킴 — 조회수 열이 밀리면 릴스 슬롯도 같이 따라감.
// 셀 값=조회수(만 단위), 링크=해당 셀의 하이퍼링크. 합계 열은 이 10칸의 합으로 대시보드가 직접 계산해 덮어씀.
var REEL_COL_START = 0; // _resolveCols가 COL.views + 2로 채움
var REEL_SLOT_COUNT = 10;

// 상품코드 최대 개수(그룹당 최대 행 수) — H열 하나만 사용, 옛 AJ열은 참조하지 않음
var MAX_CODES = 10;

// ── 인플루언서 등급 공용 상수 (2026-09-09) ──
// 프론트(index.html)의 TIER_TAXONOMY에서 파생되는 TIER_OPTIONS/TIER_MIN_SAMPLE과 값·순서가
// 반드시 일치해야 함 — 여긴 시트 값 정규화(허용값 검증)용, 프론트는 드롭다운/정렬/집계용.
// 색상은 화면 표시 전용이라 프론트에만 있음(GAS는 값 검증만 함).
var TIER_OPTIONS = ['메가', '매크로', '마이크로', '나노'];
// 2026-09-10: 등급은 프론트가 채널의 과거 매출로 자동 산정함. 이 열은 그 결과를 덮어쓰는
// "수동 지정" 전용이 됐고 비어 있는 게 정상 — 헤더 문구도 그 의미로 바꿈(구 '등급'은 자동 승격).
var TIER_HEADER = '등급(수동)';
var TIER_MIN_SAMPLE = 3; // 등급별 집계에서 "표본 적음"으로 표시하는 기준 건수(프론트 배지 판정과 동일)

// 시트 셀의 등급 값을 허용값 4종 중 하나로 정규화 — 오타/공백/미분류는 전부 빈 문자열로.
// 저장할 때도 같은 함수를 통과시켜서, 프론트가 이상한 값을 보내도 시트에 남지 않게 함.
function _normalizeTier(v) {
  var t = String(v || '').trim();
  return TIER_OPTIONS.indexOf(t) !== -1 ? t : '';
}

// ── 팔로워 수 (2026-09-11) ──
// 등급을 매출 축과 팔로워 축 두 개로 나누면서 추가된 열. 산정은 프론트가 하고(FOLLOWER_RULES),
// GAS는 이 열의 읽기/쓰기와 값 정규화만 담당함 — 등급 열과 같은 역할 분담.
var FOLLOWERS_HEADER = '팔로워 수';
// 시트/프론트에서 온 값을 숫자로 — 콤마·공백이 섞여 있어도 받아주고, 음수/비수치/빈값은 null.
// null은 "미입력"이고 0과 다름(0은 '팔로워 0명'이라는 실제 값으로 취급).
function _normalizeFollowers(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = (typeof v === 'number') ? v : Number(String(v).replace(/[,\s]/g, ''));
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 2행 헤더 텍스트 → 열 인덱스 해석 (2026-09-14) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 헤더 비교용 정규화 — 공백(일반/전각/줄바꿈)과 대소문자 차이만 무시함.
// 부분 문자열 매칭은 절대 하지 않음: '선착순'이 '선착순 수량'을, '등급'이 '매출등급'을 잡아버리는
// 종류의 사고가 이 함수 하나로 막힘(항상 "정규화 후 완전히 같을 때"만 매칭).
function _normHeaderText(v) {
  return String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase();
}

// 2행 헤더는 한 실행 안에서 여러 번 읽히므로 시트 이름 기준으로 한 번만 읽어 재사용.
// (Apps Script는 실행이 끝나면 전역이 초기화되므로 요청 간에 남지 않음 — 캐시 무효화 걱정 불필요)
var _headerRowCache = null, _headerRowCacheSheet = null;
function _headerRowValues(sheet) {
  if (_headerRowCache && _headerRowCacheSheet === sheet.getName()) return _headerRowCache;
  var lastCol = sheet.getLastColumn();
  _headerRowCache = lastCol > 0 ? sheet.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0] : [];
  _headerRowCacheSheet = sheet.getName();
  return _headerRowCache;
}

/* 2행 헤더에서 열 인덱스(0-based)를 찾는 단일 창구.
   header: 문자열 또는 후보 문자열 배열(앞에서부터 순서대로 시도).
   opts.claimed: {열인덱스:true} — 이미 다른 논리 열이 선점한 열은 건너뜀(같은 헤더 텍스트가
     두 열에 있는 '비고' 같은 경우를 순서로 갈라내기 위함. COL_HEADER_SPECS 주석 참고).
   opts.optional: true면 못 찾아도 -1을 돌려줌. 기본은 "못 찾으면 던진다".
   같은 후보가 여러 열에 있으면 가장 왼쪽 열을 씀 — 레거시 중복 헤더('구성'/'목표수량')가 항상
   오른쪽에 있어서 이 규칙만으로 실제 사용 열이 선택됨. */
function getColIndexByHeader(sheet, header, opts) {
  opts = opts || {};
  var names = Object.prototype.toString.call(header) === '[object Array]' ? header : [header];
  var row = _headerRowValues(sheet);
  var claimed = opts.claimed || null;
  for (var n = 0; n < names.length; n++) {
    var want = _normHeaderText(names[n]);
    if (!want) continue;
    for (var c = 0; c < row.length; c++) {
      if (claimed && claimed[c]) continue;
      if (_normHeaderText(row[c]) === want) return c;
    }
  }
  if (opts.optional) return -1;
  // 실패 메시지에 실제 2행 헤더 전체를 열 문자와 함께 실어 보냄 — 헤더 문구가 코드와 어긋났을 때
  // 시트를 따로 열어보지 않고도 무엇을 고쳐야 하는지 바로 알 수 있게 하려는 것.
  var dump = [];
  for (var d = 0; d < row.length; d++) dump.push(_colLetter(d) + '=' + String(row[d] == null ? '' : row[d]));
  throw new Error('시트 "' + sheet.getName() + '" ' + HEADER_ROW + '행에서 "' + names.join('" 또는 "') +
    '" 헤더를 찾을 수 없습니다. 헤더를 추가하거나 문구를 맞춰주세요. 현재 ' + HEADER_ROW + '행 헤더: [' +
    dump.join(' | ') + ']');
}

// COL_HEADER_SPECS를 순서대로 훑어 COL을 채움. 한 실행 안에서 한 번만 수행.
// 이 함수가 끝나기 전에는 COL이 비어 있으므로, 메인 시트를 만지는 코드는 전부 _mainSheet(ss)
// (또는 doGet처럼 직접 _resolveCols 호출)를 거쳐야 함.
var _colsResolved = false;
/* ⚠ 2026-09-15: 열 매핑을 CacheService에 캐시하던 코드를 **제거**했다.

   그 캐시는 "열 개수가 같으면 히트"로 판정했는데, 열을 **옮기는** 경우 개수가 그대로라
   최대 60초 동안 옛 위치로 읽고 쓰게 된다 — 값이 엉뚱한 열에 저장되는 종류의 사고다
   (실제로 '인플루언서 링크' 열을 옮겼을 때 걸릴 수 있던 경로).

   그렇다고 "헤더 해시를 같이 저장해 비교"하는 방식도 답이 아니다. 해시를 구하려면 결국 2행
   헤더를 읽어야 하는데, 그 읽기 1회가 이 캐시가 아끼던 유일한 비용이다(전체 요청의 0.3%).
   즉 검증을 붙이는 순간 이득이 0이 되고 복잡성과 실패 지점만 남는다.
   → 매 실행마다 헤더를 읽어 해석한다. 실행 안에서는 _colsResolved로 한 번만 수행되므로
     추가 비용은 요청당 헤더 한 줄 읽기 1회뿐이고, 열을 어떻게 옮기든 항상 정확하다. */
function _resolveCols(sheet) {
  if (_colsResolved) return COL;
  var claimed = {};
  var log = [];
  for (var i = 0; i < COL_HEADER_SPECS.length; i++) {
    var key = COL_HEADER_SPECS[i][0];
    var idx = getColIndexByHeader(sheet, COL_HEADER_SPECS[i][1], { claimed: claimed, optional: !!COL_HEADER_SPECS[i][2] });
    COL[key] = idx;
    if (idx >= 0) { claimed[idx] = true; log.push(key + '=' + _colLetter(idx)); }
    else log.push(key + '=(없음)');
  }
  REEL_COL_START = COL.views + 2; // 0-based 조회수 열 → 1-based(+1) → 그 바로 오른쪽 칸(+1)
  _colsResolved = true;
  // 열이 밀렸을 때 "어느 열로 해석됐는지"를 실행 기록 한 줄로 확인할 수 있게 항상 남김 — 값이
  // 이상해 보이는 문제는 대부분 이 줄과 시트를 나란히 보면 바로 판별됨.
  Logger.log('[열 해석] ' + log.join(', ') + ' / 릴스 슬롯 시작=' + _colLetter(REEL_COL_START - 1));
  return COL;
}

// 실적통합 시트 + 열 해석을 한 번에 — MAIN_SHEET를 직접 getSheetByName 하지 말고 항상 이걸 쓸 것.
// 열 인덱스가 2행 헤더에서 나오므로, 시트를 손에 넣는 순간 해석도 끝나 있어야 안전함.
// 시트가 없으면 null(호출부가 기존과 똑같이 에러 JSON을 만들 수 있도록 예외를 던지지 않음).
function _mainSheet(ss) {
  var sheet = ss.getSheetByName(MAIN_SHEET);
  if (sheet) _resolveCols(sheet);
  return sheet;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 저장 성능: 구간 계측 / 행 탐색 / 배치 쓰기 / 락 (2026-09-15) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/* 쓰기 요청의 구간별 소요시간(ms)을 모아 응답 JSON의 timings로 돌려준다.
   Apps Script는 프로파일러가 없어서, 느린 저장을 만나면 "어디가 느린지"를 추측할 수밖에 없었다.
   이 계측이 있으면 프론트 콘솔에 바로 구간표가 찍히므로 다음 번에도 측정부터 시작할 수 있다. */
var _TM = null;
function _tmStart() { _TM = { _last: Date.now(), _t0: Date.now(), phases: {} }; }
function _tmMark(name) {
  if (!_TM) return;
  var now = Date.now();
  _TM.phases[name] = (_TM.phases[name] || 0) + (now - _TM._last);
  _TM._last = now;
}
function _tmReport() {
  if (!_TM) return null;
  _TM.phases.total = Date.now() - _TM._t0;
  return _TM.phases;
}

/* ── 캐시 일괄 정리 ──
   열을 옮기거나 헤더를 고친 뒤, 이전 배포가 남겨둔 캐시가 옛 값을 들고 있을 수 있다.
   Apps Script 편집기에서 이 함수만 골라 실행하면 대시보드 응답 캐시와 행 맵 캐시를 한 번에 비운다.
   (열 매핑 캐시는 2026-09-15에 제거했다 — 이유는 _resolveCols 주석 참고) */
function clearAllCaches() {
  var removed = [];
  try { CacheService.getScriptCache().remove('cols_' + SCRIPT_VERSION); removed.push('옛 열 매핑'); } catch (e) {}
  try { _invalidateDashboardCache(); removed.push('대시보드 응답'); } catch (e) {}
  try { _invalidateDealRowMap(); removed.push('dealId 행 맵'); } catch (e) {}
  Logger.log('[캐시 정리] ' + removed.join(', ') + ' 비움');
  return removed;
}

// ── dealId → 행 목록 맵 ──
/* 예전 _findGroupRows는 dealId 하나를 찾자고 getDataRange()로 시트 전체(운영 기준 2만 셀 이상)를
   읽었다. 실제로 필요한 건 dealId 열과 코드순번 열 둘뿐이라, 그 두 열만 한 번에 읽어 맵을 만든다.
   맵은 CacheService에도 올려두고, 다음 요청은 아래 두 가지를 확인한 뒤에만 재사용한다:
     1) 시트 전체 행 수(getMaxRows)가 맵을 만들 때와 같은가 — 사람이 행을 넣거나 지우면 달라짐
     2) 후보 행들이 지금도 그 dealId를 담고 있는가 — 좁은 범위 읽기 1회
   둘 중 하나라도 어긋나면 그냥 다시 만든다. 캐시가 어긋난 채로 쓰면 "남의 행에 저장"이 되므로
   검증 없는 재사용은 절대 하지 않는다. */
var DEAL_ROWS_TTL_SEC = 120;
function _dealRowsCacheKey() { return 'dealRows_' + SCRIPT_VERSION; }
function _invalidateDealRowMap() {
  try { CacheService.getScriptCache().remove(_dealRowsCacheKey()); } catch (e) {}
}

function _buildDealRowMap(sheet) {
  var maxRows = sheet.getMaxRows();
  var map = {};
  if (maxRows <= DATA_START_ROW) return { rows: map, maxRows: maxRows };
  var n = maxRows - DATA_START_ROW;
  var first = DATA_START_ROW + 1;
  var vals;
  if (COL.codeSeq === COL.dealId + 1) {
    vals = sheet.getRange(first, COL.dealId + 1, n, 2).getValues(); // 붙어 있으면 읽기 1회
  } else {
    var a = sheet.getRange(first, COL.dealId + 1, n, 1).getValues();
    var b = sheet.getRange(first, COL.codeSeq + 1, n, 1).getValues();
    vals = [];
    for (var z = 0; z < n; z++) vals.push([a[z][0], b[z][0]]);
  }
  for (var i = 0; i < n; i++) {
    var id = String(vals[i][0] || '').trim();
    if (!id) continue;
    var seq = _numOrNull(vals[i][1]);
    if (!map[id]) map[id] = [];
    map[id].push([first + i, seq == null ? 999 : seq]);
  }
  return { rows: map, maxRows: maxRows };
}

function _putDealRowMap(blob) {
  try {
    var s = JSON.stringify(blob);
    if (s.length < 95000) CacheService.getScriptCache().put(_dealRowsCacheKey(), s, DEAL_ROWS_TTL_SEC);
  } catch (e) { Logger.log('dealId 행 맵 캐시 저장 실패 (무시): ' + e); }
}
function _getDealRowMap() {
  try {
    var s = CacheService.getScriptCache().get(_dealRowsCacheKey());
    return s ? JSON.parse(s) : null;
  } catch (e) { return null; }
}

// 캐시된 후보 행들이 "지금도" 그 dealId인지 좁은 범위 하나만 읽어 확인
function _verifyDealRows(sheet, dealId, pairs) {
  if (!pairs || !pairs.length) return false;
  var min = pairs[0][0], max = pairs[0][0];
  for (var i = 1; i < pairs.length; i++) {
    if (pairs[i][0] < min) min = pairs[i][0];
    if (pairs[i][0] > max) max = pairs[i][0];
  }
  if (min <= DATA_START_ROW || max > sheet.getMaxRows()) return false;
  var vals = sheet.getRange(min, COL.dealId + 1, max - min + 1, 1).getValues();
  for (var j = 0; j < pairs.length; j++) {
    if (String(vals[pairs[j][0] - min][0] || '').trim() !== dealId) return false;
  }
  return true;
}

function _findGroupRows(sheet, dealId) {
  if (!dealId) return [];
  var out = null;
  var cached = _getDealRowMap();
  if (cached && cached.maxRows === sheet.getMaxRows() && cached.rows && cached.rows[dealId]) {
    if (_verifyDealRows(sheet, dealId, cached.rows[dealId])) out = cached.rows[dealId];
  }
  if (!out) {
    var blob = _buildDealRowMap(sheet);
    _putDealRowMap(blob);
    out = blob.rows[dealId] || [];
  }
  var res = [];
  for (var i = 0; i < out.length; i++) res.push({ row: out[i][0], codeSeq: out[i][1] });
  res.sort(function (a, b) { return a.codeSeq - b.codeSeq; });
  return res;
}

/* 같은 행 안에서 "완전히 인접한" 열끼리만 묶어 setValues를 한 번씩 호출한다.
   pending 형태: { 행번호: { 0-based열: 값 } }
   ⚠ 떨어진 열을 한 범위로 묶으면 사이 열까지 값으로 덮어써 버린다(총매출 수식이 숫자로 박히는 사고).
   그래서 gap이 1칸이라도 있으면 범위를 끊는다 — 호출이 조금 늘어도 남의 칸은 건드리지 않는 쪽. */
function _writeCellsBatched(sheet, pending) {
  var calls = 0;
  for (var rowKey in pending) {
    var row = Number(rowKey);
    var cols = [];
    for (var ck in pending[rowKey]) cols.push(Number(ck));
    cols.sort(function (a, b) { return a - b; });
    var i = 0;
    while (i < cols.length) {
      var j = i;
      while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++;
      var vals = [];
      for (var k = i; k <= j; k++) vals.push(pending[rowKey][cols[k]]);
      sheet.getRange(row, cols[i] + 1, 1, vals.length).setValues([vals]);
      calls++;
      i = j + 1;
    }
  }
  return calls;
}

// 등급 결과 열(매출등급/팔로워 등급)을 pending에 얹어, 본문 저장과 같은 setValues 묶음에 태운다.
// 두 열은 붙어 있으므로 보통 추가 호출 0회(본문 쓰기와 합쳐지거나 2칸짜리 범위 하나).
function _stageTiers(pending, rows, tiers) {
  if (!tiers) return;
  var s = _normalizeTier(tiers.salesTier), f = _normalizeTier(tiers.followerTier);
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!pending[r]) pending[r] = {};
    pending[r][COL.salesTier] = s;
    pending[r][COL.followerTier] = f;
  }
}

/* 행 구조를 바꾸는 저장(행 추가/삭제)만 짧게 직렬화한다.
   두 사람이 동시에 등록하면 둘 다 같은 "마지막 데이터 행"을 계산해서 한쪽이 다른 쪽을 덮어쓸 수
   있기 때문. 값만 고치는 저장은 행이 이미 확정돼 있어 락이 필요 없다(락은 그 자체가 대기시간이라
   꼭 필요한 경로에만 건다). 5초 안에 못 잡으면 기다리지 않고 바로 에러 — 사용자를 붙잡아두는
   것보다 "다시 시도해주세요"가 낫다. */
var STRUCT_LOCK_WAIT_MS = 5000;
function _withStructLock(fn) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(STRUCT_LOCK_WAIT_MS);
  } catch (e) {
    throw new Error('다른 사용자가 저장 중입니다. 잠시 후 다시 시도해주세요.');
  }
  try { return fn(); }
  finally { try { lock.releaseLock(); } catch (e) {} }
}

// ── 등급 결과 열(매출등급/팔로워 등급)의 시트 측 표시 (2026-09-14) ──
// 이 두 열은 대시보드가 계산해서 되비추는 "결과 칸"이라, 시트에서 직접 고쳐도 다음 기록 때
// 덮어써짐. 그 사실을 헤더 메모로 못 박아 두고, 읽기 로직은 이 두 열을 등급 판정에 절대 쓰지 않음.
var TIER_RESULT_NOTE = "대시보드 자동 기록 — 직접 수정 시 덮어써짐. 수동 지정은 '등급(수동)' 열 사용";
// 조건부 서식 색 — 프론트 TIER_COLORS와 같은 톤(배경/글자색 쌍)을 그대로 옮긴 것.
// 드롭다운(데이터 확인)은 일부러 넣지 않음: 사람이 고르는 칸이 아니라 결과 칸이기 때문.
var TIER_SHEET_COLORS = {
  '메가':     { bg: '#EDE9FE', fg: '#6D28D9' },
  '매크로':   { bg: '#DBEAFE', fg: '#1D4ED8' },
  '마이크로': { bg: '#D1FAE5', fg: '#047857' },
  '나노':     { bg: '#FEF3C7', fg: '#B45309' }
};

// ── 사은품/선착순/오픈시간/적립금 드롭다운 공용 상수 (2026-08-18 모달 개편) ──
// 프론트(index.html)의 동일 목록과 반드시 값이 일치해야 함 — 여긴 마이그레이션 매칭용, 프론트는 UI 렌더용.
var GIFT_ITEMS = [
  '하드필터', '하드락필터', '하드락필터(mini)', '저온촉매 탈취필터',
  '락앤락 김치통 2.6L 2P', '푸드컨테이너(단종)', '실링 컨테이너 2L', '실링 컨테이너 3L',
  '탈취제', '수동 빙수기',
  // 더 슬림용(2026-09-17 추가) — 프론트 GIFT_ITEMS와 순서·표기가 같아야 함
  '더 슬림 먼지봉투(3개입)', '더 슬림 헤파필터', '더 슬림 스테이션 헤파필터',
  '더 슬림 배터리', '더 슬림 브러쉬롤러'
];
// 현장에서 정식 품목명 대신 흔히 줄여 쓰는 표현(마이그레이션 매칭용) — 정식명 자체도 항상 포함해둠.
var GIFT_ITEM_ALIASES = {
  '하드필터': ['하드필터'],
  '하드락필터': ['하드락필터'],
  '하드락필터(mini)': ['하드락필터(mini)', '하드락필터미니', '하드락필터 mini'],
  '저온촉매 탈취필터': ['저온촉매 탈취필터', '저온촉매필터', '촉매탈취필터', '촉매필터'],
  '락앤락 김치통 2.6L 2P': ['락앤락 김치통 2.6L 2P', '락앤락김치통', '김치통'],
  '푸드컨테이너(단종)': ['푸드컨테이너(단종)', '푸드컨테이너'],
  '실링 컨테이너 2L': ['실링 컨테이너 2L', '실링컨테이너2L', '실링용기2L'],
  '실링 컨테이너 3L': ['실링 컨테이너 3L', '실링컨테이너3L', '실링용기3L'],
  '탈취제': ['탈취제'],
  '수동 빙수기': ['수동 빙수기', '수동빙수기', '빙수기'],
  // 더 슬림용 — 마이그레이션은 2026-08-18에 이미 끝났으므로 실질 매칭 대상은 없지만,
  // GIFT_ITEMS의 모든 항목이 여기 나타나는 파일 규칙을 깨지 않도록 정식명 기준으로만 등록함.
  '더 슬림 먼지봉투(3개입)': ['더 슬림 먼지봉투(3개입)', '더슬림먼지봉투'],
  '더 슬림 헤파필터': ['더 슬림 헤파필터', '더슬림헤파필터'],
  '더 슬림 스테이션 헤파필터': ['더 슬림 스테이션 헤파필터', '더슬림스테이션헤파필터'],
  '더 슬림 배터리': ['더 슬림 배터리', '더슬림배터리'],
  '더 슬림 브러쉬롤러': ['더 슬림 브러쉬롤러', '더슬림브러쉬롤러']
};
function _buildQtyOptions() {
  var opts = [];
  for (var q = 50; q <= 500; q += 50) opts.push(q);
  for (var q2 = 600; q2 <= 3000; q2 += 100) opts.push(q2);
  return opts;
}
var QTY_STANDARD_OPTIONS = _buildQtyOptions(); // [50,100,150,...,500,600,700,...,3000]
var OPEN_TIME_OPTIONS = (function () {
  var opts = [];
  for (var h = 0; h <= 23; h++) opts.push(_pad(h) + ':00');
  return opts;
})(); // ['00:00',...,'23:00']
var POINTS_OPTIONS = ['NPAY 1만원', 'NPAY 2만원', 'NPAY 3만원', 'NPAY 4만원', 'NPAY 5만원'];
var QTY_UNSPECIFIED_LABEL = '전원증정'; // 기존 자유텍스트에 수량 명시가 없을 때 마이그레이션 기본값

function _stripSpaces(s) { return String(s || '').replace(/\s+/g, ''); }

// 텍스트 안에서 GIFT_ITEMS(정식명 또는 GIFT_ITEM_ALIASES에 등록된 흔한 줄임 표현) 중 하나가
// 부분 일치하면 그 canonical 품목명을 반환(없으면 null). 공백 유무 차이는 무시하고 비교함.
// "하드락필터"와 "하드락필터(mini)"처럼 한쪽이 다른 쪽을 포함하는 경우가 있어, 일치하는 표현 중
// 가장 긴(가장 구체적인) 것을 고름 — 짧은 쪽으로 잘못 매칭되는 것 방지.
function _matchGiftItem(text) {
  var t = _stripSpaces(text);
  if (!t) return null;
  var bestCanonical = null, bestLen = 0;
  for (var i = 0; i < GIFT_ITEMS.length; i++) {
    var canonical = GIFT_ITEMS[i];
    var aliases = GIFT_ITEM_ALIASES[canonical] || [canonical];
    for (var j = 0; j < aliases.length; j++) {
      var alias = _stripSpaces(aliases[j]);
      if (alias && t.indexOf(alias) !== -1 && alias.length > bestLen) {
        bestCanonical = canonical;
        bestLen = alias.length;
      }
    }
  }
  return bestCanonical;
}

// "24시간 타임딜"의 24, 날짜 등 수량과 무관한 숫자까지 수량으로 착각하지 않도록, 개수 단위가
// 붙은 숫자만 "수량을 명시한 것"으로 인정함(예: "300개", "50명"). 단위 없는 숫자는 무시.
var QTY_UNIT_PATTERN = /(\d+)\s*(개|명|세트|박스|건)/;
function _extractQtyWithUnit(text) {
  var m = String(text || '').match(QTY_UNIT_PATTERN);
  return m ? parseInt(m[1], 10) : null;
}

// 텍스트에서 "개수 단위가 붙은" 숫자를 찾아 QTY_STANDARD_OPTIONS(50, 100~3000 100단위)에 정확히
// 일치할 때만 반환(단위 없는 숫자는 애초에 후보로 안 봄 — 없으면 null)
function _matchQtyNumber(text) {
  var n = _extractQtyWithUnit(text);
  if (n == null) return null;
  return QTY_STANDARD_OPTIONS.indexOf(n) !== -1 ? n : null;
}

// 텍스트에서 "10:00"/"10시"/"오후 2시" 등의 시간 표현을 찾아 00:00~23:00(1시간 단위)에 맞으면
// "HH:00" 형태로 반환(없거나 범위 밖이면 null) — 오전/오후·AM/PM 표기를 24시간제로 환산함.
// 분이 "00"이 아닌 값(예: "10:30", "10시 30분")은 드롭다운이 1시간 단위라 억지로 반올림하지 않고
// 확신 매칭 실패로 처리함 — 그래야 호출부가 원문을 신규 비고에 그대로 보존해 정밀도 유실을 막음.
function _matchOpenTime(text) {
  var t = String(text || '');
  var hour = null, minute = 0;
  var mColon = t.match(/(\d{1,2}):(\d{2})/);
  var mHour = !mColon ? t.match(/(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/) : null;
  if (mColon) { hour = parseInt(mColon[1], 10); minute = parseInt(mColon[2], 10); }
  else if (mHour) { hour = parseInt(mHour[1], 10); minute = mHour[2] ? parseInt(mHour[2], 10) : 0; }
  if (hour == null) return null;
  if (minute !== 0) return null;
  var isPM = /오후|PM/i.test(t);
  var isAM = /오전|AM/i.test(t);
  if (isPM && hour < 12) hour += 12;
  if (isAM && hour === 12) hour = 0;
  if (hour === 24) hour = 0; // "24:00"은 00:00과 같은 시각 — 드롭다운이 00:00~23:00이므로 0시로 통일(2026-08-27)
  if (hour < 0 || hour > 23) return null;
  return _pad(hour) + ':00';
}

// 텍스트에서 "NPAY 2만원" 류 표현을 찾아 POINTS_OPTIONS 중 하나로 정규화(없으면 null)
function _matchPoints(text) {
  var m = String(text || '').match(/NPAY\s*([1-5])\s*만\s*원/i);
  return m ? ('NPAY ' + m[1] + '만원') : null;
}

// 접근 제어
var REQUIRE_AUTH   = true;
var ALLOWED_DOMAIN = 'athomecorp.com';

/* 구글 로그인 클라이언트 ID — 프론트(GAS_CLIENT_ID)와 **반드시 같은 값**이어야 한다.
   ID 토큰 검증에서 aud를 이 값과 대조하는 데 쓴다. 이게 없으면 "다른 사이트에서 발급된, 서명은
   진짜인 구글 ID 토큰"으로도 우리 서버에 들어올 수 있다(혼동된 대리자 문제). */
var GAS_CLIENT_ID = '379680980952-vcvtnv1le4lmma2f0gv6snita17ve7bd.apps.googleusercontent.com';

/* ── 자체 세션 (2026-09-16) ────────────────────────────────────────────────────
   구글 ID 토큰은 수명이 1시간이고, 갱신 수단(One Tap 조용한 재인증)이 iframe·쿠키 정책·One Tap
   쿨다운에 막혀 자주 실패했다. 그래서 구글 로그인은 **신원 확인 1회**에만 쓰고, 그 뒤로는
   우리가 발급한 세션 토큰으로 인증한다.

   저장소를 시트로 둔 이유: CacheService는 최대 6시간이라 절대 만료 12시간을 담지 못하고,
   무엇보다 로그아웃(즉시 무효화)을 보장할 수 없다. 세션은 몇 십 행 수준이라 시트로 충분하다. */
var SESSION_SHEET = '_sessions';
/* 차단 목록(선택) — **없는 게 기본이다.** 시트가 존재할 때만 그 A열의 이메일을 거부한다.
   허용 목록(화이트리스트) 방식을 쓰지 않는 이유: 이 대시보드는 앳홈 구성원 전원이 쓰는 도구라
   누가 들어올지 미리 적어두는 비용이 계속 발생하고, 신규 입사자가 매번 막힌다.
   도메인(hd)과 이메일 인증 여부는 구글이 보증하므로 그것으로 충분하고, 예외적으로 특정 인원을
   막아야 할 때만 이 시트를 손으로 만든다. */
var BLOCKED_USERS_SHEET = '_blocked_users';
var SESSION_COL = { sid: 0, email: 1, name: 2, issuedAt: 3, expiresAt: 4, lastSeenAt: 5 };

var SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000; // 발급 후 12시간이면 무조건 만료
var SESSION_IDLE_MS     =  2 * 60 * 60 * 1000; // 마지막 사용 후 2시간 미사용이면 만료
var SESSION_SLIDE_MS    =  6 * 60 * 60 * 1000; // 남은 절대 만료가 이보다 적으면 새 토큰을 실어 연장
/* lastSeenAt을 매 요청 갱신하면 요청마다 시트 쓰기가 1회 늘어난다(하트비트가 45초마다 오므로
   사용자 수만큼 곱해진다). 미사용 판정 기준이 2시간이라 1분 단위 정밀도면 차고 넘치므로,
   이 간격보다 최근에 쓴 값이면 건너뛴다 — 판정에는 영향이 없고 쓰기만 줄어든다. */
var SESSION_TOUCH_MIN_INTERVAL_MS = 60 * 1000;

// 현재 서명에 쓰는 키 버전. 키를 교체할 땐 Script Properties에 SESSION_SECRET_V2를 넣고 이 값을 2로
// 올린다 — V1로 서명된 기존 토큰은 계속 검증되다가 자연 만료되므로 전원 재로그인이 필요 없다.
var SESSION_KEY_VERSION = 1;

// 관리자 전용 기능(시트 연결/디버그 정보 노출)을 쓸 수 있는 계정 — 나중에 추가할 수 있게 배열로 관리.
// 프론트의 ADMIN_EMAILS(index.html)와 반드시 같은 값으로 유지할 것 — 여긴 실제 서버 검증용, 그쪽은 UI 표시용.
var ADMIN_EMAILS = ['p_dh_3678@athomecorp.com'];

// 이 대시보드는 Minix 전용입니다 — 브랜드열 값이 아래 목록에 없으면 해당 행은 제외됩니다
var MINIX_ALIASES = { '미닉스': true, 'minix': true, 'Minix': true, 'MINIX': true };

// 캘린더 "프로모션/이벤트 일정" 전용 시트 — 실적통합과 완전히 분리되어 실적/KPI/품목별 실적에 집계되지 않음
// 탭이 없으면 최초 저장 시 _ensureEventSheet가 헤더까지 자동 생성함
var EVENT_SHEET = '캘린더이벤트';
var EVENT_COL = { name: 0, start: 1, end: 2, note: 3 }; // A 이벤트명 / B 시작일 / C 종료일 / D 메모
var EVENT_DATA_START_ROW = 1; // 0-based index — 1행(index 0)은 헤더, 2행부터 데이터

// "회고" 문서 전용 시트 — 실적통합과 완전히 분리되어 대시보드/품목별 실적 집계에 전혀 영향을 주지
// 않음. 탭이 없으면 최초 저장 시 _ensureReviewSheet가 헤더까지 자동 생성함(캘린더이벤트와 동일 패턴).
var REVIEW_SHEET = '회고';
var REVIEW_COL = { id: 0, title: 1, ym: 2, owner: 3, team: 4, part: 5, body: 6, updatedAt: 7, editedBy: 8 };
var REVIEW_DATA_START_ROW = 1; // 0-based index — 1행(index 0)은 헤더, 2행부터 데이터
// 본문(Editor.js JSON 문자열)이 시트 셀당 50,000자 제한을 넘지 않도록 분할 저장하는 기준.
// 첫 조각은 기존 '본문'(G열)에, 나머지는 J열('본문2')부터 순서대로 이어 씀 — 읽을 때 전부 이어붙임.
var REVIEW_BODY_CHUNK_MAX = 45000;
var REVIEW_BODY_EXTRA_START_COL = 10; // 1-based — J열('본문2')부터 오버플로우

// doGet 응답 캐시 — 실적통합 파싱이 무거워서(수 초), 여러 사용자가 짧은 간격으로 새로고침할 때
// 실행 시간·동시 실행 한도 부담이 커짐. 계산 결과를 스크립트 캐시에 잠깐 담아두고 그 안에서는
// 재계산 없이 그대로 돌려줌. 데이터를 바꾸는 doPost 액션은 성공 시 _invalidateDashboardCache()로 즉시 무효화함.
var DASHBOARD_CACHE_TTL_SEC = 60;
var CACHE_CHUNK_SIZE = 30000; // CacheService 값 상한(100KB/키)을 한글 멀티바이트 감안해 안전하게 피하려고 청크 분할

// 이번 doGet/doPost 호출이 시작된 시각 — _json()이 모든 응답에 execMs를 붙여주는 기준점.
// 요청마다 doGet/doPost 진입 시 새로 설정됨(전역이지만 Apps Script는 요청당 별도 실행이라 안전).
var _reqStartMs = 0;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 인증 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/* 2026-09-16 전면 교체. 예전 구조의 문제는 두 가지였다.

   ① 구글 ID 토큰을 **서명 검증 없이** base64 디코드만 해서 exp/email/hd를 읽었다. 웹앱 액세스
      권한이 "모든 사용자(익명 포함)"이고 /exec 주소가 공개 HTML에 박혀 있으므로, 아무나
      {"email":"...@athomecorp.com","hd":"athomecorp.com","exp":<미래>} 를 base64로 만들어 붙이면
      시트 전체를 읽고 쓸 수 있었다. 서명·aud·iss 중 무엇도 확인하지 않았다.
   ② 그 토큰의 수명이 1시간인데 갱신이 One Tap 하나에만 의존해 자주 실패했다(iframe에서는 아예
      뜨지 않아 임베드 모드에서는 100% 실패).

   이제 구글 로그인은 **신원 확인 1회**에만 쓴다(tokeninfo로 서명까지 검증). 그 뒤로는 우리가
   서명한 세션 토큰으로 인증한다. */

// ── 서명 키 ──
/* 비밀키는 Script Properties에만 둔다(코드·저장소에 넣지 않는다). 없으면 예외를 던져서
   "검증이 조용히 통과"하는 일이 절대 없게 한다 — 인증 코드에서 가장 위험한 실패 방식이다. */
function _sessionSecret(keyVersion) {
  var name = 'SESSION_SECRET_V' + keyVersion;
  var v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error('세션 비밀키가 없습니다: Script Properties에 ' + name + ' 를 추가하세요.');
  return v;
}

function _b64u(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}
function _b64uToString(s) {
  var t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Utilities.newBlob(Utilities.base64Decode(t)).getDataAsString();
}
/* 길이·내용이 같은지를 **일찍 빠져나오지 않고** 비교 — 서명 비교에서 조기 반환하면 일치하는
   접두사 길이가 응답 시간으로 새어나간다(타이밍 공격). 인증 경로라 습관적으로 상수 시간으로 둔다.

   ⚠ 반드시 charCodeAt으로 비교할 것. 문자열 인덱싱 결과끼리 XOR하면("a" ^ "b") 양쪽이 숫자로
      강제 변환되며 0 ^ 0 = 0이 되어, **길이만 같으면 무엇이든 일치로 판정된다**. 그러면 서명
      검증이 통째로 무력해진다(2026-09-16 최초 구현에서 실제로 이랬고 테스트가 잡았다). */
function _constantTimeEquals(a, b) {
  var sa = String(a), sb = String(b);
  if (sa.length !== sb.length) return false;
  var diff = 0;
  for (var i = 0; i < sa.length; i++) diff |= (sa.charCodeAt(i) ^ sb.charCodeAt(i));
  return diff === 0;
}

// 세션 토큰 = base64url(payload JSON) + '.' + base64url(HMAC-SHA256(payload, secret))
function _signSessionToken(payload) {
  var body = _b64u(Utilities.newBlob(JSON.stringify(payload)).getBytes());
  var mac = Utilities.computeHmacSha256Signature(body, _sessionSecret(payload.kv));
  return body + '.' + _b64u(mac);
}

/* 토큰 문자열 → { ok, payload, reason }.
   reason: 'missing' | 'malformed' | 'badsig' | 'expired' | 'keymissing'
   ⚠ 여기서는 **서명과 exp만** 본다. 세션이 실제로 살아 있는지(로그아웃·미사용 만료)는
      시트를 봐야 알 수 있고, 그건 _authRequest가 이어서 확인한다. */
function _verifySessionToken(token) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  var parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  var payload;
  try { payload = JSON.parse(_b64uToString(parts[0])); }
  catch (e) { return { ok: false, reason: 'malformed' }; }
  if (!payload || !payload.sid || !payload.email || !payload.exp) return { ok: false, reason: 'malformed' };

  var kv = payload.kv || 1;
  var expected;
  try { expected = Utilities.computeHmacSha256Signature(parts[0], _sessionSecret(kv)); }
  catch (e) { return { ok: false, reason: 'keymissing' }; }   // 그 버전의 키가 없음 = 검증 불가
  if (!_constantTimeEquals(_b64u(expected), parts[1])) return { ok: false, reason: 'badsig' };

  if (payload.exp < Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, payload: payload };
}

// ── 세션 시트 ──
function _sessionSheet(ss) {
  var sheet = ss.getSheetByName(SESSION_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SESSION_SHEET);
    sheet.getRange(1, 1, 1, 6)
      .setValues([['sessionId', 'email', 'name', 'issuedAt', 'expiresAt', 'lastSeenAt']])
      .setFontWeight('bold');
    sheet.setFrozenRows(1);
    try { sheet.hideSheet(); } catch (e) {}
    Logger.log('[세션] ' + SESSION_SHEET + ' 시트를 새로 만들었습니다');
  }
  return sheet;
}

/* 차단 이메일 목록. **시트가 없으면 빈 목록**(= 아무도 차단하지 않음)이고, 없다고 만들지 않는다.
   차단이 필요할 때만 사람이 '_blocked_users' 시트를 손으로 만들고 A열에 이메일을 적는다.

   ⚠ 시트를 자동 생성하지 않는 건 의도된 선택이다. 자동 생성하면 "차단 기능이 켜져 있다"는
      인상을 주고, 빈 시트를 보고 거기에 **허용할** 사람을 적는 오해가 실제로 생긴다.
      (그렇게 적으면 그 사람들만 정확히 차단된다 — 조용히 반대로 동작하는 최악의 실수다.)

   헤더 행 유무를 따지지 않고 A열 전체를 훑는다. 사람이 손으로 만드는 시트라 헤더를 넣을지
   말지 알 수 없고, '@'가 없는 값은 어차피 이메일이 아니라 걸러진다. */
function _blockedEmails(ss) {
  var sheet = ss.getSheetByName(BLOCKED_USERS_SHEET);
  if (!sheet) return {};            // 시트 없음 = 제한 없음
  var last = sheet.getLastRow();
  if (last < 1) return {};
  var vals = sheet.getRange(1, 1, last, 1).getValues();
  var out = {};
  for (var i = 0; i < vals.length; i++) {
    var em = String(vals[i][0] || '').trim().toLowerCase();
    if (em && em.indexOf('@') > 0) out[em] = true;   // 'email' 같은 헤더 문자열은 자연히 걸러진다
  }
  return out;
}

// sid로 세션 행을 찾는다 — 세션 수가 적어 선형 탐색으로 충분하다. { rowIndex, row } 또는 null
function _findSessionRow(sheet, sid) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var vals = sheet.getRange(2, 1, last - 1, 6).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][SESSION_COL.sid] || '') === sid) return { rowIndex: i + 2, row: vals[i] };
  }
  return null;
}

// 만료된(절대/미사용) 세션 행을 지운다. 로그인 때만 돌려서 시트가 무한정 커지지 않게 한다.
function _pruneSessions(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var vals = sheet.getRange(2, 1, last - 1, 6).getValues();
  var now = Date.now();
  var dead = [];
  for (var i = 0; i < vals.length; i++) {
    var exp = Number(vals[i][SESSION_COL.expiresAt]) || 0;
    var seen = Number(vals[i][SESSION_COL.lastSeenAt]) || 0;
    if (!vals[i][SESSION_COL.sid] || now > exp || (seen && now - seen > SESSION_IDLE_MS)) dead.push(i + 2);
  }
  for (var d = dead.length - 1; d >= 0; d--) sheet.deleteRow(dead[d]);
  if (dead.length) Logger.log('[세션] 만료 세션 ' + dead.length + '건 정리');
  return dead.length;
}

/* 로그인 경로 진단 (2026-09-17) — 편집기에서 diagLogin()을 직접 실행한다. **배포 불필요**.
   로그인이 'verify_failed'로 떨어질 때, 웹앱 로그를 뒤지는 대신 원인을 한 번에 보려고 만들었다.

   편집기 실행은 **지금 편집기에 로그인한 사람의 권한**으로 돌고, 웹앱은 **배포 시점에 부여된
   권한**으로 돈다. 그래서 이 둘의 결과가 갈리는지가 그 자체로 답이다:
     · 여기서도 실패        → 스코프/네트워크 등 진짜 문제
     · 여기선 성공, 웹앱만 실패 → 배포본의 권한이 낡음(재배포하며 동의해야 함) */
function diagLogin() {
  Logger.log('--- diagLogin 시작 ---');
  var secret = PropertiesService.getScriptProperties().getProperty('SESSION_SECRET_V1');
  Logger.log('SESSION_SECRET_V1: ' + (secret ? '있음(길이 ' + secret.length + ')' : '❌ 없음'));

  var t0 = Date.now();
  try {
    var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=dummy',
      { muteHttpExceptions: true });
    // 400 + invalid_token 본문이 정상이다(더미 토큰이므로). 여기까지 오면 UrlFetch는 멀쩡하다.
    Logger.log('✅ UrlFetchApp 정상 — HTTP ' + res.getResponseCode() + ' (' + (Date.now() - t0) + 'ms)');
    Logger.log('   본문: ' + String(res.getContentText()).slice(0, 200));
  } catch (e) {
    Logger.log('❌ UrlFetchApp 예외 (' + (Date.now() - t0) + 'ms)');
    Logger.log('   원문: ' + e);
    Logger.log('   스택: ' + (e && e.stack));
  }
  Logger.log('--- diagLogin 끝 ---');
}

// ── 구글 ID 토큰 검증 (로그인 1회) ──
/* tokeninfo는 구글이 서명까지 확인해 클레임을 돌려주는 엔드포인트다. 자체 JWK 캐싱보다 느리지만
   로그인 시 1회만 타므로 문제되지 않고, 키 롤오버를 구글이 알아서 처리해 준다.
   반환: { ok, email, name, reason } */
function _verifyGoogleIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return { ok: false, reason: 'missing' };
  var res;
  try {
    res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true });
  } catch (e) {
    Logger.log('[로그인] tokeninfo 호출 실패: ' + e);
    return { ok: false, reason: 'verify_failed' };
  }
  if (res.getResponseCode() !== 200) return { ok: false, reason: 'invalid' };

  var info;
  try { info = JSON.parse(res.getContentText()); } catch (e) { return { ok: false, reason: 'invalid' }; }

  // aud — 이 토큰이 **우리 클라이언트용으로** 발급됐는가. 빠뜨리면 남의 사이트 토큰도 통과한다.
  if (String(info.aud || '') !== GAS_CLIENT_ID) return { ok: false, reason: 'aud' };
  // iss — 구글이 발급했는가
  var iss = String(info.iss || '');
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') return { ok: false, reason: 'iss' };
  // exp — tokeninfo가 만료 토큰을 400으로 막아주지만, 응답을 그대로 믿지 않고 한 번 더 본다
  if (!info.exp || Number(info.exp) * 1000 < Date.now()) return { ok: false, reason: 'expired' };
  // email_verified — tokeninfo는 문자열 'true'로 주는 경우가 있어 둘 다 받는다
  var verified = (info.email_verified === true || String(info.email_verified) === 'true');
  if (!verified) return { ok: false, reason: 'unverified' };

  var email = String(info.email || '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'invalid' };
  var hd = String(info.hd || '').trim().toLowerCase();
  if (hd !== ALLOWED_DOMAIN.trim().toLowerCase()) return { ok: false, reason: 'domain' };

  return { ok: true, email: email, name: String(info.name || info.email || ''), reason: null };
}

// ── 로그인 / 로그아웃 ──
/* 구글 ID 토큰 1개를 받아 검증하고 세션을 발급한다. 이 액션만 세션 없이 호출할 수 있다. */
function _login(ss, idToken) {
  var v = _verifyGoogleIdToken(idToken);
  if (!v.ok) {
    Logger.log('[로그인 거절] 사유=' + v.reason); // 토큰 값은 절대 남기지 않는다
    return _json({ error: 'LOGIN_REJECTED', reason: v.reason });
  }
  /* 여기까지 왔다는 건 구글이 서명한 토큰이고, hd가 athomecorp.com이며, 이메일이 인증됐다는 뜻이다
     (_verifyGoogleIdToken에서 전부 확인). 앳홈 구성원이면 그것으로 충분하다. */
  if (_blockedEmails(ss)[v.email]) {
    Logger.log('[로그인 거절] 차단 목록 — ' + v.email);
    return _json({ error: 'LOGIN_REJECTED', reason: 'blocked', email: v.email });
  }

  var sheet = _sessionSheet(ss);
  _pruneSessions(sheet);

  var now = Date.now();
  var sid = Utilities.getUuid();
  var expiresAt = now + SESSION_ABSOLUTE_MS;
  sheet.appendRow([sid, v.email, v.name, now, expiresAt, now]);

  var token = _signSessionToken({ sid: sid, email: v.email, name: v.name, exp: expiresAt, iat: now, kv: SESSION_KEY_VERSION });
  Logger.log('[로그인] ' + v.email + ' / sid=' + sid.slice(0, 6));
  return _json({
    success: true, sessionToken: token,
    user: { email: v.email, name: v.name, isAdmin: _isAdminEmail(v.email) },
    expiresAt: expiresAt
  });
}

function _logout(ss, auth) {
  var sheet = _sessionSheet(ss);
  var found = _findSessionRow(sheet, auth.sessionId);
  if (found) sheet.deleteRow(found.rowIndex);
  Logger.log('[로그아웃] ' + auth.email + ' / sid=' + String(auth.sessionId).slice(0, 6));
  return _json({ success: true });
}

/* 관리자용 — 편집기에서 직접 실행. 모든 세션을 끊어 전원 재로그인시킨다.
   비밀키가 유출됐다고 의심될 때는 이것만으로 부족하다: Script Properties의 SESSION_SECRET_V1을
   새 값으로 바꾸면 기존 토큰은 전부 서명 검증에서 떨어진다(시트 삭제보다 확실하다). */
function revokeAllSessions() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _sessionSheet(ss);
  var last = sheet.getLastRow();
  if (last < 2) { Logger.log('[세션] 끊을 세션이 없습니다'); return 0; }
  var count = last - 1;
  sheet.deleteRows(2, count);
  Logger.log('[세션] 전체 ' + count + '건 종료 — 모든 사용자가 다시 로그인해야 합니다');
  return count;
}

/* 특정 사용자의 세션만 끊는다 — 편집기에서 revokeUserSessions('someone@athomecorp.com') */
function revokeUserSessions(email) {
  var target = String(email || '').trim().toLowerCase();
  if (!target) { Logger.log('[세션] 이메일을 지정하세요'); return 0; }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _sessionSheet(ss);
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var vals = sheet.getRange(2, 1, last - 1, 6).getValues();
  var dead = [];
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][SESSION_COL.email] || '').trim().toLowerCase() === target) dead.push(i + 2);
  }
  for (var d = dead.length - 1; d >= 0; d--) sheet.deleteRow(dead[d]);
  Logger.log('[세션] ' + target + ' 세션 ' + dead.length + '건 종료');
  return dead.length;
}

// ── 요청 인증 ──
/* 이번 응답에 실어 보낼 새 세션 토큰(슬라이딩 연장). _json이 모든 응답에 자동으로 붙인다 —
   반환 지점이 수십 군데라 호출부마다 챙기게 하면 반드시 빠뜨리는 곳이 생긴다. */
var _renewedSessionToken = null;

/* 요청 → { ok, email, name, sessionId, reason }
   reason: 'missing' | 'malformed' | 'badsig' | 'expired' | 'keymissing' | 'revoked' | 'idle' */
function _authRequest(ss, e) {
  if (!REQUIRE_AUTH) return { ok: true, email: '', name: '', sessionId: '' };
  var token = (e && e.parameter) ? (e.parameter.session || '') : '';
  var v = _verifySessionToken(token);
  if (!v.ok) return { ok: false, reason: v.reason };

  var sheet = _sessionSheet(ss);
  var found = _findSessionRow(sheet, v.payload.sid);
  if (!found) return { ok: false, reason: 'revoked' };  // 로그아웃됐거나 정리된 세션

  var now = Date.now();
  var expiresAt = Number(found.row[SESSION_COL.expiresAt]) || 0;
  var lastSeen = Number(found.row[SESSION_COL.lastSeenAt]) || 0;
  if (now > expiresAt) return { ok: false, reason: 'expired' };
  if (lastSeen && now - lastSeen > SESSION_IDLE_MS) return { ok: false, reason: 'idle' };

  // 마지막 사용 갱신 — 너무 잦은 쓰기를 피해 1분 간격으로만(위 SESSION_TOUCH_MIN_INTERVAL_MS 주석)
  if (now - lastSeen >= SESSION_TOUCH_MIN_INTERVAL_MS) {
    sheet.getRange(found.rowIndex, SESSION_COL.lastSeenAt + 1).setValue(now);
  }

  // 슬라이딩 연장 — 남은 절대 만료가 얼마 없으면 새 토큰을 발급해 응답에 실어 보낸다
  if (expiresAt - now < SESSION_SLIDE_MS) {
    var newExp = now + SESSION_ABSOLUTE_MS;
    sheet.getRange(found.rowIndex, SESSION_COL.expiresAt + 1).setValue(newExp);
    _renewedSessionToken = _signSessionToken({
      sid: v.payload.sid, email: v.payload.email, name: v.payload.name || '',
      exp: newExp, iat: now, kv: SESSION_KEY_VERSION
    });
  }

  return {
    ok: true,
    email: String(found.row[SESSION_COL.email] || v.payload.email),
    name: String(found.row[SESSION_COL.name] || v.payload.name || ''),
    sessionId: v.payload.sid
  };
}

// 관리자 판정 — 세션에서 확인된 이메일로만 본다(토큰 클레임을 그대로 믿지 않는다)
function _isAdminEmail(email) {
  var em = String(email || '').trim().toLowerCase();
  for (var i = 0; i < ADMIN_EMAILS.length; i++) {
    if (ADMIN_EMAILS[i].trim().toLowerCase() === em) return true;
  }
  return false;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── doGet ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function doGet(e) {
  var _t0 = Date.now();
  _reqStartMs = _t0;
  try {
    /* 실행 기록(Executions)에 "이런 요청이 왔었다"는 사실은 항상 남긴다. 다만 **파라미터 키만**
       남기고 값은 절대 남기지 않는다 — 여기엔 세션 토큰과 구글 ID 토큰이 실려 오고, 실행 로그는
       스크립트 접근 권한이 있는 사람 모두가 본다. 로그에 남은 토큰은 그 자체로 유효한 자격증명이다. */
    Logger.log('[doGet 진입] action=' + (e && e.parameter ? (e.parameter.action || '(없음, 조회 요청)') : '(e.parameter 없음)') +
      ' / 파라미터 키=' + (e && e.parameter ? Object.keys(e.parameter).join(',') : '(없음)'));

    _renewedSessionToken = null; // 요청마다 초기화(전역이지만 Apps Script는 요청당 별도 실행이라 안전)
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    // 로그인만 세션 없이 호출할 수 있다 — 세션을 받으러 오는 요청이므로 당연히 세션이 없다
    if (e && e.parameter && e.parameter.action === 'login') {
      return _login(ss, e.parameter.idToken || '');
    }

    var auth = _authRequest(ss, e);
    if (!auth.ok) return _json({ error: 'AUTH_REQUIRED', reason: auth.reason });

    if (e && e.parameter && e.parameter.action === 'logout') return _logout(ss, auth);

    // ⚠ 2026-07-29: 저장/수정/삭제 등 쓰기 액션을 doPost가 아니라 여기 doGet으로 라우팅함 — POST가
    // Apps Script의 302 리다이렉트 처리에서 본문을 통째로 유실시키는 문제가 여러 형태(JSON body,
    // 폼 인코딩 body)로 재현됐고, 한 번도 실패한 적 없는 이 GET 파이프라인을 그대로 재사용하는 게
    // 가장 검증된 방법이었음. 인증은 위에서 이미 확인됐으므로 별도 재검증 없이 바로 처리 함수로 감.
    if (e && e.parameter && e.parameter.action) {
      // _handleWriteAction 자체에 이미 try-catch가 있지만(그 catch 블록 안에서 또 예외가 나는
      // 극단적인 경우까지 포함해서), 쓰기 분기에서 발생하는 어떤 예외든 절대 doGet 밖으로 조용히
      // 새어나가지 않고 반드시 JSON으로 응답하도록 여기서 한 번 더 감쌈(요청받은 이중 방어).
      try {
        return _handleWriteAction(e, auth);
      } catch (writeErr) {
        Logger.log('[doGet 쓰기 최종방어] action=' + e.parameter.action + ' / 에러=' + writeErr +
          ' / 스택=\n' + (writeErr && writeErr.stack));
        return _json({ error: writeErr.toString(), action: e.parameter.action, stack: (writeErr && writeErr.stack) || '' });
      }
    }

    // 썸네일 프록시: 개별 Drive 파일을 사용자에게 직접 공유하는 대신, 스크립트 소유자 권한으로
    // 파일을 읽어 내려줌 — 조직 정책(링크 공유 차단)과 무관하게 항상 접근 가능.
    // Blob을 doGet에서 직접 반환하면 구글이 파일을 googleusercontent.com으로 302 리다이렉트해서
    // 내려주는데, 그 응답엔 Access-Control-Allow-Origin이 없어 fetch()가 CORS로 막힘.
    // fetchLive와 완전히 동일한 _json() 파이프라인(ContentService JSON)을 타면 CORS도 똑같이
    // 통과하므로, 이미지를 base64로 인코딩해 JSON으로 응답하고 프론트가 data URL로 변환해 씀.
    if (e && e.parameter && e.parameter.thumb) {
      return _thumbAsJson(e.parameter.thumb);
    }

    // 회고 문서 목록/상세 — 실적통합 파싱/캐시와 완전히 별개 경로(가벼운 요청이라 캐시 불필요).
    if (e && e.parameter && e.parameter.review) {
      return _handleReviewGet(e.parameter.review, e.parameter.id || '');
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();

    var sheet = ss.getSheetByName(MAIN_SHEET);
    if (!sheet) {
      var allNames = ss.getSheets().map(function (s) { return s.getName(); });
      throw new Error('데이터 시트를 찾을 수 없습니다. 현재 시트 목록: ' + allNames.join(', '));
    }

    // 디버그 엔드포인트(?debug=...)는 시트 연결정보/원시 데이터를 그대로 노출하므로 관리자 전용.
    if (e && e.parameter && e.parameter.debug) {
      if (!_isAdminEmail(auth.email)) return _json({ error: 'ADMIN_REQUIRED' });

      // ?debug=reels&row=123 으로 호출 시 해당 행의 릴스 슬롯/썸네일 원본 상태를 그대로 반환
      if (e.parameter.debug === 'reels' && e.parameter.row) {
        _resolveCols(sheet); // 릴스 슬롯 위치(REEL_COL_START)가 필요하므로 이 분기만 먼저 해석
        return _json(_debugReelsRaw(sheet, parseInt(e.parameter.row, 10)));
      }

      // ?debug=1 — 이 배포본이 실제로 어느 스프레드시트/탭을 읽고 있는지, 원시 헤더/데이터 몇 줄,
      // 필터링 통계(브랜드/제품 없음으로 제외된 행 수 등)를 그대로 보여줌. 데이터가 안 나올 때 1차 진단용.
      if (e.parameter.debug === '1') {
        return _json(_debugRawDump(ss, sheet));
      }
    }

    // 여기서부터 COL이 필요함 — 2행 헤더를 읽어 열 인덱스를 해석한다(_resolveCols 주석 참고).
    // ⚠ 일부러 위 디버그 분기보다 "뒤"에 둠: 헤더 문구가 코드와 어긋나 해석이 실패하는 상황이야말로
    // ?debug=1의 실제 2행 헤더 덤프가 가장 필요한 때라, 그 진단 경로까지 같이 죽으면 안 되기 때문.
    _resolveCols(sheet);

    // ?nocache=1이면 캐시를 건너뛰고 항상 새로 계산(수동 새로고침 버튼용)
    var noCache = !!(e && e.parameter && e.parameter.nocache === '1');
    var cache = CacheService.getScriptCache();
    var cacheKey = _dashboardCacheKey();
    var payload = noCache ? null : _cacheGetJSON(cache, cacheKey);
    var fromCache = !!payload;

    if (!payload) {
      _ensureExtraHeaders(sheet);

      var result = parseMainSheet(sheet);

      // dealId 없는 행 자동 백필 — 사람이 시트에 직접 새 행을 추가한 경우(dealId 미기입) 대비.
      // 이 시점엔 이미 각 행이 parseMainSheet에서 "단독 그룹"으로 취급됐으므로, 그 자리에 새
      // dealId+codeSeq=1을 채워주기만 하면 됨(다른 행과의 관계를 새로 계산할 필요 없음).
      _autoFillMissingDealIds(sheet, result.deals);

      var calendarEvents = _loadCalendarEvents(ss);

      payload = { purchases: result.deals, calendarEvents: calendarEvents, updatedAt: new Date().toISOString(), version: SCRIPT_VERSION };
      _cachePutJSON(cache, cacheKey, payload, DASHBOARD_CACHE_TTL_SEC);

      // 열 재배치 검증용 — 첫 행이 실제로 올바른 열에서 읽혔는지 확인(공구가/매출/시작일/조회수/
      // 상품코드/비고). 값이 시트와 다르면 COL 매핑이 어긋난 것이니 바로 확인할 것.
      if (result.deals.length) {
        var d0 = result.deals[0];
        Logger.log('[열 매핑 검증] 첫 행 — product=' + d0.product + ', salePrice=' + d0.sale +
          ', revenue=' + d0.revenue + ', startMD=' + d0.start + ', views=' + d0.views +
          ', code=' + JSON.stringify(d0.codes) + ', note=' + d0.note);
      }

      // 진행중 건 누락 진단용 — 상태별 건수를 세어서 KPI(진행 중 건수)와 대조할 수 있게 함.
      // 이 합계가 시트에서 눈으로 센 상태별 행 수와 다르면 위 [파싱 진단]/[dealId 불일치 분리]/
      // [상태값 미매칭] 로그에서 어느 행이 어떤 이유로 빠졌는지 확인할 것.
      var statusCounts = {};
      for (var si2 = 0; si2 < result.deals.length; si2++) {
        var st2 = result.deals[si2].status;
        statusCounts[st2] = (statusCounts[st2] || 0) + 1;
      }
      Logger.log('[상태별 건수 검증] 전체 공구건=' + result.deals.length + ' / ' + JSON.stringify(statusCounts));
    }

    payload.cached = fromCache;
    payload.execMs = Date.now() - _t0;
    Logger.log('doGet 완료: ' + payload.execMs + 'ms' + (fromCache ? ' (캐시 히트, TTL ' + DASHBOARD_CACHE_TTL_SEC + '초)' : ' (새로 계산)'));
    return _json(payload);
  } catch (err) {
    return _json({ error: err.toString(), purchases: [], execMs: Date.now() - _t0 });
  }
}

// ── doGet 응답 캐시(CacheService) — 100KB/키 제한을 피하려고 청크로 쪼개서 저장 ──
function _dashboardCacheKey() {
  return 'dashboardData_' + SCRIPT_VERSION;
}

function _cachePutJSON(cache, key, obj, ttlSec) {
  try {
    var str = JSON.stringify(obj);
    var chunks = [];
    for (var i = 0; i < str.length; i += CACHE_CHUNK_SIZE) chunks.push(str.slice(i, i + CACHE_CHUNK_SIZE));
    var payload = {};
    payload[key + ':meta'] = String(chunks.length);
    for (var c = 0; c < chunks.length; c++) payload[key + ':' + c] = chunks[c];
    cache.putAll(payload, ttlSec);
  } catch (e) {
    Logger.log('캐시 저장 실패 (무시): ' + e);
  }
}

function _cacheGetJSON(cache, key) {
  try {
    var metaStr = cache.get(key + ':meta');
    if (!metaStr) return null;
    var n = parseInt(metaStr, 10);
    var keys = [];
    for (var c = 0; c < n; c++) keys.push(key + ':' + c);
    var got = cache.getAll(keys);
    var parts = [];
    for (var c2 = 0; c2 < n; c2++) {
      var part = got[key + ':' + c2];
      if (part == null) return null; // 일부 청크만 만료/누락이면 전체를 무효로 취급
      parts.push(part);
    }
    return JSON.parse(parts.join(''));
  } catch (e) {
    Logger.log('캐시 조회 실패 (무시): ' + e);
    return null;
  }
}

/* 저장한 건 하나만 캐시에서 갈아끼움 (2026-09-15).
   기존에는 저장할 때마다 대시보드 캐시를 통째로 버렸고, 그러면 그 다음 조회가 시트 전체 재파싱
   (운영 기준 4만 셀 이상)을 떠안았다. 바뀐 건 한 건인데 전체를 버리는 게 아까워서, 캐시된
   payload에서 그 dealId만 찾아 필드를 덮어쓴다.

   ⚠ 안전이 속도보다 우선이다. 캐시가 실제 시트와 조용히 어긋나면 "남들 화면에만 옛날 값이 보이는"
   가장 찾기 힘든 종류의 버그가 된다. 그래서 아래 조건이 하나라도 걸리면 부분 갱신을 포기하고
   기존처럼 전체 무효화로 떨어진다(느릴 뿐 항상 정확함):
     · 핸들러가 cachePatch를 만들지 않은 액션 (신규 등록/삭제/릴스/상품코드 변경 등 — 행 구성이
       바뀌면 건 단위 조립을 다시 해야 하므로 필드 덮어쓰기로는 맞출 수 없음)
     · 파생값이 걸린 변경 (공구가·판매수량 → 총매출은 시트 수식, 시작일·종료일 → 연도/진행상태)
     · 캐시 자체가 없거나 그 dealId가 캐시에 없을 때 */
function _patchDashboardCache(resp) {
  if (!resp) return false;
  var extra = resp.cachePatches || null;
  if (!resp.cachePatch) {
    // 본문 변경 없이 전파만 일어난 경우도 캐시를 살려둘 수 있다
    return extra ? _patchCacheMany(extra) : false;
  }
  var p = resp.cachePatch;
  if (!p.dealId) return false;
  try {
    var cache = CacheService.getScriptCache();
    var payload = _cacheGetJSON(cache, _dashboardCacheKey());
    if (!payload || !payload.purchases) return false; // 캐시가 없으면 갱신할 대상도 없음
    var list = payload.purchases, hit = -1;
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].dealId || '') === p.dealId) { hit = i; break; }
    }
    if (hit < 0) return false;
    for (var k in p.fields) list[hit][k] = p.fields[k];
    if (p.tierRows) list[hit].tierRows = p.tierRows;
    if (resp.cachePatches) {
      for (var e = 0; e < resp.cachePatches.length; e++) {
        var ep = resp.cachePatches[e];
        for (var ei = 0; ei < list.length; ei++) {
          if (String(list[ei].dealId || '') !== ep.dealId) continue;
          for (var ek in ep.fields) list[ei][ek] = ep.fields[ek];
          break;
        }
      }
    }
    payload.updatedAt = new Date().toISOString();
    _cachePutJSON(cache, _dashboardCacheKey(), payload, DASHBOARD_CACHE_TTL_SEC);
    Logger.log('[캐시 부분 갱신] dealId=' + p.dealId + ' / 필드 ' + Object.keys(p.fields || {}).length +
      '개' + (resp.cachePatches ? ' / 전파 ' + resp.cachePatches.length + '건' : ''));
    return true;
  } catch (e) {
    Logger.log('캐시 부분 갱신 실패 → 전체 무효화로 대체: ' + e);
    return false;
  }
}

// 본문 변경 없이 전파만 있었던 경우 — 해당 건들만 갈아끼운다
function _patchCacheMany(patches) {
  try {
    var cache = CacheService.getScriptCache();
    var payload = _cacheGetJSON(cache, _dashboardCacheKey());
    if (!payload || !payload.purchases) return false;
    var list = payload.purchases, hit = 0;
    for (var e = 0; e < patches.length; e++) {
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].dealId || '') !== patches[e].dealId) continue;
        for (var k in patches[e].fields) list[i][k] = patches[e].fields[k];
        hit++; break;
      }
    }
    if (!hit) return false;
    payload.updatedAt = new Date().toISOString();
    _cachePutJSON(cache, _dashboardCacheKey(), payload, DASHBOARD_CACHE_TTL_SEC);
    Logger.log('[캐시 부분 갱신] 전파 ' + hit + '건');
    return true;
  } catch (e) {
    Logger.log('캐시 전파 갱신 실패 → 전체 무효화로 대체: ' + e);
    return false;
  }
}

/* updateDeal의 changes 키 → 캐시된 deal 객체의 필드명.
   여기 **없는 키가 하나라도 섞여 있으면** 부분 갱신을 통째로 포기한다(= 전체 무효화).
   일부러 뺀 것들과 이유:
     sale/comm/qty — 총매출이 시트 수식이라 서버가 그 결과를 알지 못함(다시 읽어야 함)
     start/end     — 연도·진행상태가 여기서 파생되므로 단순 덮어쓰기로는 정합이 안 맞음
     codes         — 행이 늘거나 줄어 건 단위 조립 자체가 달라짐 */
var CACHE_PATCH_FIELDS = {
  product: 'product', vendor: 'vendor', platform: 'platform', format: 'format',
  composition: 'composition', marketingLink: 'marketingLink', link: 'link',
  targetQty: 'targetQty', extraQty: 'extraQty', note: 'note', note2: 'note2',
  option1: 'option1', option2: 'option2', firstCome: 'firstCome', firstComeQty: 'firstComeQty',
  giftItem1: 'giftItem1', giftQty1: 'giftQty1', giftItem2: 'giftItem2', giftQty2: 'giftQty2',
  giftItem3: 'giftItem3', giftQty3: 'giftQty3',
  status: 'status', tier: 'tier', followers: 'followers'
};

/* 전파로 값이 바뀐 다른 공구건들의 캐시 패치 목록.
   전파는 "모든 대상 행에 같은 값"을 쓰므로 필드값이 전부 동일해서, dealId만 갈아끼우면 된다.
   편집 중인 건 자신은 별도 cachePatch가 이미 담당하므로 제외한다. */
function _buildChannelFieldPatches(prop, selfDealId) {
  var fields = {};
  for (var k in prop.byField) {
    if (!prop.byField[k]) continue; // 실제로 바뀐 게 없는 필드는 캐시도 건드릴 필요 없음
    fields[k] = prop.appliedValues ? prop.appliedValues[k] : undefined;
  }
  if (!Object.keys(fields).length) return null;
  var out = [];
  for (var i = 0; i < prop.dealIds.length; i++) {
    if (prop.dealIds[i] === selfDealId) continue;
    out.push({ dealId: prop.dealIds[i], fields: fields });
  }
  return out.length ? out : null;
}

function _buildCachePatch(dealId, changes, tierRows) {
  var fields = {};
  for (var k in changes) {
    var target = CACHE_PATCH_FIELDS[k];
    if (!target) {
      if (k === 'channel') { // 채널명은 캐시에 두 이름으로 들어 있어 특별 취급
        fields.channel = changes[k] || '';
        fields.influencer = changes[k] || '';
        continue;
      }
      return null; // 모르는/파생 필드가 끼어 있으면 부분 갱신 포기
    }
    var v = changes[k];
    // parseMainSheet가 내려주는 형태와 맞춰줌 — 빈 팔로워는 ''가 아니라 null이어야 함
    // (프론트 adaptGAS가 !=null로 판정해서, ''로 두면 0명으로 읽힌다)
    if (k === 'followers') v = (v === '' || v == null) ? null : Number(v);
    fields[target] = v;
  }
  return { dealId: dealId, fields: fields, tierRows: tierRows || null };
}

// 데이터를 바꾸는 doPost 액션이 성공하면 호출 — 다음 doGet이 방금 바뀐 값을 바로 반영하게 함
function _invalidateDashboardCache() {
  try {
    var cache = CacheService.getScriptCache();
    var metaKey = _dashboardCacheKey() + ':meta';
    var metaStr = cache.get(metaKey);
    if (!metaStr) return;
    var n = parseInt(metaStr, 10);
    var keys = [metaKey];
    for (var c = 0; c < n; c++) keys.push(_dashboardCacheKey() + ':' + c);
    cache.removeAll(keys);
  } catch (e) {
    Logger.log('캐시 무효화 실패 (무시): ' + e);
  }
}

// 캐시 동작 검증용 — Apps Script 편집기에서 이 함수만 선택해 직접 실행(HTTP 왕복 없이 doGet과
// 동일한 계산 경로를 그대로 태움). ① 캐시 미스 이후 히트로 갈 때 두 번째 조회가 실제로 빨라지는지,
// ② 무효화 직후엔 다시 미스로 떨어지는지(=쓰기 후 다음 조회가 최신 데이터로 재계산됨)를 로그로 확인.
function _testCacheBehavior() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _mainSheet(ss);
  if (!sheet) { Logger.log('[캐시테스트] 실적통합 시트를 찾을 수 없어 중단'); return; }

  var cache = CacheService.getScriptCache();
  var cacheKey = _dashboardCacheKey();

  function computeAndCache() {
    var t0 = Date.now();
    var result = parseMainSheet(sheet);
    var payload = { purchases: result.deals, calendarEvents: _loadCalendarEvents(ss), updatedAt: new Date().toISOString(), version: SCRIPT_VERSION };
    _cachePutJSON(cache, cacheKey, payload, DASHBOARD_CACHE_TTL_SEC);
    return Date.now() - t0;
  }

  _invalidateDashboardCache(); // 이전 실행 잔여 캐시 제거 — 반드시 미스부터 시작

  var msMiss = computeAndCache();
  Logger.log('[캐시테스트] 1회차(캐시 없음→새로 계산): ' + msMiss + 'ms');

  var t2 = Date.now();
  var hit2 = _cacheGetJSON(cache, cacheKey);
  var msHit = Date.now() - t2;
  Logger.log('[캐시테스트] 2회차(같은 캐시 조회): ' + (hit2 ? '히트' : '미스(예상 밖 — TTL 안인데 없음)') +
    ', ' + msHit + 'ms' + (hit2 ? ' — 1회차보다 ' + (msMiss - msHit) + 'ms 빠름' : ''));

  _invalidateDashboardCache(); // 쓰기 액션 성공 시 실제로 호출되는 것과 동일한 무효화
  var hit3 = _cacheGetJSON(cache, cacheKey);
  Logger.log('[캐시테스트] 무효화 후 3회차: ' + (hit3 ? '히트(실패 — 무효화가 안 먹음)' : '미스(정상 — 다음 조회는 최신 데이터로 재계산됨)'));

  computeAndCache(); // 테스트가 실제 서비스 캐시를 빈 상태로 남기지 않게 정상 캐시 재생성
  Logger.log('[캐시테스트] 종료 — 정상 캐시 재생성 완료');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 접속자 표시(Presence) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 대시보드 데이터 캐시(dashboardData_*)와는 완전히 별개의 캐시 키를 씀 — presence 하트비트는
// 로스터 하나만 읽고 쓸 뿐, _invalidateDashboardCache()를 호출하지 않으므로 데이터 캐시에 영향 없음.
// CacheService는 키 목록 조회가 안 되므로, 이메일→{name,email,lastSeen} 맵 하나를 통짜 JSON으로
// 저장/갱신하는 방식으로 구현(동시 하트비트가 겹치면 드물게 갱신 하나가 유실될 수 있으나, 다음
// 하트비트가 30초 후 다시 오므로 접속자 표시 용도로는 문제되지 않음 — LockService까지는 불필요).
var PRESENCE_CACHE_KEY = 'presenceRoster_v1';
var PRESENCE_CACHE_TTL_SEC = 90; // 하트비트가 끊겨도 90초까지는 로스터 자체를 보존
var PRESENCE_ACTIVE_WINDOW_MS = 90 * 1000; // 응답에 포함할 "최근 접속" 기준(프론트 하트비트 주기 45초의 2배 — 2026-08-04 30→45초로 완화되면서 같이 조정)

// 접속자 표시 — 신원은 세션에서 확인된 값만 쓴다(클라이언트가 보낸 이름/이메일을 믿지 않는다)
function _presenceHeartbeat(auth) {
  var email = (auth && auth.email) || '';
  var name = (auth && (auth.name || auth.email)) || '';
  var cache = CacheService.getScriptCache();
  var now = Date.now();

  var roster = {};
  try {
    var raw = cache.get(PRESENCE_CACHE_KEY);
    if (raw) roster = JSON.parse(raw);
  } catch (e) {
    roster = {};
  }

  if (email) roster[email] = { name: name, email: email, lastSeen: now };

  // 60초 넘게 하트비트가 없는 사용자는 응답과 저장 둘 다에서 제외 — 로스터가 무한정 커지는 것도 방지
  var prunedRoster = {};
  var active = [];
  for (var key in roster) {
    var entry = roster[key];
    if (now - entry.lastSeen <= PRESENCE_ACTIVE_WINDOW_MS) {
      prunedRoster[key] = entry;
      active.push({ name: entry.name, email: entry.email, isMe: entry.email === email });
    }
  }
  active.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });

  try {
    cache.put(PRESENCE_CACHE_KEY, JSON.stringify(prunedRoster), PRESENCE_CACHE_TTL_SEC);
  } catch (e) {
    Logger.log('presence 캐시 저장 실패 (무시): ' + e);
  }

  return _json({ success: true, users: active });
}

// ── 디버그: 특정 행의 릴스 저장 상태(릴스 슬롯 하이퍼링크 + 썸네일 JSON) 원본 그대로 반환 ──
function _debugReelsRaw(sheet, row) {
  // getLastRow()는 서식/수식이 미리 적용된 범위(예: 3000행)까지 잡아버려 실제보다 훨씬 넓은
  // 범위를 "유효"하다고 판단할 수 있음 — _getLastDataRow로 실제 데이터 끝 기준으로 검사함.
  var lastDataRow = _getLastDataRow(sheet, COL.channel + 1);
  if (!row || row < DATA_START_ROW + 1 || row > lastDataRow) {
    return { debug: true, error: '잘못된 행 번호: ' + row + ' (유효 범위 ' + (DATA_START_ROW + 1) + '~' + lastDataRow + ')' };
  }
  var rowVals = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
  var richRow = sheet.getRange(row, REEL_COL_START, 1, REEL_SLOT_COUNT).getRichTextValues()[0];
  var slots = [];
  for (var i = 0; i < REEL_SLOT_COUNT; i++) {
    var rc = richRow[i];
    slots.push({ text: rc ? rc.getText() : '', linkUrl: rc ? rc.getLinkUrl() : null });
  }
  var thumbsRaw = rowVals[COL.thumbs];
  var thumbs;
  try { thumbs = JSON.parse(thumbsRaw || '[]'); } catch (e) { thumbs = { parseError: String(e), raw: thumbsRaw }; }
  return {
    debug: true, row: row,
    product: rowVals[COL.product], channel: rowVals[COL.channel],
    viewsTotal: rowVals[COL.views],
    reelSlots: slots,
    thumbsJson_raw: thumbsRaw,
    thumbsJson_parsed: thumbs
  };
}

// ── 디버그: 이 배포본이 실제로 어느 스프레드시트/탭을 읽는지 + 원시 헤더/데이터 몇 줄 +
// 필터링 통계(브랜드/제품 없음으로 제외된 행 수)를 그대로 보여줌. 데이터가 안 나올 때 1차 진단용.
function _debugRawDump(ss, sheet) {
  var data = sheet.getDataRange().getValues();
  var headerRow = data.length > 1 ? data[1] : []; // 2행(0-based index 1)이 헤더

  // 열 해석 실패(2행 헤더 문구가 COL_HEADER_SPECS와 어긋남)야말로 이 덤프가 가장 필요한 상황이라,
  // 실패해도 멈추지 않고 에러 문구를 응답에 실어 보냄 — headerRow2_raw와 나란히 보면 바로 고칠 수 있음.
  var colError = '', colMap = {};
  try {
    _resolveCols(sheet);
    for (var ck in COL) colMap[ck] = COL[ck] >= 0 ? _colLetter(COL[ck]) : '(없음)';
  } catch (colErr) {
    colError = String((colErr && colErr.message) || colErr);
  }

  var totalDataRows = Math.max(0, data.length - DATA_START_ROW);
  var withProduct = 0, withoutProduct = 0;
  var brandCounts = {}; // 실제로 등장하는 브랜드 값별 건수(오타/공백 차이 확인용)
  var passMinixFilter = 0;

  var sampleRows = [];
  for (var i = colError ? data.length : DATA_START_ROW; i < data.length; i++) {
    var row = data[i];
    var brand = String(row[COL.brand] || '').trim();
    var product = String(row[COL.product] || '').trim();
    if (!product) { withoutProduct++; continue; }
    withProduct++;
    brandCounts[brand || '(빈값)'] = (brandCounts[brand || '(빈값)'] || 0) + 1;
    if (MINIX_ALIASES[brand]) passMinixFilter++;

    if (sampleRows.length < 5) {
      sampleRows.push({
        row: i + 1,
        brand: brand, product: product,
        channel: String(row[COL.channel] || '').trim(),
        dealId: String(row[COL.dealId] || '').trim(),
        codeSeq: row[COL.codeSeq],
        code: String(row[COL.code] || '').trim(),
        startMD_raw: String(row[COL.startMD] || ''),
        qty: row[COL.qty]
      });
    }
  }

  return {
    debug: true,
    scriptUrl: ScriptApp.getService().getUrl(), // 대시보드 연결 설정에 저장된 URL과 이 값이 같아야 함
    spreadsheetId: ss.getId(),
    spreadsheetName: ss.getName(),
    sheetNameConfigured: MAIN_SHEET, // 코드(MAIN_SHEET 상수)가 찾으려는 탭명
    sheetNameActuallyFound: sheet.getName(), // 실제로 찾아서 읽고 있는 탭명(위와 같아야 정상)
    allSheetNamesInThisSpreadsheet: ss.getSheets().map(function (s) { return s.getName(); }),
    dataStartRowConfig_0based: DATA_START_ROW, // 3행부터 데이터로 간주(0-based 2)
    headerRow2_raw: headerRow,
    columnMap: colMap,      // 2행 헤더에서 해석된 논리 열 → 실제 시트 열 문자(열이 밀렸는지 한눈에 확인)
    columnError: colError,  // 비어있지 않으면 해석 실패 — 이 메시지가 어떤 헤더를 못 찾았는지 알려줌
    totalRowsInSheet: data.length,
    totalDataRows: totalDataRows,
    withProduct: withProduct,
    withoutProduct_excluded: withoutProduct,
    brandValueCounts: brandCounts, // 여기 키가 "미닉스"/"Minix" 등과 다르면 MINIX_ALIASES 필터에서 전부 걸러짐
    passMinixFilter: passMinixFilter, // 최종적으로 대시보드에 나와야 할 건수
    sampleFirst5DataRows: sampleRows
  };
}


/* ── dealId 통일 (2026-09-15) ───────────────────────────────────────────────────
   상품코드별로 따로 등록돼 dealId가 제각각인 행들을, 기존 구조(같은 dealId + 코드순번 1..n)로
   맞춘다. 대상은 행 번호로 직접 지정한다 — 내용(제품·채널·기간)이 같다는 이유로 자동으로 묶으면
   서로 다른 공구건을 합칠 위험이 있어서, 사람이 확인한 묶음만 손댄다.

   각 묶음의 **첫 행 dealId**가 대표가 되고, 나머지 행의 dealId가 그 값으로 바뀐다.
   코드순번은 1부터 순서대로 다시 매긴다. 행은 삭제하지 않고 실적도 건드리지 않는다
   (상품코드별 실적은 그대로 남고, parseMainSheet가 합산해서 한 건으로 보여준다).

   먼저 previewUnifyDealIds()로 바뀔 셀 목록을 보고, 이상 없으면 applyUnifyDealIds(). */

// 러브지나 — 내용 기준 병합으로만 한 건처럼 보이던 4묶음 (시트 행 번호)
var LOVEZINA_ROW_GROUPS = [
  [180, 181, 182, 183, 184, 185],
  [281, 283, 284],
  [298, 299, 300],
  [329, 330, 331]
];

function previewUnifyDealIds(groups) { return _unifyDealIds(groups || LOVEZINA_ROW_GROUPS, true); }
function applyUnifyDealIds(groups)   { return _unifyDealIds(groups || LOVEZINA_ROW_GROUPS, false); }

function _unifyDealIds(groups, dryRun) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _mainSheet(ss);
  if (!sheet) { Logger.log('[dealId 통일] 실적통합 시트를 찾을 수 없습니다'); return null; }
  _resolveCols(sheet);

  var lastRow = _getLastDataRow(sheet, COL.channel + 1);
  var n = lastRow - DATA_START_ROW, first = DATA_START_ROW + 1;
  var vals = sheet.getRange(first, 1, n, sheet.getLastColumn()).getValues();
  var idVals  = sheet.getRange(first, COL.dealId + 1, n, 1).getValues();
  var seqVals = sheet.getRange(first, COL.codeSeq + 1, n, 1).getValues();

  var edits = [], skipped = [], ok = 0;

  for (var g = 0; g < groups.length; g++) {
    var rows = groups[g];
    var idxs = [], bad = null;
    for (var r = 0; r < rows.length; r++) {
      var idx = rows[r] - first;
      if (idx < 0 || idx >= n) { bad = rows[r] + '행이 데이터 범위(' + first + '~' + lastRow + ') 밖입니다'; break; }
      if (!String(vals[idx][COL.product] || '').trim()) { bad = rows[r] + '행에 제품명이 없습니다'; break; }
      if (!MINIX_ALIASES[String(vals[idx][COL.brand] || '').trim()]) { bad = rows[r] + '행이 미닉스 행이 아닙니다'; break; }
      idxs.push(idx);
    }
    // 같은 공구건이라는 최소 전제 — 채널·제품·기간이 모두 같아야 한다. 다르면 손대지 않고 보고만 한다
    if (!bad) {
      var key = null;
      for (var k = 0; k < idxs.length; k++) {
        var row = vals[idxs[k]];
        var yr = _numOrNull(row[COL.year]);
        var kk = [String(row[COL.channel] || '').trim(), String(row[COL.product] || '').replace(/\s+/g, '').toLowerCase(),
          _parseDate(row[COL.startMD], yr) || '', _parseDate(row[COL.endMD], yr) || ''].join(' | ');
        if (key === null) key = kk;
        else if (kk !== key) { bad = '행마다 채널·제품·기간이 다릅니다 ("' + key + '" vs "' + kk + '")'; break; }
      }
    }
    if (bad) {
      skipped.push({ rows: rows, reason: bad });
      Logger.log('  ⚠ 건너뜀 — 행 [' + rows.join(', ') + ']: ' + bad);
      continue;
    }

    var primaryId = String(idVals[idxs[0]][0] || '').trim();
    if (!primaryId) { primaryId = Utilities.getUuid(); }
    for (var i2 = 0; i2 < idxs.length; i2++) {
      var sheetRow = first + idxs[i2];
      var curId = String(idVals[idxs[i2]][0] || '').trim();
      var curSeq = _numOrNull(seqVals[idxs[i2]][0]);
      if (curId !== primaryId) {
        edits.push({ row: sheetRow, col: '공구건ID', from: curId, to: primaryId });
        idVals[idxs[i2]][0] = primaryId;
      }
      if (curSeq !== i2 + 1) {
        edits.push({ row: sheetRow, col: '코드순번', from: curSeq, to: i2 + 1 });
        seqVals[idxs[i2]][0] = i2 + 1;
      }
    }
    ok++;
  }

  Logger.log('[dealId 통일] ' + (dryRun ? '미리보기' : '실행') + ' — 묶음 ' + ok + '개 / 건너뜀 ' +
    skipped.length + '개 / 바뀔 셀 ' + edits.length + '개');
  for (var e = 0; e < edits.length; e++) {
    Logger.log('  · ' + edits[e].row + '행 ' + edits[e].col + ': "' + edits[e].from + '" → "' + edits[e].to + '"');
  }
  if (!edits.length) Logger.log('  (바꿀 셀이 없습니다 — 이미 통일돼 있습니다)');

  if (!dryRun && edits.length) {
    sheet.getRange(first, COL.dealId + 1, n, 1).setValues(idVals);
    sheet.getRange(first, COL.codeSeq + 1, n, 1).setValues(seqVals);
    SpreadsheetApp.flush();
    _invalidateDashboardCache();
    _invalidateDealRowMap();
    Logger.log('[dealId 통일] 기록 완료 — 대시보드를 새로고침하면 각 묶음이 한 건으로 보입니다');
  }
  return { dryRun: !!dryRun, groups: ok, edits: edits, skipped: skipped };
}


/* ── 인플루언서 링크 일괄 채움 (2026-09-15) ────────────────────────────────────
   ID(인스타/유튜브)는 있는데 링크 열이 빈 행에, 대시보드와 같은 규칙으로 프로필 주소를 만들어
   기록한다. 이미 링크가 있는 행은 건드리지 않는다(사람이 넣은 값이 우선).

   대시보드는 링크가 비어 있어도 화면에서 즉석 생성해 걸어주므로 이 함수는 필수가 아니다.
   시트를 직접 보는 사람에게도 링크가 보이게 하려는 1회성 정리다.

   먼저 previewInfluencerLinks()로 대상 행 수와 샘플을 확인한 뒤 fillInfluencerLinks(). */
function previewInfluencerLinks() { return _fillInfluencerLinks(true); }
function fillInfluencerLinks()    { return _fillInfluencerLinks(false); }

// 플랫폼 표기 흔들림 흡수 — 프론트 _platformKind와 같은 기준
function _platformKindGas(platform) {
  var t = String(platform || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!t) return '';
  if (t.indexOf('인스타') >= 0 || t.indexOf('instagram') >= 0 || t === 'ig' ||
      t.indexOf('릴스') >= 0 || t.indexOf('reels') >= 0) return 'ig';
  if (t.indexOf('유튜브') >= 0 || t.indexOf('유툽') >= 0 || t.indexOf('youtube') >= 0 || t === 'yt' ||
      t.indexOf('쇼츠') >= 0 || t.indexOf('shorts') >= 0) return 'yt';
  return '';
}
function _buildChannelLinkGas(platform, igId, ytId) {
  var kind = _platformKindGas(platform);
  var ig = String(igId || '').trim().replace(/^@+/, '');
  var yt = String(ytId || '').trim().replace(/^@+/, '');
  if (kind === 'ig' && ig) return 'https://www.instagram.com/' + ig;
  if (kind === 'yt' && yt) return 'https://www.youtube.com/@' + yt;
  // 플랫폼 표기가 없거나 못 알아볼 때 — ID가 한쪽에만 있으면 그걸로 만든다
  if (!kind) {
    if (ig && !yt) return 'https://www.instagram.com/' + ig;
    if (yt && !ig) return 'https://www.youtube.com/@' + yt;
  }
  return '';
}

function _fillInfluencerLinks(dryRun) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _mainSheet(ss);
  if (!sheet) { Logger.log('[링크 채움] 실적통합 시트를 찾을 수 없습니다'); return null; }
  _resolveCols(sheet);
  if (COL.link < 0) { Logger.log("[링크 채움] '인플루언서 링크' 열을 찾을 수 없습니다"); return null; }
  if (COL.igId < 0 && COL.ytId < 0) { Logger.log('[링크 채움] 인스타/유튜브 ID 열이 없습니다'); return null; }

  var lastRow = _getLastDataRow(sheet, COL.channel + 1);
  if (lastRow <= DATA_START_ROW) { Logger.log('[링크 채움] 데이터 행이 없습니다'); return null; }
  var n = lastRow - DATA_START_ROW, first = DATA_START_ROW + 1;
  var vals = sheet.getRange(first, 1, n, sheet.getLastColumn()).getValues();
  var linkVals = sheet.getRange(first, COL.link + 1, n, 1).getValues();

  var targets = [];
  for (var i = 0; i < n; i++) {
    var row = vals[i];
    if (!String(row[COL.product] || '').trim()) continue;
    if (!MINIX_ALIASES[String(row[COL.brand] || '').trim()]) continue;
    if (String(linkVals[i][0] || '').trim()) continue;              // 이미 링크가 있으면 손대지 않는다
    var url = _buildChannelLinkGas(row[COL.platform],
      COL.igId >= 0 ? row[COL.igId] : '', COL.ytId >= 0 ? row[COL.ytId] : '');
    if (!url) continue;
    targets.push({ idx: i, sheetRow: first + i, channel: String(row[COL.channel] || '').trim(), url: url });
  }

  Logger.log('[링크 채움] ' + (dryRun ? '미리보기' : '실행') + ' — 대상 ' + targets.length + '행' +
    ' (ID는 있는데 링크가 빈 행)');
  for (var t = 0; t < Math.min(5, targets.length); t++) {
    Logger.log('  · ' + targets[t].sheetRow + '행  ' + targets[t].channel + '  → ' + targets[t].url);
  }
  if (targets.length > 5) Logger.log('  · … 외 ' + (targets.length - 5) + '행');
  if (!targets.length) Logger.log('  (채울 행이 없습니다)');

  if (!dryRun && targets.length) {
    for (var w = 0; w < targets.length; w++) linkVals[targets[w].idx][0] = targets[w].url;
    sheet.getRange(first, COL.link + 1, n, 1).setValues(linkVals);
    SpreadsheetApp.flush();
    _invalidateDashboardCache();
    Logger.log('[링크 채움] ' + targets.length + '행 기록 완료');
  }
  return { dryRun: !!dryRun, count: targets.length, sample: targets.slice(0, 5) };
}


/* ── 링크 → 플랫폼 ID 역추출 (2026-09-16) ──────────────────────────────────────
   _fillInfluencerLinks의 반대 방향이다. ID 열은 비어 있고 인플루언서 링크만 들어 있는 행에서
   주소를 파싱해 인스타/유튜브 ID를 뽑아 채운다.

   판정 기준은 **주소의 호스트**이지 플랫폼 열이 아니다. 플랫폼 표기는 '인스타'·'IG'·'릴스'처럼
   흔들리는 데다 플랫폼 열과 링크가 실제로 어긋난 행도 있어서, 주소 쪽이 언제나 더 믿을 만하다.

   뽑는 형태
     instagram.com/{id}                → igId
     youtube.com/@{id}                 → ytId
     youtube.com/channel|c|user/{id}   → ytId
   건드리지 않는 형태(로그에만 남김)
     instagram.com/p|reel|tv|stories/…  게시물 주소라 계정명이 아니다
     youtu.be/… · youtube.com/watch · /shorts/…  영상 주소다
     단축 URL·블로그·그 밖의 호스트

   뽑은 값은 채널 공통 전파 규칙대로 같은 채널(앞뒤 공백만 제거한 완전 일치)의 빈 칸에도 채운다.
   다만 시트에 이미 값이 있으면 그쪽이 이긴다 — 링크에서 뽑은 값이 달라도 덮지 않고 불일치로
   로그에만 남긴다. 사람이 넣은 값을 되돌리는 쪽이 훨씬 비싸기 때문이다.

   먼저 previewIdsFromLinks()로 대상과 샘플을 확인한 뒤 fillIdsFromLinks(). */
function previewIdsFromLinks() { return _extractIdsFromLinks(true); }
function fillIdsFromLinks()    { return _extractIdsFromLinks(false); }

// 인스타 경로의 첫 칸이 계정명이 아닌 경우 — 게시물·기능 주소
var IG_NON_PROFILE = { p:1, reel:1, reels:1, tv:1, stories:1, explore:1, s:1, direct:1,
  accounts:1, about:1, developer:1, legal:1, challenge:1 };

/* 링크 한 줄 → { kind:'ig'|'yt'|'', id, reason }. kind가 빈 문자열이면 reason이 건너뛴 이유다.
   Apps Script에는 브라우저의 URL 클래스가 없어 호스트와 경로만 정규식으로 잘라 쓴다. */
function _extractIdFromLinkGas(link) {
  var s = String(link == null ? '' : link).trim();
  if (!s) return { kind: '', id: '', reason: '링크 없음' };
  var m = s.match(/^(?:https?:\/\/)?([^\/?#\s]+)([^?#\s]*)/i);
  if (!m) return { kind: '', id: '', reason: '주소 형태가 아님' };
  var host = m[1].toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  var segs = String(m[2] || '').replace(/^\/+|\/+$/g, '').split('/').filter(function (x) { return !!x; });
  var head = segs[0] || '';

  if (host === 'instagram.com' || host === 'instagr.am') {
    if (!head) return { kind: '', id: '', reason: '인스타 주소인데 계정명이 없음' };
    if (IG_NON_PROFILE[head.toLowerCase()]) return { kind: '', id: '', reason: '인스타 게시물/기능 주소(/' + head + ')' };
    var ig = head.replace(/^@+/, '');
    if (!/^[A-Za-z0-9._]{1,30}$/.test(ig)) return { kind: '', id: '', reason: '인스타 ID 형식이 아님(' + head + ')' };
    return { kind: 'ig', id: ig, reason: '' };
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (head.charAt(0) === '@') {
      var handle = head.replace(/^@+/, '');
      return handle ? { kind: 'yt', id: handle, reason: '' }
                    : { kind: '', id: '', reason: '유튜브 핸들이 비어 있음' };
    }
    var lead = head.toLowerCase();
    if (lead === 'channel' || lead === 'c' || lead === 'user') {
      var seg = (segs[1] || '').replace(/^@+/, '');
      return seg ? { kind: 'yt', id: seg, reason: '' }
                 : { kind: '', id: '', reason: '유튜브 /' + lead + ' 주소인데 뒤가 비어 있음' };
    }
    return { kind: '', id: '', reason: '유튜브 채널 주소가 아님(' + (head ? '/' + head : '경로 없음') + ')' };
  }
  if (host === 'youtu.be') return { kind: '', id: '', reason: '유튜브 영상 단축 주소' };
  return { kind: '', id: '', reason: '인스타/유튜브 주소가 아님(' + host + ')' };
}

function _extractIdsFromLinks(dryRun) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _mainSheet(ss);
  if (!sheet) { Logger.log('[ID 역추출] 실적통합 시트를 찾을 수 없습니다'); return null; }
  _resolveCols(sheet);
  if (COL.link < 0) { Logger.log("[ID 역추출] '인플루언서 링크' 열을 찾을 수 없습니다"); return null; }
  if (COL.igId < 0 && COL.ytId < 0) {
    Logger.log("[ID 역추출] 인스타/유튜브 ID 열이 없습니다 — 2행에 '인스타 ID'/'유튜브 ID' 헤더를 추가하세요");
    return null;
  }

  var lastRow = _getLastDataRow(sheet, COL.channel + 1);
  if (lastRow <= DATA_START_ROW) { Logger.log('[ID 역추출] 데이터 행이 없습니다'); return null; }
  var n = lastRow - DATA_START_ROW, first = DATA_START_ROW + 1;
  var vals = sheet.getRange(first, 1, n, sheet.getLastColumn()).getValues();

  function cellId(row, key) {
    return COL[key] >= 0 ? _normalizeChannelFieldValue(key, row[COL[key]]) : '';
  }

  /* ① 한 번 훑으며 채널마다 "시트에 이미 있는 값"과 "링크에서 뽑은 값"을 따로 모은다.
     둘을 섞지 않는 이유는 ②에서 시트 값을 우선하기 위해서다. */
  var chs = {}, order = [], skipped = [];
  for (var i = 0; i < n; i++) {
    var row = vals[i];
    if (!String(row[COL.product] || '').trim()) continue;
    if (!MINIX_ALIASES[String(row[COL.brand] || '').trim()]) continue;
    var ch = String(row[COL.channel] || '').trim();
    if (!ch) continue;
    if (!chs[ch]) {
      chs[ch] = { ch: ch, idx: [], igSheet: '', ytSheet: '', igLink: '', ytLink: '', conflicts: [] };
      order.push(ch);
    }
    var c = chs[ch];
    c.idx.push(i);
    var ig = cellId(row, 'igId'), yt = cellId(row, 'ytId');
    if (ig) c.igSheet = ig;   // 아래쪽(= 최근) 행이 이긴다 — 채널 정보는 최신이 정답
    if (yt) c.ytSheet = yt;
    var link = String(row[COL.link] || '').trim();
    if (!link || ig || yt) continue;   // 링크가 없거나 이미 ID가 붙은 행은 볼 것이 없다
    var got = _extractIdFromLinkGas(link);
    if (!got.kind) { skipped.push({ sheetRow: first + i, channel: ch, link: link, reason: got.reason }); continue; }
    var prev = got.kind === 'ig' ? c.igLink : c.ytLink;
    // 같은 채널에 서로 다른 링크가 있으면 아래쪽(= 최근) 행이 이긴다. 어느 쪽이 채택됐는지가
    // 로그만 보고 분명해야 한다 — "A vs B"로만 적으면 사람이 순서를 외워야 한다
    if (prev && prev !== got.id) {
      c.conflicts.push(got.kind + ' 링크끼리 어긋남: ' + prev + ' → ' + got.id +
        '(' + (first + i) + '행) 채택 — 아래쪽 행 우선');
    }
    if (got.kind === 'ig') c.igLink = got.id; else c.ytLink = got.id;
  }

  // ② 채널 기준값을 정하고 빈 칸을 채운다. 쓰기는 열마다 setValues 한 번(전파 함수와 같은 방식)
  var igCol = [], ytCol = [];
  for (var r = 0; r < n; r++) {
    igCol.push([COL.igId >= 0 ? vals[r][COL.igId] : '']);
    ytCol.push([COL.ytId >= 0 ? vals[r][COL.ytId] : '']);
  }
  var targets = [], igFilled = 0, ytFilled = 0, hitChannels = 0, conflicts = [], touchedRows = {};
  for (var k = 0; k < order.length; k++) {
    var cc = chs[order[k]];
    if (!cc.igLink && !cc.ytLink) continue;     // 이 채널에서는 링크로 뽑힌 게 없다 — 손대지 않는다
    hitChannels++;
    if (cc.igSheet && cc.igLink && cc.igSheet !== cc.igLink) cc.conflicts.push('igId 시트 ' + cc.igSheet + ' vs 링크 ' + cc.igLink);
    if (cc.ytSheet && cc.ytLink && cc.ytSheet !== cc.ytLink) cc.conflicts.push('ytId 시트 ' + cc.ytSheet + ' vs 링크 ' + cc.ytLink);
    if (cc.conflicts.length) conflicts.push(cc.ch + ' — ' + cc.conflicts.join(' / '));
    var wantIg = cc.igSheet || cc.igLink, igSrc = cc.igSheet ? '시트' : '링크';
    var wantYt = cc.ytSheet || cc.ytLink, ytSrc = cc.ytSheet ? '시트' : '링크';
    for (var t = 0; t < cc.idx.length; t++) {
      var ix = cc.idx[t];
      if (COL.igId >= 0 && wantIg && !_normalizeChannelFieldValue('igId', igCol[ix][0])) {
        igCol[ix][0] = wantIg; igFilled++; touchedRows[first + ix] = true;
        targets.push({ sheetRow: first + ix, channel: cc.ch, field: 'igId', value: wantIg, src: igSrc });
      }
      if (COL.ytId >= 0 && wantYt && !_normalizeChannelFieldValue('ytId', ytCol[ix][0])) {
        ytCol[ix][0] = wantYt; ytFilled++; touchedRows[first + ix] = true;
        targets.push({ sheetRow: first + ix, channel: cc.ch, field: 'ytId', value: wantYt, src: ytSrc });
      }
    }
  }
  var rowCount = Object.keys(touchedRows).length;

  Logger.log('[ID 역추출] ' + (dryRun ? '미리보기' : '실행') + ' — 링크에서 ID를 뽑은 채널 ' + hitChannels +
    '개 / 채울 칸 ' + targets.length + '개(행 ' + rowCount + '개) / 건너뛴 링크 ' + skipped.length + '개');
  for (var s = 0; s < Math.min(5, targets.length); s++) {
    var g = targets[s];
    Logger.log('  · ' + g.sheetRow + '행  ' + g.channel + '  ' + g.field + ' ← @' + g.value + ' (' + g.src + ')');
  }
  if (targets.length > 5) Logger.log('  · … 외 ' + (targets.length - 5) + '칸');
  if (!targets.length) Logger.log('  (채울 칸이 없습니다)');
  for (var q = 0; q < Math.min(40, skipped.length); q++) {
    Logger.log('  [건너뜀] ' + skipped[q].sheetRow + '행  ' + skipped[q].channel + '  ' + skipped[q].link +
      '  → ' + skipped[q].reason);
  }
  if (skipped.length > 40) Logger.log('  [건너뜀] … 외 ' + (skipped.length - 40) + '개');
  if (conflicts.length) {
    // 충돌은 두 종류다(시트 vs 링크 / 링크 vs 링크). 앞엣것만 말하면 뒤엣것을 볼 때 문구가 거짓이 된다
    Logger.log('[ID 역추출] 값이 어긋난 채널 ' + conflicts.length +
      '개 — 시트에 값이 있으면 그 값을, 없으면 아래쪽(최근) 행의 링크값을 썼습니다');
    for (var v = 0; v < conflicts.length; v++) Logger.log('  ! ' + conflicts[v]);
  }

  if (!dryRun) {
    if (targets.length) {
      if (igFilled && COL.igId >= 0) sheet.getRange(first, COL.igId + 1, n, 1).setValues(igCol);
      if (ytFilled && COL.ytId >= 0) sheet.getRange(first, COL.ytId + 1, n, 1).setValues(ytCol);
      SpreadsheetApp.flush();
      _invalidateDashboardCache();
    }
    Logger.log('[ID 역추출] 기록 완료 — 인스타 ' + igFilled + '칸 / 유튜브 ' + ytFilled + '칸 / 건너뜀 ' +
      skipped.length + '개');
  }
  return { dryRun: !!dryRun, channels: hitChannels, filled: targets.length, igFilled: igFilled,
    ytFilled: ytFilled, rows: rowCount, skipped: skipped, conflicts: conflicts,
    sample: targets.slice(0, 5) };
}


/* ── 다중 상품코드 진단 (2026-09-15) ────────────────────────────────────────────
   "한 공구건 = 같은 dealId + 코드순번 1..n" 구조가 시트에서 실제로 지켜지고 있는지 본다.
   하늘마켓·이제이쿡처럼 상품코드가 여러 개인 건을 대조할 때 쓴다. 읽기 전용이다.

   보고 항목
     rows      — 그 건이 차지한 시트 행 번호
     codes     — 행별 상품코드
     strayPerf — 대표 행이 아닌데 실적이 들어 있는 행(운영 규칙 위반 — 대시보드는 대표 행만 읽으므로
                 이 값들은 집계에서 빠진다)
     seqIssue  — 코드순번이 비었거나 중복이라 대표 행을 특정할 수 없는 상태 */
function reportMultiCodeDeals() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _mainSheet(ss);
  if (!sheet) { Logger.log('[다중코드] 실적통합 시트를 찾을 수 없습니다'); return []; }
  _resolveCols(sheet);

  var lastRow = _getLastDataRow(sheet, COL.channel + 1);
  if (lastRow <= DATA_START_ROW) { Logger.log('[다중코드] 데이터 행이 없습니다'); return []; }
  var n = lastRow - DATA_START_ROW, first = DATA_START_ROW + 1;
  var vals = sheet.getRange(first, 1, n, sheet.getLastColumn()).getValues();

  var byDeal = {}, order = [];
  for (var i = 0; i < n; i++) {
    var row = vals[i];
    var did = String(row[COL.dealId] || '').trim();
    if (!did) continue;
    if (!String(row[COL.product] || '').trim()) continue;
    if (!MINIX_ALIASES[String(row[COL.brand] || '').trim()]) continue;
    if (!byDeal[did]) { byDeal[did] = []; order.push(did); }
    byDeal[did].push({ sheetRow: first + i, row: row });
  }

  var out = [];
  for (var k = 0; k < order.length; k++) {
    var members = byDeal[order[k]];
    if (members.length < 2) continue;                 // 단독 행 건은 볼 것이 없다
    members.sort(function (a, b) {
      var sa = _numOrNull(a.row[COL.codeSeq]); if (sa == null) sa = 999;
      var sb = _numOrNull(b.row[COL.codeSeq]); if (sb == null) sb = 999;
      return sa - sb;
    });
    var seqs = {}, seqIssue = false, stray = [], rows = [], codes = [];
    for (var m = 0; m < members.length; m++) {
      var mr = members[m].row;
      rows.push(members[m].sheetRow);
      codes.push(String(mr[COL.code] || '').trim());
      var seq = _numOrNull(mr[COL.codeSeq]);
      if (seq == null || seqs[seq]) seqIssue = true;
      if (seq != null) seqs[seq] = true;
      // 대표 행(m===0)이 아닌데 실적이 있으면 대시보드 집계에서 빠진다
      if (m > 0 && (_numOrNull(mr[COL.qty]) != null || _numOrNull(mr[COL.revenue]) != null)) {
        stray.push(members[m].sheetRow);
      }
    }
    var year = _numOrNull(members[0].row[COL.year]);
    out.push({
      dealId: order[k],
      channel: String(members[0].row[COL.channel] || '').trim(),
      product: String(members[0].row[COL.product] || '').trim(),
      start: _parseDate(members[0].row[COL.startMD], year) || '',
      end: _parseDate(members[0].row[COL.endMD], year) || '',
      rows: rows, codes: codes, strayPerf: stray, seqIssue: seqIssue
    });
  }

  Logger.log('[다중코드] 상품코드가 2개 이상인 공구건 ' + out.length + '건');
  for (var o = 0; o < out.length; o++) {
    var d = out[o];
    Logger.log('  · ' + d.channel + ' / ' + d.product + ' / ' + d.start + '~' + d.end +
      ' / 행 [' + d.rows.join(', ') + '] / 코드 [' + d.codes.join(', ') + ']' +
      (d.strayPerf.length ? '  ⚠ 대표 행이 아닌 행에 실적 있음 → 행 [' + d.strayPerf.join(', ') + '] (집계에서 빠짐)' : '') +
      (d.seqIssue ? '  ⚠ 코드순번이 비었거나 중복임' : ''));
  }
  if (!out.length) Logger.log('  (상품코드가 2개 이상인 건이 없습니다)');
  return out;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 메인 시트 파싱 (dealId로 그룹핑 → 그룹당 "공구건" 1개) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 상품코드가 여러 개인 공구건은 같은 dealId를 공유하는 여러 행(코드순번 1~5)으로 저장됨.
// 코드순번=1(또는 그룹 내 최솟값) 행이 "대표 행" — 판매수량/매출/조회수/릴스/기간/공구가/수수료/
// 목표수량/상태 등 실적·조건 값은 대표 행에만 있고, 나머지 행은 상품코드만 의미 있음(나머지 칸은 빈값).
// 제품명/채널명/브랜드/벤더사는 그룹의 모든 행에 동일하게 들어있어 그대로 사용.
function parseMainSheet(sheet) {
  // ⚠ 2026-08-04: getDataRange()는 getLastRow()와 동일한 매커니즘(서식/수식이 있는 마지막 행)으로
  // 범위를 잡아서, 실제 데이터가 373행에서 끝나도 서식이 미리 적용된 3000행까지 그대로 읽어버림
  // (_getLastDataRow 주석 참고). 매 doGet 캐시 미스마다 이 큰 범위를 두 번(getValues+getTextStyles)
  // 읽는 게 "느리고 재연결 중" 증상의 실제 병목이었음 — _getLastDataRow로 실제 마지막 행까지만,
  // Range 객체 하나를 재사용해서 값/스타일을 각각 그 범위에서만 가져오도록 수정.
  var lastDataRow = _getLastDataRow(sheet, COL.channel + 1);
  var mainRange = sheet.getRange(1, 1, lastDataRow, sheet.getLastColumn());
  var data = mainRange.getValues();

  // 취소선 감지 (B열 기준, 실패해도 파싱은 계속)
  var strikeMap = {};
  try {
    var styles = mainRange.getTextStyles();
    for (var r = DATA_START_ROW; r < styles.length; r++) {
      if (styles[r] && styles[r][COL.brand] && styles[r][COL.brand].isStrikethrough()) {
        strikeMap[r] = true;
      }
    }
  } catch (e) {
    Logger.log('취소선 감지 실패 (무시): ' + e);
  }

  // 릴스별 조회수/링크(하이퍼링크 포함) — 한 번에 읽어서 행별로 매칭
  var reelRich = null;
  try {
    if (data.length > DATA_START_ROW) {
      reelRich = sheet.getRange(DATA_START_ROW + 1, REEL_COL_START, data.length - DATA_START_ROW, REEL_SLOT_COUNT).getRichTextValues();
    }
  } catch (e) {
    Logger.log('릴스 링크 읽기 실패 (무시): ' + e);
  }

  // 채널명(E열) 셀에 걸린 하이퍼링크(인플루언서 프로필 링크) — getValues()는 텍스트만 읽고
  // 하이퍼링크는 놓치므로 채널명 열 범위 전체를 한 번만 getRichTextValues()로 읽어둠(행별 개별
  // 호출 금지 — 성능). 채널명이 비어있는 행도 있을 수 있어 인덱스가 어긋나지 않게 조심.
  var channelRich = null;
  try {
    if (data.length > DATA_START_ROW) {
      channelRich = sheet.getRange(DATA_START_ROW + 1, COL.channel + 1, data.length - DATA_START_ROW, 1).getRichTextValues();
    }
  } catch (e) {
    Logger.log('채널명 하이퍼링크 읽기 실패 (무시): ' + e);
  }

  var today = new Date();
  today.setHours(0, 0, 0, 0);

  // 1차 패스: 유효한 행만 골라 dealId로 그룹핑. dealId가 비어있으면(사람이 새로 추가한 행 등)
  // 서로 다른 빈 문자열끼리 잘못 뭉치지 않도록 물리 행 번호 기반의 고유 키를 대신 사용함
  // (실제로 노출되는 deal.dealId 필드는 그대로 빈 문자열로 두고, doGet이 이후 _autoFillMissingDealIds로 채움).
  var groups = {}; // key -> [{rowIdx, row}]
  var groupOrder = [];
  var skippedStrike = 0, skippedNoProduct = 0, skippedNonMinix = 0;

  for (var i = DATA_START_ROW; i < data.length; i++) {
    if (strikeMap[i]) { skippedStrike++; continue; }
    var row = data[i];
    var brand = String(row[COL.brand] || '').trim();
    var product = String(row[COL.product] || '').trim();
    if (!product) { skippedNoProduct++; continue; } // 빈 행/구분용 행("2025년" 등) 제외
    if (!MINIX_ALIASES[brand]) { skippedNonMinix++; continue; } // Minix 전용 대시보드

    var dealId = String(row[COL.dealId] || '').trim();
    var key = dealId || ('__ROW' + i);
    if (!groups[key]) { groups[key] = []; groupOrder.push(key); }
    groups[key].push({ rowIdx: i, row: row });
  }

  // 방어 로직: 같은 dealId를 공유하는 그룹인데 제품명/채널명이 서로 다른 행이 섞여 있으면
  // (수동 편집 중 dealId가 실수로 복사된 경우 등) 정상적인 "한 공구건의 코드 여러 개" 그룹이
  // 아니라 서로 다른 공구건이 우연히 같은 dealId를 갖게 된 것으로 간주함. 이런 경우 대표 행으로
  // 억지로 합쳐서 나머지를 조용히 지워버리지 않고, 일치하지 않는 행을 별도 건으로 분리해서
  // 전부 살아남게 함 — 데이터가 화면에서 조용히 사라지는 것을 막는 게 최우선.
  var mismatchSplit = 0;
  for (var gi = 0; gi < groupOrder.length; gi++) {
    var gk = groupOrder[gi];
    var mem = groups[gk];
    if (mem.length <= 1) continue;
    var refProduct = String(mem[0].row[COL.product] || '').trim();
    var refChannel = String(mem[0].row[COL.channel] || '').trim();
    var consistent = [mem[0]];
    for (var mi = 1; mi < mem.length; mi++) {
      var mp = String(mem[mi].row[COL.product] || '').trim();
      var mc = String(mem[mi].row[COL.channel] || '').trim();
      if (mp === refProduct && mc === refChannel) {
        consistent.push(mem[mi]);
      } else {
        var splitKey = '__SPLIT' + mem[mi].rowIdx;
        // 분리된 행은 원래 dealId(다른 행과 겹쳐 있던 값)를 그대로 들고 나가면 안 됨 — 그 값을
        // 그대로 반환하면 여러 공구건이 똑같은 dealId를 갖게 돼서, 캘린더/표에서 그중 아무 칩이나
        // 클릭해도 항상 그 dealId로 배열에서 "처음 발견되는" 건(대개 시트 첫 행)의 모달이 열리는
        // 버그가 생김. 여기서 메모리상 dealId를 비워두면, 이 함수가 끝난 뒤 doGet이 호출하는
        // _autoFillMissingDealIds가 "dealId 없는 행"으로 인식해 새 UUID를 발급해서 시트에도 써줌.
        mem[mi].row[COL.dealId] = '';
        groups[splitKey] = [mem[mi]];
        groupOrder.push(splitKey);
        mismatchSplit++;
        Logger.log('[dealId 불일치 분리] row ' + (mem[mi].rowIdx + 1) + ' (제품=' + mp + ', 채널=' + mc +
          ') — 그룹 대표행(제품=' + refProduct + ', 채널=' + refChannel + ')과 달라 별도 공구건으로 분리하고 ' +
          '기존 dealId를 비웠음(곧 새 dealId가 자동 발급됨). 다른 행과 dealId가 겹쳐 있었던 것으로 보임.');
      }
    }
    groups[gk] = consistent;
  }

  Logger.log('[파싱 진단] 전체 데이터 행=' + (data.length - DATA_START_ROW) +
    ' / 취소선 제외=' + skippedStrike + ' / 제품명 없음 제외=' + skippedNoProduct +
    ' / 브랜드 불일치 제외=' + skippedNonMinix + ' / dealId 불일치로 분리=' + mismatchSplit +
    ' / 최종 공구건 수=' + groupOrder.length);

  var deals = [];

  for (var g = 0; g < groupOrder.length; g++) {
    var members = groups[groupOrder[g]];
    // 코드순번 오름차순 정렬(값이 없거나 이상하면 맨 뒤로) — 가장 앞이 대표 행
    members.sort(function (a, b) {
      var sa = _numOrNull(a.row[COL.codeSeq]); if (sa == null) sa = 999;
      var sb = _numOrNull(b.row[COL.codeSeq]); if (sb == null) sb = 999;
      return sa - sb;
    });
    var primary = members[0];
    var pRow = primary.row;
    var pIdx = primary.rowIdx;

    var codes = [];
    for (var m = 0; m < members.length; m++) {
      var c = String(members[m].row[COL.code] || '').trim();
      if (c) codes.push(c);
    }

    /* 등급 결과 열(매출등급/팔로워 등급)을 프론트가 되기록할 때 쓰는 행 목록 (2026-09-14).
       원소 하나가 [시트 행 번호(1-based), 현재 매출등급 셀값, 현재 팔로워등급 셀값].
       · 등급은 채널 속성이라 그 채널이 등장하는 **모든 물리 행**에 같은 값을 써야 하는데, 공구건
         하나가 상품코드 수만큼 여러 행을 차지하고 그 행들이 시트에서 붙어 있지도 않다(코드가
         나중에 추가되면 시트 맨 아래에 붙음). 그래서 대표 행만으로는 부족하고 그룹 전체의 행
         번호를 프론트에 알려줘야 함.
       · 현재 셀값을 같이 실어 보내는 이유는 단 하나, "이미 같은 값이면 아예 요청을 안 보내기"
         위해서임. 이 두 값은 대시보드가 쓴 결과라 등급 판정에는 절대 쓰지 않는다(사람이 시트에서
         직접 고쳐도 무시되고 다음 기록 때 덮어써짐 — 수동 지정은 '등급(수동)' 열이 담당). */
    var tierRows = [];
    for (var tr = 0; tr < members.length; tr++) {
      tierRows.push([
        members[tr].rowIdx + 1,
        String(members[tr].row[COL.salesTier] || '').trim(),
        String(members[tr].row[COL.followerTier] || '').trim()
      ]);
    }

    var vendor     = String(pRow[COL.vendor]   || '').trim();
    var channel    = String(pRow[COL.channel]  || '').trim();
    var product    = String(pRow[COL.product]  || '').trim();
    var platform   = String(pRow[COL.platform] || '').trim();
    var salePrice  = _numOrNull(pRow[COL.salePrice]);
    /* 실적은 그룹의 모든 행을 합산한다 (2026-09-15).

       운영 규칙은 "실적은 대표 행에만"이고 대시보드가 쓰는 행도 대표 행 하나뿐이라, 예전엔
       대표 행 값만 읽었다. 그런데 상품코드별로 각각 따로 등록된 건(러브지나·하늘마켓 등)은
       행마다 자기 판매수량·매출을 갖고 있어서, 대표 행만 읽으면 나머지 코드의 실적이 통째로
       집계에서 사라진다. 프론트가 내용 기준으로 합쳐 보여주던 값이 바로 이 합계였다.
       행마다 값이 있으면 합치고, 대표 행에만 있으면 결과는 예전과 같다(= 안전한 일반화). */
    var qty = null, revenue = null, perfRows = 0;
    for (var pm = 0; pm < members.length; pm++) {
      var mq = _numOrNull(members[pm].row[COL.qty]);
      var mr = _numOrNull(members[pm].row[COL.revenue]);
      if (mq != null) qty = (qty || 0) + mq;
      if (mr != null) revenue = (revenue || 0) + mr;
      if (mq != null || mr != null) perfRows++;
    }
    var commission = _numOrNull(pRow[COL.commission]);
    if (commission != null && commission <= 1) commission = Math.round(commission * 1000) / 10;
    var year       = _numOrNull(pRow[COL.year]);
    var startCell  = pRow[COL.startMD];
    var endCell    = pRow[COL.endMD];
    var statusRaw  = String(pRow[COL.status] || '').trim();
    var format     = String(pRow[COL.format] || '').trim();
    var targetQty  = _numOrNull(pRow[COL.targetQty]);
    var marketingLink = String(pRow[COL.marketingLink] || '').trim();
    var option1    = String(pRow[COL.option1]   || '').trim();
    var option2    = _normalizeOpenTime(pRow[COL.option2]); // 오픈시간 — Date/시간소수/초포함 등 어떤 형태든 "HH:00"으로
    var firstCome  = String(pRow[COL.firstCome] || '').trim();
    var extraQty   = _numOrNull(pRow[COL.extraQty]);
    var note       = String(pRow[COL.note]      || '').trim();
    // 2026-08-18 신규 — 사은품(최대 3쌍)/선착순 수량/신규 자유입력 비고
    var giftItem1  = String(pRow[COL.giftItem1] || '').trim();
    var giftQty1   = String(pRow[COL.giftQty1]  || '').trim();
    var giftItem2  = String(pRow[COL.giftItem2] || '').trim();
    var giftQty2   = String(pRow[COL.giftQty2]  || '').trim();
    var giftItem3  = String(pRow[COL.giftItem3] || '').trim();
    var giftQty3   = String(pRow[COL.giftQty3]  || '').trim();
    var firstComeQty = String(pRow[COL.firstComeQty] || '').trim();
    var note2      = String(pRow[COL.note2]     || '').trim();
    var tier       = _normalizeTier(pRow[COL.tier]); // 허용값(TIER_OPTIONS) 밖이면 빈값=미분류
    var followers  = _normalizeFollowers(pRow[COL.followers]); // 공구 당시 팔로워 수(없으면 null=미입력)

    // 인플루언서 링크: 별도 링크 열(COL.link)에 값이 있으면 그걸 우선하고, 없으면 채널명 셀에
    // 걸린 하이퍼링크로 채움(둘 다 없으면 빈 값). 채널명 셀에 링크가 없는 행도 있을 수 있음.
    var linkColVal = String(pRow[COL.link] || '').trim();
    var channelCellLink = '';
    if (channelRich) {
      var chRichRow = channelRich[pIdx - DATA_START_ROW];
      if (chRichRow && chRichRow[0]) channelCellLink = chRichRow[0].getLinkUrl() || '';
    }
    var influencerLink = linkColVal || channelCellLink;

    var reels = [];
    if (reelRich) {
      var richRow = reelRich[pIdx - DATA_START_ROW];
      var thumbsArr = [];
      try { thumbsArr = JSON.parse(pRow[COL.thumbs] || '[]'); } catch (e) {}
      for (var k = 0; k < REEL_SLOT_COUNT; k++) {
        var rc = richRow ? richRow[k] : null;
        var txt = rc ? rc.getText() : '';
        var linkUrl = rc ? rc.getLinkUrl() : null;
        var v = txt ? _numOrNull(txt) : null;
        if (v != null || linkUrl) {
          reels.push({ views: v, url: linkUrl || '', thumb: thumbsArr[k] || '' });
        }
      }
    }

    // 조회수: Y열(저장 시점에 기록된 합계)에 기대지 않고, 릴스 슬롯(Z~AI)에서 매 요청마다 실시간
    // 합산함 — 모달의 합계 계산(_modalReels.reduce((s,r)=>s+(r.views||0),0))과 동일한 기준.
    // 릴스별 조회수는 입력해뒀지만 모달 저장을 안 해서 Y열이 비어 있는 건도 바로 반영되게 하기 위함
    // (2026-08-24 이슈: "저장 안 하면 조회수 —" 버그). 릴스 조회수가 하나도 없는 건(레거시로 Y열에만
    // 합계가 수동 입력된 경우 등)은 Y열 값을 그대로 사용.
    var hasReelViews = reels.some(function (r) { return r.views != null; });
    var views;
    if (hasReelViews) {
      views = reels.reduce(function (s, r) { return s + (r.views || 0); }, 0);
    } else {
      // 조회수도 같은 이유로 행 합산(릴스 조회수가 있으면 위에서 이미 릴스 기준으로 계산됨)
      views = null;
      for (var vm = 0; vm < members.length; vm++) {
        var vv = _numOrNull(members[vm].row[COL.views]);
        if (vv != null) views = (views || 0) + vv;
      }
      if (views === 0) views = null;
    }

    var startDate = _parseDate(startCell, year);
    var endDate   = _parseDate(endCell, year) || startDate;
    endDate = _fixYearWrap(startDate, endDate);

    // 진행상태 매칭: 공백류(일반 공백/전각 공백/줄바꿈 등, \s가 포괄)를 전부 제거하고 비교해서
    // "진행중" vs "진행 중" 같은 표기 차이에 흔들리지 않게 함. 그래도 못 알아본 값이면(오타 등)
    // 행 자체를 누락시키지 않고 날짜 기준으로 안전하게 분류 + 콘솔에 경고를 남겨 원인 추적 가능하게 함.
    var status;
    var sn = statusRaw.replace(/\s/g, '');
    var knownStatus = (sn === '종료' || sn === '완료') ? '완료'
      : (sn === '진행중' || sn === '진행') ? '진행중'
      : (sn === '예정') ? '예정'
      : null;
    if (knownStatus) {
      status = knownStatus;
    } else {
      if (sn) {
        Logger.log('[상태값 미매칭] row ' + (pIdx + 1) + ' 진행상태="' + statusRaw +
          '" — 알려진 값(완료/진행중/예정)과 다름. 날짜 기준으로 자동 분류함(행은 누락시키지 않음).');
      }
      if (startDate) {
        var sd = new Date(startDate + 'T00:00:00');
        var ed = new Date((endDate || startDate) + 'T00:00:00');
        if (ed < today)       status = '완료';
        else if (sd <= today) status = '진행중';
        else                  status = '예정';
      } else {
        status = '예정';
      }
    }

    deals.push({
      id:          pIdx + 1, // 대표 행의 실제 물리 행 번호(1-based) — 리스트 렌더링 key 용도로만 사용, 식별자는 dealId
      dealId:      String(pRow[COL.dealId] || '').trim(),
      brand:       'Minix',
      product:     product,
      channel:     channel,
      influencer:  channel,
      vendor:      vendor,
      platform:    platform,
      format:      format,
      start:       startDate || '',
      end:         endDate   || '',
      targetQty:   targetQty,
      status:      status,
      views:       views,
      /* 실적이 들어 있는 시트 행 수 — 2 이상이면 상품코드별로 실적이 나뉘어 있다는 뜻이다.
         모달은 이때 판매수량·조회수를 직접 못 고치게 막는다(한 칸으로는 어느 행에 쓸지 정할 수 없음). */
      perfRows:    perfRows,
      qty:         qty,
      revenue:     revenue,
      codes:       codes,
      composition: String(pRow[COL.composition] || '').trim(),
      link:        influencerLink,
      marketingLink: marketingLink,
      option1:     option1,
      option2:     option2,
      firstCome:   firstCome,
      extraQty:    extraQty,
      reels:       reels,
      sale:        salePrice,
      commission:  commission,
      note:        note,
      giftItem1: giftItem1, giftQty1: giftQty1,
      giftItem2: giftItem2, giftQty2: giftQty2,
      giftItem3: giftItem3, giftQty3: giftQty3,
      firstComeQty: firstComeQty,
      note2: note2,
      tier: tier,
      followers: followers,
      // 채널 단위 속성(플랫폼 ID) — 열이 없으면 빈 문자열. 대표 행 값을 그대로 내려보낸다.
      igId: COL.igId >= 0 ? String(pRow[COL.igId] || '').trim() : '',
      ytId: COL.ytId >= 0 ? String(pRow[COL.ytId] || '').trim() : '',
      tierRows:    tierRows,
      rowCount:    members.length // 이 그룹(dealId)이 시트에서 실제로 몇 개 물리 행을 차지하는지 — 프론트가 "N행" 안내에 사용
    });
  }

  Logger.log('파싱 완료: ' + deals.length + '건 / 시트: ' + sheet.getName());
  return { deals: deals };
}

/* 시트 쪽 부가 정비 — 내부용 열 숨기기 + 등급 결과 열(매출등급/팔로워 등급)의 헤더 메모·조건부 서식.
   ⚠ 2026-09-14: 예전엔 여기서 "헤더가 비어 있으면 만들어 넣는" 일도 했는데, 열 위치의 근거가
   2행 헤더 텍스트 하나로 일원화된 뒤로는 그게 모순이 됨 — 헤더가 없으면 애초에 어느 열에 만들어야
   할지 알 수 없고, 코드가 임의 위치에 만들어 넣는 순간 "근거"가 두 개로 갈라지기 때문.
   이제 헤더가 없으면 _resolveCols가 실제 2행 헤더를 통째로 실은 에러로 알려주고, 사람이 시트에서
   직접 추가하는 것이 정규 경로다. */
function _ensureExtraHeaders(sheet) {
  // 등급 열은 의미가 '수동 지정'으로 바뀌었으므로, 구 문구('등급')로 남아 있으면 한 번만 갱신함
  // (해석 자체는 '등급(수동)'/'등급' 둘 다 후보로 두고 있어서 문구가 어느 쪽이든 동작함)
  try {
    var tierHd = sheet.getRange(HEADER_ROW, COL.tier + 1);
    if (String(tierHd.getValue() || '').trim() === '등급') tierHd.setValue(TIER_HEADER);
  } catch (e) { Logger.log('등급 헤더 갱신 실패 (무시): ' + e); }
  try { sheet.hideColumns(COL.dealId + 1); } catch (e) { Logger.log('dealId 열 숨기기 실패 (무시): ' + e); }
  try { sheet.hideColumns(COL.codeSeq + 1); } catch (e) { Logger.log('코드순번 열 숨기기 실패 (무시): ' + e); }
  _ensureTierResultColumnChrome(sheet);
}

/* 매출등급/팔로워 등급 열의 "사람이 보는 부분" — 헤더 메모와 등급별 4색 조건부 서식.
   매 요청마다 다시 칠하면 낭비이므로, 두 열의 위치를 지문 삼아 문서 속성에 찍어두고 달라졌을 때만
   실행함(열이 밀려서 위치가 바뀌면 자동으로 다시 칠해짐).
   데이터 유효성(드롭다운)은 일부러 넣지 않음 — 사람이 고르는 칸이 아니라 결과 칸이기 때문. */
var TIER_CHROME_PROP_KEY = 'tierResultColChrome';
function _ensureTierResultColumnChrome(sheet) {
  var stamp = _colLetter(COL.salesTier) + ',' + _colLetter(COL.followerTier) + ',v1';
  var props;
  try { props = PropertiesService.getDocumentProperties(); } catch (e) { props = null; }
  if (props && props.getProperty(TIER_CHROME_PROP_KEY) === stamp) return;

  try {
    sheet.getRange(HEADER_ROW, COL.salesTier + 1).setNote(TIER_RESULT_NOTE);
    sheet.getRange(HEADER_ROW, COL.followerTier + 1).setNote(TIER_RESULT_NOTE);

    var maxRows = sheet.getMaxRows();
    if (maxRows > DATA_START_ROW) {
      var ranges = [
        sheet.getRange(DATA_START_ROW + 1, COL.salesTier + 1, maxRows - DATA_START_ROW, 1),
        sheet.getRange(DATA_START_ROW + 1, COL.followerTier + 1, maxRows - DATA_START_ROW, 1)
      ];
      var mine = {};
      for (var r = 0; r < ranges.length; r++) mine[ranges[r].getA1Notation()] = true;
      // 이 두 열만을 대상으로 하는 기존 규칙(= 이전 실행이 남긴 것)만 걷어냄. 다른 열이 하나라도
      // 섞인 규칙은 사람이 직접 만든 것일 수 있으므로 절대 건드리지 않음.
      var rules = sheet.getConditionalFormatRules();
      var kept = [];
      for (var i = 0; i < rules.length; i++) {
        var rr = rules[i].getRanges(), onlyMine = true;
        for (var j = 0; j < rr.length; j++) if (!mine[rr[j].getA1Notation()]) { onlyMine = false; break; }
        if (!onlyMine) kept.push(rules[i]);
      }
      for (var t = 0; t < TIER_OPTIONS.length; t++) {
        var color = TIER_SHEET_COLORS[TIER_OPTIONS[t]];
        kept.push(SpreadsheetApp.newConditionalFormatRule()
          .whenTextEqualTo(TIER_OPTIONS[t])
          .setBackground(color.bg).setFontColor(color.fg)
          .setRanges(ranges).build());
      }
      sheet.setConditionalFormatRules(kept);
    }
    if (props) props.setProperty(TIER_CHROME_PROP_KEY, stamp);
    Logger.log('[등급 결과 열 정비] 메모·조건부 서식 적용 완료 (' + stamp + ')');
  } catch (e) {
    // 표시용 장식이라 실패해도 데이터 흐름과는 무관 — 다음 실행에서 다시 시도되게 속성만 안 찍고 넘어감
    Logger.log('등급 결과 열 정비 실패 (무시): ' + e);
  }
}

// dealId가 비어있는 행(사람이 시트에 직접 새 행을 추가한 경우 등)에 새 UUID+codeSeq=1을 발급해 기록함.
// parseMainSheet 단계에서 이미 "단독 그룹"으로 취급됐으므로 다른 행과의 관계를 새로 계산할 필요 없음.
function _autoFillMissingDealIds(sheet, deals) {
  var filled = 0;
  for (var i = 0; i < deals.length; i++) {
    var d = deals[i];
    if (d.dealId) continue;
    var newId = Utilities.getUuid();
    sheet.getRange(d.id, COL.dealId + 1).setValue(newId);
    sheet.getRange(d.id, COL.codeSeq + 1).setValue(1);
    d.dealId = newId;
    filled++;
  }
  if (filled > 0) { Logger.log('[dealId 자동 백필] ' + filled + '건에 새 dealId 발급함'); _invalidateDealRowMap(); }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 1회성 마이그레이션: 사은품/오픈시간/선착순/적립금 구조화 (2026-08-18) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Apps Script 편집기 상단 함수 선택 드롭다운에서 migrateGiftFieldsOnce를 골라 "▶ 실행"으로
// 수동 실행할 것(URL 호출 아님, doGet/doPost와 무관). 실행 순서:
//  1) _backupMainSheetOnce가 실적통합 시트 전체를 그대로 복제해 숨긴 백업 시트로 보존(최초 1회만).
//  2) 각 행의 구 추가옵션1(S)/추가옵션2(T)/선착순(U)/비고(X)를 읽어 새 구조로 변환.
//  3) 새 품목/시간/적립금 목록과 확실히 매칭되는 값만 새 드롭다운 값으로 정규화하고, 매칭 안 되는
//     원문은 전부(구 비고 포함) 신규 비고(AZ)로 그대로 옮겨 절대 유실되지 않게 함.
//  4) 구 추가옵션1(S) 원본 텍스트 자체는 지우지 않고 그대로 둠(레거시 열, 더 이상 안 읽지만 안전망).
// 이미 새 열(AS/AY/AZ 중 하나라도)이 채워진 행은 이미 처리된 것으로 보고 건너뜀 — 재실행해도 안전.
//
// 구 추가옵션1/2·선착순·비고 원문 4개를 새 구조로 변환하는 핵심 로직 — migrateGiftFieldsOnce와
// (마이그레이션 보정용) remigrateFromBackup이 이 함수 하나를 공유해서 로직이 두 곳에서 어긋나지 않게 함.
// 품목은 매칭되는데 수량 텍스트에 숫자가 있긴 하지만 표준 수량(50, 100~3000 100단위)과 안 맞으면
// "전원증정"으로 추측하지 않고(그 표현은 "수량 지정이 아예 없었다"는 뜻이라 다른 의미가 됨) 원문을
// 그대로 신규 비고에 보존하고 수량 칸은 비워둠 — 숫자 자체가 아예 없을 때만 "전원증정"으로 채움.
function _deriveGiftFields(oldOption1, oldOption2, oldFirstCome, oldNote) {
  var archived = [];
  var stat = {
    giftMatched: 0, giftUnmatched: 0,
    openTimeMatched: 0, openTimeUnmatched: 0,
    firstComeMatched: 0, firstComeUnmatched: 0,
    pointsMatched: 0
  };

  oldNote = String(oldNote || '').trim();
  if (oldNote) archived.push(oldNote);
  var points = _matchPoints(oldNote);
  if (points) stat.pointsMatched++;

  oldOption2 = String(oldOption2 || '').trim();
  var openTime = _matchOpenTime(oldOption2);
  if (openTime) stat.openTimeMatched++;
  else if (oldOption2) { stat.openTimeUnmatched++; archived.push('[구 추가옵션2] ' + oldOption2); }

  oldFirstCome = String(oldFirstCome || '').trim();
  var firstComeItem = '', firstComeQty = '';
  var fcItem = _matchGiftItem(oldFirstCome);
  if (fcItem) {
    stat.firstComeMatched++;
    firstComeItem = fcItem;
    var fcQty = _matchQtyNumber(oldFirstCome);
    if (fcQty != null) firstComeQty = fcQty;
    else if (_extractQtyWithUnit(oldFirstCome) == null) firstComeQty = QTY_UNSPECIFIED_LABEL;
    else archived.push('[구 선착순 수량확인필요] ' + oldFirstCome);
  } else if (oldFirstCome) {
    stat.firstComeUnmatched++;
    archived.push('[구 선착순] ' + oldFirstCome);
  }

  oldOption1 = String(oldOption1 || '').trim();
  var giftItem1 = '', giftQty1 = '';
  var giftItem = _matchGiftItem(oldOption1);
  if (giftItem) {
    stat.giftMatched++;
    giftItem1 = giftItem;
    var giftQty = _matchQtyNumber(oldOption1);
    if (giftQty != null) giftQty1 = giftQty;
    else if (_extractQtyWithUnit(oldOption1) == null) giftQty1 = QTY_UNSPECIFIED_LABEL;
    else archived.push('[구 추가옵션1 수량확인필요] ' + oldOption1);
  } else if (oldOption1) {
    stat.giftUnmatched++;
    archived.push('[구 추가옵션1] ' + oldOption1);
  }

  return {
    points: points || '', openTime: openTime || '',
    firstComeItem: firstComeItem, firstComeQty: firstComeQty,
    giftItem1: giftItem1, giftQty1: giftQty1,
    note2: archived.join(' / '),
    stat: stat
  };
}

function migrateGiftFieldsOnce() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _mainSheet(ss);
  if (!sheet) { Logger.log('[마이그레이션] 실적통합 시트를 찾을 수 없어 중단'); return; }

  _backupMainSheetOnce(ss, sheet);
  _ensureExtraHeaders(sheet);

  var lastDataRow = _getLastDataRow(sheet, COL.channel + 1);
  if (lastDataRow <= DATA_START_ROW) { Logger.log('[마이그레이션] 데이터 행이 없어 중단'); return; }

  var numCols = sheet.getMaxColumns();
  var range = sheet.getRange(DATA_START_ROW + 1, 1, lastDataRow - DATA_START_ROW, numCols);
  var data = range.getValues();

  var stats = {
    total: 0, skippedAlready: 0,
    giftMatched: 0, giftUnmatched: 0,
    openTimeMatched: 0, openTimeUnmatched: 0,
    firstComeMatched: 0, firstComeUnmatched: 0,
    pointsMatched: 0
  };

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var hasAnyOld = String(row[COL.option1] || '').trim() || String(row[COL.option2] || '').trim() ||
      String(row[COL.firstCome] || '').trim() || String(row[COL.note] || '').trim();
    if (!hasAnyOld) continue; // 옮길 것 자체가 없는 빈 행은 건너뜀

    var alreadyDone = String(row[COL.giftItem1] || '').trim() || String(row[COL.firstComeQty] || '').trim() ||
      String(row[COL.note2] || '').trim();
    if (alreadyDone) { stats.skippedAlready++; continue; }

    stats.total++;

    // S(구 추가옵션1) 자체는 legacy로 그대로 둠(비파괴, 건드리지 않음) — 파생 결과만 새 열에 기록
    var derived = _deriveGiftFields(row[COL.option1], row[COL.option2], row[COL.firstCome], row[COL.note]);
    row[COL.note]         = derived.points;
    row[COL.option2]      = derived.openTime;
    row[COL.firstCome]    = derived.firstComeItem;
    row[COL.firstComeQty] = derived.firstComeQty;
    row[COL.giftItem1]    = derived.giftItem1;
    row[COL.giftQty1]     = derived.giftQty1;
    row[COL.note2]        = derived.note2;

    stats.giftMatched += derived.stat.giftMatched; stats.giftUnmatched += derived.stat.giftUnmatched;
    stats.openTimeMatched += derived.stat.openTimeMatched; stats.openTimeUnmatched += derived.stat.openTimeUnmatched;
    stats.firstComeMatched += derived.stat.firstComeMatched; stats.firstComeUnmatched += derived.stat.firstComeUnmatched;
    stats.pointsMatched += derived.stat.pointsMatched;
  }

  range.setValues(data);
  SpreadsheetApp.flush();
  _invalidateDashboardCache();

  Logger.log('[마이그레이션 완료] ' + JSON.stringify(stats));
  return stats;
}

// 마이그레이션 실행 전 원본을 같은 스프레드시트 안에 복제해 숨긴 시트로 백업. 이미 백업이 있으면
// 다시 만들지 않음 — 마이그레이션을 여러 번 재실행해도 "진짜 원본"인 최초 백업은 절대 덮이지 않음.
var MAIN_SHEET_BACKUP_NAME = '실적통합_백업_마이그레이션전';
function _backupMainSheetOnce(ss, sheet) {
  var existing = ss.getSheetByName(MAIN_SHEET_BACKUP_NAME);
  if (existing) { Logger.log('[백업] 이미 존재함 — 다시 만들지 않음: ' + MAIN_SHEET_BACKUP_NAME); return existing; }
  var copy = sheet.copyTo(ss);
  copy.setName(MAIN_SHEET_BACKUP_NAME);
  try { copy.hideSheet(); } catch (e) { Logger.log('백업 시트 숨기기 실패 (무시): ' + e); }
  Logger.log('[백업] 완료 — 시트명: ' + MAIN_SHEET_BACKUP_NAME);
  return copy;
}

// ⚠ 2026-08-18 보정용 — migrateGiftFieldsOnce의 최초 버전에 있던 두 가지 정밀도 손실 버그
// (①분 단위 오픈시간이 정시로 반올림됨, ②품목은 매칭됐지만 수량이 표준 목록과 안 맞을 때 원문 대신
// "전원증정"으로 덮어씀)를 고친 뒤, 이미 마이그레이션이 끝난 라이브 시트를 백업 시트의 원본 텍스트
// 기준으로 처음부터 다시 계산해서 덮어씀. _deriveGiftFields를 그대로 재사용하므로 로직은 항상 최신
// 수정 버전과 일치함 — 백업이 원본 그대로이므로 몇 번을 다시 실행해도 항상 같은(올바른) 결과가 나옴.
// Apps Script 편집기에서 이 함수를 직접 선택해 실행할 것.
// ⚠ 이 함수는 백업 시트의 행을 **현재 실적통합 시트의 열 배치 기준**으로 읽는다. 백업을 뜬 뒤
// 열이 삽입/이동됐다면(2026-09-14 매출등급/팔로워등급 삽입 등) 백업 쪽 열이 어긋나므로 절대
// 재실행하지 말 것 — 이미 1회성으로 완료된 보정이다.
function remigrateFromBackup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _mainSheet(ss);
  var backup = ss.getSheetByName(MAIN_SHEET_BACKUP_NAME);
  if (!sheet || !backup) { Logger.log('[보정] 실적통합 또는 백업 시트를 찾을 수 없어 중단'); return; }

  var lastDataRow = _getLastDataRow(sheet, COL.channel + 1);
  var backupLastDataRow = _getLastDataRow(backup, COL.channel + 1);
  if (lastDataRow !== backupLastDataRow) {
    Logger.log('[보정] 실적통합(' + lastDataRow + '행)과 백업(' + backupLastDataRow + '행)의 데이터 행 수가 달라 ' +
      '안전하게 중단합니다 — 백업 이후 실적통합에 행이 추가/삭제된 것으로 보입니다. 수동 확인 필요.');
    return;
  }
  if (lastDataRow <= DATA_START_ROW) { Logger.log('[보정] 데이터 행이 없어 중단'); return; }

  var numRows = lastDataRow - DATA_START_ROW;
  var backupOldCols = backup.getRange(DATA_START_ROW + 1, 1, numRows, backup.getLastColumn()).getValues();

  var noteRange = sheet.getRange(DATA_START_ROW + 1, COL.note + 1, numRows, 1);
  var option2Range = sheet.getRange(DATA_START_ROW + 1, COL.option2 + 1, numRows, 1);
  var firstComeRange = sheet.getRange(DATA_START_ROW + 1, COL.firstCome + 1, numRows, 1);
  var firstComeQtyRange = sheet.getRange(DATA_START_ROW + 1, COL.firstComeQty + 1, numRows, 1);
  var giftItem1Range = sheet.getRange(DATA_START_ROW + 1, COL.giftItem1 + 1, numRows, 1);
  var giftQty1Range = sheet.getRange(DATA_START_ROW + 1, COL.giftQty1 + 1, numRows, 1);
  var note2Range = sheet.getRange(DATA_START_ROW + 1, COL.note2 + 1, numRows, 1);

  var noteOut = [], option2Out = [], firstComeOut = [], firstComeQtyOut = [], giftItem1Out = [], giftQty1Out = [], note2Out = [];
  var stats = {
    total: 0,
    giftMatched: 0, giftUnmatched: 0,
    openTimeMatched: 0, openTimeUnmatched: 0,
    firstComeMatched: 0, firstComeUnmatched: 0,
    pointsMatched: 0
  };

  for (var i = 0; i < numRows; i++) {
    var bRow = backupOldCols[i];
    var hasAnyOld = String(bRow[COL.option1] || '').trim() || String(bRow[COL.option2] || '').trim() ||
      String(bRow[COL.firstCome] || '').trim() || String(bRow[COL.note] || '').trim();
    if (!hasAnyOld) {
      noteOut.push(['']); option2Out.push(['']); firstComeOut.push(['']); firstComeQtyOut.push(['']);
      giftItem1Out.push(['']); giftQty1Out.push(['']); note2Out.push(['']);
      continue;
    }
    stats.total++;
    var derived = _deriveGiftFields(bRow[COL.option1], bRow[COL.option2], bRow[COL.firstCome], bRow[COL.note]);
    noteOut.push([derived.points]);
    option2Out.push([derived.openTime]);
    firstComeOut.push([derived.firstComeItem]);
    firstComeQtyOut.push([derived.firstComeQty]);
    giftItem1Out.push([derived.giftItem1]);
    giftQty1Out.push([derived.giftQty1]);
    note2Out.push([derived.note2]);

    stats.giftMatched += derived.stat.giftMatched; stats.giftUnmatched += derived.stat.giftUnmatched;
    stats.openTimeMatched += derived.stat.openTimeMatched; stats.openTimeUnmatched += derived.stat.openTimeUnmatched;
    stats.firstComeMatched += derived.stat.firstComeMatched; stats.firstComeUnmatched += derived.stat.firstComeUnmatched;
    stats.pointsMatched += derived.stat.pointsMatched;
  }

  noteRange.setValues(noteOut);
  option2Range.setValues(option2Out);
  firstComeRange.setValues(firstComeOut);
  firstComeQtyRange.setValues(firstComeQtyOut);
  giftItem1Range.setValues(giftItem1Out);
  giftQty1Range.setValues(giftQty1Out);
  note2Range.setValues(note2Out);
  SpreadsheetApp.flush();
  _invalidateDashboardCache();

  Logger.log('[보정 완료] 백업 원본 기준으로 전체 재계산함 — ' + JSON.stringify(stats));
  return stats;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── dealId 그룹 조회/조작 공통 헬퍼 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 해당 dealId를 가진 모든 물리 행을 코드순번 오름차순으로 반환. [0]이 항상 대표 행.
// 반환 항목: {row: 1-based 물리 행 번호, codeSeq: 숫자}

// 그룹 전체(모든 코드순번 행)에 동일하게 반영하는 필드 — 사람이 시트를 훑어볼 때 헷갈리지 않도록
// (등급은 채널명에 종속된 값이라 channel과 같은 취급 — 그룹의 모든 행에 동일하게 기록)
// ⚠ 2026-09-14: 예전엔 {필드명: COL.xxx} 형태의 맵이었는데, COL이 파일 로드 시점의 고정 상수가
// 아니라 _resolveCols가 런타임에 채우는 객체가 되면서 그 방식이 성립하지 않게 됨(로드 시점엔 전부
// undefined). 마침 이 맵들은 키와 COL 키가 이름까지 동일했으므로, 키 목록만 남기고 열 인덱스는
// 쓰는 순간 COL[k]로 조회하도록 바꿈.
var GROUP_MIRROR_KEYS = ['brand', 'product', 'channel', 'vendor', 'tier'];

// 대표 행(코드순번=1)에만 반영하는 필드 — 실적/조건 값은 그룹당 하나만 존재해야 하므로 중복 저장 금지.
// 팔로워 수는 "공구 진행 당시" 스냅샷이라 채널이 아니라 건에 속하는 값이어서 여기(대표 행)에 들어감.
var PRIMARY_ONLY_KEYS = [
  'platform', 'link', 'format', 'composition',
  'targetQty', 'marketingLink',
  'option1', 'option2', 'firstCome',
  'extraQty', 'note',
  'giftItem1', 'giftQty1',
  'giftItem2', 'giftQty2',
  'giftItem3', 'giftQty3',
  'firstComeQty', 'note2',
  // 채널 단위 필드지만 "이 건만 저장"을 고를 수 있어야 하므로 대표 행 전용 경로에도 둔다.
  // 채널 전체 전파는 data.channelFields가 따로 담당한다(둘은 서로 배타적으로 쓰임).
  'followers', 'igId', 'ytId'
];

// 채널명(E열) 셀의 텍스트는 그대로 두고 하이퍼링크만 걸거나 제거함 — 별도 링크 열(COL.link)과
// 어긋나지 않도록 저장 시 항상 같이 갱신함. url이 falsy면 링크 제거(텍스트는 유지).
function _buildChannelRichText(text, url) {
  var builder = SpreadsheetApp.newRichTextValue().setText(text);
  if (url) builder.setLinkUrl(0, text.length, url);
  return builder.build();
}
function _setChannelLink(sheet, row, url) {
  var cell = sheet.getRange(row, COL.channel + 1);
  var text = String(cell.getValue() || '');
  if (!text) return; // 채널명 자체가 비어있으면 링크를 걸 자리가 없음
  cell.setRichTextValue(_buildChannelRichText(text, url));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── doPost: 접속자 하트비트(presence) 전용 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 공구 추가/수정/삭제/실적 기입 등 쓰기 액션은 전부 doGet의 _handleWriteAction으로 이관됨
// (2026-07-29 — POST가 Apps Script의 302 리다이렉트 처리에서 본문을 유실시키는 문제 때문).
// presence만 예외로 여기 남겨둠 — 이 경로는 한 번도 실패한 적 없어서 건드릴 이유가 없었음.

function doPost(e) {
  _reqStartMs = Date.now();
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('요청 본문(postData)이 비어있습니다.');
    }
    var body = JSON.parse(e.postData.contents);
    _renewedSessionToken = null;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    /* 세션 토큰은 본문으로도, 쿼리로도 올 수 있다 — _authRequest는 e.parameter만 보므로
       본문으로 온 경우 그쪽에 채워 넣어 한 곳에서만 판정하게 한다(검증 경로를 둘로 만들지 않는다). */
    if (body.session && e.parameter && !e.parameter.session) e.parameter.session = body.session;
    var auth = _authRequest(ss, e);
    if (!auth.ok) return _json({ error: 'AUTH_REQUIRED', reason: auth.reason });

    if (body.action === 'presence') return _presenceHeartbeat(auth);
    // 오프라인 원장(apps-script-offline.js) — 업로드 레코드가 수백 KB라 GET 청크 대신 본문으로 받는다
    // 파트 홈 집계(home_, apps-script-home.js)도 같은 창구로 받는다
    if (/^(offline|home)_/.test(String(body.action || ''))) return _offlineHandle(body.action, body.data, auth);
    throw new Error('doPost는 presence·offline_ 전용입니다(파트 홈 home_ 포함) — 그 외 액션(' + body.action + ')은 doGet(GET)으로 보내야 합니다.');
  } catch (err) {
    return _json({ error: err.toString() });
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 쓰기 액션(GET 경유): 공구 추가 / 수정 / 삭제 / 실적 기입 등 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// doGet에서 e.parameter.action이 있으면 여기로 라우팅됨. 처리 로직(각 _addDeal/_updateDeal 등)은
// 예전 doPost가 쓰던 함수를 100% 그대로 재사용 — 바뀐 건 "어떻게 데이터가 도착하는가"뿐, "도착한
// 데이터를 어떻게 처리하는가"는 전혀 안 바뀜.
//
// 페이로드는 e.parameter.payload(JSON 문자열, URL 인코딩된 채로 도착 — Apps Script가 자동으로
// 디코딩해서 e.parameter에 넣어줌)로 옴. 너무 길어서 프론트가 여러 청크로 쪼개 보낸 경우
// (e.parameter.chunkTotal > 1)는 CacheService에 청크를 모아뒀다가 마지막 청크가 도착했을 때만
// 조립해서 실제 처리를 실행함 — 그 전 청크들은 "받았다"는 가벼운 확인 응답만 돌려줌.
function _handleWriteAction(e, auth) {
  _tmStart();
  _lastJsonObj = null;
  var action = e.parameter.action;
  // ⚠ 2026-07-29 이분 탐색용 진단 체크포인트 — e.parameter.debugStage가 '0'~'3'이면 그 지점까지만
  // 실행하고 조기 반환함(실제 시트 변경 없음). 정상 저장 요청은 이 파라미터를 아예 안 보내므로 평소
  // 동작에는 전혀 영향 없음. 편집기의 가짜 e 객체 테스트는 성공하는데 실제 브라우저 요청만 실패하는
  // 문제(2026-07-29)의 원인이 "요청 파싱/라우팅"과 "실제 처리 로직" 중 어느 쪽인지 좁히는 용도.
  // 프론트의 _diagWriteStage(n)으로 각 단계를 개별 호출해볼 수 있음.
  var debugStage = e.parameter.debugStage;
  try {
    if (debugStage === '0') {
      Logger.log('[진단0] action=' + action + ' — payload 파라미터 없이도 쓰기 라우팅까지 도달하는지 확인');
      return _json({ success: true, stage: 0, note: 'payload 없이도 doGet 쓰기 라우팅까지 도달함' });
    }

    var chunkTotal = e.parameter.chunkTotal ? parseInt(e.parameter.chunkTotal, 10) : 0;
    var payloadRaw;

    if (chunkTotal > 1) {
      var chunkIndex = parseInt(e.parameter.chunkIndex, 10);
      var chunkId = e.parameter.chunkId || '';
      if (!chunkId) throw new Error('청크 요청에 chunkId가 없습니다.');
      _storeWriteChunk(chunkId, chunkIndex, e.parameter.payload || '');
      Logger.log('[doGet 쓰기청크] action=' + action + ' chunkId=' + chunkId + ' ' + (chunkIndex + 1) + '/' + chunkTotal);
      if (chunkIndex < chunkTotal - 1) {
        return _json({ success: true, chunkReceived: chunkIndex }); // 마지막 청크 전까지는 확인 응답만
      }
      payloadRaw = _assembleWriteChunks(chunkId, chunkTotal);
      if (payloadRaw == null) {
        throw new Error('청크 조립 실패 — 일부 청크가 누락되었거나 만료되었습니다(chunkId=' + chunkId + ').');
      }
    } else {
      payloadRaw = e.parameter.payload || '';
    }
    if (!payloadRaw) throw new Error('요청 payload가 비어있습니다.');

    if (debugStage === '1') {
      Logger.log('[진단1] action=' + action + ' — payload 파라미터(길이 ' + payloadRaw.length + ') 수신까지 도달(아직 파싱 전)');
      return _json({ success: true, stage: 1, note: 'payload 파라미터 수신까지 정상(파싱 전)', payloadLen: payloadRaw.length });
    }

    var data = JSON.parse(payloadRaw);
    Logger.log('[doGet 쓰기] action=' + action + ' / data 키=' + (data ? Object.keys(data).join(',') : '(없음)'));

    if (debugStage === '2') {
      Logger.log('[진단2] action=' + action + ' — payload JSON.parse 성공, keys=' + Object.keys(data).join(','));
      return _json({ success: true, stage: 2, note: 'payload JSON.parse까지 정상', dataKeys: Object.keys(data) });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (debugStage === '3') {
      var sheetCheck = ss.getSheetByName(MAIN_SHEET);
      Logger.log('[진단3] action=' + action + ' — SpreadsheetApp 접근 성공, sheet=' + (sheetCheck ? sheetCheck.getName() : '(없음)'));
      return _json({ success: true, stage: 3, note: 'SpreadsheetApp 접근까지 정상', sheetFound: !!sheetCheck });
    }

    _tmMark('parse'); // 여기까지가 payload 수신·파싱·시트 접근

    var resp;
    // 회고 문서는 실적통합과 무관한 별도 시트라 대시보드 캐시를 무효화할 필요가 없음 — 이 액션들만 건너뜀.
    var skipCacheInvalidate = false;
    // 행을 추가/삭제하는 액션만 짧게 직렬화 — 동시 저장이 같은 '마지막 데이터 행'을 계산해
    // 서로 덮어쓰는 것을 막는다(경합이 없으면 대기 0). 값만 바꾸는 액션은 락을 걸지 않음.
    if (action === 'addSalesRow') resp = _withStructLock(function () { return _addDeal(ss, data); });
    else if (action === 'addPerf') resp = _addPerf(ss, data);
    else if (action === 'addCalendarEvent') resp = _addCalendarEvent(ss, data);
    else if (action === 'updateCalendarEvent') resp = _updateCalendarEvent(ss, data);
    else if (action === 'deleteCalendarEvent') resp = _deleteCalendarEvent(ss, data);
    else if (action === 'saveReels') resp = _saveReels(ss, data);
    else if (action === 'updateDeal') resp = _withStructLock(function () { return _updateDeal(ss, data); });
    else if (action === 'deleteDeal') resp = _withStructLock(function () { return _deleteDeal(ss, data); });
    else if (action === 'clearChannelTier') resp = _clearChannelTier(ss, data);
    else if (action === 'updateChannelFollowers') resp = _updateChannelFollowers(ss, data);
    else if (action === 'writeTiers') resp = _writeTiers(ss, data);
    else if (action === 'updateChannelFields') resp = _updateChannelFields(ss, data);
    else if (action === 'uploadThumbnail') resp = _uploadThumbnail(data);
    else if (action === 'saveReview') { resp = _saveReview(ss, data, auth); skipCacheInvalidate = true; }
    else if (action === 'deleteReview') { resp = _deleteReview(ss, data); skipCacheInvalidate = true; }
    else if (action === 'duplicateReview') { resp = _duplicateReview(ss, data, auth); skipCacheInvalidate = true; }
    else if (action === 'uploadReviewImage') { resp = _uploadReviewImage(data); skipCacheInvalidate = true; }
    else if (action === 'uploadReviewImageByUrl') { resp = _uploadReviewImageByUrl(data); skipCacheInvalidate = true; }
    else if (action === 'shareReviewImages') { resp = _shareReviewImages(data); skipCacheInvalidate = true; }
    else throw new Error('Unknown action: ' + action);

    // ⚠ 2026-07-29 근본 원인: Apps Script는 setValue/setValues 등 시트 쓰기를 스크립트 실행이
    // 끝나는 시점에 한꺼번에 flush(반영)하는데, 그때 데이터 확인 규칙(드롭다운) 위반 같은 예외가
    // 터지면 이미 위에서 resp를 만들고 return하기 전인데도 "실행 자체가 나중에 실패"로 끝나버려서
    // 이 함수의 try-catch로는 절대 못 잡았음 — 그 결과가 CORS 헤더 없는 에러 페이지로 나가
    // "CORS 차단"으로 위장돼 있었던 것(진짜 원인은 시트 검증 예외였음). 여기서 명시적으로 flush를
    // 호출해서, 검증 위반이 있으면 반드시 지금 이 자리에서(아직 try 안에서) 터지게 만들어 catch가
    // 잡을 수 있게 함 — 이후로 이런 예외는 정상적인 JSON({error:'...데이터 확인 규칙...'}) 응답으로
    // 나가고, 실행 기록에도 "완료됨"으로 남게 됨(에러 응답을 정상적으로 반환한 것이므로).
    _tmMark('handler');
    SpreadsheetApp.flush();
    _tmMark('flush');

    if (!skipCacheInvalidate) {
      // 저장한 행만 캐시에서 갈아끼우고, 그게 불가능한 액션/상황이면 통째로 무효화.
      // (무효화는 다음 조회가 전체 재파싱을 떠안는다는 뜻이라, 가능하면 부분 갱신 쪽이 이득)
      if (!_patchDashboardCache(_lastJsonObj)) _invalidateDashboardCache();
    }
    _tmMark('cache');

    Logger.log('[doGet 쓰기 완료] action=' + action + ' / ' + JSON.stringify(_tmReport()));
    // 구간 시간을 응답에 실어 보냄 — 핸들러가 이미 _json()으로 직렬화했으므로, 그때 붙잡아둔
    // 원본 객체(_lastJsonObj)에 timings를 얹어 다시 직렬화한다(작은 객체라 비용 무시 가능).
    if (_lastJsonObj) {
      _lastJsonObj.timings = _tmReport();
      return _json(_lastJsonObj);
    }
    return resp;
  } catch (err) {
    Logger.log('[doGet 쓰기 실패] action=' + action + ' / 에러=' + err + ' / 스택=\n' + (err && err.stack));
    return _json({ error: err.toString(), action: action, stack: (err && err.stack) || '' });
  }
}

// ── 쓰기 액션 청크 버퍼(CacheService) — 큰 payload(이미지 base64, 릴스 다수, 회고 본문 등)를
// 여러 GET 요청으로 나눠 보낼 때, 도착한 조각을 잠깐 모아두는 용도. doGet 응답 캐시(dashboardData_*)
// 와는 완전히 별개 키 네임스페이스라 서로 간섭하지 않음.
var WRITE_CHUNK_CACHE_PREFIX = 'writeChunk_';
var WRITE_CHUNK_TTL_SEC = 300; // 5분 안에 모든 청크가 도착해야 함(그 안에 다 안 오면 조립 실패로 처리)

function _storeWriteChunk(chunkId, chunkIndex, chunkData) {
  var cache = CacheService.getScriptCache();
  cache.put(WRITE_CHUNK_CACHE_PREFIX + chunkId + ':' + chunkIndex, chunkData, WRITE_CHUNK_TTL_SEC);
}

function _assembleWriteChunks(chunkId, chunkTotal) {
  var cache = CacheService.getScriptCache();
  var keys = [];
  for (var i = 0; i < chunkTotal; i++) keys.push(WRITE_CHUNK_CACHE_PREFIX + chunkId + ':' + i);
  var got = cache.getAll(keys);
  var parts = [];
  for (var i2 = 0; i2 < chunkTotal; i2++) {
    var part = got[WRITE_CHUNK_CACHE_PREFIX + chunkId + ':' + i2];
    if (part == null) return null; // 청크 유실/만료 — 조립 불가
    parts.push(part);
  }
  cache.removeAll(keys); // 다 쓴 청크는 정리(재사용 방지)
  return parts.join('');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 수동 테스트: 배포 전에 편집기에서 직접 실행해 flush 수정을 검증 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 편집기 상단 함수 선택 드롭다운에서 아래 두 함수를 각각 고르고 ▶ 실행 — 실제 HTTP 요청 없이
// _handleWriteAction을 가짜 e 객체로 직접 호출하므로 302/CORS와 완전히 무관하게 로직만 검증됨.
// 배포 전에 반드시 "둘 다" 실행해서 두 결과를 확인할 것:
//  1) _testWriteAction_validProduct — 시트 검증 규칙에 맞는 정상 제품명("더 플렌더 mini")으로
//     저장 시도. 기대 결과: 로그에 success:true가 정상 반환되고, 실적통합 시트에 테스트 행이
//     하나 생김(확인 후 지울 것). 실행 기록(Executions)에도 "완료됨"으로 남아야 함.
//  2) _testWriteAction_invalidProduct — 시트 드롭다운에 없는 가짜 제품명으로 저장 시도(= C428에서
//     실제로 터졌던 것과 같은 종류의 데이터 확인 규칙 위반을 일부러 재현).
//     flush 수정 전에는: 이 실행이 "실패"로 끝나고(예외가 함수 밖에서 터짐), 반환값도 못 받았음.
//     flush 수정 후 기대 결과: 예외가 이제 이 함수의 try 안에서 잡혀서, 로그에 success 없이
//     {error:'...데이터 확인 규칙...'} 형태의 정상 JSON이 반환되고, 실행 기록에는 "완료됨"으로
//     남아야 함(정상적으로 에러를 반환한 것이므로) — "실패"로 남으면 flush 위치가 아직 잘못된 것.
//     이 케이스는 시트에 행이 남지 않아야 정상(검증 실패로 애초에 안 써졌다는 뜻).
function _testWriteAction_validProduct() {
  var fakeE = {
    parameter: {
      action: 'addSalesRow',
      payload: JSON.stringify({
        product: '더 플렌더 mini',
        ch: '__검증테스트_정상(지워도됨)__' + Date.now(),
        vendor: '',
        platform: '인스타그램',
        start: '2026-07-29',
        end: '2026-07-29',
        status: '예정',
        codes: ['VERIFY-OK-' + Date.now()]
      })
    }
  };
  var result = _handleWriteAction(fakeE, '');
  var text = result.getContent();
  Logger.log('[검증-정상 제품명] _handleWriteAction 반환값: ' + text);
  return text;
}

function _testWriteAction_invalidProduct() {
  var fakeE = {
    parameter: {
      action: 'addSalesRow',
      payload: JSON.stringify({
        product: '존재하지않는상품_검증용(지워도됨)',
        ch: '__검증테스트_오류(지워도됨)__' + Date.now(),
        vendor: '',
        platform: '인스타그램',
        start: '2026-07-29',
        end: '2026-07-29',
        status: '예정',
        codes: ['VERIFY-ERR-' + Date.now()]
      })
    }
  };
  var result = _handleWriteAction(fakeE, '');
  var text = result.getContent();
  Logger.log('[검증-오류 제품명] _handleWriteAction 반환값: ' + text);
  return text;
}

// ⚠ 2026-07-30: 실적통합 시트는 서식/수식이 실제 데이터보다 훨씬 아래(예: 3000행)까지 미리 적용돼
// 있어서, sheet.getLastRow()가 값이 아니라 "서식/수식이 있는 마지막 행"까지 그대로 잡아버림(빈 값이라도
// 서식이 있으면 "데이터가 있는 행"으로 침 — Sheets API 공식 동작). 그 결과 실제 데이터는 373행에서
// 끝나는데 새 공구가 3001행에 추가되는 문제가 있었음. 그래서 getLastRow()를 아예 쓰지 않고, 기준 열
// (keyCol, 1-based — 보통 채널명 열)의 값을 직접 훑어서 "값이 실제로 있는" 마지막 행을 찾음.
function _getLastDataRow(sheet, keyCol) {
  var maxRows = sheet.getMaxRows();
  if (maxRows <= DATA_START_ROW) return DATA_START_ROW; // 시트에 데이터 행 자체가 없음
  var vals = sheet.getRange(DATA_START_ROW + 1, keyCol, maxRows - DATA_START_ROW, 1).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0] || '').trim() !== '') return DATA_START_ROW + 1 + i;
  }
  return DATA_START_ROW; // 값이 있는 행이 하나도 없음 → 헤더 마지막 행(2행)
}

// 새 공구건 등록 — 상품코드 개수만큼(1~10) 같은 dealId를 공유하는 행을 만듦.
// 시트를 직접 봐도 각 행이 완전한 정보를 담고 있도록, 공통 필드(브랜드/제품/벤더사/채널/플랫폼/
// 마케팅링크/공구가/수수료율/연도/기간/진행상태/포맷/구성/운영정보/링크)는 모든 행에 동일하게
// 기록함. 실적/조회 필드(판매수량·총매출·조회수·릴스)만 그룹당 하나여야 하므로 첫 행에만 기록.
// 여러 행을 setValues로 한 번에 써서, 중간에 실패해도 일부 행만 생기는 일이 없게 함(원자적 삽입).
function _addDeal(ss, data) {
  var sheet = _mainSheet(ss);
  if (!sheet) throw new Error('실적통합 시트를 찾을 수 없습니다.');
  _ensureExtraHeaders(sheet);

  var codes = (Array.isArray(data.codes) ? data.codes : []).map(function (c) { return String(c || '').trim(); }).filter(function (c) { return c; });
  if (!codes.length) codes = [''];
  codes = codes.slice(0, MAX_CODES);

  var dealId = Utilities.getUuid();
  var scheme = data.s || {};
  var startDate = _toDateOnly(data.start);
  var endDate   = _toDateOnly(data.end) || startDate;
  var numCols = sheet.getMaxColumns();

  // 공통 필드 — 그룹의 모든 행에 동일하게 기록
  var common = {};
  common[COL.brand]         = '미닉스';
  common[COL.product]       = data.product || '';
  common[COL.channel]       = data.ch || '';
  common[COL.vendor]        = data.vendor || '';
  common[COL.platform]      = data.platform || '';
  common[COL.marketingLink] = data.marketingLink || '';
  common[COL.salePrice]     = scheme.sale != null ? scheme.sale : '';
  common[COL.commission]    = scheme.comm != null ? scheme.comm / 100 : '';
  common[COL.year]          = startDate ? startDate.getFullYear() : '';
  common[COL.startMD]       = startDate || '';
  common[COL.endMD]         = endDate || '';
  common[COL.status]        = data.status || '예정';
  common[COL.format]        = data.format || '';
  common[COL.composition]   = data.composition || '';
  common[COL.option1]       = data.option1 || '';
  common[COL.option2]       = data.option2 || '';
  common[COL.firstCome]     = data.firstCome || '';
  common[COL.targetQty]     = data.targetQty != null ? data.targetQty : '';
  common[COL.extraQty]      = data.extraQty != null ? data.extraQty : '';
  common[COL.note]          = data.note || '';
  common[COL.link]          = data.link || '';
  common[COL.giftItem1]     = data.giftItem1 || '';
  common[COL.giftQty1]      = data.giftQty1 || '';
  common[COL.giftItem2]     = data.giftItem2 || '';
  common[COL.giftQty2]      = data.giftQty2 || '';
  common[COL.giftItem3]     = data.giftItem3 || '';
  common[COL.giftQty3]      = data.giftQty3 || '';
  common[COL.firstComeQty]  = data.firstComeQty || '';
  common[COL.note2]         = data.note2 || '';
  common[COL.tier]          = _normalizeTier(data.tier);
  // 채널 단위 속성(플랫폼 ID) — 열이 없으면(-1) 건너뛴다. 없는 열에 쓰면 A열을 덮어쓴다.
  if (COL.igId >= 0) common[COL.igId] = _normalizeChannelFieldValue('igId', data.igId);
  if (COL.ytId >= 0) common[COL.ytId] = _normalizeChannelFieldValue('ytId', data.ytId);
  // 등급 결과 열(G·H)도 등록과 동시에 기록 — 신규 건이라도 채널 등급은 프론트가 이미 알고 있어서
  // payload에 실려온다. 예전엔 등록 후 재조회 → render() → writeTiers로 왕복이 두 번 더 있었다.
  if (data.tiers) {
    common[COL.salesTier]    = _normalizeTier(data.tiers.salesTier);
    common[COL.followerTier] = _normalizeTier(data.tiers.followerTier);
  }

  var rows = [];
  for (var i = 0; i < codes.length; i++) {
    var row = [];
    for (var k in common) row[k] = common[k];
    row[COL.code]    = codes[i];
    row[COL.dealId]  = dealId;
    row[COL.codeSeq] = i + 1;
    if (i === 0) {
      // 실적/조회 필드는 대표 행(첫 행)에만 — 등록 시점에 값이 있는 경우에만 기록(보통은 비어 있음).
      // 총매출(COL.revenue)은 여기서 값을 넣지 않음 — 아래에서 그 행 기준 수식(=판매수량×공구가)을
      // 직접 심어줌(클라이언트가 data.revenue를 보내는 경우가 실제로 없어서, 이 값을 기다리면
      // 총매출 칸이 계속 빈 채로 남는 버그가 있었음 — 2026-08-21 확인).
      if (data.qty != null) row[COL.qty] = data.qty;
      if (data.views != null) row[COL.views] = data.views;
      var addFollowers = _normalizeFollowers(data.followers);
      if (addFollowers != null) row[COL.followers] = addFollowers;
    }
    for (var c = 0; c < numCols; c++) if (row[c] === undefined) row[c] = '';
    rows.push(row);
  }

  // 시트 끝 범위에 setValues로 값만 쓰면 새 행이 기존 행들의 데이터 확인(드롭다운)·서식·색상을 전혀
  // 상속받지 못함(범위에 값만 쓰는 건 서식과 완전히 무관한 별개 동작이라, 시트 UI에서 직접 "행 삽입"할
  // 때와 다름). 그래서 다음 순서로 처리함:
  //  1) _getLastDataRow로 "진짜" 마지막 데이터 행을 찾고, insertRowsAfter로 그 바로 아래에 새 행을 삽입
  //     (getLastRow()를 썼으면 서식이 미리 적용된 3000행 뒤에 붙어버렸을 것 — 위 _getLastDataRow 주석 참고)
  //  2) 그 직전 데이터 행 → 새 행 범위로 서식/데이터 확인만 명시적으로 copyTo(PASTE_FORMAT +
  //     PASTE_DATA_VALIDATION) — 값은 절대 복사하지 않음(직전 행에 실적 값이 남아있어도 새 행엔
  //     옮겨가면 안 되므로 PASTE_VALUES/PASTE_NORMAL은 쓰지 않고 이 둘만 씀). 1행짜리 원본을
  //     여러 행짜리 대상 범위에 copyTo하면 그대로 반복(타일링) 적용됨.
  //  3) 그 다음에야 실제 값을 setValues로 기록 — flush는 호출부(_handleWriteAction)에서 처리.
  var lastDataRow = _getLastDataRow(sheet, COL.channel + 1);
  sheet.insertRowsAfter(lastDataRow, rows.length);
  var startRow = lastDataRow + 1;
  var newRange = sheet.getRange(startRow, 1, rows.length, numCols);
  if (lastDataRow > DATA_START_ROW) { // 실제 데이터 행이 하나라도 있을 때만 그 행을 서식 원본으로 씀
    var templateRow = sheet.getRange(lastDataRow, 1, 1, numCols);
    templateRow.copyTo(newRange, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    templateRow.copyTo(newRange, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  }
  // 오픈시간(추가옵션2, "10:00" 같은 문자열)을 구글 시트가 시간(time) 값으로 자동 인식해버리는
  // 문제 방지(2026-08-21) — 위 서식 복사 단계에서 직전 행이 이미 시간 형식이었다면 그 서식까지
  // 같이 대물림돼 계속 재발했음. 값을 쓰기 "전"에 이 열만 일반 텍스트로 고정해서 재발을 끊음
  // (REVIEW_COL.ym에도 같은 문제로 이미 쓰던 setNumberFormat('@') 패턴을 그대로 재사용).
  sheet.getRange(startRow, COL.option2 + 1, rows.length, 1).setNumberFormat('@');
  // 시작일/종료일도 같은 이유로 값을 쓰기 전에 시간 없는 날짜 서식으로 고정(2026-08-24) — 직전 행
  // 서식을 그대로 물려받으면 과거에 섞여 있던 날짜+시간 서식까지 같이 대물림될 수 있음.
  sheet.getRange(startRow, COL.startMD + 1, rows.length, 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(startRow, COL.endMD + 1, rows.length, 1).setNumberFormat('yyyy-mm-dd');
  newRange.setValues(rows);

  // 총매출은 대표 행(첫 행, startRow)에만 "=판매수량×공구가" 수식으로 기록 — 판매수량이 아직
  // 비어 있어도(등록 시점엔 보통 비어있음) 수식은 정상 저장되고, 그 값을 빈 셀이 아니라 0으로
  // 계산해서 보여줌(I{row}*빈칸 = 0). 나중에 실적 기입으로 판매수량만 채워지면 화면(K열)이
  // 자동으로 재계산됨 — 별도 저장 로직 없이 시트 수식이 그 역할을 대신함.
  sheet.getRange(startRow, COL.revenue + 1).setFormula(_revenueFormula(startRow));

  // 인플루언서 링크가 입력됐으면 채널명 셀에도 하이퍼링크를 걸어줌(코드별로 생성된 모든 행에 동일
  // 반영). setValues로는 서식(하이퍼링크)이 안 실리므로 별도 setRichTextValues 호출이 필요함.
  // 반드시 위의 서식 복사(copyTo)보다 나중에 실행 — 안 그러면 복사해온 서식이 이 하이퍼링크를
  // 덮어써 버릴 수 있음.
  if (data.link && data.ch) {
    var channelRT = [];
    for (var ri = 0; ri < codes.length; ri++) channelRT.push([_buildChannelRichText(data.ch, data.link)]);
    sheet.getRange(startRow, COL.channel + 1, codes.length, 1).setRichTextValues(channelRT);
  }

  _invalidateDealRowMap(); // 행이 늘었으므로 dealId→행 맵을 버림

  // 프론트가 낙관적으로 그려둔 임시 건을 실제 값으로 바꿔 끼울 수 있게 행 정보를 돌려줌
  var addTierRows = [];
  var addS = data.tiers ? _normalizeTier(data.tiers.salesTier) : '';
  var addF = data.tiers ? _normalizeTier(data.tiers.followerTier) : '';
  for (var tr2 = 0; tr2 < codes.length; tr2++) addTierRows.push([startRow + tr2, addS, addF]);

  return _json({
    success: true, mainRow: startRow, dealId: dealId,
    rowIndex: startRow, rowCount: codes.length, tierRows: addTierRows
  });
}

// 공구건 상세 모달 저장 — dealId 그룹 전체에 반영.
// data.changes: 공통 필드(GROUP_MIRROR_KEYS)는 그룹의 모든 행에 동일 반영, 나머지(PRIMARY_ONLY_KEYS +
// sale/comm/start/end/status)는 대표 행에만 반영.
// data.codes: 최신 상품코드 배열(1~5개) — 그룹 행 수와 비교해 부족하면 append, 남으면 delete.
function _updateDeal(ss, data) {
  var sheet = _mainSheet(ss);
  if (!sheet) return _json({ error: '실적통합 시트를 찾을 수 없습니다.' });

  var groupRows = _findGroupRows(sheet, data.dealId);
  if (!groupRows.length) return _json({ error: '해당 공구 행을 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.' });

  var primaryRow = groupRows[0].row;
  var brandCell = String(sheet.getRange(primaryRow, COL.brand + 1).getValue() || '').trim();
  if (!MINIX_ALIASES[brandCell]) {
    return _json({ error: '해당 행이 더 이상 유효한 공구 행이 아닙니다. 새로고침 후 다시 시도해주세요.' });
  }

  var c = data.changes || {};
  // 등급은 허용값 4종(TIER_OPTIONS) 밖이면 시트에 남기지 않음 — 저장 경로에서도 읽기와 같은 기준을 적용
  if (c.tier !== undefined) c.tier = _normalizeTier(c.tier);
  // 팔로워 수도 읽기와 같은 기준으로 정규화 — 콤마 섞인 문자열이 와도 숫자로, 빈값은 ''(셀 비움)
  if (c.followers !== undefined) {
    var nf = _normalizeFollowers(c.followers);
    c.followers = nf == null ? '' : nf;
  }

  /* ⚠ 2026-09-15: 예전엔 바뀐 필드마다 setValue를 한 번씩 불렀다(필드 10개면 RPC 10회).
     이제는 "어느 행 어느 열에 무엇을 쓸지"를 pending에 모아두고, 마지막에 붙어 있는 열끼리만
     묶어서 setValues로 한 번에 내보낸다. 사은품 6칸+선착순수량+비고처럼 원래 연속인 구간은
     호출 하나로 합쳐지고, 등급 결과 열(G·H)도 같은 묶음에 얹혀 별도 왕복이 사라진다. */
  var pending = {};
  function stage(row, col, value) {
    if (!pending[row]) pending[row] = {};
    pending[row][col] = value;
  }

  // 공통 필드 — 그룹의 모든 행에 동일 반영
  for (var ki = 0; ki < GROUP_MIRROR_KEYS.length; ki++) {
    var k = GROUP_MIRROR_KEYS[ki];
    if (COL[k] == null || COL[k] < 0) continue; // 시트에 없는 선택 열 — 쓰면 A열을 덮어쓴다
    if (c[k] !== undefined) {
      for (var g = 0; g < groupRows.length; g++) stage(groupRows[g].row, COL[k], c[k] || '');
    }
  }

  // 대표 행 전용 필드
  for (var k2i = 0; k2i < PRIMARY_ONLY_KEYS.length; k2i++) {
    var k2 = PRIMARY_ONLY_KEYS[k2i];
    if (COL[k2] == null || COL[k2] < 0) continue; // 시트에 없는 선택 열 — 쓰면 A열을 덮어쓴다
    if (c[k2] !== undefined) {
      // option2(오픈시간, "10:00")를 구글 시트가 시간 값으로 자동 인식하는 문제 방지 — 값을 쓰기
      // 전에 이 열만 일반 텍스트로 고정(REVIEW_COL.ym에 이미 쓰던 setNumberFormat('@') 패턴 재사용)
      if (k2 === 'option2') sheet.getRange(primaryRow, COL.option2 + 1).setNumberFormat('@');
      stage(primaryRow, COL[k2], c[k2] != null ? c[k2] : '');
    }
  }

  if (c.sale !== undefined) stage(primaryRow, COL.salePrice, c.sale != null ? c.sale : '');
  if (c.comm !== undefined) stage(primaryRow, COL.commission, c.comm != null ? c.comm / 100 : '');
  if (c.qty  !== undefined) stage(primaryRow, COL.qty, c.qty != null ? c.qty : '');

  var newStart = c.start !== undefined ? _toDateOnly(c.start) : undefined;
  var newEnd   = c.end   !== undefined ? _toDateOnly(c.end)   : undefined;
  if (newStart !== undefined) {
    sheet.getRange(primaryRow, COL.startMD + 1).setNumberFormat('yyyy-mm-dd');
    stage(primaryRow, COL.startMD, newStart || '');
    if (newStart) stage(primaryRow, COL.year, newStart.getFullYear());
  }
  if (newEnd !== undefined) {
    sheet.getRange(primaryRow, COL.endMD + 1).setNumberFormat('yyyy-mm-dd');
    stage(primaryRow, COL.endMD, newEnd || '');
  }

  // 등급 결과 열(G·H)을 같은 묶음에 태움 — 예전엔 저장이 끝난 뒤 프론트가 writeTiers를 따로
  // 호출해서 HTTP 왕복이 하나 더 있었다. 채널 등급은 프론트가 산정하므로 저장 payload에 실려온다.
  if (data.tiers) {
    var tierTargets = [];
    for (var tg = 0; tg < groupRows.length; tg++) tierTargets.push(groupRows[tg].row);
    /* 채널 필드를 전파한 행들도 같은 채널이므로 등급이 동일하다 — G·H를 함께 맞춰두지 않으면
       다음 렌더에서 프론트가 그 차이를 발견해 writeTiers를 한 번 더 쏜다(없앤 왕복이 되살아남).
       ⚠ 전파는 이 시점보다 뒤에서 실행되므로, 대상 행 목록은 아래에서 다시 한 번 반영한다. */
    _stageTiers(pending, tierTargets, data.tiers);
  }

  var writeCalls = _writeCellsBatched(sheet, pending);

  /* 릴스도 같은 실행에서 처리 (2026-09-15) — 예전엔 프론트가 updateDeal 다음에 saveReels를
     따로 호출해서 HTTP 왕복이 하나 더 있었다. Apps Script는 왕복당 고정비가 1.7~2초라
     (302 리다이렉트 구조) 이 한 번이 저장 시간의 절반을 차지했다.
     프론트는 릴스가 **실제로 바뀐 경우에만** data.reels를 실어 보낸다 — 안 바뀌었는데 매번 쓰면
     슬롯 10칸을 헛되이 다시 쓰게 되고(쓰기 RPC 20여 회), 그게 합친 이득을 도로 까먹는다. */
  var reelsSaved = null;
  if (data.reels != null) reelsSaved = _applyReels(sheet, primaryRow, data.reels);

  /* 채널 단위 필드(플랫폼 ID·팔로워 수) 전파 — 같은 실행 안에서 끝낸다.
     별도 액션으로 빼면 HTTP 왕복이 하나 늘고, Apps Script는 왕복당 고정비가 1.7~2초라
     그게 곧 저장 시간이 된다. 프론트가 모드(fillEmpty/overwrite)까지 정해서 보낸다. */
  var channelProp = null;
  if (data.channelFields && data.channelFields.fields) {
    var propChannel = String(data.channelFields.channel || c.channel || '').trim();
    if (!propChannel) propChannel = String(sheet.getRange(primaryRow, COL.channel + 1).getValue() || '').trim();
    channelProp = _propagateChannelFields(sheet, propChannel, data.channelFields.fields,
      data.channelFields.mode === 'fillEmpty' ? 'fillEmpty' : 'overwrite');
  }

  /* 전파로 건드린 "다른 공구건의 행"에도 G·H 등급을 맞춰둔다.
     위의 배치 쓰기는 이미 끝난 뒤라 별도 묶음으로 처리한다. 이걸 빼먹으면 같은 채널인데 행마다
     등급 칸이 달라지고, 다음 렌더에서 프론트가 그 차이를 발견해 writeTiers를 한 번 더 쏜다. */
  if (data.tiers && channelProp && channelProp.rows.length) {
    var known = {};
    for (var gk = 0; gk < groupRows.length; gk++) known[groupRows[gk].row] = true;
    var extraRows = [];
    for (var pr = 0; pr < channelProp.rows.length; pr++) {
      if (!known[channelProp.rows[pr]]) extraRows.push(channelProp.rows[pr]);
    }
    if (extraRows.length) {
      var extraPending = {};
      _stageTiers(extraPending, extraRows, data.tiers);
      writeCalls += _writeCellsBatched(sheet, extraPending);
    }
  }

  // 채널명 셀의 하이퍼링크도 함께 갱신 — 위 링크 열(COL.link)과 어긋나지 않게, 그룹의 모든 행에
  // 반영함(채널명 텍스트는 위 값 쓰기가 이미 끝난 뒤라 최신 텍스트를 그대로 씀).
  // 링크를 빈 값으로 저장하면 하이퍼링크만 제거되고 텍스트는 유지됨.
  if (c.link !== undefined) {
    for (var lg = 0; lg < groupRows.length; lg++) {
      _setChannelLink(sheet, groupRows[lg].row, c.link || '');
    }
  }

  // 2026-08-21: 예전엔 수식이 없을 때만 "판매수량×공구가"를 고정 숫자로 한 번 계산해 넣었는데,
  // 그 뒤로는 수식이 아니라 그 시점 스냅샷값이라 다음에 sale/qty가 또 바뀌어도 재계산이 안 됐음
  // (게다가 신규 등록 건은 아예 수식 자체가 없어서 총매출이 계속 빈 채로 남는 원인이기도 했음).
  // 이제는 항상 수식(=판매수량×공구가, 그 행 상대참조)을 다시 심어줌 — 이미 같은 수식이면 같은
  // 문자열을 다시 쓰는 것뿐이라 안전하고, 예전에 빈 칸/고정숫자였던 건은 이 순간 수식으로 교체됨.
  if (c.sale !== undefined || c.qty !== undefined) {
    sheet.getRange(primaryRow, COL.revenue + 1).setFormula(_revenueFormula(primaryRow));
  }

  // 상품코드 배열 반영 — 행 수를 codes.length에 맞춤
  var rowSetChanged = false; // 행이 늘거나 줄면 캐시 부분 갱신으로는 못 맞춤 → 전체 무효화로 떨어짐
  if (Array.isArray(data.codes)) {
    var codes = data.codes.map(function (x) { return String(x || '').trim(); }).filter(function (x) { return x; }).slice(0, MAX_CODES);
    if (!codes.length) codes = [''];

    // 기존 행에 codes를 순서대로 덮어씀(공유 개수만큼)
    var shared = Math.min(groupRows.length, codes.length);
    for (var s = 0; s < shared; s++) {
      sheet.getRange(groupRows[s].row, COL.code + 1).setValue(codes[s]);
    }

    if (codes.length !== groupRows.length) {
      rowSetChanged = true;
      _invalidateDealRowMap(); // 행 번호가 바뀌므로 dealId→행 맵을 버림
    }

    if (codes.length > groupRows.length) {
      // 부족한 만큼 그룹 끝에 새 행 추가(공통 필드는 대표 행 현재 값을 복사, 실적/조건 값은 비움)
      var mirrorVals = {};
      for (var mki = 0; mki < GROUP_MIRROR_KEYS.length; mki++) mirrorVals[GROUP_MIRROR_KEYS[mki]] = sheet.getRange(primaryRow, COL[GROUP_MIRROR_KEYS[mki]] + 1).getValue();
      // 새로 추가되는 행도 채널명 하이퍼링크가 맞도록, 지금 이 요청에서 바뀐 링크(c.link)가
      // 있으면 그걸 쓰고 없으면 현재 저장된 링크(링크 열 → 없으면 채널명 셀 하이퍼링크)를 따라감
      var linkForNewRows = c.link !== undefined ? c.link : String(sheet.getRange(primaryRow, COL.link + 1).getValue() || '').trim();
      if (!linkForNewRows) {
        var primaryRT = sheet.getRange(primaryRow, COL.channel + 1).getRichTextValue();
        linkForNewRows = primaryRT ? (primaryRT.getLinkUrl() || '') : '';
      }
      for (var add = groupRows.length; add < codes.length; add++) {
        var newRow = [];
        for (var mk2 = 0; mk2 < GROUP_MIRROR_KEYS.length; mk2++) newRow[COL[GROUP_MIRROR_KEYS[mk2]]] = mirrorVals[GROUP_MIRROR_KEYS[mk2]];
        newRow[COL.code] = codes[add];
        newRow[COL.dealId] = data.dealId;
        newRow[COL.codeSeq] = add + 1;
        for (var ci = 0; ci < newRow.length; ci++) if (newRow[ci] === undefined) newRow[ci] = '';
        // sheet.appendRow(newRow)는 내부적으로 getLastRow()+1에 씀 — 실적통합 시트에 서식/수식이
        // 실제 데이터보다 훨씬 아래까지 미리 적용돼 있으면 _addDeal과 똑같이 그 서식 끝(예: 3000행)
        // 다음에 붙어버림. _getLastDataRow 기준으로 직접 위치를 계산해 그 바로 다음 행에 삽입하고,
        // 서식/데이터 확인도 _addDeal과 동일하게 복사함(추가 코드 행도 드롭다운·색상이 빠지면 안 되므로).
        var addLastDataRow = _getLastDataRow(sheet, COL.channel + 1);
        sheet.insertRowsAfter(addLastDataRow, 1);
        var addRowNum = addLastDataRow + 1;
        var addRange = sheet.getRange(addRowNum, 1, 1, newRow.length);
        if (addLastDataRow > DATA_START_ROW) {
          var addTemplateRow = sheet.getRange(addLastDataRow, 1, 1, newRow.length);
          addTemplateRow.copyTo(addRange, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
          addTemplateRow.copyTo(addRange, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
        }
        addRange.setValues([newRow]);
        if (linkForNewRows) _setChannelLink(sheet, addRowNum, linkForNewRows);
      }
    } else if (codes.length < groupRows.length) {
      // 초과 행 삭제 — 물리 행 번호 내림차순으로 지워야 인덱스가 안 밀림
      var toDelete = groupRows.slice(codes.length).map(function (x) { return x.row; }).sort(function (a, b) { return b - a; });
      for (var d = 0; d < toDelete.length; d++) sheet.deleteRow(toDelete[d]);
    }
  }

  // 저장 결과를 프론트가 그대로 병합할 수 있게 돌려줌 — 예전엔 저장 직후 fetchLive()로 전체를
  // 다시 받아왔는데(시트 4만 셀 재파싱 + HTTP 왕복 1회), 실제로 바뀐 건 이 건 하나뿐이다.
  var finalRows = rowSetChanged ? _findGroupRows(sheet, data.dealId) : groupRows;
  // 등급을 같이 보내지 않은 요청이면 시트의 G·H를 건드리지 않았으므로 tierRows를 만들지 않는다.
  // 예전엔 이 경우에도 빈 문자열로 채워 돌려줬는데, 그러면 프론트가 "시트 G·H가 비었다"고 오해해서
  // 다음 렌더에서 writeTiers를 한 번 더 쏜다(방금 없앤 왕복이 되살아남). null이면 프론트도
  // 캐시 갱신도 그냥 건너뛴다.
  var tierRows = null;
  if (data.tiers) {
    var sT = _normalizeTier(data.tiers.salesTier);
    var fT = _normalizeTier(data.tiers.followerTier);
    tierRows = [];
    for (var fr = 0; fr < finalRows.length; fr++) tierRows.push([finalRows[fr].row, sT, fT]);
  }

  return _json({
    success: true,
    dealId: data.dealId,
    rowIndex: finalRows.length ? finalRows[0].row : primaryRow,
    rowCount: finalRows.length,
    tierRows: tierRows,
    writeCalls: writeCalls,
    reelsSaved: reelsSaved,
    // 프론트가 로컬 모델을 맞추고 사용자에게 "몇 건에 반영됐는지" 알릴 수 있게
    channelFields: channelProp ? {
      channel: channelProp.channel, mode: channelProp.mode,
      written: channelProp.written, rowIndexes: channelProp.rows,
      byField: channelProp.byField, skippedFields: channelProp.skipped
    } : null,
    // 전파된 다른 공구건들도 캐시에서 같이 갱신 — 안 하면 다음 조회에서 옛 값이 잠깐 보인다
    cachePatches: (channelProp && channelProp.dealIds && channelProp.dealIds.length)
      ? _buildChannelFieldPatches(channelProp, data.dealId) : null,
    // 행 구성이 그대로일 때만 캐시 부분 갱신 시도(아니면 _handleWriteAction이 전체 무효화로 감)
    // 릴스를 건드렸으면 조회수 합계·썸네일이 바뀌므로 필드 덮어쓰기로는 못 맞춤 → 전체 무효화로
    cachePatch: (rowSetChanged || data.reels != null) ? null : _buildCachePatch(data.dealId, c, tierRows)
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 1회성 보정: 총매출(K열)이 수식이 아닌 기존 행에 수식을 채워 넣음 (2026-08-21) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 신규 등록 시 총매출에 수식을 안 심던 버그(_addDeal 참고) 때문에, 그 버그가 있던 동안 등록된
// 건들은 총매출이 빈 칸이거나(한 번도 수정 안 함) 그 시점 스냅샷 고정 숫자로(한 번이라도 판매수량을
// 수정한 적 있음) 남아있음. Apps Script 편집기에서 이 함수만 선택해 "▶ 실행"으로 수동 실행할 것.
//  1) _backupMainSheetForRevenueFix가 실적통합 시트 전체를 복제해 숨긴 백업 시트로 보존(최초 1회만).
//  2) 대표 행(코드순번 1 또는 codeSeq 자체가 없는 단독 행) 중 제품명이 있고 총매출이 "이미 수식"이
//     아닌 행만 골라 그 행 기준 수식(=판매수량×공구가)으로 교체함. 이미 수식인 행은 그대로 둠
//     (값 유실 없음 — 고정 숫자였던 행도 같은 셀의 판매수량×공구가를 그대로 재계산하는 것이므로
//     현재 보이는 값이 바뀌지 않음. 코드순번 2 이상인 보조 행/제품명 없는 빈 행은 건드리지 않음).
function fixMissingRevenueFormulas() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _mainSheet(ss);
  if (!sheet) { Logger.log('[매출수식보정] 실적통합 시트를 찾을 수 없어 중단'); return; }

  _backupMainSheetForRevenueFix(ss, sheet);

  var lastDataRow = _getLastDataRow(sheet, COL.channel + 1);
  if (lastDataRow <= DATA_START_ROW) { Logger.log('[매출수식보정] 데이터 행이 없어 중단'); return; }

  var numRows = lastDataRow - DATA_START_ROW;
  var productVals = sheet.getRange(DATA_START_ROW + 1, COL.product + 1, numRows, 1).getValues();
  var codeSeqVals = sheet.getRange(DATA_START_ROW + 1, COL.codeSeq + 1, numRows, 1).getValues();
  var revRange = sheet.getRange(DATA_START_ROW + 1, COL.revenue + 1, numRows, 1);
  var revFormulas = revRange.getFormulas();

  var fixed = 0, alreadyOk = 0, skippedNotPrimary = 0, skippedNoProduct = 0;
  for (var i = 0; i < numRows; i++) {
    if (!String(productVals[i][0] || '').trim()) { skippedNoProduct++; continue; }
    var seq = _numOrNull(codeSeqVals[i][0]);
    var isPrimary = (seq == null || seq === 1);
    if (!isPrimary) { skippedNotPrimary++; continue; }
    if (revFormulas[i][0]) { alreadyOk++; continue; } // 이미 수식이면 손대지 않음
    var row = DATA_START_ROW + 1 + i;
    sheet.getRange(row, COL.revenue + 1).setFormula(_revenueFormula(row));
    fixed++;
  }
  SpreadsheetApp.flush();
  _invalidateDashboardCache();
  Logger.log('[매출수식보정 완료] 수식으로 새로 채움=' + fixed + ' / 이미 수식이었음=' + alreadyOk +
    ' / 대표행 아님(안 건드림)=' + skippedNotPrimary + ' / 제품명 없는 빈 행(안 건드림)=' + skippedNoProduct);
  return { fixed: fixed, alreadyOk: alreadyOk, skippedNotPrimary: skippedNotPrimary, skippedNoProduct: skippedNoProduct };
}

var REVENUE_FIX_BACKUP_NAME = '실적통합_백업_매출수식보정전';
function _backupMainSheetForRevenueFix(ss, sheet) {
  var existing = ss.getSheetByName(REVENUE_FIX_BACKUP_NAME);
  if (existing) { Logger.log('[매출수식보정 백업] 이미 존재함 — 다시 만들지 않음: ' + REVENUE_FIX_BACKUP_NAME); return existing; }
  var copy = sheet.copyTo(ss);
  copy.setName(REVENUE_FIX_BACKUP_NAME);
  try { copy.hideSheet(); } catch (e) { Logger.log('백업 시트 숨기기 실패 (무시): ' + e); }
  Logger.log('[매출수식보정 백업] 완료 — 시트명: ' + REVENUE_FIX_BACKUP_NAME);
  return copy;
}

// 채널 단위 '등급(수동)' 일괄 초기화 — 수동 지정은 행별로 저장되지만 의미는 채널 속성이라,
// 되돌릴 때도 그 채널의 모든 행을 한 번에 비워야 함. 한 행만 지우면 남아 있는 다른 행의 값이
// 다시 그 채널의 수동 등급으로 승격돼(프론트는 "가장 최근 값"을 채널 등급으로 씀) 사용자
// 입장에선 "되돌리기가 안 먹은" 것처럼 보임.
// 열 하나를 통째로 읽어 메모리에서 지운 뒤 한 번의 setValues로 되쓴다(행마다 setValue를 부르면
// 행 수만큼 시트 왕복이 생겨 느림).
function _clearChannelTier(ss, data) {
  var sheet = _mainSheet(ss);
  if (!sheet) return _json({ error: '실적통합 시트를 찾을 수 없습니다.' });
  var channel = String((data && data.channel) || '').trim();
  if (!channel) return _json({ error: '채널명이 비어 있습니다.' });
  _ensureExtraHeaders(sheet);

  var lastRow = _getLastDataRow(sheet, COL.channel + 1);
  if (lastRow <= DATA_START_ROW) return _json({ success: true, cleared: 0, channel: channel });

  var n = lastRow - DATA_START_ROW;
  var chVals = sheet.getRange(DATA_START_ROW + 1, COL.channel + 1, n, 1).getValues();
  var brandVals = sheet.getRange(DATA_START_ROW + 1, COL.brand + 1, n, 1).getValues();
  var tierRange = sheet.getRange(DATA_START_ROW + 1, COL.tier + 1, n, 1);
  var tierVals = tierRange.getValues();
  var cleared = 0;
  for (var i = 0; i < n; i++) {
    if (String(chVals[i][0] || '').trim() !== channel) continue;
    if (!MINIX_ALIASES[String(brandVals[i][0] || '').trim()]) continue; // Minix 외 행은 건드리지 않음
    if (String(tierVals[i][0] || '').trim() === '') continue;
    tierVals[i][0] = '';
    cleared++;
  }
  if (cleared) tierRange.setValues(tierVals);
  Logger.log('[등급 수동 초기화] 채널=' + channel + ' / 비운 행 수=' + cleared);
  return _json({ success: true, cleared: cleared, channel: channel });
}

/* 채널 단위 '팔로워 수' 갱신 (2026-09-11) — 채널별 성과 표의 인라인 편집에서 호출.
   팔로워 수 자체는 건별 스냅샷이지만, 표에서 고치는 값의 의미는 "이 채널의 현재 팔로워 수"라
   그 채널의 **가장 최근 공구건 대표 행**에만 쓴다(과거 건의 당시 값을 소급해 덮어쓰면 시점별
   스냅샷이라는 성격이 깨짐). 프론트의 followerCount도 같은 규칙("가장 최근 값")으로 읽는다.
   _clearChannelTier와 같이 열을 통째로 읽어 메모리에서 판단한 뒤 셀 하나만 쓴다. */
function _updateChannelFollowers(ss, data) {
  var sheet = _mainSheet(ss);
  if (!sheet) return _json({ error: '실적통합 시트를 찾을 수 없습니다.' });
  var channel = String((data && data.channel) || '').trim();
  if (!channel) return _json({ error: '채널명이 비어 있습니다.' });
  var followers = _normalizeFollowers(data && data.followers); // null이면 값 지우기
  _ensureExtraHeaders(sheet);

  var lastRow = _getLastDataRow(sheet, COL.channel + 1);
  if (lastRow <= DATA_START_ROW) return _json({ error: '해당 채널의 공구건을 찾을 수 없습니다.' });

  var n = lastRow - DATA_START_ROW;
  var first = DATA_START_ROW + 1;
  var chVals    = sheet.getRange(first, COL.channel + 1, n, 1).getValues();
  var brandVals = sheet.getRange(first, COL.brand + 1, n, 1).getValues();
  var seqVals   = sheet.getRange(first, COL.codeSeq + 1, n, 1).getValues();
  var yearVals  = sheet.getRange(first, COL.year + 1, n, 1).getValues();
  var startVals = sheet.getRange(first, COL.startMD + 1, n, 1).getValues();

  var bestRow = 0, bestKey = '';
  for (var i = 0; i < n; i++) {
    if (String(chVals[i][0] || '').trim() !== channel) continue;
    if (!MINIX_ALIASES[String(brandVals[i][0] || '').trim()]) continue; // Minix 외 행은 건드리지 않음
    var seq = _numOrNull(seqVals[i][0]);
    if (seq != null && seq !== 1) continue; // 같은 공구건의 보조 행(코드순번 2~)은 건너뜀
    // 날짜를 못 읽는 행도 후보에서 빼지 않음 — 빈 키('')는 어떤 날짜보다 작아 자연히 뒤로 밀림
    var ymd = _parseDate(startVals[i][0], _numOrNull(yearVals[i][0])) || '';
    if (bestRow === 0 || ymd >= bestKey) { bestRow = first + i; bestKey = ymd; }
  }
  if (!bestRow) return _json({ error: '해당 채널의 공구건을 찾을 수 없습니다.' });

  sheet.getRange(bestRow, COL.followers + 1).setValue(followers == null ? '' : followers);
  Logger.log('[팔로워 수 갱신] 채널=' + channel + ' / 행=' + bestRow + ' / 값=' + followers);
  return _json({ success: true, channel: channel, row: bestRow, followers: followers, start: bestKey });
}

/* 등급 결과 열 배치 기록 (2026-09-14) — 프론트가 등급 재계산을 끝낸 뒤 호출.
   data.rows: [{rowIndex, salesTier, followerTier}, ...] — rowIndex는 1-based 시트 행 번호.
   등급 산정은 전적으로 프론트 몫이고(임계값이 바뀔 때마다 GAS를 재배포할 수는 없으므로), GAS는
   "받은 값을 그 행에 그대로 적는" 역할만 한다. 다만 시트를 망가뜨리지 않도록 세 가지는 여기서 지킴:
     1) 허용값 4종(TIER_OPTIONS) 밖의 값은 _normalizeTier가 전부 빈칸으로 — 시트에 이상한 값이 남지 않음
     2) 데이터 범위 밖 행 번호와 Minix 외 행은 건너뜀 — 프론트가 잘못된 행을 보내도 남의 행을 안 건드림
     3) 실제로 값이 달라지는 행이 하나도 없으면 아무것도 쓰지 않고 끝냄(written:0)
   쓰기는 바뀐 행들을 전부 덮는 최소 블록(minRow~maxRow) 하나를 setValues 한 번으로 처리한다 —
   행마다 setValue를 부르면 호출 수가 행 수만큼 늘어 6분 실행 한도에 금방 닿기 때문. 블록 안의
   안 바뀐 행은 자기 값을 그대로 다시 쓰는 것이라 결과가 같다. */
function _writeTiers(ss, data) {
  var sheet = _mainSheet(ss);
  if (!sheet) return _json({ error: '실적통합 시트를 찾을 수 없습니다.' });

  var rows = (data && Object.prototype.toString.call(data.rows) === '[object Array]') ? data.rows : [];
  if (!rows.length) return _json({ success: true, written: 0 });

  var lastRow = _getLastDataRow(sheet, COL.channel + 1);
  if (lastRow <= DATA_START_ROW) return _json({ success: true, written: 0 });

  var want = {}; // 1-based 행 번호 -> [매출등급, 팔로워등급]
  var minRow = 0, maxRow = 0, skipped = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i] || {};
    var rowIndex = _numOrNull(r.rowIndex);
    if (rowIndex == null || rowIndex <= DATA_START_ROW || rowIndex > lastRow) { skipped++; continue; }
    want[rowIndex] = [_normalizeTier(r.salesTier), _normalizeTier(r.followerTier)];
    if (!minRow || rowIndex < minRow) minRow = rowIndex;
    if (rowIndex > maxRow) maxRow = rowIndex;
  }
  if (!minRow) return _json({ success: true, written: 0, skipped: skipped });

  var n = maxRow - minRow + 1;
  var brandVals = sheet.getRange(minRow, COL.brand + 1, n, 1).getValues();
  var salesVals = sheet.getRange(minRow, COL.salesTier + 1, n, 1).getValues();
  var folVals   = sheet.getRange(minRow, COL.followerTier + 1, n, 1).getValues();

  var changed = 0;
  for (var key in want) {
    var idx = Number(key) - minRow;
    if (!MINIX_ALIASES[String(brandVals[idx][0] || '').trim()]) { skipped++; continue; } // Minix 외 행은 건드리지 않음
    var s = want[key][0], f = want[key][1];
    if (String(salesVals[idx][0] || '').trim() === s && String(folVals[idx][0] || '').trim() === f) continue;
    salesVals[idx][0] = s;
    folVals[idx][0] = f;
    changed++;
  }
  if (!changed) return _json({ success: true, written: 0, skipped: skipped });

  if (COL.followerTier === COL.salesTier + 1) {
    // 정상 레이아웃 — 두 열이 붙어 있으므로 2칸짜리 범위 하나로 한 번에 씀
    var pair = [];
    for (var p = 0; p < n; p++) pair.push([salesVals[p][0], folVals[p][0]]);
    sheet.getRange(minRow, COL.salesTier + 1, n, 2).setValues(pair);
  } else {
    // 누군가 두 열 사이에 다른 열을 끼워 넣어 인접이 깨진 경우 — 한 범위로 묶으면 사이 열의 수식까지
    // 값으로 덮어써 버리므로 열별로 따로 씀(호출이 하나 늘 뿐 결과는 동일)
    Logger.log('[등급 기록] 매출등급/팔로워등급 열이 인접하지 않아 열별로 나눠 기록함');
    sheet.getRange(minRow, COL.salesTier + 1, n, 1).setValues(salesVals);
    sheet.getRange(minRow, COL.followerTier + 1, n, 1).setValues(folVals);
  }

  Logger.log('[등급 기록] 요청 ' + rows.length + '행 / 갱신 ' + changed + '행 / 건너뜀 ' + skipped +
    '행 / 블록=' + minRow + '~' + maxRow);
  return _json({ success: true, written: changed, skipped: skipped });
}

/* ━━━ 채널 단위 필드 전파 (2026-09-15) ━━━
   플랫폼 ID·팔로워 수는 공구건이 아니라 채널에 속한 값인데, 시트는 공구건(행) 단위라 같은 채널이
   여러 행에 흩어져 있다. 그래서 한 건에서 고친 값이 나머지 행에 반영되지 않으면 같은 채널인데
   행마다 값이 다른 상태가 쌓인다. 이 함수가 그 전파를 담당한다.

   채널 판정은 **앞뒤 공백만 제거한 완전 일치**다. 대소문자·띄어쓰기 변형을 묶지 않는 건 의도된
   보수적 선택 — '민이'와 '민 이'를 같은 채널로 합쳤다가 실제로 다른 채널이면 남의 데이터를
   덮어쓰게 되고, 그건 되돌리기 어렵다.

   mode
     'fillEmpty' — 비어 있는 칸만 채움(기본). 이미 값이 있는 행은 건드리지 않는다.
     'overwrite' — 대상 행 전부를 덮어씀.
   어느 쪽이든 Minix 행만 대상으로 하고, 값이 실제로 달라지는 행이 없으면 아무것도 쓰지 않는다.

   읽기는 필요한 열만 한 번씩, 쓰기는 **필드(열)마다 한 번의 setValues**로 끝낸다. */
function _propagateChannelFields(sheet, channelName, fields, mode) {
  var result = { channel: channelName, mode: mode, written: 0, rows: [], byField: {}, skipped: [] };
  var ch = String(channelName || '').trim();
  if (!ch || !fields) return result;

  var keys = [];
  for (var k in fields) {
    if (CHANNEL_FIELD_KEYS.indexOf(k) === -1) continue;
    if (COL[k] == null || COL[k] < 0) { result.skipped.push(k); continue; } // 시트에 열이 아직 없음
    keys.push(k);
  }
  if (!keys.length) return result;

  var lastRow = _getLastDataRow(sheet, COL.channel + 1);
  if (lastRow <= DATA_START_ROW) return result;
  var n = lastRow - DATA_START_ROW, first = DATA_START_ROW + 1;

  var chVals = sheet.getRange(first, COL.channel + 1, n, 1).getValues();
  var brandVals = sheet.getRange(first, COL.brand + 1, n, 1).getValues();
  var dealIdVals = sheet.getRange(first, COL.dealId + 1, n, 1).getValues();

  // 이 채널에 속한 행 인덱스(0-based, first 기준)
  var targets = [];
  for (var i = 0; i < n; i++) {
    if (String(chVals[i][0] || '').trim() !== ch) continue;
    if (!MINIX_ALIASES[String(brandVals[i][0] || '').trim()]) continue;
    targets.push(i);
  }
  if (!targets.length) return result;

  var touched = {}; // 실제로 값이 바뀐 행 번호
  for (var ki = 0; ki < keys.length; ki++) {
    var key = keys[ki];
    var col = COL[key];
    var want = _normalizeChannelFieldValue(key, fields[key]);
    var colVals = sheet.getRange(first, col + 1, n, 1).getValues();
    var changed = 0;
    for (var t = 0; t < targets.length; t++) {
      var idx = targets[t];
      var cur = colVals[idx][0];
      var curStr = String(cur == null ? '' : cur).trim();
      if (mode === 'fillEmpty' && curStr !== '') continue; // 빈 칸만 채우기
      if (curStr === String(want)) continue;               // 이미 같은 값
      colVals[idx][0] = want;
      touched[first + idx] = true;
      changed++;
    }
    result.byField[key] = changed;
    if (!result.appliedValues) result.appliedValues = {};
    result.appliedValues[key] = (key === 'followers') ? (want === '' ? null : want) : want;
    if (changed) sheet.getRange(first, col + 1, n, 1).setValues(colVals); // 열당 쓰기 1회
  }

  for (var r in touched) result.rows.push(Number(r));
  result.rows.sort(function (a, b) { return a - b; });
  result.written = result.rows.length;
  // 전파된 행이 속한 공구건들 — 호출부가 캐시 부분 갱신/등급 재기록 대상으로 쓴다
  var ids = {};
  for (var q = 0; q < result.rows.length; q++) {
    var did = String(dealIdVals[result.rows[q] - first][0] || '').trim();
    if (did) ids[did] = true;
  }
  result.dealIds = Object.keys(ids);
  Logger.log('[채널 필드 전파] 채널=' + ch + ' mode=' + mode + ' / 대상 ' + targets.length +
    '행 중 ' + result.written + '행 갱신 / 필드별=' + JSON.stringify(result.byField) +
    (result.skipped.length ? ' / 열없음=' + result.skipped.join(',') : ''));
  return result;
}

/* 채널 단위 필드 단독 갱신 액션 — 채널별 성과 표의 인라인 편집이 쓴다.
   (공구건 모달 저장은 updateDeal에 실려 같은 실행에서 처리되므로 이 액션을 쓰지 않는다 — 왕복 1회 유지) */
function _updateChannelFields(ss, data) {
  var sheet = _mainSheet(ss);
  if (!sheet) return _json({ error: '실적통합 시트를 찾을 수 없습니다.' });
  var channel = String((data && data.channel) || '').trim();
  if (!channel) return _json({ error: '채널명이 비어 있습니다.' });
  var mode = data.mode === 'fillEmpty' ? 'fillEmpty' : 'overwrite';
  var res = _propagateChannelFields(sheet, channel, data.fields || {}, mode);
  if (res.skipped.length) {
    Logger.log('[채널 필드] 시트에 열이 없어 건너뜀: ' + res.skipped.join(',') +
      " — 2행에 '인스타 ID' / '유튜브 ID' 헤더를 추가하면 활성화됨");
  }
  return _json({
    success: true, channel: channel, mode: mode,
    written: res.written, rowIndexes: res.rows, byField: res.byField,
    skippedFields: res.skipped, dealIds: res.dealIds
  });
}

// 공구건 삭제 — dealId 그룹의 모든 행을 하드 삭제(릴스 데이터도 대표 행에 같이 있어 함께 삭제됨)
function _deleteDeal(ss, data) {
  var sheet = _mainSheet(ss);
  if (!sheet) return _json({ error: '실적통합 시트를 찾을 수 없습니다.' });

  var groupRows = _findGroupRows(sheet, data.dealId);
  if (!groupRows.length) return _json({ error: '해당 공구 행을 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.' });

  var brandCell = String(sheet.getRange(groupRows[0].row, COL.brand + 1).getValue() || '').trim();
  if (!MINIX_ALIASES[brandCell]) {
    return _json({ error: '해당 행이 더 이상 유효한 공구 행이 아닙니다. 새로고침 후 다시 시도해주세요.' });
  }

  var rowsDesc = groupRows.map(function (x) { return x.row; }).sort(function (a, b) { return b - a; });
  for (var i = 0; i < rowsDesc.length; i++) sheet.deleteRow(rowsDesc[i]);
  _invalidateDealRowMap(); // 행이 사라졌으므로 dealId→행 맵을 버림

  return _json({ success: true });
}

// 실적 기입 → 대표 행에만 판매수량/총매출/조회수 반영 (현재 프론트에서는 호출하지 않는 액션이지만,
// 총매출은 다른 경로와 똑같이 항상 수식으로 유지 — data.revenue를 직접 setValue하면 다른 경로가
// 심어둔 수식을 고정 숫자로 덮어써 버려서 이후 재계산이 끊기므로 여기도 동일하게 맞춤)
function _addPerf(ss, data) {
  var sheet = _mainSheet(ss);
  if (!sheet) return _json({ error: '실적통합 시트를 찾을 수 없습니다.' });

  var groupRows = _findGroupRows(sheet, data.dealId);
  if (!groupRows.length) return _json({ error: '해당 공구 행을 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.' });
  var primaryRow = groupRows[0].row;

  if (data.qty   != null) sheet.getRange(primaryRow, COL.qty   + 1).setValue(data.qty);
  if (data.qty   != null) sheet.getRange(primaryRow, COL.revenue + 1).setFormula(_revenueFormula(primaryRow));
  if (data.views != null) sheet.getRange(primaryRow, COL.views + 1).setValue(data.views);

  return _json({ success: true });
}

// 모달의 릴스 관리 저장 → 채널 링크 + 릴스별 URL/조회수(하이퍼링크 포함) + 썸네일(JSON) + 조회수 합계.
// 전부 대표 행에만 반영(릴스는 공구건 단위 데이터, 코드별로 나뉘지 않음).
function _saveReels(ss, data) {
  var sheet = _mainSheet(ss);
  if (!sheet) return _json({ error: '실적통합 시트를 찾을 수 없습니다.' });

  var groupRows = _findGroupRows(sheet, data.dealId);
  if (!groupRows.length) return _json({ error: '해당 공구 행을 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.' });
  var sheetRow = groupRows[0].row;

  sheet.getRange(sheetRow, COL.link + 1).setValue(data.link || '');

  var savedCount = _applyReels(sheet, sheetRow, data.reels);
  return _json({ success: true, count: savedCount });
}

/* 릴스 슬롯 + 썸네일 + 조회수 합계를 한 행에 기록 — _saveReels와 _updateDeal이 공유한다.
   ⚠ 2026-09-15 저장 왕복을 줄이면서 추출한 것으로, 로직은 예전 _saveReels 본문 그대로다
   (로직을 새로 쓰면 하이퍼링크·썸네일 처리에서 조용히 틀어질 위험이 있어 옮기기만 했다).
   reels가 null/undefined면 아무것도 하지 않고 0을 돌려준다 — "릴스를 안 건드린 저장"이
   조회수 합계나 슬롯을 지워버리면 안 되기 때문. */
function _applyReels(sheet, sheetRow, reels) {
  if (reels == null) return 0;
  var savedCount = 0;
  var thumbs = [];
  var total = 0;
  for (var i = 0; i < REEL_SLOT_COUNT; i++) {
    var cell = sheet.getRange(sheetRow, REEL_COL_START + i);
    var r = reels[i];
    if (r && (r.url || r.views != null)) {
      var text = r.views != null ? String(r.views) : ' ';
      try {
        if (r.url) {
          cell.setNumberFormat('@');
          var rtv = SpreadsheetApp.newRichTextValue().setText(text).setLinkUrl(0, text.length, r.url).build();
          cell.setRichTextValue(rtv);
        } else {
          cell.setValue(r.views != null ? r.views : '');
        }
      } catch (linkErr) {
        cell.setNumberFormat('@');
        cell.setValue(text);
        Logger.log('릴스 링크 저장 실패 (텍스트만 저장): row=' + sheetRow + ' slot=' + i + ' url=' + r.url + ' err=' + linkErr);
      }
      if (r.views != null) total += Number(r.views);
      thumbs.push(r.thumb || '');
      savedCount++;
    } else {
      cell.setNumberFormat('General');
      cell.setValue('');
      thumbs.push('');
    }
  }
  sheet.getRange(sheetRow, COL.views + 1).setValue(total || '');
  sheet.getRange(sheetRow, COL.thumbs + 1).setValue(JSON.stringify(thumbs));
  return savedCount;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 캘린더 "프로모션/이벤트 일정" (캘린더이벤트 시트) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _ensureEventSheet(ss) {
  var sheet = ss.getSheetByName(EVENT_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(EVENT_SHEET);
    sheet.getRange(1, 1, 1, 4).setValues([['이벤트명', '시작일', '종료일', '메모']]);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
  }
  return sheet;
}

function _eventDateStr(cell) {
  if (cell instanceof Date && !isNaN(cell.getTime())) {
    return cell.getFullYear() + '-' + _pad(cell.getMonth() + 1) + '-' + _pad(cell.getDate());
  }
  var s = String(cell || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

// doGet에서 호출 — 시트가 아직 없으면(한 번도 저장 안 됨) 그냥 빈 배열 반환 (여기서 시트를 생성하지 않음)
function _loadCalendarEvents(ss) {
  var sheet = ss.getSheetByName(EVENT_SHEET);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var events = [];
  for (var i = EVENT_DATA_START_ROW; i < data.length; i++) {
    var row = data[i];
    var name = String(row[EVENT_COL.name] || '').trim();
    var start = _eventDateStr(row[EVENT_COL.start]);
    if (!name || !start) continue;
    events.push({
      id: i + 1, // 캘린더이벤트 시트의 실제 물리 행 번호(1-based)
      name: name,
      start: start,
      end: _eventDateStr(row[EVENT_COL.end]) || start,
      note: String(row[EVENT_COL.note] || '').trim()
    });
  }
  return events;
}

// 클라이언트가 모달을 연 시점의 이벤트명(origName)이 현재 시트 값과 일치하는지 확인
// (그 사이 행이 삭제/이동됐으면 엉뚱한 행을 고치지 않도록 방어)
function _eventRowValid(sheet, row, origName) {
  if (!row || row <= EVENT_DATA_START_ROW || row > sheet.getLastRow()) return false;
  var actual = String(sheet.getRange(row, EVENT_COL.name + 1).getValue() || '').trim();
  return actual === String(origName || '').trim();
}

function _addCalendarEvent(ss, data) {
  var name = String((data && data.name) || '').trim();
  var start = data && data.start ? new Date(data.start) : null;
  if (!name) return _json({ error: '이벤트명을 입력하세요.' });
  if (!start) return _json({ error: '시작일을 입력하세요.' });
  var end = data.end ? new Date(data.end) : start;

  var sheet = _ensureEventSheet(ss);
  sheet.appendRow([name, start, end, data.note || '']);
  return _json({ success: true });
}

function _updateCalendarEvent(ss, data) {
  var sheet = ss.getSheetByName(EVENT_SHEET);
  if (!sheet) return _json({ error: '캘린더이벤트 시트를 찾을 수 없습니다.' });
  if (!_eventRowValid(sheet, data.row, data.origName)) {
    return _json({ error: '해당 이벤트를 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.' });
  }
  var name = String((data && data.name) || '').trim();
  var start = data && data.start ? new Date(data.start) : null;
  if (!name) return _json({ error: '이벤트명을 입력하세요.' });
  if (!start) return _json({ error: '시작일을 입력하세요.' });
  var end = data.end ? new Date(data.end) : start;

  var row = data.row;
  sheet.getRange(row, EVENT_COL.name + 1).setValue(name);
  sheet.getRange(row, EVENT_COL.start + 1).setValue(start);
  sheet.getRange(row, EVENT_COL.end + 1).setValue(end);
  sheet.getRange(row, EVENT_COL.note + 1).setValue(data.note || '');
  return _json({ success: true });
}

function _deleteCalendarEvent(ss, data) {
  var sheet = ss.getSheetByName(EVENT_SHEET);
  if (!sheet) return _json({ error: '캘린더이벤트 시트를 찾을 수 없습니다.' });
  if (!_eventRowValid(sheet, data.row, data.origName)) {
    return _json({ error: '해당 이벤트를 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.' });
  }
  sheet.deleteRow(data.row);
  return _json({ success: true });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 릴스 썸네일 업로드(Drive) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

var THUMB_FOLDER_NAME = '공동구매_릴스_썸네일';

// Workspace 도메인에 배포된 스크립트는 ScriptApp.getService().getUrl()이 가끔
// https://script.google.com/a/<도메인>/macros/s/.../exec 형태로 나옴 — 이 /a/<도메인>/ 경로는
// 구글이 자체 로그인 세션(우리 idToken과는 별개)을 요구해서 리다이렉트/차단될 수 있으므로,
// 일반적인 /macros/s/.../exec 형태로 통일해서 저장함(우리 앱의 idToken 인증만 거치도록).
function _canonicalScriptUrl() {
  var url = ScriptApp.getService().getUrl();
  return url.replace(/\/a\/[^/]+\/macros\//, '/macros/');
}

function _uploadThumbnail(data) {
  if (!data || !data.base64) return _json({ error: '업로드할 이미지 데이터가 없습니다.' });
  try {
    var folder = _getThumbFolder();
    var bytes = Utilities.base64Decode(data.base64);
    var mimeType = data.mimeType || 'image/jpeg';
    var blob = Utilities.newBlob(bytes, mimeType, 'thumb_' + Date.now() + '.jpg');
    var file = folder.createFile(blob);

    // 조직 정책이 "링크가 있는 모든 사용자" 공유를 막고 있어 개별 파일 공유는 신뢰할 수 없음(403).
    // 대신 파일은 비공개로 두고, doGet의 ?thumb=<fileId> 프록시로 스크립트 소유자 권한으로 내려줌.
    // 이 URL 자체엔 idToken을 넣지 않음(토큰은 만료되므로) — 프론트가 매번 요청 시점에 새로 붙임.
    var url = _canonicalScriptUrl() + '?thumb=' + file.getId();
    return _json({ success: true, url: url });
  } catch (err) {
    return _json({ error: '이미지 업로드 실패: ' + err.toString() });
  }
}

function _getThumbFolder() {
  var it = DriveApp.getFoldersByName(THUMB_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(THUMB_FOLDER_NAME);
}

// doGet의 ?thumb=<fileId> 프록시 본체 — 이미지를 base64로 인코딩해 다른 모든 응답과 동일한
// _json() 파이프라인으로 내려줌. Blob을 doGet에서 직접 반환하면 구글이 파일을
// googleusercontent.com으로 302 리다이렉트해서 서빙하는데, 그 응답엔 CORS 헤더가 없어서
// fetch()가 차단됨 — ContentService JSON 응답은 fetchLive와 동일하게 CORS를 통과하므로 이 방식으로 통일함.
function _thumbAsJson(fileId) {
  try {
    var blob = DriveApp.getFileById(fileId).getBlob();
    var base64 = Utilities.base64Encode(blob.getBytes());
    var mimeType = blob.getContentType() || 'image/jpeg';
    return _json({ success: true, base64: base64, mimeType: mimeType });
  } catch (err) {
    return _json({ error: '썸네일을 불러올 수 없습니다: ' + err.toString() });
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 회고 (회고 시트) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function _ensureReviewSheet(ss) {
  var sheet = ss.getSheetByName(REVIEW_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(REVIEW_SHEET);
    sheet.getRange(1, 1, 1, 9).setValues([['id', '제목', '연월', '담당자', '팀', '파트', '본문', '수정일시', '최종편집자']]);
    sheet.getRange(1, 1, 1, 9).setFontWeight('bold');
  }
  return sheet;
}

// doGet ?review=list / ?review=get&id=... / ?review=meta&id=... 진입점
function _handleReviewGet(reviewParam, id) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (reviewParam === 'list') return _json({ success: true, reviews: _listReviews(ss) });
  if (reviewParam === 'get') {
    var doc = _getReviewDoc(ss, id);
    if (!doc) return _json({ error: '해당 회고 문서를 찾을 수 없습니다.' });
    return _json({ success: true, review: doc });
  }
  if (reviewParam === 'meta') {
    // 저장 직전 동시 편집 충돌 감지용 경량 조회 — 본문 없이 최종 편집 시각/편집자만 돌려줌
    var sheet = ss.getSheetByName(REVIEW_SHEET);
    if (!sheet || !id) return _json({ error: '해당 회고 문서를 찾을 수 없습니다.' });
    var row = _findReviewRow(sheet, id);
    if (!row) return _json({ error: '해당 회고 문서를 찾을 수 없습니다.' });
    var vals = sheet.getRange(row, 1, 1, 9).getValues()[0];
    return _json({
      success: true,
      updatedAt: _reviewUpdatedAtStr(vals[REVIEW_COL.updatedAt]),
      editedBy: String(vals[REVIEW_COL.editedBy] || '')
    });
  }
  return _json({ error: 'Unknown review request: ' + reviewParam });
}

function _reviewUpdatedAtStr(cell) {
  return cell instanceof Date ? cell.toISOString() : String(cell || '');
}

// ym("yyyy-MM") 셀이 시트에 의해 날짜로 잘못 저장된 과거 행을 방어적으로 복구 — 이후
// _saveReview는 저장 시 서식을 텍스트로 고정해 재발을 막지만, 이미 날짜로 저장된 기존 값은
// 그대로 남아있으므로 읽을 때 "yyyy-MM"으로 되돌려 <input type="month">가 인식하게 함.
function _reviewYmStr(cell) {
  if (cell instanceof Date) {
    var m = cell.getMonth() + 1;
    return cell.getFullYear() + '-' + (m < 10 ? '0' + m : '' + m);
  }
  return String(cell || '');
}

// 목록 화면용 — 시트가 아직 없으면(한 번도 저장 안 됨) 빈 배열 반환(캘린더이벤트와 동일 패턴).
// 본문(블록 JSON)은 목록에 필요 없어 응답에서 제외 — 문서가 많아져도 목록 응답이 가벼움.
function _listReviews(ss) {
  var sheet = ss.getSheetByName(REVIEW_SHEET);
  if (!sheet) return [];
  var data = sheet.getDataRange().getValues();
  var list = [];
  for (var i = REVIEW_DATA_START_ROW; i < data.length; i++) {
    var row = data[i];
    var id = String(row[REVIEW_COL.id] || '').trim();
    if (!id) continue;
    list.push({
      id: id,
      title: String(row[REVIEW_COL.title] || ''),
      ym: _reviewYmStr(row[REVIEW_COL.ym]),
      owner: String(row[REVIEW_COL.owner] || ''),
      team: String(row[REVIEW_COL.team] || ''),
      part: String(row[REVIEW_COL.part] || ''),
      updatedAt: _reviewUpdatedAtStr(row[REVIEW_COL.updatedAt]),
      editedBy: String(row[REVIEW_COL.editedBy] || '')
    });
  }
  list.sort(function (a, b) { return (b.updatedAt || '').localeCompare(a.updatedAt || ''); }); // 최신 작성순
  return list;
}

function _findReviewRow(sheet, id) {
  var data = sheet.getDataRange().getValues();
  for (var i = REVIEW_DATA_START_ROW; i < data.length; i++) {
    if (String(data[i][REVIEW_COL.id] || '') === id) return i + 1; // 1-based 물리 행 번호
  }
  return 0;
}

function _getReviewDoc(ss, id) {
  var sheet = ss.getSheetByName(REVIEW_SHEET);
  if (!sheet || !id) return null;
  var data = sheet.getDataRange().getValues();
  for (var i = REVIEW_DATA_START_ROW; i < data.length; i++) {
    var row = data[i];
    if (String(row[REVIEW_COL.id] || '') !== id) continue;
    // 본문은 분할 저장됐을 수 있음 — '본문'(G열) + '본문2'(J열)부터 순서대로 이어붙여 원문 복원
    var content = String(row[REVIEW_COL.body] || '');
    for (var c = REVIEW_BODY_EXTRA_START_COL - 1; c < row.length; c++) {
      if (row[c] === '' || row[c] === null || row[c] === undefined) break; // 오버플로우는 연속으로만 존재
      content += String(row[c]);
    }
    // blocks는 구버전 프론트(자체 블록 에디터) 호환용 — 본문이 배열 JSON일 때만 채워짐.
    // 신 프론트는 content(원문 문자열)만 사용하므로 GAS를 먼저 재배포해도 기존 화면이 깨지지 않음.
    var blocks = [];
    try { var p = JSON.parse(content || '[]'); if (Object.prototype.toString.call(p) === '[object Array]') blocks = p; } catch (e) { blocks = []; }
    return {
      id: String(row[REVIEW_COL.id] || ''),
      title: String(row[REVIEW_COL.title] || ''),
      ym: _reviewYmStr(row[REVIEW_COL.ym]),
      owner: String(row[REVIEW_COL.owner] || ''),
      team: String(row[REVIEW_COL.team] || ''),
      part: String(row[REVIEW_COL.part] || ''),
      content: content,
      blocks: blocks,
      updatedAt: _reviewUpdatedAtStr(row[REVIEW_COL.updatedAt]),
      editedBy: String(row[REVIEW_COL.editedBy] || '')
    };
  }
  return null;
}

// 저장(신규/수정 겸용) — id가 없으면 새로 발급해 새 행 추가, 있으면 기존 행을 덮어씀.
// 로그인한 athomecorp.com 사용자 누구나 읽기/쓰기 가능(REQUIRE_AUTH 도메인 검증 외 추가 제한 없음).
// 본문: 신 프론트는 content(Editor.js JSON 문자열), 구 프론트는 blocks(블록 트리 배열)를 보냄 —
// 재배포 순서와 무관하게 둘 다 수용. 45,000자 초과분은 '본문2','본문3',...(J열~)에 분할 저장.
function _saveReview(ss, data, auth) {
  var sheet = _ensureReviewSheet(ss);
  var editor = (auth && (auth.name || auth.email)) || '';
  var id = String((data && data.id) || '').trim() || Utilities.getUuid();
  var now = new Date().toISOString();
  var content = (data && typeof data.content === 'string') ? data.content : JSON.stringify((data && data.blocks) || []);
  var chunks = _splitReviewBody(content);
  var rowData = [
    id,
    String((data && data.title) || '').trim(),
    String((data && data.ym) || '').trim(),
    String((data && data.owner) || '').trim(),
    String((data && data.team) || '').trim(),
    String((data && data.part) || '').trim(),
    chunks[0],
    now,
    editor
  ];
  var row = _findReviewRow(sheet, id);
  if (row) sheet.getRange(row, 1, 1, rowData.length).setValues([rowData]);
  else { sheet.appendRow(rowData); row = _findReviewRow(sheet, id); }
  // 월(ym) 셀은 "yyyy-MM" 형태라 시트가 날짜로 자동 인식해 값을 날짜 일련값으로 바꿔치기하는
  // 경우가 있음(Apps Script setValues도 예외 아님 — 실측 확인). 서식을 일반 텍스트로 고정한 뒤
  // 값을 한 번 더 써서, 위 setValues/appendRow가 날짜로 바꿔놨더라도 그 값을 되돌림.
  sheet.getRange(row, REVIEW_COL.ym + 1).setNumberFormat('@').setValue(rowData[REVIEW_COL.ym]);
  // 오버플로우 조각 기록 + 이전 저장이 남긴 잔여 오버플로우 셀 청소(본문이 짧아진 경우 대비)
  var extra = chunks.length - 1;
  if (extra > 0) {
    _ensureReviewOverflowHeaders(sheet, extra);
    sheet.getRange(row, REVIEW_BODY_EXTRA_START_COL, 1, extra).setValues([chunks.slice(1)]);
  }
  var lastCol = sheet.getLastColumn();
  var clearFrom = REVIEW_BODY_EXTRA_START_COL + extra;
  if (lastCol >= clearFrom) sheet.getRange(row, clearFrom, 1, lastCol - clearFrom + 1).clearContent();
  return _json({ success: true, id: id, updatedAt: now, editedBy: editor });
}

// 본문을 셀당 45,000자 조각으로 분할 — 조각 경계가 서로게이트 페어(이모지 등) 한가운데를
// 지나면 셀에 깨진 문자가 저장될 수 있어 경계를 한 글자 양보함(이어붙이면 원문과 동일).
function _splitReviewBody(content) {
  var s = String(content || '');
  var chunks = [];
  var i = 0;
  while (i < s.length) {
    var end = Math.min(i + REVIEW_BODY_CHUNK_MAX, s.length);
    if (end < s.length) {
      var c = s.charCodeAt(end - 1);
      if (c >= 0xD800 && c <= 0xDBFF) end--;
    }
    chunks.push(s.slice(i, end));
    i = end;
  }
  if (!chunks.length) chunks.push('');
  return chunks;
}

// '본문2','본문3',... 헤더가 필요한 만큼 존재하도록 보장(없을 때만 씀)
function _ensureReviewOverflowHeaders(sheet, extraCount) {
  for (var k = 0; k < extraCount; k++) {
    var col = REVIEW_BODY_EXTRA_START_COL + k;
    var h = sheet.getRange(1, col);
    if (!h.getValue()) h.setValue('본문' + (k + 2)).setFontWeight('bold');
  }
}

function _deleteReview(ss, data) {
  var sheet = ss.getSheetByName(REVIEW_SHEET);
  if (!sheet) return _json({ error: '회고 시트를 찾을 수 없습니다.' });
  var id = String((data && data.id) || '').trim();
  var row = _findReviewRow(sheet, id);
  if (!row) return _json({ error: '해당 회고 문서를 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.' });
  sheet.deleteRow(row);
  return _json({ success: true });
}

// 복사 — 원본 회고를 통째로 복제해 새 id로 저장(원본은 그대로 유지). 제목만 "- 복사본"을 붙여
// 구분하고, 나머지 메타(담당자/팀/파트/연월)와 본문은 그대로 복제함. 본문에 박힌 이미지는
// _cloneReviewImages로 Drive 파일 자체를 복사해 원본과 독립시킴 — 원본을 나중에 삭제해도
// 복사본 이미지가 함께 사라지지 않게 하기 위함(2026-08-25).
function _duplicateReview(ss, data, auth) {
  var srcId = String((data && data.id) || '').trim();
  var src = _getReviewDoc(ss, srcId);
  if (!src) return _json({ error: '원본 회고를 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.' });

  var newContent = _cloneReviewImages(src.content);
  var newTitle = (src.title && src.title.trim() ? src.title.trim() : '제목 없음') + ' - 복사본';

  var editor = (auth && (auth.name || auth.email)) || '';
  var sheet = _ensureReviewSheet(ss);
  var newId = Utilities.getUuid();
  var now = new Date().toISOString();
  var chunks = _splitReviewBody(newContent);
  var rowData = [newId, newTitle, src.ym, src.owner, src.team, src.part, chunks[0], now, editor];
  sheet.appendRow(rowData);
  var row = _findReviewRow(sheet, newId);
  // ym 셀 날짜 자동변환 방지(원본 셀도 이미 텍스트로 저장돼 있지만 appendRow는 재검증 안 하므로 동일하게 고정)
  sheet.getRange(row, REVIEW_COL.ym + 1).setNumberFormat('@').setValue(rowData[REVIEW_COL.ym]);
  var extra = chunks.length - 1;
  if (extra > 0) {
    _ensureReviewOverflowHeaders(sheet, extra);
    sheet.getRange(row, REVIEW_BODY_EXTRA_START_COL, 1, extra).setValues([chunks.slice(1)]);
  }
  return _json({ success: true, id: newId, title: newTitle, updatedAt: now, editedBy: editor });
}

// 본문(JSON 문자열) 안에 박힌 우리 Drive 이미지 URL(lh3.googleusercontent.com/d/<fileId>)을 전부
// 찾아 실제 Drive 파일을 복사하고, 문자열 치환으로 새 URL을 끼워넣음. 같은 이미지가 문서 안에
// 여러 번 쓰였어도 파일당 한 번만 복사(idMap으로 중복 방지). 개별 이미지 복사가 실패해도(권한 등)
// 전체 복사 자체는 계속 진행 — 그 이미지만 원본 파일을 그대로 참조(복사본이 아예 안 만들어지는 것보단
// 나음, 다만 그 한 장은 원본 삭제 시 함께 깨질 수 있음 — 실패는 Logger에 남겨 추적 가능).
function _cloneReviewImages(content) {
  var re = /https:\/\/lh3\.googleusercontent\.com\/d\/([A-Za-z0-9_-]+)/g;
  var idMap = {};
  var m;
  while ((m = re.exec(content)) !== null) {
    var fileId = m[1];
    if (idMap.hasOwnProperty(fileId)) continue;
    try {
      var copy = DriveApp.getFileById(fileId).makeCopy(_getReviewImgFolder());
      try { _shareFilePublic(copy); } catch (shareErr) { /* 공유 실패해도 복사 자체는 성공 처리 */ }
      idMap[fileId] = copy.getId();
    } catch (err) {
      Logger.log('[회고 복사] 이미지 복제 실패(원본 파일을 그대로 참조함): fileId=' + fileId + ' err=' + err);
      idMap[fileId] = fileId;
    }
  }
  var result = content;
  for (var oldId in idMap) {
    if (idMap[oldId] === oldId) continue;
    result = result.split('https://lh3.googleusercontent.com/d/' + oldId).join('https://lh3.googleusercontent.com/d/' + idMap[oldId]);
  }
  return result;
}

// 회고 본문에 삽입하는 이미지 — 릴스 썸네일과 완전히 같은 방식(전용 Drive 폴더에 비공개로 저장하고
// doGet의 ?thumb=<fileId> 프록시로 인증 fetch 서빙)이라 폴더만 분리하고 프록시는 그대로 재사용함.
var REVIEW_IMG_FOLDER_NAME = '공동구매_회고_이미지';

function _getReviewImgFolder() {
  var it = DriveApp.getFoldersByName(REVIEW_IMG_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(REVIEW_IMG_FOLDER_NAME);
}

// 회고 이미지는 조직 내(도메인) 링크 공유로 고정 — 외부 공개(ANYONE_WITH_LINK)는 쓰지 않음
// (2026-08-11 결정: 내부 자료라 링크 유출 시 외부 열람 가능성을 차단). 팀원은 대시보드 로그인
// 과정에서 이미 Google 세션이 있으므로 lh3.googleusercontent.com <img>가 그대로 표시됨.
function _shareFilePublic(file) {
  file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
}

function _saveReviewImageBlob(blob, ext) {
  var folder = _getReviewImgFolder();
  var file = folder.createFile(blob.setName('review_' + Date.now() + '.' + ext));
  try { _shareFilePublic(file); } catch (e) { /* 공유 실패해도 업로드 자체는 성공 처리(소유자/도메인 조회는 가능) */ }
  return _json({ success: true, url: 'https://lh3.googleusercontent.com/d/' + file.getId() });
}

function _uploadReviewImage(data) {
  if (!data || !data.base64) return _json({ error: '업로드할 이미지 데이터가 없습니다.' });
  try {
    var bytes = Utilities.base64Decode(data.base64);
    var mimeType = data.mimeType || 'image/jpeg';
    var ext = mimeType.indexOf('png') >= 0 ? 'png' : 'jpg';
    var blob = Utilities.newBlob(bytes, mimeType);
    return _saveReviewImageBlob(blob, ext);
  } catch (err) {
    return _json({ error: '이미지 업로드 실패: ' + err.toString() });
  }
}

// 노션 등 외부 이미지 URL을 서버(UrlFetchApp)가 즉시 가져와 Drive에 영구 저장 —
// 노션 클립보드의 S3 서명 URL은 곧 만료되므로 프론트가 URL을 그대로 저장하면 안 됨.
var REVIEW_IMG_URL_MAX_BYTES = 15 * 1024 * 1024;
function _uploadReviewImageByUrl(data) {
  var url = String((data && data.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) return _json({ error: '유효한 이미지 URL이 아닙니다.' });
  try {
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    if (res.getResponseCode() >= 400) return _json({ error: '이미지를 가져오지 못했습니다 (HTTP ' + res.getResponseCode() + ')' });
    var blob = res.getBlob();
    var mimeType = String(blob.getContentType() || '');
    if (mimeType.indexOf('image/') !== 0) return _json({ error: '이미지 형식이 아닙니다: ' + (mimeType || '알 수 없음') });
    if (blob.getBytes().length > REVIEW_IMG_URL_MAX_BYTES) return _json({ error: '이미지가 너무 큽니다 (15MB 초과)' });
    var ext = mimeType.indexOf('png') >= 0 ? 'png' : (mimeType.indexOf('gif') >= 0 ? 'gif' : (mimeType.indexOf('webp') >= 0 ? 'webp' : 'jpg'));
    return _saveReviewImageBlob(blob, ext);
  } catch (err) {
    return _json({ error: '이미지 가져오기 실패: ' + err.toString() });
  }
}

// 구버전 회고 이미지(?thumb= 프록시 방식, 비공개)를 새 <img> 직접 표시 방식으로 살리기 위한
// 지연 마이그레이션 — 프론트가 구형 이미지 블록을 발견하면 fileId 목록을 보내오고,
// 여기서 링크 공유만 걸어줌(파일 이동/복사 없음). 실패한 id는 조용히 건너뜀.
function _shareReviewImages(data) {
  var ids = (data && data.ids) || [];
  var done = 0;
  for (var i = 0; i < ids.length && i < 30; i++) {
    try { _shareFilePublic(DriveApp.getFileById(String(ids[i]))); done++; } catch (e) {}
  }
  return _json({ success: true, shared: done });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 유틸리티 ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 모든 응답이 이 함수를 거치므로, 여기 한 곳에서만 execMs를 채우면 읽기/쓰기/에러 응답 전부가
// 별도 수정 없이 "GAS 처리 시간(ms)"을 갖게 됨 — 프론트가 이 값으로 병목이 GAS인지(execMs가 큼)
// 네트워크/콜드스타트인지(execMs는 작은데 왕복은 느림) 구분할 수 있음. 호출부가 이미 execMs를
// 직접 넣어둔 경우(예: doGet의 캐시 히트 경로)는 덮어쓰지 않음.
// 마지막으로 직렬화한 객체 — _handleWriteAction이 여기에 timings를 얹어 다시 내보낸다.
var _lastJsonObj = null;
function _json(obj) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) _lastJsonObj = obj;
  /* 슬라이딩 연장으로 새 세션 토큰이 발급됐으면 어떤 응답이든 여기에 실어 보낸다.
     반환 지점이 수십 곳이라 호출부마다 챙기게 하면 반드시 빠뜨리는 곳이 생기고, 그 경로만
     조용히 연장이 안 돼서 "가끔 로그아웃"이 재발한다 — 출구 한 곳에서 처리한다. */
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && _renewedSessionToken && !obj.sessionToken) {
    obj.sessionToken = _renewedSessionToken;
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.execMs === undefined && _reqStartMs) {
    obj.execMs = Date.now() - _reqStartMs;
  }
  /* 버전도 같은 이유로 출구에서 싣는다. 예전엔 성공 payload에만 있어서, AUTH_REQUIRED 같은
     에러 응답을 받은 프론트가 "버전 필드 없음 — 구버전 배포본"으로 로그를 남겼다. 인증 실패를
     배포 문제로 오해하게 만드는 로그였으므로, 어떤 응답에든 실려 나가게 한다. */
  if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.version === undefined) {
    obj.version = SCRIPT_VERSION;
  }
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _pad(n) { return n < 10 ? '0' + n : String(n); }

// 0-based 열 인덱스(COL.xxx) → 스프레드시트 A1 열 문자(0→A, 1→B, ..., 25→Z, 26→AA ...).
// 총매출 수식(=J{row}*I{row})을 만들 때 COL.qty/COL.salePrice 값이 나중에 열이 밀려도 안 깨지게
// 하드코딩된 'I'/'J' 대신 이걸로 계산함.
function _colLetter(idx0) {
  var n = idx0 + 1, s = '';
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
// 총매출 = 판매수량 × 공구가, 해당 행(row, 1-based) 기준 상대참조 수식 문자열
function _revenueFormula(row) {
  return '=' + _colLetter(COL.qty) + row + '*' + _colLetter(COL.salePrice) + row;
}

// 오픈시간(추가옵션2) 값을 항상 "HH:00" 문자열로 정규화(2026-08-21) — 구글 시트가 "10:00" 같은
// 문자열을 시간(time) 값으로 자동 인식해버린 셀은 getValues()로 읽으면 Date 객체(1899-12-30
// 기준일 + 그 시각)나 시간 소수값(0~1, 하루 중 비율)으로 넘어오는데, 이러면 프론트 드롭다운의
// option value("10:00")와 안 맞아서 매칭이 실패해 빈 드롭다운으로 보임. 어떤 형태로 오든 여기서
// 하나로 통일해서, 이미 이렇게 저장된 기존 값도 (다시 쓰지 않고 읽을 때만) 정상 매칭되게 함.
function _normalizeOpenTime(raw) {
  if (raw == null || raw === '') return '';
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return '';
    return _pad(raw.getHours()) + ':00';
  }
  if (typeof raw === 'number') {
    // 시간 값이 0~1 사이 소수(하루 중 비율)로 오는 경우 — 시간 단위로 환산
    var hour = Math.round(raw * 24) % 24;
    return _pad(hour) + ':00';
  }
  var s = String(raw).trim();
  var m = s.match(/^(\d{1,2}):(\d{2})/); // "10:00"과 "10:00:00" 둘 다 앞의 시:분만 취함
  // "24:00"은 00:00과 동일한 시각으로 통일(2026-08-27 드롭다운 00:00~23:00 정리) — 예전에
  // 24:00으로 저장된 건도 읽을 때 00:00으로 넘어가 드롭다운에 정상 매칭됨(시트 값은 건드리지 않음).
  if (m) return _pad(parseInt(m[1], 10) % 24) + ':00';
  return s; // 알아볼 수 없는 형식은 원문을 그대로 보존(추측해서 지우지 않음)
}

function _numOrNull(v) {
  if (v === null || v === '' || v === undefined) return null;
  var n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? null : n;
}

// "YYYY-MM-DD"(프론트가 시작일/종료일로 항상 이 형식을 보냄) → 시간 없는 Date로 안전하게 변환.
// new Date("YYYY-MM-DD")는 스펙상 UTC 자정으로 해석되는데, 이 스크립트/시트 타임존이 UTC+9(한국)라
// 시트에는 그 날짜 오전 9시로 저장돼버리는 문제가 있었음(2026-08-24 확인 — "2026. 8. 27 오전
// 9:00:00"처럼 보이던 값의 실제 원인). 연/월/일을 직접 뽑아 new Date(y, m-1, d)로 만들면 로컬
// 자정이 되어 이 시차가 생기지 않음.
function _toDateOnly(dateStr) {
  if (!dateStr) return null;
  var m = String(dateStr).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

// 날짜 파싱: Date 셀 → "YYYY-MM-DD" (연도 + "M/D" 텍스트 형식도 폴백 지원)
function _parseDate(cell, year) {
  if (cell instanceof Date && !isNaN(cell.getTime())) {
    return cell.getFullYear() + '-' + _pad(cell.getMonth() + 1) + '-' + _pad(cell.getDate());
  }
  var s = String(cell || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  var m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})$/);
  if (m && year) {
    var mo = parseInt(m[1], 10);
    var da = parseInt(m[2], 10);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return parseInt(year, 10) + '-' + _pad(mo) + '-' + _pad(da);
  }
  return null;
}

// 연도 넘김 보정: 시작일/종료일이 같은 해로 파싱됐는데 종료월이 시작월보다 앞서면(예: 12월→1월)
// 실제로는 해를 넘긴 일정으로 보고 종료일 연도를 +1 함.
function _fixYearWrap(startDate, endDate) {
  if (!startDate || !endDate) return endDate;
  var sy = parseInt(startDate.slice(0, 4), 10), sm = parseInt(startDate.slice(5, 7), 10);
  var ey = parseInt(endDate.slice(0, 4), 10), em = parseInt(endDate.slice(5, 7), 10);
  if (sy === ey && em < sm) return (ey + 1) + endDate.slice(4);
  return endDate;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── 일회성: 시작일/종료일 뒤섞인 기존 데이터 정규화 (2026-08-24) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 시트에 "8/27"(연도 없는 텍스트) / "2026. 8. 25"(날짜) / "2026. 8. 27 오전 9:00:00"(날짜+시간,
// _toDateOnly 도입 전 UTC 파싱 버그로 생긴 값) 세 형태가 섞여 있던 걸 전부 "연도 포함, 시간 없는
// 날짜"로 통일하는 일회성 스크립트. Apps Script 편집기에서 함수 선택 드롭다운으로 아래 순서대로
// 직접 실행할 것(웹앱 경유 아님 — 실수로 재실행되는 걸 막기 위해 일부러 doGet에 연결하지 않음):
//   1) backupMainSheetForDateFix()   — 원본을 별도 시트로 복제. 반드시 먼저 실행.
//   2) previewDateNormalization()    — 아무것도 쓰지 않고 무엇이/왜 바뀔지만 계산해 반환(Executions
//                                       로그 또는 실행 후 "실행 기록" 패널에서 반환값 확인).
//   3) 위 결과(특히 wrapCases/unresolved)를 확인하고 문제 없으면 applyDateNormalization() 실행 —
//      이때 실제로 시트에 반영됨.
function backupMainSheetForDateFix() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(MAIN_SHEET);
  if (!sheet) { Logger.log('실적통합 시트를 찾을 수 없습니다.'); return null; }
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
  var backupName = (MAIN_SHEET + '_백업_날짜정규화전_' + stamp).slice(0, 100);
  var copy = sheet.copyTo(ss);
  copy.setName(backupName);
  Logger.log('백업 완료: "' + backupName + '" 시트가 생성되었습니다. 이 시트를 지우지 말고 보관하세요.');
  return backupName;
}

function previewDateNormalization() {
  return _normalizeSheetDates(true);
}

function applyDateNormalization() {
  return _normalizeSheetDates(false);
}

// raw 셀 값(Date 인스턴스 또는 텍스트) → {y,m,d}. "M/D"(연도 없음) 텍스트는 yearHint(해당 행의
// 연도 열 값)를 그대로 사용 — 연도를 추측하지 않고 반드시 이 값에서만 가져옴.
function _parseDateLoose(raw, yearHint) {
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    return { y: raw.getFullYear(), m: raw.getMonth() + 1, d: raw.getDate() };
  }
  var s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  var mFull = s.match(/^(\d{4})[.\-\/]\s*(\d{1,2})[.\-\/]\s*(\d{1,2})/);
  if (mFull) return { y: parseInt(mFull[1], 10), m: parseInt(mFull[2], 10), d: parseInt(mFull[3], 10) };
  var mShort = s.match(/^(\d{1,2})[\/\-.](\d{1,2})$/);
  if (mShort && yearHint) return { y: parseInt(yearHint, 10), m: parseInt(mShort[1], 10), d: parseInt(mShort[2], 10) };
  return null;
}

function _isoOf(p) { return p ? (p.y + '-' + _pad(p.m) + '-' + _pad(p.d)) : null; }

// dryRun=true면 아무것도 쓰지 않고 무엇이 바뀔지만 계산해서 반환(안전 확인용).
// dryRun=false면 실제로 시작일/종료일 열에 반영(연도 열은 건드리지 않음 — 그대로 신뢰해 입력값으로만 씀).
function _normalizeSheetDates(dryRun) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = _mainSheet(ss);
  if (!sheet) { Logger.log('실적통합 시트를 찾을 수 없습니다.'); return { error: '시트 없음' }; }

  var lastDataRow = _getLastDataRow(sheet, COL.channel + 1);
  if (lastDataRow <= DATA_START_ROW) {
    Logger.log('데이터 행이 없습니다.');
    return { totalRows: 0, changed: 0, wrapCases: [], unresolved: [] };
  }

  var numRows = lastDataRow - DATA_START_ROW;
  var startRange = sheet.getRange(DATA_START_ROW + 1, COL.startMD + 1, numRows, 1);
  var endRange   = sheet.getRange(DATA_START_ROW + 1, COL.endMD   + 1, numRows, 1);
  var yearRange  = sheet.getRange(DATA_START_ROW + 1, COL.year    + 1, numRows, 1);
  var startVals = startRange.getValues();
  var endVals   = endRange.getValues();
  var yearVals  = yearRange.getValues();

  var changed = 0, wrapCases = [], unresolved = [];
  var newStartVals = [], newEndVals = [];

  for (var i = 0; i < numRows; i++) {
    var rowNum = DATA_START_ROW + 1 + i;
    var rawStart = startVals[i][0];
    var rawEnd = endVals[i][0];
    var hasStart = (rawStart instanceof Date) || String(rawStart || '').trim() !== '';

    if (!hasStart) { // 시작일 자체가 없는 행은 건드리지 않음
      newStartVals.push([rawStart]); newEndVals.push([rawEnd]);
      continue;
    }

    var yearHint = _numOrNull(yearVals[i][0]);
    var ps = _parseDateLoose(rawStart, yearHint);
    var pe = _parseDateLoose(rawEnd, yearHint) || ps;

    if (!ps) {
      unresolved.push({ row: rowNum, rawStart: String(rawStart), rawEnd: String(rawEnd), yearCol: yearVals[i][0] });
      newStartVals.push([rawStart]); newEndVals.push([rawEnd]);
      continue;
    }

    var startISO = _isoOf(ps);
    var endISO = _isoOf(pe);
    if (endISO < startISO) {
      var oldEndISO = endISO;
      pe = { y: ps.y + 1, m: pe.m, d: pe.d };
      endISO = _isoOf(pe);
      wrapCases.push({ row: rowNum, start: startISO, oldEnd: oldEndISO, newEnd: endISO });
    }

    var wasAlreadyClean =
      (rawStart instanceof Date) && rawStart.getHours() === 0 && rawStart.getMinutes() === 0 && rawStart.getSeconds() === 0 &&
      (rawEnd instanceof Date) && rawEnd.getHours() === 0 && rawEnd.getMinutes() === 0 && rawEnd.getSeconds() === 0 &&
      rawStart.getFullYear() === ps.y && rawStart.getMonth() + 1 === ps.m && rawStart.getDate() === ps.d &&
      rawEnd.getFullYear() === pe.y && rawEnd.getMonth() + 1 === pe.m && rawEnd.getDate() === pe.d;
    if (!wasAlreadyClean) changed++;

    newStartVals.push([new Date(ps.y, ps.m - 1, ps.d)]);
    newEndVals.push([new Date(pe.y, pe.m - 1, pe.d)]);
  }

  var summary = { totalRows: numRows, changed: changed, wrapCases: wrapCases, unresolved: unresolved, dryRun: dryRun };
  Logger.log('[날짜 정규화 ' + (dryRun ? '미리보기' : '적용') + '] 전체 ' + numRows + '행 중 변경대상 ' + changed +
    '건, 연말-연초 걸침 보정 ' + wrapCases.length + '건, 인식 불가(미변경) ' + unresolved.length + '건');
  if (wrapCases.length) Logger.log('[연말-연초 걸침 보정 상세] ' + JSON.stringify(wrapCases));
  if (unresolved.length) Logger.log('[인식 불가 상세 — 수동 확인 필요] ' + JSON.stringify(unresolved));

  if (!dryRun) {
    startRange.setValues(newStartVals);
    endRange.setValues(newEndVals);
    startRange.setNumberFormat('yyyy-mm-dd');
    endRange.setNumberFormat('yyyy-mm-dd');
    Logger.log('[날짜 정규화 적용 완료] 시트에 반영했습니다.');
  }

  return summary;
}
