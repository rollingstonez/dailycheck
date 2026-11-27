// 개발용 가짜 구글 시트 서버.
// apps-script/Code.gs 의 순수 함수(dc_*)를 그대로 불러 써서 실제 스크립트와 같은 규칙으로 동작한다.
//   실행: npm run mock   → 앱의 시트 주소에 http://localhost:8787 , 비밀번호 1234
//   브라우저에서 http://localhost:8787 을 열면 현재 시트 내용을 표로 볼 수 있다.
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(dir, '../apps-script/Code.gs'), 'utf8'), ctx);
const { dc_photoNote, dc_reportGrid, PHOTO_LOG, dc_read, dc_locate, dc_findRow, dc_initApproved, dc_groupApproved, dc_applyApproval, dc_decide, dc_groupCorrections, dc_verify, dc_expectedMap, dc_findFinding, dc_acceptRows, dc_cast, dc_hasCriteria, dc_SEP, dc_parseTab, dc_tabYM, dc_recentFrom, dc_copyApproved, dc_sameStructure, TOKEN } = ctx;
// 승인 비밀번호: 개발용 기본값 0000 (승인 비밀번호 입력 흐름을 시험하려고). 비우려면  ADMIN_PIN= npm run mock
const PIN = process.env.ADMIN_PIN ?? '0000';
const PORT = Number(process.env.PORT || 8787);

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const YEAR = new Date().getFullYear();

/** 탭 이름 → { grid, notes } (실제 시트처럼 1행 날짜는 Date 객체) */
const sheets = {};
function seed() {
  const days = [];
  for (let i = 20; i >= 1; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    if (d.getDay() !== 0) days.push(d);
  }
  const rows = [
    ['밸브', 'on/off', (i) => (i === 6 ? 'off' : 'on')],
    ['오일 (ml)', '100~150', (i) => 115 + ((i * 7) % 30) + (i === 11 ? 45 : 0)],
    ['헬륨 (kg)', '40 이상', (i) => 50 - Math.floor(i / 2)],
    ['온도 (℃)', '95 이하, 사진', (i) => 84 + (i % 5) + (i === 14 ? 10 : 0)],
    ['레버', 'up/down', () => 'up'],
    ['가스 사용량 (㎥)', '', (i) => 120 + i * 2],
    ['특이사항', '', (i) => (i === 11 ? '오일 과다 투입, 재교육' : '')],
  ];
  const grid = [['점검사항', '기준', ...days]];
  for (const [label, crit, f] of rows) grid.push([label, crit, ...days.map((_, i) => f(i))]);
  grid.push(['점검자', '', ...days.map((_, i) => (i % 2 ? '김점검' : '박현장'))]);
  grid.push(['점검시각', '', ...days.map(() => '08:3' + Math.floor(Math.random() * 10))]);
  sheets['설비 일일점검'] = { grid, notes: grid.map((r) => r.map(() => '')) };

  // 기준 열 없는 시트 (사용자가 처음 보여 준 모양 그대로)
  const g2 = [['점검사항', ...days.slice(-3)], ['밸브', 'on', 'off', 'on'], ['오일 (ml)', 120, 130, 115], ['헬륨(Kg)', 45, 42, 39], ['온도(oC)', 85, 86, 91]];
  sheets['보일러실'] = { grid: g2, notes: g2.map((r) => r.map(() => '')) };

  // 월별 탭 («라인점검 2026-07» … 이번 달): 한 탭 = 한 달. 5개월 전·4개월 전 탭은 «오래된 탭»(동기화 때 이름만 읽음)
  const now = new Date();
  for (let k = 4; k >= 0; k--) {
    const first = new Date(now.getFullYear(), now.getMonth() - k, 1);
    const last = k === 0 ? now.getDate() : new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const ds = [];
    for (let d = 1; d <= Math.min(last, 6); d++) ds.push(new Date(first.getFullYear(), first.getMonth(), d));
    const g = [['점검사항', '기준', ...ds]];
    g.push(['라인 압력 (bar)', '3~5', ...ds.map((_, i) => +(4 + (i % 3) * 0.3 - (k === 2 && i === 3 ? 1.5 : 0)).toFixed(1))]);
    g.push(['컨베이어', 'on/off', ...ds.map(() => 'on')]);
    g.push(['점검자', '', ...ds.map(() => '박현장')]);
    g.push(['점검시각', '', ...ds.map(() => '09:00')]);
    sheets[`라인점검 ${first.getFullYear()}-${pad(first.getMonth() + 1)}`] = { grid: g, notes: g.map((r) => r.map(() => '')) };
  }
}
seed();

