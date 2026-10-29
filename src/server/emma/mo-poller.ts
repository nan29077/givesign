/**
 * EMMA MO 폴러.
 *
 * em_mo_log_YYYYMM 에서 신규 수신 건을 읽어 도메인 핸들러로 넘긴다.
 *
 * 상태 전이
 * ---------
 *   '3'(EMMA 가 넣은 신규)
 *      → '2'(우리가 선점, 조건부 UPDATE 라 동시 실행에도 한 프로세스만 성공)
 *      → '9'(처리 완료)  또는  '3'(예외 발생 → 다음 폴링에서 재시도)
 *
 * EMMA 는 MO 행을 INSERT 만 하고 다시 읽지 않으므로 이 갱신이 EMMA 동작에 영향을 주지 않는다.
 * (검증: emma_sp_smo.sql 에는 log_create 와 tran_insert 두 함수뿐이다)
 *
 * 중복 처리에 대하여
 * ------------------
 * 선점 실패 시 건너뛰지만, 이것은 **성능을 위한 1차 방어일 뿐 정확성의 근거가 아니다.**
 * 정확성은 도메인 쪽 `mo_inbound_message (provider_code, provider_message_id)` UNIQUE 제약이
 * 보장한다. 잠금이 만료된 채로 폴링이 겹쳐 같은 행을 두 번 넘기더라도 결제는 한 번만 생성된다.
 */

import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import {
  assertSafeSuffix,
  getEmmaQuerier,
  moTableExists,
  pollingSuffixes,
} from './client';
import { restoreMoNumber, splitMoNumber } from './number';
import {
  EMMA_MO_STATUS,
  type EmmaMoHandler,
  type EmmaMoMessage,
  type EmmaMoRow,
  type EmmaPollResult,
} from './types';

/** 조회 컬럼. 명세서에 있는 필드만 읽는다. */
const MO_COLUMNS = `mo_key, service_type, mo_recipient, emo_recipient, mo_originator,
                    mo_callback, msg_status, subject, content, date_mo, date_mo_recv,
                    carrier, rs_id, ems_id, ems_total, ems_seq, emma_id`;

/**
 * 처리 대상 행을 읽는다.
 *
 * 신규('3') 와, 선점된 채 오래 남은 건('2')을 함께 본다. 후자는 처리 도중 프로세스가 죽어
 * 영영 묻히는 것을 막기 위한 복구 경로다. EMMA 테이블에는 갱신 시각 컬럼이 없으므로
 * **EMMA 가 행을 넣은 시각(date_mo_recv)** 을 기준으로 오래된 것만 되살린다.
 * (정상 처리는 1초 안에 끝나므로 기본 5분이면 진행 중인 건을 건드리지 않는다)
 */
async function fetchCandidates(suffix: string, limit: number, staleSec: number): Promise<EmmaMoRow[]> {
  assertSafeSuffix(suffix);
  const q = getEmmaQuerier();
  return q.query<EmmaMoRow>(
    `SELECT ${MO_COLUMNS}
       FROM em_mo_log_${suffix}
      WHERE msg_status = $1
         OR (msg_status = $2 AND date_mo_recv < NOW() - MAKE_INTERVAL(secs => $3))
      ORDER BY date_mo ASC
      LIMIT ${Number(limit)}`,
    [EMMA_MO_STATUS.NEW, EMMA_MO_STATUS.CLAIMED, staleSec],
  );
}

/**
 * 상태를 '처리 중'으로 원자적으로 선점한다.
 * 다른 프로세스가 먼저 가져갔으면 0행이 갱신되어 false 를 돌려준다.
 */
async function claim(suffix: string, moKey: string, staleSec: number): Promise<boolean> {
  assertSafeSuffix(suffix);
  const q = getEmmaQuerier();
  const affected = await q.execute(
    `UPDATE em_mo_log_${suffix}
        SET msg_status = $1
      WHERE mo_key = $2
        AND (msg_status = $3
             OR (msg_status = $1 AND date_mo_recv < NOW() - MAKE_INTERVAL(secs => $4)))`,
    [EMMA_MO_STATUS.CLAIMED, moKey, EMMA_MO_STATUS.NEW, staleSec],
  );
  return affected > 0;
}

/** 상태를 바꾼다(완료 '9' 또는 재시도를 위한 신규 '3' 복귀). */
async function setStatus(suffix: string, moKey: string, status: string): Promise<void> {
  assertSafeSuffix(suffix);
  const q = getEmmaQuerier();
  await q.execute(`UPDATE em_mo_log_${suffix} SET msg_status = $1 WHERE mo_key = $2`, [status, moKey]);
}

