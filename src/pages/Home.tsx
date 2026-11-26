import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { go } from '../App';
import { prettyDate, today } from '../util';
import { getConfig, syncNow, useSyncState } from '../sheet/sync';
import { countChanges } from '../sheet/changes';

export default function Home() {
  const d = today();
  const lists = useLiveQuery(() => db.checklists.toArray().then((l) => l.sort(byOrder)), []);
  const recs = useLiveQuery(() => db.records.where('date').equals(d).toArray(), [d]);
  const sheetIds = new Set(lists?.filter((c) => c.sheetTab).map((c) => c.id));
  const unsent = useLiveQuery(() => db.records.filter((r) => !r.synced && r.checklistId.startsWith('sheet:')).count(), []);
  const sync = useSyncState();
  const cfg = getConfig();

  if (!lists || !recs) return null;

  return (
    <div className="page">
      <header className="top">
        <div className="muted">{prettyDate(d)}</div>
        <h1>오늘의 점검</h1>
      </header>

      {cfg ? (
        <div className={'sync-bar ' + (sync.error ? 'err' : '')}>
          <div className="grow">
            <div>
              📄 {cfg.name ?? '구글 시트'}
              {unsent ? <b> · 보낼 기록 {unsent}건</b> : null}
            </div>
            <div className="small muted">
              {sync.busy
                ? '동기화 중…'
                : sync.error
                  ? '⚠ ' + sync.error
                  : sync.message ?? (sync.lastSync ? `마지막 동기화 ${new Date(sync.lastSync).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : '')}
            </div>
          </div>
          <button className="btn sm" disabled={sync.busy} onClick={() => syncNow()}>
            {sync.busy ? '…' : '⟳ 동기화'}
          </button>
        </div>
      ) : (
        <button className="card list-card hint" onClick={() => go('checklists')}>
          <div className="grow">
            <div className="title">구글 시트 연결하기</div>
            <div className="muted small">시트에 적은 점검사항으로 입력 화면이 만들어지고, 입력하면 시트에 자동 기록됩니다</div>
          </div>
          ›
        </button>
      )}

      {cfg && countChanges(sync.changes) > 0 && (
        <button className="card list-card alert" onClick={() => go('changes')}>
          <div className="grow">
            <div className="title">⚠ 시트의 점검항목이 바뀌었습니다</div>
            <div className="muted small">변경 {countChanges(sync.changes)}건 · 확인하고 승인하면 화면에 반영됩니다</div>
          </div>
          <span className="badge todo">확인 ›</span>
        </button>
      )}

      {lists.length === 0 && <div className="card empty">아직 점검표가 없습니다.</div>}

      {lists.map((c) => {
        const rec = recs.find((r) => r.checklistId === c.id);
        return (
          <button key={c.id} className={'card list-card ' + (rec ? 'done' : '')} onClick={() => (rec ? go('inspect', c.id, rec.id) : go('inspect', c.id))}>
            <div className="grow">
              <div className="title">{c.name}</div>
              <div className="muted">
                {sheetIds.has(c.id) ? '📄 시트 · ' : ''}항목 {c.items.length}개
                {rec && ` · ${rec.inspector || '이름 없음'}${rec.time ? ' ' + rec.time : ''}`}
              </div>
            </div>
            {rec ? (
              rec.abnormal.length > 0 ? <span className="badge bad">이상 {rec.abnormal.length}</span> : <span className="badge ok">완료</span>
            ) : (
              <span className="badge todo">점검하기 ›</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** 시트 점검표 먼저, 그다음 이름순 */
export const byOrder = (a: { sheetTab?: string; name: string }, b: { sheetTab?: string; name: string }) =>
  Number(!a.sheetTab) - Number(!b.sheetTab) || a.name.localeCompare(b.name, 'ko');
