/* 오프라인 원장 GAS(apps-script.js + apps-script-offline.js + apps-script-offline-targets.js)를 node vm에서 실코드 그대로 띄운다.
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

/* opts.today   — _offToday() 고정값('YYYY-MM-DD')
   opts.noSheetId — OFFLINE_SHEET_ID를 비운 상태
   opts.setup   — true면 offline_setupSheets까지 실행해 둔다 */
function loadOfflineGas(opts) {
  opts = opts || {};
  const main = { '실적통합': makeSheet('실적통합', [[], []]) };
  const scriptProps = { SESSION_SECRET_V1: 'test-secret-v1-0123456789' };
  if (!opts.noSheetId) scriptProps.OFFLINE_SHEET_ID = OFFLINE_ID;
  const cacheStore = installGlobals(main, { scriptProps });
  const off = makeOfflineSS();
  global.SpreadsheetApp.openById = id => {
    if (id !== OFFLINE_ID) throw new Error('openById: 모르는 ID ' + id);
    return off;
  };
  const locks = { taken: 0 };
  global.LockService.getDocumentLock = () => ({
    tryLock: () => { locks.taken++; return true; }, waitLock() { locks.taken++; }, releaseLock() {}
  });
  global.Utilities.formatDate = formatDate;
  const ctx = vm.createContext(global);
  vm.runInContext(fs.readFileSync(path.join(PROJ, 'apps-script.js'), 'utf8'), ctx, { filename: 'apps-script.js' });
  vm.runInContext(fs.readFileSync(path.join(PROJ, 'apps-script-offline.js'), 'utf8'), ctx, { filename: 'apps-script-offline.js' });
  const targets = path.join(PROJ, 'apps-script-offline-targets.js');
  if (fs.existsSync(targets)) vm.runInContext(fs.readFileSync(targets, 'utf8'), ctx, { filename: 'apps-script-offline-targets.js' });
  if (opts.today) ctx._offToday = () => opts.today;
  if (opts.setup) ctx.offline_setupSheets();
  return { ctx, off, cacheStore, locks, tab: name => off.getSheetByName(name) };
}

// 탭의 데이터 행(헤더 제외, 값 있는 행까지)
function dataRows(sheet) {
  const last = sheet.getLastRow();
  return sheet._grid.slice(1, last).map(r => r.slice());
}

module.exports = { loadOfflineGas, dataRows, OFFLINE_ID, PROJ, STATS, resetStats };
