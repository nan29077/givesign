-- 자동 정산 (지급일 지정 + 지급대행)
--
-- 사회복지기관이 정산을 요청하는 방식에서, 관리자가 정한 지급일에 자동으로 지급하는 방식으로 바꾼다.
--   settlement_days : 결제일로부터 며칠(영업일) 뒤에 지급할지. 전역 일괄 + 사회복지기관별 개별 지정
--   auto            : 자동 정산 배치가 만든 회차 표시
--
-- 포인트 지급 상태(사회복지기관이 자기 서비스에 포인트를 넣었는지)도 함께 정리한다.
-- 이전 이름(reflect_*)은 문자페이가 사회복지기관을 호출하는 구조를 전제했으나,
-- 지급 주체가 사회복지기관으로 확정되면서 의미가 바뀌었다.

ALTER TABLE "fee_policy"
  ADD COLUMN "settlement_days" INTEGER NOT NULL DEFAULT 5;

ALTER TABLE "settlement_request"
  ADD COLUMN "auto" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "charge" RENAME COLUMN "reflect_status" TO "point_status";
ALTER TABLE "charge" RENAME COLUMN "reflect_note"   TO "point_note";
ALTER TABLE "charge" RENAME COLUMN "reflected_at"   TO "point_given_at";
ALTER TABLE "charge" ADD COLUMN "point_by" TEXT;
