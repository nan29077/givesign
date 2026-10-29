-- 도메인 이름 정리 (문자PG 전환 3-E)
--
-- 후원 서비스 시절의 이름을 결제 서비스 이름으로 바꾼다. 구조는 그대로이고 이름만 바뀐다.
--   donation      -> charge            (결제/충전 건)
--   creator_*     -> merchant_*        (사회복지기관)
--   donor_*       -> payer_*           (결제 후원자)
--
-- 데이터는 옮기지 않는다(RENAME 만 사용). 순서: 컬럼 -> 테이블 -> 타입 -> 이름 정리.

-- 1) 컬럼 이름 ---------------------------------------------------------------
ALTER TABLE "banned_word"          RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "blocked_donor"        RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "blocked_donor"        RENAME COLUMN "donor_id"   TO "payer_id";
ALTER TABLE "charge_product"       RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "creator_code"         RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "creator_mo_number"    RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "donation"             RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "donation"             RENAME COLUMN "donor_id"   TO "payer_id";
ALTER TABLE "donation_counter"     RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "donation_counter"     RENAME COLUMN "donor_id"   TO "payer_id";
ALTER TABLE "donation_limit_policy" RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "donation_limit_policy" RENAME COLUMN "donor_id"   TO "payer_id";
ALTER TABLE "donation_status_log"  RENAME COLUMN "donation_id" TO "charge_id";
ALTER TABLE "donor_creator_link"   RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "donor_creator_link"   RENAME COLUMN "donor_id"   TO "payer_id";
ALTER TABLE "donor_creator_link"   RENAME COLUMN "donor_blocked_at" TO "payer_blocked_at";
ALTER TABLE "fee_policy"           RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "mo_inbound_message"   RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "mt_outbound_message"  RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "mt_outbound_message"  RENAME COLUMN "donation_id" TO "charge_id";
ALTER TABLE "payment_method_token" RENAME COLUMN "donor_id"   TO "payer_id";
ALTER TABLE "payment_pin_session"  RENAME COLUMN "donation_id" TO "charge_id";
ALTER TABLE "payment_registration" RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "payment_registration" RENAME COLUMN "donor_id"   TO "payer_id";
ALTER TABLE "payment_transaction"  RENAME COLUMN "donation_id" TO "charge_id";
ALTER TABLE "refund"               RENAME COLUMN "donation_id" TO "charge_id";
ALTER TABLE "report"               RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "report"               RENAME COLUMN "donation_id" TO "charge_id";
ALTER TABLE "risk_detection"       RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "risk_detection"       RENAME COLUMN "donor_id"   TO "payer_id";
ALTER TABLE "risk_detection"       RENAME COLUMN "donation_id" TO "charge_id";
ALTER TABLE "secure_link"          RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "secure_link"          RENAME COLUMN "donation_id" TO "charge_id";
ALTER TABLE "settlement_account"   RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "settlement_ledger"    RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "settlement_ledger"    RENAME COLUMN "donation_id" TO "charge_id";
ALTER TABLE "settlement_request"   RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "support_inquiry"      RENAME COLUMN "creator_id" TO "merchant_id";
ALTER TABLE "support_inquiry"      RENAME COLUMN "donation_id" TO "charge_id";

-- 한도 정책 컬럼
ALTER TABLE "donation_limit_policy" RENAME COLUMN "donor_daily_limit"        TO "payer_daily_limit";
ALTER TABLE "donation_limit_policy" RENAME COLUMN "donor_monthly_limit"      TO "payer_monthly_limit";
ALTER TABLE "donation_limit_policy" RENAME COLUMN "donor_daily_max_count"    TO "payer_daily_max_count";
ALTER TABLE "donation_limit_policy" RENAME COLUMN "new_donor_first_day_limit" TO "new_payer_first_day_limit";
ALTER TABLE "donation_limit_policy" RENAME COLUMN "per_creator_daily_limit"  TO "per_merchant_daily_limit";

