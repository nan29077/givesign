-- AddColumn: creator_profile.channel_platform
ALTER TABLE "creator_profile" ADD COLUMN IF NOT EXISTS "channel_platform" TEXT;
