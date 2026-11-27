/**
 * 데일리체크 ↔ 구글 시트 연결 스크립트
 *
 * 시트 모양 (탭 하나 = 점검표 하나)
 *   A열: 점검사항   예) 밸브, 오일 (ml), 헬륨(Kg), 온도(℃)
 *   B열: 기준 (선택) 예) on/off, 100~150, 40 이상, 95 이하, 사진
 *   1행: 날짜       예) 11/11, 11/12 ...
 *   맨 아래 "점검자", "점검시각" 행은 앱이 자동으로 만듭니다.
 *
 * 앱이 자동으로 만드는 탭 (이름이 _ 로 시작 → 앱의 점검표 목록에는 안 나옴)
 *   _사진기록                  사진 한 장 = 한 줄, 칸 안 미리보기 + 원본 링크
 *   _월간 2026-11 <점검표>     월간 보고서 (요약 · 항목별 표 · 이상/사진 목록 · 그래프)
 *
 * 설치 방법은 같은 폴더의 설치방법.md 를 보세요.
 */

// ▼ 앱의 "비밀번호" 칸에 넣을 값과 똑같이 바꾸세요. ('' 로 두면 비밀번호 없이 연결됨)
var TOKEN = '1234';

var PHOTO_FOLDER = '데일리체크 사진';
var PHOTO_LOG = '_사진기록';
var PHOTO_COLOR = '#fce8b2'; // 사진이 있는 칸 배경 (연한 주황)
var SPECIAL_INSPECTOR = '점검자';
var SPECIAL_TIME = '점검시각';
var SPECIAL_REMARK = '특이사항';

/* ───────────── 구글 시트 메뉴 · 자동 실행 ───────────── */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('데일리체크')
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

function reportAll_(month) {
  return pointTabs_().map(function (sh) { return makeReport_(sh.getName(), month).sheet; });
}

function pointTabs_() {
  return SpreadsheetApp.getActive().getSheets().filter(function (s) {
    return !s.isSheetHidden() && s.getName().charAt(0) !== '_';
  });
}

/* ───────────── 앱 요청 받기 ───────────── */

function doGet() {
  return json_({ ok: true, message: '데일리체크 연결 스크립트가 작동 중입니다. 이 주소를 앱에 넣으세요.' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (TOKEN && body.token !== TOKEN) throw new Error('비밀번호가 맞지 않습니다');
    if (body.action === 'read') return json_(read_());
    if (body.action === 'submit') return json_(submit_(body));
    if (body.action === 'report') {
      var r = makeReport_(body.tab, body.month);
      r.ok = true;
      return json_(r);
    }
    throw new Error('알 수 없는 요청: ' + body.action);
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function tz_() { return SpreadsheetApp.getActive().getSpreadsheetTimeZone(); }

function fmt_() {
  var tz = tz_();
  return function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
}

function read_() {
  var ss = SpreadsheetApp.getActive();
  var fmt = fmt_();
  var year = new Date().getFullYear();
  var tabs = pointTabs_().map(function (sh) {
    var rng = sh.getDataRange();
    var r = dc_read(rng.getValues(), rng.getNotes(), fmt, year);
    r.tab = sh.getName();
    return r;
  });
  return { ok: true, name: ss.getName(), tabs: tabs };
}

/* ───────────── 점검 기록 쓰기 ───────────── */

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

    var entries = (b.entries || []).concat([
      { label: SPECIAL_INSPECTOR, value: b.inspector || '' },
      { label: SPECIAL_TIME, value: b.time ? "'" + b.time : '' },
    ]);

    // 점검자·점검시각 행이 없으면 맨 아래에 추가
    var labels = labels_(sh);
    [SPECIAL_INSPECTOR, SPECIAL_TIME].forEach(function (s) {
      if (dc_findRow(labels, s) < 0) {
        sh.getRange(sh.getLastRow() + 1, 1).setValue(s);
        labels = labels_(sh);
      }
    });
    // «이상 발견» 사진·메모용 특이사항 행이 없으면 점검자 행 바로 위에 추가
    var wantsRemark = entries.some(function (en) { return String(en.label).trim() === SPECIAL_REMARK; });
    if (wantsRemark && dc_findRow(labels, SPECIAL_REMARK) < 0) {
      var at = dc_findRow(labels, SPECIAL_INSPECTOR) + 1; // 1부터 시작
      sh.insertRowBefore(at);
      sh.getRange(at, 1).setValue(SPECIAL_REMARK);
      labels = labels_(sh);
    }

    var missing = [];
    var uploaded = [];
    var logRows = [];
    entries.forEach(function (en) {
      var r = dc_findRow(labels, en.label);
      if (r < 0) { missing.push(en.label); return; }
      var cell = sh.getRange(r + 1, col + 1);
      var value = en.value === null || en.value === undefined ? '' : en.value;
      cell.setValue(value);
      if (en.photos && en.photos.length) {
        var saved = savePhotos_(b.tab, b.date, en.label, en.photos);
        uploaded = uploaded.concat(saved);
        var note = cell.getNote();
        var add = dc_photoNote(saved.length, b.inspector, b.time, en.note, saved.map(function (p) { return p.url; }));
        cell.setNote(note ? note + '\n\n' + add : add);
        cell.setBackground(PHOTO_COLOR);
        en.photos.forEach(function (p, i) {
          logRows.push({ date: b.date, time: b.time || '', tab: b.tab, label: en.label, value: value, note: en.note || '', inspector: b.inspector || '', url: saved[i].url, thumb: p.thumb });
        });
      }
    });
    if (logRows.length) logPhotos_(logRows);
    return { ok: true, column: col + 1, missing: missing, photos: uploaded };
  } finally {
    lock.releaseLock();
  }
}

function labels_(sh) {
  var n = Math.max(1, sh.getLastRow());
  return sh.getRange(1, 1, n, 1).getValues().map(function (row) { return String(row[0]).trim(); });
}

function folder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** 사진 원본 → 드라이브 «데일리체크 사진 / 점검표 / 2026-11» */
function savePhotos_(tab, date, label, photos) {
  var folder = folder_(folder_(folder_(DriveApp.getRootFolder(), PHOTO_FOLDER), tab), String(date).slice(0, 7));
  return photos.map(function (p) {
    var name = date + '_' + label.replace(/[\\/:*?"<>|]/g, '') + '_' + String(p.id).slice(0, 6) + '.jpg';
    var f = folder.createFile(Utilities.newBlob(Utilities.base64Decode(p.data), 'image/jpeg', name));
    return { id: p.id, url: f.getUrl() };
  });
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
