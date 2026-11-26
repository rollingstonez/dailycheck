import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { go } from '../App';
import type { CheckItem, Correction, InspectionRecord, ItemValue } from '../types';
import { compressImage, criteriaText, formatValue, hhmm, isAbnormal, stampNow, today, uid } from '../util';
import PhotoThumb from '../components/PhotoThumb';
import { sheetRecordId, syncNow, useSyncState } from '../sheet/sync';
import { correctRecord } from '../correct';

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
  const [confirming, setConfirming] = useState(false);
  const [correcting, setCorrecting] = useState<CheckItem | null>(null);
  const sync = useSyncState();
  // 사진은 찍는 즉시 이 id로 기기에 저장해 둔다
  const tempId = useMemo(() => recordId ?? 'tmp-' + uid(), [recordId]);
  const draftKey = `dc:draft:${checklistId}:${recordId ?? 'new'}`;
  const loaded = useRef(false);

  useEffect(() => {
    loaded.current = false;
    setMissing([]);
    setConfirming(false);
    setCorrecting(null);
    (async () => {
      const rec = recordId ? await db.records.get(recordId) : null;
      setExisting(rec ?? null);
      const draft = localStorage.getItem(draftKey);
      const d = draft ? JSON.parse(draft) : null;
      // 이미 저장된 값은 항상 기록 쪽이 우선 (임시 저장본이 오래되었을 수 있음)
      const recorded = Object.fromEntries(Object.entries(rec?.values ?? {}).filter(([, v]) => hasValue(v as ItemValue)));
      setValues({ ...(d ? d.values ?? {} : rec?.values ?? {}), ...recorded });
      const merged: Photos = { ...(d?.photos ?? {}) };
      for (const [k, ids] of Object.entries(rec?.photos ?? {})) merged[k] = [...new Set([...(ids as string[]), ...(merged[k] ?? [])])];
      setPhotos(merged);
      setDate(rec ? rec.date : d?.date ?? today());
      if (rec?.inspector && !localStorage.getItem(INSPECTOR_KEY)) setInspector(rec.inspector);
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
  const recVals = existing?.values ?? {};
  /** 이미 저장된 값은 잠김 (고치려면 «정정») */
  const isLocked = (i: CheckItem) => i.type !== 'photo' && hasValue(recVals[i.id]);
  const lockedPhotos = new Set(Object.values(existing?.photos ?? {}).flat());
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
  const newItems = items.filter((i) => !isLocked(i) && i.type !== 'photo' && hasValue(values[i.id]));
  const newPhotoCount = Object.values(photos).flat().filter((id) => !lockedPhotos.has(id)).length;

  async function changeDate(d: string) {
    setDate(d);
    if (existing) return;
    // 같은 날짜에 이미 기록이 있으면 그 기록을 연다 (새로 만들어 덮어쓰지 않는다)
    const dup = checklist!.sheetTab
      ? await db.records.get(sheetRecordId(checklist!.id, d))
      : await db.records.where('[checklistId+date]').equals([checklist!.id, d]).first();
    if (dup) {
      alert('이 날짜에는 이미 기록이 있습니다. 그 기록을 엽니다.');
      go('inspect', checklist!.id, dup.id);
    }
  }

  function review() {
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
    if (newItems.length === 0 && newPhotoCount === 0) {
      alert('새로 입력한 내용이 없습니다.');
      return;
    }
    setConfirming(true);
  }

  async function doSave() {
    setSaving(true);
    try {
      if (!existing) {
        const dup = checklist!.sheetTab
          ? await db.records.get(sheetRecordId(checklist!.id, date))
          : await db.records.where('[checklistId+date]').equals([checklist!.id, date]).first();
        if (dup) {
          setConfirming(false);
          alert('이 날짜에는 이미 기록이 있습니다. 그 기록을 열어 보완하세요.');
          go('inspect', checklist!.id, dup.id);
          return;
        }
      }
      const finalId = existing ? existing.id : checklist!.sheetTab ? sheetRecordId(checklist!.id, date) : uid();
      localStorage.setItem(INSPECTOR_KEY, inspector.trim());
      const now = Date.now();
      const cleanPhotos = Object.fromEntries(Object.entries(photos).filter(([, v]) => v.length));
      const rec: InspectionRecord = {
        id: finalId,
        checklistId: checklist!.id,
        checklistName: checklist!.name,
        date: existing?.date ?? date,
        time: existing?.time ?? hhmm(),
        inspector: inspector.trim(),
        values,
        photos: cleanPhotos,
        photoLinks: existing?.photoLinks,
        corrections: existing?.corrections,
        abnormal: abnormalNow.map((i) => i.id),
        itemsSnapshot: existing && !checklist!.sheetTab ? mergeSnapshot(existing.itemsSnapshot, items) : items,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        synced: false,
      };
      await db.transaction('rw', db.records, db.photos, async () => {
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
    } finally {
      setSaving(false);
    }
  }

  async function cancel() {
    if ((newItems.length > 0 || newPhotoCount > 0) && !confirm('저장하지 않고 나갈까요? 입력한 내용이 사라집니다.')) return;
    localStorage.removeItem(draftKey);
    await db.photos.where('recordId').equals(tempId).filter((p) => !lockedPhotos.has(p.id)).delete();
    go();
  }

  async function afterCorrection() {
    setCorrecting(null);
    if (!existing) return;
    const rec = await db.records.get(existing.id);
    if (rec) {
      setExisting(rec);
      setValues((v) => ({ ...v, ...rec.values }));
    }
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

      {existing && (
        <div className="card notice small">
          🔒 저장된 값은 잠겨 있습니다. 고치려면 <b>정정</b>을 누르세요 (사유를 남기고, 원본 값은 기록으로 남습니다). 비어 있는 항목은 이어서 입력할 수 있습니다.
        </div>
      )}

      <div className="card row2">
        <label>
          점검자
          <input id="inspector" value={inspector} onChange={(e) => setInspector(e.target.value)} placeholder="이름" />
        </label>
        <label>
          날짜
          <input type="date" value={date} max={today()} disabled={!!existing} onChange={(e) => e.target.value && changeDate(e.target.value)} />
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
            locked={isLocked(item)}
            lockedPhotos={lockedPhotos}
            onCorrect={() => setCorrecting(item)}
            corrections={(existing?.corrections ?? []).filter((c) => c.itemId === item.id)}
            links={existing?.photoLinks?.[item.id] ?? []}
          />
        ))}
        {items.length === 0 && <div className="empty muted">항목이 없습니다.</div>}
      </div>

      <div className="savebar">
        {abnormalNow.length > 0 && (
          <div className="warn">⚠ 기준 벗어남 {abnormalNow.length}건: {abnormalNow.map((i) => i.label).join(', ')}</div>
        )}
        {missing.length > 0 && <div className="warn">필수 항목 {missing.length}개가 비어 있습니다</div>}
        <button className="btn primary big" disabled={saving} onClick={review}>
          {existing ? '보완 저장' : '저장'}
        </button>
      </div>

      {confirming && (
        <div className="overlay">
          <div className="sheet">
            <h3>저장 전 확인</h3>
            <div className="small muted">
              저장하면 입력한 값은 <b>잠깁니다.</b> 이후 고치려면 사유를 남기는 «정정»을 해야 하고, 원본 값은 기록으로 남습니다. 값이 맞는지 한 번 더 확인하세요.
            </div>
            <ul className="confirm-list">
              {newItems.map((i) => {
                const bad = isAbnormal(i, values[i.id]);
                return (
                  <li key={i.id} className={bad ? 'bad' : ''}>
                    <span>{i.label}</span>
                    <b>{formatValue(i, values[i.id])}{bad && ' ⚠'}</b>
                  </li>
                );
              })}
              {newPhotoCount > 0 && (
                <li>
                  <span>사진</span>
                  <b>{newPhotoCount}장</b>
                </li>
              )}
            </ul>
            {items.length - filled > 0 && <div className="small muted">비어 있는 항목 {items.length - filled}개 — 나중에 이어서 입력할 수 있습니다.</div>}
            <div className="row-btns">
              <button className="btn big" disabled={saving} onClick={() => setConfirming(false)}>돌아가서 확인</button>
              <button className="btn primary big" disabled={saving} onClick={doSave}>{saving ? '저장 중…' : '저장'}</button>
            </div>
          </div>
        </div>
      )}

      {correcting && existing && (
        <CorrectDialog
          item={correcting}
          current={existing.values[correcting.id]}
          needPin={sync.pinRequired && !!checklist.sheetTab}
          inspector={inspector.trim() || existing.inspector}
          recordId={existing.id}
          onClose={() => setCorrecting(null)}
          onDone={afterCorrection}
        />
      )}
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
  locked: boolean;
  lockedPhotos: Set<string>;
  onCorrect: () => void;
  corrections: Correction[];
  links: string[];
}

/** 시트의 한 행 = 화면의 한 줄:  [유량]  (ml)  [ 150 ]  📷   (저장된 값은 🔒 + 정정) */
function ItemRow({ item, value, onChange, photos, onPhotos, missing, recordId, stamp, locked, lockedPhotos, onCorrect, corrections, links }: RowProps) {
  const bad = isAbnormal(item, value);
  const crit = criteriaText(item);
  const showCam = item.photo || item.type === 'photo' || bad || photos.length > 0;
  const wide = item.type === 'memo' || (item.type === 'choice' && ((item.options?.length ?? 0) > 2 || (item.options ?? []).some((o) => o.length > 4)));
  const lockedView = (
    <>
      <div className="ri-locked">
        <span className="v">{formatValue(item, value) || '—'}</span>
        <span aria-hidden>🔒</span>
      </div>
      <button className="ri-fix" onClick={onCorrect}>정정</button>
    </>
  );

  return (
    <div id={'item-' + item.id} className={'ri ' + (bad ? 'is-bad ' : '') + (missing ? 'is-missing ' : '') + (wide ? 'wide' : '')}>
      <div className="ri-main">
        <div className="ri-label">
          {item.label}
          {item.required && <span className="req">*</span>}
          {crit && <div className="ri-crit">{crit}</div>}
        </div>
        {item.type === 'number' && <div className="ri-unit">{item.unit ? `(${item.unit})` : ''}</div>}
        {!wide && item.type !== 'photo' && (locked ? lockedView : <ItemInput item={item} value={value} onChange={onChange} />)}
        {showCam && <PhotoButton ids={photos} onChange={onPhotos} recordId={recordId} stamp={stamp} highlight={!!item.photo && photos.length === 0} />}
      </div>
      {wide && (locked ? <div className="ri-locked-row">{lockedView}</div> : <ItemInput item={item} value={value} onChange={onChange} />)}
      {corrections.map((c, i) => (
        <div key={i} className="ri-corr">
          ✎ 정정 {formatValue(item, c.from) || '—'} → <b>{formatValue(item, c.to)}</b> · 사유: {c.reason} · {c.by} · {c.at}
        </div>
      ))}
      {(photos.length > 0 || links.length > 0) && (
        <div className="photos sm">
          {photos.map((id) => (
            <PhotoThumb key={id} id={id} onRemove={lockedPhotos.has(id) ? undefined : () => onPhotos(photos.filter((x) => x !== id))} />
          ))}
          {photos.length === 0 && links.map((u, k) => (
            <a key={u} className="small" href={u} target="_blank" rel="noreferrer">📷 사진 {k + 1}</a>
          ))}
        </div>
      )}
    </div>
  );
}

/** 정정 창: 새 값 + 사유(필수) (+ 승인 비밀번호). 원본은 지워지지 않는다. */
function CorrectDialog({ item, current, needPin, inspector, recordId, onClose, onDone }: {
  item: CheckItem;
  current: ItemValue | undefined;
  needPin: boolean;
  inspector: string;
  recordId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState<ItemValue>(current ?? null);
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setBusy(true);
    setErr('');
    try {
      await correctRecord({ recordId, itemId: item.id, value, reason, pin, inspector });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay">
      <div className="sheet">
        <h3>정정: {item.label}{item.unit ? ` (${item.unit})` : ''}</h3>
        <div className="small muted">
          지금 기록된 값 <b>{formatValue(item, current)}</b> · 원본은 지워지지 않고, 정정 내역(사유·시각)과 함께 남습니다.
        </div>
        <div className="correct-input">
          <ItemInput item={item} value={value} onChange={setValue} />
        </div>
        <label>
          정정 사유 (필수)
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 숫자를 잘못 눌렀음 (165 → 16.5)" />
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
          <button className="btn primary big" disabled={busy || !reason.trim() || (needPin && !pin)} onClick={submit}>{busy ? '정정 중…' : '정정 저장'}</button>
        </div>
      </div>
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
