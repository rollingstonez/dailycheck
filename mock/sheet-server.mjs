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
const { dc_read, dc_locate, dc_findRow, dc_photoNote, dc_reportGrid, TOKEN, PHOTO_LOG } = ctx;
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
  const notes = grid.map((r) => r.map(() => ''));
  // 사진이 붙은 칸 예시: 온도 정상값이지만 이상해 보여 찍은 사진
  notes[4][2 + 14] = dc_photoNote(1, '박현장', '08:31', '온도계 유리에 김이 서려 잘 안 보임', [`http://localhost:${PORT}/photos/sample.jpg`]);
  sheets['설비 일일점검'] = { grid, notes };

  // 기준 열 없는 시트 (사용자가 처음 보여 준 모양 그대로)
  const g2 = [['점검사항', ...days.slice(-3)], ['밸브', 'on', 'off', 'on'], ['오일 (ml)', 120, 130, 115], ['헬륨(Kg)', 45, 42, 39], ['온도(oC)', 85, 86, 91]];
  sheets['보일러실'] = { grid: g2, notes: g2.map((r) => r.map(() => '')) };
}
seed();

const width = (g) => Math.max(...g.map((r) => r.length));
function read() {
  return {
    ok: true,
    name: '가짜 시트 (개발용)',
    tabs: Object.entries(sheets)
      .filter(([tab]) => !tab.startsWith('_'))
      .map(([tab, s]) => ({ tab, ...dc_read(s.grid, s.notes, fmt, YEAR) })),
  };
}

/** Code.gs 의 makeReport_ 와 같은 표를 만들어 «_월간 …» 탭으로 넣는다 (그래프는 목록으로만 표시) */
function report(b) {
  const s = sheets[b.tab];
  if (!s) throw new Error(`시트에 "${b.tab}" 탭이 없습니다`);
  if (!/^\d{4}-\d{2}$/.test(String(b.month))) throw new Error('보고서 달이 올바르지 않습니다: ' + b.month);
  const now = new Date();
  const rep = dc_reportGrid(b.tab, dc_read(s.grid, s.notes, fmt, Number(b.month.slice(0, 4))), b.month, fmt(now), `${fmt(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`);
  const notes = rep.rows.map((r) => r.map(() => ''));
  for (const l of rep.meta.links) notes[l.r][l.c] = l.url;
  const grid = rep.rows.map((r) => r.slice());
  for (const l of rep.meta.links) grid[l.r][l.c] = l.text;
  grid.push([]);
  grid.push([`그래프 ${rep.meta.daily.cols.length}개: ${rep.meta.daily.cols.map((c) => c.label).join(', ')}`]);
  sheets[rep.sheetName] = { grid, notes, report: rep.meta };
  return { ok: true, sheet: rep.sheetName, url: `http://localhost:${PORT}/#${encodeURIComponent(rep.sheetName)}`, warnings: [] };
}

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

const photoDir = path.join(dir, 'photos');
fs.mkdirSync(photoDir, { recursive: true });

function submit(b) {
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
  const entries = [...(b.entries || []), { label: '점검자', value: b.inspector || '' }, { label: '점검시각', value: b.time || '' }];
  for (const sp of ['점검자', '점검시각']) {
    if (dc_findRow(grid.map((r) => r[0]), sp) < 0) {
      grid.push([sp, ...Array(W - 1).fill('')]);
      notes.push(Array(W).fill(''));
    }
  }
  // «이상 발견»용 특이사항 행이 없으면 점검자 행 바로 위에
  if (entries.some((en) => String(en.label).trim() === '특이사항') && dc_findRow(grid.map((r) => r[0]), '특이사항') < 0) {
    const at = dc_findRow(grid.map((r) => r[0]), '점검자');
    grid.splice(at, 0, ['특이사항', ...Array(W - 1).fill('')]);
    notes.splice(at, 0, Array(W).fill(''));
  }
  const labels = grid.map((r) => String(r[0]));
  const missing = [];
  let uploaded = [];
  const logRows = [];
  for (const en of entries) {
    const r = dc_findRow(labels, en.label);
    if (r < 0) {
      missing.push(en.label);
      continue;
    }
    grid[r][col] = en.value ?? '';
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
        logRows.push({ date: b.date, time: b.time || '', tab: b.tab, label: en.label, value: en.value ?? '', note: en.note || '', inspector: b.inspector || '', url: saved[i].url, thumb: p.thumb }),
      );
    }
  }
  if (logRows.length) logPhotos(logRows);
  return { ok: true, column: col + 1, missing, photos: uploaded };
}

function html() {
  const cell = (v) => (v instanceof Date ? `${v.getMonth() + 1}/${v.getDate()}` : String(v ?? ''));
  const tabs = Object.entries(sheets)
    .map(
      ([tab, s]) =>
        `<h2 id="${encodeURIComponent(tab)}">${tab}</h2><table>${s.grid
          .map((r, ri) => {
            const m = s.report;
            const cls = m && (m.sections.includes(ri) ? 'sec' : m.headers.includes(ri) ? 'hd' : '');
            return `<tr${cls ? ` class=${cls}` : ''}>${r
              .map((v, ci) => {
                const bad = m?.bad.some(([br, bc]) => br === ri && bc === ci) ? ' bad' : '';
                const note = s.notes[ri]?.[ci];
                return `<td class="${note ? 'n' : ''}${bad}"${note ? ` title="${String(note).replace(/"/g, '&quot;')}"` : ''}>${cell(v)}</td>`;
              })
              .join('')}</tr>`;
          })
          .join('')}</table>`,
    )
    .join('');
  return `<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=5><title>가짜 시트</title>
<style>body{font:14px sans-serif;margin:16px}table{border-collapse:collapse}td{border:1px solid #ccc;padding:4px 8px;white-space:nowrap}tr:first-child td{background:#eef}td.n{background:#fce8b2}td.bad{color:#d93025;font-weight:bold}tr.sec td{background:#e8f0fe;font-weight:bold}tr.hd td{background:#f1f3f4;font-weight:bold}</style>
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
          b.action === 'read' ? read() : b.action === 'submit' ? submit(b) : b.action === 'report' ? report(b) : { ok: false, error: '알 수 없는 요청' };
      } catch (e) {
        out = { ok: false, error: String(e.message || e) };
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(out));
    });
  })
  .listen(PORT, () => console.log(`가짜 시트 서버: http://localhost:${PORT}  (비밀번호 ${TOKEN})`));
