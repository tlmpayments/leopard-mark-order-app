-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('admin', 'ops', 'warehouse', 'rep', 'docs_only');

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('brewery', 'warehouse');

-- CreateEnum
CREATE TYPE "InventoryEventType" AS ENUM ('BREW', 'INCOMING', 'TRANSFER', 'DELIVERY', 'RETURN', 'SAMPLE', 'DESTRUCTION', 'LOSS', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('planned', 'in_transit', 'delivered', 'cancelled');

-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('delivery_receipt', 'straight_bol');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'dead');

-- AlterTable (hand-written: Prisma's generated diff wanted to DROP and re-add
-- reps.role, which would silently reset every existing admin to 'rep'. RepRole's
-- two values are a strict subset of UserRole's five, so the column is retyped in
-- place with a USING cast and the data survives.)
ALTER TABLE "reps" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "reps"
  ALTER COLUMN "role" TYPE "UserRole" USING ("role"::text::"UserRole");
ALTER TABLE "reps" ALTER COLUMN "role" SET DEFAULT 'rep';

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "billing_contact_email" TEXT,
ADD COLUMN     "first_order_at" TIMESTAMP(3),
ADD COLUMN     "tax_exempt" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "brand_code" TEXT,
ADD COLUMN     "deposit_amount" DECIMAL(10,2),
ADD COLUMN     "is_keg" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "package_type" TEXT,
ADD COLUMN     "reorder_threshold" INTEGER,
ADD COLUMN     "upc" TEXT,
ADD COLUMN     "weight_per_unit" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "blocked_at" TIMESTAMP(3),
ADD COLUMN     "blocked_by_user_id" TEXT,
ADD COLUMN     "blocked_reason" TEXT,
ADD COLUMN     "delivered_at" TIMESTAMP(3),
ADD COLUMN     "expected_empty_kegs" INTEGER,
ADD COLUMN     "tap_handle_requested" BOOLEAN;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "deposit_amount" DECIMAL(10,2),
ADD COLUMN     "deposit_credit_amount" DECIMAL(10,2),
ADD COLUMN     "invoice_number" TEXT,
ADD COLUMN     "pdf_url" TEXT;

-- DropEnum (nothing references it once reps.role is retyped above)
DROP TYPE IF EXISTS "RepRole";

-- CreateTable
CREATE TABLE "user_locations" (
    "user_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_locations_pkey" PRIMARY KEY ("user_id","location_id")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "LocationType" NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "address" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "inbound_instructions" TEXT,
    "outbound_instructions" TEXT,
    "shipping_hours" TEXT,
    "shipping_contact" TEXT,
    "has_loading_dock" BOOLEAN NOT NULL DEFAULT false,
    "liftgate_required" BOOLEAN NOT NULL DEFAULT false,
    "sheet_row_ref" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route_schedules" (
    "id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "warehouse_id" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "cutoff_hour" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "region_slack_channels" (
    "region" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'orders',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "region_slack_channels_pkey" PRIMARY KEY ("region")
);

-- CreateTable
CREATE TABLE "commodities" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nmfc_number" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commodities_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "inventory_events" (
    "id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "type" "InventoryEventType" NOT NULL,
    "product_id" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "from_location_id" TEXT,
    "to_location_id" TEXT,
    "account_id" TEXT,
    "order_line_id" TEXT,
    "shipment_id" TEXT,
    "lot_number" TEXT,
    "actor_user_id" TEXT,
    "ref_note" TEXT,
    "notes" TEXT,
    "correction_of_id" TEXT,
    "import_ref" TEXT,
    "sheet_row_ref" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipments" (
    "id" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'planned',
    "type" "InventoryEventType" NOT NULL,
    "from_location_id" TEXT,
    "to_location_id" TEXT,
    "account_id" TEXT,
    "order_id" TEXT,
    "scheduled_for" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "delivered_by_user_id" TEXT,
    "bol_number" TEXT,
    "doc_type" "DocType" NOT NULL DEFAULT 'delivery_receipt',
    "carrier_name" TEXT,
    "carrier_phone" TEXT,
    "handling_units" INTEGER,
    "handling_unit_type" TEXT,
    "weight_lbs" DECIMAL(10,2),
    "dimensions" TEXT,
    "freight_class" TEXT,
    "commodity_code" TEXT,
    "prepared_by" TEXT,
    "reference_note" TEXT,
    "notes" TEXT,
    "rendered_html" TEXT,
    "empties_picked_up" INTEGER,
    "sheet_row_ref" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bol_sequences" (
    "location_id" TEXT NOT NULL,
    "yymmdd" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "bol_sequences_pkey" PRIMARY KEY ("location_id","yymmdd")
);

-- CreateTable
CREATE TABLE "document_logs" (
    "doc_number" TEXT NOT NULL,
    "doc_type" "DocType" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "created_by_user_id" TEXT,
    "shipment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_logs_pkey" PRIMARY KEY ("doc_number")
);

-- CreateTable
CREATE TABLE "keg_custody_entries" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "shipment_id" TEXT,
    "invoice_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "keg_custody_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "payload_json" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "run_after" TIMESTAMP(3) NOT NULL,
    "last_error" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "order_id" TEXT,
    "account_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_rules" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "config_json" JSONB,
    "updated_by_user_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_rules_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "locations_type_active_idx" ON "locations"("type", "active");

-- CreateIndex
CREATE INDEX "route_schedules_region_active_idx" ON "route_schedules"("region", "active");

