/**
 * DayByCheck ↔ 구글 시트 연결 스크립트
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
var PROTECT_DESC = '데일리체크 기록 보호'; // 스크립트가 거는 시트 보호의 이름 (기존 시트의 보호를 찾는 기준이라 이름 변경 후에도 그대로 둠)
var PHOTO_FOLDER = '데일리체크 사진'; // 기존 사진이 있는 드라이브 폴더라 이름 변경 후에도 그대로 둠
var SPECIAL_INSPECTOR = '점검자';
var SPECIAL_TIME = '점검시각';
var SPECIAL_REMARK = '특이사항'; // 점검표에 없는 이상을 적는 행 (없으면 첫 저장 때 자동으로 만든다)
var PHOTO_LOG = '_사진기록';    // 사진 한 장 = 한 줄 (칸 안 미리보기 + 원본 링크)
var PHOTO_COLOR = '#fce8b2';   // 사진이 있는 칸 배경 (연한 주황)

/* ───────────── 구글 시트에서 실행되는 부분 ───────────── */

function doGet() {
  return json_({ ok: true, message: 'DayByCheck 연결 스크립트가 작동 중입니다. 이 주소를 앱에 넣으세요.' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (TOKEN && body.token !== TOKEN) throw new Error('비밀번호가 맞지 않습니다');
    if (body.action === 'read') return json_(read_(body));
    if (body.action === 'readTabs') return json_(readTabsNamed_(body));
    if (body.action === 'submit') return json_(submit_(body));
    if (body.action === 'approve') return json_(approve_(body));
    if (body.action === 'correct') return json_(correct_(body));
    if (body.action === 'verify') return json_(verify_(body));
    if (body.action === 'resolve') return json_(resolve_(body));
    if (body.action === 'protect') return json_(protect_());
    if (body.action === 'report') {
      var rep = makeReport_(body.tab, body.month);
      rep.ok = true;
      return json_(rep);
    }
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

/**
 * 시트의 탭들을 읽는다. recentFrom('yyyy-MM')을 주면 그보다 오래된 월별 탭은 이름만(lite) 돌려준다.
 * (월별 탭이 해마다 쌓여도 동기화가 느려지지 않도록)
 */
function readTabs_(ss, recentFrom) {
  var fmt = fmt_();
  var year = new Date().getFullYear();
  var now = new Date();
  var ny = now.getFullYear(), nm = now.getMonth() + 1;
  return ss.getSheets()
    .filter(function (s) { return !s.isSheetHidden() && s.getName().charAt(0) !== '_'; })
    .map(function (sh) {
      var name = sh.getName();
      var ym = dc_tabYM(dc_parseTab(name), ny, nm);
      if (recentFrom && ym && ym < recentFrom) return { tab: name, lite: true, ym: ym };
      var rng = sh.getDataRange();
      var r = dc_read(rng.getValues(), rng.getNotes(), fmt, year);
      r.tab = name;
      r.ym = ym;
      return r;
    });
}

/** 지난 달 탭을 필요할 때 읽는다 (보고서·기록에서 오래된 달을 볼 때) */
function readTabsNamed_(b) {
  var ss = SpreadsheetApp.getActive();
  var want = {};
  (b.tabs || []).forEach(function (n) { want[n] = true; });
  var tabs = readTabs_(ss, null).filter(function (t) { return want[t.tab]; });
  return { ok: true, tabs: tabs };
}

function read_(b) {
  var ss = SpreadsheetApp.getActive();
  var firstTime = !ss.getSheetByName(APPROVED_TAB); // 처음 연결할 때는 전체를 읽어 확정본을 만든다
  var tabs = readTabs_(ss, firstTime ? null : (b && b.recent) || null);
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
  // auto: 새 달 탭이 이미 확정된 다른 탭과 똑같은 모양일 때만 비밀번호 없이 확정 (바뀐 것이 없으므로)
  var auto = b.auto === true;
  if (!auto && ADMIN_PIN && String(b.pin || '') !== ADMIN_PIN) throw new Error('승인 비밀번호가 맞지 않습니다');
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActive().getSheetByName(APPROVED_TAB);
    if (!sh) throw new Error('먼저 앱에서 동기화하세요');
    var rows = readApprovedRows_(sh);
    if (auto) (b.tabs || []).forEach(function (t) { if (!dc_sameStructure(rows, t.tab, t.items)) throw new Error('자동으로 확정할 수 없는 변경입니다'); });
    writeApproved_(sh, dc_applyApproval(rows, b.tabs || [], b.removed || [], stamp_()));
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 새 달 탭 만들기: 지난달 탭을 복사하고 날짜별 값(C열부터)만 비운다.
 * 점검사항·기준·서식은 그대로 이어지고, 확정본(_승인본)도 지난달 것을 이어받아 다시 승인을 묻지 않는다.
 */
function createMonthTab_(ss, from, name) {
  var src = ss.getSheetByName(from);
  if (!src) throw new Error('새 달 탭을 만들 기준 탭 "' + from + '" 이 없습니다');
  var sh = src.copyTo(ss);
  sh.setName(name);
  var head = src.getRange(1, 1, 1, Math.min(2, src.getMaxColumns())).getValues()[0];
  var startCol = dc_hasCriteria(head) ? 3 : 2;
  if (sh.getMaxColumns() >= startCol) {
    sh.getRange(1, startCol, sh.getMaxRows(), sh.getMaxColumns() - startCol + 1).clearContent().clearNote();
  }
  try { ss.setActiveSheet(sh); ss.moveActiveSheet(src.getIndex() + 1); } catch (e) { /* 위치를 못 옮겨도 계속 */ }
  var ap = ss.getSheetByName(APPROVED_TAB);
  if (ap) writeApproved_(ap, dc_copyApproved(readApprovedRows_(ap), from, name, stamp_()));
  try { ensureProtection_(sh); } catch (e) { /* 보호를 걸지 못해도 계속 */ }
  return sh;
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
    var ss0 = SpreadsheetApp.getActive();
    var sh = ss0.getSheetByName(b.tab);
    if (!sh && b.createFrom) sh = createMonthTab_(ss0, b.createFrom, b.tab); // 새 달의 첫 입력: 지난달 탭을 복사해 새 탭을 만든다
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
    // «이상 발견» 사진·메모용 특이사항 행: 없으면 점검자 행 바로 위에 만든다 (labels 의 n번째 = 시트 n+1행)
    var wantsRemark = (b.entries || []).some(function (en) { return String(en.label).trim() === SPECIAL_REMARK; });
    if (wantsRemark && labels.indexOf(SPECIAL_REMARK) < 0) {
      var at = labels.indexOf(SPECIAL_INSPECTOR);
      sh.insertRowBefore(at + 1);
      sh.getRange(at + 1, 1).setValue(SPECIAL_REMARK);
      labels.splice(at, 0, SPECIAL_REMARK);
      grid.splice(at, 0, [SPECIAL_REMARK]);
    }

    var missing = [];
    var uploaded = [];
    var locked = [];   // 이미 다른 값이 기록되어 있어 건너뛴 항목
    var logRows = [];
    var photoRows = []; // _사진기록 탭에 줄 한 장씩
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
        var add = dc_photoNote(saved.length, b.inspector, b.time, en.note, saved.map(function (p) { return p.url; }));
        cell.setNote(note ? note + '\n\n' + add : add);
        cell.setBackground(PHOTO_COLOR); // 사진이 있는 칸은 연한 주황 (값은 그대로)
        en.photos.forEach(function (p, i) {
          photoRows.push({ date: b.date, time: b.time || '', tab: b.tab, label: en.label, value: val, note: en.note || '', inspector: b.inspector || '', url: saved[i].url, thumb: p.thumb });
        });
      }
    });
    appendRows_(hiddenSheet_(LOG_TAB, LOG_HEADER), logRows);
    if (photoRows.length) { try { logPhotos_(photoRows); } catch (e) { /* 사진 기록 탭은 보조 — 입력은 이미 저장됨 */ } }
    try { ensureProtection_(sh); } catch (e) { /* 보호를 걸지 못해도 입력은 저장됨 */ }
    return { ok: true, tab: b.tab, column: col + 1, missing: missing, photos: uploaded, locked: locked };
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

/** 기본은 최근 3개월 탭만 검사 (all: true 면 전체 기간) */
function verifyTabs_(ss, all) {
  var d = new Date();
  var tabs = readTabs_(ss, all ? null : dc_recentFrom(d.getFullYear(), d.getMonth() + 1));
  var skip = {};
  tabs.forEach(function (t) { if (t.lite) skip[t.tab] = true; });
  return { tabs: tabs.filter(function (t) { return !t.lite; }), skip: skip };
}

function verify_(b) {
  var ss = SpreadsheetApp.getActive();
  var rows = readLogRows_(hiddenSheet_(LOG_TAB, LOG_HEADER));
  var vt = verifyTabs_(ss, !!(b && b.all));
  var r = dc_verify(vt.tabs, rows, vt.skip);
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
    var vt = verifyTabs_(ss, !!b.all);
    var current = dc_verify(vt.tabs, rows, vt.skip).findings;
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
    var vals = {}, photos = {}, memos = {};
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
        var ms = dc_noteMemos(n);
        if (ms.length) memos[dc.date] = ms.join(' / ');
      }
    }
    if (label === SPECIAL_INSPECTOR) inspector = vals;
    else if (label === SPECIAL_TIME) time = vals;
    else items.push({ row: r + 1, label: label, criteria: hasCrit ? String(grid[r][1] || '').trim() : '', values: vals, photos: photos, memos: memos });
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
function dc_verify(tabs, rows, skip) {
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
    if (ackTab[tab] || (skip && skip[tab])) return; // 읽지 않은(오래된) 탭은 검사하지 않음
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

/* ── 월별 탭 (순수 함수) ── */

/**
 * 탭 이름에서 월을 읽는다.  «설비 2026-11», «설비 2026.11», «2026년 11월», «26년 11월», «설비 11월» ...
 * 돌려주는 값: { series: 월을 뺀 이름, y: 연도(모르면 0), m: 월(없으면 0), token: 이름 속 월 표기 }
 * 월이 없는 이름은 series 가 이름 그대로이고 m 이 0 이다. (이 함수는 앱의 src/sheet/series.ts parseTab 과 같은 규칙)
 */
function dc_parseTab(name) {
  var s = String(name === null || name === undefined ? '' : name).trim();
  var m, y = 0, mo = 0, token = '';
  m = s.match(/(\d{4})\s*([-./년])\s*(\d{1,2})\s*(월)?/);
  if (m && +m[3] >= 1 && +m[3] <= 12) { y = +m[1]; mo = +m[3]; token = m[0]; }
  else {
    m = s.match(/(\d{2})\s*년\s*(\d{1,2})\s*월/);
    if (m && +m[2] >= 1 && +m[2] <= 12) { y = 2000 + +m[1]; mo = +m[2]; token = m[0]; }
    else {
      m = s.match(/(\d{1,2})\s*월/);
      if (m && +m[1] >= 1 && +m[1] <= 12) { mo = +m[1]; token = m[0]; }
    }
  }
  if (!mo) return { series: s, y: 0, m: 0, token: '' };
  var rest = s.replace(token, ' ').replace(/\s+/g, ' ').replace(/^[\s_\-·.,\/]+|[\s_\-·.,\/]+$/g, '');
  return { series: rest, y: y, m: mo, token: token };
}

/** 월 («yyyy-MM»). 연도가 없는 이름(«11월»)은 지금 기준으로 가장 그럴듯한 해를 고른다: 과거는 11개월, 미래는 1개월까지 */
function dc_tabYM(p, nowY, nowM) {
  if (!p.m) return '';
  var y = p.y || (p.m > nowM + 1 ? nowY - 1 : nowY);
  return y + '-' + dc_pad(p.m);
}

/** 최근 3개월(이번 달 포함)의 시작 월 */
function dc_recentFrom(y, m) {
  m -= 2;
  if (m < 1) { m += 12; y -= 1; }
  return y + '-' + dc_pad(m);
}

/** 확정본 행에서 fromTab 의 항목을 toTab 으로 복사 (toTab 이 이미 있으면 그대로) */
function dc_copyApproved(rows, fromTab, toTab, stamp) {
  var has = rows.some(function (r) { return String(r[0]) === toTab; });
  if (has) return rows;
  var add = rows.filter(function (r) { return String(r[0]) === fromTab; }).map(function (r) { return [toTab, r[1], r[2], stamp]; });
  return rows.concat(add);
}

/** tab 이 아닌 다른 확정 탭 중에 items 와 점검사항·기준이 똑같은 것이 있는가 */
function dc_sameStructure(rows, tab, items) {
  if (!items || !items.length) return false;
  return dc_groupApproved(rows).some(function (g) {
    if (g.tab === tab || g.items.length !== items.length) return false;
    for (var i = 0; i < items.length; i++) {
      if (String(g.items[i].label).trim() !== String(items[i].label).trim()) return false;
      if (String(g.items[i].criteria || '').trim() !== String(items[i].criteria || '').trim()) return false;
    }
    return true;
  });
}

/* ───────────── 시트 메뉴 · 자동 실행 · 월간 보고서 ───────────── */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('DayByCheck')
    .addItem('이번 달 보고서 만들기', 'menuThisMonth')
    .addItem('지난달 보고서 만들기', 'menuLastMonth')
    .addSeparator()
    .addItem('매일 아침 보고서 자동 갱신 켜기', 'menuAutoOn')
    .addItem('자동 갱신 끄기', 'menuAutoOff')
    .addToUi();
}

function menuThisMonth() { menuReports_(monthOf_(0)); }
function menuLastMonth() { menuReports_(monthOf_(-1)); }

function menuReports_(month) {
  var made = reportAll_(month);
  SpreadsheetApp.getUi().alert(made.length ? month + ' 보고서를 만들었습니다:\n' + made.join('\n') : '보고서를 만들 점검표 탭이 없습니다.');
}

function menuAutoOn() {
  menuAutoOff_(true);
  ScriptApp.newTrigger('dailycheckAuto').timeBased().everyDays(1).atHour(6).create();
  dailycheckAuto();
  SpreadsheetApp.getUi().alert('켰습니다. 매일 아침 6시쯤 이번 달 보고서가 새로 갱신되고, 매월 1~3일에는 지난달 보고서도 마무리됩니다.');
}

function menuAutoOff() { menuAutoOff_(false); }

function menuAutoOff_(silent) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailycheckAuto') ScriptApp.deleteTrigger(t);
  });
  if (!silent) SpreadsheetApp.getUi().alert('자동 갱신을 껐습니다.');
}

