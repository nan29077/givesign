/**
 * EMMA 테이블 생성 — **로컬 검수 전용**.
 *
 * 실제 운영에서는 EMMA 에이전트가 인포뱅크 프로시저(`sp_em_smo_log_create` 등)로 자기 테이블을
 * 직접 만든다. 우리가 만들 일이 없다. 이 파일은 EMMA 를 설치하지 않은 개발 PC 에서
 * "수신 → 결제 → 후원 반영" 흐름을 그대로 돌려 보기 위한 것이다.
 *
 * DDL 은 인포뱅크가 배포한 emma_sp_smo.sql / emma_sp_smt.sql 의 CREATE TABLE 문을 그대로 옮겼다.
 * 컬럼·타입·기본값이 하나라도 다르면 실제 연동에서 어긋나므로 임의로 고치지 않는다.
 *
 * 안전장치
 *  - isLocal 이 아니면 아무것도 하지 않고 예외를 던진다.
 *  - CREATE TABLE IF NOT EXISTS 라서 이미 EMMA 가 만든 테이블이 있으면 건드리지 않는다.
 */

import { isLocal } from '@/lib/env';
import { assertSafeSuffix, getEmmaQuerier, moTableSuffix } from './client';

function assertLocalOnly() {
  if (!isLocal) {
    throw new Error('EMMA 개발용 테이블 생성은 APP_ENV=local 에서만 사용할 수 있습니다.');
  }
}

/** MO 수신 테이블 (EMMA 가 INSERT 하는 곳). */
export async function ensureDevMoTable(suffix = moTableSuffix()): Promise<void> {
  assertLocalOnly();
  assertSafeSuffix(suffix);
  const q = getEmmaQuerier();
  await q.execute(`
    CREATE TABLE IF NOT EXISTS em_mo_log_${suffix} (
      mo_key        VARCHAR(50)  NOT NULL,
      service_type  CHAR(2)      NOT NULL,
      mo_recipient  VARCHAR(32)  NOT NULL,
      emo_recipient VARCHAR(80),
      mo_originator VARCHAR(32)  NOT NULL,
      mo_callback   VARCHAR(32)  NOT NULL,
      msg_status    CHAR(1)      NOT NULL DEFAULT '3',
      subject       VARCHAR(40),
      content       VARCHAR(4000),
      date_mo       TIMESTAMP    NOT NULL,
      date_mo_recv  TIMESTAMP    NOT NULL DEFAULT now(),
      carrier       NUMERIC(5),
      rs_id         VARCHAR(20),
      ems_id        NUMERIC(3),
      ems_total     NUMERIC(1),
      ems_seq       NUMERIC(1),
      emma_id       CHAR(2)      DEFAULT ' ',
      CONSTRAINT pk_em_mo_log_${suffix} PRIMARY KEY (mo_key)
    )
  `);
}

/** MT 발송 큐 (EMMA 가 픽업하는 곳). */
export async function ensureDevMtTable(): Promise<void> {
  assertLocalOnly();
  const q = getEmmaQuerier();
  await q.execute(`CREATE SEQUENCE IF NOT EXISTS sq_em_smt_tran_01 INCREMENT BY 1 START WITH 1`);
  await q.execute(`
    CREATE TABLE IF NOT EXISTS em_smt_tran (
      mt_pr            NUMERIC(11)   NOT NULL,
      msg_key          VARCHAR(20),
      input_type       CHAR(1)       NOT NULL DEFAULT '0',
      mt_refkey        VARCHAR(20),
      priority         CHAR(2)       NOT NULL DEFAULT 'S',
      date_client_req  TIMESTAMP     NOT NULL,
      content          VARCHAR(4000) NOT NULL,
      callback         VARCHAR(25)   NOT NULL,
      service_type     CHAR(2)       NOT NULL,
      broadcast_yn     CHAR(1)       NOT NULL DEFAULT 'N',
      msg_status       CHAR(1)       NOT NULL DEFAULT '1',
      recipient_num    VARCHAR(25),
      country_code     VARCHAR(8)    NOT NULL DEFAULT '82',
      emma_id          CHAR(2)       DEFAULT ' ',
      reg_date         TIMESTAMP     DEFAULT NOW(),
      CONSTRAINT pk_em_smt_tran PRIMARY KEY (mt_pr)
    )
  `);
}

