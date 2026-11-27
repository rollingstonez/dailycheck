import { useSyncExternalStore } from 'react';
import { db } from '../db';
import type { Checklist, InspectionRecord, ItemValue } from '../types';
import { isAbnormal } from '../util';
import { toCheckItem, type SheetTab } from './parse';

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
}
let state: SyncState = { busy: false, lastSync: Number(localStorage.getItem(LAST_KEY)) || undefined };
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

/** 연결 테스트 + 저장 */
export async function connect(url: string, token: string) {
  const cfg = { url: url.trim(), token: token.trim() };
  const r = await call<{ name: string; tabs: SheetTab[] }>(cfg, { action: 'read' });
  setConfig({ ...cfg, name: r.name });
  await applyRead(r.tabs);
  emit({ lastSync: Date.now(), error: undefined });
  localStorage.setItem(LAST_KEY, String(Date.now()));
  return r;
}

export async function disconnect() {
  setConfig(null);
}

/* ───── 시트 → 앱 ───── */

export const sheetChecklistId = (tab: string) => `sheet:${tab}`;
export const sheetRecordId = (checklistId: string, date: string) => `${checklistId}|${date}`;

async function applyRead(tabs: SheetTab[]) {
  const now = Date.now();
  const keepIds = new Set<string>();
  await db.transaction('rw', db.checklists, db.records, async () => {
    for (const t of tabs) {
      if (!t.items.length) continue;
      const id = sheetChecklistId(t.tab);
      keepIds.add(id);
      const items = t.items.map((si) => toCheckItem(t.tab, si));
      const old = await db.checklists.get(id);
      const cl: Checklist = { id, name: t.tab, items, sheetTab: t.tab, createdAt: old?.createdAt ?? now, updatedAt: now };
      await db.checklists.put(cl);

      // 이 기기에서 아직 못 보낸 기록은 덮어쓰지 않는다
      const local = await db.records.where('checklistId').equals(id).toArray();
      const pending = new Map(local.filter((r) => !r.synced).map((r) => [r.date, r]));
      const prev = new Map(local.map((r) => [r.date, r]));
      await db.records.bulkDelete(local.filter((r) => r.synced).map((r) => r.id));

      const recs: InspectionRecord[] = [];
      for (const date of t.dates) {
        if (pending.has(date)) continue;
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
        recs.push({
          id: sheetRecordId(id, date),
          checklistId: id,
          checklistName: t.tab,
          date,
          inspector: String(t.inspector[date] ?? ''),
          time: t.time[date] ? String(t.time[date]) : undefined,
          values,
          abnormal: items.filter((it) => isAbnormal(it, values[it.id])).map((it) => it.id),
          itemsSnapshot: items,
          photos: p?.photos,
          photoLinks,
          photoNotes,
          createdAt: p?.createdAt ?? now,
          updatedAt: now,
          synced: true,
        });
      }
      await db.records.bulkPut(recs);
    }
    // 시트에서 사라진 탭 정리 (못 보낸 기록이 없을 때만)
    const sheetLists = await db.checklists.filter((c) => !!c.sheetTab).toArray();
    for (const c of sheetLists) {
      if (keepIds.has(c.id)) continue;
      const unsent = await db.records.where('checklistId').equals(c.id).filter((r) => !r.synced).count();
      if (!unsent) await db.checklists.delete(c.id);
    }
  });
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

async function pushRecord(cfg: SheetConfig, rec: InspectionRecord, tab: string) {
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
    const note = rec.photoNotes?.[it.id] ?? (it.type === 'memo' && typeof v === 'string' ? v : '');
    entries.push({ label: it.sheetLabel, value: v === undefined || v === null ? '' : v, photos, note });
  }
  const r = await call<{ missing: string[]; photos: { id: string; url: string }[] }>(cfg, {
    action: 'submit',
    tab,
    date: rec.date,
    inspector: rec.inspector,
    time: rec.time,
    entries,
  });
  for (const p of r.photos) await db.photos.update(p.id, { uploadedUrl: p.url });
  await db.records.update(rec.id, {
    synced: true,
    syncError: r.missing.length ? `시트에 없는 항목: ${r.missing.join(', ')}` : undefined,
  });
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
      const tabOf = new Map(lists.map((c) => [c.id, c.sheetTab!]));
      const pending = await db.records.filter((r) => !r.synced && tabOf.has(r.checklistId)).toArray();
      let sent = 0;
      for (const rec of pending) {
        try {
          await pushRecord(cfg, rec, tabOf.get(rec.checklistId)!);
          sent++;
        } catch (e) {
          await db.records.update(rec.id, { syncError: (e as Error).message });
          throw e;
        }
      }
      const r = await call<{ name: string; tabs: SheetTab[] }>(cfg, { action: 'read' });
      if (r.name !== cfg.name) setConfig({ ...cfg, name: r.name });
      await applyRead(r.tabs);
      const t = Date.now();
      localStorage.setItem(LAST_KEY, String(t));
      emit({ lastSync: t, message: sent ? `시트에 ${sent}건 기록했습니다` : undefined });
    } catch (e) {
      emit({ error: (e as Error).message });
    } finally {
      emit({ busy: false });
      running = null;
    }
  })();
  return running;
}

/** 시트 안에 «_월간 YYYY-MM 탭이름» 보고서 탭과 그래프를 만든다 (못 보낸 기록부터 보낸 뒤) */
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