const width = (g) => Math.max(...g.map((r) => r.length));
/** 승인된 항목 목록 ( _승인본 탭 ): 처음 읽을 때 지금 시트를 기준으로 확정 */
let approvedRows = null;
/** 장부(_기록, 덧붙이기만)와 정정 내역(_정정) */
const logRows = [];
const corrRows = [];
const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

const nowY = new Date().getFullYear();
const nowM = new Date().getMonth() + 1;
/** recentFrom 보다 오래된 월별 탭은 이름만(lite) — Code.gs 의 readTabs_ 와 같은 규칙 */
const readTabs = (recentFrom = null) =>
  Object.entries(sheets)
    .filter(([tab]) => !tab.startsWith('_'))
    .map(([tab, s]) => {
    const ym = dc_tabYM(dc_parseTab(tab), nowY, nowM);
    if (recentFrom && ym && ym < recentFrom) return { tab, lite: true, ym };
    return { tab, ...dc_read(s.grid, s.notes, fmt, YEAR), ym };
  });

function read(b) {
  const first = !approvedRows; // 처음 연결할 때는 전체를 읽어 확정본을 만든다
  const tabs = readTabs(first ? null : b?.recent || null);
  if (!approvedRows) approvedRows = dc_initApproved(tabs, stamp());
  return { ok: true, name: '가짜 시트 (개발용)', tabs, approved: dc_groupApproved(approvedRows), pinRequired: !!PIN, corrections: dc_groupCorrections(corrRows) };
}

function approve(b) {
  const auto = b.auto === true; // 이미 확정된 다른 탭과 똑같은 새 달 탭만 비밀번호 없이
  if (!auto && PIN && String(b.pin || '') !== PIN) throw new Error('승인 비밀번호가 맞지 않습니다');
  if (!approvedRows) throw new Error('먼저 앱에서 동기화하세요');
  if (auto) for (const t of b.tabs || []) if (!dc_sameStructure(approvedRows, t.tab, t.items)) throw new Error('자동으로 확정할 수 없는 변경입니다');
  approvedRows = dc_applyApproval(approvedRows, b.tabs || [], b.removed || [], stamp());
  return { ok: true };
}

/** 기록 검사 (Code.gs 의 verify_ / resolve_ / restoreFinding_ 와 같은 규칙) */
function verifyTabs(all) {
  const tabs = readTabs(all ? null : dc_recentFrom(nowY, nowM));
  const skip = {};
  for (const t of tabs) if (t.lite) skip[t.tab] = true;
  return { tabs: tabs.filter((t) => !t.lite), skip };
}

function verify(b) {
  const vt = verifyTabs(!!b?.all);
  const r = dc_verify(vt.tabs, logRows, vt.skip);
  return { ok: true, at: stamp(), checked: r.checked, findings: r.findings };
}

const approvedCriteria = (tab, label) => String(approvedRows?.find((r) => r[0] === tab && String(r[1]).trim() === label)?.[2] ?? '');