export async function ensureDevEmmaTables(suffix = moTableSuffix()): Promise<void> {
  await ensureDevMoTable(suffix);
  await ensureDevMtTable();
}

/**
 * 사업자가 수신번호를 어떻게 나눠 보내는지에 대한 세 가지 경우.
 * 계약 전이라 확정할 수 없으므로, 셋 다 같은 결과가 나오는지 눈으로 확인할 수 있게 해 둔다.
 */
export type MoSplitMode = 'BASE_SUB' | 'PREFIX_REST' | 'WHOLE';

export const MO_SPLIT_LABEL: Record<MoSplitMode, string> = {
  BASE_SUB: 'A) 대표번호 8자리 + 서브번호 4자리 (가장 유력)',
  PREFIX_REST: 'B) 앞 4자리 + 나머지 8자리',
  WHOLE: 'C) 전체번호가 한 컬럼에',
};

/** 전체 수신번호를 선택한 방식대로 두 컬럼으로 나눈다. */
export function splitForCarrier(
  fullNumber: string,
  mode: MoSplitMode,
): { moRecipient: string; emoRecipient: string | null } {
  const digits = fullNumber.replace(/\D/g, '');
  switch (mode) {
    case 'PREFIX_REST':
      return { moRecipient: digits.slice(0, 4), emoRecipient: digits.slice(4) };
    case 'WHOLE':
      return { moRecipient: digits, emoRecipient: null };
    case 'BASE_SUB':
    default:
      return { moRecipient: digits.slice(0, -4), emoRecipient: digits.slice(-4) };
  }
}

export interface DevMoInsert {
  fullNumber: string;
  from: string;
  content: string;
  splitMode: MoSplitMode;
  moKey?: string;
}

/** EMMA 가 넣은 것과 같은 모양의 수신 행을 만든다. */
export async function insertDevMo(
  input: DevMoInsert,
): Promise<{ moKey: string; moRecipient: string; emoRecipient: string | null }> {
  assertLocalOnly();
  const suffix = moTableSuffix();
  assertSafeSuffix(suffix);
  await ensureDevMoTable(suffix);

  const { moRecipient, emoRecipient } = splitForCarrier(input.fullNumber, input.splitMode);
  const moKey = input.moKey ?? `SIMEMMA${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const q = getEmmaQuerier();

  await q.execute(
    `INSERT INTO em_mo_log_${suffix}
       (mo_key, service_type, mo_recipient, emo_recipient, mo_originator, mo_callback,
        msg_status, content, date_mo, date_mo_recv, carrier, emma_id)
     VALUES ($1, '4', $2, $3, $4, $4, '3', $5, NOW(), NOW(), 10001, ' ')`,
    [moKey, moRecipient, emoRecipient, input.from, input.content],
  );

  return { moKey, moRecipient, emoRecipient };
}

/**
 * 세 가지 분할 방식이 모두 같은 수신번호로 복원되는지 한 번에 확인한다.
 * 문자를 실제로 넣지 않고 계산만 하므로 결제가 생기지 않는다.
 *
 * 순수 계산이라 Server Action 으로 둘 이유가 없다. `'use server'` 파일에 있으면
 * 인증 없이 호출 가능한 엔드후원금가 하나 더 생기므로 여기(일반 모듈)에 둔다.
 */
export function previewSplitModes(fullNumber: string) {
  const modes: MoSplitMode[] = ['BASE_SUB', 'PREFIX_REST', 'WHOLE'];
  return modes.map((mode) => {
    const { moRecipient, emoRecipient } = splitForCarrier(fullNumber, mode);
    return { mode, moRecipient, emoRecipient };
  });
}