/** 매일 자동 실행: 이번 달 갱신 + 월초(1~3일)에는 지난달도 마무리 */
function dailycheckAuto() {
  reportAll_(monthOf_(0));
  var day = Number(Utilities.formatDate(new Date(), tz_(), 'd'));
  if (day <= 3) reportAll_(monthOf_(-1));
}

function monthOf_(delta) {
  var now = new Date();
  var d = new Date(now.getFullYear(), now.getMonth() + delta, 1);
  return Utilities.formatDate(d, tz_(), 'yyyy-MM');
}

/** 그 달의 보고서 만들기: 월별 탭은 그 달 탭만, 월이 없는 탭은 항상. 숨김·_ 탭 제외 */
function reportAll_(month) {
  var now = new Date();
  var names = [];
  SpreadsheetApp.getActive().getSheets().forEach(function (s) {
    var n = s.getName();
    if (s.isSheetHidden() || n.charAt(0) === '_') return;
    var p = dc_parseTab(n);
    if (p.m && dc_tabYM(p, now.getFullYear(), now.getMonth() + 1) !== month) return;
    names.push(n);
  });
  return names.map(function (n) { return makeReport_(n, month).sheet; });
}

/** _사진기록 탭에 한 장씩 한 줄 (칸 안 미리보기 + 원본 링크) */
function logPhotos_(rows) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(PHOTO_LOG);
  if (!sh) {
    sh = ss.insertSheet(PHOTO_LOG, ss.getNumSheets());
    sh.getRange(1, 1, 1, 9).setValues([['날짜', '시각', '점검표', '항목', '그때 값', '메모', '점검자', '사진', '원본']])
      .setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
    sh.setColumnWidth(6, 220);
    sh.setColumnWidth(8, 120);
    sh.setTabColor('#f4b400');
  }
  rows.forEach(function (p) {
    sh.appendRow([p.date, p.time ? "'" + p.time : '', p.tab, p.label, p.value, p.note, p.inspector, '', '']);
    var r = sh.getLastRow();
    sh.getRange(r, 1).setNumberFormat('yyyy-MM-dd');
    if (p.thumb) {
      try {
        // 사진을 공개하지 않고 칸 안에 직접 넣는다 (작은 미리보기)
        var img = SpreadsheetApp.newCellImage().setSourceUrl('data:image/jpeg;base64,' + p.thumb).setAltTextTitle(p.label).build();
        sh.getRange(r, 8).setValue(img);
        sh.setRowHeight(r, 90);
      } catch (e) {
        sh.getRange(r, 8).setValue('(미리보기 없음)');
      }
    }
    sh.getRange(r, 9).setRichTextValue(SpreadsheetApp.newRichTextValue().setText('열기').setLinkUrl(p.url).build());
  });
}

