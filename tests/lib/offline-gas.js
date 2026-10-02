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

/* opts.today   — _offToday() 고정값('YYYY-MM-DD')
   opts.legacy  — 기존 스프레드시트 탭 목({탭: {grid, merges}}) — 주면 LEGACY_PROGRESS_SHEET_ID로 연결
   opts.noSheetId — OFFLINE_SHEET_ID를 비운 상태
   opts.setup   — true면 offline_setupSheets까지 실행해 둔다
   opts.dir     — GAS 파일을 읽을 폴더(기본 저장소 루트). 확인 스크립트가 바꾸기 전 코드(git show)를 띄울 때 */
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
  return { ctx, off, legacy, cacheStore, locks, tab: name => off.getSheetByName(name) };
}

// 탭의 데이터 행(헤더 제외, 값 있는 행까지)
function dataRows(sheet) {
  const last = sheet.getLastRow();
  return sheet._grid.slice(1, last).map(r => r.slice());
}

module.exports = { loadOfflineGas, dataRows, OFFLINE_ID, PROJ, STATS, resetStats };
