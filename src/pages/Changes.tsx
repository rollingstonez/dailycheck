import { useState } from 'react';
import { go } from '../App';
import { approveChanges, getConfig, useSyncState } from '../sheet/sync';
import { countChanges, type Change } from '../sheet/changes';

const crit = (c: string) => (c ? `«${c}»` : '(없음)');

function ChangeLine({ c }: { c: Change }) {
  switch (c.kind) {
    case 'add':
      return <li className="chg add"><b>＋ 추가</b> {c.label}{c.criteria && <span className="muted"> · 기준 {c.criteria}</span>}</li>;
    case 'remove':
      return <li className="chg del"><b>－ 삭제</b> {c.label}</li>;
    case 'rename':
      return <li className="chg"><b>✎ 이름 변경</b> {c.from} → {c.to}</li>;
    case 'criteria':
      return <li className="chg"><b>⚙ 기준 변경</b> {c.label}: {crit(c.from)} → {crit(c.to)}</li>;
  }
}

/** 시트에서 바뀐 점검항목을 확인하고 승인하는 화면 (1인 사업자도 같은 화면: 승인 버튼, 필요하면 비밀번호) */
export default function Changes() {
  const s = useSyncState();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const total = countChanges(s.changes);
  const hasDelete = s.changes.some((c) => c.removedTab || c.changes.some((x) => x.kind === 'remove'));

  async function approve() {
    setBusy(true);
    setErr('');
    try {
      await approveChanges(pin);
      go();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="top">
        <a className="link" href="#/">‹ 오늘</a>
        <h1>변경 확인</h1>
        <div className="muted small">📄 {getConfig()?.name ?? '구글 시트'} · 시트에서 바뀐 점검항목</div>
      </header>

      {total === 0 ? (
        <div className="card empty">확인할 변경이 없습니다.<a className="btn primary" href="#/">오늘 화면으로</a></div>
      ) : (
        <>
          <div className="card notice small">
            시트의 점검항목이 {total}건 바뀌었습니다. <b>승인하기 전까지는 이전에 확정한 점검표로 계속 입력</b>할 수 있고, 승인하면 모든 폰의 화면에 반영됩니다.
          </div>

          {s.changes.map((tc) => (
            <div key={tc.tab} className="card">
              <h3>{tc.tab}</h3>
              {tc.newTab && <div className="muted small">시트에 새 탭이 생겼습니다. 항목 {tc.liveItems.length}개의 새 점검표로 추가됩니다.</div>}
              {tc.removedTab && <div className="muted small">시트에서 이 탭이 사라졌습니다. 승인하면 점검표 목록에서 지웁니다. (이 기기에 받아 둔 기록은 남습니다)</div>}
              <ul className="chg-list">{tc.changes.map((c, i) => <ChangeLine key={i} c={c} />)}</ul>
            </div>
          ))}

          {hasDelete && (
            <div className="card warnbox small">
              ⚠ <b>삭제한 행은 과거 기록까지 시트에서 이미 사라진 상태</b>입니다. 실수였다면 승인하지 말고 시트에서 되돌린 뒤(Ctrl+Z 또는 파일 › 버전 기록) 다시 동기화하세요.
            </div>
          )}

          <div className="card">
            {s.pinRequired && (
              <label>
                승인 비밀번호
                <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" autoComplete="off" placeholder="시트 스크립트에 정한 승인 비밀번호" />
              </label>
            )}
            {err && <div className="bad-text small">⚠ {err}</div>}
            <div className="row-btns">
              <button className="btn primary big" disabled={busy || (s.pinRequired && !pin)} onClick={approve}>
                {busy ? '반영 중…' : '승인하고 반영'}
              </button>
              <a className="btn big center-btn" href="#/">나중에</a>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
