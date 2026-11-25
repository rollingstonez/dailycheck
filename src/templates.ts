import type { CheckItem } from './types';

type TemplateItem = Omit<CheckItem, 'id'>;

export interface Template {
  name: string;
  description: string;
  items: TemplateItem[];
}

/** 업종별 서식 템플릿 (기획서 2단계 '해자'의 씨앗) */
export const TEMPLATES: Template[] = [
  {
    name: '설비 일일점검',
    description: '공장 설비·유틸리티 일일 점검 예시',
    items: [
      { label: '컴프레서 정상 작동', type: 'yesno', required: true, okAnswer: 'yes' },
      { label: '컴프레서 압력', type: 'number', required: true, unit: 'bar', min: 6, max: 8 },
      { label: '보일러 가스 사용량(계량기)', type: 'number', required: true, unit: '㎥' },
      { label: '윤활유 투입량', type: 'number', required: false, unit: 'L' },
      { label: '이상 소음·진동 있음', type: 'yesno', required: true, okAnswer: 'no' },
      { label: '작업장 정리 상태', type: 'choice', required: true, options: ['양호', '보통', '불량'], badOptions: ['불량'] },
      { label: '소화기 위치·압력 확인', type: 'yesno', required: true, okAnswer: 'yes' },
      { label: '특이사항', type: 'memo', required: false },
      { label: '현장 사진', type: 'photo', required: false },
    ],
  },
  {
    name: 'HACCP 일반위생관리 일지',
    description: '식품공장 작업 전 위생 점검 예시',
    items: [
      { label: '작업장 온도', type: 'number', required: true, unit: '℃', max: 25 },
      { label: '냉장고 온도', type: 'number', required: true, unit: '℃', min: 0, max: 10 },
      { label: '냉동고 온도', type: 'number', required: true, unit: '℃', max: -18 },
      { label: '작업자 위생복·위생모 착용', type: 'yesno', required: true, okAnswer: 'yes' },
      { label: '손 세척·소독 실시', type: 'yesno', required: true, okAnswer: 'yes' },
      { label: '작업자 건강 이상(설사·발열 등) 있음', type: 'yesno', required: true, okAnswer: 'no' },
      { label: '작업장 청소 상태', type: 'choice', required: true, options: ['양호', '보통', '불량'], badOptions: ['불량'] },
      { label: '방충·방서 이상 있음', type: 'yesno', required: true, okAnswer: 'no' },
      { label: '개선 조치 내용', type: 'memo', required: false },
    ],
  },
  {
    name: '빈 점검표',
    description: '처음부터 직접 만들기',
    items: [],
  },
];
