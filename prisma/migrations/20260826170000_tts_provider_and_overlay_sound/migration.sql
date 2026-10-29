-- 외부 TTS 제공사(네이버 클로바 Voice) 연동 정보.
-- 인증 정보는 암호화 컬럼(_enc)에만 저장하고 화면에는 마스킹 값만 노출한다.
ALTER TABLE "tts_setting"
ADD COLUMN "tts_provider" TEXT NOT NULL DEFAULT 'browser',
ADD COLUMN "naver_client_id_enc" TEXT,
ADD COLUMN "naver_client_secret_enc" TEXT,
ADD COLUMN "naver_client_id_masked" TEXT;

-- 오버레이 효과음 설정. 기본은 켜짐 / 음량 80.
ALTER TABLE "overlay_setting"
ADD COLUMN "sound_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "sound_volume" INTEGER NOT NULL DEFAULT 80;

ALTER TABLE "overlay_setting"
ADD CONSTRAINT "overlay_setting_sound_volume_check"
CHECK ("sound_volume" >= 0 AND "sound_volume" <= 100);
