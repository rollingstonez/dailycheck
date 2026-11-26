/**
 * 데일리체크 ↔ 구글 시트 연결 스크립트
 *
 * 시트 모양 (탭 하나 = 점검표 하나)
 *   A열: 점검사항   예) 밸브, 오일 (ml), 헬륨(Kg), 온도(℃)
 *   B열: 기준 (선택) 예) on/off, 100~150, 40 이상, 95 이하, 사진
 *   1행: 날짜       예) 11/11, 11/12 ...
 *   맨 아래 "점검자", "점검시각" 행은 앱이 자동으로 만듭니다.
 *
 * 설치 방법은 같은 폴더의 설치방법.md 를 보세요.
 */

// ▼ 앱의 "비밀번호" 칸에 넣을 값과 똑같이 바꾸세요. ('' 로 두면 비밀번호 없이 연결됨)
var TOKEN = '1234';

// ▼ 승인 비밀번호 (선택). 시트의 점검항목을 고치면 앱의 «변경 확인»에서 승인해야 현장 화면에 반영됩니다.
//   '' 로 두면 비밀번호 없이 «승인» 버튼만 누르면 됩니다. 혼자 쓰신다면 비워 두거나 TOKEN 과 같게 하세요.
var ADMIN_PIN = '';

var APPROVED_TAB = '_승인본'; // 승인된 점검항목 목록 (숨김 탭, 지우면 현재 시트가 새 기준으로 다시 확정됨)
var LOG_TAB = '_기록';   // 입력·정정 장부 (덧붙이기만 함, 숨김 탭 — 지우지 마세요)
var CORR_TAB = '_정정'; // 정정 내역만 따로 (앱이 읽어서 «정정됨»으로 표시)
var LOG_HEADER = ['시각', '구분', '탭', '날짜', '항목', '값', '이전값', '사유', '점검자'];
var CORR_HEADER = ['시각', '탭', '날짜', '항목', '이전값', '정정값', '사유', '정정자'];
var PROTECT_DESC = '데일리체크 기록 보호'; // 스크립트가 거는 시트 보호의 이름
var PHOTO_FOLDER = '데일리체크 사진';
var SPECIAL_INSPECTOR = '점검자';
var SPECIAL_TIME = '점검시각';

/* ───────────── 구글 시트에서 실행되는 부분 ───────────── */

