-- 2026-11-06 정밀 점검 A-1: 승인 뒤 배치가 실행하는 승인 요청(QUEUED) 선점·진행 기록
ALTER TABLE "approval_request" ADD COLUMN "locked_at" TIMESTAMPTZ(3);
ALTER TABLE "approval_request" ADD COLUMN "locked_by" TEXT;
ALTER TABLE "approval_request" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "approval_request" ADD COLUMN "result" TEXT;
CREATE INDEX "approval_request_status_updated_at_idx" ON "approval_request"("status", "updated_at");
