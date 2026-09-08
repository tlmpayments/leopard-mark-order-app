-- A driver's personal sign-in link: a held credential instead of a typed one.

-- CreateTable
CREATE TABLE "driver_access_tokens" (
    "id" TEXT NOT NULL,
    "rep_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "label" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" TEXT,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "driver_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_access_tokens_token_hash_key" ON "driver_access_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "driver_access_tokens_rep_id_revoked_at_idx" ON "driver_access_tokens"("rep_id", "revoked_at");

-- AddForeignKey
ALTER TABLE "driver_access_tokens" ADD CONSTRAINT "driver_access_tokens_rep_id_fkey" FOREIGN KEY ("rep_id") REFERENCES "reps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
