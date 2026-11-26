import Dexie, { type Table } from 'dexie';
import type { Checklist, InspectionRecord, Photo } from './types';
import { TEMPLATES } from './templates';
import { uid } from './util';

/** 기기 안(IndexedDB)에 저장 → 인터넷이 없어도 입력·조회 가능 */
class DailyCheckDB extends Dexie {
  checklists!: Table<Checklist, string>;
  records!: Table<InspectionRecord, string>;
  photos!: Table<Photo, string>;

  constructor() {
    super('dailycheck');
    this.version(1).stores({
      checklists: 'id, name, updatedAt',
      records: 'id, checklistId, date, [checklistId+date], synced',
      photos: 'id, recordId',
    });
  }
}

export const db = new DailyCheckDB();

/** 처음 실행 시 예시 점검표를 하나 넣어 둔다 */
export async function seedIfEmpty() {
  const n = await db.checklists.count();
  if (n > 0) return;
  const now = Date.now();
  const t = TEMPLATES[0];
  await db.checklists.add({
    id: uid(),
    name: t.name,
    description: t.description,
    items: t.items.map((i) => ({ ...i, id: uid() })),
    createdAt: now,
    updatedAt: now,
  });
}
