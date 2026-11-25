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
const { dc_read, dc_locate, dc_findRow, TOKEN } = ctx;
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
}
seed();

const width = (g) => Math.max(...g.map((r) => r.length));
function read() {
  return {
    ok: true,
    name: '가짜 시트 (개발용)',
    tabs: Object.entries(sheets).map(([tab, s]) => ({ tab, ...dc_read(s.grid, s.notes, fmt, YEAR) })),
  };
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
  for (const sp of ['점검자', '점검시각']) {
    if (dc_findRow(grid.map((r) => r[0]), sp) < 0) {
      grid.push([sp, ...Array(W - 1).fill('')]);
      notes.push(Array(W).fill(''));
    }
  }
  const labels = grid.map((r) => String(r[0]));
  const missing = [];
  let uploaded = [];
  const entries = [...(b.entries || []), { label: '점검자', value: b.inspector || '' }, { label: '점검시각', value: b.time || '' }];
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
      const urls = saved.map((p) => p.url).join('\n');
      notes[r][col] = notes[r][col] ? notes[r][col] + '\n' + urls : '📷 사진\n' + urls;
    }
  }
  return { ok: true, column: col + 1, missing, photos: uploaded };
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
        out = b.action === 'read' ? read() : b.action === 'submit' ? submit(b) : { ok: false, error: '알 수 없는 요청' };
      } catch (e) {
        out = { ok: false, error: String(e.message || e) };
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(out));
    });
  })
  .listen(PORT, () => console.log(`가짜 시트 서버: http://localhost:${PORT}  (비밀번호 ${TOKEN})`));
