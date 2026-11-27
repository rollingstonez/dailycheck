import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { CheckItem, InspectionRecord } from '../types';
import { criteriaText, fmtNum, formatValue, toDateStr, today } from '../util';
import { exportRecordsCsv } from './Records';
import { byOrder } from './Home';
import { getConfig, makeSheetReport } from '../sheet/sync';

type Mode = 'week' | 'month';
const WEEK = ['월', '화', '수', '목', '금', '토', '일'];

/** 기간: 시작·끝 날짜(YYYY-MM-DD)와 그 사이 날짜 목록 */
function rangeOf(mode: Mode, anchor: string) {
  const [y, m, d] = anchor.split('-').map(Number);
  let start: Date, end: Date;
  if (mode === 'month') {
    start = new Date(y, m - 1, 1);
    end = new Date(y, m, 0);
  } else {
    const a = new Date(y, m - 1, d);
    const dow = (a.getDay() + 6) % 7; // 월요일 = 0
    start = new Date(y, m - 1, d - dow);
    end = new Date(y, m - 1, d - dow + 6);
  }
  const days: string[] = [];
  for (const t = new Date(start); t <= end; t.setDate(t.getDate() + 1)) days.push(toDateStr(t));
  return { from: days[0], to: days[days.length - 1], days, start };
}

function shift(mode: Mode, anchor: string, dir: -1 | 1) {
  const [y, m, d] = anchor.split('-').map(Number);
  return toDateStr(mode === 'month' ? new Date(y, m - 1 + dir, 1) : new Date(y, m - 1, d + 7 * dir));
}

export default function Report() {
  const [mode, setMode] = useState<Mode>('month');
  const [anchor, setAnchor] = useState(today());
  const [listId, setListId] = useState('');
  const lists = useLiveQuery(() => db.checklists.toArray().then((l) => l.sort(byOrder)), []);
  useEffect(() => {
    if ((!listId || !lists?.some((l) => l.id === listId)) && lists?.length) setListId(lists[0].id);
  }, [lists, listId]);

  const r = rangeOf(mode, anchor);
  const recs = useLiveQuery(
    () => (listId ? db.records.where('[checklistId+date]').between([listId, r.from], [listId, r.to], true, true).sortBy('date') : []),
    [listId, r.from, r.to],
  );
  const checklist = lists?.find((c) => c.id === listId);
  const [y, m] = anchor.split('-').map(Number);
  const title =
    mode === 'month'
      ? `${y}년 ${m}월`
      : `${Number(r.from.slice(5, 7))}/${Number(r.from.slice(8))} ~ ${Number(r.to.slice(5, 7))}/${Number(r.to.slice(8))} 주간`;

  return (
    <div className="page report">
      <header className="top no-print">
        <h1>보고서</h1>
      </header>
      <div className="card no-print">
        <div className="seg-tabs">
          <button className={mode === 'week' ? 'on' : ''} onClick={() => setMode('week')}>주간</button>
          <button className={mode === 'month' ? 'on' : ''} onClick={() => setMode('month')}>월간</button>
        </div>
        <div className="period">
          <button className="btn" aria-label="이전" onClick={() => setAnchor(shift(mode, anchor, -1))}>‹</button>
          {mode === 'month' ? (
            <input type="month" value={anchor.slice(0, 7)} onChange={(e) => e.target.value && setAnchor(e.target.value + '-01')} />
          ) : (
            <input type="date" value={anchor} onChange={(e) => e.target.value && setAnchor(e.target.value)} />
          )}
          <button className="btn" aria-label="다음" onClick={() => setAnchor(shift(mode, anchor, 1))}>›</button>
        </div>
        <label>
          점검표
          <select value={listId} onChange={(e) => setListId(e.target.value)}>
            {lists?.map((c) => (
              <option key={c.id} value={c.id}>{c.sheetTab ? '📄 ' : ''}{c.name}</option>
            ))}
          </select>
        </label>
      </div>

      {mode === 'month' && checklist?.sheetTab && getConfig() && <SheetReport tab={checklist.sheetTab} month={anchor.slice(0, 7)} />}

      {checklist && recs && (
        <ReportBody mode={mode} title={title} name={checklist.name} currentItems={checklist.items} recs={recs} days={r.days} start={r.start} />
      )}
    </div>
  );
}