-- CreateIndex
CREATE UNIQUE INDEX "route_schedules_region_warehouse_id_weekday_key" ON "route_schedules"("region", "warehouse_id", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_events_import_ref_key" ON "inventory_events"("import_ref");

-- CreateIndex
CREATE INDEX "inventory_events_product_id_from_location_id_idx" ON "inventory_events"("product_id", "from_location_id");

-- CreateIndex
CREATE INDEX "inventory_events_product_id_to_location_id_idx" ON "inventory_events"("product_id", "to_location_id");

-- CreateIndex
CREATE INDEX "inventory_events_shipment_id_idx" ON "inventory_events"("shipment_id");

-- CreateIndex
CREATE INDEX "inventory_events_account_id_occurred_at_idx" ON "inventory_events"("account_id", "occurred_at");

-- CreateIndex
CREATE INDEX "inventory_events_type_occurred_at_idx" ON "inventory_events"("type", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_order_id_key" ON "shipments"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_bol_number_key" ON "shipments"("bol_number");

-- CreateIndex
CREATE INDEX "shipments_status_scheduled_for_idx" ON "shipments"("status", "scheduled_for");

-- CreateIndex
CREATE INDEX "shipments_account_id_delivered_at_idx" ON "shipments"("account_id", "delivered_at");

-- CreateIndex
CREATE INDEX "document_logs_doc_type_date_idx" ON "document_logs"("doc_type", "date");

-- CreateIndex
CREATE INDEX "keg_custody_entries_account_id_occurred_at_idx" ON "keg_custody_entries"("account_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_runs_idempotency_key_key" ON "job_runs"("idempotency_key");

-- CreateIndex
CREATE INDEX "job_runs_status_run_after_idx" ON "job_runs"("status", "run_after");

-- CreateIndex
CREATE INDEX "job_runs_kind_created_at_idx" ON "job_runs"("kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoice_number_key" ON "invoices"("invoice_number");

-- AddForeignKey
ALTER TABLE "user_locations" ADD CONSTRAINT "user_locations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "reps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_locations" ADD CONSTRAINT "user_locations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route_schedules" ADD CONSTRAINT "route_schedules_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_commodity_code_fkey" FOREIGN KEY ("commodity_code") REFERENCES "commodities"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_logs" ADD CONSTRAINT "document_logs_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keg_custody_entries" ADD CONSTRAINT "keg_custody_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keg_custody_entries" ADD CONSTRAINT "keg_custody_entries_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "keg_custody_entries" ADD CONSTRAINT "keg_custody_entries_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- stock_by_location: nets the append-only ledger into on-hand quantities.
--
-- A view, not a materialized view or a counter column, because the ledger is
-- the system of record and a cached total is a second source of truth (§13).
-- The netting signs mirror lib/inventory.ts INVENTORY_DIRECTION exactly, and
-- both mirror the Inventory app's computeStock() so the migration can prove
-- parity SKU by SKU before the old dashboard is retired.
--
--   BREW, INCOMING                        -> +qty at to_location
--   DELIVERY, SAMPLE, DESTRUCTION, LOSS   -> -qty at from_location
--   TRANSFER, RETURN, ADJUSTMENT          -> -qty at from, +qty at to
--
-- Rows with a NULL location on the relevant side are skipped, which is how an
-- external source or sink (a contract brewery, a dumped keg) stays untracked
-- rather than accruing against a phantom location.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW "stock_by_location" AS
WITH movements AS (
    -- credits: stock arriving at to_location
    SELECT "product_id", "to_location_id" AS "location_id", "qty"::bigint AS "delta"
    FROM "inventory_events"
    WHERE "to_location_id" IS NOT NULL
      AND "type" IN ('BREW', 'INCOMING', 'TRANSFER', 'RETURN', 'ADJUSTMENT')
  UNION ALL
    -- debits: stock leaving from_location
    SELECT "product_id", "from_location_id" AS "location_id", -("qty"::bigint) AS "delta"
    FROM "inventory_events"
    WHERE "from_location_id" IS NOT NULL
      AND "type" IN ('DELIVERY', 'SAMPLE', 'DESTRUCTION', 'LOSS', 'TRANSFER', 'RETURN', 'ADJUSTMENT')
)
SELECT "product_id",
       "location_id",
       SUM("delta") AS "on_hand"
FROM movements
GROUP BY "product_id", "location_id";

-- ---------------------------------------------------------------------------
-- available_for_delivery: warehouses only, net of units already promised to
-- scheduled-but-undelivered orders. Warehouse-only is a business rule, not a
-- filter for tidiness: stock at a contract brewery is not in our custody yet.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW "available_for_delivery" AS
WITH reserved AS (
    SELECT ol."product_id",
           o."inventory_source" AS "location_id",
           SUM(ol."qty")::bigint AS "qty"
    FROM "orders" o
    JOIN "order_lines" ol ON ol."order_id" = o."id"
    WHERE o."scheduled_for" IS NOT NULL
      AND o."delivered_at" IS NULL
      AND o."status" NOT IN ('cancelled', 'rejected', 'expired')
      AND o."inventory_source" IS NOT NULL
    GROUP BY ol."product_id", o."inventory_source"
)
SELECT s."product_id",
       s."location_id",
       s."on_hand",
       COALESCE(r."qty", 0) AS "reserved",
       s."on_hand" - COALESCE(r."qty", 0) AS "available"
FROM "stock_by_location" s
JOIN "locations" l ON l."id" = s."location_id"
LEFT JOIN reserved r ON r."product_id" = s."product_id" AND r."location_id" = s."location_id"
WHERE l."type" = 'warehouse';
