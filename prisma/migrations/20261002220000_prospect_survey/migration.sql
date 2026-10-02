-- Survey answers on a prospect visit, and on each entry in its trail. See
-- ProspectVisit.survey in schema.prisma. Additive: two nullable columns.
ALTER TABLE "prospect_visits" ADD COLUMN "survey" JSONB;
ALTER TABLE "prospect_visit_events" ADD COLUMN "survey" JSONB;
