-- 배송 메모를 둘로 나눈다.
--   memo          : 후원자가 결제 화면에서 남긴 배송 요청 (사회복지기관은 읽기 전용)
--   merchant_memo : 사회복지기관 내부 메모 (후원자에게 보이지 않음)
-- 이전에는 한 컬럼을 공유해, 사회복지기관이 내부 메모를 저장하면 후원자의 배송 요청이 지워졌다.
ALTER TABLE "charge_shipment" ADD COLUMN "merchant_memo" TEXT;
