import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { go } from '../App';
import { TEMPLATES } from '../templates';
import { uid } from '../util';

export default function Checklists() {
  const lists = useLiveQuery(() => db.checklists.orderBy('name').toArray(), []);
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
    go('checklists/' + id);
  }

  return (
    <div className="page">
      <header className="top">
        <h1>점검표 관리</h1>
      </header>

      {lists?.map((c) => (
        <button key={c.id} className="card list-card" onClick={() => go('checklists/' + c.id)}>
          <div className="grow">
            <div className="title">{c.name}</div>
            <div className="muted">항목 {c.items.length}개{c.description ? ` · ${c.description}` : ''}</div>
          </div>
          <span className="muted">편집 ›</span>
        </button>
      ))}

      {!picking ? (
        <button className="btn primary big" onClick={() => setPicking(true)}>+ 새 점검표</button>
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
