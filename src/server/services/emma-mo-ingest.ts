/**
 * EMMA 수신 문자 → 기브싸인 결제 파이프라인 연결.
 *
 * 이 파일이 "포터블한 EMMA 코어(src/server/emma)" 와 "기브싸인 도메인" 사이의 유일한 접점이다.
 *
 * 설계 원칙
 * ---------
 * 1. **기존 처리 흐름을 재사용한다.** 수신 이후의 모든 판단(중복 차단, 라우팅, 후원자 조회,
 *    한도, 금칙어, 금액 선택 링크 발송)은 `handleMoInbound()`(charge-flow.ts)가 이미 하고 있다.
 *    여기서는 EMMA 행을 `MoInbound` 모양으로 옮겨 주기만 한다. 결제 로직을 새로 쓰지 않는 것이
 *    중복 결제를 막는 가장 확실한 방법이다.
 *
 * 2. **멱등성은 기존 4중 방어를 그대로 탄다.** EMMA 의 `mo_key` 를 `providerMessageId` 로 넘기면
 *    `mo_inbound_message (provider_code, provider_message_id)` UNIQUE 가 1차 방어선으로 작동한다.
 *    폴링이 겹쳐 같은 행을 두 번 넘겨도 결제는 한 번만 생성된다.
 *
 * 3. **예외는 삼키지 않는다.** 여기서 예외가 나면 폴러가 해당 행을 신규 상태로 되돌려 다음
 *    폴링에서 재시도한다. 조용히 성공 처리하면 후원자 돈만 빠지고 기록이 없는 상태가 된다.
 */

import { logger } from '@/lib/logger';
import { maskPhone } from '@/lib/crypto';
import type { MoInbound } from '@/server/adapters/mo';
import { handleMoInbound } from '@/server/services/charge-flow';
import { pollEmmaMo, type EmmaMoMessage, type EmmaPollResult } from '@/server/emma';

/** 수신 로그·결제 기록에 남는 사업자 코드. */
export const EMMA_PROVIDER_CODE = 'infobank-emma';

/** EMMA 메시지를 기존 MO 인바운드 규격으로 옮긴다. */
export function toMoInbound(message: EmmaMoMessage): MoInbound {
  return {
    providerMessageId: message.moKey,
    providerCode: EMMA_PROVIDER_CODE,
    // 라우팅은 숫자만 남긴 전체번호로 한다(routeMerchant 가 normalizePhone 으로 같은 형태를 만든다).
    receivedNumber: message.receivedNumber,
    fromNumber: message.fromNumber,
    messageType: message.messageType,
    content: message.content,
    receivedAt: message.receivedAt,
  };
}

/**
 * 수신 문자 1건 처리.
 *
 * @returns 폴링 로그에 남길 요약(도메인 처리 결과 코드)
 * @throws  도메인 처리가 실패하면 그대로 던진다(폴러가 재시도 대상으로 되돌린다).
 */
export async function ingestEmmaMo(message: EmmaMoMessage): Promise<string> {
  // 발신번호가 비면 후원자를 식별할 수 없다. 재시도해도 결과가 같으므로 예외 대신 결과 코드로 끝낸다.
  if (!message.fromNumber) {
    logger.warn('EMMA MO 발신번호 없음 — 처리하지 않음', { moKey: message.moKey });
    return 'NO_ORIGINATOR';
  }

  const result = await handleMoInbound(toMoInbound(message));

  logger.info('EMMA MO 처리', {
    moKey: message.moKey,
    receivedNumber: message.receivedNumber,
    subCode: message.subCode,
    from: maskPhone(message.fromNumber),
    result: result.result,
    chargeId: result.chargeId,
  });

  return result.result;
}

/**
 * EMMA MO 폴링 1회 실행.
 * 크론 엔드후원금(/api/cron/emma-mo)에서 호출한다.
 */
export async function runEmmaMoPolling(): Promise<EmmaPollResult> {
  return pollEmmaMo(ingestEmmaMo);
}
