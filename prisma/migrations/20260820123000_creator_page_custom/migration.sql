-- 사회복지기관 후원 페이지 꾸미기: 배너, 방송중 스위치, 라이브 링크
ALTER TABLE "creator_profile" ADD COLUMN "banner_url" TEXT;
ALTER TABLE "creator_profile" ADD COLUMN "live_on" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "creator_profile" ADD COLUMN "live_url" TEXT;
