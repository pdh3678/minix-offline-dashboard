/* 운영 응답 시간 측정 — 로그인된 대시보드 탭의 개발자 도구 콘솔에 통째로 붙여넣는다(node로 실행하지 않는다. 테스트도 아니다).
   Sheets API 전환(2026-10-02) 전후 비교용. 같은 스니펫을 GAS "새 버전" 배포 전에 한 번, 배포 후에 한 번 돌린다.

   한 회차 = ① offline_upload(고른 파일을 다시 반영) → ② 조회 5종. 반영이 오프라인 캐시 세대를 바꾸므로 ②는 전부 시트를 다시 읽는다
   (응답의 cached로 확인 — 캐시 히트가 섞이면 표에 보인다). ROUNDS회 반복해 평균을 낸다.
     ② home_getSummary(9월) → offline_getMonthly(하이마트 1~12월) → offline_getInventory(하이마트) → offline_getSalesBreakdown(하이마트 9월)
        → 공구 분석 데이터 조회(GET, nocache=1 — 서버 캐시 건너뜀)
   파일은 운영에 이미 반영한 "같은 파일"(이마트 '기간별매출(상품별)_일별상세' 한 달분)이어야 한다 — 기간 교체형이라 같은 파일을 다시
   넣으면 원장은 그대로다(멱등: 회차마다 지운 행 = 넣은 행인지 표에 나온다). 업로드로그에서 그 기간을 덮은 더 최근 업로드가 있으면 멈춘다
   (옛 파일로 새 데이터를 덮지 않게). 남는 흔적: 업로드로그 ROUNDS행, 그 파일 미매칭 코드의 발견횟수 +ROUNDS.
   지문 = 조회 응답의 SHA-256 앞 12자리(실행 시간·버전·캐시 여부·세션 토큰·updatedAt은 빼고) — 배포 전후로 같으면 결과가 같다
   (그 사이 누가 업로드·저장했으면 달라진다).
   결과: 콘솔 표 두 개(회차별 · 액션별 평균·지문) + window.__latency */
(async () => {
  const ROUNDS = 3, YM = '2026-09', CH = 'himart';
  const file = await new Promise(resolve => {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:99999;top:16px;right:16px;padding:14px 16px;background:#fff;color:#111;border:2px solid #111;border-radius:10px;font:14px/1.5 sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25)';
    box.innerHTML = '<b>응답 시간 측정</b><br>운영에 이미 반영한 이마트 일별상세 파일을 고르세요<br><input type="file" accept=".xlsx,.xls,.csv" style="margin-top:8px">';
    box.querySelector('input').onchange = e => { box.remove(); resolve(e.target.files[0]); };
    document.body.appendChild(box);
  });
  const XLSX = await _loadSheetJS();
  const rows = OfflineParsers.dropUnusedColumns(OfflineParsers.readWorkbookRows(XLSX, new Uint8Array(await file.arrayBuffer())).rows);
  const masters = await _offlineCall('offline_getMasters');
  const offsets = {};
  (masters.channels || []).forEach(c => { if (c.stockOffset) offsets[c.channelId] = c.stockOffset; });
  const parsed = OfflineParsers.parseRows(rows, { fileName: file.name, today: _upTodayStr(), stockOffsets: offsets });
  if (!parsed.ok || parsed.blocked) throw new Error('파일을 반영할 수 없습니다: ' + (parsed.error || parsed.type));
  const payload = OfflineParsers.toUploadPayload(parsed, { fileName: file.name });
  // 같은 파일이 이미 반영돼 있고, 그 뒤에 같은 기간을 덮은 다른 업로드가 없어야 한다
  const log = (await _offlineCall('offline_getUploadLog')).items.filter(x => x.status === '성공');
  const range = payload.meta.replaceStart + '~' + payload.meta.replaceEnd;
  const overlap = x => { const p = String(x.range).split('~'); return x.fileType === parsed.type && p[0] <= payload.meta.replaceEnd && (p[1] || p[0]) >= payload.meta.replaceStart; };
  const latest = log.filter(overlap)[0]; // 최근 50건, 최신이 먼저
  if (!latest || latest.fileName !== file.name) {
    throw new Error('멈춤 — ' + range + '을(를) 마지막으로 덮은 업로드가 이 파일이 아닙니다: ' + (latest ? latest.fileName + ' (' + latest.at + ')' : '없음') + '. 그 파일로 다시 실행하세요.');
  }
  console.log('[측정] 파일 ' + file.name + ' · 교체 기간 ' + range + ' · 마지막 반영 ' + latest.at + ' · ' + ROUNDS + '회');
  const y = YM.slice(0, 4);
  const reads = [
    ['home_getSummary', () => _offlineCall('home_getSummary', { ym: YM, mode: 'month' })],
    ['offline_getMonthly', () => _offlineCall('offline_getMonthly', { from: y + '-01', to: y + '-12', channelId: CH })],
    ['offline_getInventory', () => _offlineCall('offline_getInventory', { channelId: CH })],
    ['offline_getSalesBreakdown', () => _offlineCall('offline_getSalesBreakdown', { channelId: CH, from: YM, to: YM })],
    ['공구 분석 데이터 조회', () => _gasFetch(_gasUrl(_getGasUrl()) + '&nocache=1', {})]
  ];
  const digest = async j => {
    const c = Object.assign({}, j);
    ['execMs', 'version', 'cached', 'sessionToken', 'updatedAt'].forEach(k => { delete c[k]; });
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(c)));
    return Array.from(new Uint8Array(buf)).slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
  };
  const timed = async (round, name, fn) => {
    const t = performance.now();
    let j, err = '';
    try { j = await fn(); } catch (e) { err = String(e.message || e); }
    const row = { 회차: round, 액션: name, 왕복ms: Math.round(performance.now() - t), 서버ms: j ? j.execMs : null, 캐시: !!(j && j.cached), 버전: j ? j.version : '', 오류: err || (j && j.error) || '' };
    if (name === 'offline_upload' && j && j.applied) row.멱등 = '지운 ' + j.applied.salesRemoved + ' / 넣은 ' + j.applied.sales;
    else if (j && !row.오류) row.지문 = await digest(j);
    return row;
  };
  const out = [];
  for (let r = 1; r <= ROUNDS; r++) {
    out.push(await timed(r, 'offline_upload', () => _offlineCall('offline_upload', payload)));
    for (const [name, fn] of reads) out.push(await timed(r, name, fn));
  }
  console.table(out);
  const avg = {};
  out.forEach(x => {
    const a = avg[x.액션] || (avg[x.액션] = { 액션: x.액션, n: 0, 왕복: 0, 서버: 0, 캐시히트: 0, 지문: [] });
    a.n++; a.왕복 += x.왕복ms; a.서버 += x.서버ms || 0; if (x.캐시) a.캐시히트++;
    if (x.지문 && a.지문.indexOf(x.지문) < 0) a.지문.push(x.지문);
  });
  const summary = Object.values(avg).map(a => ({ 액션: a.액션, '왕복 평균ms': Math.round(a.왕복 / a.n), '서버 평균ms': Math.round(a.서버 / a.n), 캐시히트: a.캐시히트 + '/' + a.n, 지문: a.지문.join(' · ') }));
  console.table(summary);
  console.log('[측정] 서버 버전 ' + out[0].버전 + ' · 멱등 ' + out.filter(x => x.멱등).map(x => x.멱등).join(' · '));
  window.__latency = { file: file.name, range, version: out[0].버전, rows: out, summary };
})().catch(e => console.error('[측정 실패]', e));
