-- CreateEnum
CREATE TYPE "RepRole" AS ENUM ('rep', 'admin');

-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('active', 'expired', 'suspended', 'unknown');

-- CreateEnum
CREATE TYPE "MessagingChannel" AS ENUM ('sms');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('opted_in', 'opted_out');

-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('portal', 'sms', 'rep_app');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('draft', 'pending_confirmation', 'confirmed', 'scheduled', 'fulfilled', 'cancelled', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "OrderEventActor" AS ENUM ('customer', 'ai', 'rep', 'ops', 'system');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('db_to_sheet', 'sheet_to_db');

-- CreateTable
CREATE TABLE "reps" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pin_hash" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "role" "RepRole" NOT NULL DEFAULT 'rep',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "business_name" TEXT NOT NULL,
    "legal_entity" TEXT,
    "license_number" TEXT,
    "license_state" TEXT,
    "license_status" "LicenseStatus" NOT NULL DEFAULT 'unknown',
    "license_expiry" TIMESTAMP(3),
    "sales_rep_id" TEXT,
    "region" TEXT,
    "address" TEXT,
    "delivery_address" TEXT,
    "delivery_instructions" TEXT,
    "delivery_window" TEXT,
    "payment_method" TEXT,
    "terms" TEXT,
    "credit_hold" BOOLEAN NOT NULL DEFAULT false,
    "priority" TEXT,
    "imported_to_ekos" BOOLEAN NOT NULL DEFAULT false,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "sheet_row_ref" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone_e164" TEXT,
    "role" TEXT,
    "is_authorized_sender" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consents" (
    "id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "channel" "MessagingChannel" NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "terms_version" TEXT NOT NULL,
    "terms_text_snapshot" TEXT NOT NULL,
    "consented_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "source_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "sku_code" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "format_label" TEXT NOT NULL,
    "format_detail" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "list_price" DECIMAL(10,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_pricing" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "account_pricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "contact_id" TEXT,
    "channel" "OrderChannel" NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'draft',
    "submitted_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "scheduled_for" TIMESTAMP(3),
    "sales_rep_id" TEXT,
    "notes" TEXT,
    "sheet_synced_at" TIMESTAMP(3),
    "invoice_number" TEXT,
    "delivery_date" TIMESTAMP(3),
    "bol_number" TEXT,
    "invoice_status" TEXT,
    "payment_method" TEXT,
    "ach_ref" TEXT,
    "inventory_source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_lines" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "line_total" DECIMAL(10,2) NOT NULL,
    "lot_number" TEXT,
    "line_index" INTEGER NOT NULL,

    CONSTRAINT "order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "account_id" TEXT,
    "contact_id" TEXT,
    "direction" "MessageDirection" NOT NULL,
    "channel" "MessagingChannel" NOT NULL,
    "from_number" TEXT NOT NULL,
    "to_number" TEXT NOT NULL,
    "body_raw" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_interpretations" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "order_id" TEXT,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "parsed_json" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "needs_human_review" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_interpretations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_events" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "actor" "OrderEventActor" NOT NULL,
    "payload_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "states" (
    "code" TEXT NOT NULL,
    "self_distribution_cap" TEXT,
    "requires_license_verification" BOOLEAN NOT NULL DEFAULT true,
    "record_retention_years" INTEGER,
    "notes" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "states_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "sync_log" (
    "id" TEXT NOT NULL,
    "direction" "SyncDirection" NOT NULL,
    "order_id" TEXT NOT NULL,
    "row_ref" TEXT,
    "fields_changed" JSONB,
    "status" TEXT NOT NULL DEFAULT 'success',
    "conflict" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reps_name_key" ON "reps"("name");

-- CreateIndex
CREATE INDEX "accounts_sales_rep_id_idx" ON "accounts"("sales_rep_id");

-- CreateIndex
CREATE INDEX "contacts_phone_e164_idx" ON "contacts"("phone_e164");

-- CreateIndex
CREATE INDEX "consents_phone_e164_channel_idx" ON "consents"("phone_e164", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_code_key" ON "products"("sku_code");

-- CreateIndex
CREATE UNIQUE INDEX "account_pricing_account_id_product_id_key" ON "account_pricing"("account_id", "product_id");

-- CreateIndex
CREATE INDEX "orders_account_id_status_idx" ON "orders"("account_id", "status");

-- CreateIndex
CREATE INDEX "orders_invoice_number_idx" ON "orders"("invoice_number");

-- CreateIndex
CREATE UNIQUE INDEX "order_lines_order_id_line_index_key" ON "order_lines"("order_id", "line_index");

-- CreateIndex
CREATE INDEX "messages_from_number_created_at_idx" ON "messages"("from_number", "created_at");

-- CreateIndex
CREATE INDEX "ai_interpretations_order_id_idx" ON "ai_interpretations"("order_id");

-- CreateIndex
CREATE INDEX "order_events_order_id_created_at_idx" ON "order_events"("order_id", "created_at");

-- CreateIndex
CREATE INDEX "sync_log_order_id_direction_idx" ON "sync_log"("order_id", "direction");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_sales_rep_id_fkey" FOREIGN KEY ("sales_rep_id") REFERENCES "reps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consents" ADD CONSTRAINT "consents_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_pricing" ADD CONSTRAINT "account_pricing_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_pricing" ADD CONSTRAINT "account_pricing_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_sales_rep_id_fkey" FOREIGN KEY ("sales_rep_id") REFERENCES "reps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interpretations" ADD CONSTRAINT "ai_interpretations_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interpretations" ADD CONSTRAINT "ai_interpretations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_log" ADD CONSTRAINT "sync_log_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
