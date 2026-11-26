import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { go } from '../App';
import { criteriaText, formatValue, prettyDate } from '../util';
import PhotoThumb from '../components/PhotoThumb';

export default function RecordDetail({ id }: { id: string }) {
  const r = useLiveQuery(() => db.records.get(id).then((x) => x ?? null), [id]);
  if (r === undefined) return null;
  if (r === null) return <div className="page">기록을 찾을 수 없습니다. <a href="#/records">목록으로</a></div>;

  return (
    <div className="page">
      <header className="top">
        <a className="link" href="#/records">‹ 기록</a>
        <h1>{prettyDate(r.date)}</h1>
        <div className="muted">{r.checklistName} · 점검자 {r.inspector}{r.time ? ` · ${r.time}` : ''}</div>
        {r.checklistId.startsWith('sheet:') && (
          <div className={'small ' + (r.synced ? 'muted' : 'bad-text')}>
            {r.synced ? '📄 구글 시트에 기록됨' : `⏳ 시트로 보내기 대기 중${r.syncError ? ' · ' + r.syncError : ''}`}
          </div>
        )}
      </header>

      <div className="card">
        {r.itemsSnapshot.map((item) => {
          const v = r.values[item.id];
          const bad = r.abnormal.includes(item.id);
          return (
            <div key={item.id} className={'kv wrapk ' + (bad ? 'is-bad' : '')}>
              <div className="grow">
                <div>{item.label}</div>
                {criteriaText(item) && <div className="muted small">{criteriaText(item)}</div>}
              </div>
              <div className="v">
                {item.type !== 'photo' && (formatValue(item, v) || <span className="muted">—</span>)}
                {(r.photos?.[item.id]?.length ?? 0) > 0 && (
                  <div className="photos sm">{r.photos![item.id].map((p) => <PhotoThumb key={p} id={p} />)}</div>
                )}
                {!r.photos?.[item.id]?.length && (r.photoLinks?.[item.id] ?? []).map((u, k) => (
                  <div key={u}><a href={u} target="_blank" rel="noreferrer" className="small">📷 사진 {k + 1}</a></div>
                ))}
                {bad && ' ⚠'}
              </div>
              {(r.corrections ?? []).filter((c) => c.itemId === item.id).map((c, i) => (
                <div key={i} className="ri-corr kv-corr">
                  ✎ 정정 {formatValue(item, c.from) || '—'} → <b>{formatValue(item, c.to)}</b> · 사유: {c.reason} · {c.by} · {c.at}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div className="card notice small">
        🔒 저장된 기록은 지우거나 덮어쓸 수 없습니다. 값을 고치려면 사유를 남기는 <b>정정</b>을 하세요. 원본 값은 {r.checklistId.startsWith('sheet:') ? '시트의 숨김 탭 «_기록»' : '정정 내역'}에 남습니다.
      </div>
      <button className="btn" onClick={() => go('inspect', r.checklistId, r.id)}>정정 · 보완 입력</button>
    </div>
  );
}