function restore(f, at, reason, by) {
  const s = sheets[f.tab];
  if (!s) return null;
  const { grid, notes } = s;
  const labels = grid.map((r) => String(r[0]).trim());
  const exp = dc_expectedMap(logRows);
  if (f.kind === 'changed' || f.kind === 'deleted') {
    const loc = dc_locate(grid, f.date, fmt, YEAR);
    const r = dc_findRow(labels, f.label);
    if (loc.col === null || r < 0) return null;
    grid[r][loc.col] = dc_cast(f.expected);
    return [[at, '복구', f.tab, f.date, f.label, f.expected, f.actual === undefined ? '' : f.actual, reason, by]];
  }
  if (f.kind === 'rowDeleted') {
    const idx = dc_findRow(labels, '점검자');
    const at0 = idx < 0 ? grid.length : idx; // 점검자 행 바로 위
    const W = width(grid);
    const row = Array(W).fill('');
    row[0] = f.label;
    if (dc_hasCriteria(grid[0])) row[1] = approvedCriteria(f.tab, f.label);
    grid.splice(at0, 0, row);
    notes.splice(at0, 0, Array(W).fill(''));
    for (const d of f.dates || []) {
      const l = dc_locate(grid, d, fmt, YEAR);
      const e = exp[f.tab + dc_SEP + d + dc_SEP + f.label];
      if (l.col !== null && e && e.v !== '') grid[at0][l.col] = dc_cast(e.v);
    }
    return [[at, '복구', f.tab, '*', f.label, '', '', reason, by]];
  }
  if (f.kind === 'dateDeleted') {
    const loc = dc_locate(grid, f.date, fmt, YEAR);
    if (loc.col !== null) return null;
    const col = loc.insertAfter + 1;
    const [y, m, d] = f.date.split('-').map(Number);
    grid.forEach((r, i) => r.splice(col, 0, i === 0 ? new Date(y, m - 1, d) : ''));
    notes.forEach((r) => r.splice(col, 0, ''));
    for (const c of f.cells || []) {
      const rr = dc_findRow(grid.map((r) => String(r[0]).trim()), c.label);
      if (rr >= 0 && c.value !== '') grid[rr][col] = dc_cast(c.value);
    }
    return [[at, '복구', f.tab, f.date, '*', '', '', reason, by]];
  }
  return null;
}

function resolve(b) {
  if (PIN && String(b.pin || '') !== PIN) throw new Error('승인 비밀번호가 맞지 않습니다');
  const mode = b.mode === 'restore' ? 'restore' : 'accept';
  let reason = String(b.reason || '').trim();
  if (mode === 'accept' && !reason) throw new Error('인정 사유를 입력하세요');
  if (!reason) reason = '시트에서 직접 바뀐 값을 장부의 값으로 되돌림';
  const vt = verifyTabs(!!b.all);
  const current = dc_verify(vt.tabs, logRows, vt.skip).findings;
  const at = stamp();
  const by = b.inspector || '';
  const out = [];
  let done = 0;
  let skipped = 0;
  for (const want of b.items || []) {
    const f = dc_findFinding(current, want);
    const res = !f ? null : mode === 'accept' ? dc_acceptRows(f, at, reason, by) : restore(f, at, reason, by);
    if (!res) {
      skipped++;
      continue;
    }
    out.push(...res);
    done++;
  }
  logRows.push(...out);
  return { ok: true, done, skipped };
}

/** 정정 (Code.gs 의 correct_ 와 같은 규칙) */
function correct(b) {
  if (PIN && String(b.pin || '') !== PIN) throw new Error('승인 비밀번호가 맞지 않습니다');
  const reason = String(b.reason || '').trim();
  if (!reason) throw new Error('정정 사유를 입력하세요');
  const s = sheets[b.tab];
  if (!s) throw new Error(`시트에 "${b.tab}" 탭이 없습니다`);
  const loc = dc_locate(s.grid, b.date, fmt, YEAR);
  if (loc.col === null) throw new Error('그 날짜의 기록이 없습니다');
  const r = dc_findRow(s.grid.map((x) => String(x[0])), b.label);
  if (r < 0) throw new Error(`시트에 "${b.label}" 항목이 없습니다`);
  const cur = s.grid[r][loc.col];
  if (dc_decide(cur, b.value) !== 'locked') throw new Error('정정할 값이 비어 있거나 기존 값과 같습니다');
  const at = stamp();
  s.grid[r][loc.col] = b.value;
  const line = `✎ 정정 ${at}: ${cur} → ${b.value} (사유: ${reason})${b.inspector ? ' · ' + b.inspector : ''}`;
  s.notes[r][loc.col] = s.notes[r][loc.col] ? s.notes[r][loc.col] + '\n' + line : line;
  logRows.push([at, '정정', b.tab, b.date, b.label, b.value, cur, reason, b.inspector || '']);
  corrRows.push([at, b.tab, b.date, b.label, cur, b.value, reason, b.inspector || '']);
  return { ok: true };
}

