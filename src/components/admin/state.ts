/**
 * 관리자 서버 액션의 공통 반환 형태.
 * 이 모듈은 서버/클라이언트 양쪽에서 import 되므로 서버 전용 코드를 넣지 않는다.
 */
export interface AdminActionState {
  ok: boolean;
  message?: string;
  /** 액션별 부가 결과 (시뮬레이터 실행 결과 등). 값은 항상 문자열로 직렬화한다. */
  detail?: Record<string, string>;
}

export const initialAdminState: AdminActionState = { ok: false };
