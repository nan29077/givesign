-- 2026-11-09 2차 과제 D: 통합 발송 관리(발송 대기열·선호 채널·결과 미확인 수동 재발송)

-- 후원자 안내 채널 선호(알림톡 우선이 기본)
ALTER TABLE "payer_profile" ADD COLUMN "preferred_channel" TEXT NOT NULL DEFAULT 'ALIMTALK';

-- 알림톡 결과 미확인(UNKNOWN) 건의 수동 문자 재발송(1회)
ALTER TABLE "mt_outbound_message" ADD COLUMN "resend_body_enc" TEXT,
ADD COLUMN "manual_resent_at" TIMESTAMPTZ(3),
ADD COLUMN "manual_resend_id" TEXT;

-- 관계·정보형 안내 발송 대기열
CREATE TABLE "outbound_queue" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "send_key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_id" TEXT,
    "precounted" BOOLEAN NOT NULL DEFAULT false,
    "template_code" TEXT NOT NULL,
    "template_enc" TEXT,
    "body_masked" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "due_at" TIMESTAMPTZ(3) NOT NULL,
    "deferrals" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_reason" TEXT,
    "locked_at" TIMESTAMPTZ(3),
    "locked_by" TEXT,
    "bundle_id" TEXT,
    "mt_message_id" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbound_queue_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outbound_queue_send_key_key" ON "outbound_queue"("send_key");
CREATE INDEX "outbound_queue_status_due_at_idx" ON "outbound_queue"("status", "due_at");
CREATE INDEX "outbound_queue_merchant_id_payer_id_status_idx" ON "outbound_queue"("merchant_id", "payer_id", "status");
CREATE INDEX "outbound_queue_merchant_id_created_at_idx" ON "outbound_queue"("merchant_id", "created_at");
CREATE INDEX "outbound_queue_mt_message_id_idx" ON "outbound_queue"("mt_message_id");
