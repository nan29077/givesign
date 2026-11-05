-- 2026-11-06 점검 A-5: 솔라피 알림톡은 접수(2000)가 전달 완료가 아니다.
-- 접수 상태(ACCEPTED)와 결과 미확인(UNKNOWN)을 나누고, 전달 실패 시 같은 본문을 문자로 대체하기 위한 원문 암호문을 둔다.
-- PostgreSQL 12 이상은 ADD VALUE 를 트랜잭션 안에서 실행할 수 있다(같은 트랜잭션에서 새 값을 쓰지는 않는다).
ALTER TYPE "delivery_status" ADD VALUE 'ACCEPTED';
ALTER TYPE "delivery_status" ADD VALUE 'UNKNOWN';

ALTER TABLE "mt_outbound_message"
  ADD COLUMN "accepted_at" TIMESTAMPTZ(3),
  ADD COLUMN "report_checked_at" TIMESTAMPTZ(3),
  ADD COLUMN "body_enc" TEXT;
