import { useState } from 'react';
import { getConfig, useSyncState } from '../sheet/sync';
import { canRestore, protectNow, resolveFindings, useIntegrity, verifyNow, type Finding } from '../sheet/integrity';

const md = (d?: string) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8))}` : '');
const val = (v: unknown) => (v === undefined || v === null || v === '' ? '(비어 있음)' : String(v));

function describe(f: Finding): { title: string; detail: string } {
  switch (f.kind) {
    case 'changed':
      return { title: `${f.label} · ${md(f.date)}`, detail: `장부 ${val(f.expected)} → 시트 ${val(f.actual)}  (시트에서 직접 바뀐 값)` };
    case 'deleted':
      return { title: `${f.label} · ${md(f.date)}`, detail: `장부 ${val(f.expected)} → 시트에서 지워짐` };
    case 'unlogged':
      return { title: `${f.label} · ${md(f.date)}`, detail: `시트 ${val(f.actual)}  (앱을 거치지 않고 시트에 직접 입력된 값)` };
    case 'rowDeleted':
      return { title: `${f.label}`, detail: `점검항목 행이 시트에서 지워짐 · ${f.dates?.length ?? 0}일치 기록 (${(f.dates ?? []).slice(0, 4).map(md).join(', ')}${(f.dates?.length ?? 0) > 4 ? ' …' : ''})` };
    case 'dateDeleted':
      return { title: `${md(f.date)} 날짜 열`, detail: `날짜 열이 시트에서 지워짐 · ${f.cells?.length ?? 0}개 항목 기록` };
    case 'tabDeleted':
      return { title: `«${f.tab}» 탭`, detail: `탭이 시트에서 지워짐 · 기록 ${f.count ?? 0}칸 (구글 시트의 «버전 기록»으로 복원하세요)` };
  }
}

const keyOf = (f: Finding) => [f.kind, f.tab, f.date ?? '', f.label ?? ''].join('|');

/** 장부와 시트 비교: 앱을 거치지 않고 시트에서 직접 바뀐 값을 찾아서 되돌리거나 인정한다 */
export default function Integrity() {
  const s = useIntegrity();
  const sync = useSyncState();
  const cfg = getConfig();
  const [dlg, setDlg] = useState<{ mode: 'restore' | 'accept'; items: Finding[] } | null>(null);
  const [protectMsg, setProtectMsg] = useState('');

  async function doProtect() {
    setProtectMsg('');
    try {
      await protectNow();
      setProtectMsg('✓ 시트 보호를 적용했습니다. (기록 칸을 고치거나 지우려 하면 구글 시트가 경고합니다)');
    } catch (e) {
      setProtectMsg('⚠ ' + (e as Error).message);
    }
  }

  const tabs = [...new Set(s.findings.map((f) => f.tab))];

  return (
    <div className="page">
      <header className="top">
        <a className="link" href="#/checklists">‹ 점검표</a>
        <h1>기록 검사</h1>
        <div className="muted small">시트에 적힌 값을 «앱이 남긴 장부»와 비교합니다</div>
      </header>

      {!cfg ? (
        <div className="card empty">구글 시트가 연결되어 있지 않습니다.<a className="btn primary" href="#/checklists">시트 연결하기</a></div>
      ) : (
        <>
          <div className={'card ' + (s.findings.length ? 'warnbox' : '')}>
            <div className="title">
              {s.findings.length > 0 ? `⚠ 시트에서 직접 바뀐 것 ${s.findings.length}건` : s.checkedAt ? '✓ 장부와 시트가 일치합니다' : '아직 검사하지 않았습니다'}
            </div>
            <div className="small muted">
              {s.checkedAt ? `마지막 검사 ${new Date(s.checkedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · 비교한 칸 ${s.checked ?? 0}개` : '버튼을 눌러 검사하세요. 앱을 쓰면 6시간마다 자동으로 검사합니다.'}
            </div>
            {s.error && <div className="bad-text small">⚠ {s.error}</div>}
            <button className="btn primary" disabled={s.busy} onClick={() => verifyNow()}>{s.busy ? '검사 중…' : '지금 검사'}</button>
          </div>

          {tabs.map((tab) => {
            const list = s.findings.filter((f) => f.tab === tab);
            return (
              <div key={tab} className="card">
                <h3>{tab}</h3>
                <ul className="chg-list">
                  {list.map((f) => {
                    const d = describe(f);
                    return (
                      <li key={keyOf(f)} className={'chg ' + (f.kind === 'unlogged' ? 'add' : 'del')}>
                        <div><b>{d.title}</b></div>
                        <div className="small muted">{d.detail}</div>
                        <div className="row-btns small-btns">
                          {canRestore(f) && <button className="btn" onClick={() => setDlg({ mode: 'restore', items: [f] })}>되돌리기</button>}
                          <button className="btn" onClick={() => setDlg({ mode: 'accept', items: [f] })}>인정</button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}

          {s.findings.length > 1 && (
            <div className="row-btns">
              <button className="btn" onClick={() => setDlg({ mode: 'restore', items: s.findings.filter(canRestore) })}>되돌릴 수 있는 것 모두 되돌리기</button>
              <button className="btn" onClick={() => setDlg({ mode: 'accept', items: s.findings })}>모두 인정</button>
            </div>
          )}

          {s.findings.length > 0 && (
            <div className="card notice small">
              <b>되돌리기</b>: 장부에 남은 값으로 시트를 복구합니다. 바뀐 값은 장부에 «이전값»으로 남습니다.<br />
              <b>인정</b>: 시트의 값이 맞다고 확인하고 사유를 남깁니다. 장부에 «직접수정 확인»으로 기록되고 다시 나타나지 않습니다.
            </div>
          )}

          <div className="card">
            <h3>시트 보호</h3>
            <div className="small muted">
              연결할 때 자동으로 걸립니다. 기록 칸(날짜 열)을 고치거나 그 칸이 든 행·열을 지우려 하면 구글 시트가 경고를 띄웁니다. 점검사항·기준 칸은 그대로 고칠 수 있습니다. 숨김 장부 탭은 시트 주인만 고칠 수 있게 잠깁니다.
            </div>
            {protectMsg && <div className="small">{protectMsg}</div>}
            <button className="btn" onClick={doProtect}>시트 보호 다시 적용</button>
          </div>
        </>
      )}

      {dlg && <ResolveDialog mode={dlg.mode} items={dlg.items} needPin={sync.pinRequired} onClose={() => setDlg(null)} />}
    </div>
  );
}

function ResolveDialog({ mode, items, needPin, onClose }: { mode: 'restore' | 'accept'; items: Finding[]; needPin: boolean; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const accept = mode === 'accept';

  async function submit() {
    setBusy(true);
    setErr('');
    try {
      await resolveFindings(mode, items, reason, pin);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay">
      <div className="sheet">
        <h3>{accept ? '시트의 값 인정' : '장부의 값으로 되돌리기'} · {items.length}건</h3>
        <div className="small muted">
          {accept
            ? '시트의 값이 맞다고 확인하는 것입니다. 사유가 장부에 남습니다.'
            : '시트를 장부에 남은 값으로 복구합니다. 지금 시트에 적힌 값은 장부에 «이전값»으로 남습니다.'}
        </div>
        <ul className="confirm-list">
          {items.slice(0, 8).map((f) => (
            <li key={keyOf(f)}>
              <span>{describe(f).title}</span>
            </li>
          ))}
          {items.length > 8 && <li><span className="muted">… 외 {items.length - 8}건</span></li>}
        </ul>
        <label>
          {accept ? '인정 사유 (필수)' : '메모 (선택)'}
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={accept ? '예: 점검자가 시트에 직접 적은 값을 확인함' : '예: 실수로 고친 값을 되돌림'} />
        </label>
        {needPin && (
          <label>
            승인 비밀번호
            <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" autoComplete="off" />
          </label>
        )}
        {err && <div className="bad-text small">⚠ {err}</div>}
        <div className="row-btns">
          <button className="btn big" disabled={busy} onClick={onClose}>취소</button>
          <button className="btn primary big" disabled={busy || (accept && !reason.trim()) || (needPin && !pin)} onClick={submit}>
            {busy ? '처리 중…' : accept ? '인정' : '되돌리기'}
          </button>
        </div>
      </div>
    </div>
  );
}
