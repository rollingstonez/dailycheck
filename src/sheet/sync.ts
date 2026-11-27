import { useSyncExternalStore } from 'react';
import { db } from '../db';
import type { Checklist, Correction, InspectionRecord, ItemValue, SheetTabRef } from '../types';
import { isAbnormal } from '../util';
import { toCheckItem, type SheetTab } from './parse';
import { resolve, type ApprovedTab, type TabChange } from './changes';
import { nowYM, parseTab, seriesOf, tabForDate, tabYM } from './series';

/* ───── 연결 설정 (이 기기에 저장) ───── */

export interface SheetConfig {
  url: string;
  token: string;
  name?: string;
}
const CFG_KEY = 'dc:sheet';
const LAST_KEY = 'dc:lastSync';

export function getConfig(): SheetConfig | null {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
  } catch {
    return null;
  }
}
export function setConfig(c: SheetConfig | null) {
  if (c) localStorage.setItem(CFG_KEY, JSON.stringify(c));
  else localStorage.removeItem(CFG_KEY);
  emit({});
}

/* ───── 상태 (화면에 표시) ───── */

interface SyncState {
  busy: boolean;
  error?: string;
  lastSync?: number;
  message?: string;
  /** 시트에서 바뀌었지만 아직 승인하지 않은 점검항목 */
  changes: TabChange[];
  /** 승인에 비밀번호가 필요한지 (시트 스크립트의 ADMIN_PIN) */
  pinRequired: boolean;
  /** 지난 달 탭의 기록을 불러오는 중 */
  loadingOld?: boolean;
}
interface SheetCorrection {
  at: string;
  tab: string;
  date: string;
  label: string;
  from: string;
  to: string;
  reason: string;
  by: string;
}
interface ReadResult {
  name: string;
  tabs: SheetTab[];
  approved?: ApprovedTab[];
  pinRequired?: boolean;
  corrections?: SheetCorrection[];
}
let state: SyncState = { busy: false, lastSync: Number(localStorage.getItem(LAST_KEY)) || undefined, changes: [], pinRequired: false };
const listeners = new Set<() => void>();
function emit(p: Partial<SyncState>) {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}
export function useSyncState() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/* ───── 통신 ───── */

async function call<T>(cfg: SheetConfig, body: object): Promise<T> {
  let res: Response;
  try {
    // text/plain 으로 보내야 Apps Script 가 CORS 사전 요청 없이 받는다
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, token: cfg.token }),
      redirect: 'follow',
    });
  } catch {
    throw new Error(navigator.onLine ? '시트 주소에 연결할 수 없습니다. 주소와 배포 설정(액세스: 모든 사용자)을 확인하세요.' : '인터넷 연결 없음');
  }
  let j: { ok: boolean; error?: string } & T;
  try {
    j = await res.json();
  } catch {
    throw new Error('시트 응답을 읽을 수 없습니다. 웹 앱 URL(…/exec)이 맞는지 확인하세요.');
  }
  if (!j.ok) throw new Error(j.error || '알 수 없는 오류');
  return j;
}

/** 연결된 시트에 요청 (기록 검사 등 다른 모듈용) */
export async function callSheet<T>(body: object): Promise<T> {
  const cfg = getConfig();
  if (!cfg) throw new Error('구글 시트가 연결되어 있지 않습니다');
  return call<T>(cfg, body);
}

/** 동기화가 끝난 뒤 실행할 일 (예: 기록 검사) */
const afterSyncHooks = new Set<() => void>();
export const onAfterSync = (f: () => void) => {
  afterSyncHooks.add(f);
};

/** 연결 테스트 + 저장 */
export async function connect(url: string, token: string) {
  const cfg = { url: url.trim(), token: token.trim() };
  const r = await call<ReadResult>(cfg, { action: 'read', recent: recentFrom() });
  setConfig({ ...cfg, name: r.name });
  await handleRead(r);
  emit({ lastSync: Date.now(), error: undefined });
  localStorage.setItem(LAST_KEY, String(Date.now()));
  return r;
}

export async function disconnect() {
  setConfig(null);
}

/* ───── 시트 → 앱 ───── */

/** 점검표 id: 월별 탭이면 월을 뺀 이름(시리즈) 기준, 아니면 탭 이름 */
export const sheetChecklistId = (series: string) => `sheet:${series}`;

