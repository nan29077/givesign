-- 충전 반영 상태 (문자PG 4단계 연동 자리)
--
-- 결제 승인 이후 사회복지기관에 충전을 반영한 결과를 남긴다.
-- 결제 성공과는 별개 사건이다. 반영이 실패해도 결제·정산은 되돌리지 않고 상태로만 남긴다.

ALTER TABLE "donation"
  ADD COLUMN "reflect_status" "delivery_status" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "reflect_note"   TEXT,
  ADD COLUMN "reflected_at"   TIMESTAMPTZ(3);
