/* 오프라인 원장 GAS(apps-script.js + apps-script-offline.js + apps-script-offline-targets.js + apps-script-offline-inventory.js + apps-script-home.js)를 node vm에서 실코드 그대로 띄운다.
   구글 API는 mock-sheets.js 목을 쓰고, 오프라인 스프레드시트(openById)만 여기서 따로 만든다.

   목과 실제 시트가 다른 점 중 오프라인 코드가 기대는 것만 맞춘다:
   · getLastRow — 실제 시트는 **값이 있는 마지막 행**(clearContent로 비운 뒤쪽 행은 세지 않음)
   · setNumberFormat — 어떤 범위에 무슨 서식을 걸었는지 기록(텍스트 서식 검증용) */
const fs = require('fs'), path = require('path'), vm = require('vm');
const { makeSheet, installGlobals, STATS, resetStats } = require('./mock-sheets.js');

const PROJ = path.join(__dirname, '..', '..');
const OFFLINE_ID = 'OFFLINE-TEST-ID';

function offSheet(name) {
  const sh = makeSheet(name, [[]]);
  sh._formats = [];
  sh.getLastRow = () => {
    for (let i = sh._grid.length - 1; i >= 0; i--) if (sh._grid[i].some(v => v !== '' && v != null)) return i + 1;
    return 0;
  };
  const orig = sh.getRange;
  sh.getRange = (r, c, nr, nc) => {
    const api = orig(r, c, nr, nc);
    api.setNumberFormat = f => { sh._formats.push({ r, c, nr: nr || 1, nc: nc || 1, f }); return api; };
    return api;
  };
  sh.getDataRange = () => sh.getRange(1, 1, sh._grid.length, sh.getLastColumn());
  return sh;
}

function makeOfflineSS() {
  const sheets = {}, order = [];
  return {
    _sheets: sheets, _order: order,
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => { sheets[n] = offSheet(n); order.push(n); return sheets[n]; },
    getSheets: () => order.map(n => sheets[n])
  };
}

// Utilities.formatDate — 오프라인 코드가 쓰는 패턴만(yyyy MM dd HH mm ss), Asia/Seoul 고정
function formatDate(d, tz, fmt) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(d).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
    .replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
}

/* 기존(원본) 스프레드시트 목 — **읽기 메서드만** 있다. 코드가 원본에 쓰기를 시도하면 "is not a function"으로
   바로 실패한다(원본은 절대 수정하지 않는다는 원칙을 테스트로 고정). calls에 호출한 메서드를 기록한다.
   tabs: { 탭이름: { grid: 2차원 배열(1행부터), merges: [[행, 열, 행수, 열수]] (1-based) } } */
const LEGACY_ID = 'LEGACY-TEST-ID';
function makeLegacySS(tabs) {
  const calls = [];
  const sheets = {};
  Object.keys(tabs).forEach(name => {
    const { grid, merges } = tabs[name];
    const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
    sheets[name] = {
      getName: () => name,
      getLastRow: () => { calls.push('getLastRow'); return grid.length; },
      getLastColumn: () => { calls.push('getLastColumn'); return width; },
      getRange: (r, c, nr, nc) => ({
        getValues() {
          calls.push('getValues');
          const out = [];
          for (let i = 0; i < nr; i++) { const row = grid[r - 1 + i] || []; const o = []; for (let j = 0; j < nc; j++) { const v = row[c - 1 + j]; o.push(v === undefined ? '' : v); } out.push(o); }
          return out;
        },
        getMergedRanges() {
          calls.push('getMergedRanges');
          return (merges || []).map(([mr, mc, mnr, mnc]) => ({ getRow: () => mr, getColumn: () => mc, getNumRows: () => mnr, getNumColumns: () => mnc }));
        }
      })
    };
  });
  return { _calls: calls, getSheetByName: n => { calls.push('getSheetByName'); return sheets[n] || null; } };
}

/* Sheets 고급 서비스(Sheets API v4) 목 — 오프라인 목 스프레드시트(off)의 같은 grid를 읽고 쓴다. 실제 API와 맞추는 것:
   · Values.batchGet — 범위 "'탭'!A2:L". 뒤쪽 빈 행과 행 끝 빈 칸은 빼고 준다(가운데 빈 행은 []). 값이 없으면 values 키가 없다.
     Date 셀은 일련번호(dateTimeRenderOption SERIAL_NUMBER — 실제처럼 숫자). 없는 탭은 "Unable to parse range" 오류
   · Spreadsheets.get — sheets[].properties { sheetId(첫 탭 0 — 0이면 키가 빠진다), title, gridProperties.rowCount(= getMaxRows) }
   · Spreadsheets.batchUpdate(resource, id) — appendDimension · repeatCell(numberFormat → _formats에 기록) · updateCells
     (range를 rows가 다 채우지 못하면 남는 칸은 비운다). 요청 하나라도 틀리면 아무것도 바뀌지 않는다(원자적)
   calls = 호출 기록 [{ op: 'batchGet'|'get'|'batchUpdate', ... }] — 왕복 수 검사용 */
