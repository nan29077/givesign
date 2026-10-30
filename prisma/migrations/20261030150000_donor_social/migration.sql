-- CreateTable
CREATE TABLE "donor_social_account" (
    "id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_user_hash" TEXT NOT NULL,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "donor_social_account_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "donor_social_account_merchant_id_provider_provider_user_has_key" ON "donor_social_account"("merchant_id", "provider", "provider_user_hash");

-- CreateIndex
CREATE UNIQUE INDEX "donor_social_account_member_id_provider_key" ON "donor_social_account"("member_id", "provider");

-- AddForeignKey
ALTER TABLE "donor_social_account" ADD CONSTRAINT "donor_social_account_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "donor_member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

