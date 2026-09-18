-- The rep's field record for a prospective door. See ProspectVisit in
-- schema.prisma for why the door list itself is not in the database.
CREATE TYPE "prospect_visit_status" AS ENUM ('visited', 'interested', 'comeback', 'signed', 'nofit');

CREATE TABLE "prospect_visits" (
    "id" TEXT NOT NULL,
    "prospect_id" INTEGER NOT NULL,
    "status" "prospect_visit_status" NOT NULL,
    "note" TEXT,
    "rep_name" TEXT NOT NULL,
    "marked_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prospect_visits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prospect_visits_prospect_id_key" ON "prospect_visits"("prospect_id");
CREATE INDEX "prospect_visits_rep_name_idx" ON "prospect_visits"("rep_name");
CREATE INDEX "prospect_visits_status_idx" ON "prospect_visits"("status");