function installSheetsApi(off, id) {
  const calls = [];
  const ids = new Map();
  let next = 0; // 실제처럼 첫 탭의 sheetId는 0 — 응답에서 0은 빠진다(아래 get)
  const sheetIdOf = name => { if (!ids.has(name)) ids.set(name, next++); return ids.get(name); };
  const byId = sid => { for (const [n, v] of ids) if (v === sid && off._sheets[n]) return off._sheets[n]; throw new Error('No grid with id: ' + sid); };
  const checkId = x => { if (x !== id) throw new Error('Requested entity was not found: ' + x); };
  const colNo = s => s.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const serial = d => (d.getTime() + 9 * 3600000 - Date.UTC(1899, 11, 30)) / 86400000;
  const width = g => g.reduce((m, r) => Math.max(m, r.length), 0);
  function readRange(a1) {
    const m = /^'((?:[^']|'')+)'!A(\d+):([A-Z]+)$/.exec(a1);
    const sh = m && off._sheets[m[1].replace(/''/g, "'")];
    if (!sh) throw new Error('Unable to parse range: ' + a1);
    const r0 = +m[2] - 1, W = colNo(m[3]), g = sh._grid, out = [];
    for (let i = r0; i < g.length; i++) {
      const row = (g[i] || []).slice(0, W).map(v => (v === undefined || v === null ? '' : v instanceof Date ? serial(v) : v));
      while (row.length && row[row.length - 1] === '') row.pop();
      out.push(row);
    }
    while (out.length && !out[out.length - 1].length) out.pop();
    return out.length ? { range: a1, majorDimension: 'ROWS', values: out } : { range: a1, majorDimension: 'ROWS' };
  }
  function inGrid(sh, rg) {
    if (rg.endRowIndex > sh._grid.length) throw new Error('Range exceeds grid limits. Max rows: ' + sh._grid.length + ', requested end row: ' + rg.endRowIndex);
  }
  function apply(req) {
    if (req.appendDimension) {
      const sh = byId(req.appendDimension.sheetId), w = width(sh._grid);
      if (req.appendDimension.dimension !== 'ROWS') throw new Error('appendDimension: ROWS만 흉내 낸다');
      for (let i = 0; i < req.appendDimension.length; i++) sh._grid.push(new Array(w).fill(''));
    } else if (req.repeatCell) {
      const rg = req.repeatCell.range, sh = byId(rg.sheetId), nf = req.repeatCell.cell.userEnteredFormat.numberFormat;
      inGrid(sh, rg);
      if (req.repeatCell.fields !== 'userEnteredFormat.numberFormat') throw new Error('repeatCell fields: ' + req.repeatCell.fields);
      sh._formats.push({ r: rg.startRowIndex + 1, c: rg.startColumnIndex + 1, nr: rg.endRowIndex - rg.startRowIndex, nc: rg.endColumnIndex - rg.startColumnIndex, f: nf.pattern || nf.type });
    } else if (req.updateCells) {
      const u = req.updateCells, rg = u.range, sh = byId(rg.sheetId);
      inGrid(sh, rg);
      if (u.fields !== 'userEnteredValue') throw new Error('updateCells fields: ' + u.fields);
      for (let i = rg.startRowIndex; i < rg.endRowIndex; i++) {
        const row = sh._grid[i];
        while (row.length < rg.endColumnIndex) row.push('');
        const src = (u.rows || [])[i - rg.startRowIndex];
        for (let j = rg.startColumnIndex; j < rg.endColumnIndex; j++) {
          const cd = src && src.values ? src.values[j - rg.startColumnIndex] : null, v = cd && cd.userEnteredValue;
          if (v && ['stringValue', 'numberValue', 'boolValue'].filter(k => k in v).length !== 1) throw new Error('userEnteredValue: ' + JSON.stringify(v));
          row[j] = !v ? '' : 'stringValue' in v ? v.stringValue : 'numberValue' in v ? v.numberValue : v.boolValue;
        }
      }
    } else throw new Error('목이 모르는 요청: ' + Object.keys(req).join(','));
  }
  global.Sheets = {
    Spreadsheets: {
      get(x, o) {
        checkId(x); calls.push({ op: 'get', fields: o && o.fields });
        return { sheets: off._order.filter(n => off._sheets[n]).map((n, i) => ({ properties: Object.assign(sheetIdOf(n) ? { sheetId: sheetIdOf(n) } : {},
          { title: n, index: i, gridProperties: { rowCount: off._sheets[n]._grid.length, columnCount: width(off._sheets[n]._grid) } }) })) };
      },
      batchUpdate(resource, x) {
        checkId(x); calls.push({ op: 'batchUpdate', requests: resource.requests.map(r => Object.keys(r)[0]) });
        const snap = Object.keys(off._sheets).map(n => [off._sheets[n], off._sheets[n]._grid.map(r => r.slice()), off._sheets[n]._formats.length]);
        try { resource.requests.forEach(apply); }
        catch (e) { snap.forEach(([sh, g, f]) => { sh._grid.splice(0, sh._grid.length, ...g); sh._formats.length = f; }); throw e; }
        return { spreadsheetId: x, replies: resource.requests.map(() => ({})) };
      },
      Values: {
        batchGet(x, o) {
          checkId(x); calls.push({ op: 'batchGet', ranges: o.ranges.slice() });
          if (o.valueRenderOption !== 'UNFORMATTED_VALUE' || o.dateTimeRenderOption !== 'SERIAL_NUMBER') throw new Error('목은 UNFORMATTED_VALUE + SERIAL_NUMBER만 흉내 낸다');
          return { spreadsheetId: x, valueRanges: o.ranges.map(readRange) };
        }
      }
    }
  };
  // 시트 생성 순서대로 sheetId를 정해 둔다(get 전에 batchUpdate가 오는 일은 없지만 id가 바뀌지 않게)
  off._order.forEach(sheetIdOf);
  return { calls, count: op => calls.filter(c => c.op === op).length, reset: () => { calls.length = 0; } };
}

