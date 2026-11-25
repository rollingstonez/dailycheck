import { useLiveQuery } from 'dexie-react-hooks';
import { db, deleteRecord } from '../db';
import { go } from '../App';
import { criteriaText, formatValue, prettyDate } from '../util';
import PhotoThumb from '../components/PhotoThumb';

export default function RecordDetail({ id }: { id: string }) {
  const r = useLiveQuery(() => db.records.get(id).then((x) => x ?? null), [id]);
  if (r === undefined) return null;
  if (r === null) return <div className="page">기록을 찾을 수 없습니다. <a href="#/records">목록으로</a></div>;

  async function del() {
    if (!confirm('이 기록을 삭제할까요? 되돌릴 수 없습니다.')) return;
    await deleteRecord(id);
    go('records');
  }

  return (
    <div className="page">
      <header className="top">
        <a className="link" href="#/records">‹ 기록</a>
        <h1>{prettyDate(r.date)}</h1>
        <div className="muted">{r.checklistName} · 점검자 {r.inspector}</div>
      </header>

      <div className="card">
        {r.itemsSnapshot.map((item) => {
          const v = r.values[item.id];
          const bad = r.abnormal.includes(item.id);
          return (
            <div key={item.id} className={'kv ' + (bad ? 'is-bad' : '')}>
              <div className="grow">
                <div>{item.label}</div>
                {criteriaText(item) && <div className="muted small">{criteriaText(item)}</div>}
              </div>
              <div className="v">
                {item.type === 'photo' ? (
                  <div className="photos">{((v as string[]) ?? []).map((p) => <PhotoThumb key={p} id={p} />)}</div>
                ) : (
                  formatValue(item, v) || <span className="muted">—</span>
                )}
                {bad && ' ⚠'}
              </div>
            </div>
          );
        })}
      </div>

      <div className="row-btns">
        <button className="btn" onClick={() => go(`inspect/${r.checklistId}/${r.id}`)}>수정</button>
        <button className="btn danger" onClick={del}>삭제</button>
      </div>
    </div>
  );
}
