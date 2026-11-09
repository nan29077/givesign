-- 2026-11-09 1차 과제 B
--  (1) 문자 후원 단계별 이탈 측정 — funnel_step: (흐름, 단계) 유니크 = 처음 도달만. 개인정보 원문 없음.
--  (2) 콘텐츠 "자동 작성 + 항상 사람 승인 후 게시"(대표 결정) — 자동 승인 설정을 모두 끈다(컬럼은 호환을 위해 남김).
--  (3) 수정 요청 판 연결(content_item.revision_*), 반려·수정 요청 이유(content_feedback), 승인 알림 1회 기록(content_review_alert).

-- AlterTable
ALTER TABLE "content_item" ADD COLUMN     "revision_of" TEXT,
ADD COLUMN     "revision_request" TEXT,
ADD COLUMN     "revision_root_id" TEXT;

-- CreateTable
CREATE TABLE "funnel_step" (
    "id" TEXT NOT NULL,
    "flow_key" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "campaign_id" TEXT,
    "source" TEXT,
    "mo_message_id" TEXT,
    "charge_id" TEXT,
    "reason" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "funnel_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_feedback" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason_code" TEXT,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_review_alert" (
    "dedupe_key" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "item_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_review_alert_pkey" PRIMARY KEY ("dedupe_key")
);

-- CreateIndex
CREATE INDEX "funnel_step_merchant_id_occurred_at_idx" ON "funnel_step"("merchant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "funnel_step_occurred_at_idx" ON "funnel_step"("occurred_at");

-- CreateIndex
CREATE INDEX "funnel_step_charge_id_idx" ON "funnel_step"("charge_id");

-- CreateIndex
CREATE UNIQUE INDEX "funnel_step_flow_key_step_key" ON "funnel_step"("flow_key", "step");

-- CreateIndex
CREATE INDEX "content_feedback_merchant_id_created_at_idx" ON "content_feedback"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "content_feedback_item_id_kind_created_at_idx" ON "content_feedback"("item_id", "kind", "created_at");

-- CreateIndex
CREATE INDEX "content_review_alert_merchant_id_created_at_idx" ON "content_review_alert"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "content_item_revision_root_id_created_at_idx" ON "content_item"("revision_root_id", "created_at");


-- 자동 승인은 더 이상 쓰지 않는다. 켜져 있던 기관도 모두 끈다(앱은 값과 무관하게 무시한다).
UPDATE "merchant_content_setting" SET "auto_approve" = false WHERE "auto_approve" = true;