/* ───────────── 월간 보고서 탭 ───────────── */

function makeReport_(tabName, month) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) throw new Error('보고서 달이 올바르지 않습니다: ' + month);
  var ss = SpreadsheetApp.getActive();
  var src = ss.getSheetByName(tabName);
  if (!src) throw new Error('시트에 "' + tabName + '" 탭이 없습니다');
  var tz = tz_();
  var rng = src.getDataRange();
  var data = dc_read(rng.getValues(), rng.getNotes(), fmt_(), Number(month.slice(0, 4)));
  var now = new Date();
  var rep = dc_reportGrid(tabName, data, month, Utilities.formatDate(now, tz, 'yyyy-MM-dd'), Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm'));
  var m = rep.meta;

  var sh = ss.getSheetByName(rep.sheetName) || ss.insertSheet(rep.sheetName, ss.getNumSheets());
  sh.clear(); // 내용·서식만 지우고 그래프는 남겨 둔다 (슬라이드 연결 유지)
  sh.setTabColor('#4285f4');

  var rows = rep.rows.map(function (r) { return r.slice(); });
  var dl = m.daily;
  for (var i = 0; i < dl.count; i++) {
    var ds = rows[dl.first + i][0].split('-');
    rows[dl.first + i][0] = new Date(Number(ds[0]), Number(ds[1]) - 1, Number(ds[2]));
  }
  sh.getRange(1, 1, rows.length, rep.width).setValues(rows);

  sh.getRange(m.title + 1, 1).setFontSize(16).setFontWeight('bold');
  sh.getRange(m.sub + 1, 1).setFontColor('#80868b');
  m.sections.forEach(function (r) { sh.getRange(r + 1, 1, 1, rep.width).setBackground('#e8f0fe').setFontWeight('bold'); });
  m.headers.forEach(function (r) { sh.getRange(r + 1, 1, 1, rep.width).setBackground('#f1f3f4').setFontWeight('bold'); });
  m.bad.forEach(function (rc) { sh.getRange(rc[0] + 1, rc[1] + 1).setFontColor('#d93025').setFontWeight('bold'); });
  m.photo.forEach(function (rc) { sh.getRange(rc[0] + 1, rc[1] + 1).setBackground(PHOTO_COLOR); });
  m.links.forEach(function (l) {
    sh.getRange(l.r + 1, l.c + 1).setRichTextValue(SpreadsheetApp.newRichTextValue().setText(l.text).setLinkUrl(l.url).build());
  });
  if (dl.count) sh.getRange(dl.first + 1, 1, dl.count, 1).setNumberFormat('M/d (ddd)');
  sh.setColumnWidth(1, 150);
  if (rep.width > 1) sh.autoResizeColumns(2, rep.width - 1);

  // 그래프: 숫자 항목마다 날짜별 선 그래프. 제목이 같은 그래프는 새로 만들지 않고 고쳐 쓴다.
  var old = {};
  sh.getCharts().forEach(function (c) { old[String(c.getOptions().get('title'))] = c; });
  var chartCol = rep.width + 2;
  var warnings = [];
  dl.cols.forEach(function (dc, k) {
    if (!dl.count) return;
    try {
      var prev = old[dc.label];
      delete old[dc.label];
      var b = (prev ? prev.modify() : sh.newChart())
        .setChartType(Charts.ChartType.LINE)
        .clearRanges()
        .addRange(sh.getRange(dl.header + 1, 1, dl.count + 1, 1))
        .addRange(sh.getRange(dl.header + 1, dc.col + 1, dl.count + 1, 1))
        .setNumHeaders(1)
        .setPosition(1 + k * 16, chartCol, 0, 0)
        .setOption('title', dc.label)
        .setOption('legend', { position: 'none' })
        .setOption('pointSize', 6)
        .setOption('width', 560)
        .setOption('height', 300)
        .setOption('hAxis', { format: 'M/d' })
        .setOption('vAxis', { title: dc.crit ? '기준 ' + dc.crit : '' });
      if (prev) sh.updateChart(b.build());
      else sh.insertChart(b.build());
    } catch (e) {
      warnings.push(dc.label + ' 그래프: ' + e.message);
    }
  });
  Object.keys(old).forEach(function (t) { sh.removeChart(old[t]); });

  return { sheet: rep.sheetName, url: ss.getUrl() + '#gid=' + sh.getSheetId(), warnings: warnings };
}