function doGet() {
  return json_({ ok: true, message: '데일리체크 연결 스크립트가 작동 중입니다. 이 주소를 앱에 넣으세요.' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (TOKEN && body.token !== TOKEN) throw new Error('비밀번호가 맞지 않습니다');
    if (body.action === 'read') return json_(read_());
    if (body.action === 'submit') return json_(submit_(body));
    if (body.action === 'approve') return json_(approve_(body));
    if (body.action === 'correct') return json_(correct_(body));
    if (body.action === 'verify') return json_(verify_());
    if (body.action === 'resolve') return json_(resolve_(body));
    if (body.action === 'protect') return json_(protect_());
    throw new Error('알 수 없는 요청: ' + body.action);
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function fmt_() {
  var tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  return function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
}

function readTabs_(ss) {
  var fmt = fmt_();
  var year = new Date().getFullYear();
  return ss.getSheets()
    .filter(function (s) { return !s.isSheetHidden() && s.getName().charAt(0) !== '_'; })
    .map(function (sh) {
      var rng = sh.getDataRange();
      var r = dc_read(rng.getValues(), rng.getNotes(), fmt, year);
      r.tab = sh.getName();
      return r;
    });
}

function read_() {
  var ss = SpreadsheetApp.getActive();
  var tabs = readTabs_(ss);
  return { ok: true, name: ss.getName(), tabs: tabs, approved: approved_(ss, tabs), pinRequired: !!ADMIN_PIN, corrections: readCorrections_(ss) };
}

function stamp_() {
  return Utilities.formatDate(new Date(), SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
}

function writeApproved_(sh, rows) {
  var all = [['탭', '점검사항', '기준', '승인시각']].concat(rows);
  sh.clearContents();
  sh.getRange(1, 1, all.length, 4).setNumberFormat('@').setValues(all); // 글자로 저장 (예: 1/2 가 날짜로 바뀌지 않게)
}

function readApprovedRows_(sh) {
  var n = sh.getLastRow();
  return n > 1 ? sh.getRange(2, 1, n - 1, 4).getValues() : [];
}

/** 승인된 항목 목록. 처음 연결할 때는 지금 시트를 기준으로 자동 확정한다. */
function approved_(ss, tabs) {
  var sh = ss.getSheetByName(APPROVED_TAB);
  if (!sh) {
    var lock = LockService.getDocumentLock();
    lock.waitLock(20000);
    try {
      sh = ss.getSheetByName(APPROVED_TAB);
      if (!sh) {
        sh = ss.insertSheet(APPROVED_TAB);
        writeApproved_(sh, dc_initApproved(tabs, stamp_()));
        try { sh.hideSheet(); } catch (e) { /* 숨기지 못해도 «_»로 시작하는 탭은 앱이 무시합니다 */ }
        try { lockSheet_(sh); protectAll_(ss); } catch (e) { /* 보호를 걸지 못해도 입력·동기화는 계속됩니다 */ }
      }
    } finally {
      lock.releaseLock();
    }
  }
  return dc_groupApproved(readApprovedRows_(sh));
}

function approve_(b) {
  if (ADMIN_PIN && String(b.pin || '') !== ADMIN_PIN) throw new Error('승인 비밀번호가 맞지 않습니다');
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(APPROVED_TAB);
    if (!sh) throw new Error('먼저 앱에서 동기화하세요');
    writeApproved_(sh, dc_applyApproval(readApprovedRows_(sh), b.tabs || [], b.removed || [], stamp_()));
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/** 숨김 탭을 만들거나 가져온다 */
function hiddenSheet_(name, header) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setNumberFormat('@').setValues([header]);
    try { sh.hideSheet(); } catch (e) { /* 숨기지 못해도 «_»로 시작하는 탭은 앱이 무시합니다 */ }
    try { lockSheet_(sh); } catch (e) { /* 보호를 걸지 못해도 계속 */ }
  }
  return sh;
}

/** 장부 맨 아래에 줄을 덧붙인다 (글자로 저장해 값이 바뀌지 않게) */
function appendRows_(sh, rows) {
  if (!rows.length) return;
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
}

function readCorrections_(ss) {
  var sh = ss.getSheetByName(CORR_TAB);
  if (!sh || sh.getLastRow() < 2) return [];
  return dc_groupCorrections(sh.getRange(2, 1, sh.getLastRow() - 1, CORR_HEADER.length).getValues());
}

/** 정정: 이미 기록된 값을 고친다. 사유 필수, 원본은 장부에 남고, 칸 메모에도 표시된다. */
function correct_(b) {
  if (ADMIN_PIN && String(b.pin || '') !== ADMIN_PIN) throw new Error('승인 비밀번호가 맞지 않습니다');
  var reason = String(b.reason || '').trim();
  if (!reason) throw new Error('정정 사유를 입력하세요');
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(b.tab);
    if (!sh) throw new Error('시트에 "' + b.tab + '" 탭이 없습니다');
    var grid = sh.getDataRange().getValues();
    var loc = dc_locate(grid, b.date, fmt_(), new Date().getFullYear());
    if (loc.col === null) throw new Error('그 날짜의 기록이 없습니다');
    var labels = grid.map(function (row) { return String(row[0]).trim(); });
    var r = dc_findRow(labels, b.label);
    if (r < 0) throw new Error('시트에 "' + b.label + '" 항목이 없습니다');
    var cur = grid[r][loc.col];
    if (dc_decide(cur, b.value) !== 'locked') throw new Error('정정할 값이 비어 있거나 기존 값과 같습니다');

    var stamp = stamp_();
    var cell = sh.getRange(r + 1, loc.col + 1);
    cell.setValue(b.value);
    var line = '✎ 정정 ' + stamp + ': ' + cur + ' → ' + b.value + ' (사유: ' + reason + ')' + (b.inspector ? ' · ' + b.inspector : '');
    var note = cell.getNote();
    cell.setNote(note ? note + '\n' + line : line);
    appendRows_(hiddenSheet_(LOG_TAB, LOG_HEADER), [[stamp, '정정', b.tab, b.date, b.label, b.value, cur, reason, b.inspector || '']]);
    appendRows_(hiddenSheet_(CORR_TAB, CORR_HEADER), [[stamp, b.tab, b.date, b.label, cur, b.value, reason, b.inspector || '']]);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function submit_(b) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000); // 여러 명이 동시에 저장해도 섞이지 않도록
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(b.tab);
    if (!sh) throw new Error('시트에 "' + b.tab + '" 탭이 없습니다');
    var fmt = fmt_();
    var grid = sh.getDataRange().getValues();
    var loc = dc_locate(grid, b.date, fmt, new Date().getFullYear());

    var col = loc.col; // 0부터 시작
    if (col === null) {
      sh.insertColumnAfter(loc.insertAfter + 1);
      col = loc.insertAfter + 1;
      sh.getRange(1, col + 1).setValue(b.date).setNumberFormat('M/d');
    }

    // 점검자·점검시각 행이 없으면 맨 아래에 추가
    var labels = grid.map(function (row) { return String(row[0]).trim(); });
    [SPECIAL_INSPECTOR, SPECIAL_TIME].forEach(function (s) {
      if (labels.indexOf(s) < 0) {
        var last = sh.getLastRow() + 1;
        sh.getRange(last, 1).setValue(s);
        labels[last - 1] = s;
      }
    });

    var missing = [];
    var uploaded = [];
    var locked = [];   // 이미 다른 값이 기록되어 있어 건너뛴 항목
    var logRows = [];
    var stamp = stamp_();
    var fresh = loc.col === null; // 방금 새로 만든 날짜 열이면 읽어 둔 값이 없다
    var entries = (b.entries || []).concat([
      { label: SPECIAL_INSPECTOR, value: b.inspector || '' },
      { label: SPECIAL_TIME, value: b.time ? "'" + b.time : '' },
    ]);
    entries.forEach(function (en) {
      var r = dc_findRow(labels, en.label);
      if (r < 0) { missing.push(en.label); return; }
      var cell = sh.getRange(r + 1, col + 1);
      var cur = !fresh && grid[r] && grid[r][col] !== undefined ? grid[r][col] : '';
      var val = en.value === null || en.value === undefined ? '' : en.value;
      if (en.label === SPECIAL_INSPECTOR) {
        // 점검자: 비어 있으면 기록, 다른 사람이 이어서 입력하면 이름을 덧붙임
        if (val !== '' && cur === '') cell.setValue(val);
        else if (val !== '' && String(cur).indexOf(String(val)) < 0) cell.setValue(cur + ', ' + val);
      } else if (en.label === SPECIAL_TIME) {
        if (val !== '' && cur === '') cell.setValue(val); // 점검시각은 처음 것을 유지
      } else {
        // 이미 기록된 칸은 덮어쓰지 않는다 (고치려면 «정정»)
        var d = dc_decide(cur, val);
        if (d === 'write') {
          cell.setValue(val);
          logRows.push([stamp, '입력', b.tab, b.date, en.label, val, '', '', b.inspector || '']);
        } else if (d === 'locked') {
          locked.push(en.label);
        }
      }
      if (en.photos && en.photos.length) {
        var saved = savePhotos_(b.tab, b.date, en.label, en.photos);
        uploaded = uploaded.concat(saved);
        var note = cell.getNote();
        var urls = saved.map(function (p) { return p.url; }).join('\n');
        cell.setNote(note ? note + '\n' + urls : '📷 사진\n' + urls);
      }
    });
    appendRows_(hiddenSheet_(LOG_TAB, LOG_HEADER), logRows);
    try { ensureProtection_(sh); } catch (e) { /* 보호를 걸지 못해도 입력은 저장됨 */ }
    return { ok: true, column: col + 1, missing: missing, photos: uploaded, locked: locked };
  } finally {
    lock.releaseLock();
  }
}

/* ───────────── 시트 보호 ───────────── */

/**
 * 기록 칸(날짜 열 전체)을 «보호된 범위(경고)»로 건다.
 *  - 시트에서 이 칸을 고치거나 이 칸이 들어 있는 행·열을 지우려 하면 구글 시트가 경고를 띄웁니다. (주인 포함)
 *  - 점검사항·기준 칸(A·B열)과 1행은 보호하지 않아서, 항목을 고치는 일은 그대로 할 수 있습니다.
 *  - 이 스크립트가 쓰는 값은 경고 없이 들어갑니다.
 */
function ensureProtection_(sh) {
  var head = sh.getRange(1, 1, 1, Math.min(2, sh.getMaxColumns())).getValues()[0];
  var startCol = dc_hasCriteria(head) ? 3 : 2;
  var rows = sh.getMaxRows() - 1;
  var cols = sh.getMaxColumns() - startCol + 1;
  if (rows < 1 || cols < 1) return;
  var prots = sh.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  for (var i = 0; i < prots.length; i++) {
    if (prots[i].getDescription() !== PROTECT_DESC) continue;
    var r = prots[i].getRange();
    if (r.getRow() === 2 && r.getColumn() === startCol && r.getNumRows() >= rows && r.getNumColumns() >= cols) return; // 이미 충분히 보호됨
    prots[i].remove();
  }
  var prot = sh.getRange(2, startCol, rows, cols).protect();
  prot.setDescription(PROTECT_DESC);
  prot.setWarningOnly(true);
}

/** 숨김 장부 탭은 시트 주인만 고칠 수 있게 잠근다 */
function lockSheet_(sh) {
  var ps = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  for (var i = 0; i < ps.length; i++) if (ps[i].getDescription() === PROTECT_DESC) return;
  var p = sh.protect();
  p.setDescription(PROTECT_DESC);
  var me = Session.getEffectiveUser();
  p.addEditor(me);
  p.removeEditors(p.getEditors().filter(function (e) { return e.getEmail() !== me.getEmail(); }));
  if (p.canDomainEdit()) p.setDomainEdit(false);
}

function protectAll_(ss) {
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.charAt(0) === '_') lockSheet_(sh);
    else if (!sh.isSheetHidden()) ensureProtection_(sh);
  });
}

