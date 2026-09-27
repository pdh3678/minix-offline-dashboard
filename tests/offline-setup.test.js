/* 오프라인 스프레드시트 구조 — offline_setupSheets와 시트 입출력 헬퍼.

   지키려는 성질:
     · 11개 탭이 정해진 순서·헤더로 만들어지고, 1행 헤더 고정·굵게, 날짜·코드 열은 텍스트 서식
     · 두 번 실행해도 안전 — 새로 만들지 않고, 데이터(채널 초기값 포함)를 중복시키지 않는다
     · 헤더가 다르면 고치지 않고 보고만 한다
     · OFFLINE_SHEET_ID는 Script Properties에서만 — 없으면 무엇을 넣어야 하는지 알려주며 실패
     · 원장 교체(_offReplaceRows)는 같은 입력이면 같은 결과, 처음 지워지는 행부터만 다시 쓴다
     · 텍스트 열은 문자열 그대로('0012', 13자리 바코드, '2026-09-01')

   실행: node tests/offline-setup.test.js  (또는 node tests/run-all.js) */
const fs = require('fs'), path = require('path');
const { loadOfflineGas, dataRows, PROJ } = require(path.join(__dirname, 'lib', 'offline-gas.js'));

let pass = 0, fail = 0;
function check(l, c, extra) {
  if (c) { pass++; console.log('  PASS  ' + l); }
  else { fail++; console.log('  FAIL  ' + l + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

const EXPECT = [
  ['README', ['탭', '설명']],
  ['제품마스터', ['sku_id', '표준명', '품목군', '모델', '옵션', '활성', '정렬순서', '비고']],
  ['채널마스터', ['channel_id', '채널명', '유형', '활성', '정렬순서', '업로드시작월']],
  ['코드매핑', ['channel_id', '원본코드', 'sku_id', '재고구분', '원본상품명', '등록일', '등록자', '비고']],
  ['점포마스터', ['channel_id', '점포코드', '점포명', '지역', '최초등록일', '최근확인일']],
  ['판매원장', ['기간시작', '기간종료', '단위', 'channel_id', '점포코드', '원본코드', '수량', '설치완료수량', '출처', 'upload_id']],
  ['재고_채널일별', ['기준일', 'channel_id', '원본코드', '재고수량', '이동중수량', '예약수량', 'upload_id']],
  ['재고_점포최신', ['기준일', 'channel_id', '점포코드', '원본코드', '재고수량', '이동중수량', '예약수량', '당월입고', '당월판매', 'upload_id']],
  ['하이마트_누적스냅샷', ['기준일', '점포코드', '원본코드', '당월실판매', '당월판매', '금주판매', '당일판매', '잔여재고', 'upload_id']],
  ['업로드로그', ['upload_id', '업로드시각', '업로더', '파일명', '파일유형', 'channel_id', '기준일/기간', '원본행수', '반영행수', '미매칭코드수', '경고', '상태']],
  ['미매칭코드', ['channel_id', '원본코드', '원본상품명', '최초발견일', '최근발견일', '발견횟수']],
  ['목표실적_월', ['연월', 'channel_id', '품목군', '모델', '구분', '목표수량', '실적수량', '출처', '수정일', '수정자', '비고']],
  ['단가마스터', ['channel_id', '품목군', '모델', '공급가', '적용시작일', '비고', '수정일', '수정자']],
  ['이관로그', ['실행시각', '실행자', '대상', '월 범위', '반영 행수', '미매핑 항목', '상태']]
];
// 텍스트 서식이어야 하는 열(날짜·코드·id) — 숫자 열은 절대 텍스트가 되면 안 된다(합계가 깨짐)
const NUMERIC = {
  '제품마스터': ['정렬순서'], '채널마스터': ['정렬순서'], '판매원장': ['수량', '설치완료수량'],
  '재고_채널일별': ['재고수량', '이동중수량', '예약수량'],
  '재고_점포최신': ['재고수량', '이동중수량', '예약수량', '당월입고', '당월판매'],
  '하이마트_누적스냅샷': ['당월실판매', '당월판매', '금주판매', '당일판매', '잔여재고'],
  '업로드로그': ['원본행수', '반영행수', '미매칭코드수'], '미매칭코드': ['발견횟수'],
  '목표실적_월': ['목표수량', '실적수량'], '단가마스터': ['공급가'], '이관로그': ['반영 행수']
};
function textColsFromFormats(sheet) {
  const cols = new Set();
  sheet._formats.filter(f => f.r === 1 && f.f === '@').forEach(f => { for (let c = f.c; c < f.c + f.nc; c++) cols.add(c); });
  return cols;
}

(function main() {
  console.log('\n[1] 빈 스프레드시트에서 실행 — 14개 탭 생성');
  {
    const { ctx, off, tab } = loadOfflineGas();
    const rep = ctx.offline_setupSheets();
    check('14개 탭을 만들었다고 보고', rep.created.length === 14 && rep.verified.length === 0 && rep.extended.length === 0 && rep.mismatched.length === 0, rep);
    check('탭 순서 = README → 이관로그', JSON.stringify(off._order) === JSON.stringify(EXPECT.map(e => e[0])), off._order);
    EXPECT.forEach(([name, headers]) => {
      const sh = tab(name);
      check(name + ' 헤더', JSON.stringify(sh._grid[0].slice(0, headers.length)) === JSON.stringify(headers), sh._grid[0]);
      const text = textColsFromFormats(sh);
      const numeric = NUMERIC[name] || [];
      const wantText = headers.map((h, i) => i + 1).filter(c => numeric.indexOf(headers[c - 1]) < 0);
      check(name + ' 날짜·코드 열 텍스트 서식, 숫자 열은 아님',
        wantText.every(c => text.has(c)) && numeric.every(h => !text.has(headers.indexOf(h) + 1)),
        { text: [...text], numeric });
    });
    const ch = dataRows(tab('채널마스터'));
    check('채널마스터 초기 데이터 7행', ch.length === 7, ch);
    check('  ↳ 하이마트·전자랜드·이마트만 활성', ch.filter(r => r[3] === 'Y').map(r => r[0]).join(',') === 'himart,etland,emart', ch.map(r => r[0] + r[3]));
    check('  ↳ 값이 명세 그대로(업로드시작월: 하이마트·전자랜드·이마트 2026-09, 나머지 빈칸)', JSON.stringify(ch.map(r => r.slice(0, 4).concat([r[5]]))) === JSON.stringify([
      ['himart', '하이마트', '전문점', 'Y', '2026-09'], ['etland', '전자랜드', '전문점', 'Y', '2026-09'], ['emart', '이마트', '할인점', 'Y', '2026-09'],
      ['traders', '트레이더스', '창고형', 'N', ''], ['shinsegae', '신세계', '백화점', 'N', ''], ['theablen', '디에이블앤', '폐쇄몰', 'N', ''],
      ['special', '기타 특판', '특판', 'N', '']]), ch);
    const readme = dataRows(tab('README'));
    check('README에 "직접 수정 금지" 안내', readme.some(r => /직접 수정 금지/.test(r[0]) && /대시보드/.test(r[1])), readme[0]);
    check('README가 원장 탭을 전부 설명', EXPECT.slice(1).every(([n]) => readme.some(r => r[0] === n)));
    check('원장·마스터 탭은 비어 있음(초기 데이터 없음)', ['제품마스터', '코드매핑', '판매원장', '재고_채널일별', '미매칭코드', '목표실적_월', '단가마스터', '이관로그'].every(n => tab(n).getLastRow() === 1));

    console.log('\n[2] 두 번째 실행 — 만들지 않고 헤더만 확인, 데이터 불변');
    const before = JSON.stringify(off.getSheets().map(s => s._grid));
    const rep2 = ctx.offline_setupSheets();
    check('새로 만든 탭 없음, 14개 모두 확인', rep2.created.length === 0 && rep2.verified.length === 14, rep2);
    check('시트 내용이 그대로(채널 초기값 중복 없음)', JSON.stringify(off.getSheets().map(s => s._grid)) === before);

    console.log('\n[3] 헤더가 바뀐 탭 — 고치지 않고 보고만');
    tab('판매원장')._grid[0][6] = '판매수량';
    const rep3 = ctx.offline_setupSheets();
    check('판매원장 불일치 보고', rep3.mismatched.length === 1 && rep3.mismatched[0].tab === '판매원장' && rep3.mismatched[0].actual[6] === '판매수량', rep3.mismatched);
    check('  ↳ 헤더를 덮어쓰지 않음', tab('판매원장')._grid[0][6] === '판매수량');
  }

  console.log('\n[4] 채널마스터 탭만 먼저 있고 비어 있으면 초기 데이터를 채운다');
  {
    const { ctx, off, tab } = loadOfflineGas();
    const sh = off.insertSheet('채널마스터');
    sh.getRange(1, 1, 1, 5).setValues([['channel_id', '채널명', '유형', '활성', '정렬순서']]);
    const rep = ctx.offline_setupSheets();
    check('채널마스터는 열 확장, 나머지 13개 생성', rep.extended.length === 1 && rep.extended[0].tab === '채널마스터' && rep.created.length === 13, rep);
    check('초기 데이터 7행(업로드시작월 포함)', dataRows(tab('채널마스터')).length === 7 && dataRows(tab('채널마스터'))[0][5] === '2026-09');
  }

  console.log('\n[5] OFFLINE_SHEET_ID가 없으면 무엇을 넣을지 알려주며 실패');
  {
    const { ctx } = loadOfflineGas({ noSheetId: true });
    let err = null;
    try { ctx.offline_setupSheets(); } catch (e) { err = e; }
    check('Script Properties 키 이름을 담은 에러', err && /OFFLINE_SHEET_ID/.test(err.message), err && err.message);
    const src = fs.readFileSync(path.join(PROJ, 'apps-script-offline.js'), 'utf8');
    check('스프레드시트 ID를 코드에 하드코딩하지 않음', src.indexOf('1fmXUQpLZQgsYIfmKC5d') < 0 && !/openById\(\s*['"]/.test(src));
  }

  console.log('\n[6] 텍스트 열 쓰기 — 코드·날짜가 문자열 그대로');
  {
    const { ctx, tab } = loadOfflineGas({ setup: true });
    const def = ctx.OFF_TABS.store, sh = tab('점포마스터');
    ctx._offWriteBlock(sh, def, 2, [['emart', '0012', 'EM창동점', '', '2026-09-01', '2026-09-27'], ['emart', 8809770080951, 'X', '', '2026-09-01', '2026-09-01']]);
    const rows = dataRows(sh);
    check("'0012' 그대로", rows[0][1] === '0012', rows[0]);
    check('숫자로 온 13자리 코드도 문자열로', rows[1][1] === '8809770080951', rows[1]);
    check("날짜 '2026-09-01' 문자열", rows[0][4] === '2026-09-01' && typeof rows[0][4] === 'string');
    check('쓴 범위에 텍스트 서식을 먼저 걸었다', sh._formats.some(f => f.r === 2 && f.c === 1 && f.nc === 6 && f.f === '@'), sh._formats.slice(-2));
    const back = ctx._offReadRows(sh, def);
    check('다시 읽어도 문자열', back[0][1] === '0012' && back[1][1] === '8809770080951', back);
  }

  console.log('\n[7] 원장 교체 헬퍼 — 멱등, 처음 지워지는 행부터만 다시 쓴다');
  {
    const { ctx, tab } = loadOfflineGas({ setup: true });
    const def = ctx.OFF_TABS.stockDaily, sh = tab('재고_채널일별');
    const row = (d, ch, code, q) => [d, ch, code, q, '', '', 'U1'];
    const base = [];
    for (let i = 1; i <= 20; i++) base.push(row('2026-09-' + String(i).padStart(2, '0'), 'emart', 'A', i));
    ctx._offWriteBlock(sh, def, 2, base);
    const keep = r => !(r[0] === '2026-09-19' && r[1] === 'emart');
    const add = [row('2026-09-19', 'emart', 'A', 190), row('2026-09-19', 'emart', 'B', 5)];
    sh._calls.length = 0;
    const res = ctx._offReplaceRows(sh, def, ctx._offReadRows(sh, def), keep, add);
    const writes = sh._calls.filter(c => c.op === 'setValues');
    check('지운 1행·추가 2행 보고', res.removed === 1 && res.added === 2, res);
    check('19일 행(20행)부터만 다시 씀', writes.length === 1 && writes[0].r === 20 && writes[0].nr === 3, writes);
    const once = JSON.stringify(dataRows(sh));
    ctx._offReplaceRows(sh, def, ctx._offReadRows(sh, def), keep, add);
    check('같은 교체를 한 번 더 해도 결과가 같다', JSON.stringify(dataRows(sh)) === once);
    check('나머지 행은 순서 그대로', dataRows(sh).slice(0, 18).map(r => r[3]).join() === '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18');
    // 줄어드는 교체 — 남는 뒤쪽 행은 비워서 getLastRow가 줄어야 한다
    ctx._offReplaceRows(sh, def, ctx._offReadRows(sh, def), r => r[0] < '2026-09-10', []);
    check('줄어들면 뒤쪽을 비운다(9행 남음)', sh.getLastRow() === 10 && dataRows(sh).length === 9, sh.getLastRow());
    sh._calls.length = 0;
    ctx._offReplaceRows(sh, def, ctx._offReadRows(sh, def), () => true, []);
    check('바뀌는 게 없으면 쓰지 않는다', sh._calls.filter(c => c.op === 'setValues' || c.op === 'clearContent').length === 0, sh._calls);
  }

  console.log('\n[9] 1단계 시트에 2-A 실행 — 채널마스터에 업로드시작월 열만 덧붙이고 기존 값은 그대로');
  {
    const { ctx, off, tab } = loadOfflineGas({ setup: true });
    // 1단계 모양으로 되돌린다: 채널마스터 5열 + 사람이 고친 값, 2-A 탭 없음, README는 11행
    const ch = tab('채널마스터');
    ch._grid.forEach(row => { row.length = 5; });
    ch._grid[4][3] = 'Y'; // 사람이 트레이더스를 활성으로 바꿔 둔 상태
    ['목표실적_월', '단가마스터', '이관로그'].forEach(n => { delete off._sheets[n]; off._order.splice(off._order.indexOf(n), 1); });
    tab('README')._grid.length = 12;
    const rep = ctx.offline_setupSheets();
    check('채널마스터 확장 보고(업로드시작월 추가)', rep.extended.length === 1 && JSON.stringify(rep.extended[0].added) === '["업로드시작월"]', rep.extended);
    check('2-A 탭 3개 생성', JSON.stringify(rep.created) === JSON.stringify(['목표실적_월', '단가마스터', '이관로그']), rep.created);
    check('헤더가 다른 탭 없음', rep.mismatched.length === 0, rep.mismatched);
    const rows = dataRows(ch);
    check('업로드시작월 초기값: himart·etland·emart = 2026-09, 나머지 빈칸', rows.map(r => r[0] + '=' + r[5]).join() === 'himart=2026-09,etland=2026-09,emart=2026-09,traders=,shinsegae=,theablen=,special=', rows.map(r => r[5]));
    check('기존 값(사람이 바꾼 활성)은 그대로', rows[3][3] === 'Y' && rows[3][0] === 'traders');
    check('새 열은 텍스트 서식', ch._formats.some(f => f.r === 1 && f.c === 6 && f.f === '@'));
    check('README에 새 탭 설명이 추가됨', ['목표실적_월', '단가마스터', '이관로그'].every(n => dataRows(tab('README')).some(r => r[0] === n)));
    ch._grid[1][5] = ''; // 사람이 하이마트 업로드시작월을 비움
    const rep2 = ctx.offline_setupSheets();
    check('다시 실행하면 확장 없이 확인만', rep2.extended.length === 0 && rep2.verified.length === 14, rep2);
    check('  ↳ 사람이 비운 업로드시작월을 다시 채우지 않음', dataRows(ch)[0][5] === '');
  }

  console.log('\n[8] 날짜 산술 — 타임존 영향 없음');
  {
    const { ctx } = loadOfflineGas();
    check('월말 +1 = 다음 달 1일', ctx._offAddDays('2026-09-30', 1) === '2026-10-01');
    check('연말 +1', ctx._offAddDays('2026-12-31', 1) === '2027-01-01');
    check('윤년 2/28 +1', ctx._offAddDays('2028-02-28', 1) === '2028-02-29');
    check('-45일', ctx._offAddDays('2026-09-27', -45) === '2026-08-13');
  }

  console.log('\n' + '─'.repeat(50));
  console.log('통과 ' + pass + ' / 실패 ' + fail);
  process.exit(fail ? 1 : 0);
})();
