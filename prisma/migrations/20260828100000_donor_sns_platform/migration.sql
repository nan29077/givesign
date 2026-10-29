-- AlterTable: donor_profile에 sns_platform 컬럼 추가
ALTER TABLE "donor_profile" ADD COLUMN IF NOT EXISTS "sns_platform" TEXT;
