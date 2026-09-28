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
  ['offline-traders.test.js', '트레이더스 분리 — 코드 매핑 공유(코드체계채널), 점포별 일별 매출·재고 파일 채널 분리, 옛 합계 파일 차단']
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
