import type { CheckItem, SheetTabRef } from '../types';

/**
 * 월별 탭: «설비 2026-11», «설비 2026-12» … 처럼 이름이 같고 월만 다른 탭을 하나의 점검표(시리즈)로 묶는다.
 * 이름에서 월을 읽는 규칙은 시트 스크립트(apps-script/Code.gs 의 dc_parseTab)와 똑같아야 한다.
 * (mock/tab-parity-test.mjs 가 둘을 비교한다)
 */

export interface ParsedTab {
  /** 월 표기를 뺀 이름 (월이 없으면 이름 그대로) */
  series: string;
  /** 이름에 적힌 연도 (없으면 0) */
  y: number;
  /** 월 1~12 (이름에 월이 없으면 0) */
  m: number;
  /** 이름 속 월 표기 (예: «2026-11») */
  token: string;
}

const RE_YM4 = /(\d{4})(\s*[-./년]\s*)(\d{1,2})(\s*월)?/;
const RE_YM2 = /(\d{2})(\s*년\s*)(\d{1,2})(\s*월)/;
const RE_M = /(\d{1,2})(\s*월)/;
const okMonth = (n: number) => n >= 1 && n <= 12;
const pad = (n: number) => String(n).padStart(2, '0');

export function parseTab(name: string): ParsedTab {
  const s = String(name ?? '').trim();
  let y = 0;
  let m = 0;
  let token = '';
  let r = RE_YM4.exec(s);
  if (r && okMonth(+r[3])) {
    y = +r[1];
    m = +r[3];
    token = r[0];
  } else if ((r = RE_YM2.exec(s)) && okMonth(+r[3])) {
    y = 2000 + +r[1];
    m = +r[3];
    token = r[0];
  } else if ((r = RE_M.exec(s)) && okMonth(+r[1])) {
    m = +r[1];
    token = r[0];
  }
  if (!m) return { series: s, y: 0, m: 0, token: '' };
  const rest = s.replace(token, ' ').replace(/\s+/g, ' ').replace(/^[\s_\-·.,/]+|[\s_\-·.,/]+$/g, '');
  return { series: rest, y, m, token };
}

/** 월 «yyyy-MM». 연도 없는 이름(«11월»)은 과거 11개월~미래 1개월 안에서 고른다 */
export function tabYM(p: ParsedTab, nowY: number, nowM: number): string {
  if (!p.m) return '';
  const y = p.y || (p.m > nowM + 1 ? nowY - 1 : nowY);
  return `${y}-${pad(p.m)}`;
}

export const nowYM = () => {
  const d = new Date();
  return { y: d.getFullYear(), m: d.getMonth() + 1 };
};

/** 점검표 이름: 월을 뺀 이름. 이름이 월뿐이면(«11월») «점검표» */
export const seriesOf = (tab: string) => parseTab(tab).series || '점검표';

/** 앞 달 탭 이름의 표기 방식을 그대로 따라 다음 달 탭 이름을 만든다 («설비 2026-11» → «설비 2026-12») */
export function nextTabName(prevTab: string, y: number, m: number): string {
  const s = String(prevTab).trim();
  const ym4 = RE_YM4.exec(s);
  if (ym4 && okMonth(+ym4[3])) {
    const [, , sep, mo, suffix] = ym4;
    const numericSep = /[-./]/.test(sep);
    const padded = mo.startsWith('0') || (numericSep && mo.length === 2);
    return s.replace(ym4[0], `${y}${sep}${padded ? pad(m) : m}${suffix ?? ''}`);
  }
  const ym2 = RE_YM2.exec(s);
  if (ym2 && okMonth(+ym2[3])) {
    const [, , sep, mo, suffix] = ym2;
    return s.replace(ym2[0], `${pad(y % 100)}${sep}${mo.startsWith('0') ? pad(m) : m}${suffix}`);
  }
  const mm = RE_M.exec(s);
  if (mm && okMonth(+mm[1])) return s.replace(mm[0], `${mm[1].startsWith('0') ? pad(m) : m}${mm[2]}`);
  return `${s} ${y}-${pad(m)}`;
}

/** 이 날짜 기록이 들어갈 탭. 그 달 탭이 아직 없으면 새로 만들 이름과 복사해 올 탭(createFrom)을 알려 준다 */
export function tabForDate(c: { sheetTab?: string; monthly?: boolean; tabs?: SheetTabRef[] }, date: string): { tab: string; createFrom?: string } {
  if (!c.monthly || !c.tabs?.length) return { tab: c.sheetTab ?? '' };
  const ym = date.slice(0, 7);
  const hit = c.tabs.find((t) => t.ym === ym);
  if (hit) return { tab: hit.tab };
  const dated = c.tabs.filter((t) => t.ym).sort((a, b) => a.ym.localeCompare(b.ym));
  if (!dated.length) return { tab: c.sheetTab ?? '' };
  const prev = [...dated].reverse().find((t) => t.ym < ym) ?? dated[dated.length - 1];
  const [y, m] = ym.split('-').map(Number);
  return { tab: nextTabName(prev.tab, y, m), createFrom: prev.tab };
}

/** 이 날짜에 입력할 점검항목: 그 달 탭의 항목. 그 달 탭이 아직 없으면 바로 앞선 달 탭의 항목 (다음 달 탭을 미리 만들어 둬도 이번 달 입력은 이번 달 항목으로) */
export function itemsForDate(c: { items: CheckItem[]; monthly?: boolean; tabs?: SheetTabRef[] }, date: string): CheckItem[] {
  if (!c.monthly || !c.tabs?.length) return c.items;
  const ym = date.slice(0, 7);
  const dated = c.tabs.filter((t) => t.ym && t.items?.length).sort((a, b) => a.ym.localeCompare(b.ym));
  if (!dated.length) return c.items;
  const pick = dated.find((t) => t.ym === ym) ?? [...dated].reverse().find((t) => t.ym < ym) ?? dated[0];
  return pick.items!;
}

/** 가장 최근 달의 탭 */
export const latestTab = (tabs: SheetTabRef[]) => [...tabs].sort((a, b) => a.ym.localeCompare(b.ym) || 0).slice(-1)[0];
