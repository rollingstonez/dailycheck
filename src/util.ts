import type { CheckItem, ItemValue } from './types';

export const uid = () =>
  (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));

const pad = (n: number) => String(n).padStart(2, '0');

/** 현지 시간 기준 YYYY-MM-DD */
export const toDateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => toDateStr(new Date());
export const thisMonth = () => today().slice(0, 7);

export const daysInMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};

const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
export const prettyDate = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  const w = WEEK[new Date(y, m - 1, d).getDay()];
  return `${m}월 ${d}일 (${w})`;
};

/** 입력값이 기준을 벗어났는지 */
export function isAbnormal(item: CheckItem, v: ItemValue | undefined): boolean {
  if (v === null || v === undefined || v === '') return false;
  switch (item.type) {
    case 'yesno':
      return v !== (item.okAnswer ?? 'yes');
    case 'number': {
      if (typeof v === 'string') v = parseFloat(v);
      if (typeof v !== 'number' || isNaN(v)) return false;
      if (item.min !== undefined && v < item.min) return true;
      if (item.max !== undefined && v > item.max) return true;
      return false;
    }
    case 'choice': {
      const sv = String(v).toLowerCase();
      return (item.badOptions ?? []).some((b) => b.toLowerCase() === sv);
    }
    default:
      return false;
  }
}

export function isEmpty(item: CheckItem, v: ItemValue | undefined) {
  if (v === null || v === undefined || v === '') return true;
  if (item.type === 'photo') return !Array.isArray(v) || v.length === 0;
  return false;
}

export function criteriaText(item: CheckItem): string {
  if (item.type === 'yesno') return `정상: ${(item.okAnswer ?? 'yes') === 'yes' ? '예' : '아니오'}`;
  if (item.type === 'number') {
    const u = item.unit ?? '';
    if (item.min !== undefined && item.max !== undefined) return `기준 ${item.min}~${item.max}${u}`;
    if (item.min !== undefined) return `기준 ${item.min}${u} 이상`;
    if (item.max !== undefined) return `기준 ${item.max}${u} 이하`;
  }
  if (item.type === 'choice' && item.badOptions?.length) {
    const ok = (item.options ?? []).filter((o) => !item.badOptions!.includes(o));
    return ok.length ? `정상: ${ok.join('/')}` : '';
  }
  return '';
}

export function formatValue(item: CheckItem, v: ItemValue | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  if (item.type === 'yesno') return v === 'yes' ? '예' : '아니오';
  if (item.type === 'number') return `${v}${item.unit ?? ''}`;
  if (item.type === 'photo') return Array.isArray(v) ? `사진 ${v.length}장` : '';
  return String(v);
}

/** 사진을 긴 변 1280px JPEG로 줄이고, 아래쪽에 날짜·시간 워터마크를 찍는다 */
export async function compressImage(file: File, stampLines: string[] = [], maxSide = 1280): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  if (stampLines.length) {
    const fs = Math.max(16, Math.round(Math.min(canvas.width, canvas.height) / 26));
    ctx.font = `bold ${fs}px -apple-system, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
    ctx.textBaseline = 'bottom';
    const pad = Math.round(fs * 0.5);
    const lh = Math.round(fs * 1.3);
    const w = Math.max(...stampLines.map((l) => ctx.measureText(l).width)) + pad * 2;
    const h = lh * stampLines.length + pad * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, canvas.height - h, Math.min(w, canvas.width), h);
    ctx.fillStyle = '#fff';
    stampLines.forEach((l, i) => ctx.fillText(l, pad, canvas.height - h + pad + lh * (i + 1)));
  }
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('사진 변환 실패'))), 'image/jpeg', 0.8),
  );
}

/** 2026-11-25 14:32:05 (워터마크용) */
export const stampNow = () => {
  const d = new Date();
  return `${toDateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
export const hhmm = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** CSV 파일 내려받기 (엑셀·구글 시트에서 한글이 깨지지 않도록 BOM 포함) */
export function downloadCsv(filename: string, rows: (string | number)[][]) {
  const esc = (c: string | number) => {
    const s = String(c ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const fmtNum = (n: number) =>
  Number.isInteger(n) ? n.toLocaleString('ko-KR') : n.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