-- 2) 테이블 이름 -------------------------------------------------------------
ALTER TABLE "donor_profile"         RENAME TO "payer_profile";
ALTER TABLE "donor_creator_link"    RENAME TO "payer_merchant_link";
ALTER TABLE "blocked_donor"         RENAME TO "blocked_payer";
ALTER TABLE "creator_profile"       RENAME TO "merchant_profile";
ALTER TABLE "creator_code"          RENAME TO "merchant_code";
ALTER TABLE "creator_mo_number"     RENAME TO "merchant_mo_number";
ALTER TABLE "donation_status_log"   RENAME TO "charge_status_log";
ALTER TABLE "donation_limit_policy" RENAME TO "charge_limit_policy";
ALTER TABLE "donation_counter"      RENAME TO "charge_counter";
ALTER TABLE "donation"              RENAME TO "charge";

-- 3) 열거형 타입 이름 --------------------------------------------------------
ALTER TYPE "creator_status"          RENAME TO "merchant_status";
ALTER TYPE "donation_status"         RENAME TO "charge_status";
ALTER TYPE "donor_onboarding_status" RENAME TO "payer_onboarding_status";

-- 4) 정산 원장 보호 함수의 옛 브랜드 이름 정리 --------------------------------
CREATE OR REPLACE FUNCTION munjapay_block_ledger_mutation() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION '정산 원장은 append-only 입니다. 정정은 반대분개로 처리하세요.';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS settlement_ledger_append_only ON "settlement_ledger";
CREATE TRIGGER settlement_ledger_append_only
  BEFORE UPDATE OR DELETE ON "settlement_ledger"
  FOR EACH ROW EXECUTE FUNCTION munjapay_block_ledger_mutation();
DROP FUNCTION IF EXISTS tornado_block_ledger_mutation();

-- 5) 인덱스·제약 이름 정리 ---------------------------------------------------
-- 이름만 바꾼다. 정의는 그대로다. 이름이 옛 도메인을 가리키면 나중에 읽는 사람이 헷갈린다.
DO $do$
DECLARE
  r record;
  n text;
BEGIN
  FOR r IN
    SELECT conname AS name, conrelid::regclass::text AS tbl
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
  LOOP
    n := r.name;
    n := replace(n, 'donation_status_log', 'charge_status_log');
    n := replace(n, 'donation_limit_policy', 'charge_limit_policy');
    n := replace(n, 'donation_counter', 'charge_counter');
    n := replace(n, 'donor_creator_link', 'payer_merchant_link');
    n := replace(n, 'creator_profile', 'merchant_profile');
    n := replace(n, 'creator_mo_number', 'merchant_mo_number');
    n := replace(n, 'creator_code', 'merchant_code');
    n := replace(n, 'donor_profile', 'payer_profile');
    n := replace(n, 'blocked_donor', 'blocked_payer');
    n := replace(n, 'creator_id', 'merchant_id');
    n := replace(n, 'donor_id', 'payer_id');
    n := replace(n, 'donation_id', 'charge_id');
    n := replace(n, 'donation', 'charge');
    n := replace(n, 'donor', 'payer');
    n := replace(n, 'creator', 'merchant');
    IF n <> r.name THEN
      EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', r.tbl, r.name, n);
    END IF;
  END LOOP;

  FOR r IN
    SELECT indexname AS name
    FROM pg_indexes
    WHERE schemaname = 'public'
  LOOP
    n := r.name;
    n := replace(n, 'donation_status_log', 'charge_status_log');
    n := replace(n, 'donation_limit_policy', 'charge_limit_policy');
    n := replace(n, 'donation_counter', 'charge_counter');
    n := replace(n, 'donor_creator_link', 'payer_merchant_link');
    n := replace(n, 'creator_profile', 'merchant_profile');
    n := replace(n, 'creator_mo_number', 'merchant_mo_number');
    n := replace(n, 'creator_code', 'merchant_code');
    n := replace(n, 'donor_profile', 'payer_profile');
    n := replace(n, 'blocked_donor', 'blocked_payer');
    n := replace(n, 'creator_id', 'merchant_id');
    n := replace(n, 'donor_id', 'payer_id');
    n := replace(n, 'donation_id', 'charge_id');
    n := replace(n, 'donation', 'charge');
    n := replace(n, 'donor', 'payer');
    n := replace(n, 'creator', 'merchant');
    IF n <> r.name THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', r.name, n);
    END IF;
  END LOOP;
