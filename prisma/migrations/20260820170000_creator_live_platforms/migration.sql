-- 후원샵 라이브 플랫폼별 주소와 현재 노출할 플랫폼
ALTER TABLE "creator_profile"
  ADD COLUMN "youtube_live_url" TEXT,
  ADD COLUMN "instagram_live_url" TEXT,
  ADD COLUMN "tiktok_live_url" TEXT,
  ADD COLUMN "live_platform" TEXT;

-- 기존 유튜브 라이브 주소를 새 구조로 안전하게 이관한다.
UPDATE "creator_profile"
SET "youtube_live_url" = "live_url",
    "live_platform" = CASE WHEN "live_url" IS NOT NULL THEN 'YOUTUBE' ELSE NULL END
WHERE "live_url" IS NOT NULL;
