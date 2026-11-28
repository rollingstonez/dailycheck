import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { go } from '../App';
import { downloadCsv, formatValue, prettyDate, thisMonth } from '../util';
import type { CheckItem, InspectionRecord } from '../types';
import { ensureRange, useSyncState } from '../sheet/sync';

export default function Records() {
  const [month, setMonth] = useState(thisMonth());
  const [listId, setListId] = useState('');
  const lists = useLiveQuery(() => db.checklists.orderBy('name').toArray(), []);
  const recs = useLiveQuery(
    () =>
      db.records
        .where('date')
        .between(month + '-01', month + '-32')
        .filter((r) => !listId || r.checklistId === listId)
        .reverse()
        .sortBy('date'),
    [month, listId],
  );

  const sync = useSyncState();
  useEffect(() => {
    for (const c of lists ?? []) if (c.sheetTab && (!listId || c.id === listId)) ensureRange(c.id, month + '-01', month + '-31');
  }, [lists, listId, month]);

  function exportCsv() {
    if (!recs?.length) return;
    exportRecordsCsv(recs, `DayByCheck_${month}${listId ? '_' + recs[0].checklistName : ''}.csv`);
  }

  return (
    <div className="page">
      <header className="top">
        <h1>점검 기록</h1>
      </header>
      <div className="card row2">
        <label>
          월
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} />
        </label>
        <label>
          점검표
          <select value={listId} onChange={(e) => setListId(e.target.value)}>
            <option value="">전체</option>
            {lists?.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
      </div>

      <button className="btn" disabled={!recs?.length} onClick={exportCsv}>
        ⬇ 엑셀·구글 시트용 CSV 내려받기 ({recs?.length ?? 0}건)
      </button>

      {sync.loadingOld && <div className="card notice small">지난 달 기록을 불러오는 중…</div>}
      {recs?.length === 0 && !sync.loadingOld && <div className="card empty">이 달의 기록이 없습니다.</div>}
      {recs?.map((r) => (
        <button key={r.id} className="card list-card" onClick={() => go('records', r.id)}>
          <div className="grow">
            <div className="title">{prettyDate(r.date)}</div>
            <div className="muted">{r.checklistName} · {r.inspector}</div>
          </div>
          {r.abnormal.length > 0 ? <span className="badge bad">이상 {r.abnormal.length}</span> : <span className="badge ok">정상</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * 한 행 = 한 번의 점검. 점검표가 여러 개면 항목 열을 모두 합친다.
 * 구글 시트: 파일 › 가져오기 › 업로드 로 바로 열 수 있다.
 */
export function exportRecordsCsv(recs: InspectionRecord[], filename: string) {
  const cols: CheckItem[] = [];
  const seen = new Set<string>();
  for (const r of [...recs].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const i of r.itemsSnapshot) {
      if (!seen.has(i.id)) {
        seen.add(i.id);
        cols.push(i);
      }
    }
  }
  const header = ['날짜', '점검표', '점검자', '이상 건수', '이상 항목', '정정 내역', ...cols.map((c) => (c.unit ? `${c.label}(${c.unit})` : c.label))];
  const rows = [...recs]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => {
      const byId = Object.fromEntries(r.itemsSnapshot.map((i) => [i.id, i]));
      return [
        r.date,
        r.checklistName,
        r.inspector,
        r.abnormal.length,
        r.abnormal.map((id) => byId[id]?.label ?? '').join(' / '),
        (r.corrections ?? [])
          .map((c) => `${byId[c.itemId]?.label ?? ''}: ${c.from}→${c.to} (${c.reason}, ${c.by} ${c.at})`)
          .join(' / '),
        ...cols.map((c) => {
          const v = r.values[c.id];
          if (c.type === 'number') return typeof v === 'number' ? v : '';
          return formatValue(c, v);
        }),
      ];
    });
  downloadCsv(filename, [header, ...rows]);
}
