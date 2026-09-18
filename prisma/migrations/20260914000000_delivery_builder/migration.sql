ALTER TABLE "delivery_routes" ADD COLUMN "routing_snapshot" JSONB;
ALTER TABLE "route_stops" ALTER COLUMN "order_id" DROP NOT NULL;
ALTER TABLE "route_stops" ADD COLUMN "stop_name" TEXT, ADD COLUMN "stop_address" TEXT, ADD COLUMN "account_ref" TEXT;
ALTER TABLE "route_stops" ADD CONSTRAINT "route_stop_destination" CHECK ("order_id" IS NOT NULL OR (length(trim("stop_name")) > 0 AND length(trim("stop_address")) > 0 AND "stop_name" IS NOT NULL AND "stop_address" IS NOT NULL));
