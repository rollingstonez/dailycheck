import { db } from './db';
import type { Correction, ItemValue } from './types';
import { isAbnormal, toDateStr } from './util';
import { sheetCorrect, syncNow } from './sheet/sync';
import { tabForDate } from './sheet/series';

const pad = (n: number) => String(n).padStart(2, '0');
const nowStr = () => {
  const d = new Date();
  return `${toDateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export interface CorrectOpts {
  recordId: string;
  itemId: string;
  value: ItemValue;
  reason: string;
  /** 시트 점검표일 때 승인 비밀번호 (시트 스크립트가 확인) */
  pin: string;
  inspector: string;
}

/**
 * 정정: 저장된 값은 덮어쓰지 않고, 원본·정정값·사유·시각을 남기며 고친다.
 *  - 시트 점검표: 시트 스크립트가 사유·비밀번호를 확인하고 장부(_기록, _정정)에 남긴다. 인터넷 필요.
 *  - 앱 안에서 만든 점검표: 기록에 정정 내역을 함께 저장한다.
 */
export async function correctRecord(o: CorrectOpts) {
  const reason = o.reason.trim();
  if (!reason) throw new Error('정정 사유를 입력하세요');
  let rec = await db.records.get(o.recordId);
  if (!rec) throw new Error('기록을 찾을 수 없습니다');
  const item = rec.itemsSnapshot.find((i) => i.id === o.itemId);
  if (!item) throw new Error('항목을 찾을 수 없습니다');
  const prev = rec.values[o.itemId];
  if (String(prev ?? '') === String(o.value ?? '')) throw new Error('기존 값과 같습니다');
  if (o.value === null || o.value === undefined || o.value === '') throw new Error('새 값을 입력하세요');

  const cl = await db.checklists.get(rec.checklistId);
  if (cl?.sheetTab) {
    // 아직 시트로 못 보낸 기록이면 먼저 보낸다 (그래야 원본이 장부에 남는다)
    if (!rec.synced) {
      await syncNow();
      rec = await db.records.get(o.recordId);
      if (!rec?.synced) throw new Error('인터넷에 연결된 뒤에 정정할 수 있습니다 (먼저 시트로 보내야 합니다)');
    }
    await sheetCorrect({ tab: rec.tab ?? tabForDate(cl, rec.date).tab, date: rec.date, label: item.sheetLabel ?? item.label, value: o.value, reason, inspector: o.inspector, pin: o.pin });
    await syncNow(); // 시트에서 다시 읽어 값·정정 내역 반영
    return;
  }

  const values = { ...rec.values, [o.itemId]: o.value };
  const corr: Correction = { itemId: o.itemId, from: prev ?? null, to: o.value, reason, by: o.inspector, at: nowStr() };
  await db.records.put({
    ...rec,
    values,
    abnormal: rec.itemsSnapshot.filter((i) => isAbnormal(i, values[i.id])).map((i) => i.id),
    corrections: [...(rec.corrections ?? []), corr],
    updatedAt: Date.now(),
  });
}
