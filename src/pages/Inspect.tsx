import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { go } from '../App';
import type { CheckItem, InspectionRecord, ItemValue } from '../types';
import { compressImage, criteriaText, hhmm, isAbnormal, stampNow, today, uid } from '../util';
import PhotoThumb from '../components/PhotoThumb';
import { sheetRecordId, syncNow } from '../sheet/sync';

const INSPECTOR_KEY = 'dc:inspector';

interface Props {
  checklistId?: string;
  recordId?: string;
}

type Photos = Record<string, string[]>;

const hasValue = (v: ItemValue | undefined) => v !== null && v !== undefined && v !== '';

export default function Inspect({ checklistId, recordId }: Props) {
  const checklist = useLiveQuery(() => (checklistId ? db.checklists.get(checklistId).then((c) => c ?? null) : null), [checklistId]);
  const [existing, setExisting] = useState<InspectionRecord | null | undefined>(undefined);
  const [values, setValues] = useState<Record<string, ItemValue>>({});
  const [photos, setPhotos] = useState<Photos>({});
  const [inspector, setInspector] = useState(() => localStorage.getItem(INSPECTOR_KEY) ?? '');
  const [date, setDate] = useState(today());
  const [missing, setMissing] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // 사진은 찍는 즉시 이 id로 기기에 저장해 둔다
  const tempId = useMemo(() => recordId ?? 'tmp-' + uid(), [recordId]);
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
        setPhotos(d.photos ?? {});
        if (d.date) setDate(d.date);
      } else if (rec) {
        setValues(rec.values);
        setPhotos(rec.photos ?? {});
        setDate(rec.date);
        if (rec.inspector) setInspector(rec.inspector);
      }
      loaded.current = true;
    })();
  }, [recordId, draftKey]);

  // 입력 도중 앱이 꺼져도 이어서 쓸 수 있도록 임시 저장
  useEffect(() => {
    if (loaded.current) localStorage.setItem(draftKey, JSON.stringify({ values, photos, date }));
  }, [values, photos, date, draftKey]);

  if (checklist === undefined || existing === undefined) return null;
  if (checklist === null) return <div className="page">점검표를 찾을 수 없습니다.</div>;

  const items = checklist.items;
  const filledOf = (i: CheckItem) => (i.type === 'photo' ? (photos[i.id]?.length ?? 0) > 0 : hasValue(values[i.id]));
  const set = (id: string, v: ItemValue) => {
    setValues((p) => ({ ...p, [id]: v }));
    setMissing((m) => m.filter((x) => x !== id));
  };
  const setItemPhotos = (id: string, ids: string[]) => {
    setPhotos((p) => ({ ...p, [id]: ids }));
    setMissing((m) => m.filter((x) => x !== id));
  };

  const filled = items.filter(filledOf).length;
  const abnormalNow = items.filter((i) => isAbnormal(i, values[i.id]));

  async function save() {
    const miss = items.filter((i) => i.required && !filledOf(i)).map((i) => i.id);
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
    const empty = items.length - filled;
    if (empty > 0 && !confirm(`${empty}개 항목이 비어 있습니다. 이대로 저장할까요?`)) {
      const first = items.find((i) => !filledOf(i));
      if (first) document.getElementById('item-' + first.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    // 시트 점검표는 «탭 + 날짜» 하나에 기록 하나 (= 시트의 날짜 열 하나)
    const finalId = checklist!.sheetTab ? sheetRecordId(checklist!.id, date) : recordId ?? uid();
    if (finalId !== recordId) {
      const clash = await db.records.get(finalId);
      if (clash && !confirm(`${date}에 이미 기록이 있습니다. 덮어쓸까요?`)) return;
    }

    setSaving(true);
    localStorage.setItem(INSPECTOR_KEY, inspector.trim());
    const now = Date.now();
    const cleanPhotos = Object.fromEntries(Object.entries(photos).filter(([, v]) => v.length));
    const rec: InspectionRecord = {
      id: finalId,
      checklistId: checklist!.id,
      checklistName: checklist!.name,
      date,
      time: hhmm(),
      inspector: inspector.trim(),
      values,
      photos: cleanPhotos,
      photoLinks: existing?.date === date ? existing?.photoLinks : undefined,
      abnormal: abnormalNow.map((i) => i.id),
      itemsSnapshot: existing && !checklist!.sheetTab ? mergeSnapshot(existing.itemsSnapshot, items) : items,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      synced: false,
    };
    await db.transaction('rw', db.records, db.photos, async () => {
      if (recordId && recordId !== finalId) await db.records.delete(recordId);
      await db.records.put(rec);
      // 사진을 최종 기록에 연결하고, 지운 사진은 정리
      const keep = new Set(Object.values(cleanPhotos).flat());
      await db.photos.where('recordId').anyOf([tempId, finalId]).modify((p, ref) => {
        if (!keep.has(p.id)) delete (ref as { value?: unknown }).value;
        else p.recordId = finalId;
      });
    });
    localStorage.removeItem(draftKey);
    syncNow();
    go();
  }

  async function cancel() {
    if (filled > 0 && !existing && !confirm('저장하지 않고 나갈까요? 입력한 내용이 사라집니다.')) return;
    localStorage.removeItem(draftKey);
    if (!existing) await db.photos.where('recordId').equals(tempId).delete();
    go();
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
          <input type="date" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
      </div>

      <div className="card rows">
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            value={values[item.id]}
            onChange={(v) => set(item.id, v)}
            photos={photos[item.id] ?? []}
            onPhotos={(ids) => setItemPhotos(item.id, ids)}
            missing={missing.includes(item.id)}
            recordId={tempId}
            stamp={[checklist.name, item.label + (item.unit ? ` (${item.unit})` : '')]}
          />
        ))}
        {items.length === 0 && <div className="empty muted">항목이 없습니다.</div>}
      </div>

      <div className="savebar">
        {abnormalNow.length > 0 && (
          <div className="warn">⚠ 기준 벗어남 {abnormalNow.length}건: {abnormalNow.map((i) => i.label).join(', ')}</div>
        )}
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

