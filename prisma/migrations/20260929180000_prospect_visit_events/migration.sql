-- The trail behind prospect_visits: every status a rep has set on a door, kept.
-- See ProspectVisitEvent in schema.prisma. Additive only (one new table).
CREATE TABLE "prospect_visit_events" (
    "id" TEXT NOT NULL,
    "prospect_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "rep_name" TEXT NOT NULL,
    "marked_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prospect_visit_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prospect_visit_events_prospect_id_rep_name_marked_at_key" ON "prospect_visit_events"("prospect_id", "rep_name", "marked_at");
CREATE INDEX "prospect_visit_events_prospect_id_marked_at_idx" ON "prospect_visit_events"("prospect_id", "marked_at");
