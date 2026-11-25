import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { CheckItem, InspectionRecord } from '../types';
import { criteriaText, daysInMonth, fmtNum, formatValue, thisMonth, today } from '../util';
import { exportRecordsCsv } from './Records';

export default function Report() {
  const [month, setMonth] = useState(thisMonth());
  const [listId, setListId] = useState('');
  const lists = useLiveQuery(() => db.checklists.orderBy('name').toArray(), []);
  useEffect(() => {
    if (!listId && lists?.length) setListId(lists[0].id);
  }, [lists, listId]);

  const recs = useLiveQuery(
    () =>
      listId
        ? db.records.where('[checklistId+date]').between([listId, month + '-01'], [listId, month + '-32']).sortBy('date')
        : [],
    [listId, month],
  );
  const checklist = lists?.find((c) => c.id === listId);

  return (
    <div className="page report">
      <header className="top no-print">
        <h1>월간 보고서</h1>
      </header>
      <div className="card row2 no-print">
        <label>
          월
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value || thisMonth())} />
        </label>
        <label>
          점검표
          <select value={listId} onChange={(e) => setListId(e.target.value)}>
            {lists?.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
      </div>

      {checklist && recs && <ReportBody month={month} name={checklist.name} currentItems={checklist.items} recs={recs} />}
    </div>
  );
}

