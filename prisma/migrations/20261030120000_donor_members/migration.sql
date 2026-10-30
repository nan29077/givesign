-- CreateEnum
CREATE TYPE "donor_member_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "donor_member" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "donor_member_status" NOT NULL DEFAULT 'ACTIVE',
    "phone_hash" TEXT,
    "phone_enc" TEXT,
    "phone_masked" TEXT,
    "phone_verified_at" TIMESTAMPTZ(3),
    "marketing_agreed" BOOLEAN NOT NULL DEFAULT false,
    "terms_agreed_at" TIMESTAMPTZ(3) NOT NULL,
    "avatar_index" INTEGER NOT NULL DEFAULT (floor((random() * (50)::double precision)))::integer,
    "last_login_at" TIMESTAMPTZ(3),
    "admin_note" TEXT,
    "withdrawn_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "donor_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "donor_session" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "donor_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "donor_member_merchant_id_status_created_at_idx" ON "donor_member"("merchant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "donor_member_email_idx" ON "donor_member"("email");

-- CreateIndex
CREATE UNIQUE INDEX "donor_member_merchant_id_email_key" ON "donor_member"("merchant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "donor_member_merchant_id_phone_hash_key" ON "donor_member"("merchant_id", "phone_hash");

-- CreateIndex
CREATE UNIQUE INDEX "donor_session_token_hash_key" ON "donor_session"("token_hash");

-- CreateIndex
CREATE INDEX "donor_session_member_id_idx" ON "donor_session"("member_id");

-- CreateIndex
CREATE INDEX "donor_session_expires_at_idx" ON "donor_session"("expires_at");

-- AddForeignKey
ALTER TABLE "donor_member" ADD CONSTRAINT "donor_member_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donor_session" ADD CONSTRAINT "donor_session_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "donor_member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

