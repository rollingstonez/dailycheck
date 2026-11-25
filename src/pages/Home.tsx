import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { go } from '../App';
import { prettyDate, today } from '../util';

export default function Home() {
  const d = today();
  const lists = useLiveQuery(() => db.checklists.orderBy('name').toArray(), []);
  const recs = useLiveQuery(() => db.records.where('date').equals(d).toArray(), [d]);
  const unsynced = useLiveQuery(() => db.records.filter((r) => !r.synced).count(), []);

  if (!lists || !recs) return null;

  return (
    <div className="page">
      <header className="top">
        <div className="muted">{prettyDate(d)}</div>
        <h1>오늘의 점검</h1>
      </header>

      {lists.length === 0 && (
        <div className="card empty">
          아직 점검표가 없습니다.
          <button className="btn primary" onClick={() => go('checklists')}>점검표 만들기</button>
        </div>
      )}

      {lists.map((c) => {
        const rec = recs.find((r) => r.checklistId === c.id);
        return (
          <button
            key={c.id}
            className={'card list-card ' + (rec ? 'done' : '')}
            onClick={() => go(rec ? `inspect/${c.id}/${rec.id}` : `inspect/${c.id}`)}
          >
            <div className="grow">
              <div className="title">{c.name}</div>
              <div className="muted">
                항목 {c.items.length}개
                {rec && ` · ${rec.inspector || '이름 없음'} 점검`}
              </div>
            </div>
            {rec ? (
              rec.abnormal.length > 0 ? (
                <span className="badge bad">이상 {rec.abnormal.length}</span>
              ) : (
                <span className="badge ok">완료</span>
              )
            ) : (
              <span className="badge todo">점검하기 ›</span>
            )}
          </button>
        );
      })}

      {unsynced !== undefined && unsynced > 0 && (
        <p className="muted small center">
          이 기기에 저장된 기록 {unsynced}건 · 서버 동기화는 아직 연결 전입니다
        </p>
      )}
    </div>
  );
}
