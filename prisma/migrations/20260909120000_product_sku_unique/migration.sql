-- 사회복지기관 안에서 sku 를 유일하게 만든다.
--
-- 일괄 동기화(POST /api/partner/v1/products/bulk)는 sku 로 기존 상품을 찾아 갱신한다.
-- 같은 sku 가 두 건이면 어느 쪽이 갱신될지 알 수 없고, 두 요청이 동시에 들어오면
-- 둘 다 "없음" 으로 판단해 같은 sku 상품이 두 개 만들어진다.
--
-- sku 가 비어 있는 상품(수동 등록 상품 대부분)은 제약을 받지 않는다.
-- Postgres 의 UNIQUE 는 NULL 을 서로 다른 값으로 보기 때문이다.
--
-- 이미 중복이 있으면 이 마이그레이션은 실패한다. 그때는 아래로 중복을 찾아
-- 한쪽 sku 를 바꾸거나 비운 뒤 다시 적용한다.
--   SELECT merchant_id, sku, count(*) FROM charge_product
--    WHERE sku IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1;
CREATE UNIQUE INDEX "charge_product_merchant_id_sku_key"
  ON "charge_product" ("merchant_id", "sku");
