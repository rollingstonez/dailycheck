import { useEffect, useState } from 'react';
import { db } from '../db';
import { go } from '../App';
import { ITEM_TYPE_LABEL, type CheckItem, type Checklist, type ItemType } from '../types';
import { criteriaText, uid } from '../util';
import { describeItem } from '../sheet/parse';

export default function ChecklistEditor({ id }: { id: string }) {
  const [c, setC] = useState<Checklist | null | undefined>(undefined);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    db.checklists.get(id).then((x) => setC(x ?? null));
  }, [id]);

  if (c === undefined) return null;
  if (c === null) return <div className="page">점검표를 찾을 수 없습니다. <a href="#/checklists">목록으로</a></div>;
  if (c.sheetTab) return <SheetPreview c={c} />;

  const patch = (p: Partial<Checklist>) => {
    setC({ ...c, ...p });
    setDirty(true);
  };
  const setItem = (idx: number, p: Partial<CheckItem>) => patch({ items: c.items.map((it, i) => (i === idx ? { ...it, ...p } : it)) });
  const move = (idx: number, d: -1 | 1) => {
    const j = idx + d;
    if (j < 0 || j >= c.items.length) return;
    const items = [...c.items];
    [items[idx], items[j]] = [items[j], items[idx]];
    patch({ items });
  };
  const add = () => patch({ items: [...c.items, { id: uid(), label: '', type: 'yesno', required: true, okAnswer: 'yes' }] });

  async function save() {
    if (!c!.name.trim()) return alert('점검표 이름을 입력하세요.');
    const blank = c!.items.findIndex((i) => !i.label.trim());
    if (blank >= 0) return alert(`${blank + 1}번 항목의 이름이 비어 있습니다.`);
    const bad = c!.items.find((i) => i.type === 'choice' && !(i.options?.length));
    if (bad) return alert(`"${bad.label}" 항목에 선택지를 하나 이상 넣어 주세요.`);
    await db.checklists.put({ ...c!, name: c!.name.trim(), updatedAt: Date.now() });
    go('checklists');
  }

  async function remove() {
    if (!confirm(`"${c!.name}" 점검표를 삭제할까요?\n이미 저장된 점검 기록은 남아 있습니다.`)) return;
    await db.checklists.delete(id);
    go('checklists');
  }

  function back() {
    if (dirty && !confirm('저장하지 않은 변경 사항이 있습니다. 나갈까요?')) return;
    go('checklists');
  }

  return (
    <div className="page editor">
      <header className="top sticky">
        <button className="link" onClick={back}>‹ 목록</button>
        <div className="grow center title">점검표 편집</div>
        <button className="link strong" onClick={save}>저장</button>
      </header>

      <div className="card">
        <label>
          점검표 이름
          <input value={c.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label>
          설명 (선택)
          <input value={c.description ?? ''} onChange={(e) => patch({ description: e.target.value })} />
        </label>
      </div>

      {c.items.map((it, idx) => (
        <section key={it.id} className="card item-edit">
          <div className="item-head">
            <span className="num">{idx + 1}</span>
            <input className="grow" value={it.label} placeholder="항목 이름 (예: 컴프레서 압력)" onChange={(e) => setItem(idx, { label: e.target.value })} />
          </div>
          <div className="row2">
            <label>
              입력 방식
              <select value={it.type} onChange={(e) => setItem(idx, defaultsFor(e.target.value as ItemType))}>
                {(Object.keys(ITEM_TYPE_LABEL) as ItemType[]).map((t) => (
                  <option key={t} value={t}>{ITEM_TYPE_LABEL[t]}</option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={it.required} onChange={(e) => setItem(idx, { required: e.target.checked })} />
              필수 입력
            </label>
          </div>

          {it.type === 'yesno' && (
            <label>
              정상인 답
              <select value={it.okAnswer ?? 'yes'} onChange={(e) => setItem(idx, { okAnswer: e.target.value as 'yes' | 'no' })}>
                <option value="yes">예 (아니오면 이상)</option>
                <option value="no">아니오 (예면 이상)</option>
              </select>
            </label>
          )}

          {it.type === 'number' && (
            <div className="row3">
              <label>
                단위
                <input value={it.unit ?? ''} placeholder="℃, bar, L" onChange={(e) => setItem(idx, { unit: e.target.value || undefined })} />
              </label>
              <label>
                기준 이상
                <NumField value={it.min} onChange={(v) => setItem(idx, { min: v })} />
              </label>
              <label>
                기준 이하
                <NumField value={it.max} onChange={(v) => setItem(idx, { max: v })} />
              </label>
            </div>
          )}

          {it.type === 'choice' && (
            <>
              <label>
                선택지 (쉼표로 구분)
                <input
                  key={(it.options ?? []).join('|')}
                  defaultValue={(it.options ?? []).join(', ')}
                  placeholder="양호, 보통, 불량"
                  onBlur={(e) => {
                    const options = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                    setItem(idx, { options, badOptions: (it.badOptions ?? []).filter((b) => options.includes(b)) });
                  }}
                />
              </label>
              {(it.options?.length ?? 0) > 0 && (
                <div>
                  <div className="muted small">이상으로 볼 선택지</div>
                  <div className="seg wrap">
                    {it.options!.map((o) => {
                      const on = it.badOptions?.includes(o);
                      return (
                        <button
                          key={o}
                          className={on ? 'on bad' : ''}
                          onClick={() => setItem(idx, { badOptions: on ? it.badOptions!.filter((b) => b !== o) : [...(it.badOptions ?? []), o] })}
                        >
                          {o}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}

          <div className="row-btns small-btns">
            <button className="btn" disabled={idx === 0} onClick={() => move(idx, -1)}>▲ 위로</button>
            <button className="btn" disabled={idx === c.items.length - 1} onClick={() => move(idx, 1)}>▼ 아래로</button>
            <button className="btn danger" onClick={() => patch({ items: c.items.filter((_, i) => i !== idx) })}>삭제</button>
          </div>
        </section>
      ))}

      <button className="btn big" onClick={add}>+ 항목 추가</button>
      <button className="btn primary big" onClick={save}>저장</button>
      <button className="btn danger" onClick={remove}>점검표 삭제</button>
    </div>
  );
}

function defaultsFor(type: ItemType): Partial<CheckItem> {
  const reset = { type, okAnswer: undefined, unit: undefined, min: undefined, max: undefined, options: undefined, badOptions: undefined };
  if (type === 'yesno') return { ...reset, okAnswer: 'yes' };
  if (type === 'choice') return { ...reset, options: ['양호', '보통', '불량'], badOptions: ['불량'] };
  return reset;
}

function NumField({ value, onChange }: { value?: number; onChange: (v: number | undefined) => void }) {
  const [t, setT] = useState(value === undefined ? '' : String(value));
  return (
    <input
      inputMode="decimal"
      value={t}
      placeholder="없음"
      onChange={(e) => {
        const s = e.target.value.replace(/[^0-9.\-]/g, '');
        setT(s);
        const n = parseFloat(s);
        onChange(s === '' || isNaN(n) ? undefined : n);
      }}
    />
  );
}

/** 시트에서 온 점검표: 앱이 시트를 어떻게 읽었는지 보여 준다 (수정은 시트에서) */
function SheetPreview({ c }: { c: Checklist }) {
  return (
    <div className="page">
      <header className="top">
        <a className="link" href="#/checklists">‹ 점검표</a>
        <h1>{c.name}</h1>
        <div className="muted small">📄 {c.monthly ? `월별 탭 ${c.tabs?.length ?? 0}개` : '구글 시트 탭'} · 항목 {c.items.length}개 (가장 최근 탭 기준)</div>
        {c.monthly && <div className="muted small">탭: {(c.tabs ?? []).map((t) => t.tab).join(', ')}</div>}
      </header>
      <div className="card notice small">
        항목 추가·수정·순서 변경은 <b>구글 시트</b>에서 하세요. 앱에서 «동기화»하면 반영됩니다.
        <br />B열 «기준»에 <code>on/off</code>, <code>100~150</code>, <code>40 이상</code>, <code>사진</code> 등을 적으면 입력 방식과 이상 판정이 정해집니다.
      </div>
      <div className="card">
        {c.items.map((it, i) => (
          <div key={it.id} className="kv">
            <span className="num-sm">{i + 1}</span>
            <div className="grow">
              <div>
                {it.label}
                {it.unit && <span className="muted"> ({it.unit})</span>}
              </div>
              <div className="muted small">
                {describeItem(it)}
                {criteriaText(it) && ` · ${criteriaText(it)}`}
                {it.photo && ' · 📷 사진'}
              </div>
            </div>
            {it.sheetCriteria && <code className="small">{it.sheetCriteria}</code>}
          </div>
        ))}
      </div>
    </div>
  );
}
