-- 2026-11-06 정밀 점검 A-3: 저니 문자 단계 발송 중복 키(발송 전 예약 행)
ALTER TABLE "journey_step_log" ADD COLUMN "dedupe_key" TEXT;
CREATE UNIQUE INDEX "journey_step_log_dedupe_key_key" ON "journey_step_log"("dedupe_key");