/** 사진 칸 메모 글: 첫 줄 요약, 둘째 줄 "설명", 그 아래 링크 */
function dc_photoNote(count, inspector, time, note, urls) {
  var head = '📷 사진 ' + count + '장' + (inspector || time ? ' · ' + [inspector, time].filter(function (x) { return x; }).join(' ') : '');
  var lines = [head];
  if (note) lines.push('"' + String(note).replace(/\s*\n\s*/g, ' ') + '"');
  return lines.concat(urls).join('\n');
}

/** 메모 글 → 사진 설명들 ("…" 줄) */
function dc_noteMemos(n) {
  var out = [];
  String(n || '').split('\n').forEach(function (line) {
    var m = line.trim().match(/^"(.*)"$/);
    if (m && m[1]) out.push(m[1]);
  });
  return out;
}

/* ── 항목 해석 (앱의 src/sheet/parse.ts 와 같은 규칙) ── */

function dc_num(s) {
  if (typeof s === 'number') return s;
  var t = String(s === null || s === undefined ? '' : s).replace(/,/g, '').trim();
  if (!/^-?\d*\.?\d+$/.test(t)) return null;
  return parseFloat(t);
}

function dc_splitUnit(label) {
  var m = String(label).match(/^(.*?)\s*[(（]\s*([^()（）]+?)\s*[)）]\s*$/);
  return m && m[1] ? { name: m[1].trim(), unit: m[2] } : { name: String(label).trim(), unit: '' };
}

