-- 점검 B (2026-11-05): 같은 주민등록번호를 두 후원자 계정에 등록하지 못하게 resident_no_hash 를 유니크로 바꾼다.
--
-- 이미 중복으로 등록된 행이 있으면 유니크 인덱스 생성이 실패하므로, 먼저 정리한다.
-- 데이터는 지우지 않는다. 가장 먼저 등록한 행(created_at, payer_id 순)만 그대로 두고,
-- 나머지 행의 해시 앞에 'conflict:<payer_id>:' 를 붙여 충돌을 피한다. 이렇게 표시된 행은
-- 애플리케이션에서 "확인 필요(주민번호 중복)" 로 보고 영수증을 발급하지 않는다(receipts.ts).
-- 후원자가 다시 저장하면 정상 해시로 바뀌며, 그때 먼저 등록한 계정이 있으면 거절된다.
WITH ranked AS (
  SELECT "payer_id",
         ROW_NUMBER() OVER (PARTITION BY "resident_no_hash" ORDER BY "created_at" ASC, "payer_id" ASC) AS rn
  FROM "payer_receipt_profile"
  WHERE "resident_no_hash" NOT LIKE 'conflict:%'
)
UPDATE "payer_receipt_profile" p
SET "resident_no_hash" = 'conflict:' || p."payer_id" || ':' || p."resident_no_hash"
FROM ranked r
WHERE p."payer_id" = r."payer_id" AND r.rn > 1;

DROP INDEX IF EXISTS "payer_receipt_profile_resident_no_hash_idx";

CREATE UNIQUE INDEX "payer_receipt_profile_resident_no_hash_key" ON "payer_receipt_profile"("resident_no_hash");