/** EMMA 의 service_type 을 메시지 종류로 옮긴다. '4'=SMS MO, '5'=MMS MO */
function toMessageType(serviceType: string | null): EmmaMoMessage['messageType'] {
  return String(serviceType ?? '').trim() === '5' ? 'MMS' : 'SMS';
}

/** 원본 행 → 정규화 메시지. 번호 복원이 여기서 일어난다. */
export function toMoMessage(row: EmmaMoRow): EmmaMoMessage {
  const receivedNumber = restoreMoNumber(row.mo_recipient, row.emo_recipient);
  const { base, sub } = splitMoNumber(receivedNumber);
  return {
    moKey: row.mo_key,
    receivedNumber,
    baseNumber: base,
    subCode: sub,
    fromNumber: String(row.mo_originator ?? '').trim(),
    content: row.content ?? '',
    messageType: toMessageType(row.service_type),
    receivedAt: row.date_mo ? new Date(row.date_mo) : new Date(),
    raw: row,
  };
}

/**
 * 폴링 1회.
 *
 * @param handler 수신 문자 1건을 처리할 도메인 함수
 */
export async function pollEmmaMo(handler: EmmaMoHandler): Promise<EmmaPollResult> {
  const result: EmmaPollResult = { fetched: 0, handed: 0, skipped: 0, failed: 0, details: [] };

  const limit = env.emma.batchSize;
  const staleSec = env.emma.staleSec;
  const expectedBase = env.emma.baseNumber.replace(/\D/g, '');

  for (const suffix of pollingSuffixes()) {
    if (!(await moTableExists(suffix))) continue;

    let rows: EmmaMoRow[];
    try {
      rows = await fetchCandidates(suffix, limit, staleSec);
    } catch (e) {
      // 한 달치 테이블 조회가 실패해도 나머지 달은 계속 본다.
      logger.error('EMMA MO 조회 실패', { suffix, message: (e as Error).message });
      continue;
    }
    result.fetched += rows.length;

    for (const row of rows) {
      const moKey = row.mo_key;

      let claimed = false;
      try {
        claimed = await claim(suffix, moKey, staleSec);
      } catch (e) {
        result.failed++;
        result.details.push({ moKey, outcome: 'failed', detail: `선점 실패: ${(e as Error).message}` });
        continue;
      }
      if (!claimed) {
        result.skipped++;
        result.details.push({ moKey, outcome: 'skipped', detail: '다른 실행이 이미 선점' });
        continue;
      }

      const message = toMoMessage(row);

      // 대표번호가 설정과 다르면 남의 번호가 섞여 들어온 것이다. 처리하지 않고 남겨 둔다.
      // (한 EMMA 에 여러 서비스의 번호가 물린 구성에서 서로의 결제를 가로채는 사고를 막는다)
      if (expectedBase && message.baseNumber !== expectedBase) {
        await setStatus(suffix, moKey, EMMA_MO_STATUS.NEW).catch(() => undefined);
        result.skipped++;
        result.details.push({
          moKey,
          outcome: 'skipped',
          detail: `대표번호 불일치 (수신 ${message.baseNumber || '없음'} / 설정 ${expectedBase})`,
        });
        logger.warn('EMMA MO 대표번호 불일치 — 처리하지 않음', {
          moKey,
          received: message.baseNumber,
          expected: expectedBase,
        });
        continue;
      }

      try {
        const detail = await handler(message);
        await setStatus(suffix, moKey, EMMA_MO_STATUS.DONE);
        result.handed++;
        result.details.push({ moKey, outcome: 'handed', detail: detail ?? undefined });
      } catch (e) {
        // 도메인 처리에서 예외가 났다. 신규로 되돌려 다음 폴링에서 다시 시도한다.
        // (되돌리기 자체가 실패하면 '2' 로 남지만, staleSec 이 지나면 복구 대상이 된다)
        await setStatus(suffix, moKey, EMMA_MO_STATUS.NEW).catch(() => undefined);
        result.failed++;
        result.details.push({ moKey, outcome: 'failed', detail: (e as Error).message });
        logger.error('EMMA MO 처리 실패 — 재시도 대상으로 되돌림', {
          moKey,
          message: (e as Error).message,
        });
      }
    }
  }

  return result;
}
