import type { CheckItem } from '../types';

/** 시트 한 행 (Code.gs 의 dc_read 결과) */
export interface SheetItem {
  row: number;
  label: string;
  criteria: string;
  values: Record<string, string | number>;
  photos: Record<string, string[]>;
  /** 사진 메모에 적힌 설명 (날짜별) */
  memos?: Record<string, string>;
}

/** 사진·메모를 모으는 행 이름. 시트에 없으면 첫 «이상 발견» 저장 때 자동으로 생긴다 */
export const REMARK_LABEL = '특이사항';

export interface SheetTab {
  tab: string;
  hasCriteria: boolean;
  dates: string[];
  items: SheetItem[];
  inspector: Record<string, string>;
  time: Record<string, string>;
}

/** "오일 (ml)" → { name: "오일", unit: "ml" } */
export function splitUnit(label: string) {
  const m = label.match(/^(.*?)\s*[(（]\s*([^()（）]+?)\s*[)）]\s*$/);
  return m && m[1] ? { name: m[1].trim(), unit: m[2] } : { name: label.trim(), unit: undefined };
}

// 흔한 2지선다: 앞이 정상. NORMAL_KNOWN 에 있는 쌍은 기준이 없어도 뒤쪽을 이상으로 본다.
const KNOWN_PAIRS = [
  ['on', 'off'], ['up', 'down'], ['yes', 'no'], ['예', '아니오'], ['o', 'x'], ['정상', '이상'],
  ['양호', '불량'], ['ok', 'ng'], ['합격', '불합격'], ['적합', '부적합'], ['유', '무'],
];
const NORMAL_KNOWN = new Set(['o', '정상', '양호', 'ok', '합격', '적합']);

const num = (s: string) => {
  const n = parseFloat(s.replace(/,/g, ''));
  return isNaN(n) ? undefined : n;
};

/** "100~150", "40 이상", "95 이하", "≥40", "40이상 50이하" → min/max */
export function parseRange(c: string): { min?: number; max?: number } | null {
  const s = c.replace(/\s+/g, ' ').trim();
  let m = s.match(/^(-?[\d.,]+)\s*[~∼〜]\s*(-?[\d.,]+)$/);
  if (m) return { min: num(m[1]), max: num(m[2]) };
  const out: { min?: number; max?: number } = {};
  for (const mm of s.matchAll(/(-?[\d.,]+)\s*(이상|초과|이하|미만)|(>=|≥|>|<=|≤|<)\s*(-?[\d.,]+)/g)) {
    const v = num(mm[1] ?? mm[4]);
    const op = mm[2] ?? mm[3];
    if (v === undefined) continue;
    if (['이상', '초과', '>=', '≥', '>'].includes(op)) out.min = v;
    else out.max = v;
  }
  return out.min !== undefined || out.max !== undefined ? out : null;
}

const isNumeric = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && /^-?[\d,]*\.?\d+$/.test(v.trim()));

export const sheetItemId = (tab: string, label: string) => `s:${tab}:${label}`;

/** 시트 한 행 → 앱 입력 항목 */
export function toCheckItem(tab: string, si: SheetItem): CheckItem {
  const { name, unit } = splitUnit(si.label);
  const rawCrit = si.criteria ?? '';
  const photo = /사진|📷/.test(rawCrit);
  const crit = rawCrit.replace(/사진|📷/g, '').replace(/^[\s,·/]+|[\s,·/]+$/g, '').trim();
  const base: CheckItem = {
    id: sheetItemId(tab, si.label),
    label: name,
    unit,
    type: 'memo',
    required: /필수/.test(crit),
    photo,
    sheetLabel: si.label,
    sheetCriteria: rawCrit,
  };
  const c = crit.replace(/필수/g, '').trim();
  if (/^(특이사항|비고|메모)$/.test(si.label.trim())) return base;

  // 1) 기준에 선택지 (on/off, up/down, 양호/보통/불량)
  if (c && c.includes('/') && !parseRange(c)) {
    const options = c.split('/').map((s) => s.trim()).filter(Boolean);
    if (options.length >= 2) return { ...base, type: 'choice', options, badOptions: options.slice(1) };
  }
  // 2) 숫자 기준
  const range = c ? parseRange(c) : null;
  if (range) return { ...base, type: 'number', ...range };
  if (/숫자|수치/.test(c) || unit) return { ...base, type: 'number' };
  if (/메모|글|텍스트/.test(c)) return base;

  // 3) 기준이 없으면 지금까지 적힌 값으로 추측
  const vals = Object.values(si.values).filter((v) => v !== '' && v !== null && v !== undefined);
  if (vals.length && vals.every(isNumeric)) return { ...base, type: 'number' };
  const strs = vals.map((v) => String(v).trim());
  const distinct = [...new Set(strs.map((s) => s.toLowerCase()))];
  const pair = KNOWN_PAIRS.find((p) => distinct.length > 0 && distinct.every((d) => p.includes(d)));
  if (pair) {
    // 시트에 적힌 대소문자 그대로 사용 (예: ON/OFF)
    const cased = pair.map((p) => strs.find((s) => s.toLowerCase() === p) ?? p);
    return { ...base, type: 'choice', options: cased, badOptions: NORMAL_KNOWN.has(pair[0]) ? [cased[1]] : [] };
  }
  if (distinct.length >= 2 && distinct.length <= 4 && strs.every((s) => s.length <= 6)) {
    const freq = new Map<string, number>();
    strs.forEach((s) => freq.set(s, (freq.get(s) ?? 0) + 1));
    return { ...base, type: 'choice', options: [...freq.keys()].sort((a, b) => freq.get(b)! - freq.get(a)!), badOptions: [] };
  }
  return base;
}

export function describeItem(i: CheckItem): string {
  if (i.type === 'choice') return `버튼: ${(i.options ?? []).join(' / ')}`;
  if (i.type === 'number') return '숫자';
  if (i.type === 'yesno') return '예 / 아니오';
  if (i.type === 'photo') return '사진';
  return '메모';
}