function dc_range(c) {
  var s = String(c).replace(/\s+/g, ' ').trim();
  var m = s.match(/^(-?[\d.,]+)\s*[~∼〜]\s*(-?[\d.,]+)$/);
  if (m) return { min: dc_num(m[1]), max: dc_num(m[2]) };
  var out = { min: null, max: null };
  var re = /(-?[\d.,]+)\s*(이상|초과|이하|미만)|(>=|≥|>|<=|≤|<)\s*(-?[\d.,]+)/g;
  var mm;
  while ((mm = re.exec(s))) {
    var v = dc_num(mm[1] !== undefined ? mm[1] : mm[4]);
    var op = mm[2] || mm[3];
    if (v === null) continue;
    if (['이상', '초과', '>=', '≥', '>'].indexOf(op) >= 0) out.min = v;
    else out.max = v;
  }
  return out.min !== null || out.max !== null ? out : null;
}

var DC_PAIRS = [
  ['on', 'off'], ['up', 'down'], ['yes', 'no'], ['예', '아니오'], ['o', 'x'], ['정상', '이상'],
  ['양호', '불량'], ['ok', 'ng'], ['합격', '불합격'], ['적합', '부적합'], ['유', '무'],
];
var DC_NORMAL = ['o', '정상', '양호', 'ok', '합격', '적합'];

