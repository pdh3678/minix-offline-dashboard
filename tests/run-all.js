/* 전체 테스트 실행 — node tests/run-all.js
   각 스위트를 별도 프로세스로 돌린다(전역/모듈 캐시가 서로 섞이지 않게).
   하나라도 실패하면 exit 1. */
const { execFileSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['columns.test.js',    '열 해석 — 2행 헤더로 COL을 찾고, 중복/유사 헤더를 올바르게 가름'],
  ['write-paths.test.js','쓰기 경로 — 등록/수정/실적/팔로워/등급이 올바른 열에 들어감'],
  ['frontend.test.js',   '프론트 — 응답 변환·등급 산정·시트 기록 payload'],
  ['save-path.test.js',  '저장 통합 — 프론트+GAS 실코드로 낙관적 저장 왕복'],
  ['embed.test.js',      '임베드 모드 — 셸 숨김, 쿼리 보존, 프레임 허용 헤더'],
  ['channel-fields.test.js','채널 필드 전파(GAS) — fillEmpty/overwrite, 열 없을 때 안전'],
  ['channel-front.test.js', '채널 필드(프론트) — 불일치 판정, 확인 팝업, 로컬 전파'],
  ['save-flow.test.js',    '저장 흐름 — saveSchemeModal/saveDeal을 끝까지 실행'],
  ['multi-code.test.js',   '다중 상품코드 — 같은 dealId+코드순번 구조, 실적 합산, dealId 통일'],
  ['channel-link.test.js', '인플루언서 링크 — 플랫폼 ID로 자동 생성, 수동 수정 보존'],
  ['id-from-link.test.js','링크 → ID 역추출 + 채널 정보 미입력 목록'],
  ['session-auth.test.js','자체 세션 인증 — 서명 검증, 만료·연장, 도메인 허용/차단'],
  ['product-line.test.js','품목군 — 상수 하나로 사이드바·해시·드롭다운·사은품이 따라오는지'],
  ['relogin.test.js',     '세션 만료 → 재로그인 — 오버레이가 반드시 걷히고 보던 페이지로 복귀'],
  ['table-header.test.js','표 헤더 공용 컴포넌트 — 두 줄 헤더(subLabel)와 아이콘 위치'],
  ['tier-tooltip.test.js', '등급 기준표 툴팁 — 상수에서 파생, 임계값 표기, 표/모달 공유'],
  ['influencer-filter.test.js','인플루언서 검색 — 대시보드와 품목 페이지가 같은 컴포넌트, KPI·표 동시 적용'],
  ['nav-structure.test.js', '사이드바·라우팅 — 메뉴 구조, 접기 저장, 기존 해시 유지 + 신규 해시, 임베드'],
  ['deal-form-prefill.test.js','새 공구건 등록 버튼 — PageHeaderActions, 품목·모델·날짜 미리 채우기, #gongu/new'],
  ['pending-list.test.js',    '미기입 목록 — 판정 그대로, 완료 강조·진행중/예정 흐리게, 상태 칩, 사이드바 배지'],
  ['service-move.test.js',    '서비스 주소 이전 — 옛 주소만 새 주소로(경로·쿼리·해시 보존), 이동 중 부트스트랩 정지'],
  ['offline-setup.test.js',   '오프라인 시트 구조 — 11개 탭·헤더·텍스트 서식, 재실행 안전, 원장 교체 헬퍼'],
  ['offline-resolver.test.js','오프라인 코드 해석 — (채널, 원본코드) 키, 비활성 매핑, 모델명·재고구분·SKU 제안'],
  ['../scripts/test-offline-parsers.js','오프라인 파서 — 5종 판별·헤더 탐색·숫자/날짜/코드 정규화(합성 픽스처)'],
  ['offline-ledger.test.js',  '오프라인 원장 반영 — 기간 교체·스냅샷·하이마트 누적 차이, 재업로드·순서 무관 동일'],
  ['offline-api.test.js',     '오프라인 API — doPost 라우팅·세션, 마스터 캐시, SKU·매핑 저장, 미매칭·로그·상태, 프론트 클라이언트'],
  ['offline-ui.test.js',      '데이터 업로드 화면 — 진입 훅, 파일 카드, 기준일·교체기간 수정, 하이마트 순서, 카드에서 바로 매핑'],
  ['offline-monthly.test.js', '월별 실적 해석(2-A) — 업로드 전후 OUT 원천, 원장 집계·미매칭, 모델 정규화, 단가·달성률·합계'],
  ['offline-targets.test.js', '목표·단가·이관 API(2-A) — 진행현황 파싱·제안·반영(멱등, input 보존)·9월 대조, 납품가 이관, 원본 읽기 전용'],
  ['offline-targets-ui.test.js','목표 관리 화면(2-A) — 월별 입력(원장 읽기 전용·부분 갱신·붙여넣기·전월 복사), 단가, 이관 미리보기→반영'],
  ['offline-inventory.test.js', '재고·판매 지표(2-B) — 정상재고·일평균·재고일수·점포·결품·미매칭, 일별 판매·재고 추이, 설정·단가 삭제·SKU 수정'],
  ['offline-screens-ui.test.js', '오프라인 화면(2-B) — 채널 현황 KPI·카드·매트릭스, 채널 상세 표·일별·점포·CSV, 재고 현황 매트릭스·경보·설정, 메모'],
  ['offline-admin-2b-ui.test.js', '잔여 관리 기능(2-B) — 제품마스터 탭(품목군 변경 확인·비활성화), 단가 삭제, 연간 보기(월 합계 일치·목표만 저장·붙여넣기)'],
  ['offline-traders.test.js', '트레이더스 분리 — 코드 매핑 공유(코드체계채널), 점포별 일별 매출·재고 파일 채널 분리, 옛 합계 파일 차단'],
  ['offline-extra.test.js', '본품 외 대분류(필터·기타) — 새 SKU 만들기(기타 옵션 필수), 매핑 전후 본품 수치 불변, 필터 한 줄·경보, 기타 경보 제외, 구분선 배치, 비본품 표시'],
  ['home-gas.test.js', '파트 홈 GAS — 공구목표_월·채널군, 공구 목표 저장·이관(블록 찾기·병합·대조·멱등·input 보존), home_getSummary(채널군 금액·필터·경보·캐시)'],
  ['offline-stock-date.test.js', '재고 기준일 보정 — 채널마스터 재고기준일오프셋, 업로드 기준일(새 화면·옛 화면 호환·하이마트 그대로), 데이터 현황·지표·추이, offline_fixStockDates 1회(중복 정리·재실행 방지), 업로드 미리보기'],
  ['offline-sales-breakdown.test.js', '채널 상세 판매 분석 — 점포유형 열, 모델별 = 지점별 = OUT 실적 + 필터 + 미매칭, 모델/SKU·대분류·설치완료, 온라인/오프라인, 캐시, 화면·CSV·임베드'],
  ['home-ui.test.js', '파트 홈 화면 — 공구 = 공구 분석 총 매출, 오프라인 = 채널 현황 IN 금액, 오늘 챙길 것 = 각 화면 건수, 일정·오류 격리·임베드 + 목표 관리 공구 목표·연간 보기·이관'],
  ['offline-erp.test.js', 'ERP 매출이익리스트 — 채널·거래처 설정(멱등), 판매원장 금액·수수료, 파서(쓰는 열만·무상 동봉 제외·합산·기간), 반영(거래처 → 채널·ERP 채널 교체·멱등·개인정보 없음), 업로드 미리보기, 코드 매핑 제안, IN실적원천 upload(월별·목표 관리·이관 대조·재고·파트 홈·채널 화면)'],
  ['offline-channel-category.test.js', '채널 대분류 — 채널 현황 묶음·묶음 합계·매트릭스 소계, 채널 대분류 필터(KPI·재고·기준일·경보), 채널 상세 탭 묶음·이동, 재고 현황 머리 묶음, 목표 관리 월별·연간 소계·필터·변경 보호, 업로드 현황·로그·코드 매핑 표시, 파트 홈 펼침 표'],
  ['offline-sheets-api.test.js', 'Sheets API 입출력 — API 경로 = SpreadsheetApp 경로(시트·서식·응답), 조회 batchGet 1번·반영 탭마다 batchUpdate 1번, 끝부분만 쓰기·남는 행 비우기, 날짜 셀·없는 탭 대체, 요청 범위 기억, appsscript.json'],
  ['offline-inbox-parsers.test.js', '수신함 파서 공유 — GAS가 브라우저 파서 파일 그대로, SheetJS 같은 주소·SRI·캐시·변조 거부, samples 브라우저 경로 = GAS 경로(XLSX_PATH 있을 때)'],
  ['offline-inbox.test.js', '수신함 자동 반영 — 수동 업로드와 같은 결과·순서, 처리완료·오류 폴더, 재투입 건너뜀, 회당 최대·시간 예산·락 이월, ERP 개인정보·임시 파일 없음, 공유 드라이브 인자, 권한 부족, 보관일수, Sheets API 분당 상한'],
  ['offline-inbox-ui.test.js', '자동 반영 화면 — 상태 패널(사용·트리거·폴더·마지막 실행·경고·파일별 결과), [지금 확인], 업로드로그 방식 열·수신함처리 사유, HTML 이스케이프'],
  ['review-html-embed.test.js', '회고 HTML 임베드 — review_* 세션·첨부 폴더 제한·5MB/20MB, sandbox allow-scripts만·blob 없음, 높이 메시지 출처 검증, 원문 캐시']
];