/** 동기화 때 전체를 읽을 가장 오래된 달 (이번 달 포함 최근 3개월). 그보다 오래된 월별 탭은 이름만 받는다 */
function recentFrom() {
  const { y, m } = nowYM();
  const d = new Date(y, m - 1 - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 오래된 탭을 나중에 불러올 때 쓰려고 가장 최근에 받은 정정 내역을 기억해 둔다 */
let lastCorrections: SheetCorrection[] = [];
export const sheetRecordId = (checklistId: string, date: string) => `${checklistId}|${date}`;

/** 정정 내역의 값은 글자로 저장되어 있어, 숫자 항목이면 숫자로 되돌린다 */
const castValue = (type: string, v: string): ItemValue => (type === 'number' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : v);

/** 오래된 탭(lite)은 이름·월만 받았으므로 나머지는 빈 값으로 채워 둔다 */
const normalizeTab = (t: SheetTab): SheetTab => (t.lite ? { ...t, hasCriteria: false, dates: [], items: [], inspector: {}, time: {} } : t);

/** 시트에서 읽은 내용 → 승인된 항목으로 화면 구성, 승인 안 된 변경은 따로 모아 둔다 */
async function handleRead(r: ReadResult) {
  const tabs = r.tabs.map(normalizeTab);
  lastCorrections = r.corrections ?? [];
  if (!r.approved) {
    // 승인 기능이 없는 예전 스크립트: 시트 그대로 반영
    await applyRead(tabs, tabs, r.corrections);
    emit({ changes: [], pinRequired: false });
    return;
  }
  let approved = r.approved;
  let res = resolve(tabs, approved);
  // 새 달 탭이 지난달과 똑같으면 바뀐 것이 없으니 승인을 묻지 않고 확정한다
  const auto = res.changes.filter((c) => c.autoApprove);
  if (auto.length) {
    try {
      const add = auto.map((c) => ({ tab: c.tab, items: c.liveItems }));
      await callSheet({ action: 'approve', auto: true, tabs: add, removed: [] });
      approved = [...approved, ...add];
    } catch {
      // 자동 확정이 안 되면 «변경 확인»에서 직접 승인
    }
    res = resolve(tabs, approved);
  }
  await applyRead(res.effective, tabs, r.corrections);
  emit({ changes: res.changes.filter((c) => !c.autoApprove), pinRequired: !!r.pinRequired });
}

/** 변경 승인: 지금 시트의 모양을 확정본으로 저장 → 다시 동기화해서 모든 화면에 반영 */
export async function approveChanges(pin: string) {
  const cfg = getConfig();
  if (!cfg) throw new Error('구글 시트가 연결되어 있지 않습니다');
  const tabs = state.changes.filter((c) => !c.removedTab).map((c) => ({ tab: c.tab, items: c.liveItems }));
  const removed = state.changes.filter((c) => c.removedTab).map((c) => c.tab);
  await call(cfg, { action: 'approve', pin, tabs, removed });
  if (running) await running;
  await syncNow();
}

/** 탭 하나의 «yyyy-MM»: 이름에 연도가 없으면(«11월») 안에 적힌 날짜의 해를 따른다 */
function ymOfTab(t: SheetTab): string {
  const p = parseTab(t.tab);
  if (!p.m) return '';
  if (!p.y && t.dates.length && Number(t.dates[0].slice(5, 7)) === p.m) return t.dates[0].slice(0, 7);
  const { y, m } = nowYM();
  return t.ym || tabYM(p, y, m);
}

/** 탭 하나의 기록들 (한 날짜 = 한 기록). 이 기기에서 아직 못 보낸 날짜는 건드리지 않는다 */
function recordsOfTab(
  checklistId: string,
  name: string,
  t: SheetTab,
  items: ReturnType<typeof toCheckItem>[],
  corrections: SheetCorrection[],
  prev: Map<string, InspectionRecord>,
  pendingDates: Set<string>,
  now: number,
): InspectionRecord[] {
  const recs: InspectionRecord[] = [];
  for (const date of t.dates) {
    if (pendingDates.has(date)) continue;
    const values: Record<string, ItemValue> = {};
    const photoLinks: Record<string, string[]> = {};
    const photoNotes: Record<string, string> = {};
    let any = false;
    t.items.forEach((si, i) => {
      const v = si.values[date];
      if (v !== undefined && v !== '') {
        values[items[i].id] = v;
        any = true;
      }
      if (si.photos[date]) photoLinks[items[i].id] = si.photos[date];
      if (si.memos?.[date]) photoNotes[items[i].id] = si.memos[date];
    });
    if (!any && !t.inspector[date]) continue;
    const p = prev.get(date);
    const corr: Correction[] = corrections
      .filter((c) => c.tab === t.tab && c.date === date)
      .flatMap((c) => {
        const it = items.find((x) => x.sheetLabel === c.label);
        return it ? [{ itemId: it.id, from: castValue(it.type, c.from), to: castValue(it.type, c.to), reason: c.reason, by: c.by, at: c.at }] : [];
      });
    recs.push({
      id: sheetRecordId(checklistId, date),
      checklistId,
      checklistName: name,
      tab: t.tab,
      date,
      inspector: String(t.inspector[date] ?? ''),
      time: t.time[date] ? String(t.time[date]) : undefined,
      values,
      abnormal: items.filter((it) => isAbnormal(it, values[it.id])).map((it) => it.id),
      itemsSnapshot: items,
      photos: p?.photos,
      photoLinks,
      photoNotes,
      corrections: corr.length ? corr : undefined,
      createdAt: p?.createdAt ?? now,
      updatedAt: now,
      synced: true,
    });
  }
  return recs;
}

/**
 * 시트에서 읽은 탭들을 점검표와 기록으로 반영한다.
 *  - effective: 내용을 읽었고 확정된 탭 (화면·기록을 만든다)
 *  - all: 이름만 받은 오래된 탭까지 포함한 전체 (점검표가 어떤 탭들로 이뤄졌는지 알려 준다)
 * 이름이 같고 월만 다른 탭(«설비 2026-11», «설비 2026-12»)은 하나의 점검표로 묶는다.
 */
async function applyRead(effective: SheetTab[], all: SheetTab[], corrections: SheetCorrection[] = []) {
  const now = Date.now();
  const keepIds = new Set<string>();
  const loadedNames = new Set(effective.filter((t) => t.items.length).map((t) => t.tab));
  const groups = new Map<string, SheetTab[]>();
  for (const t of all) {
    if (!(loadedNames.has(t.tab) || t.lite)) continue; // 승인 전인 새 탭은 아직 점검표로 쓰지 않음
    const name = seriesOf(t.tab);
    groups.set(name, [...(groups.get(name) ?? []), t]);
  }

  await db.transaction('rw', db.checklists, db.records, async () => {
    for (const [name, tabs] of groups) {
      const id = sheetChecklistId(name);
      keepIds.add(id);
      const old = await db.checklists.get(id);
      const wasLoaded = new Map((old?.tabs ?? []).map((r) => [r.tab, r.loaded]));
      const oldItems = new Map((old?.tabs ?? []).map((r) => [r.tab, r.items]));
      const loaded = tabs.filter((t) => !t.lite && t.items.length);
      const itemsOfTab = new Map(loaded.map((t) => [t.tab, t.items.map((si) => toCheckItem(name, si))]));
      const refs: SheetTabRef[] = tabs
        .map((t) => ({ tab: t.tab, ym: t.lite ? t.ym ?? '' : ymOfTab(t), loaded: !t.lite || !!wasLoaded.get(t.tab), items: itemsOfTab.get(t.tab) ?? oldItems.get(t.tab) }))
        .sort((a, b) => a.ym.localeCompare(b.ym) || a.tab.localeCompare(b.tab));
      const latest = [...loaded].sort((a, b) => ymOfTab(a).localeCompare(ymOfTab(b))).pop();
      const latestRef = refs[refs.length - 1];
      const items = latest ? latest.items.map((si) => toCheckItem(name, si)) : old?.items;
      if (!items) continue; // 읽은 탭이 하나도 없고 이전에 받아 둔 것도 없음
      await db.checklists.put({
        id,
        name,
        items,
        sheetTab: latestRef?.tab ?? latest?.tab,
        monthly: refs.some((r) => r.ym),
        tabs: refs,
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
      });

      // 이 기기에서 아직 못 보낸 기록은 덮어쓰지 않는다
      const local = await db.records.where('checklistId').equals(id).toArray();
      const pendingDates = new Set(local.filter((r) => !r.synced).map((r) => r.date));
      const prev = new Map(local.map((r) => [r.date, r]));
      const readTabs = new Set(loaded.map((t) => t.tab));
      const existingTabs = new Set(tabs.map((t) => t.tab));
      // 다시 읽은 탭의 기록은 시트 내용으로 새로 만들고, 시트에서 탭이 사라졌으면 그 탭의 기록도 정리한다
      await db.records.bulkDelete(local.filter((r) => r.synced && r.tab && (readTabs.has(r.tab) || !existingTabs.has(r.tab))).map((r) => r.id));
      for (const t of loaded) {
        await db.records.bulkPut(recordsOfTab(id, name, t, itemsOfTab.get(t.tab)!, corrections, prev, pendingDates, now));
      }
    }
    // 시트에서 사라진 점검표 정리 (못 보낸 기록이 없을 때만)
    const sheetLists = await db.checklists.filter((c) => !!c.sheetTab).toArray();
    for (const c of sheetLists) {
      if (keepIds.has(c.id)) continue;
      const unsent = await db.records.where('checklistId').equals(c.id).filter((r) => !r.synced).count();
      if (!unsent) await db.checklists.delete(c.id);
    }
  });
}

/**
 * 지난 달 탭 불러오기: 오래된 월별 탭은 동기화 때 이름만 받으므로,
 * 보고서·기록에서 그 달을 볼 때 내용을 받아 이 기기에 저장해 둔다.
 */
let loadChain: Promise<void> = Promise.resolve();
let loadingCount = 0;
export function ensureRange(checklistId: string, from: string, to: string): Promise<void> {
  if (!getConfig()) return Promise.resolve();
  loadChain = loadChain.then(() => ensureRangeNow(checklistId, from, to)).catch(() => undefined);
  return loadChain;
}

async function ensureRangeNow(checklistId: string, from: string, to: string) {
  if (!getConfig()) return;
  const cl = await db.checklists.get(checklistId);
  const need = (cl?.tabs ?? []).filter((t) => !t.loaded && t.ym && t.ym >= from.slice(0, 7) && t.ym <= to.slice(0, 7));
  if (!cl || !need.length) return;
  loadingCount++;
  emit({ loadingOld: true });
  try {
    const r = await callSheet<{ tabs: SheetTab[] }>({ action: 'readTabs', tabs: need.map((t) => t.tab) });
    const now = Date.now();
    await db.transaction('rw', db.checklists, db.records, async () => {
      const local = await db.records.where('checklistId').equals(checklistId).toArray();
      const pendingDates = new Set(local.filter((x) => !x.synced).map((x) => x.date));
      const prev = new Map(local.map((x) => [x.date, x]));
      for (const t of r.tabs) {
        // 오래된 탭은 확정 여부와 상관없이 시트에 적힌 그대로 보여 준다 (기록을 읽는 용도)
        const items = t.items.map((si) => toCheckItem(cl.name, si));
        await db.records.bulkPut(recordsOfTab(checklistId, cl.name, t, items, lastCorrections, prev, pendingDates, now));
      }
      const got = new Set(r.tabs.map((t) => t.tab));
      await db.checklists.update(checklistId, { tabs: (cl.tabs ?? []).map((t) => (got.has(t.tab) ? { ...t, loaded: true } : t)) });
    });
  } catch (e) {
    emit({ error: '지난 달 기록을 불러오지 못했습니다: ' + (e as Error).message });
  } finally {
    loadingCount--;
    emit({ loadingOld: loadingCount > 0 });
  }
}

/* ───── 앱 → 시트 ───── */

const blobToBase64 = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(b);
  });