interface RowProps {
  item: CheckItem;
  value: ItemValue | undefined;
  onChange: (v: ItemValue) => void;
  photos: string[];
  onPhotos: (ids: string[]) => void;
  missing: boolean;
  recordId: string;
  stamp: string[];
}

/** 시트의 한 행 = 화면의 한 줄:  [유량]  (ml)  [ 150 ]  📷 */
function ItemRow({ item, value, onChange, photos, onPhotos, missing, recordId, stamp }: RowProps) {
  const bad = isAbnormal(item, value);
  const crit = criteriaText(item);
  const showCam = item.photo || item.type === 'photo' || bad || photos.length > 0;
  const wide = item.type === 'memo' || (item.type === 'choice' && ((item.options?.length ?? 0) > 2 || (item.options ?? []).some((o) => o.length > 4)));

  return (
    <div id={'item-' + item.id} className={'ri ' + (bad ? 'is-bad ' : '') + (missing ? 'is-missing ' : '') + (wide ? 'wide' : '')}>
      <div className="ri-main">
        <div className="ri-label">
          {item.label}
          {item.required && <span className="req">*</span>}
          {crit && <div className="ri-crit">{crit}</div>}
        </div>
        {item.type === 'number' && <div className="ri-unit">{item.unit ? `(${item.unit})` : ''}</div>}
        {!wide && item.type !== 'photo' && <ItemInput item={item} value={value} onChange={onChange} />}
        {showCam && <PhotoButton ids={photos} onChange={onPhotos} recordId={recordId} stamp={stamp} highlight={!!item.photo && photos.length === 0} />}
      </div>
      {wide && <ItemInput item={item} value={value} onChange={onChange} />}
      {photos.length > 0 && (
        <div className="photos sm">
          {photos.map((id) => (
            <PhotoThumb key={id} id={id} onRemove={() => onPhotos(photos.filter((x) => x !== id))} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 숫자 칸에서 «다음»을 누르면 다음 칸으로 */
function focusNext(el: HTMLElement) {
  const all = Array.from(document.querySelectorAll<HTMLInputElement>('.inspect .rows input.ri-in'));
  const i = all.indexOf(el as HTMLInputElement);
  if (i >= 0 && all[i + 1]) {
    all[i + 1].focus();
    all[i + 1].scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else (el as HTMLInputElement).blur();
}

function ItemInput({ item, value, onChange }: { item: CheckItem; value: ItemValue | undefined; onChange: (v: ItemValue) => void }) {
  switch (item.type) {
    case 'yesno':
      return (
        <div className="ri-seg">
          {(['yes', 'no'] as const).map((a) => (
            <button key={a} className={value === a ? ((item.okAnswer ?? 'yes') === a ? 'on ok' : 'on bad') : ''} onClick={() => onChange(value === a ? null : a)}>
              {a === 'yes' ? '예' : '아니오'}
            </button>
          ))}
        </div>
      );
    case 'choice': {
      const cur = value === null || value === undefined ? '' : String(value).toLowerCase();
      return (
        <div className="ri-seg">
          {(item.options ?? []).map((o) => {
            const on = cur === o.toLowerCase();
            const isBad = (item.badOptions ?? []).includes(o);
            return (
              <button key={o} className={on ? (isBad ? 'on bad' : 'on ok') : ''} onClick={() => onChange(on ? null : o)}>
                {o}
              </button>
            );
          })}
        </div>
      );
    }
    case 'number':
      return <NumberInput value={value} onChange={onChange} />;
    case 'memo':
      return (
        <input
          className="ri-in ri-memo"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="내용 입력"
          enterKeyHint="next"
          onKeyDown={(e) => e.key === 'Enter' && focusNext(e.currentTarget)}
        />
      );
    default:
      return null;
  }
}

function NumberInput({ value, onChange }: { value: ItemValue | undefined; onChange: (v: ItemValue) => void }) {
  // 입력 중 "12." 같은 상태를 유지하기 위해 문자열로 따로 들고 있음
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  useEffect(() => {
    if (value === null || value === undefined) setText('');
    else if (Number(text) !== Number(value)) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      className="ri-in ri-num"
      inputMode="decimal"
      enterKeyHint="next"
      value={text}
      onKeyDown={(e) => e.key === 'Enter' && focusNext(e.currentTarget)}
      onChange={(e) => {
        const t = e.target.value.replace(/[^0-9.\-]/g, '');
        setText(t);
        const n = parseFloat(t);
        onChange(t === '' || isNaN(n) ? null : n);
      }}
    />
  );
}

function PhotoButton({ ids, onChange, recordId, stamp, highlight }: { ids: string[]; onChange: (ids: string[]) => void; recordId: string; stamp: string[]; highlight: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const added: string[] = [];
      for (const f of Array.from(files)) {
        const blob = await compressImage(f, [stampNow(), ...stamp]);
        const id = uid();
        await db.photos.add({ id, recordId, blob, createdAt: Date.now() });
        added.push(id);
      }
      onChange([...ids, ...added]);
    } catch (e) {
      alert('사진을 저장하지 못했습니다: ' + (e as Error).message);
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = '';
    }
  }
  return (
    <>
      <input ref={ref} type="file" accept="image/*" capture="environment" hidden onChange={(e) => add(e.target.files)} />
      <button className={'ri-cam ' + (highlight ? 'hl' : '')} disabled={busy} aria-label="사진 찍기" onClick={() => ref.current?.click()}>
        {busy ? '…' : '📷'}
        {ids.length > 0 && <span className="cnt">{ids.length}</span>}
      </button>
    </>
  );
}
