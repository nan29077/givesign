-- 2026-11-09 2차 과제 F: 후원자 셀프서비스 확대
-- 연락 선호(2차 D 와 같은 정의 — 둘 중 누가 먼저 합쳐져도 충돌하지 않게 IF NOT EXISTS)
ALTER TABLE "payer_profile" ADD COLUMN IF NOT EXISTS "preferred_channel" TEXT NOT NULL DEFAULT 'ALIMTALK_FIRST';

-- 정기후원 변경 이력
CREATE TABLE "recurring_change_log" (
    "id" TEXT NOT NULL,
    "recurring_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_change_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "recurring_change_log_recurring_id_created_at_idx" ON "recurring_change_log"("recurring_id", "created_at");
CREATE INDEX "recurring_change_log_merchant_id_created_at_idx" ON "recurring_change_log"("merchant_id", "created_at");

ALTER TABLE "recurring_change_log" ADD CONSTRAINT "recurring_change_log_recurring_id_fkey" FOREIGN KEY ("recurring_id") REFERENCES "recurring_donation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
