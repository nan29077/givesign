-- 금액 미정 상태 허용 (문자PG 전환 3단계)
--
-- MO 를 받은 시점에는 후원 금액이 정해지지 않는다. 금액 0 은 "아직 고르지 않음" 을 뜻한다.
-- PENDING_AMOUNT 에서만 0 을 허용하고, 그 밖의 모든 상태에서는 여전히 양수만 허용해
-- 0원 결제가 승인·정산으로 흘러가는 것을 막는다.
--
-- enum 값을 추가한 마이그레이션과 같은 트랜잭션에서는 그 값을 쓸 수 없어 파일을 나눴다.

ALTER TABLE "donation" DROP CONSTRAINT IF EXISTS "donation_amount_positive";
-- 금액을 고르기 전에 끝난 건(차단·실패)도 금액이 없다. 승인·정산으로 가는 상태에서는 여전히 양수만 허용한다.
ALTER TABLE "donation" ADD CONSTRAINT "donation_amount_positive"
  CHECK (
    "amount" > 0
    OR ("amount" = 0 AND "status" IN ('PENDING_AMOUNT', 'LIMIT_BLOCKED', 'CONTENT_BLOCKED', 'PAYMENT_FAILED', 'UNREGISTERED'))
  );
