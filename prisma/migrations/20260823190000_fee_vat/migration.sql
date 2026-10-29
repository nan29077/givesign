-- 수수료 부가세 분리 표시용 컬럼.
--
-- donation.pg_fee / platform_fee 는 종전과 같이 "실제 차감액" 이며,
-- 수수료 정책의 vat_included = false 인 경우 부가세가 그 안에 포함된다.
-- fee_vat 은 그중 부가세가 얼마인지 보여주기 위한 값이다(합산 대상 아님).
ALTER TABLE "donation" ADD COLUMN "fee_vat" BIGINT NOT NULL DEFAULT 0;
