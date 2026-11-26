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

function read_() {
  var ss = SpreadsheetApp.getActive();
  var fmt = fmt_();
  var year = new Date().getFullYear();
  var tabs = ss.getSheets()
    .filter(function (s) { return !s.isSheetHidden() && s.getName().charAt(0) !== '_'; })
    .map(function (sh) {
      var rng = sh.getDataRange();
      var r = dc_read(rng.getValues(), rng.getNotes(), fmt, year);
      r.tab = sh.getName();
      return r;
    });
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
    return { ok: true, column: col + 1, missing: missing, photos: uploaded, locked: locked };
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
