-- 결제수단 종류(계좌 / 카드) 구분.
-- 카드 빌링키는 아직 실 연동 전이며, 스키마와 로직 구조만 먼저 준비한다.
CREATE TYPE "payment_method_kind" AS ENUM ('ACCOUNT', 'CARD');

ALTER TABLE "payment_registration"
  ADD COLUMN "method" "payment_method_kind" NOT NULL DEFAULT 'ACCOUNT';

ALTER TABLE "payment_method_token"
  ADD COLUMN "method" "payment_method_kind" NOT NULL DEFAULT 'ACCOUNT',
  ADD COLUMN "card_issuer" TEXT,
  ADD COLUMN "card_tail4" TEXT;