function ReportBody({ month, name, currentItems, recs }: { month: string; name: string; currentItems: CheckItem[]; recs: InspectionRecord[] }) {
  const [y, m] = month.split('-').map(Number);
  const total = daysInMonth(month);
  const t = today();
  const isCurrent = t.startsWith(month);
  const elapsed = isCurrent ? Number(t.slice(8)) : t < month ? 0 : total;

  // 점검표 현재 항목 + 기록 당시에만 있던 항목
  const items: CheckItem[] = [...currentItems];
  const ids = new Set(items.map((i) => i.id));
  for (const r of recs) for (const i of r.itemsSnapshot) if (!ids.has(i.id)) { ids.add(i.id); items.push(i); }

  const checkedDays = new Set(recs.map((r) => r.date));
  const missedDays: number[] = [];
  for (let d = 1; d <= elapsed; d++) {
    const ds = `${month}-${String(d).padStart(2, '0')}`;
    if (!checkedDays.has(ds)) missedDays.push(d);
  }
  const abnormalEvents = recs.flatMap((r) =>
    r.abnormal.map((id) => ({ rec: r, item: items.find((i) => i.id === id) ?? r.itemsSnapshot.find((i) => i.id === id)! })),
  ).filter((e) => e.item);
  const abnormalByItem = new Map<string, number>();
  for (const e of abnormalEvents) abnormalByItem.set(e.item.id, (abnormalByItem.get(e.item.id) ?? 0) + 1);
  const topBad = [...abnormalByItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const inspectors = [...new Set(recs.map((r) => r.inspector))];

  const summary: string[] = [];
  if (recs.length === 0) summary.push('이 달에는 점검 기록이 없습니다.');
  else {
    summary.push(`${elapsed}일 중 ${checkedDays.size}일 점검했습니다 (점검률 ${elapsed ? Math.round((checkedDays.size / elapsed) * 100) : 0}%).`);
    summary.push(
      abnormalEvents.length
        ? `기준을 벗어난 경우가 ${abnormalEvents.length}건 있었습니다. 가장 잦은 항목: ${topBad
            .map(([id, n]) => `${items.find((i) => i.id === id)?.label} ${n}회`)
            .join(', ')}.`
        : '기준을 벗어난 항목은 없었습니다.',
    );
    for (const it of items.filter((i) => i.type === 'number')) {
      const nums = recs.map((r) => r.values[it.id]).filter((v): v is number => typeof v === 'number');
      if (nums.length >= 2) {
        const half = Math.floor(nums.length / 2);
        const a = avg(nums.slice(0, half));
        const b = avg(nums.slice(half));
        const ch = a !== 0 ? ((b - a) / Math.abs(a)) * 100 : 0;
        if (Math.abs(ch) >= 10) summary.push(`${it.label}: 월 후반 평균이 전반보다 ${Math.abs(Math.round(ch))}% ${ch > 0 ? '높습니다' : '낮습니다'}.`);
      }
    }
  }

  return (
    <div className="report-body">
      <div className="card">
        <div className="muted small">월간 점검 보고서</div>
        <h2>{y}년 {m}월 · {name}</h2>
        <div className="stats">
          <Stat label="점검 일수" value={`${checkedDays.size} / ${elapsed}일`} />
          <Stat label="점검 횟수" value={`${recs.length}회`} />
          <Stat label="이상 건수" value={`${abnormalEvents.length}건`} bad={abnormalEvents.length > 0} />
        </div>
        <ul className="summary">
          {summary.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
        {inspectors.length > 0 && <div className="muted small">점검자: {inspectors.join(', ')}</div>}
      </div>

      <div className="card">
        <h3>날짜별 점검 현황</h3>
        <div className="cal">
          {['일', '월', '화', '수', '목', '금', '토'].map((w) => <div key={w} className="wd">{w}</div>)}
          {Array.from({ length: new Date(y, m - 1, 1).getDay() }, (_, i) => <div key={'b' + i} />)}
          {Array.from({ length: total }, (_, i) => {
            const ds = `${month}-${String(i + 1).padStart(2, '0')}`;
            const dayRecs = recs.filter((r) => r.date === ds);
            const cls = dayRecs.length
              ? dayRecs.some((r) => r.abnormal.length) ? 'bad' : 'ok'
              : i + 1 <= elapsed ? 'miss' : 'future';
            return <div key={i} className={'d ' + cls} title={ds}>{i + 1}</div>;
          })}
        </div>
        <div className="legend small muted">
          <span><i className="ok" />정상</span><span><i className="bad" />이상 있음</span><span><i className="miss" />미점검</span>
        </div>
      </div>

      {recs.length > 0 && (
        <div className="card">
          <h3>항목별 정리</h3>
          {items.map((it) => <ItemSummary key={it.id} item={it} recs={recs} month={month} total={total} bad={abnormalByItem.get(it.id) ?? 0} />)}
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
        <button className="btn" disabled={!recs.length} onClick={() => exportRecordsCsv(recs, `데일리체크_${month}_${name}.csv`)}>⬇ CSV</button>
      </div>
    </div>
  );
}

const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

function Stat({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className={'stat ' + (bad ? 'bad' : '')}>
      <div className="v">{value}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}

function ItemSummary({ item, recs, month, total, bad }: { item: CheckItem; recs: InspectionRecord[]; month: string; total: number; bad: number }) {
  const vals = recs.map((r) => r.values[item.id]).filter((v) => v !== undefined && v !== null && v !== '');
  let body: React.ReactNode = <span className="muted">입력 {vals.length}회</span>;

  if (item.type === 'number') {
    const nums = vals.filter((v): v is number => typeof v === 'number');
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
          <Spark item={item} recs={recs} month={month} total={total} />
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
        {vals.length > 0 && <span>정상률 <b>{Math.round(((vals.length - bad) / vals.length) * 100)}%</b></span>}
      </div>
    );
  } else if (item.type === 'memo') {
    const memos = recs.filter((r) => typeof r.values[item.id] === 'string' && (r.values[item.id] as string).trim());
    body = memos.length ? (
      <ul className="memos small">
        {memos.map((r) => <li key={r.id}><b>{Number(r.date.slice(8))}일</b> {r.values[item.id] as string}</li>)}
      </ul>
    ) : <span className="muted small">기록 없음</span>;
  } else if (item.type === 'photo') {
    const n = vals.reduce<number>((s, v) => s + (Array.isArray(v) ? v.length : 0), 0);
    body = <span className="muted small">사진 {n}장</span>;
  }

  return (
    <div className="isum">
      <div className="ihead">
        <b>{item.label}</b>
        {criteriaText(item) && <span className="muted small"> · {criteriaText(item)}</span>}
        {bad > 0 && <span className="badge bad sm">이상 {bad}</span>}
      </div>
      {body}
    </div>
  );
}

/** 날짜별 추이 (작은 선 그래프) */
function Spark({ item, recs, month, total }: { item: CheckItem; recs: InspectionRecord[]; month: string; total: number }) {
  const pts = recs
    .filter((r) => typeof r.values[item.id] === 'number' && r.date.startsWith(month))
    .map((r) => ({ d: Number(r.date.slice(8)), v: r.values[item.id] as number }));
  if (pts.length < 2) return null;
  const W = 320, H = 70, P = 6;
  const vs = pts.map((p) => p.v).concat(item.min ?? [], item.max ?? []);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (lo === hi) { lo -= 1; hi += 1; }
  const x = (d: number) => P + ((d - 1) / Math.max(1, total - 1)) * (W - 2 * P);
  const yy = (v: number) => H - P - ((v - lo) / (hi - lo)) * (H - 2 * P);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.d).toFixed(1)},${yy(p.v).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${item.label} 추이`}>
      {item.min !== undefined && <line x1={P} x2={W - P} y1={yy(item.min)} y2={yy(item.min)} className="lim" />}
      {item.max !== undefined && <line x1={P} x2={W - P} y1={yy(item.max)} y2={yy(item.max)} className="lim" />}
      <path d={path} className="line" />
      {pts.map((p, i) => {
        const out = (item.min !== undefined && p.v < item.min) || (item.max !== undefined && p.v > item.max);
        return <circle key={i} cx={x(p.d)} cy={yy(p.v)} r={out ? 3.5 : 2.2} className={out ? 'dot bad' : 'dot'} />;
      })}
    </svg>
  );
}
