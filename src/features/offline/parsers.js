'use strict';
/* 협력사 포털 엑셀 판별·파싱 — 순수 함수. 브라우저에서는 전역 OfflineParsers, node에서는 require().
   GAS(드라이브 수신함 자동 반영)도 이 파일을 **그대로** 편집기 파일 "offline_parsers"로 붙여넣어 쓴다(전역 OfflineParsers) —
   수동 업로드와 자동 반영이 같은 파서를 써야 결과가 같다. 그래서 브라우저·GAS 어느 쪽 전용 API(window·document·TextDecoder·Buffer 필수)도
   쓰지 않는다(Buffer는 있을 때만). 고친 뒤에는 GAS에도 다시 붙여넣을 것 — tests/offline-inbox-parsers.test.js가 두 경로 결과를 비교한다.
   흐름: 파일 → readWorkbookRows(XLSX, 바이트) → 2차원 배열 → parseRows(rows, opts) → 정규화 레코드
         → toUploadPayload(결과, 미리보기에서 고친 값) → offline_upload

   지키는 것
   · 헤더 행은 상위 15행 안에서 유형별 시그니처 헤더 조합으로 찾는다(전자랜드: 1행 제목 + 2행 헤더,
     이마트 재고: 상단 요약 블록 뒤 5행 헤더). 열도 위치가 아니라 헤더 이름으로 찾고, 모르는 열은 무시.
   · 헤더 비교는 공백을 무시한다('상품 코드' = '상품코드', '타지점입고 예정수량' = '타지점입고예정수량').
   · 숫자: 쉼표 제거, 텍스트 숫자('1.000') 처리, 빈칸 = 0, 음수(반품) 허용.
   · 날짜는 전부 'YYYY-MM-DD' 문자열. 코드·점포코드는 문자열(13자리 바코드·앞자리 0 보존). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OfflineParsers = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const HEADER_SCAN_ROWS = 15;

  /* 유형 정의. sig = 판별 시그니처(한 행에 전부 있어야 그 유형), cols = 파싱에 필요한 열(논리명 → 헤더).
     판별 순서가 곧 우선순위다 — 더 구체적인 시그니처를 앞에 둔다. */
  const TYPES = {
    HIMART_SALES_STOCK: {
      label: '하이마트 판매재고현황', channelId: 'himart', kind: 'himart',
      sig: ['인도처코드', '상품코드', '당월실판매', '당월판매', '당일판매', '잔여재고'],
      cols: { branch: '지사명', store: '인도처코드', storeName: '인도처명', code: '상품코드', name: '상품명',
        real: '당월실판매', sale: '당월판매', week: '금주판매', day: '당일판매', stock: '잔여재고' }
    },
    ETLAND_SALES: {
      label: '전자랜드 판매내역', channelId: 'etland', kind: 'period',
      sig: ['지점코드', '모델명', '판매수량', '판매일자'],
      cols: { region: '지부', store: '지점코드', storeName: '지점명', code: '모델명', name: '설명',
        qty: '판매수량', date: '판매일자', gubun: '구분' }
    },
    ETLAND_STOCK: {
      label: '전자랜드 현재고', channelId: 'etland', kind: 'snapshot',
      sig: ['입고지점코드', '모델명', '재고수량', '타지점입고예정수량'],
      cols: { region: '지부', store: '입고지점코드', storeName: '입고지점', code: '모델명', name: '설명',
        stock: '재고수량', transit: '타지점입고예정수량', reserved: '판매예약수량' }
    },
    // 이마트·트레이더스 점포가 한 파일 — split 'store': GAS가 점포(점포마스터 → 점포명접두어)로 채널을 나눈다
    EMART_STOCK: {
      label: '이마트 점포 재고', channelId: 'emart', kind: 'snapshot', split: 'store',
      sig: ['조회일자', '점포코드', '상품코드', '현재수량'],
      cols: { ym: '조회일자', storeName: '점포명', store: '점포코드', name: '상품명', stock: '현재수량',
        monthIn: '매입량', code: '상품코드', monthSale: '매출량' }
    },
    /* 이마트 포털 '기간별매출(상품별)_일별상세' — 업태명(이마트·트레이더스) × 점포 × 상품 × 날짜 열.
       split: 'biz' — 한 파일에 여러 채널이 섞여 있어 레코드마다 업태명을 싣고, GAS가 채널마스터 원천업태명으로 채널을 정한다 */
    EMART_DAILY_SALES_STORE: {
      label: '이마트 점포별 일별 매출', channelId: 'emart', kind: 'period', split: 'biz',
      sig: ['업태명', '점포코드', '상품코드', '상품명'], needDateCols: true,
      cols: { biz: '업태명', store: '점포코드', storeName: '점포명', code: '상품코드', name: '상품명' }
    },
    /* ERP '백화점, 폐쇄몰, 렌탈 매출이익리스트' — 2줄 헤더(1행 그룹명, 2행 열 이름). 우리 창고에서 고객에게 직접 출고한 기록.
       channelId는 채널이 아니라 코드체계(erp) — split 'customer': 레코드의 거래처코드(점포코드 자리)로 GAS가 거래처매핑에서 채널을 정한다.
       onlyUsedCols — 주문자·수취인·연락처·주소·송장번호 열이 있는 파일이라 읽자마자 cols 열만 남긴다(dropUnusedColumns) */
    ERP_SALES_PROFIT: {
      label: 'ERP 매출이익리스트(백화점·폐쇄몰·렌탈)', channelId: 'erp', kind: 'period', split: 'customer', onlyUsedCols: true,
      sig: ['날짜', '거래처코드', '거래처명', '상품코드', '카테고리', '수불구분', '수량', '금액', '수수료'],
      cols: { date: '날짜', cust: '거래처코드', custName: '거래처명', brand: '브랜드', code: '상품코드', name: '기본상품명',
        cat: '카테고리', gubun: '수불구분', qty: '수량', amt: '금액', fee: '수수료' }
    },
    // 트레이더스가 합쳐진 SKU별 합계 파일 — 판별은 하되 반영하지 않는다(blocked). 점포별 일별 매출을 쓴다
    EMART_DAILY_SALES: {
      label: '이마트 일별 매출(합계)', channelId: 'emart', kind: 'period',
      blocked: "트레이더스가 합쳐진 합계 파일이라 반영할 수 없습니다. '기간별매출(상품별)_일별상세' 파일을 사용하세요",
      sig: ['상품코드', '상품명'], needDateCols: true,
      cols: { code: '상품코드', name: '상품명' }
    }
  };
  // 점포별 일별 매출(업태명·점포코드 포함)도 일별 매출(합계)의 시그니처를 만족하므로 반드시 그보다 앞에 둔다
  const TYPE_ORDER = ['HIMART_SALES_STOCK', 'ETLAND_SALES', 'ETLAND_STOCK', 'EMART_STOCK', 'EMART_DAILY_SALES_STORE', 'ERP_SALES_PROFIT', 'EMART_DAILY_SALES'];
  const OPTIONAL_COLS = { gubun: true, ym: true, region: true, branch: true, reserved: true, week: true };

  // ── 값 정규화 ──
  const normHeader = h => String(h == null ? '' : h).replace(/\s+/g, '');
  const pad2 = n => (n < 10 ? '0' : '') + n;
  function validYmd(y, m, d) {
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }
  const ymd = (y, m, d) => y + '-' + pad2(m) + '-' + pad2(d);
  // 'YYYY-MM-DD' + n일(음수 가능, 월말·연말 넘김 포함)
  function addDays(s, n) {
    const t = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10) + n));
    return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }

  function toNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const s = String(v == null ? '' : v).replace(/[,\s]/g, '');
    if (!s || s === '-') return 0;
    const n = Number(s);
    return isFinite(n) ? n : NaN; // 숫자가 아닌 글자 — 호출부가 세어서 경고한다
  }
  function toCode(v) {
    if (v == null) return '';
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    return String(v).trim();
  }
  // 셀 값 → 'YYYY-MM-DD' | null. 엑셀 날짜 일련번호, 'YYYY-MM-DD' / 'YYYY.MM.DD' / 'YYYYMMDD' 문자열
  function toDate(v) {
    if (typeof v === 'number') {
      if (v < 20000 || v > 80000) return null; // 1954~2119 범위만 날짜 일련번호로 본다
      const t = new Date(Math.round((Math.floor(v) - 25569) * 86400000)); // 25569 = 1970-01-01
      return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    }
    if (v instanceof Date && !isNaN(v.getTime())) return ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
    const s = String(v == null ? '' : v).trim();
    const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(s) || /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    return validYmd(y, mo, d) ? ymd(y, mo, d) : null;
  }
  /* 파일명의 기준일
     · 날짜+시각 14자리(YYYYMMDDhhmmss — 이마트 '재고현황_상세_20260928101559')는 앞 8자리
     · 그 외 YYYYMMDD / YYYY-MM-DD / YYYY_MM_DD (구분자는 한 가지로 일관돼야 함, 전자랜드 'YYYY-MM-DD_hhmmss' 포함) */
  function dateFromFileName(name) {
    const s = String(name || '');
    const dt = /(?:^|\D)(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])([01]\d|2[0-3])([0-5]\d)([0-5]\d)(?!\d)/.exec(s);
    if (dt && validYmd(+dt[1], +dt[2], +dt[3])) return ymd(+dt[1], +dt[2], +dt[3]);
    const re = /(?:^|\D)(20\d{2})([-_.]?)(0[1-9]|1[0-2])\2(0[1-9]|[12]\d|3[01])/g;
    let m;
    while ((m = re.exec(String(name || ''))) !== null) {
      if (validYmd(+m[1], +m[3], +m[4])) return ymd(+m[1], +m[3], +m[4]);
      re.lastIndex = m.index + 1;
    }
    return '';
  }

  /* 파일명의 기간 — 날짜가 둘 이상이면 처음 두 개를 시작~끝으로(ERP 'YYYY-MM-DD~YYYY-MM-DD', '_YYYYMMDD_YYYYMMDD_').
     둘 다 올바른 날짜이고 시작 ≤ 끝일 때만 → { start, end } | null */
  function periodFromFileName(name) {
    const re = /(?:^|\D)(20\d{2})([-_.]?)(0[1-9]|1[0-2])\2(0[1-9]|[12]\d|3[01])(?!\d)/g, found = [];
    let m;
    while ((m = re.exec(String(name || ''))) !== null && found.length < 2) {
      if (validYmd(+m[1], +m[3], +m[4])) found.push(ymd(+m[1], +m[3], +m[4]));
      re.lastIndex = m.index + 1;
    }
    return found.length === 2 && found[0] <= found[1] ? { start: found[0], end: found[1] } : null;
  }
  // ERP 거래처명 → 점포명 기본값: 법인 표기((주)·㈜·주식회사·(유)·유한회사)와 옛 이름('(구 : …)')을 뺀다. 거래처매핑에 있는 거래처는 그 이름을 쓴다
  function cleanCustomerName(s) {
    return String(s == null ? '' : s).replace(/\(주\)|㈜|주식회사|\(유\)|유한회사/g, '').replace(/\(\s*구\s*[:：][^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  }

  // 이마트 일별 매출의 날짜 열 헤더('9월 1일') → {m, d} | null
  function monthDayHeader(h) {
    const m = /^(\d{1,2})월(\d{1,2})일$/.exec(normHeader(h));
    return m ? { m: +m[1], d: +m[2] } : null;
  }

  // ── 판별 ──
  function headerIndex(row) {
    const idx = {};
    (row || []).forEach((h, i) => { const k = normHeader(h); if (k && !(k in idx)) idx[k] = i; });
    return idx;
  }
  function rowMatches(type, row) {
    const t = TYPES[type], idx = headerIndex(row);
    if (!t.sig.every(h => h in idx)) return false;
    if (t.needDateCols && !(row || []).some(h => monthDayHeader(h))) return false;
    return true;
  }
  const isBlankCell = v => v === '' || v == null || (typeof v === 'string' && !v.trim());
  /* 2줄 헤더(병합 셀) — 열마다 아래 행 값, 비어 있으면 윗행 값. ERP 매출이익리스트(2026-10)는 L1:L2·AP1:AP2(수불구분)·AQ1:AQ2(수량)처럼
     세로로 병합된 열 이름이 1행에만 있고 2행은 비어 있다(병합 셀 값은 좌상단 칸에만 있다) */
  function mergedHeader(upper, lower) {
    const n = Math.max((upper || []).length, (lower || []).length), out = [];
    for (let i = 0; i < n; i++) out.push(isBlankCell((lower || [])[i]) ? ((upper || [])[i] == null ? '' : upper[i]) : lower[i]);
    return out;
  }
  /* 상위 15행에서 시그니처가 맞는 첫 헤더 → { type, headerIndex(0-based, 헤더의 마지막 행), header(열 이름 배열) } | null.
     행마다 그 행 하나로 먼저 맞춰 보고, 안 맞으면 바로 윗행과 합친 2줄 헤더로 맞춰 본다. type을 주면 그 유형만.
     파싱·개인정보 열 차단도 이 header를 그대로 쓴다(판별과 파싱이 같은 헤더) */
  function detect(rows, onlyType) {
    const n = Math.min(HEADER_SCAN_ROWS, (rows || []).length);
    const types = onlyType ? (TYPES[onlyType] ? [onlyType] : []) : TYPE_ORDER;
    for (let r = 0; r < n; r++) {
      for (const type of types) if (rowMatches(type, rows[r])) return { type, headerIndex: r, header: (rows[r] || []).slice(), twoLine: false };
      if (!r) continue;
      const merged = mergedHeader(rows[r - 1], rows[r]);
      for (const type of types) if (rowMatches(type, merged)) return { type, headerIndex: r, header: merged, twoLine: true };
    }
    return null;
  }
  // 행 길이 맞추기 — 모든 행을 가장 긴 행 길이로('' 채움). 끝 빈칸을 잘라 주는 읽기(구글 Sheets API 등)와 SheetJS(defval '')가 같은 모양이 되게
  function padRows(rows) {
    const w = (rows || []).reduce((m, r) => Math.max(m, (r || []).length), 0);
    return (rows || []).map(r => { const o = (r || []).slice(); while (o.length < w) o.push(''); return o; });
  }

  const isBlankRow = r => !r || r.every(v => v === '' || v == null);

  // ── 파싱 ──
  /* opts: { fileName, type(판별 무시하고 이 유형으로), baseDate(스냅샷형 기준일 직접 지정),
             year(이마트 일별 매출 연도 직접 지정), today('YYYY-MM-DD', 연도 추정 기준),
             stockOffsets({channel_id: 일} — 채널마스터 재고기준일오프셋) }
     반환: { ok, error?, type, typeLabel, channelId, kind, headerRow(1-based), rawRowCount, fileDate,
             baseDate, baseDateChosen(직접 고른 기준일), needsDate, stockOffset, period{start,end}, year, records, summary, plannedRows, warnings }
     재고 기준일 = 파일명 날짜 + 그 파일 채널의 재고기준일오프셋 — 스냅샷형(전자랜드 현재고·이마트 재고현황_상세)만.
       전자랜드·이마트 재고 파일은 받은 날의 전일 마감 재고라 오프셋 −1(이마트 파일은 이마트·트레이더스가 섞여 있지만
       두 채널 오프셋이 같아 파일 단위로 이마트 값을 쓴다). 하이마트(himart)는 같은 날짜로 누적 판매 차이도 계산하므로
       오프셋을 적용하지 않는다. stockOffsets를 주지 않으면(채널마스터를 아직 못 받음) stockOffset = null, 기준일 = 파일명 날짜 */
  function parseRows(rows, opts) {
    opts = opts || {};
    rows = padRows(rows);
    const found = detect(rows, opts.type || null);
    if (!found) {
      return { ok: false, error: opts.type ? (TYPES[opts.type] ? TYPES[opts.type].label : opts.type) + ' 헤더를 상위 ' + HEADER_SCAN_ROWS + '행에서 찾지 못했습니다.' : '알 수 없는 파일 형식입니다 — 상위 ' + HEADER_SCAN_ROWS + '행에서 아는 헤더 조합을 찾지 못했습니다.' };
    }
    const t = TYPES[found.type];
    const hdr = found.header;
    const idx = headerIndex(hdr);
    const col = {};
    const missing = [];
    Object.keys(t.cols).forEach(k => {
      const h = t.cols[k];
      if (h in idx) col[k] = idx[h];
      else if (!OPTIONAL_COLS[k]) missing.push(h);
    });
    if (missing.length) return { ok: false, type: found.type, error: t.label + ' 필수 열이 없습니다: ' + missing.join(', ') };

    const data = rows.slice(found.headerIndex + 1).filter(r => !isBlankRow(r));
    const fileDate = dateFromFileName(opts.fileName);
    const res = {
      ok: true, type: found.type, typeLabel: t.label, channelId: t.channelId, kind: t.kind, split: t.split || '', blocked: t.blocked || '',
      headerRow: found.headerIndex + 1, rawRowCount: data.length, fileDate,
      baseDate: '', baseDateChosen: !!opts.baseDate, needsDate: false, stockOffset: null, period: null, year: null,
      records: { sales: [], storeStock: [], channelStock: [], himart: [], stores: [], names: {} },
      summary: {}, warnings: []
    };
    const bad = { num: 0, skipped: 0 };
    const num = v => { const n = toNum(v); if (isNaN(n)) { bad.num++; return 0; } return n; };
    const cell = (r, k) => (col[k] == null ? '' : r[col[k]]);

    if (t.kind !== 'period') {
      if (t.kind === 'snapshot') { if (opts.stockOffsets) res.stockOffset = Number(opts.stockOffsets[t.channelId]) || 0; }
      else res.stockOffset = 0;
      res.baseDate = opts.baseDate || (fileDate && res.stockOffset ? addDays(fileDate, res.stockOffset) : fileDate);
      res.needsDate = !res.baseDate;
      if (res.needsDate) res.warnings.push('파일명에서 기준일을 찾지 못했습니다 — 기준일을 선택해야 반영할 수 있습니다.');
    }

    if (found.type === 'EMART_DAILY_SALES_STORE') parseEmartDailyStore(res, hdr, data, col, opts, num, bad);
    else if (found.type === 'EMART_DAILY_SALES') parseEmartDaily(res, hdr, data, col, opts, num, bad);
    else if (found.type === 'ETLAND_SALES') parseEtlandSales(res, data, cell, num, bad);
    else if (found.type === 'ERP_SALES_PROFIT') parseErpSales(res, data, cell, num, bad, opts.fileName);
    else parseSnapshot(res, found.type, data, cell, num, bad);

    if (bad.num) res.warnings.push('숫자가 아닌 값 ' + bad.num + '개를 0으로 읽었습니다.');
    if (bad.skipped) res.warnings.push('코드·날짜가 비어 건너뛴 행 ' + bad.skipped + '개');
    finishSummary(res);
    return res;
  }

  function addName(res, code, name) {
    if (code && name && !res.records.names[code]) res.records.names[code] = String(name).trim();
  }
  function addStore(res, seen, code, name, region) {
    if (!code || seen[code]) return;
    seen[code] = true;
    res.records.stores.push({ code, name: String(name || '').trim(), region: String(region || '').trim() });
  }

  /* 이마트 일별 매출 두 양식이 같이 쓰는 날짜 열('9월 1일' · '09월01일') → [{ i, date }]. res.year·res.period도 채운다.
     합계·평균 열은 날짜 헤더가 아니라서 자연히 빠진다. */
  function emartDateCols(res, hdr, opts) {
    const today = opts.today || new Date().toISOString().slice(0, 10);
    const ty = +today.slice(0, 4), tm = +today.slice(5, 7);
    const dateCols = [];
    hdr.forEach((h, i) => {
      const md = monthDayHeader(h);
      if (!md) return;
      // 연도가 없는 헤더 — 업로드 시점 기준으로 추정하되 현재 월보다 미래 월이면 전년도로 본다
      const y = opts.year ? +opts.year : (md.m > tm ? ty - 1 : ty);
      if (!validYmd(y, md.m, md.d)) { res.warnings.push('날짜가 아닌 날짜 열을 건너뜀: ' + h); return; }
      dateCols.push({ i, date: ymd(y, md.m, md.d) });
    });
    res.year = opts.year ? +opts.year : (dateCols.length ? +dateCols[dateCols.length - 1].date.slice(0, 4) : ty);
    const dates = dateCols.map(c => c.date).sort();
    res.period = dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null;
    return dateCols;
  }

  // 날짜 열을 세로로 풀어 day 레코드(점포 없음)
  function parseEmartDaily(res, hdr, data, col, opts, num, bad) {
    const dateCols = emartDateCols(res, hdr, opts);
    data.forEach(r => {
      const code = toCode(r[col.code]);
      if (!code) { bad.skipped++; return; }
      addName(res, code, r[col.name]);
      dateCols.forEach(c => {
        const qty = num(r[c.i]);
        if (qty) res.records.sales.push({ s: c.date, e: c.date, store: '', code, qty, inst: '' });
      });
    });
  }

  /* 점포별 일별 매출 — 날짜 열을 세로로 풀어 점포 단위 day 레코드. 레코드·점포마다 업태명(biz)을 싣는다(채널은 GAS가 정함).
     같은 날·점포·상품·업태가 여러 줄이면 합산, 0은 저장하지 않고 음수(반품)는 그대로.
     summary.byBiz = 업태명별 [{ biz, rows(레코드), stores, qty }] — 미리보기에서 채널별로 나눠 보여 준다 */
  function parseEmartDailyStore(res, hdr, data, col, opts, num, bad) {
    const dateCols = emartDateCols(res, hdr, opts);
    const agg = {}, order = [], seenStore = {}, byBiz = {}, bizOrder = [];
    data.forEach(r => {
      const code = toCode(r[col.code]), store = toCode(r[col.store]);
      const biz = String(r[col.biz] == null ? '' : r[col.biz]).trim();
      if (!code || !store) { bad.skipped++; return; }
      addName(res, code, r[col.name]);
      if (!seenStore[store]) {
        seenStore[store] = true;
        res.records.stores.push({ code: store, name: String(r[col.storeName] == null ? '' : r[col.storeName]).trim(), region: '', biz });
      }
      if (!byBiz[biz]) { byBiz[biz] = { biz, rows: 0, stores: {}, qty: 0 }; bizOrder.push(biz); }
      byBiz[biz].stores[store] = true;
      dateCols.forEach(c => {
        const qty = num(r[c.i]);
        if (!qty) return;
        const k = [c.date, store, code, biz].join('|');
        if (!(k in agg)) { agg[k] = 0; order.push(k); }
        agg[k] += qty;
      });
    });
    order.forEach(k => {
      if (!agg[k]) return;
      const p = k.split('|');
      res.records.sales.push({ s: p[0], e: p[0], store: p[1], code: p[2], qty: agg[k], inst: '', biz: p[3] });
      byBiz[p[3]].rows++; byBiz[p[3]].qty += agg[k];
    });
    res.summary.byBiz = bizOrder.map(b => ({ biz: b || '(빈칸)', rows: byBiz[b].rows, stores: Object.keys(byBiz[b].stores).length, qty: byBiz[b].qty }));
  }

  // 판매일자 × 지점 × 모델명으로 합산해 day 레코드 — 같은 날 같은 모델이 여러 줄(반품 포함)일 수 있다
  function parseEtlandSales(res, data, cell, num, bad) {
    const agg = {}, gubun = {}, seenStore = {};
    let min = '', max = '';
    data.forEach(r => {
      const code = toCode(cell(r, 'code'));
      const date = toDate(cell(r, 'date'));
      const g = String(cell(r, 'gubun') == null ? '' : cell(r, 'gubun')).trim() || '(빈칸)';
      gubun[g] = (gubun[g] || 0) + 1;
      if (!code || !date) { bad.skipped++; return; }
      const store = toCode(cell(r, 'store'));
      addStore(res, seenStore, store, cell(r, 'storeName'), cell(r, 'region'));
      addName(res, code, cell(r, 'name'));
      const k = date + '|' + store + '|' + code;
      agg[k] = (agg[k] || 0) + num(cell(r, 'qty'));
      if (!min || date < min) min = date;
      if (!max || date > max) max = date;
    });
    Object.keys(agg).sort().forEach(k => {
      const p = k.split('|');
      if (agg[k]) res.records.sales.push({ s: p[0], e: p[0], store: p[1], code: p[2], qty: agg[k], inst: '' });
    });
    res.period = min ? { start: min, end: max } : null;
    res.summary.gubun = gubun;
    const other = Object.keys(gubun).filter(g => g !== '판매(계약)');
    if (other.length) res.warnings.push('구분에 "판매(계약)" 외의 값이 있습니다: ' + other.map(g => g + ' ' + gubun[g] + '건').join(', ') + ' — 수량은 그대로 합산했습니다.');
  }

  /* ERP 매출이익리스트 — 날짜('날짜' 열 = 매출일, 주문일 아님) × 거래처 × 상품코드로 수량·금액·수수료를 합산한 day 레코드.
     거래처코드를 점포코드(store) 자리에 싣고, 채널은 GAS가 거래처매핑으로 정한다. 수불구분 매출출고(+)·매출반품·매출취소(파일의 음수 그대로).
     무상 동봉(카테고리 '구성품'이면서 금액 0 — 반품·취소 포함)은 판매로 저장하지 않고 수량만 센다. 합산 결과가 수량·금액·수수료 모두 0이면 저장하지 않는다.
     교체 기간 기본값 = 파일명의 기간, 없으면 파일 안의 최소~최대 날짜.
     summary.byCust[] = 거래처별 { code, name, rows(원본 행), qty·amount·fee(무상 동봉 제외 뒤), excludedQty }(원본 순서)
     summary.brands[] = 브랜드별 { brand, rows, qty, amount, minix }(무상 동봉 제외 뒤) · summary.excluded = { rows, qty }
     summary.products = { 상품코드: { brand, category } }(코드 매핑 제안용) · summary.fileAmount = 파일 전체 금액 합 · summary.dataPeriod */
  function parseErpSales(res, data, cell, num, bad, fileName) {
    const agg = {}, order = [], custs = {}, custOrder = [], brands = {}, brandOrder = [], gubun = {};
    const ex = { rows: 0, qty: 0 };
    const txt = (r, k) => String(cell(r, k) == null ? '' : cell(r, k)).trim();
    let min = '', max = '', fileAmount = 0, totals = 0;
    res.summary.products = {};
    data.forEach(r => {
      const date = toDate(cell(r, 'date')), code = toCode(cell(r, 'code')), cust = toCode(cell(r, 'cust'));
      // 합계·소계 행 — 날짜가 비었거나 날짜가 아닌 행(2026-10 파일 끝 합계 행: A:AP 병합, 수량·금액 숫자만)은 판매가 아니다
      if (!date) { totals++; return; }
      const g = txt(r, 'gubun') || '(빈칸)';
      gubun[g] = (gubun[g] || 0) + 1;
      if (!code || !cust) { bad.skipped++; return; }
      const qty = num(cell(r, 'qty')), amt = num(cell(r, 'amt')), fee = num(cell(r, 'fee'));
      const cat = txt(r, 'cat'), brand = txt(r, 'brand');
      fileAmount += amt;
      if (!min || date < min) min = date;
      if (!max || date > max) max = date;
      let c = custs[cust];
      if (!c) { c = custs[cust] = { code: cust, name: cleanCustomerName(cell(r, 'custName')), rows: 0, qty: 0, amount: 0, fee: 0, excludedQty: 0 }; custOrder.push(cust); }
      c.rows++;
      if (cat === '구성품' && amt === 0) { ex.rows++; ex.qty += qty; c.excludedQty += qty; return; }
      addName(res, code, cell(r, 'name'));
      if (!res.summary.products[code]) res.summary.products[code] = { brand, category: cat };
      c.qty += qty; c.amount += amt; c.fee += fee;
      let b = brands[brand];
      if (!b) { b = brands[brand] = { brand: brand || '(빈칸)', rows: 0, qty: 0, amount: 0, minix: /미닉스|minix/i.test(brand) }; brandOrder.push(brand); }
      b.rows++; b.qty += qty; b.amount += amt;
      const k = date + '|' + cust + '|' + code;
      let a = agg[k];
      if (!a) { a = agg[k] = { qty: 0, amt: 0, fee: 0 }; order.push(k); }
      a.qty += qty; a.amt += amt; a.fee += fee;
    });
    order.sort().forEach(k => {
      const a = agg[k], p = k.split('|');
      if (a.qty || a.amt || a.fee) res.records.sales.push({ s: p[0], e: p[0], store: p[1], code: p[2], qty: a.qty, inst: '', amt: a.amt, fee: a.fee });
    });
    custOrder.forEach(k => res.records.stores.push({ code: k, name: custs[k].name, region: '' }));
    const fp = periodFromFileName(fileName);
    res.period = fp || (min ? { start: min, end: max } : null);
    res.periodFrom = fp ? 'file' : 'data';
    Object.assign(res.summary, { gubun, excluded: ex, fileAmount, dataPeriod: min ? { start: min, end: max } : null,
      byCust: custOrder.map(k => custs[k]), brands: brandOrder.map(k => brands[k]) });
    if (totals) {
      res.summary.totalRows = totals;
      res.rawRowCount -= totals; // 원본 행 = 데이터 행만
      res.warnings.push('합계·소계 행 제외 ' + totals + '행 — 날짜가 없는 행(파일 끝 합계 등)은 판매로 집계하지 않습니다.');
    }
    if (fp && min && (min < fp.start || max > fp.end)) res.warnings.push('파일 안 날짜(' + min + '~' + max + ')가 파일명의 기간(' + fp.start + '~' + fp.end + ')을 벗어납니다 — 교체 기간 밖의 행은 반영되지 않습니다.');
  }

  // 스냅샷형(이마트 재고 / 전자랜드 현재고 / 하이마트) — 점포 재고 + 채널 합계, 하이마트는 누적 스냅샷도
  function parseSnapshot(res, type, data, cell, num, bad) {
    const byKey = {}, order = [], seenStore = {}, himart = {};
    const yms = {};
    data.forEach(r => {
      const code = toCode(cell(r, 'code'));
      if (!code) { bad.skipped++; return; }
      const store = toCode(cell(r, 'store'));
      addStore(res, seenStore, store, cell(r, 'storeName'), type === 'HIMART_SALES_STOCK' ? cell(r, 'branch') : cell(r, 'region'));
      addName(res, code, cell(r, 'name'));
      if (type === 'EMART_STOCK') { const ym = String(cell(r, 'ym') || '').trim(); if (ym) yms[ym] = true; }
      const k = store + '|' + code;
      let o = byKey[k];
      if (!o) {
        o = byKey[k] = { store, code, stock: 0, transit: '', reserved: '', monthIn: '', monthSale: '' };
        if (type === 'ETLAND_STOCK') { o.transit = 0; o.reserved = 0; }
        if (type === 'EMART_STOCK') { o.monthIn = 0; o.monthSale = 0; }
        if (type === 'HIMART_SALES_STOCK') o.monthSale = 0;
        order.push(k);
      }
      o.stock += num(cell(r, 'stock'));
      if (type === 'ETLAND_STOCK') { o.transit += num(cell(r, 'transit')); o.reserved += num(cell(r, 'reserved')); }
      if (type === 'EMART_STOCK') { o.monthIn += num(cell(r, 'monthIn')); o.monthSale += num(cell(r, 'monthSale')); }
      if (type === 'HIMART_SALES_STOCK') {
        const h = himart[k] || (himart[k] = { store, code, real: 0, sale: 0, week: 0, day: 0, stock: 0 });
        h.real += num(cell(r, 'real')); h.sale += num(cell(r, 'sale')); h.week += num(cell(r, 'week'));
        h.day += num(cell(r, 'day')); h.stock += num(cell(r, 'stock'));
        o.monthSale += num(cell(r, 'sale'));
      }
    });
    const chan = {}, chanOrder = [];
    order.forEach(k => {
      const o = byKey[k];
      res.records.storeStock.push(o);
      let c = chan[o.code];
      if (!c) {
        c = chan[o.code] = { code: o.code, stock: 0, transit: o.transit === '' ? '' : 0, reserved: o.reserved === '' ? '' : 0 };
        chanOrder.push(o.code);
      }
      c.stock += o.stock;
      if (c.transit !== '') c.transit += o.transit;
      if (c.reserved !== '') c.reserved += o.reserved;
      if (himart[k]) res.records.himart.push(himart[k]);
    });
    res.records.channelStock = chanOrder.map(c => chan[c]);
    if (type === 'EMART_STOCK' && res.baseDate) {
      // 조회일자는 기준일의 월 또는 파일명 날짜의 월이면 된다(10/1에 받은 파일 = 9/30 재고 — 조회일자가 어느 쪽이어도 정상)
      const want = [res.baseDate, res.fileDate].filter(Boolean).map(d => d.slice(0, 4) + d.slice(5, 7));
      const other = Object.keys(yms).filter(ym => want.indexOf(ym) < 0);
      if (other.length) res.warnings.push('조회일자(' + other.join(', ') + ')가 기준일 ' + res.baseDate + '의 월과 다릅니다.');
    }
  }

  function finishSummary(res) {
    const codes = {};
    ['sales', 'storeStock', 'channelStock', 'himart'].forEach(k => res.records[k].forEach(r => { codes[r.code] = true; }));
    res.codes = Object.keys(codes).sort();
    res.summary.codeCount = res.codes.length;
    res.summary.storeCount = res.records.stores.length;
    const r = res.records;
    res.plannedRows = res.kind === 'period'
      ? { sales: r.sales.length }
      : { stockDaily: r.channelStock.length, stockStore: r.storeStock.length, himartSnap: r.himart.filter(h => h.real || h.sale || h.week || h.day).length };
  }

  /* 미리보기에서 고친 값(기준일·교체기간)을 얹어 offline_upload 입력으로 — { meta, records }
     스냅샷형은 파일명 날짜(meta.fileDate)도 보낸다 — 서버는 이걸 보고 "기준일이 이미 재고 기준일로 정해졌다"고 보고 그대로 쓴다.
     채널 오프셋을 몰라 적용하지 못했고(stockOffset null) 기준일을 직접 고르지도 않았으면 보내지 않는다 → 서버가 채널 오프셋을 더한다 */
  function toUploadPayload(res, edits) {
    edits = edits || {};
    const meta = { fileName: edits.fileName || '', fileType: res.type, channelId: res.channelId, rawRowCount: res.rawRowCount };
    if (res.kind === 'period') {
      meta.replaceStart = edits.replaceStart || (res.period && res.period.start) || '';
      meta.replaceEnd = edits.replaceEnd || (res.period && res.period.end) || '';
    } else {
      meta.baseDate = edits.baseDate || res.baseDate || '';
      if (res.kind === 'snapshot' && (res.stockOffset != null || res.baseDateChosen)) meta.fileDate = res.fileDate || '';
    }
    // ERP 매출이익리스트 — 미리보기에서 채널을 고른 새 거래처({code, name, channelId}) → GAS가 거래처매핑에 저장하고 그 채널로 반영
    if (res.split === 'customer') meta.customers = edits.customers || [];
    // 합계·소계 행을 뺐다는 사실 — 서버가 업로드로그 경고에 남긴다
    if (res.summary && res.summary.totalRows) meta.totalRowsExcluded = res.summary.totalRows;
    const r = res.records;
    return {
      meta,
      records: {
        sales: r.sales, storeStock: r.storeStock, channelStock: r.channelStock,
        himart: r.himart, stores: r.stores, names: r.names
      }
    };
  }

  /* 개인정보 차단 — 유형에 onlyUsedCols가 있으면(ERP 매출이익리스트: 주문자·수취인·연락처·주소·송장번호 열) 그 유형의 cols 열만 남긴
     새 2차원 배열 [헤더, ...데이터 행]을 돌려준다(헤더 위 그룹명 행도 버린다). 파일을 읽자마자 부르면 원본 행은 남지 않고
     판별·파싱·미리보기·전송은 이 배열만 본다. 판별되지 않거나 다른 유형이면 rows 그대로 */
  function dropUnusedColumns(rows) {
    const found = detect(padRows(rows));
    if (!found || !TYPES[found.type].onlyUsedCols) return rows;
    const t = TYPES[found.type], idx = headerIndex(found.header); // 2줄 헤더면 합친 헤더(판별과 같은 것)
    const keep = Object.keys(t.cols).map(k => t.cols[k]).filter(h => h in idx), at = keep.map(h => idx[h]);
    return [keep].concat(rows.slice(found.headerIndex + 1).map(r => at.map(c => (r && r[c] !== undefined ? r[c] : ''))));
  }

  /* SheetJS 워크북 → 2차원 배열(유형이 판별되는 첫 시트, 없으면 첫 시트).
     XLSX는 호출부가 넘긴다(브라우저 전역 / node require) — 이 파일이 SheetJS에 의존하지 않게.
     · raw:true — HTML·CSV(전자랜드 .xls는 실제로 HTML)에서 '2026-09-02'를 날짜로 바꾸다 UTC로
       하루 밀리는 것, 점포코드 앞자리 0이 숫자 변환으로 사라지는 것을 막는다(xlsx에는 영향 없음).
     · 시트의 <dimension>이 실제 셀보다 작게 적힌 파일이 있다(이마트 재고: A1:F3인데 데이터는 843행).
       그대로 두면 3행만 읽히므로 셀 주소로 범위를 다시 잡는다. */
  function readWorkbookRows(XLSX, bytes) {
    const isBuf = typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(bytes);
    const wb = XLSX.read(bytes, { type: isBuf ? 'buffer' : 'array', raw: true, cellDates: false });
    let first = null;
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      fixSheetRange(XLSX, ws);
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
      if (!first) first = { sheetName: name, rows };
      if (detect(rows)) return { sheetName: name, rows };
    }
    return first || { sheetName: '', rows: [] };
  }
  function fixSheetRange(XLSX, ws) {
    let maxR = -1, maxC = -1;
    Object.keys(ws).forEach(k => {
      if (k[0] === '!') return;
      const a = XLSX.utils.decode_cell(k);
      if (a.r > maxR) maxR = a.r;
      if (a.c > maxC) maxC = a.c;
    });
    if (maxR >= 0) ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  }

  return {
    TYPES, TYPE_ORDER, HEADER_SCAN_ROWS,
    detect, parseRows, toUploadPayload, readWorkbookRows, dropUnusedColumns,
    dateFromFileName, periodFromFileName, cleanCustomerName, addDays, toNum, toCode, toDate, normHeader
  };
});