interface BodyProps {
  mode: Mode;
  title: string;
  name: string;
  currentItems: CheckItem[];
  recs: InspectionRecord[];
  days: string[];
  start: Date;
}

function ReportBody({ mode, title, name, currentItems, recs, days, start }: BodyProps) {
  const t = today();
  const elapsedDays = days.filter((d) => d <= t);
  const elapsed = elapsedDays.length;

  // 점검표 현재 항목 + 기록 당시에만 있던 항목
  const items: CheckItem[] = [...currentItems];
  const ids = new Set(items.map((i) => i.id));
  for (const r of recs) for (const i of r.itemsSnapshot) if (!ids.has(i.id)) { ids.add(i.id); items.push(i); }

  const checkedDays = new Set(recs.map((r) => r.date));
  const abnormalEvents = recs
    .flatMap((r) => r.abnormal.map((id) => ({ rec: r, item: items.find((i) => i.id === id) ?? r.itemsSnapshot.find((i) => i.id === id)! })))
    .filter((e) => e.item);
  const abnormalByItem = new Map<string, number>();
  for (const e of abnormalEvents) abnormalByItem.set(e.item.id, (abnormalByItem.get(e.item.id) ?? 0) + 1);
  const topBad = [...abnormalByItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const inspectors = [...new Set(recs.map((r) => r.inspector).filter(Boolean))];

  const summary: string[] = [];
  if (recs.length === 0) summary.push('이 기간에는 점검 기록이 없습니다.');
  else {
    summary.push(`${elapsed}일 중 ${checkedDays.size}일 점검했습니다 (점검률 ${elapsed ? Math.round((checkedDays.size / elapsed) * 100) : 0}%).`);
    summary.push(
      abnormalEvents.length
        ? `기준을 벗어난 경우가 ${abnormalEvents.length}건 있었습니다. 가장 잦은 항목: ${topBad.map(([id, n]) => `${items.find((i) => i.id === id)?.label} ${n}회`).join(', ')}.`
        : '기준을 벗어난 항목은 없었습니다.',
    );
    for (const it of items.filter((i) => i.type === 'number')) {
      const nums = numsOf(recs, it);
      if (nums.length >= 4) {
        const half = Math.floor(nums.length / 2);
        const a = avg(nums.slice(0, half));
        const b = avg(nums.slice(half));
        const ch = a !== 0 ? ((b - a) / Math.abs(a)) * 100 : 0;
        if (Math.abs(ch) >= 10)
          summary.push(`${it.label}: 기간 후반 평균이 전반보다 ${Math.abs(Math.round(ch))}% ${ch > 0 ? '높습니다' : '낮습니다'}.`);
      }
    }
  }

  const lead = mode === 'month' ? (start.getDay() + 6) % 7 : 0;

  return (
    <div className="report-body">
      <div className="card">
        <div className="muted small">{mode === 'month' ? '월간' : '주간'} 점검 보고서</div>
        <h2>{title} · {name}</h2>
        <div className="stats">
          <Stat label="점검 일수" value={`${checkedDays.size} / ${elapsed}일`} />
          <Stat label="점검 횟수" value={`${recs.length}회`} />
          <Stat label="이상 건수" value={`${abnormalEvents.length}건`} bad={abnormalEvents.length > 0} />
        </div>
        <ul className="summary">{summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
        {inspectors.length > 0 && <div className="muted small">점검자: {inspectors.join(', ')}</div>}
      </div>

      <div className="card">
        <h3>날짜별 점검 현황</h3>
        <div className={'cal ' + (mode === 'week' ? 'week' : '')}>
          {WEEK.map((w) => <div key={w} className="wd">{w}</div>)}
          {Array.from({ length: lead }, (_, i) => <div key={'b' + i} />)}
          {days.map((ds) => {
            const dayRecs = recs.filter((r) => r.date === ds);
            const cls = dayRecs.length ? (dayRecs.some((r) => r.abnormal.length) ? 'bad' : 'ok') : ds <= t ? 'miss' : 'future';
            return <div key={ds} className={'d ' + cls} title={ds}>{mode === 'week' ? `${Number(ds.slice(5, 7))}/${Number(ds.slice(8))}` : Number(ds.slice(8))}</div>;
          })}
        </div>
        <div className="legend small muted">
          <span><i className="ok" />정상</span><span><i className="bad" />이상 있음</span><span><i className="miss" />미점검</span>
        </div>
      </div>

      {recs.length > 0 && (
        <div className="card">
          <h3>항목별 정리</h3>
          {items.map((it) => <ItemSummary key={it.id} item={it} recs={recs} days={days} bad={abnormalByItem.get(it.id) ?? 0} />)}
        </div>
      )}

      {abnormalEvents.length > 0 && (
        <div className="card">
          <h3>이상 항목 목록</h3>
          <table className="tbl">
            <thead><tr><th>날짜</th><th>항목</th><th>값</th><th>점검자</th></tr></thead>
            <tbody>
              {abnormalEvents.map((e, i) => (
                <tr key={i}>
                  <td>{Number(e.rec.date.slice(5, 7))}/{Number(e.rec.date.slice(8))}</td>
                  <td>{e.item.label}</td>
                  <td className="bad-text">{formatValue(e.item, e.rec.values[e.item.id])}</td>
                  <td>{e.rec.inspector}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row-btns no-print">
        <button className="btn primary" onClick={() => window.print()}>🖨 인쇄 · PDF 저장</button>
        <button className="btn" disabled={!recs.length} onClick={() => exportRecordsCsv(recs, `데일리체크_${title}_${name}.csv`)}>⬇ CSV</button>
      </div>
    </div>
  );
}

/** 구글 시트 안에 «_월간 YYYY-MM 탭» 보고서 탭 + 그래프 만들기 */
function SheetReport({ tab, month }: { tab: string; month: string }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ sheet: string; url: string; warnings: string[] } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setDone(null);
    setErr('');
  }, [tab, month]);
  async function make() {
    setBusy(true);
    setErr('');
    try {
      setDone(await makeSheetReport(tab, month));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card sheet-report no-print">
      <div>
        <b>📊 구글 시트에 월간 보고서 탭 만들기</b>
        <div className="muted small">요약 · 항목별 표 · 이상/사진 목록 · 항목별 그래프가 시트 안에 생깁니다. 그래프는 구글 슬라이드에 붙여 연결할 수 있어요.</div>
      </div>
      <button className="btn primary" disabled={busy} onClick={make}>
        {busy ? '만드는 중…' : done ? '다시 만들기 (최신 기록으로)' : `${Number(month.slice(5))}월 보고서 탭 만들기`}
      </button>
      {done && (
        <div className="small">
          ✅ «{done.sheet}» 탭을 만들었습니다.{' '}
          <a href={done.url} target="_blank" rel="noreferrer">시트에서 열기 ›</a>
          {done.warnings.length > 0 && <div className="bad-text">{done.warnings.join(' · ')}</div>}
        </div>
      )}
      {err && <div className="small bad-text">{err}</div>}
    </div>
  );
}

const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const toNum = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : undefined);
const numsOf = (recs: InspectionRecord[], it: CheckItem) => recs.map((r) => toNum(r.values[it.id])).filter((v): v is number => v !== undefined);

function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className={'stat ' + (bad ? 'bad' : '')}>
      <div className="v">{value}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}

function ItemSummary({ item, recs, days, bad }: { item: CheckItem; recs: InspectionRecord[]; days: string[]; bad: number }) {
  const [open, setOpen] = useState(false);
  const vals = recs.map((r) => r.values[item.id]).filter((v) => v !== undefined && v !== null && v !== '');
  const photoCount = recs.reduce((s, r) => s + (r.photos?.[item.id]?.length || r.photoLinks?.[item.id]?.length || 0), 0);
  let body: React.ReactNode = <span className="muted small">입력 {vals.length}회</span>;

  if (item.type === 'number') {
    const nums = numsOf(recs, item);
    if (nums.length) {
      const u = item.unit ?? '';
      body = (
        <>
          <div className="nums small">
            <span>합계 <b>{fmtNum(nums.reduce((s, x) => s + x, 0))}{u}</b></span>
            <span>평균 <b>{fmtNum(avg(nums))}{u}</b></span>
            <span>최소 <b>{fmtNum(Math.min(...nums))}{u}</b></span>
            <span>최대 <b>{fmtNum(Math.max(...nums))}{u}</b></span>
          </div>
          <Spark item={item} recs={recs} days={days} />
        </>
      );
    }
  } else if (item.type === 'yesno' || item.type === 'choice') {
    const counts = new Map<string, number>();
    for (const v of vals) {
      const k = formatValue(item, v);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    body = (
      <div className="nums small">
        {[...counts.entries()].map(([k, n]) => <span key={k}>{k} <b>{n}회</b></span>)}
        {vals.length > 0 && (item.type === 'yesno' || (item.badOptions?.length ?? 0) > 0) && (
          <span>정상률 <b>{Math.round(((vals.length - bad) / vals.length) * 100)}%</b></span>
        )}
      </div>
    );
  } else if (item.type === 'memo') {
    const memos = recs.filter((r) => typeof r.values[item.id] === 'string' && (r.values[item.id] as string).trim());
    body = memos.length ? (
      <ul className="memos small">
        {memos.map((r) => <li key={r.id}><b>{Number(r.date.slice(5, 7))}/{Number(r.date.slice(8))}</b> {r.values[item.id] as string}</li>)}
      </ul>
    ) : <span className="muted small">기록 없음</span>;
  }

  return (
    <div className="isum">
      <div className="ihead">
        <b>{item.label}</b>
        {item.unit && <span className="muted"> ({item.unit})</span>}
        {criteriaText(item) && <span className="muted small"> · {criteriaText(item)}</span>}
        {bad > 0 && <span className="badge bad sm">이상 {bad}</span>}
        {photoCount > 0 && <span className="muted small"> · 📷 {photoCount}</span>}
      </div>
      {body}
      {item.type !== 'memo' && vals.length > 0 && (
        <>
          <button className="toggle no-print" onClick={() => setOpen(!open)}>{open ? '날짜별 값 접기 ▲' : '날짜별 값 보기 ▼'}</button>
          {open && (
            <table className="daytbl">
              <tbody>
                {recs.filter((r) => r.values[item.id] !== undefined && r.values[item.id] !== '').map((r) => (
                  <tr key={r.id} className={r.abnormal.includes(item.id) ? 'bad-text' : ''}>
                    <td>{Number(r.date.slice(5, 7))}/{Number(r.date.slice(8))}</td>
                    <td>{r.inspector}</td>
                    <td>{formatValue(item, r.values[item.id])}{r.abnormal.includes(item.id) ? ' ⚠' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

/** 날짜별 추이 (작은 선 그래프, 점선 = 기준) */
function Spark({ item, recs, days }: { item: CheckItem; recs: InspectionRecord[]; days: string[] }) {
  const idx = new Map(days.map((d, i) => [d, i]));
  const pts = recs
    .map((r) => ({ i: idx.get(r.date), v: toNum(r.values[item.id]) }))
    .filter((p): p is { i: number; v: number } => p.i !== undefined && p.v !== undefined);
  if (pts.length < 2) return null;
  const W = 320, H = 70, P = 6;
  const vs = pts.map((p) => p.v).concat(item.min ?? [], item.max ?? []);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (lo === hi) { lo -= 1; hi += 1; }
  const x = (i: number) => P + (i / Math.max(1, days.length - 1)) * (W - 2 * P);
  const yy = (v: number) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const path = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${yy(p.v).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${item.label} 추이`}>
      {item.min !== undefined && <line x1={P} x2={W - P} y1={yy(item.min)} y2={yy(item.min)} className="lim" />}
      {item.max !== undefined && <line x1={P} x2={W - P} y1={yy(item.max)} y2={yy(item.max)} className="lim" />}
      <path d={path} className="line" />
      {pts.map((p, k) => {
        const out = (item.min !== undefined && p.v < item.min) || (item.max !== undefined && p.v > item.max);
        return <circle key={k} cx={x(p.i)} cy={yy(p.v)} r={out ? 3.5 : 2.2} className={out ? 'dot bad' : 'dot'} />;
      })}
    </svg>
  );
}


