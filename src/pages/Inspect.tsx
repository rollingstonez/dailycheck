import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { go } from '../App';
import type { CheckItem, InspectionRecord, ItemValue } from '../types';
import { compressImage, criteriaText, isAbnormal, isEmpty, today, uid } from '../util';
import PhotoThumb from '../components/PhotoThumb';

const INSPECTOR_KEY = 'dc:inspector';

interface Props {
  checklistId?: string;
  recordId?: string;
}

export default function Inspect({ checklistId, recordId }: Props) {
  const checklist = useLiveQuery(() => (checklistId ? db.checklists.get(checklistId).then((c) => c ?? null) : null), [checklistId]);
  const [existing, setExisting] = useState<InspectionRecord | null | undefined>(undefined);
  const [values, setValues] = useState<Record<string, ItemValue>>({});
  const [inspector, setInspector] = useState(() => localStorage.getItem(INSPECTOR_KEY) ?? '');
  const [date, setDate] = useState(today());
  const [missing, setMissing] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // 새 기록이면 미리 id를 정해 두고 사진을 그 id로 바로 저장
  const recId = useMemo(() => recordId ?? uid(), [recordId]);
  const draftKey = `dc:draft:${checklistId}:${recordId ?? 'new'}`;
  const loaded = useRef(false);

  useEffect(() => {
    (async () => {
      const rec = recordId ? await db.records.get(recordId) : null;
      setExisting(rec ?? null);
      const draft = localStorage.getItem(draftKey);
      if (draft) {
        const d = JSON.parse(draft);
        setValues(d.values ?? {});
        if (d.date) setDate(d.date);
      } else if (rec) {
        setValues(rec.values);
        setDate(rec.date);
        setInspector(rec.inspector);
      }
      loaded.current = true;
    })();
  }, [recordId, draftKey]);

  // 입력 도중 앱이 꺼져도 이어서 쓸 수 있도록 임시 저장
  useEffect(() => {
    if (!loaded.current) return;
    localStorage.setItem(draftKey, JSON.stringify({ values, date }));
  }, [values, date, draftKey]);

  if (checklist === undefined || existing === undefined) return null;
  if (checklist === null) return <div className="page">점검표를 찾을 수 없습니다.</div>;

  const items = checklist.items;
  const set = (id: string, v: ItemValue) => {
    setValues((p) => ({ ...p, [id]: v }));
    setMissing((m) => m.filter((x) => x !== id));
  };

  const filled = items.filter((i) => !isEmpty(i, values[i.id])).length;
  const abnormalNow = items.filter((i) => isAbnormal(i, values[i.id]));

  async function save() {
    const miss = items.filter((i) => i.required && isEmpty(i, values[i.id])).map((i) => i.id);
    if (miss.length) {
      setMissing(miss);
      document.getElementById('item-' + miss[0])?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!inspector.trim()) {
      alert('점검자 이름을 입력해 주세요.');
      document.getElementById('inspector')?.focus();
      return;
    }
    setSaving(true);
    localStorage.setItem(INSPECTOR_KEY, inspector.trim());
    const now = Date.now();
    const rec: InspectionRecord = {
      id: recId,
      checklistId: checklist!.id,
      checklistName: checklist!.name,
      date,
      inspector: inspector.trim(),
      values,
      abnormal: abnormalNow.map((i) => i.id),
      itemsSnapshot: existing?.itemsSnapshot && existing.checklistId === checklist!.id ? mergeSnapshot(existing.itemsSnapshot, items) : items,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      synced: false,
    };
    await db.records.put(rec);
    // 삭제된 사진 정리
    const keep = new Set(items.filter((i) => i.type === 'photo').flatMap((i) => (values[i.id] as string[]) ?? []));
    await db.photos.where('recordId').equals(recId).filter((p) => !keep.has(p.id)).delete();
    localStorage.removeItem(draftKey);
    go('');
  }

  async function cancel() {
    if (filled > 0 && !confirm('저장하지 않고 나갈까요? 입력한 내용이 사라집니다.')) return;
    localStorage.removeItem(draftKey);
    if (!existing) await db.photos.where('recordId').equals(recId).delete();
    go('');
  }

  return (
    <div className="page inspect">
      <header className="top sticky">
        <button className="link" onClick={cancel}>‹ 나가기</button>
        <div className="grow center">
          <div className="title">{checklist.name}</div>
          <div className="progress"><div style={{ width: `${items.length ? (filled / items.length) * 100 : 0}%` }} /></div>
        </div>
        <span className="muted small">{filled}/{items.length}</span>
      </header>

      <div className="card row2">
        <label>
          점검자
          <input id="inspector" value={inspector} onChange={(e) => setInspector(e.target.value)} placeholder="이름" />
        </label>
        <label>
          날짜
          <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>

      {items.map((item, idx) => (
        <ItemCard
          key={item.id}
          n={idx + 1}
          item={item}
          value={values[item.id]}
          onChange={(v) => set(item.id, v)}
          missing={missing.includes(item.id)}
          recordId={recId}
        />
      ))}

      {items.length === 0 && <div className="card empty">항목이 없습니다. 점검표에서 항목을 추가하세요.</div>}

      <div className="savebar">
        {abnormalNow.length > 0 && <div className="warn">기준 벗어남 {abnormalNow.length}건: {abnormalNow.map((i) => i.label).join(', ')}</div>}
        {missing.length > 0 && <div className="warn">필수 항목 {missing.length}개가 비어 있습니다</div>}
        <button className="btn primary big" disabled={saving} onClick={save}>
          {existing ? '수정 저장' : '저장'}
        </button>
      </div>
    </div>
  );
}

