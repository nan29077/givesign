/**
 * EMMA 연동 코어.
 *
 * 이 디렉터리는 기브싸인 도메인(사회복지기관·결제·정산)에 의존하지 않는다.
 * 도메인 연결은 아래 한 파일이 담당하고, 여기 있는 모듈은 그대로 둔다.
 *
 *   기브싸인 → src/server/services/emma-mo-ingest.ts (charge-flow 의 handleMoInbound 로 연결)
 *
 * MO(수신)은 폴링(`pollEmmaMo`), MT(발신)은 큐 적재(`queueEmmaMt`)로 붙는다.
 * EMMA 는 HTTP 웹훅을 쓰지 않으므로 `/api/webhooks/mo` 경로와는 완전히 별개의 입구다.
 */

export type {
  EmmaMoRow,
  EmmaMoMessage,
  EmmaMoHandler,
  EmmaMtRequest,
  EmmaMtQueued,
  EmmaPollResult,
} from './types';
export { EMMA_MO_STATUS } from './types';

export {
  digitsOnly,
  restoreMoNumber,
  splitMoNumber,
  composeMoNumber,
  formatMoNumber,
  isUsableSubCode,
  RESERVED_SUB_CODES,
  SUB_CODE_LENGTH,
} from './number';

export {
  getEmmaQuerier,
  usesDedicatedDb,
  closeEmmaPool,
  moTableSuffix,
  pollingSuffixes,
  moTableExists,
  mtQueueExists,
} from './client';

export { pollEmmaMo, toMoMessage } from './mo-poller';
export { queueEmmaMt } from './mt-sender';
