-- ---------------------------------------------------------------------------
-- 2026-08-21 전체 검수 반영
--  1) 원천징수 소득세/지방소득세 분리 컬럼
--  2) 지급대행 이체파일 발급 이력(이중이체 추적)
--  3) 결제 결과 미확인(PAYMENT_UNKNOWN) 위험 유형
--  4) MO 번호 모드 혼재 방지 부분 유니크 인덱스
-- Amazon RDS / Aurora PostgreSQL 에서 그대로 적용 가능한 표준 SQL 만 사용한다.
-- ---------------------------------------------------------------------------

-- 1) 원천징수 분리 기록.
--    지급명세서는 소득세와 지방소득세를 각각 적어야 해서 합계만으로는 신고할 수 없다.
ALTER TABLE "settlement_request"
  ADD COLUMN IF NOT EXISTS "income_tax" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "local_tax"  BIGINT NOT NULL DEFAULT 0;

-- 기존 행 보정: 합계만 있던 건을 소득세/지방소득세로 역산해 채운다(10:1 비율).
UPDATE "settlement_request"
   SET "income_tax" = ("withholding" * 10) / 11,
       "local_tax"  = "withholding" - (("withholding" * 10) / 11)
 WHERE "withholding" > 0 AND "income_tax" = 0 AND "local_tax" = 0;

-- 2) 지급대행 이체파일 발급 이력.
--    같은 승인 건으로 파일을 두 번 받아 두 번 업로드하면 이중이체가 된다.
ALTER TABLE "settlement_request"
  ADD COLUMN IF NOT EXISTS "payout_batch_no"  TEXT,
  ADD COLUMN IF NOT EXISTS "payout_issued_at" TIMESTAMPTZ(3);

-- 3) 결제 결과 미확인 위험 유형.
--    승인 여부를 확인하지 못한 건을 FAILED 로 덮지 않고 이 유형으로 관리자 큐에 올린다.
ALTER TYPE "risk_type" ADD VALUE IF NOT EXISTS 'PAYMENT_UNKNOWN';

-- 4) MO 번호 라우팅 충돌 방지.
--    PostgreSQL 은 NULL 을 서로 다른 값으로 취급하므로 (phone_number, keyword) 유니크로는
--    전용번호(keyword IS NULL)의 중복 등록을 막지 못한다. banned_word 와 동일하게
--    부분 유니크 인덱스로 막는다. 전용번호는 번호당 하나만 존재해야 하고,
--    전용/대표번호공유가 같은 번호에 섞이면 전용으로 라우팅이 쏠려
--    대표번호를 쓰던 사회복지기관들의 후원이 통째로 엉뚱한 사람에게 들어간다.
CREATE UNIQUE INDEX IF NOT EXISTS "creator_mo_number_dedicated_uniq"
  ON "creator_mo_number" ("phone_number") WHERE "keyword" IS NULL;

-- 5) 스키마 드리프트 해소.
--    guards_and_indexes 에서 raw SQL 로 만든 인덱스 3개가 schema.prisma 에 선언돼 있지 않아,
--    다음 migrate 때 이들을 DROP 하는 마이그레이션이 자동 생성되는 상태였다.
--    schema.prisma 에 @@index 선언을 추가하고, 인덱스 이름도 Prisma 규약에 맞춰 통일한다.
ALTER INDEX IF EXISTS "donation_creator_status_idx" RENAME TO "donation_creator_id_status_idx";
ALTER INDEX IF EXISTS "mt_outbound_creator_idx" RENAME TO "mt_outbound_message_creator_id_created_at_idx";

-- 신규 구축 환경 대비 보강 (이미 있으면 무시된다)
CREATE INDEX IF NOT EXISTS "donation_creator_id_status_idx" ON "donation" ("creator_id", "status");
CREATE INDEX IF NOT EXISTS "donation_paid_at_idx" ON "donation" ("paid_at");
CREATE INDEX IF NOT EXISTS "mt_outbound_message_creator_id_created_at_idx" ON "mt_outbound_message" ("creator_id", "created_at");