/** 시트 «_사진기록» 칸 안에 넣을 작은 미리보기 (긴 변 240px) */
async function thumbBase64(b: Blob): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(b);
    const s = Math.min(1, 240 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const out = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.7));
    return out ? await blobToBase64(out) : undefined;
  } catch {
    return undefined;
  }
}

/** 이 날짜 기록이 들어갈 탭으로 보낸다. 새 달이라 탭이 없으면 지난달 탭을 복사해 새로 만든다 */
async function pushRecord(cfg: SheetConfig, rec: InspectionRecord, target: { tab: string; createFrom?: string }) {
  const entries = [];
  for (const it of rec.itemsSnapshot) {
    if (!it.sheetLabel) continue;
    const v = rec.values[it.id];
    const ids = rec.photos?.[it.id] ?? [];
    const photos = [];
    for (const pid of ids) {
      const p = await db.photos.get(pid);
      if (p && !p.uploadedUrl) photos.push({ id: p.id, data: await blobToBase64(p.blob), thumb: await thumbBase64(p.blob) });
    }
    // 사진 설명: 사진 칸이면 사진 설명, 메모 항목이면 그 글 자체
    const note = rec.photoNotes?.[it.id] ?? (it.type === 'memo' && typeof v === 'string' ? v : '');
    entries.push({ label: it.sheetLabel, value: v === undefined || v === null ? '' : v, photos, note });
  }
  const r = await call<{ missing: string[]; photos: { id: string; url: string }[]; locked?: string[] }>(cfg, {
    action: 'submit',
    tab: target.tab,
    createFrom: target.createFrom,
    date: rec.date,
    inspector: rec.inspector,
    time: rec.time,
    entries,
  });
  for (const p of r.photos) await db.photos.update(p.id, { uploadedUrl: p.url });
  await db.records.update(rec.id, {
    synced: true,
    tab: target.tab,
    syncError: r.missing.length ? `시트에 없는 항목: ${r.missing.join(', ')}` : undefined,
  });
  return r.locked ?? [];
}

