-- 후원 금액 선택 흐름 (문자PG 전환 3단계)
--
-- MO 문자는 금액을 담지 않는다. 문자를 받으면 금액 선택 링크를 보내고,
-- 후원자가 링크에서 후원 항목을 고른 뒤에야 금액이 확정된다.
--   PENDING_AMOUNT : 금액 선택 대기 상태
--   SELECT_AMOUNT  : 금액 선택 + PIN 인증으로 이어지는 보안링크

ALTER TYPE "donation_status" ADD VALUE IF NOT EXISTS 'PENDING_AMOUNT';
ALTER TYPE "secure_link_purpose" ADD VALUE IF NOT EXISTS 'SELECT_AMOUNT';
