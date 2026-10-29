-- 방송 계층 제거 (문자PG 전환 1단계)
--
-- 오버레이 · TTS · 유튜브 연동은 사회복지기관 후원 서비스의 기능이다.
-- 문자페이는 사회복지기관 결제·충전 인프라이므로 관련 테이블과 컬럼을 모두 걷어낸다.
-- 결제·정산·한도·문자 파이프라인은 그대로 둔다.

DROP TABLE IF EXISTS "youtube_chat_delivery" CASCADE;
DROP TABLE IF EXISTS "youtube_broadcast" CASCADE;
DROP TABLE IF EXISTS "youtube_connection" CASCADE;
DROP TABLE IF EXISTS "overlay_event" CASCADE;
DROP TABLE IF EXISTS "overlay_tier" CASCADE;
DROP TABLE IF EXISTS "overlay_setting" CASCADE;
DROP TABLE IF EXISTS "tts_setting" CASCADE;

DROP TYPE IF EXISTS "youtube_connection_status";

ALTER TABLE "donation"
  DROP COLUMN IF EXISTS "youtube_status",
  DROP COLUMN IF EXISTS "overlay_status",
  DROP COLUMN IF EXISTS "broadcasted_at";

ALTER TABLE "creator_profile"
  DROP COLUMN IF EXISTS "live_on",
  DROP COLUMN IF EXISTS "live_url",
  DROP COLUMN IF EXISTS "live_platform",
  DROP COLUMN IF EXISTS "youtube_live_url",
  DROP COLUMN IF EXISTS "instagram_live_url",
  DROP COLUMN IF EXISTS "tiktok_live_url",
  DROP COLUMN IF EXISTS "channel_platform",
  DROP COLUMN IF EXISTS "onboarding_obs_linked",
  DROP COLUMN IF EXISTS "onboarding_test_done";

ALTER TABLE "donation_limit_policy" DROP COLUMN IF EXISTS "tts_min_amount";
