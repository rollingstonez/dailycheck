// 데이터 구조는 구글 시트 한 칸·한 줄에 그대로 옮겨 쓸 수 있도록 단순하게 유지한다.

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
  /** 사진 버튼 표시 */
  photo?: boolean;
  /** 구글 시트 A열의 원래 글자 (시트에 쓸 때 행을 찾는 열쇠) */
  sheetLabel?: string;
  /** 구글 시트 B열 기준 원문 */
  sheetCriteria?: string;
}

export interface Checklist {
  id: string;
  name: string;
  description?: string;
  items: CheckItem[];
  /** 구글 시트 탭에서 온 점검표면 그 탭 이름 */
  sheetTab?: string;
  createdAt: number;
  updatedAt: number;
}

/** 항목별 입력값. 사진은 photos 표의 id 목록으로 저장 */
export type ItemValue = 'yes' | 'no' | number | string | string[] | null;

/** 정정 내역: 원본값은 지워지지 않고 여기와 시트 장부에 남는다 */
export interface Correction {
  itemId: string;
  from: ItemValue;
  to: ItemValue;
  reason: string;
  by: string;
  /** yyyy-MM-dd HH:mm */
  at: string;
}

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
  /** 점검 시각 HH:mm */
  time?: string;
  /** 항목별 사진 (photos 표의 id) */
  photos?: Record<string, string[]>;
  /** 시트에 올라간 사진 링크 (항목별) */
  photoLinks?: Record<string, string[]>;
  /** 정정 내역 (원본 → 정정값, 사유) */
  corrections?: Correction[];
  /** 구글 시트에 반영 여부 (시트 연결이 없는 점검표는 항상 false) */
  synced: boolean;
  /** 마지막 동기화 실패 사유 */
  syncError?: string;
}

export interface Photo {
  id: string;
  recordId: string;
  blob: Blob;
  createdAt: number;
  /** 시트(드라이브)에 올라간 주소 */
  uploadedUrl?: string;
}
