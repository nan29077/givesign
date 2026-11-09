-- 2026-11-09 과제 C: 승인 대기함 담당자 배정·기한 + 문서 발송 전 점검 경고

-- 발급 문서: 발송 전 점검 경고
ALTER TABLE "issued_document" ADD COLUMN "preflight_warnings" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- 승인 대기함 배정
CREATE TABLE "inbox_assignment" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "item_key" TEXT NOT NULL,
    "assignee_user_id" TEXT,
    "due_at" TIMESTAMPTZ(3),
    "memo" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "overdue_notified_at" TIMESTAMPTZ(3),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inbox_assignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "inbox_assignment_merchant_id_item_key_key" ON "inbox_assignment"("merchant_id", "item_key");
CREATE INDEX "inbox_assignment_resolved_at_due_at_idx" ON "inbox_assignment"("resolved_at", "due_at");