/** 한 행 → { type: number|choice|memo, unit, min, max, bad[], crit } */
function dc_kind(label, criteria, values) {
  var unit = dc_splitUnit(label).unit;
  var c = String(criteria || '').replace(/사진|📷/g, '').replace(/필수/g, '').replace(/^[\s,·/]+|[\s,·/]+$/g, '').trim();
  var k = { type: 'memo', unit: unit, min: null, max: null, bad: [], crit: c };
  if (/^(특이사항|비고|메모)$/.test(String(label).trim())) return k;
  if (c && c.indexOf('/') >= 0 && !dc_range(c)) {
    var opts = c.split('/').map(function (s) { return s.trim(); }).filter(function (s) { return s; });
    if (opts.length >= 2) { k.type = 'choice'; k.bad = opts.slice(1); return k; }
  }
  var r = c ? dc_range(c) : null;
  if (r) { k.type = 'number'; k.min = r.min; k.max = r.max; return k; }
  if (/숫자|수치/.test(c) || unit) { k.type = 'number'; return k; }
  if (/메모|글|텍스트/.test(c)) return k;
  var vals = values.filter(function (v) { return v !== '' && v !== null && v !== undefined; });
  if (vals.length && vals.every(function (v) { return dc_num(v) !== null; })) { k.type = 'number'; return k; }
  var low = vals.map(function (v) { return String(v).trim().toLowerCase(); });
  var pair = null;
  DC_PAIRS.forEach(function (p) {
    if (!pair && low.length && low.every(function (d) { return p.indexOf(d) >= 0; })) pair = p;
  });
  if (pair) {
    k.type = 'choice';
    if (DC_NORMAL.indexOf(pair[0]) >= 0) { k.bad = [pair[1]]; k.crit = '정상: ' + pair[0]; }
  }
  return k;
}

function dc_isBad(k, v) {
  if (v === '' || v === null || v === undefined) return false;
  if (k.type === 'number') {
    var n = dc_num(v);
    if (n === null) return false;
    return (k.min !== null && n < k.min) || (k.max !== null && n > k.max);
  }
  if (k.type === 'choice') {
    var s = String(v).trim().toLowerCase();
    return k.bad.some(function (b) { return b.toLowerCase() === s; });
  }
  return false;
}

function dc_round(n) { return Math.round(n * 100) / 100; }

var DC_WEEK = ['일', '월', '화', '수', '목', '금', '토'];
function dc_dayText(ds) {
  var p = ds.split('-');
  var w = DC_WEEK[new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getDay()];
  return Number(p[1]) + '/' + Number(p[2]) + ' (' + w + ')';
}