/** 개발용: 누군가 시트에서 항목을 고치는 상황을 흉내 낸다 (실제 스크립트에는 없음) */
function dev(b) {
  if (b.op === 'removeTab') {
    delete sheets[b.tab];
    return { ok: true };
  }
  if (b.op === 'copyTab') {
    // 손으로 탭을 복사해 새 달 탭을 만든 상황: 점검사항·기준은 그대로, 값은 비움
    const src = sheets[b.from];
    const start = dc_hasCriteria(src.grid[0]) ? 2 : 1;
    const grid = src.grid.map((r) => r.slice(0, start));
    sheets[b.tab] = { grid, notes: grid.map((r) => r.map(() => '')) };
    return { ok: true };
  }
  if (b.op === 'addTab') {
    const g = [['점검사항', '기준', ...sheets['설비 일일점검'].grid[0].slice(2).slice(-2)], ...b.labels.map((l) => [l, '', '', ''])];
    sheets[b.tab] = { grid: g, notes: g.map((r) => r.map(() => '')) };
    return { ok: true };
  }
  const s = sheets[b.tab];
  if (!s) throw new Error('탭 없음');
  const { grid, notes } = s;
  const labels = () => grid.map((r) => String(r[0]));
  const hasC = /기준/.test(String(grid[0][1] ?? ''));
  const W = width(grid);
  if (b.op === 'addRow') {
    const at = dc_findRow(labels(), '점검자');
    const i = at < 0 ? grid.length : at;
    const row = [b.label, ...(hasC ? [b.criteria ?? ''] : []), ...Array(W - 1 - (hasC ? 1 : 0)).fill('')];
    grid.splice(i, 0, row);
    notes.splice(i, 0, Array(W).fill(''));
  } else if (b.op === 'removeRow') {
    const i = dc_findRow(labels(), b.label);
    if (i < 0) throw new Error('항목 없음');
    grid.splice(i, 1);
    notes.splice(i, 1);
  } else if (b.op === 'log') {
    return { ok: true, log: logRows };
  } else if (b.op === 'setCell') {
    const i = dc_findRow(labels(), b.label);
    const loc = dc_locate(grid, b.date, fmt, YEAR);
    if (i < 0 || loc.col === null) throw new Error('칸 없음');
    grid[i][loc.col] = b.value; // 시트에서 직접 수정한 상황
  } else if (b.op === 'removeDate') {
    const loc = dc_locate(grid, b.date, fmt, YEAR);
    if (loc.col === null) throw new Error('날짜 열 없음');
    grid.forEach((r) => r.splice(loc.col, 1));
    notes.forEach((r) => r.splice(loc.col, 1));
  } else if (b.op === 'rename') {
    const i = dc_findRow(labels(), b.from);
    if (i < 0) throw new Error('항목 없음');
    grid[i][0] = b.to;
  } else if (b.op === 'criteria') {
    const i = dc_findRow(labels(), b.label);
    if (i < 0 || !hasC) throw new Error('항목 없음 또는 기준 열 없음');
    grid[i][1] = b.value;
  } else throw new Error('알 수 없는 op');
  return { ok: true };
}

const photoDir = path.join(dir, 'photos');
fs.mkdirSync(photoDir, { recursive: true });

/** 새 달 탭: 지난달 탭의 점검사항·기준만 복사 (Code.gs 의 createMonthTab_ 와 같은 규칙) */
function createMonthTab(from, name) {
  const src = sheets[from];
  if (!src) throw new Error(`새 달 탭을 만들 기준 탭 "${from}" 이 없습니다`);
  const start = dc_hasCriteria(src.grid[0]) ? 2 : 1;
  const grid = src.grid.map((r, i) => (i === 0 ? r.slice(0, start) : [...r.slice(0, start)]));
  sheets[name] = { grid, notes: grid.map((r) => r.map(() => '')) };
  if (approvedRows) approvedRows = dc_copyApproved(approvedRows, from, name, stamp());
}