END
$do$;

-- 6) 열거형 값 이름 ----------------------------------------------------------
ALTER TYPE "user_role"    RENAME VALUE 'CREATOR' TO 'MERCHANT';
ALTER TYPE "user_role"    RENAME VALUE 'DONOR'   TO 'PAYER';
ALTER TYPE "policy_scope" RENAME VALUE 'CREATOR' TO 'MERCHANT';
ALTER TYPE "policy_scope" RENAME VALUE 'DONOR'   TO 'PAYER';

-- 7) 스키마와 실제 DB 의 사소한 차이 정리 -------------------------------------
-- charge_product.updated_at 은 @updatedAt(애플리케이션이 채움)이라 DB 기본값이 없어야 한다.
ALTER TABLE "charge_product" ALTER COLUMN "updated_at" DROP DEFAULT;

-- 8) 원장 분개 종류 이름 ------------------------------------------------------
ALTER TYPE "ledger_entry_type" RENAME VALUE 'DONATION_GROSS' TO 'CHARGE_GROSS';

-- 9) 감사로그 액션 코드 (과거 기록도 새 이름으로 맞춘다) ----------------------
UPDATE "admin_audit_log" SET "action" = 'PAYER_UNLOCK'                    WHERE "action" = 'DONOR_UNLOCK';
UPDATE "admin_audit_log" SET "action" = 'PAYER_BLOCK'                     WHERE "action" = 'DONOR_BLOCK';
UPDATE "admin_audit_log" SET "action" = 'PAYER_UNBLOCK'                   WHERE "action" = 'DONOR_UNBLOCK';
UPDATE "admin_audit_log" SET "action" = 'PAYER_LIMIT_UPDATE'              WHERE "action" = 'DONOR_LIMIT_UPDATE';
UPDATE "admin_audit_log" SET "action" = 'MERCHANT_STATUS_UPDATE'          WHERE "action" = 'CREATOR_STATUS_UPDATE';
UPDATE "admin_audit_log" SET "action" = 'MERCHANT_PAYMENT_MODE_UPDATE'    WHERE "action" = 'CREATOR_PAYMENT_MODE_UPDATE';
UPDATE "admin_audit_log" SET "action" = 'MERCHANT_AMOUNT_BOUNDS_UPDATE'   WHERE "action" = 'CREATOR_AMOUNT_BOUNDS_UPDATE';
UPDATE "admin_audit_log" SET "action" = 'MERCHANT_AMOUNT_BOUNDS_APPLY_ALL' WHERE "action" = 'CREATOR_AMOUNT_BOUNDS_APPLY_ALL';
UPDATE "admin_audit_log" SET "action" = 'MERCHANT_CODE_REISSUE'           WHERE "action" = 'CREATOR_CODE_REISSUE';

-- 10) MT 템플릿 코드 (발송 이력·관리자 편집본 모두 새 이름으로 맞춘다) --------
UPDATE "mt_outbound_message" SET "template_code" = 'CHARGE_SUCCESS' WHERE "template_code" = 'DONATION_SUCCESS';
UPDATE "mt_outbound_message" SET "template_code" = 'CHARGE_FAILED'  WHERE "template_code" = 'DONATION_FAILED';
UPDATE "mt_message_template" SET "code" = 'CHARGE_SUCCESS' WHERE "code" = 'DONATION_SUCCESS';
UPDATE "mt_message_template" SET "code" = 'CHARGE_FAILED'  WHERE "code" = 'DONATION_FAILED';