/**
 * 월간 보고서 표 만들기 → { sheetName, width, rows[][], meta }
 * meta 의 행·열 번호는 0부터. 시트에 쓰는 쪽(makeReport_)과 가짜 서버가 함께 쓴다.
 */
function dc_reportGrid(tab, data, month, todayStr, nowText) {
  var y = Number(month.slice(0, 4)), mo = Number(month.slice(5, 7));
  var dates = data.dates.filter(function (d) { return d.slice(0, 7) === month; }).sort();
  var items = data.items.map(function (it) {
    var vals = dates.map(function (d) { return it.values[d]; });
    return { it: it, k: dc_kind(it.label, it.criteria, vals) };
  });

  var rows = [], meta = { title: 0, sub: 1, sections: [], headers: [], bad: [], photo: [], links: [], daily: { header: 0, first: 0, count: 0, cols: [] } };
  var push = function (r) { rows.push(r); return rows.length - 1; };

  // 점검한 날 · 평일 수
  var checked = dates.filter(function (d) {
    return data.inspector[d] || items.some(function (x) { var v = x.it.values[d]; return v !== '' && v !== undefined && v !== null; });
  });
  var dim = new Date(y, mo, 0).getDate();
  var thisMonth = todayStr.slice(0, 7);
  var lastDay = month < thisMonth ? dim : month === thisMonth ? Number(todayStr.slice(8, 10)) : 0;
  var weekdays = [], missed = [];
  for (var d = 1; d <= lastDay; d++) {
    var wd = new Date(y, mo - 1, d).getDay();
    if (wd === 0 || wd === 6) continue;
    var ds = month + '-' + dc_pad(d);
    if (ds === todayStr && checked.indexOf(ds) < 0) continue; // 오늘은 아직 점검 전일 수 있음
    weekdays.push(ds);
    if (checked.indexOf(ds) < 0) missed.push(ds);
  }

  // 이상 · 사진 사건
  var events = [];
  items.forEach(function (x) {
    dates.forEach(function (d) {
      var v = x.it.values[d];
      var bad = dc_isBad(x.k, v);
      var ph = x.it.photos[d] || [];
      if (bad || ph.length) events.push({ date: d, x: x, value: v === undefined ? '' : v, bad: bad, photos: ph, memo: (x.it.memos && x.it.memos[d]) || '' });
    });
  });
  var badCount = {};
  events.forEach(function (e) { if (e.bad) badCount[e.x.it.label] = (badCount[e.x.it.label] || 0) + 1; });
  var badTotal = events.filter(function (e) { return e.bad; }).length;
  var photoTotal = events.reduce(function (s, e) { return s + e.photos.length; }, 0);

  push([tab + ' 월간 점검 보고서 — ' + y + '년 ' + mo + '월']);
  push(['만든 시각 ' + nowText + ' · 이 탭은 자동으로 만들어지며, 다시 만들면 내용이 새로 바뀝니다.']);
  push([]);

  meta.sections.push(push(['요약']));
  var rate = weekdays.length ? Math.round((checked.filter(function (d) { return weekdays.indexOf(d) >= 0; }).length / weekdays.length) * 100) : 0;
  push(['• 점검한 날 ' + checked.length + '일 · 평일 ' + weekdays.length + '일 중 점검률 ' + rate + '%']);
  if (missed.length) push(['• 점검이 빠진 평일: ' + missed.map(dc_dayText).join(', ')]);
  var top = Object.keys(badCount).sort(function (a, b) { return badCount[b] - badCount[a]; }).slice(0, 3);
  var lineBad = push([badTotal ? '• 기준을 벗어난 경우 ' + badTotal + '건 — ' + top.map(function (l) { return l + ' ' + badCount[l] + '회'; }).join(', ') : '• 기준을 벗어난 항목은 없었습니다.']);
  if (badTotal) meta.bad.push([lineBad, 0]);
  if (photoTotal) push(['• 현장 사진 ' + photoTotal + '장 (아래 «이상 · 사진 목록», 전체는 «' + PHOTO_LOG + '» 탭)']);
  items.forEach(function (x) {
    if (x.k.type !== 'number') return;
    var nums = dates.map(function (d) { return dc_num(x.it.values[d]); }).filter(function (n) { return n !== null; });
    if (nums.length < 4) return;
    var h = Math.floor(nums.length / 2);
    var a = nums.slice(0, h).reduce(function (s, n) { return s + n; }, 0) / h;
    var b = nums.slice(h).reduce(function (s, n) { return s + n; }, 0) / (nums.length - h);
    var ch = a !== 0 ? ((b - a) / Math.abs(a)) * 100 : 0;
    if (Math.abs(ch) >= 10) push(['• ' + x.it.label + ': 달 후반 평균이 전반보다 ' + Math.abs(Math.round(ch)) + '% ' + (ch > 0 ? '높습니다' : '낮습니다')]);
  });
  var who = [];
  dates.forEach(function (d) { var w = data.inspector[d]; if (w && who.indexOf(String(w)) < 0) who.push(String(w)); });
  if (who.length) push(['• 점검자: ' + who.join(', ')]);
  push([]);

  meta.sections.push(push(['항목별 요약']));
  meta.headers.push(push(['항목', '단위', '기준', '입력', '합계', '평균', '최소', '최대', '결과 분포', '이상', '이상 날짜']));
  items.forEach(function (x) {
    var vals = dates.map(function (d) { return x.it.values[d]; }).filter(function (v) { return v !== '' && v !== undefined && v !== null; });
    var badDates = dates.filter(function (d) { return dc_isBad(x.k, x.it.values[d]); });
    var row = [x.it.label, x.k.unit, x.k.crit, vals.length, '', '', '', '', '', badDates.length || '', badDates.map(dc_dayText).join(', ')];
    if (x.k.type === 'number') {
      var nums = vals.map(dc_num).filter(function (n) { return n !== null; });
      if (nums.length) {
        var sum = nums.reduce(function (s, n) { return s + n; }, 0);
        row[4] = dc_round(sum); row[5] = dc_round(sum / nums.length);
        row[6] = Math.min.apply(null, nums); row[7] = Math.max.apply(null, nums);
      }
    } else if (x.k.type === 'choice') {
      var cnt = {}, order = [];
      vals.forEach(function (v) { var s = String(v); if (!(s in cnt)) { cnt[s] = 0; order.push(s); } cnt[s]++; });
      row[8] = order.map(function (s) { return s + ' ' + cnt[s]; }).join(' · ');
    }
    var r = push(row);
    if (badDates.length) { meta.bad.push([r, 9]); meta.bad.push([r, 10]); }
  });
  push([]);

  meta.sections.push(push(['이상 · 사진 목록']));
  if (!events.length) push(['이 달에는 기준을 벗어난 값이나 현장 사진이 없습니다.']);
  else {
    meta.headers.push(push(['날짜', '항목', '값', '기준', '구분', '점검자', '설명', '사진']));
    events.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.x.it.row - b.x.it.row; });
    events.forEach(function (e) {
      var kind = e.bad && e.photos.length ? '기준 벗어남 · 사진' : e.bad ? '기준 벗어남' : '사진';
      var r = push([dc_dayText(e.date), e.x.it.label, e.value, e.x.k.crit, kind, String(data.inspector[e.date] || ''), e.memo, '']);
      if (e.bad) { meta.bad.push([r, 2]); meta.bad.push([r, 4]); }
      if (e.photos.length) {
        meta.photo.push([r, 7]);
        meta.links.push({ r: r, c: 7, text: '사진 ' + e.photos.length + '장', url: e.photos[0] });
      }
    });
  }
  push([]);

  // 그래프 자료: 날짜별 숫자 값
  var numeric = items.filter(function (x) { return x.k.type === 'number'; });
  meta.sections.push(push(['날짜별 값 (그래프 자료)']));
  var hdr = ['날짜'].concat(numeric.map(function (x) { return x.it.label; })).concat(['점검자']);
  meta.daily.header = push(hdr);
  meta.headers.push(meta.daily.header);
  meta.daily.first = rows.length;
  dates.forEach(function (d) {
    var r = push([d].concat(numeric.map(function (x) { var n = dc_num(x.it.values[d]); return n === null ? '' : n; })).concat([String(data.inspector[d] || '')]));
    numeric.forEach(function (x, i) { if (dc_isBad(x.k, x.it.values[d])) meta.bad.push([r, i + 1]); });
  });
  meta.daily.count = dates.length;
  meta.daily.cols = numeric.map(function (x, i) { return { col: i + 1, label: x.it.label, crit: x.k.crit }; });
  if (!dates.length) push(['이 달에는 기록이 없습니다.']);

  var width = Math.max(11, hdr.length);
  rows = rows.map(function (r) { var o = r.slice(); while (o.length < width) o.push(''); return o; });
  return { sheetName: '_월간 ' + month + ' ' + tab, width: width, rows: rows, meta: meta };
}
