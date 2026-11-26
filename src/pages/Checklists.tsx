import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { go } from '../App';
import { TEMPLATES } from '../templates';
import { uid } from '../util';
import { connect, disconnect, getConfig, syncNow, useSyncState } from '../sheet/sync';
import { byOrder } from './Home';

export default function Checklists() {
  const lists = useLiveQuery(() => db.checklists.toArray().then((l) => l.sort(byOrder)), []);
  const [picking, setPicking] = useState(false);

  async function create(ti: number) {
    const t = TEMPLATES[ti];
    const now = Date.now();
    const id = uid();
    await db.checklists.add({
      id,
      name: t.items.length ? t.name : '새 점검표',
      description: t.items.length ? t.description : '',
      items: t.items.map((i) => ({ ...i, id: uid() })),
      createdAt: now,
      updatedAt: now,
    });
    go('checklists', id);
  }

  return (
    <div className="page">
      <header className="top">
        <h1>점검표</h1>
      </header>

      <SheetConnect />

      {lists?.map((c) => (
        <button key={c.id} className="card list-card" onClick={() => go('checklists', c.id)}>
          <div className="grow">
            <div className="title">{c.name}</div>
            <div className="muted">
              {c.sheetTab ? '📄 구글 시트 탭 · ' : '이 기기에서 만든 점검표 · '}항목 {c.items.length}개
            </div>
          </div>
          <span className="muted">{c.sheetTab ? '보기 ›' : '편집 ›'}</span>
        </button>
      ))}

      {!picking ? (
        <button className="btn" onClick={() => setPicking(true)}>+ 시트 없이 앱에서 점검표 만들기</button>
      ) : (
        <div className="card">
          <h3>어떤 서식으로 시작할까요?</h3>
          {TEMPLATES.map((t, i) => (
            <button key={t.name} className="card list-card inner" onClick={() => create(i)}>
              <div className="grow">
                <div className="title">{t.name}</div>
                <div className="muted small">{t.description}{t.items.length ? ` · 항목 ${t.items.length}개` : ''}</div>
              </div>
              ›
            </button>
          ))}
          <button className="link" onClick={() => setPicking(false)}>취소</button>
        </div>
      )}
    </div>
  );
}

function SheetConnect() {
  const cfg = getConfig();
  const sync = useSyncState();
  const [url, setUrl] = useState(cfg?.url ?? '');
  const [token, setToken] = useState(cfg?.token ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(!cfg);

  async function doConnect() {
    setBusy(true);
    setErr('');
    try {
      await connect(url, token);
      setEditing(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doDisconnect() {
    if (!confirm('시트 연결을 끊을까요?\n이 기기에 받아 둔 점검표와 기록은 남아 있습니다.')) return;
    await disconnect();
    setEditing(true);
  }

  if (cfg && !editing) {
    return (
      <div className="card">
        <div className="row-head">
          <div className="grow">
            <div className="title">📄 {cfg.name ?? '구글 시트'}</div>
            <div className="muted small">
              연결됨{sync.lastSync ? ` · 마지막 동기화 ${new Date(sync.lastSync).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
            </div>
            {sync.error && <div className="bad-text small">⚠ {sync.error}</div>}
          </div>
        </div>
        <div className="row-btns">
          <button className="btn primary" disabled={sync.busy} onClick={() => syncNow()}>{sync.busy ? '동기화 중…' : '⟳ 지금 동기화'}</button>
          <button className="btn" onClick={() => setEditing(true)}>설정</button>
        </div>
        <a className="btn center-btn" href="#/integrity">🔍 기록 검사 · 시트 보호</a>
      </div>
    );
  }

  return (
    <div className="card">
      <h3>구글 시트 연결</h3>
      <p className="muted small" style={{ margin: 0 }}>
        시트에 연결 스크립트를 설치하고 나온 <b>웹 앱 URL</b>과 스크립트에 정한 <b>비밀번호</b>를 넣으세요.
        (설치 방법: 프로젝트의 apps-script/설치방법.md)
      </p>
      <label>
        웹 앱 URL
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://script.google.com/macros/s/…/exec" inputMode="url" autoCapitalize="off" autoCorrect="off" />
      </label>
      <label>
        비밀번호
        <input value={token} onChange={(e) => setToken(e.target.value)} autoCapitalize="off" autoCorrect="off" />
      </label>
      {err && <div className="bad-text small">⚠ {err}</div>}
      <div className="row-btns">
        <button className="btn primary" disabled={busy || !url.trim()} onClick={doConnect}>{busy ? '연결 중…' : '연결'}</button>
        {cfg && <button className="btn" onClick={() => setEditing(false)}>취소</button>}
      </div>
      {cfg && <button className="link" style={{ color: 'var(--bad)' }} onClick={doDisconnect}>연결 끊기</button>}
    </div>
  );
}
