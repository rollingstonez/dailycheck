// 탭 이름 → 월 해석이 시트 스크립트(Code.gs)와 앱(src/sheet/series.ts)에서 똑같은지 확인한다.
//   실행: npm run test:tabs   (Node 22 의 --experimental-strip-types 사용)
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTab, tabYM, nextTabName, tabForDate, itemsForDate } from '../src/sheet/series.ts';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(dir, '../apps-script/Code.gs'), 'utf8'), ctx);

const names = [
  '설비 2026-11', '설비 2026.1', '설비 2026-1', '2026년 11월', '26년 11월', '설비 11월', '11월', '1월', '12월',
  'A-1 라인 2026-11', '설비_2026-12', '보일러실', '3호기 점검', '설비 2026-13', '설비 13월', '2026-11 설비', '설비 점검표 2027.01',
];
let bad = 0;
for (const [ny, nm] of [[2026, 11], [2027, 1], [2026, 6]]) {
  for (const n of names) {
    const a = ctx.dc_parseTab(n);
    const b = parseTab(n);
    const ya = ctx.dc_tabYM(a, ny, nm);
    const yb = tabYM(b, ny, nm);
    if (a.series !== b.series || a.y !== b.y || a.m !== b.m || ya !== yb) {
      bad++;
      console.log('다름', n, JSON.stringify(a), JSON.stringify(b), ya, yb);
    }
  }
}

const eq = (got, want, label) => {
  if (got !== want) {
    bad++;
    console.log('틀림', label, '→', got, '(기대:', want + ')');
  }
};
eq(nextTabName('설비 2026-11', 2026, 12), '설비 2026-12', '다음 달');
eq(nextTabName('설비 2026-12', 2027, 1), '설비 2027-01', '연도 넘김(0 채움)');
eq(nextTabName('설비 2026.9', 2026, 10), '설비 2026.10', '점 표기');
eq(nextTabName('2026년 11월', 2026, 12), '2026년 12월', '년 월 표기');
eq(nextTabName('26년 12월', 2027, 1), '27년 1월', '두 자리 연도');
eq(nextTabName('설비 11월', 2026, 12), '설비 12월', '월만');
eq(nextTabName('11월', 2027, 1), '1월', '월만 (연도 넘김)');
eq(nextTabName('보일러실', 2026, 12), '보일러실 2026-12', '월 표기가 없던 이름');

const cl = { sheetTab: '설비 2026-11', monthly: true, tabs: [{ tab: '설비 2026-10', ym: '2026-10', loaded: true }, { tab: '설비 2026-11', ym: '2026-11', loaded: true }] };
eq(JSON.stringify(tabForDate(cl, '2026-11-26')), JSON.stringify({ tab: '설비 2026-11' }), '이번 달 탭');
eq(JSON.stringify(tabForDate(cl, '2026-12-01')), JSON.stringify({ tab: '설비 2026-12', createFrom: '설비 2026-11' }), '새 달 탭 만들기');
eq(JSON.stringify(tabForDate(cl, '2026-09-15')), JSON.stringify({ tab: '설비 2026-09', createFrom: '설비 2026-11' }), '지난 달(탭 없음)');
eq(JSON.stringify(tabForDate({ sheetTab: '보일러실' }, '2026-11-26')), JSON.stringify({ tab: '보일러실' }), '월 없는 탭');

const A = [{ id: 'a' }];
const B = [{ id: 'a' }, { id: 'b' }];
const cm = { items: B, monthly: true, tabs: [{ tab: 'x 2026-10', ym: '2026-10', loaded: true, items: A }, { tab: 'x 2026-11', ym: '2026-11', loaded: true, items: A }, { tab: 'x 2027-01', ym: '2027-01', loaded: true, items: B }] };
eq(itemsForDate(cm, '2026-11-26').length, 1, '이번 달은 이번 달 탭 항목');
eq(itemsForDate(cm, '2026-12-05').length, 1, '탭이 없는 달은 바로 앞선 달 항목');
eq(itemsForDate(cm, '2027-01-03').length, 2, '다음 해 탭이 있으면 그 항목');
eq(itemsForDate(cm, '2026-01-03').length, 1, '가장 오래된 탭보다 이전이면 가장 오래된 탭');
eq(itemsForDate({ items: B }, '2026-11-26').length, 2, '월별이 아니면 점검표 항목');

console.log(bad ? `실패 ${bad}건` : `통과 (이름 ${names.length}개 × 기준일 3개, 규칙 일치)`);
process.exit(bad ? 1 : 0);