let failed = 0;
const results = [];
for (const [file, desc] of SUITES) {
  process.stdout.write('\n═══ ' + file + ' — ' + desc + '\n');
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8' });
    const m = out.match(/통과 (\d+) \/ 실패 (\d+)/);
    results.push([file, m ? Number(m[1]) : 0, m ? Number(m[2]) : 0, true]);
    process.stdout.write(out.split('\n').filter(l => /PASS|FAIL|통과/.test(l)).slice(-1)[0] + '\n');
  } catch (e) {
    failed++;
    const out = (e.stdout || '') + (e.stderr || '');
    process.stdout.write(out);
    const m = out.match(/통과 (\d+) \/ 실패 (\d+)/);
    results.push([file, m ? Number(m[1]) : 0, m ? Number(m[2]) : 1, false]);
  }
}

let tp = 0, tf = 0;
console.log('\n' + '═'.repeat(62));
results.forEach(([file, p, f, ok]) => {
  tp += p; tf += f;
  console.log((ok ? '  OK  ' : ' FAIL ') + file.padEnd(24) + ('통과 ' + p).padStart(8) + ('실패 ' + f).padStart(8));
});
console.log('═'.repeat(62));
console.log('  합계  ' + ('통과 ' + tp).padStart(30) + ('실패 ' + tf).padStart(8));
if (failed) console.log('\n실패한 스위트가 있습니다.');
process.exit(failed ? 1 : 0);
