import { redirect } from 'next/navigation';
import type { ChargeStatus } from '@/generated/prisma/enums';

/** 결제가 실제로 승인된(=매출로 잡히는) 결제 상태 */
export const PAID_CHARGE_STATUSES: ChargeStatus[] = [
  'PAYMENT_SUCCESS',
  'BROADCAST_PENDING',
  'BROADCASTED',
  'PARTIAL_DELIVERY_FAILED',
  'SETTLEMENT_PENDING',
  'SETTLED',
];

export const PAGE_SIZE = 25;

export function parsePage(raw?: string): number {
  // 전체가 숫자일 때만 받는다. parseInt 는 '1.5' 를 1 로, '3abc' 를 3 으로 읽어
  // 잘못 만든 링크가 조용히 다른 페이지를 열게 한다.
  const text = (raw ?? '1').trim();
  if (!/^\d+$/.test(text)) return 1;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}

/**
 * 범위를 벗어난 page 파라미터를 마지막 페이지로 보정한다.
 *
 * 목록이 비면 Pager 도 함께 사라진다(빈 상태 분기 안에 있다). 그래서 `?page=999` 로 들어가면
 * "조건에 맞는 결과가 없습니다" 만 남고 돌아갈 링크가 없어, URL 을 직접 고치거나 초기화해야 했다.
 * 실제로는 데이터가 있는데 화면만 비어 보이는 상태를 만들지 않는다.
 *
 * 서버 컴포넌트에서 목록 조회 직후(lastPage 를 구한 뒤)에 호출한다.
 */
export function clampPage(input: {
  basePath: string;
  params: Record<string, string | undefined>;
  page: number;
  lastPage: number;
  total: number;
  /** 한 화면에 목록이 둘 이상일 때 페이지 파라미터 이름을 분리한다(Pager 와 같은 값). */
  pageParam?: string;
}): void {
  const { basePath, params, page, lastPage, total, pageParam = 'page' } = input;
  if (total <= 0 || page <= lastPage) return;

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '' && k !== pageParam) qs.set(k, v);
  }
  qs.set(pageParam, String(lastPage));
  redirect(`${basePath}?${qs.toString()}`);
}

/**
 * 관리자 등급별 실행 가능 여부.
 *
 * 서버 액션은 이미 등급을 검사해 거절하지만, 화면이 등급을 읽지 않으면 위험한 버튼이
 * 모두 활성 상태로 보인다. 눌러 본 뒤에야 "권한이 없습니다" 를 만나는 죽은 버튼이 된다.
 * 판정 기준은 서버 액션과 같아야 한다.
 *
 * 판정은 반드시 **화이트리스트**로 한다. `permission !== 'READ_ONLY'` 같은 블랙리스트는
 * adminPermission 이 undefined 인 계정(adminProfile 행이 없는 경우)이나 새로 추가된 등급을
 * 전부 통과시켜, 화면에서 위험한 버튼이 열린 채로 보인다.
 * (서버 쪽 같은 기준: src/app/actions/admin/shared.ts)
 */
const WRITE_PERMISSIONS: ReadonlySet<string> = new Set(['SUPER_ADMIN', 'OPERATION', 'FINANCE', 'SUPPORT']);
const MONEY_PERMISSIONS: ReadonlySet<string> = new Set(['SUPER_ADMIN', 'OPERATION', 'FINANCE']);
const TEMPLATE_PERMISSIONS: ReadonlySet<string> = new Set(['SUPER_ADMIN', 'OPERATION']);
/** 계좌번호·주민등록번호 원문이 담긴 정산 파일. api/admin/settlements/* 라우트와 같은 기준. */
const SETTLEMENT_FILE_PERMISSIONS: ReadonlySet<string> = new Set(['SUPER_ADMIN', 'FINANCE']);

/** 변경 동작 일반. `run()` 의 requireWriteAdmin() 과 같은 기준. */
export function canWrite(permission?: string | null): boolean {
  return WRITE_PERMISSIONS.has(String(permission));
}

/** 금전·정책 변경. 정산·환불·수수료·한도 액션의 assertMoneyAdmin() 과 같은 기준. */
export function canManageMoney(permission?: string | null): boolean {
  return MONEY_PERMISSIONS.has(String(permission));
}

/** 최고 관리자 전용(약관 등록, 문의 관리 등). */
export function isSuperAdmin(permission?: string | null): boolean {
  return permission === 'SUPER_ADMIN';
}

/** MT 메시지 본문처럼 최고관리자·운영만 다루는 영역. */
export function canManageTemplates(permission?: string | null): boolean {
  return TEMPLATE_PERMISSIONS.has(String(permission));
}

/**
 * 지급대행 이체파일·원천징수 자료 내려받기.
 *
 * 두 라우트(api/admin/settlements/payout·withholding)는 SUPER_ADMIN·FINANCE 만 허용한다.
 * 화면이 canManageMoney 로 열어 두면 OPERATION 관리자에게 링크가 살아 있는 채로 보이고,
 * 눌러야 403 을 만난다.
 */
export function canExportSettlementFiles(permission?: string | null): boolean {
  return SETTLEMENT_FILE_PERMISSIONS.has(String(permission));
}
