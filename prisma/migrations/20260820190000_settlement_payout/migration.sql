-- 지급대행 정산: 지급 실패 상태 + 주민번호(원천징수용, 파기 대상) + 관리자 메모/지급참조
ALTER TYPE "settlement_request_status" ADD VALUE IF NOT EXISTS 'PAYOUT_FAILED' BEFORE 'REJECTED';

ALTER TABLE "settlement_request" ADD COLUMN "admin_memo" TEXT;
ALTER TABLE "settlement_request" ADD COLUMN "resident_enc" TEXT;
ALTER TABLE "settlement_request" ADD COLUMN "resident_masked" TEXT;
ALTER TABLE "settlement_request" ADD COLUMN "resident_purged_at" TIMESTAMPTZ(3);
ALTER TABLE "settlement_request" ADD COLUMN "withholding_filed_at" TIMESTAMPTZ(3);
ALTER TABLE "settlement_request" ADD COLUMN "payout_ref" TEXT;
ALTER TABLE "settlement_request" ADD COLUMN "payout_fail_reason" TEXT;
