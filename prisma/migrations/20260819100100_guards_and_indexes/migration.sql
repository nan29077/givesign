-- ---------------------------------------------------------------------------
-- 토네이도 무결성 가드 및 인덱스 보강
-- Amazon RDS / Aurora PostgreSQL 에서 그대로 적용 가능한 표준 SQL 만 사용한다.
-- (PGlite 로컬 미리보기 환경에서도 동일하게 적용된다)
-- ---------------------------------------------------------------------------

-- 1) 정산 원장 APPEND ONLY 강제
--    어떤 경로(관리자 화면, 배치, 수기 쿼리)로도 UPDATE/DELETE 할 수 없다.
--    정정이 필요하면 반대 부호 분개를 INSERT 한다.
CREATE OR REPLACE FUNCTION tornado_block_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '정산 원장(settlement_ledger)은 수정/삭제할 수 없습니다. 정정은 반대분개로 처리하십시오.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS settlement_ledger_append_only ON "settlement_ledger";
CREATE TRIGGER settlement_ledger_append_only
  BEFORE UPDATE OR DELETE ON "settlement_ledger"
  FOR EACH ROW EXECUTE FUNCTION tornado_block_ledger_mutation();

-- 2) 금칙어 유니크 (부분 인덱스)
--    PostgreSQL 은 NULL 을 서로 다른 값으로 취급하므로 (word, creator_id) 단순 유니크로는
--    전역 금칙어(creator_id IS NULL)의 중복을 막지 못한다.
CREATE UNIQUE INDEX IF NOT EXISTS "banned_word_global_uniq"
  ON "banned_word" ("word") WHERE "creator_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "banned_word_creator_uniq"
  ON "banned_word" ("word", "creator_id") WHERE "creator_id" IS NOT NULL;

-- 3) 사회복지기관당 활성 코드는 1개만
CREATE UNIQUE INDEX IF NOT EXISTS "creator_code_active_uniq"
  ON "creator_code" ("creator_id") WHERE "active" = true;

-- 4) 사회복지기관당 활성 스트림 키는 1개만
CREATE UNIQUE INDEX IF NOT EXISTS "stream_key_active_uniq"
  ON "stream_key" ("channel_id") WHERE "status" = 'ACTIVE';

-- 5) 후원자당 활성 결제수단은 1개만 (교체 시 기존 키를 REVOKED 처리)
CREATE UNIQUE INDEX IF NOT EXISTS "payment_method_token_active_uniq"
  ON "payment_method_token" ("donor_id") WHERE "status" = 'ACTIVE';

-- 6) 후원 거래당 승인 완료 결제는 1건만 (중복 결제 최종 방어선)
CREATE UNIQUE INDEX IF NOT EXISTS "payment_transaction_approved_uniq"
  ON "payment_transaction" ("donation_id") WHERE "status" = 'APPROVED';

-- 7) 금액 음수 방지
ALTER TABLE "donation" DROP CONSTRAINT IF EXISTS "donation_amount_positive";
ALTER TABLE "donation" ADD CONSTRAINT "donation_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "payment_transaction" DROP CONSTRAINT IF EXISTS "payment_transaction_amount_positive";
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_amount_positive" CHECK ("amount" > 0);

-- 8) 운영 통계용 보조 인덱스
CREATE INDEX IF NOT EXISTS "donation_creator_status_idx" ON "donation" ("creator_id", "status");
CREATE INDEX IF NOT EXISTS "donation_paid_at_idx" ON "donation" ("paid_at");
CREATE INDEX IF NOT EXISTS "mt_outbound_creator_idx" ON "mt_outbound_message" ("creator_id", "created_at");