function protect_() {
  var ss = SpreadsheetApp.getActive();
  hiddenSheet_(LOG_TAB, LOG_HEADER);
  hiddenSheet_(CORR_TAB, CORR_HEADER);
  protectAll_(ss);
  return { ok: true };
}

/* ───────────── 기록 검사 (장부 ↔ 시트 비교) ───────────── */

function readLogRows_(sh) {
  return sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, LOG_HEADER.length).getValues() : [];
}

function verify_() {
  var ss = SpreadsheetApp.getActive();
  var rows = readLogRows_(hiddenSheet_(LOG_TAB, LOG_HEADER));
  var r = dc_verify(readTabs_(ss), rows);
  return { ok: true, at: stamp_(), checked: r.checked, findings: r.findings };
}

function approvedCriteria_(tab, label) {
  var sh = SpreadsheetApp.getActive().getSheetByName(APPROVED_TAB);
  if (!sh) return '';
  var rows = readApprovedRows_(sh);
  for (var i = 0; i < rows.length; i++) if (String(rows[i][0]) === tab && String(rows[i][1]).trim() === label) return String(rows[i][2] || '');
  return '';
}

/** 되돌리기: 장부에 남은 값으로 시트를 복구한다. 성공하면 장부에 남길 줄을, 못 하면 null 을 돌려준다. */
function restoreFinding_(ss, f, rows, stamp, reason, by) {
  var sh = ss.getSheetByName(f.tab);
  if (!sh) return null;
  var fmt = fmt_(), year = new Date().getFullYear();
  var grid = sh.getDataRange().getValues();
  var labels = grid.map(function (row) { return String(row[0]).trim(); });
  var exp = dc_expectedMap(rows);

  if (f.kind === 'changed' || f.kind === 'deleted') {
    var loc = dc_locate(grid, f.date, fmt, year);
    var r = dc_findRow(labels, f.label);
    if (loc.col === null || r < 0) return null;
    sh.getRange(r + 1, loc.col + 1).setValue(dc_cast(f.expected));
    return [[stamp, '복구', f.tab, f.date, f.label, f.expected, f.actual === undefined ? '' : f.actual, reason, by]];
  }
  if (f.kind === 'rowDeleted') {
    var at = dc_findRow(labels, SPECIAL_INSPECTOR);
    var rowNo = at < 0 ? grid.length + 1 : at + 1; // 점검자 행 바로 위 (원래 위치는 알 수 없음)
    sh.insertRowBefore(rowNo);
    sh.getRange(rowNo, 1).setValue(f.label);
    if (dc_hasCriteria(grid[0] || [])) sh.getRange(rowNo, 2).setValue(approvedCriteria_(f.tab, f.label));
    (f.dates || []).forEach(function (d) {
      var l = dc_locate(grid, d, fmt, year);
      var e = exp[f.tab + dc_SEP + d + dc_SEP + f.label];
      if (l.col !== null && e && e.v !== '') sh.getRange(rowNo, l.col + 1).setValue(dc_cast(e.v));
    });
    return [[stamp, '복구', f.tab, '*', f.label, '', '', reason, by]];
  }
  if (f.kind === 'dateDeleted') {
    var loc2 = dc_locate(grid, f.date, fmt, year);
    if (loc2.col !== null) return null;
    sh.insertColumnAfter(loc2.insertAfter + 1);
    var col = loc2.insertAfter + 1;
    sh.getRange(1, col + 1).setValue(f.date).setNumberFormat('M/d');
    (f.cells || []).forEach(function (c) {
      var rr = dc_findRow(labels, c.label);
      if (rr >= 0 && c.value !== '') sh.getRange(rr + 1, col + 1).setValue(dc_cast(c.value));
    });
    return [[stamp, '복구', f.tab, f.date, '*', '', '', reason, by]];
  }
  return null; // 삭제된 탭 등은 구글 시트의 «버전 기록»으로 복원
}