/* opts.today   — _offToday() 고정값('YYYY-MM-DD')
   opts.legacy  — 기존 스프레드시트 탭 목({탭: {grid, merges}}) — 주면 LEGACY_PROGRESS_SHEET_ID로 연결
   opts.noSheetId — OFFLINE_SHEET_ID를 비운 상태
   opts.setup   — true면 offline_setupSheets까지 실행해 둔다
   opts.dir     — GAS 파일을 읽을 폴더(기본 저장소 루트). 확인 스크립트가 바꾸기 전 코드(git show)를 띄울 때
   opts.noSheetsApi — Sheets 고급 서비스를 켜지 않은 상태(appsscript.json 미반영 — SpreadsheetApp 대체 경로) */
function loadOfflineGas(opts) {
  opts = opts || {};
  const main = { '실적통합': makeSheet('실적통합', [[], []]) };
  const scriptProps = { SESSION_SECRET_V1: 'test-secret-v1-0123456789' };
  if (!opts.noSheetId) scriptProps.OFFLINE_SHEET_ID = OFFLINE_ID;
  if (opts.legacy) scriptProps.LEGACY_PROGRESS_SHEET_ID = LEGACY_ID;
  const cacheStore = installGlobals(main, { scriptProps });
  const off = makeOfflineSS();
  const legacy = opts.legacy ? makeLegacySS(opts.legacy) : null;
  global.SpreadsheetApp.openById = id => {
    if (id === OFFLINE_ID) return off;
    if (legacy && id === LEGACY_ID) return legacy;
    throw new Error('openById: 모르는 ID ' + id);
  };
  const locks = { taken: 0 };
  global.LockService.getDocumentLock = () => ({
    tryLock: () => { locks.taken++; return true; }, waitLock() { locks.taken++; }, releaseLock() {}
  });
  global.Utilities.formatDate = formatDate;
  delete global.Sheets;
  const api = opts.noSheetsApi ? null : installSheetsApi(off, OFFLINE_ID);
  const ctx = vm.createContext(global);
  const dir = opts.dir || PROJ;
  vm.runInContext(fs.readFileSync(path.join(dir, 'apps-script.js'), 'utf8'), ctx, { filename: 'apps-script.js' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'apps-script-offline.js'), 'utf8'), ctx, { filename: 'apps-script-offline.js' });
  ['apps-script-offline-targets.js', 'apps-script-offline-inventory.js', 'apps-script-home.js'].forEach(f => {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f });
  });
  if (opts.today) ctx._offToday = () => opts.today;
  if (opts.setup) ctx.offline_setupSheets();
  return { ctx, off, legacy, cacheStore, locks, api, tab: name => off.getSheetByName(name) };
}

// 탭의 데이터 행(헤더 제외, 값 있는 행까지)
function dataRows(sheet) {
  const last = sheet.getLastRow();
  return sheet._grid.slice(1, last).map(r => r.slice());
}

module.exports = { loadOfflineGas, dataRows, OFFLINE_ID, PROJ, STATS, resetStats };