function submit(b) {
  if (!sheets[b.tab] && b.createFrom) createMonthTab(b.createFrom, b.tab);
  const s = sheets[b.tab];
  if (!s) throw new Error(`시트에 "${b.tab}" 탭이 없습니다`);
  const { grid, notes } = s;
  const loc = dc_locate(grid, b.date, fmt, YEAR);
  let col = loc.col;
  if (col === null) {
    col = loc.insertAfter + 1;
    const [y, m, d] = b.date.split('-').map(Number);
    grid.forEach((r, i) => r.splice(col, 0, i === 0 ? new Date(y, m - 1, d) : ''));
    notes.forEach((r) => r.splice(col, 0, ''));
  }
  const W = width(grid);
  for (const sp of ['점검자', '점검시각']) {
    if (dc_findRow(grid.map((r) => r[0]), sp) < 0) {
      grid.push([sp, ...Array(W - 1).fill('')]);
      notes.push(Array(W).fill(''));
    }
  }
  // «이상 발견» 특이사항 행: 없으면 점검자 행 바로 위에 (Code.gs 와 같은 규칙)
  if ((b.entries || []).some((en) => String(en.label).trim() === '특이사항') && dc_findRow(grid.map((r) => r[0]), '특이사항') < 0) {
    const at0 = dc_findRow(grid.map((r) => r[0]), '점검자');
    grid.splice(at0, 0, ['특이사항', ...Array(W - 1).fill('')]);
    notes.splice(at0, 0, Array(W).fill(''));
  }
  const labels = grid.map((r) => String(r[0]));
  const missing = [];
  const locked = [];
  let uploaded = [];
  const photoRows = [];
  const at = stamp();
  const entries = [...(b.entries || []), { label: '점검자', value: b.inspector || '' }, { label: '점검시각', value: b.time || '' }];
  for (const en of entries) {
    const r = dc_findRow(labels, en.label);
    if (r < 0) {
      missing.push(en.label);
      continue;
    }
    const cur = grid[r][col] ?? '';
    const val = en.value ?? '';
    if (en.label === '점검자') {
      if (val !== '' && cur === '') grid[r][col] = val;
      else if (val !== '' && !String(cur).includes(String(val))) grid[r][col] = cur + ', ' + val;
    } else if (en.label === '점검시각') {
      if (val !== '' && cur === '') grid[r][col] = val;
    } else {
      const d = dc_decide(cur, val);
      if (d === 'write') {
        grid[r][col] = val;
        logRows.push([at, '입력', b.tab, b.date, en.label, val, '', '', b.inspector || '']);
      } else if (d === 'locked') locked.push(en.label);
    }
    if (en.photos?.length) {
      const saved = en.photos.map((p) => {
        const name = `${b.date}_${p.id.slice(0, 6)}.jpg`;
        fs.writeFileSync(path.join(photoDir, name), Buffer.from(p.data, 'base64'));
        return { id: p.id, url: `http://localhost:${PORT}/photos/${name}` };
      });
      uploaded = uploaded.concat(saved);
      const add = dc_photoNote(saved.length, b.inspector, b.time, en.note, saved.map((p) => p.url));
      notes[r][col] = notes[r][col] ? notes[r][col] + '\n\n' + add : add;
      en.photos.forEach((p, i) =>
        photoRows.push({ date: b.date, time: b.time || '', tab: b.tab, label: en.label, value: val, note: en.note || '', inspector: b.inspector || '', url: saved[i].url, thumb: p.thumb }),
      );
    }
  }
  if (photoRows.length) logPhotos(photoRows);
  return { ok: true, tab: b.tab, column: col + 1, missing, photos: uploaded, locked };
}

/** _사진기록 탭: 사진 한 장 = 한 줄 (Code.gs 의 logPhotos_ 와 같은 모양) */
function logPhotos(rows) {
  if (!sheets[PHOTO_LOG]) {
    const g = [['날짜', '시각', '점검표', '항목', '그때 값', '메모', '점검자', '사진', '원본']];
    sheets[PHOTO_LOG] = { grid: g, notes: [g[0].map(() => '')] };
  }
  const s = sheets[PHOTO_LOG];
  for (const p of rows) {
    s.grid.push([p.date, p.time, p.tab, p.label, p.value, p.note, p.inspector, p.thumb ? `<img src="data:image/jpeg;base64,${p.thumb}" height=60>` : '', '열기']);
    s.notes.push(['', '', '', '', '', '', '', '', p.url]);
  }
}

