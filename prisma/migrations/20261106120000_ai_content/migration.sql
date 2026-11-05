-- 고도화 5단계: AI 실연동·콘텐츠 캘린더(자율 생성)·카드뉴스/피드 형식·플랫폼 확장(틱톡·네이버 블로그·카카오 채널)·AI 비용 기록
-- 새 enum 값은 이 마이그레이션 안에서 쓰지 않는다(ADD VALUE 는 커밋 전 사용 불가).

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "content_kind" ADD VALUE 'CARD_NEWS';
ALTER TYPE "content_kind" ADD VALUE 'IMAGE_FEED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "social_platform" ADD VALUE 'TIKTOK';
ALTER TYPE "social_platform" ADD VALUE 'NAVER_BLOG';
ALTER TYPE "social_platform" ADD VALUE 'KAKAO_CHANNEL';

-- AlterTable
ALTER TABLE "content_item" ADD COLUMN     "platform_captions" JSONB,
ADD COLUMN     "video_url" TEXT;

-- AlterTable
ALTER TABLE "merchant_content_setting" ADD COLUMN     "auto_schedule" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "calendar_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "days" INTEGER[] DEFAULT ARRAY[1, 3, 5]::INTEGER[],
ADD COLUMN     "kinds" "content_kind"[],
ADD COLUMN     "platforms" "social_platform"[],
ADD COLUMN     "post_hour" INTEGER NOT NULL DEFAULT 19,
ADD COLUMN     "weekly_count" INTEGER NOT NULL DEFAULT 3;

-- CreateTable
CREATE TABLE "content_slot" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "slot_at" TIMESTAMPTZ(3) NOT NULL,
    "kind" "content_kind" NOT NULL,
    "campaign_id" TEXT,
    "item_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'GENERATING',
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_slot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT,
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_krw" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_cache" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "cache_key" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "content_slot_item_id_idx" ON "content_slot"("item_id");

-- CreateIndex
CREATE INDEX "content_slot_campaign_id_created_at_idx" ON "content_slot"("campaign_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "content_slot_merchant_id_slot_at_key" ON "content_slot"("merchant_id", "slot_at");

-- CreateIndex
CREATE INDEX "ai_usage_merchant_id_created_at_idx" ON "ai_usage"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_created_at_idx" ON "ai_usage"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_cache_merchant_id_feature_cache_key_key" ON "ai_cache"("merchant_id", "feature", "cache_key");

