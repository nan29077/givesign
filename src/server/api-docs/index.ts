/**
 * 사회복지기관 API 문서 레지스트리 공개 진입점.
 *
 * 화면·테스트·(앞으로 만들) OpenAPI 생성기는 이 파일만 import 한다.
 */
export type { ApiCategory, ApiEndpoint, ApiParam, ApiParamIn, ApiStatus, ApiDocSection } from './types';
export { API_STATUS_LABEL, PLANNED_NOTICE } from './types';
export { API_CATEGORIES, findCategory, orderedCategories, allEndpoints, endpointCounts } from './registry';

/** 사회복지기관 API 의 기본 경로. 문서와 라우트가 같은 값을 쓴다. */
export const API_BASE_PATH = '/api/partner/v1';
