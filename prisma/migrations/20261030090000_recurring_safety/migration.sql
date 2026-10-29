-- 정기후원 안전장치 (2026-10-29 전체 점검 H-1, H-5, M-1, M-2, M-5)
--  * payment_mode += RECURRING : 정기후원 자동 출금을 DIRECT_TRIGGER(서면승인 필요)와 구분
--  * recurring_run_status += PENDING : 결제 결과 미확인 상태. 확정 전 같은 주기 재출금 금지
--  * recurring_donation.cycle_month : 처리 중인 출금 주기(yyyy-MM). 재시도가 다음 달로 넘어가도 원래 주기로 기록
--  * 같은 후원자·같은 기관에 살아 있는 약정은 1건만 (부분 유니크 인덱스)

ALTER TYPE "payment_mode" ADD VALUE 'RECURRING';
ALTER TYPE "recurring_run_status" ADD VALUE 'PENDING';

ALTER TABLE "recurring_donation" ADD COLUMN "cycle_month" TEXT;
UPDATE "recurring_donation" SET "cycle_month" = to_char("next_charge_on", 'YYYY-MM') WHERE "cycle_month" IS NULL;
ALTER TABLE "recurring_donation" ALTER COLUMN "cycle_month" SET NOT NULL;

-- 이미 중복으로 생긴 살아 있는 약정이 있으면 가장 먼저 만든 1건만 남기고 나머지를 해지한다.
UPDATE "recurring_donation" r
SET "status" = 'CANCELED', "canceled_at" = now(), "cancel_reason" = '중복 약정 정리(시스템)'
WHERE r."status" IN ('ACTIVE', 'PAUSED', 'SUSPENDED')
  AND EXISTS (
    SELECT 1 FROM "recurring_donation" o
    WHERE o."payer_id" = r."payer_id" AND o."merchant_id" = r."merchant_id"
      AND o."status" IN ('ACTIVE', 'PAUSED', 'SUSPENDED')
      AND (o."created_at" < r."created_at" OR (o."created_at" = r."created_at" AND o."id" < r."id"))
  );

CREATE UNIQUE INDEX IF NOT EXISTS "recurring_donation_live_uniq"
  ON "recurring_donation" ("payer_id", "merchant_id")
  WHERE "status" IN ('ACTIVE', 'PAUSED', 'SUSPENDED');
