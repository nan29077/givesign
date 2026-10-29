-- 전화번호별 최초 MO 가입 안내를 정확히 한 번만 선점하고,
-- 실제 결제 가능 상태를 후원 이력과 분리해 관리한다.
CREATE TYPE "donor_onboarding_status" AS ENUM (
  'UNREGISTERED',
  'LINK_SENT',
  'REGISTERED',
  'SUSPENDED',
  'WITHDRAWN'
);

ALTER TABLE "donor_profile"
  ADD COLUMN "onboarding_status" "donor_onboarding_status" NOT NULL DEFAULT 'UNREGISTERED',
  ADD COLUMN "registration_link_sent_at" TIMESTAMPTZ(3);

-- 기존 가입 완료 후원자는 즉시 결제 가능한 상태로 이관한다.
UPDATE "donor_profile"
SET "onboarding_status" = 'REGISTERED'
WHERE "registered_at" IS NOT NULL
   OR EXISTS (
     SELECT 1
     FROM "payment_method_token" pmt
     WHERE pmt."donor_id" = "donor_profile"."id"
       AND pmt."status" = 'ACTIVE'
   );

-- 기존에 가입 안내 MT가 발송된 미가입 후원자는 재발송하지 않는다.
UPDATE "donor_profile" dp
SET
  "onboarding_status" = 'LINK_SENT',
  "registration_link_sent_at" = sent."sent_at"
FROM (
  SELECT phone_hash, MAX(COALESCE(sent_at, created_at)) AS sent_at
  FROM "mt_outbound_message"
  WHERE template_code = 'REGISTER_GUIDE'
    AND status = 'SENT'
  GROUP BY phone_hash
) sent
WHERE dp."phone_hash" = sent."phone_hash"
  AND dp."onboarding_status" = 'UNREGISTERED';

CREATE INDEX "donor_profile_onboarding_status_idx"
  ON "donor_profile"("onboarding_status");
