-- 정산 회차에 묶인 결제 건을 명시적으로 기록한다.
--
-- 이전에는 "지급액 이하가 될 때까지 오래된 순으로 세기" 로 회차 구성을 매번 다시 유도했다.
-- 그 사이 환불·신규 결제로 목록이 바뀌면 지급액보다 많은 건이 정산 완료로 잠기거나,
-- 실패한 회차의 결제 건을 배치가 새 회차로 다시 잡아 같은 돈이 두 번 나갈 수 있었다.
ALTER TABLE "charge" ADD COLUMN IF NOT EXISTS "settlement_request_id" TEXT;

CREATE INDEX IF NOT EXISTS "charge_settlement_request_id_idx" ON "charge" ("settlement_request_id");

-- 파트너 조회 API 의 커서 페이징(merchant_id + paid_at 정렬)과 자동 정산 대상 조회용.
CREATE INDEX IF NOT EXISTS "charge_merchant_id_paid_at_idx" ON "charge" ("merchant_id", "paid_at");

-- 스튜디오 대시보드의 이번 달 정산 집계용.
CREATE INDEX IF NOT EXISTS "settlement_ledger_merchant_id_settlement_key_idx"
  ON "settlement_ledger" ("merchant_id", "settlement_key");

-- 결제 실패 카운터의 감쇠 기준 시각.
-- 없으면 몇 달 간격의 실패 3건이 합산되어 후원자가 1년 잠긴다.
ALTER TABLE "payer_profile" ADD COLUMN IF NOT EXISTS "last_failed_at" TIMESTAMPTZ(3);
