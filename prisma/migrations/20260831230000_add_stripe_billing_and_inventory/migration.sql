-- CreateEnum
CREATE TYPE "InventorySource" AS ENUM ('leopard_mark_warehouse', 'familiar_ventures_consignment', 'vip_datastage');

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "stripe_customer_id" TEXT,
ADD COLUMN     "stripe_default_payment_method" TEXT,
ADD COLUMN     "stripe_setup_link_sent_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "stripe_invoice_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "collection_method" TEXT NOT NULL,
    "amount_due" DECIMAL(10,2) NOT NULL,
    "amount_paid" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "due_date" TIMESTAMP(3),
    "hosted_invoice_url" TEXT,
    "sent_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_snapshots" (
    "id" TEXT NOT NULL,
    "source" "InventorySource" NOT NULL,
    "snapshot_date" TIMESTAMP(3) NOT NULL,
    "sku_code" TEXT,
    "raw_product_code" TEXT NOT NULL,
    "location" TEXT,
    "lot_ref" TEXT,
    "on_hand" DECIMAL(10,2),
    "on_order" DECIMAL(10,2),
    "on_hold" DECIMAL(10,2),
    "available" DECIMAL(10,2),
    "in_transit" DECIMAL(10,2),
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brewery_movement_events" (
    "id" TEXT NOT NULL,
    "event_date" TIMESTAMP(3) NOT NULL,
    "event" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "destination" TEXT,
    "package_unit" TEXT,
    "qty" DECIMAL(12,4),
    "barrels" DECIMAL(12,4),
    "reports_under" TEXT,
    "state_code" TEXT,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brewery_movement_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoices_order_id_key" ON "invoices"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_stripe_invoice_id_key" ON "invoices"("stripe_invoice_id");

-- CreateIndex
CREATE INDEX "invoices_account_id_status_idx" ON "invoices"("account_id", "status");

-- CreateIndex
CREATE INDEX "inventory_snapshots_source_snapshot_date_idx" ON "inventory_snapshots"("source", "snapshot_date");

-- CreateIndex
CREATE INDEX "brewery_movement_events_location_event_date_idx" ON "brewery_movement_events"("location", "event_date");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_stripe_customer_id_key" ON "accounts"("stripe_customer_id");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