/** 검사 결과 처리: mode 'restore'(장부 값으로 되돌림) 또는 'accept'(시트 값을 인정, 사유 필수) */
function resolve_(b) {
  if (ADMIN_PIN && String(b.pin || '') !== ADMIN_PIN) throw new Error('승인 비밀번호가 맞지 않습니다');
  var mode = b.mode === 'restore' ? 'restore' : 'accept';
  var reason = String(b.reason || '').trim();
  if (mode === 'accept' && !reason) throw new Error('인정 사유를 입력하세요');
  if (!reason) reason = '시트에서 직접 바뀐 값을 장부의 값으로 되돌림';
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActive();
    var logSh = hiddenSheet_(LOG_TAB, LOG_HEADER);
    var rows = readLogRows_(logSh);
    var current = dc_verify(readTabs_(ss), rows).findings;
    var stamp = stamp_(), by = b.inspector || '';
    var out = [], done = 0, skipped = 0;
    (b.items || []).forEach(function (want) {
      var f = dc_findFinding(current, want);
      var res = !f ? null : mode === 'accept' ? dc_acceptRows(f, stamp, reason, by) : restoreFinding_(ss, f, rows, stamp, reason, by);
      if (!res) { skipped++; return; }
      out = out.concat(res);
      done++;
    });
    appendRows_(logSh, out);
    return { ok: true, done: done, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

function folder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function savePhotos_(tab, date, label, photos) {
  var folder = folder_(folder_(DriveApp.getRootFolder(), PHOTO_FOLDER), tab);
  return photos.map(function (p) {
    var name = date + '_' + label.replace(/[\\/:*?"<>|]/g, '') + '_' + String(p.id).slice(0, 6) + '.jpg';
    var f = folder.createFile(Utilities.newBlob(Utilities.base64Decode(p.data), 'image/jpeg', name));
    return { id: p.id, url: f.getUrl() };
  });
}

/* ───────────── 순수 함수 (앱 개발용 가짜 서버와 공유) ───────────── */

function dc_isDate(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }

function dc_pad(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

/** 날짜 칸 값 → 'yyyy-MM-dd' (날짜가 아니면 null) */
function dc_normDate(v, fmt, year) {
  if (dc_isDate(v)) return fmt(v);
  var s = String(v === null || v === undefined ? '' : v).trim();
  var m = s.match(/^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*[.일]?$/);
  if (m) return m[1] + '-' + dc_pad(m[2]) + '-' + dc_pad(m[3]);
  m = s.match(/^(\d{1,2})\s*[/.월-]\s*(\d{1,2})\s*[.일]?$/);
  if (m) return year + '-' + dc_pad(m[1]) + '-' + dc_pad(m[2]);
  return null;
}

function dc_hasCriteria(header) {
  return /기준|단위|유형|방식/.test(String(header[1] || ''));
}

/** 시트 전체 → 항목·날짜·값 */
function dc_read(grid, notes, fmt, year) {
  var header = grid[0] || [];
  var hasCrit = dc_hasCriteria(header);
  var dates = [];
  for (var c = hasCrit ? 2 : 1; c < header.length; c++) {
    var d = dc_normDate(header[c], fmt, year);
    if (d) dates.push({ col: c, date: d });
  }
  var items = [], inspector = {}, time = {};
  for (var r = 1; r < grid.length; r++) {
    var label = String(grid[r][0] === null || grid[r][0] === undefined ? '' : grid[r][0]).trim();
    if (!label) continue;
    var vals = {}, photos = {};
    for (var i = 0; i < dates.length; i++) {
      var dc = dates[i];
      var v = grid[r][dc.col];
      if (v !== '' && v !== null && v !== undefined) {
        if (dc_isDate(v)) v = label === SPECIAL_TIME ? String(v.getHours()) + ':' + dc_pad(v.getMinutes()) : fmt(v);
        vals[dc.date] = v;
      }
      var n = notes && notes[r] && notes[r][dc.col];
      if (n) {
        var urls = String(n).match(/https?:\/\/\S+/g);
        if (urls) photos[dc.date] = urls;
      }
    }
    if (label === SPECIAL_INSPECTOR) inspector = vals;
    else if (label === SPECIAL_TIME) time = vals;
    else items.push({ row: r + 1, label: label, criteria: hasCrit ? String(grid[r][1] || '').trim() : '', values: vals, photos: photos });
  }
  return { hasCriteria: hasCrit, dates: dates.map(function (d) { return d.date; }), items: items, inspector: inspector, time: time };
}

/** 그 날짜의 열 위치. 없으면 날짜 순서에 맞게 넣을 위치(insertAfter) */
function dc_locate(grid, date, fmt, year) {
  var header = grid[0] || [];
  var start = dc_hasCriteria(header) ? 2 : 1;
  var insertAfter = start - 1;
  for (var c = start; c < header.length; c++) {
    var d = dc_normDate(header[c], fmt, year);
    if (!d) continue;
    if (d === date) return { col: c, insertAfter: c };
    if (d < date) insertAfter = c;
  }
  return { col: null, insertAfter: insertAfter };
}

function dc_findRow(labels, label) {
  var want = String(label).trim();
  for (var i = 1; i < labels.length; i++) if (String(labels[i]).trim() === want) return i;
  return -1;
}

/* ── 승인 목록 (순수 함수) ── */

/** 처음 연결: 지금 시트의 모든 항목을 승인된 것으로 시작 */
function dc_initApproved(tabs, stamp) {
  var rows = [];
  tabs.forEach(function (t) {
    t.items.forEach(function (it) { rows.push([t.tab, it.label, it.criteria || '', stamp]); });
  });
  return rows;
}

/** 승인 탭 행 → [{ tab, items:[{label, criteria}] }] (순서 유지) */
function dc_groupApproved(rows) {
  var order = [], map = {};
  rows.forEach(function (r) {
    var tab = String(r[0]);
    if (!tab) return;
    if (!map[tab]) { map[tab] = []; order.push(tab); }
    map[tab].push({ label: String(r[1]), criteria: String(r[2] === null || r[2] === undefined ? '' : r[2]) });
  });
  return order.map(function (t) { return { tab: t, items: map[t] }; });
}

/** 승인: 해당 탭의 목록을 통째로 교체하고, 사라진 탭은 지운다 */
function dc_applyApproval(rows, tabs, removed, stamp) {
  var drop = {};
  tabs.forEach(function (t) { drop[t.tab] = true; });
  removed.forEach(function (t) { drop[t] = true; });
  var keep = rows.filter(function (r) { return !drop[String(r[0])]; });
  tabs.forEach(function (t) {
    t.items.forEach(function (it) { keep.push([t.tab, it.label, it.criteria || '', stamp]); });
  });
  return keep;
}

/* ── 잠금·정정 (순수 함수) ── */

/**
 * 칸에 값을 쓸 수 있는지 판단
 *   'write'  : 비어 있는 칸에 새 값 → 기록
 *   'same'   : 이미 같은 값이거나 새 값이 비어 있음 → 그대로 둠 (빈 값으로 지우지 못함)
 *   'locked' : 이미 다른 값이 기록됨 → 덮어쓰지 않음 (정정으로만 변경)
 *   'skip'   : 둘 다 비어 있음
 */
function dc_decide(cur, next) {
  var c = cur === null || cur === undefined ? '' : cur;
  var n = next === null || next === undefined ? '' : next;
  if (c === '') return n === '' ? 'skip' : 'write';
  if (n === '') return 'same';
  if (String(c).trim() === String(n).trim()) return 'same';
  var cn = Number(c), nn = Number(n); // 16.5 와 16.50 은 같은 값
  return !isNaN(cn) && !isNaN(nn) && cn === nn ? 'same' : 'locked';
}

/** 정정 탭 행 → [{ at, tab, date, label, from, to, reason, by }] */
function dc_groupCorrections(rows) {
  return rows
    .filter(function (r) { return String(r[1]) !== ''; })
    .map(function (r) {
      return { at: String(r[0]), tab: String(r[1]), date: String(r[2]), label: String(r[3]), from: String(r[4]), to: String(r[5]), reason: String(r[6]), by: String(r[7]) };
    });
}

/* ── 기록 검사 (순수 함수) ── */

var dc_SEP = '\u0001';

/** 값 비교: 글자가 같거나, 둘 다 숫자이고 값이 같으면 같은 값 */
function dc_same(a, b) {
  var x = String(a === null || a === undefined ? '' : a).trim();
  var y = String(b === null || b === undefined ? '' : b).trim();
  if (x === y) return true;
  var nx = Number(x), ny = Number(y);
  return x !== '' && y !== '' && !isNaN(nx) && !isNaN(ny) && nx === ny;
}

/** 장부(글자로 저장됨)의 숫자 모양 값은 숫자로 되돌려 시트에 쓴다 */
function dc_cast(v) {
  var s = String(v === null || v === undefined ? '' : v).trim();
  return s !== '' && !isNaN(Number(s)) ? Number(s) : v;
}

/** 장부 → 칸별 «마지막으로 기록된 값» (입력·정정·직접수정 확인) */
function dc_expectedMap(rows) {
  var exp = {};
  rows.forEach(function (r) {
    var kind = String(r[1]);
    if (kind !== '입력' && kind !== '정정' && kind !== '직접수정 확인') return;
    var tab = String(r[2]), date = String(r[3]), label = String(r[4]).trim();
    if (!tab || date === '*' || label === '*' || label === '') return;
    exp[tab + dc_SEP + date + dc_SEP + label] = { v: r[5] === null || r[5] === undefined ? '' : String(r[5]) };
  });
  return exp;
}

/**
 * 장부와 시트를 비교해 «앱을 거치지 않고 시트에서 직접 바뀐 것»을 찾는다.
 *   changed     : 값이 장부와 다름
 *   deleted     : 장부에 있는 값이 시트에서 지워짐
 *   unlogged    : 장부에 없는 값이 시트에 직접 입력됨 (장부가 시작된 날짜 이후)
 *   rowDeleted  : 점검항목 행이 통째로 지워짐
 *   dateDeleted : 날짜 열이 통째로 지워짐
 *   tabDeleted  : 탭이 지워짐
 * «직접수정 확인» 으로 인정된 것은 다시 나타나지 않는다.
 */
function dc_verify(tabs, rows) {
  var exp = dc_expectedMap(rows);
  var ackRow = {}, ackDate = {}, ackTab = {}, logStart = {};
  rows.forEach(function (r) {
    var kind = String(r[1]), tab = String(r[2]), date = String(r[3]), label = String(r[4]).trim();
    if (!tab) return;
    if (kind === '직접수정 확인') {
      if (date === '*' && label === '') ackTab[tab] = true;
      else if (date === '*') ackRow[tab + dc_SEP + label] = true;
      else if (label === '*') ackDate[tab + dc_SEP + date] = true;
    }
    if ((kind === '입력' || kind === '정정') && date !== '*' && (!logStart[tab] || date < logStart[tab])) logStart[tab] = date;
  });

  var byTab = {};
  tabs.forEach(function (t) { byTab[t.tab] = t; });
  var findings = [], checked = 0, tabGone = {}, rowGone = {}, dateGone = {};

  Object.keys(exp).forEach(function (k) {
    var p = k.split(dc_SEP), tab = p[0], date = p[1], label = p[2], v = exp[k].v;
    if (ackTab[tab]) return;
    var t = byTab[tab];
    if (!t) { tabGone[tab] = (tabGone[tab] || 0) + 1; return; }
    if (t.dates.indexOf(date) < 0) {
      if (v !== '' && !ackDate[tab + dc_SEP + date]) {
        var dg = dateGone[tab + dc_SEP + date] || (dateGone[tab + dc_SEP + date] = { tab: tab, date: date, cells: [] });
        dg.cells.push({ label: label, value: v });
      }
      return;
    }
    var item = null;
    for (var i = 0; i < t.items.length; i++) if (String(t.items[i].label).trim() === label) { item = t.items[i]; break; }
    if (!item) {
      if (v !== '' && !ackRow[tab + dc_SEP + label]) {
        var rg = rowGone[tab + dc_SEP + label] || (rowGone[tab + dc_SEP + label] = { tab: tab, label: label, dates: [] });
        rg.dates.push(date);
      }
      return;
    }
    if (ackRow[tab + dc_SEP + label]) return;
    checked++;
    var cell = item.values[date];
    var has = cell !== undefined && cell !== null && String(cell).trim() !== '';
    if (v === '') {
      if (has) findings.push({ kind: 'unlogged', tab: tab, date: date, label: label, actual: cell });
    } else if (!has) {
      findings.push({ kind: 'deleted', tab: tab, date: date, label: label, expected: v });
    } else if (!dc_same(cell, v)) {
      findings.push({ kind: 'changed', tab: tab, date: date, label: label, expected: v, actual: cell });
    }
  });

  tabs.forEach(function (t) {
    var start = logStart[t.tab];
    if (!start || ackTab[t.tab]) return;
    t.items.forEach(function (it) {
      var label = String(it.label).trim();
      if (ackRow[t.tab + dc_SEP + label]) return;
      Object.keys(it.values).forEach(function (date) {
        if (date < start || exp[t.tab + dc_SEP + date + dc_SEP + label] !== undefined) return;
        if (ackDate[t.tab + dc_SEP + date]) return;
        if (String(it.values[date]).trim() === '') return;
        findings.push({ kind: 'unlogged', tab: t.tab, date: date, label: label, actual: it.values[date] });
      });
    });
  });

  Object.keys(rowGone).forEach(function (k) { rowGone[k].kind = 'rowDeleted'; rowGone[k].dates.sort(); findings.push(rowGone[k]); });
  Object.keys(dateGone).forEach(function (k) { dateGone[k].kind = 'dateDeleted'; findings.push(dateGone[k]); });
  Object.keys(tabGone).forEach(function (tab) { findings.push({ kind: 'tabDeleted', tab: tab, count: tabGone[tab] }); });
  findings.sort(function (a, b) { return (a.tab + (a.date || '') + (a.label || '')).localeCompare(b.tab + (b.date || '') + (b.label || '')); });
  return { checked: checked, findings: findings.slice(0, 300) };
}

/** 요청한 항목과 같은 검사 결과를 찾는다 */
function dc_findFinding(findings, want) {
  for (var i = 0; i < findings.length; i++) {
    var f = findings[i];
    if (f.kind === want.kind && f.tab === want.tab && (f.date || '') === (want.date || '') && (f.label || '') === (want.label || '')) return f;
  }
  return null;
}

/** «시트 값 인정»: 장부에 남길 줄. 이후 검사에서 같은 건은 나타나지 않는다. */
function dc_acceptRows(f, stamp, reason, by) {
  var k = '직접수정 확인';
  if (f.kind === 'changed' || f.kind === 'deleted' || f.kind === 'unlogged') {
    return [[stamp, k, f.tab, f.date, f.label, f.actual === undefined || f.actual === null ? '' : f.actual, f.expected || '', reason, by]];
  }
  if (f.kind === 'rowDeleted') return [[stamp, k, f.tab, '*', f.label, '', '', reason, by]];
  if (f.kind === 'dateDeleted') return [[stamp, k, f.tab, f.date, '*', '', '', reason, by]];
  if (f.kind === 'tabDeleted') return [[stamp, k, f.tab, '*', '', '', '', reason, by]];
  return null;
}
