-- 고도화 6단계: 자원봉사 모집 공고·회차, 신청↔회차 연결·출석/불참, 콘텐츠↔공고 연결, 후원자 병합(조회·집계용)

-- CreateEnum
CREATE TYPE "volunteer_posting_status" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "volunteer_application_status" ADD VALUE 'COMPLETED';
ALTER TYPE "volunteer_application_status" ADD VALUE 'NO_SHOW';

-- AlterTable
ALTER TABLE "content_item" ADD COLUMN     "posting_id" TEXT;

-- AlterTable
ALTER TABLE "payer_profile" ADD COLUMN     "merge_note" TEXT,
ADD COLUMN     "merged_at" TIMESTAMPTZ(3),
ADD COLUMN     "merged_by" TEXT,
ADD COLUMN     "merged_into_id" TEXT;

-- AlterTable
ALTER TABLE "volunteer_application" ADD COLUMN     "attended_at" TIMESTAMPTZ(3),
ADD COLUMN     "attended_by" TEXT,
ADD COLUMN     "posting_id" TEXT,
ADD COLUMN     "shift_id" TEXT;

-- CreateTable
CREATE TABLE "volunteer_posting" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "interest" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "place" TEXT NOT NULL,
    "recruit_from" DATE NOT NULL,
    "recruit_to" DATE NOT NULL,
    "requirements" TEXT,
    "status" "volunteer_posting_status" NOT NULL DEFAULT 'DRAFT',
    "created_by" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "volunteer_posting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volunteer_shift" (
    "id" TEXT NOT NULL,
    "posting_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "shift_date" DATE NOT NULL,
    "start_time" TEXT NOT NULL,
    "end_time" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "applied_count" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "volunteer_shift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "volunteer_posting_merchant_id_status_recruit_to_idx" ON "volunteer_posting"("merchant_id", "status", "recruit_to");

-- CreateIndex
CREATE INDEX "volunteer_shift_posting_id_shift_date_idx" ON "volunteer_shift"("posting_id", "shift_date");

-- CreateIndex
CREATE INDEX "volunteer_shift_starts_at_idx" ON "volunteer_shift"("starts_at");

-- CreateIndex
CREATE INDEX "payer_profile_merged_into_id_idx" ON "payer_profile"("merged_into_id");

-- CreateIndex
CREATE INDEX "volunteer_application_shift_id_status_idx" ON "volunteer_application"("shift_id", "status");

-- AddForeignKey
ALTER TABLE "volunteer_application" ADD CONSTRAINT "volunteer_application_posting_id_fkey" FOREIGN KEY ("posting_id") REFERENCES "volunteer_posting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteer_application" ADD CONSTRAINT "volunteer_application_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "volunteer_shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteer_shift" ADD CONSTRAINT "volunteer_shift_posting_id_fkey" FOREIGN KEY ("posting_id") REFERENCES "volunteer_posting"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 정원·신청 수 하한. 정원 초과는 조건부 증가(applied_count < capacity)로 막는다.
ALTER TABLE "volunteer_shift" ADD CONSTRAINT "volunteer_shift_capacity_check" CHECK ("capacity" >= 1 AND "capacity" <= 1000);
ALTER TABLE "volunteer_shift" ADD CONSTRAINT "volunteer_shift_applied_count_check" CHECK ("applied_count" >= 0);

-- 진행 중(접수·승인) 신청 1건 규칙을 둘로 나눈다.
--  - 일반 신청(회차 없음): 후원자당 기관당 1건 (기존 동작 유지)
--  - 회차 신청: 후원자당 기관당 회차당 1건 (여러 회차에 각각 신청할 수 있다)
DROP INDEX IF EXISTS "volunteer_application_live_uniq";
CREATE UNIQUE INDEX "volunteer_application_live_uniq"
  ON "volunteer_application" ("merchant_id", "payer_id")
  WHERE "status" IN ('RECEIVED', 'APPROVED') AND "shift_id" IS NULL;
CREATE UNIQUE INDEX "volunteer_application_shift_live_uniq"
  ON "volunteer_application" ("merchant_id", "payer_id", "shift_id")
  WHERE "status" IN ('RECEIVED', 'APPROVED') AND "shift_id" IS NOT NULL;

-- 병합은 1단계만, 자기 자신으로는 병합하지 않는다(순환·체인은 서비스에서 행 잠금으로 막는다).
ALTER TABLE "payer_profile" ADD CONSTRAINT "payer_profile_merged_not_self" CHECK ("merged_into_id" IS NULL OR "merged_into_id" <> "id");
