-- 1인(후원자) 1일 최대 후원 건수 정책 필드 추가
ALTER TABLE "donation_limit_policy" ADD COLUMN "donor_daily_max_count" INTEGER NOT NULL DEFAULT 30;
