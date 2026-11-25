// 데이터 구조는 나중에 Supabase 표로 그대로 옮길 수 있도록 단순하게 유지한다.

export type ItemType = 'yesno' | 'number' | 'choice' | 'memo' | 'photo';

export const ITEM_TYPE_LABEL: Record<ItemType, string> = {
  yesno: '예 / 아니오',
  number: '숫자 · 기준값',
  choice: '선택지',
  memo: '메모',
  photo: '사진',
};

export interface CheckItem {
  id: string;
  label: string;
  type: ItemType;
  required: boolean;
  /** yesno: 정상으로 보는 답 */
  okAnswer?: 'yes' | 'no';
  /** number: 단위 (예: ℃, bar, L) */
  unit?: string;
  /** number: 기준 하한 — 이보다 작으면 이상 */
  min?: number;
  /** number: 기준 상한 — 이보다 크면 이상 */
  max?: number;
  /** choice: 선택지 목록 */
  options?: string[];
  /** choice: 이상으로 보는 선택지 */
  badOptions?: string[];
}

export interface Checklist {
  id: string;
  name: string;
  description?: string;
  items: CheckItem[];
  createdAt: number;
  updatedAt: number;
}

/** 항목별 입력값. 사진은 photos 표의 id 목록으로 저장 */
export type ItemValue = 'yes' | 'no' | number | string | string[] | null;

export interface InspectionRecord {
  id: string;
  checklistId: string;
  checklistName: string;
  /** YYYY-MM-DD (현지 날짜) */
  date: string;
  inspector: string;
  values: Record<string, ItemValue>;
  /** 기준을 벗어난 항목 id */
  abnormal: string[];
  /** 기록 당시 점검표 항목 (나중에 점검표가 바뀌어도 기록은 그대로 보이도록) */
  itemsSnapshot: CheckItem[];
  createdAt: number;
  updatedAt: number;
  /** 서버 동기화 여부 (서버 연결 전에는 항상 false) */
  synced: boolean;
}

export interface Photo {
  id: string;
  recordId: string;
  blob: Blob;
  createdAt: number;
}