/** 기존 기록을 수정할 때: 기록 당시 항목은 유지하고, 새로 생긴 항목만 덧붙인다 */
function mergeSnapshot(old: CheckItem[], cur: CheckItem[]) {
  const ids = new Set(old.map((i) => i.id));
  return [...old.map((o) => cur.find((c) => c.id === o.id) ?? o), ...cur.filter((c) => !ids.has(c.id))];
}

interface ItemProps {
  n: number;
  item: CheckItem;
  value: ItemValue | undefined;
  onChange: (v: ItemValue) => void;
  missing: boolean;
  recordId: string;
}

function ItemCard({ n, item, value, onChange, missing, recordId }: ItemProps) {
  const bad = isAbnormal(item, value);
  const crit = criteriaText(item);
  return (
    <section id={'item-' + item.id} className={'card item ' + (bad ? 'is-bad ' : '') + (missing ? 'is-missing' : '')}>
      <div className="item-head">
        <span className="num">{n}</span>
        <div className="grow">
          <div className="label">
            {item.label}
            {item.required && <span className="req">*</span>}
          </div>
          {crit && <div className="muted small">{crit}</div>}
        </div>
      </div>
      <ItemInput item={item} value={value} onChange={onChange} recordId={recordId} />
      {bad && <div className="bad-text">⚠ 기준을 벗어났습니다</div>}
    </section>
  );
}

function ItemInput({ item, value, onChange, recordId }: Omit<ItemProps, 'n' | 'missing'>) {
  switch (item.type) {
    case 'yesno':
      return (
        <div className="seg two">
          {(['yes', 'no'] as const).map((a) => (
            <button
              key={a}
              className={value === a ? ((item.okAnswer ?? 'yes') === a ? 'on ok' : 'on bad') : ''}
              onClick={() => onChange(value === a ? null : a)}
            >
              {a === 'yes' ? '예' : '아니오'}
            </button>
          ))}
        </div>
      );
    case 'number':
      return <NumberInput item={item} value={value} onChange={onChange} />;
    case 'choice':
      return (
        <div className="seg wrap">
          {(item.options ?? []).map((o) => (
            <button
              key={o}
              className={value === o ? ((item.badOptions ?? []).includes(o) ? 'on bad' : 'on ok') : ''}
              onClick={() => onChange(value === o ? null : o)}
            >
              {o}
            </button>
          ))}
        </div>
      );
    case 'memo':
      return (
        <textarea rows={2} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="내용 입력" />
      );
    case 'photo':
      return <PhotoInput value={(value as string[]) ?? []} onChange={onChange} recordId={recordId} />;
  }
}

function NumberInput({ item, value, onChange }: { item: CheckItem; value: ItemValue | undefined; onChange: (v: ItemValue) => void }) {
  // 입력 중 "12." 같은 상태를 유지하기 위해 문자열로 따로 들고 있음
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  useEffect(() => {
    if (typeof value === 'number' && Number(text) !== value) setText(String(value));
    if (value === null || value === undefined) setText('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className="num-input">
      <input
        inputMode="decimal"
        value={text}
        placeholder="숫자 입력"
        onChange={(e) => {
          const t = e.target.value.replace(/[^0-9.\-]/g, '');
          setText(t);
          const n = parseFloat(t);
          onChange(t === '' || isNaN(n) ? null : n);
        }}
      />
      {item.unit && <span className="unit">{item.unit}</span>}
    </div>
  );
}

function PhotoInput({ value, onChange, recordId }: { value: string[]; onChange: (v: ItemValue) => void; recordId: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const ids: string[] = [];
      for (const f of Array.from(files)) {
        const blob = await compressImage(f);
        const id = uid();
        await db.photos.add({ id, recordId, blob, createdAt: Date.now() });
        ids.push(id);
      }
      onChange([...value, ...ids]);
    } catch (e) {
      alert('사진을 저장하지 못했습니다: ' + (e as Error).message);
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = '';
    }
  }
  return (
    <div>
      <div className="photos">
        {value.map((id) => (
          <PhotoThumb key={id} id={id} onRemove={() => onChange(value.filter((x) => x !== id))} />
        ))}
      </div>
      <input ref={ref} type="file" accept="image/*" capture="environment" hidden multiple onChange={(e) => add(e.target.files)} />
      <button className="btn" disabled={busy} onClick={() => ref.current?.click()}>
        {busy ? '저장 중…' : '📷 사진 찍기'}
      </button>
    </div>
  );
}
