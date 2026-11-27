import type { SheetItem, SheetTab } from './parse';
import { nowYM, parseTab, seriesOf, tabYM } from './series';

/**
 * 시트의 점검항목 변경 확인.
 * 시트(라이브)와 «승인된 목록»(시트의 숨김 탭 _승인본)을 비교해서,
 * 승인 전까지 현장 화면은 승인된 목록으로만 만든다.
 */

export interface ApprovedItem {
  label: string;
  criteria: string;
}
export interface ApprovedTab {
  tab: string;
  items: ApprovedItem[];
}

export type Change =
  | { kind: 'add'; label: string; criteria: string }
  | { kind: 'remove'; label: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'criteria'; label: string; from: string; to: string };

export interface TabChange {
  tab: string;
  /** 승인된 적 없는 새 탭 */
  newTab?: boolean;
  /** 시트에서 사라진 탭 */
  removedTab?: boolean;
  /** 새 달 탭이면 비교 기준이 된 지난달 탭 (changes 는 지난달 대비 달라진 점) */
  basedOn?: string;
  /** 지난달과 똑같은 새 달 탭: 바뀐 것이 없으니 자동으로 확정한다 */
  autoApprove?: boolean;
  changes: Change[];
  /** 승인하면 확정본이 될 목록 (지금 시트의 모양) */
  liveItems: ApprovedItem[];
}

const norm = (s: unknown) => String(s ?? '').trim();

/** 승인된 목록과 지금 시트의 차이 */
export function diffTab(approved: ApprovedItem[], live: SheetItem[]): Change[] {
  const ap = new Map(approved.map((a) => [norm(a.label), a]));
  const lv = new Map(live.map((l) => [norm(l.label), l]));
  const changes: Change[] = [];
  const renamedTo = new Set<string>();
  const renamedFrom = new Set<string>();

  // 이름 변경: 사라진 항목과 «같은 순서 칸»에 승인된 적 없는 새 이름이 있으면 이름만 바뀐 것으로 본다
  approved.forEach((a, i) => {
    const from = norm(a.label);
    if (lv.has(from)) return;
    const cand = live[i];
    const to = cand ? norm(cand.label) : '';
    if (cand && !ap.has(to) && !renamedTo.has(to)) {
      changes.push({ kind: 'rename', from, to });
      renamedFrom.add(from);
      renamedTo.add(to);
      if (norm(a.criteria) !== norm(cand.criteria)) changes.push({ kind: 'criteria', label: to, from: norm(a.criteria), to: norm(cand.criteria) });
    }
  });
  for (const a of approved) {
    const label = norm(a.label);
    if (!lv.has(label) && !renamedFrom.has(label)) changes.push({ kind: 'remove', label });
  }
  for (const l of live) {
    const label = norm(l.label);
    if (!ap.has(label) && !renamedTo.has(label)) changes.push({ kind: 'add', label, criteria: norm(l.criteria) });
  }
  for (const a of approved) {
    const l = lv.get(norm(a.label));
    if (l && norm(a.criteria) !== norm(l.criteria)) changes.push({ kind: 'criteria', label: norm(a.label), from: norm(a.criteria), to: norm(l.criteria) });
  }
  return changes;
}

/** 승인된 목록 모양에 시트의 값을 맞춘 탭 (앱 화면·보고서는 이것으로 만든다) */
export function effectiveTab(live: SheetTab, approved: ApprovedItem[], changes: Change[]): SheetTab {
  const byLabel = new Map(live.items.map((i) => [norm(i.label), i]));
  const renames = new Map(changes.flatMap((c) => (c.kind === 'rename' ? [[c.from, c.to] as const] : [])));
  const items: SheetItem[] = approved.map((a) => {
    const l = byLabel.get(norm(a.label)) ?? byLabel.get(renames.get(norm(a.label)) ?? '');
    return l ? { ...l, label: a.label, criteria: a.criteria } : { row: 0, label: a.label, criteria: a.criteria, values: {}, photos: {} };
  });
  return { ...live, items };
}

/** 시트 전체 → { 앱이 쓸 탭들, 승인이 필요한 변경들 } */
export function resolve(tabs: SheetTab[], approved: ApprovedTab[]) {
  const apMap = new Map(approved.map((a) => [a.tab, a.items]));
  const effective: SheetTab[] = [];
  const changes: TabChange[] = [];
  const { y: ny, m: nm } = nowYM();
  const ymOfName = (name: string) => tabYM(parseTab(name), ny, nm);

  /** 같은 점검표(이름이 같은 월별 탭)에서 이 탭보다 앞선, 확정된 가장 최근 탭 */
  const previousApproved = (tab: string, ym: string) => {
    const same = approved.filter((a) => a.tab !== tab && seriesOf(a.tab) === seriesOf(tab) && a.items.length);
    const byYm = (a: ApprovedTab, b: ApprovedTab) => ymOfName(a.tab).localeCompare(ymOfName(b.tab));
    const before = same.filter((a) => ymOfName(a.tab) && ymOfName(a.tab) < ym).sort(byYm);
    const any = [...same].sort(byYm); // 더 앞선 달이 없으면 같은 점검표의 가장 최근 탭을 기준으로
    return before.length ? before[before.length - 1] : any[any.length - 1];
  };

  for (const t of tabs) {
    if (t.lite) continue; // 오래된 월별 탭은 이름만 받았으므로 비교하지 않음
    const ap = apMap.get(t.tab);
    if (!t.items.length && !ap) continue; // 항목이 없는 탭은 무시
    const liveItems = t.items.map((i) => ({ label: norm(i.label), criteria: norm(i.criteria) }));
    if (!ap) {
      const ym = t.ym ?? ymOfName(t.tab);
      const prev = ym ? previousApproved(t.tab, ym) : undefined;
      if (prev) {
        // 새 달 탭: 지난달 대비 달라진 점만 보여 준다. 똑같으면 자동 확정.
        const diff = diffTab(prev.items, t.items);
        changes.push({ tab: t.tab, newTab: true, basedOn: prev.tab, autoApprove: diff.length === 0, changes: diff, liveItems });
      } else {
        changes.push({ tab: t.tab, newTab: true, changes: liveItems.map((i) => ({ kind: 'add', label: i.label, criteria: i.criteria })), liveItems });
      }
      continue;
    }
    const diff = diffTab(ap, t.items);
    if (diff.length) changes.push({ tab: t.tab, changes: diff, liveItems });
    effective.push(effectiveTab(t, ap, diff));
  }
  const live = new Set(tabs.map((t) => t.tab));
  for (const a of approved) if (!live.has(a.tab)) changes.push({ tab: a.tab, removedTab: true, changes: [], liveItems: [] });
  return { effective, changes };
}

export const countChanges = (cs: TabChange[]) =>
  cs.reduce((n, c) => n + (c.removedTab || (c.newTab && !c.basedOn) ? 1 : c.newTab ? Math.max(1, c.changes.length) : c.changes.length), 0);
