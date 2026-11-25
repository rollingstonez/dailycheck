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
  return { ok: true, name: ss.getName(), tabs: tabs };
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
    var entries = (b.entries || []).concat([
      { label: SPECIAL_INSPECTOR, value: b.inspector || '' },
      { label: SPECIAL_TIME, value: b.time ? "'" + b.time : '' },
    ]);
    entries.forEach(function (en) {
      var r = dc_findRow(labels, en.label);
      if (r < 0) { missing.push(en.label); return; }
      var cell = sh.getRange(r + 1, col + 1);
      cell.setValue(en.value === null || en.value === undefined ? '' : en.value);
      if (en.photos && en.photos.length) {
        var saved = savePhotos_(b.tab, b.date, en.label, en.photos);
        uploaded = uploaded.concat(saved);
        var note = cell.getNote();
        var urls = saved.map(function (p) { return p.url; }).join('\n');
        cell.setNote(note ? note + '\n' + urls : '📷 사진\n' + urls);
      }
    });
    return { ok: true, column: col + 1, missing: missing, photos: uploaded };
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
