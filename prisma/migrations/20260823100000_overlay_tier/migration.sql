-- ---------------------------------------------------------------------------
-- 금액 구간별 오버레이 효과 (overlay_tier)
--
-- 후원 금액에 따라 파티클 효과 / 배너 / TTS 를 다르게 재생하기 위한 표.
-- 적용 규칙: min_amount <= 후원금액 인 구간 중 min_amount 가 가장 큰 것 하나.
-- 구간이 하나도 없는 사회복지기관는 overlay_setting 의 전역 값으로 동작한다.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "overlay_tier" (
  "id"          TEXT NOT NULL,
  "creator_id"  TEXT NOT NULL,
  "min_amount"  BIGINT NOT NULL,
  "label"       TEXT NOT NULL,
  "effect"      TEXT NOT NULL DEFAULT 'HEART',
  "banner"      BOOLEAN NOT NULL DEFAULT true,
  "duration_ms" INTEGER NOT NULL DEFAULT 7000,
  "tts_enabled" BOOLEAN NOT NULL DEFAULT false,
  "tts_voice"   TEXT NOT NULL DEFAULT '',
  "tts_speed"   DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "tts_pitch"   DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "overlay_tier_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'overlay_tier_creator_id_fkey'
  ) THEN
    ALTER TABLE "overlay_tier"
      ADD CONSTRAINT "overlay_tier_creator_id_fkey"
      FOREIGN KEY ("creator_id") REFERENCES "creator_profile" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 같은 사회복지기관가 같은 금액 구간을 두 번 만들 수 없다.
CREATE UNIQUE INDEX IF NOT EXISTS "overlay_tier_creator_id_min_amount_key"
  ON "overlay_tier" ("creator_id", "min_amount");
CREATE INDEX IF NOT EXISTS "overlay_tier_creator_id_min_amount_idx"
  ON "overlay_tier" ("creator_id", "min_amount");