/** 정정 요청 (시트 스크립트가 사유·승인 비밀번호를 확인하고 장부에 남긴다) */
export async function sheetCorrect(p: { tab: string; date: string; label: string; value: ItemValue; reason: string; inspector: string; pin: string }) {
  const cfg = getConfig();
  if (!cfg) throw new Error('구글 시트가 연결되어 있지 않습니다');
  await call(cfg, { action: 'correct', ...p });
}

/* ───── 동기화 (보내기 → 받기) ───── */

let running: Promise<void> | null = null;

export function syncNow(): Promise<void> {
  if (running) return running;
  const cfg = getConfig();
  if (!cfg) return Promise.resolve();
  running = (async () => {
    emit({ busy: true, error: undefined, message: undefined });
    try {
      const lists = await db.checklists.filter((c) => !!c.sheetTab).toArray();
      const listOf = new Map(lists.map((c) => [c.id, c]));
      const pending = await db.records.filter((r) => !r.synced && listOf.has(r.checklistId)).toArray();
      let sent = 0;
      const skipped: string[] = [];
      for (const rec of pending) {
        try {
          skipped.push(...(await pushRecord(cfg, rec, tabForDate(listOf.get(rec.checklistId)!, rec.date))));
          sent++;
        } catch (e) {
          await db.records.update(rec.id, { syncError: (e as Error).message });
          throw e;
        }
      }
      const r = await call<ReadResult>(cfg, { action: 'read', recent: recentFrom() });
      if (r.name !== cfg.name) setConfig({ ...cfg, name: r.name });
      await handleRead(r);
      const t = Date.now();
      localStorage.setItem(LAST_KEY, String(t));
      const msg = [sent ? `시트에 ${sent}건 기록했습니다` : '', skipped.length ? `이미 기록된 칸은 그대로 두었습니다: ${[...new Set(skipped)].join(', ')}` : ''].filter(Boolean).join(' · ');
      emit({ lastSync: t, message: msg || undefined });
      afterSyncHooks.forEach((f) => f());
    } catch (e) {
      emit({ error: (e as Error).message });
    } finally {
      emit({ busy: false });
      running = null;
    }
  })();
  return running;
}

/** 시트 안에 «_월간 YYYY-MM …» 보고서 탭과 그래프를 만든다 (먼저 못 보낸 기록을 보낸다) */
export async function makeSheetReport(tab: string, month: string) {
  const cfg = getConfig();
  if (!cfg) throw new Error('구글 시트가 연결되어 있지 않습니다');
  await syncNow();
  if (state.error) throw new Error(state.error);
  return call<{ sheet: string; url: string; warnings: string[] }>(cfg, { action: 'report', tab, month });
}

/** 앱 시작·인터넷 복구·화면 복귀 시 자동 동기화 */
export function startAutoSync() {
  const go = () => navigator.onLine && syncNow();
  window.addEventListener('online', go);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && go());
  go();
}