/** 월간 보고서 탭 (Code.gs 의 makeReport_ 와 같은 표). 그래프는 목록으로만 적는다 */
function report(b) {
  const s = sheets[b.tab];
  if (!s) throw new Error(`시트에 "${b.tab}" 탭이 없습니다`);
  if (!/^\d{4}-\d{2}$/.test(String(b.month))) throw new Error('보고서 달이 올바르지 않습니다: ' + b.month);
  const now = new Date();
  const data = dc_read(s.grid, s.notes, fmt, Number(b.month.slice(0, 4)));
  const rep = dc_reportGrid(b.tab, data, b.month, fmt(now), `${fmt(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`);
  const notes = rep.rows.map((r) => r.map(() => ''));
  for (const l of rep.meta.links) notes[l.r][l.c] = l.url;
  const grid = rep.rows.map((r) => r.slice());
  for (const l of rep.meta.links) grid[l.r][l.c] = l.text;
  grid.push([]);
  grid.push([`그래프 ${rep.meta.daily.cols.length}개: ${rep.meta.daily.cols.map((c) => c.label).join(', ')}`]);
  sheets[rep.sheetName] = { grid, notes, report: rep.meta };
  return { ok: true, sheet: rep.sheetName, url: `http://localhost:${PORT}/#${encodeURIComponent(rep.sheetName)}`, warnings: [] };
}

function html() {
  const cell = (v) => (v instanceof Date ? `${v.getMonth() + 1}/${v.getDate()}` : String(v ?? ''));
  const tabs = Object.entries(sheets)
    .map(
      ([tab, s]) =>
        `<h2>${tab}</h2><table>${s.grid
          .map((r, ri) => `<tr>${r.map((v, ci) => `<td${s.notes[ri]?.[ci] ? ' class=n title="' + s.notes[ri][ci] + '"' : ''}>${cell(v)}</td>`).join('')}</tr>`)
          .join('')}</table>`,
    )
    .join('');
  return `<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=5><title>가짜 시트</title>
<style>body{font:14px sans-serif;margin:16px}table{border-collapse:collapse}td{border:1px solid #ccc;padding:4px 8px;white-space:nowrap}tr:first-child td{background:#eef}td.n{background:#ffe9a8}</style>
<p>개발용 가짜 구글 시트 · 5초마다 새로고침 · 노란 칸 = 사진 메모</p>${tabs}`;
}

http
  .createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'GET' && req.url.startsWith('/photos/')) {
      const f = path.join(photoDir, path.basename(req.url));
      if (fs.existsSync(f)) return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(fs.readFileSync(f));
      return res.writeHead(404).end();
    }
    if (req.method === 'GET') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html());
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let out;
      try {
        const b = JSON.parse(body);
        if (TOKEN && b.token !== TOKEN) throw new Error('비밀번호가 맞지 않습니다');
        out =
          b.action === 'read' ? read(b)
          : b.action === 'submit' ? submit(b)
          : b.action === 'report' ? report(b)
          : b.action === 'approve' ? approve(b)
          : b.action === 'correct' ? correct(b)
          : b.action === 'verify' ? verify(b)
          : b.action === 'readTabs' ? { ok: true, tabs: readTabs().filter((t) => (b.tabs || []).includes(t.tab)) }
          : b.action === 'resolve' ? resolve(b)
          : b.action === 'protect' ? { ok: true, mock: true }
          : b.action === '_dev' ? dev(b)
          : { ok: false, error: '알 수 없는 요청' };
      } catch (e) {
        out = { ok: false, error: String(e.message || e) };
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(out));
    });
  })
  .listen(PORT, () => console.log(`가짜 시트 서버: http://localhost:${PORT}  (비밀번호 ${TOKEN}, 승인 비밀번호 ${PIN || '없음'})`));
