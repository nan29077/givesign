-- 2026-11-06 7단계 외부 연동: SNS 토큰 갱신 기록 열, 후원 회원 이메일 인증.

-- AlterTable
ALTER TABLE "donor_member" ADD COLUMN     "email_verified_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "social_channel" ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "refresh_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "token_scope" TEXT;

-- CreateTable
CREATE TABLE "donor_email_token" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "donor_email_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "donor_email_token_token_hash_key" ON "donor_email_token"("token_hash");

-- CreateIndex
CREATE INDEX "donor_email_token_member_id_created_at_idx" ON "donor_email_token"("member_id", "created_at");
