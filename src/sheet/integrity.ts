import { useSyncExternalStore } from 'react';
import { callSheet, getConfig, onAfterSync, syncNow } from './sync';

/**
 * 기록 검사: 시트의 숨김 장부(_기록)와 시트의 현재 값을 비교해서
 * 앱을 거치지 않고 시트에서 직접 바뀐 것을 찾는다. (비교는 시트 스크립트가 한다)
 */

export type FindingKind = 'changed' | 'deleted' | 'unlogged' | 'rowDeleted' | 'dateDeleted' | 'tabDeleted';

export interface Finding {
  kind: FindingKind;
  tab: string;
  date?: string;
  label?: string;
  expected?: string;
  actual?: string | number;
  dates?: string[];
  cells?: { label: string; value: string }[];
  count?: number;
}

interface State {
  busy: boolean;
  error?: string;
  checkedAt?: number;
  checked?: number;
  /** 마지막 검사가 전체 기간이었는지 (아니면 최근 3개월) */
  all?: boolean;
  findings: Finding[];
}

const KEY = 'dc:integrity';
const load = (): Partial<State> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
};
const saved = load();
let state: State = { busy: false, checkedAt: saved.checkedAt, checked: saved.checked, all: saved.all, findings: saved.findings ?? [] };
const listeners = new Set<() => void>();
function emit(p: Partial<State>) {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
export function useIntegrity() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

export const canRestore = (f: Finding) => f.kind === 'changed' || f.kind === 'deleted' || f.kind === 'rowDeleted' || f.kind === 'dateDeleted';

/** 지금 검사 */
export async function verifyNow(opts: { all?: boolean } = {}) {
  if (!getConfig() || state.busy) return;
  emit({ busy: true, error: undefined });
  try {
    const all = !!opts.all;
    const r = await callSheet<{ checked: number; findings: Finding[] }>({ action: 'verify', all });
    const next = { checkedAt: Date.now(), checked: r.checked, all, findings: r.findings };
    localStorage.setItem(KEY, JSON.stringify(next));
    emit(next);
  } catch (e) {
    emit({ error: (e as Error).message });
  } finally {
    emit({ busy: false });
  }
}

const SIX_HOURS = 6 * 3600 * 1000;
/** 동기화 뒤에 자동으로: 마지막 검사가 6시간 넘었으면 조용히 검사 */
function maybeVerify() {
  if (!state.checkedAt || Date.now() - state.checkedAt > SIX_HOURS) verifyNow();
}
onAfterSync(maybeVerify);

/** 결과 처리: 'restore' = 장부의 값으로 시트를 되돌림, 'accept' = 시트의 값을 인정(사유 필수) */
export async function resolveFindings(mode: 'restore' | 'accept', items: Finding[], reason: string, pin: string) {
  await callSheet({
    action: 'resolve',
    mode,
    reason,
    pin,
    all: !!state.all,
    inspector: localStorage.getItem('dc:inspector') ?? '',
    items: items.map((f) => ({ kind: f.kind, tab: f.tab, date: f.date, label: f.label })),
  });
  const all = !!state.all;
  state = { ...state, checkedAt: undefined }; // 바로 다시 검사
  await verifyNow({ all });
  await syncNow(); // 되돌린 값을 화면에도 반영
}

/** 시트 보호를 (다시) 건다 */
export async function protectNow() {
  await callSheet({ action: 'protect' });
}
