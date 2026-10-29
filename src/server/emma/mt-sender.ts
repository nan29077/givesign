/**
 * EMMA MT 발송 큐 적재.
 *
 * EMMA 는 `em_smt_tran` 테이블을 주기적으로(기본 2초) 훑어 발송한다. 우리가 할 일은 이 테이블에
 * 행을 하나 넣는 것뿐이고, 실제 발송·결과 갱신·로그 이관은 EMMA 가 한다.
 *
 * 그래서 이 함수의 성공은 **"발송 성공"이 아니라 "발송 큐 적재 성공"** 이다. 호출부는 이 둘을
 * 구분해야 한다(절대규칙 3: 결제 성공과 후원 반영 성공을 같은 상태로 취급하지 않는다).
 *
 * 컬럼 근거: 인포뱅크 PostgreSQL 명세서 v3.7.1.0 / emma_sp_smt.sql 의 em_smt_tran 정의.
 *
 * emma_id 를 넣지 않는 이유
 * -------------------------
 * EMMA 의 픽업 프로시저(`sp_em_smt_tran_select`)는 이중화 사용 시 `emma_id = ' '`(공백) 인 행만
 * 선점 대상으로 본 뒤 자기 ID 를 찍는다. 우리가 임의의 값을 넣으면 그 값이 EMMA 인스턴스 ID 와
 * 정확히 일치하지 않는 한 **영원히 발송되지 않는다.** 인포뱅크 공식 샘플 INSERT 에도 이 컬럼은
 * 없다. 이중화를 실제로 도입할 때만 EMMA_ID 를 설정하고, 그때도 EMMA 설정값과 반드시 맞춘다.
 */

import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
import { getEmmaQuerier } from './client';
import type { EmmaMtQueued, EmmaMtRequest } from './types';

/** SMS 서비스 구분값. '0'=SMS, '1'=URL */
const SERVICE_TYPE_SMS = '0';
/** 발송 대기 상태. EMMA 가 이 값을 보고 집어간다. */
const MSG_STATUS_READY = '1';

/** EMMA 본문 컬럼 한계(varchar 4000). 넘치면 잘라서 넣는다. */
const CONTENT_MAX = 4000;
/** 번호 컬럼 한계(varchar 25). */
const NUMBER_MAX = 25;

function digits(value: string): string {
  return (value ?? '').replace(/\D/g, '');
}

/**
 * 발송 큐에 한 건 적재한다.
 *
 * @throws 큐 적재에 실패하면 예외를 던진다. 호출부(MT 어댑터)가 ProviderResult 로 감싼다.
 */
export async function queueEmmaMt(req: EmmaMtRequest): Promise<EmmaMtQueued> {
  const to = digits(req.to).slice(0, NUMBER_MAX);
  const callback = digits(req.callback).slice(0, NUMBER_MAX);
  const content = (req.content ?? '').slice(0, CONTENT_MAX);

  if (!to) throw new Error('MT 수신번호가 비어 있습니다.');
  if (!callback) throw new Error('MT 발신번호(callback)가 비어 있습니다.');
  if (!content.trim()) throw new Error('MT 본문이 비어 있습니다.');

  const q = getEmmaQuerier();

  // emma_id 는 넣지 않는다(위 주석 참고). 이중화를 쓰는 구성에서만 설정값을 붙인다.
  const useEmmaId = env.emma.emmaId.trim() !== '';
  const emmaId = useEmmaId ? env.emma.emmaId.trim().slice(0, 2).padEnd(2, ' ') : null;

  const columns = [
    'mt_pr',
    'date_client_req',
    'content',
    'callback',
    'service_type',
    'broadcast_yn',
    'msg_status',
    'recipient_num',
  ];
  const values = [
    `nextval('sq_em_smt_tran_01')`,
    'NOW()',
    '$1',
    '$2',
    '$3',
    `'N'`,
    '$4',
    '$5',
  ];
  const params: unknown[] = [content, callback, SERVICE_TYPE_SMS, MSG_STATUS_READY, to];

  if (emmaId) {
    columns.push('emma_id');
    values.push('$6');
    params.push(emmaId);
  }

  const rows = await q.query<{ mt_pr: string | number | bigint }>(
    `INSERT INTO em_smt_tran (${columns.join(', ')})
     VALUES (${values.join(', ')})
     RETURNING mt_pr`,
    params,
  );

  const mtPr = rows[0]?.mt_pr;
  if (mtPr === undefined || mtPr === null) {
    throw new Error('MT 큐 적재 후 mt_pr 을 받지 못했습니다.');
  }

  const providerMessageId = `SMT-${String(mtPr)}`;
  logger.info('EMMA MT 큐 적재', { providerMessageId, bytes: Buffer.byteLength(content, 'utf8') });
  return { providerMessageId };
}
