-- Phase 2 (Sheet <-> Postgres sync): two fixes from adversarial review.
--
-- 1. order_lines.sheet_row_number -- lets the Sheet->DB webhook target
--    Lot # at the ONE line a Sheet row represents instead of applying one
--    row's value to every line of an order (a real correctness gap: lot
--    numbers are a per-line traceability field, unlike BOL #).
--
-- 2. orders.invoice_number becomes UNIQUE (dropping the old plain index
--    first) -- a plain Postgres UNIQUE constraint on a nullable column
--    already permits multiple NULLs while enforcing uniqueness among
--    non-null values, so no partial index is needed. Closes a gap the
--    webhook's invoiceNumber fallback lookup depended on being true but
--    nothing previously enforced: two orders sharing an invoice number
--    would have made that fallback resolve non-deterministically.
ALTER TABLE "order_lines" ADD COLUMN "sheet_row_number" INTEGER;

DROP INDEX "orders_invoice_number_idx";
ALTER TABLE "orders" ADD CONSTRAINT "orders_invoice_number_key" UNIQUE ("invoice_number");
