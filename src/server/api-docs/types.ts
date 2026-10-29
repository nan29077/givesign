/**
 * 사회복지기관 API 문서 레지스트리 타입.
 *
 * 문서를 손으로 쓰면 반드시 코드와 어긋난다. 그래서 엔드포인트 메타를 여기 한 벌만 두고
 * 화면·OpenAPI·누락 검사 테스트가 모두 이 값을 읽는다.
 *
 * 규칙
 *  - 새 `/api/partner/*` 라우트를 만들면 반드시 레지스트리에 등록한다.
 *    등록하지 않으면 `tests/api-docs.test.ts` 가 실패한다.
 *  - 아직 만들지 않은 API 도 `PLANNED` 로 미리 올린다(사용자 결정 2026-09-05).
 *    단 화면에 "이 문서만 보고 개발에 착수하지 마세요" 고지가 함께 나간다.
 */

/** 엔드포인트 제공 상태. */
export type ApiStatus =
  /** 지금 호출하면 동작한다. 규격 확정. */
  | 'LIVE'
  /** 동작하지만 규격이 바뀔 수 있다. 사전 신청 후 사용. */
  | 'BETA'
  /** 아직 동작하지 않는다. 규격은 예고이며 바뀔 수 있다. */
  | 'PLANNED';

/** 파라미터가 실리는 위치. */
export type ApiParamIn = 'path' | 'query' | 'body' | 'header';

export interface ApiParam {
  name: string;
  in: ApiParamIn;
  type: string;
  required?: boolean;
  description: string;
  example?: string;
}

export interface ApiEndpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** `/api/partner/v1` 이후 경로. 앞에 슬래시를 붙인다. */
  path: string;
  summary: string;
  status: ApiStatus;
  /**
   * HMAC 서명 헤더가 필요한지.
   * 쓰기 요청은 모두 필요하다. 문서에서 가장 많이 막히는 지점이라 표에 따로 세운다.
   */
  signed?: boolean;
  /** 테스트(샌드박스) 키로만 호출할 수 있는 엔드포인트. */
  sandboxOnly?: boolean;
  description?: string;
  params?: ApiParam[];
  /** 주의사항. 규격만으로는 알 수 없는 운영 규칙을 적는다. */
  notes?: string[];
  /** 응답 예시(JSON 문자열). 원문 그대로 보여 준다. */
  responseExample?: string;
}

/** 서술형 설명 블록. 표로 못 담는 "왜 이렇게 하는가" 를 담는다. */
export interface ApiDocSection {
  heading: string;
  /** 문단 단위. 각 항목이 한 문단이 된다. */
  body: string[];
  /** 코드 예시. 렌더링하지 않고 원문 그대로 보여 준다. */
  code?: { label: string; text: string };
}

export interface ApiCategory {
  /** URL 조각. `/studio/docs/{slug}` */
  slug: string;
  /** 목차 번호(정렬용). */
  order: number;
  title: string;
  /** 목차에 한 줄로 보이는 요약. */
  summary: string;
  /** 카테고리 전체 상태. 엔드포인트 상태에서 자동 계산하지 않고 명시한다. */
  status: ApiStatus;
  /** 본문 도입부. 문단 단위. */
  intro: string[];
  sections?: ApiDocSection[];
  endpoints?: ApiEndpoint[];
}

export const API_STATUS_LABEL: Record<ApiStatus, { text: string; tone: 'success' | 'warning' | 'neutral' }> = {
  LIVE: { text: '제공 중', tone: 'success' },
  BETA: { text: '베타', tone: 'warning' },
  PLANNED: { text: '준비 중', tone: 'neutral' },
};

/** 준비 중 문서 상단에 고정으로 붙는 고지. 미리 공개하기로 한 이상 이 문구가 신뢰를 지킨다. */
export const PLANNED_NOTICE =
  '이 항목은 아직 제공되지 않습니다. 아래 규격은 예고이며 출시 시점에 변경될 수 있습니다. 이 문서만 보고 개발에 착수하지 마세요.';
