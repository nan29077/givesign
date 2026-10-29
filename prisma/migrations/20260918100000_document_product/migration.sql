-- 문서 상품 (약정서·주문서·계약서).
--
-- 사회복지기관이 문서 서식(document_template)을 등록하고, 그 서식을 가리키는 상품
-- (charge_product.kind = DOCUMENT)을 판다. 결제가 끝나면 제출 기록
-- (document_submission)을 DRAFT 로 먼저 만들고, 그 토큰으로 만든 작성 링크를
-- 감사 문자에 넣어 보낸다. 후원자가 화면에서 채우거나 파일을 내려받아 제출한다.
--
-- 주의
--  - product_kind 에 값을 더하는 것뿐이라 기존 실물·비실물 상품은 그대로다.
--    PostgreSQL 12 이상은 ALTER TYPE ... ADD VALUE 를 트랜잭션 안에서 실행할 수 있고,
--    같은 트랜잭션에서 그 값을 쓰지만 않으면 된다(이 마이그레이션은 쓰지 않는다).
--  - 제출 기록은 서식을 참조하므로 서식은 삭제하지 않고 archived_at 으로 보관한다
--    (FK ON DELETE RESTRICT).
--  - 후원자가 적어 넣은 값은 개인정보다. values_enc / payer_*_enc 로 암호화해 담고
--    목록에는 마스킹 컬럼만 쓴다. 원문 열람은 감사로그를 남긴다.

-- CreateEnum
CREATE TYPE "document_template_type" AS ENUM ('EDITOR', 'FILE', 'PRESET');

-- CreateEnum
CREATE TYPE "document_submission_status" AS ENUM ('DRAFT', 'SUBMITTED', 'REVIEWED');

-- AlterEnum
ALTER TYPE "product_kind" ADD VALUE 'DOCUMENT';

-- AlterTable
ALTER TABLE "charge_product" ADD COLUMN     "document_template_id" TEXT;

-- CreateTable
CREATE TABLE "document_template" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "template_type" "document_template_type" NOT NULL,
    "body" TEXT,
    "fields" JSONB,
    "file_url" TEXT,
    "file_name" TEXT,
    "preset_key" TEXT,
    "require_signature" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_submission" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "charge_id" TEXT,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "payer_name_enc" TEXT,
    "payer_name_masked" TEXT,
    "payer_phone_enc" TEXT,
    "payer_phone_masked" TEXT,
    "values_enc" TEXT,
    "signature_url" TEXT,
    "status" "document_submission_status" NOT NULL DEFAULT 'DRAFT',
    "submitted_at" TIMESTAMPTZ(3),
    "reviewed_at" TIMESTAMPTZ(3),
    "merchant_memo" TEXT,
    "submit_ip" TEXT,
    "submit_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_submission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_template_merchant_id_active_idx" ON "document_template"("merchant_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "document_submission_charge_id_key" ON "document_submission"("charge_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_submission_token_hash_key" ON "document_submission"("token_hash");

-- CreateIndex
CREATE INDEX "document_submission_merchant_id_status_created_at_idx" ON "document_submission"("merchant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "document_submission_template_id_idx" ON "document_submission"("template_id");

-- CreateIndex
CREATE INDEX "document_submission_expires_at_idx" ON "document_submission"("expires_at");

-- CreateIndex
CREATE INDEX "charge_product_document_template_id_idx" ON "charge_product"("document_template_id");

-- AddForeignKey
ALTER TABLE "charge_product" ADD CONSTRAINT "charge_product_document_template_id_fkey" FOREIGN KEY ("document_template_id") REFERENCES "document_template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_template" ADD CONSTRAINT "document_template_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_submission" ADD CONSTRAINT "document_submission_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "document_template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_submission" ADD CONSTRAINT "document_submission_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_submission" ADD CONSTRAINT "document_submission_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "charge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

