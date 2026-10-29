-- 기부금영수증 통제 (2026-10-29 전체 점검 M-7, M-8, M-10, M-12)
--  * 공익법인 지정은 관리자가 확인해야 유효 (designated_donee_verified_*)
--  * 영수증에 발급 당시 주민번호 암호문을 스냅샷 → 홈택스 명세가 발급본과 어긋나지 않게
--  * 열람 토큰 만료, 무효 처리자 분리(후원자 화면에 담당자 ID 가 나가지 않게)
--  * 감사로그에 행위자(user id·표시·역할) — 기관·후원자 행위가 "시스템"으로 남지 않게

-- AlterTable
ALTER TABLE "admin_audit_log" ADD COLUMN     "actor_label" TEXT,
ADD COLUMN     "actor_role" TEXT,
ADD COLUMN     "actor_user_id" TEXT;

-- AlterTable
ALTER TABLE "donation_receipt" ADD COLUMN     "resident_no_enc" TEXT,
ADD COLUMN     "view_token_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "voided_by" TEXT;

-- AlterTable
ALTER TABLE "merchant_profile" ADD COLUMN     "designated_donee_note" TEXT,
ADD COLUMN     "designated_donee_verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "designated_donee_verified_by" TEXT;

-- CreateIndex
CREATE INDEX "admin_audit_log_actor_user_id_created_at_idx" ON "admin_audit_log"("actor_user_id", "created_at");


-- 기존 영수증: 발급 당시 값을 알 수 없으므로 현재 후원자 정보로 한 번 채운다(이후로는 바뀌지 않는다).
UPDATE "donation_receipt" d
SET "resident_no_enc" = p."resident_no_enc"
FROM "payer_receipt_profile" p
WHERE d."payer_id" = p."payer_id" AND d."resident_no_enc" IS NULL;

-- 기존 열람 토큰은 30일 뒤 만료
UPDATE "donation_receipt" SET "view_token_expires_at" = now() + interval '30 days'
WHERE "view_token_hash" IS NOT NULL AND "view_token_expires_at" IS NULL;

-- 기존 공익법인 체크는 관리자 확인 전 상태로 둔다(자기 신고만으로는 발급할 수 없다).
