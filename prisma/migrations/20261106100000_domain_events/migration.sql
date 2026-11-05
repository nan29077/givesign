-- 고도화 1단계: 도메인 이벤트(아웃박스) · 소비자별 처리 기록 · 배치 실행 기록 · 캠페인 목표 달성 시각

ALTER TABLE "campaign" ADD COLUMN "goal_reached_at" TIMESTAMPTZ(3);

CREATE TABLE "domain_event" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "payer_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "dedupe_key" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(3),
    "locked_by" TEXT,
    "last_error" TEXT,
    "processed_at" TIMESTAMPTZ(3),
    CONSTRAINT "domain_event_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "domain_event_dedupe_key_key" ON "domain_event"("dedupe_key");
CREATE INDEX "domain_event_status_next_attempt_at_idx" ON "domain_event"("status", "next_attempt_at");
CREATE INDEX "domain_event_merchant_id_type_occurred_at_idx" ON "domain_event"("merchant_id", "type", "occurred_at");
CREATE INDEX "domain_event_payer_id_occurred_at_idx" ON "domain_event"("payer_id", "occurred_at");

CREATE TABLE "domain_event_delivery" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "consumer" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "done_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "domain_event_delivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "domain_event_delivery_event_id_consumer_key" ON "domain_event_delivery"("event_id", "consumer");
ALTER TABLE "domain_event_delivery" ADD CONSTRAINT "domain_event_delivery_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "domain_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "cron_heartbeat" (
    "name" TEXT NOT NULL,
    "last_started_at" TIMESTAMPTZ(3),
    "last_finished_at" TIMESTAMPTZ(3),
    "last_ok" BOOLEAN,
    "last_status" INTEGER,
    "last_error" TEXT,
    "last_duration_ms" INTEGER,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "cron_heartbeat_pkey" PRIMARY KEY ("name")
);

-- 승인 요청 (통합 승인 대기함)
CREATE TABLE "approval_request" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "subject_type" TEXT,
    "subject_id" TEXT,
    "payer_id" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "approval_request_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "approval_request_dedupe_key_key" ON "approval_request"("dedupe_key");
CREATE INDEX "approval_request_merchant_id_status_created_at_idx" ON "approval_request"("merchant_id", "status", "created_at");
