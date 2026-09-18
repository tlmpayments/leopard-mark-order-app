-- The rep app's marketing materials flow, off Apps Script and into the
-- ledger. See the Marketing* models in schema.prisma for why the catalogue is
-- editable rows rather than a bundled JS file, and why retiring an item is a
-- flag rather than a delete.

CREATE TYPE "marketing_item_type" AS ENUM ('physical', 'digital');
CREATE TYPE "marketing_request_status" AS ENUM ('pending', 'approved', 'fulfilled', 'declined', 'cancelled');

CREATE TABLE "marketing_items" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "type" "marketing_item_type" NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "specs" TEXT NOT NULL DEFAULT '',
    "unit" TEXT NOT NULL DEFAULT 'each',
    "supplier" TEXT NOT NULL DEFAULT '',
    "lead_time" TEXT NOT NULL DEFAULT '',
    "image_url" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "marketing_items_sku_key" ON "marketing_items"("sku");
CREATE INDEX "marketing_items_active_category_idx" ON "marketing_items"("active", "category");
CREATE INDEX "marketing_items_brand_idx" ON "marketing_items"("brand");

CREATE TABLE "marketing_sequences" (
    "yymm" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "marketing_sequences_pkey" PRIMARY KEY ("yymm")
);

CREATE TABLE "marketing_requests" (
    "id" TEXT NOT NULL,
    "request_number" TEXT NOT NULL,
    "status" "marketing_request_status" NOT NULL DEFAULT 'pending',
    "rep_name" TEXT NOT NULL,
    "email" TEXT,
    "purpose" TEXT NOT NULL,
    "needed_by" TIMESTAMP(3) NOT NULL,
    "account_id" TEXT,
    "account_name" TEXT,
    "region" TEXT,
    "event_name" TEXT,
    "ship_address" TEXT,
    "custom_request" TEXT,
    "size" TEXT,
    "other_details" TEXT,
    "slack_channel" TEXT,
    "slack_ts" TEXT,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "archived_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "marketing_requests_request_number_key" ON "marketing_requests"("request_number");
CREATE INDEX "marketing_requests_status_created_at_idx" ON "marketing_requests"("status", "created_at");
CREATE INDEX "marketing_requests_rep_name_idx" ON "marketing_requests"("rep_name");
CREATE INDEX "marketing_requests_archived_at_idx" ON "marketing_requests"("archived_at");
CREATE INDEX "marketing_requests_deleted_at_idx" ON "marketing_requests"("deleted_at");

CREATE TABLE "marketing_request_lines" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "item_id" TEXT,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'each',
    "qty" INTEGER NOT NULL,
    "size" TEXT,

    CONSTRAINT "marketing_request_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "marketing_request_lines_request_id_idx" ON "marketing_request_lines"("request_id");
CREATE INDEX "marketing_request_lines_item_id_idx" ON "marketing_request_lines"("item_id");

CREATE TABLE "marketing_request_events" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "status" "marketing_request_status",
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_request_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "marketing_request_events_request_id_created_at_idx" ON "marketing_request_events"("request_id", "created_at");

CREATE TABLE "marketing_request_attachments" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_request_attachments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "marketing_request_attachments_request_id_idx" ON "marketing_request_attachments"("request_id");

ALTER TABLE "marketing_request_lines" ADD CONSTRAINT "marketing_request_lines_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "marketing_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketing_request_lines" ADD CONSTRAINT "marketing_request_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "marketing_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "marketing_request_events" ADD CONSTRAINT "marketing_request_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "marketing_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "marketing_request_attachments" ADD CONSTRAINT "marketing_request_attachments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "marketing_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
