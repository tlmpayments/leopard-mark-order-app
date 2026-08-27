-- Phase 2 (Sheet <-> Postgres sync): narrow the idempotency guard added in
-- 20260827203000_sync_log_idempotency to the db_to_sheet direction only.
--
-- The original index -- UNIQUE (order_id, direction) WHERE status = 'success'
-- -- caps every (order_id, direction) pair at ONE successful sync_log row
-- EVER. That's the right guard for db_to_sheet: lib/sheetSync.ts's
-- syncOrderToSheet is a one-time "append this order's row(s) into the Sheet"
-- operation per order -- a retried call for the same order should be
-- detected as a replay, not logged as a second success.
--
-- It's the wrong guard for sheet_to_db: app/api/sheet-sync/webhook/route.ts
-- legitimately writes a new successful sheet_to_db sync_log row every time
-- ops edits a Sheet-owned column (Invoice Status, then later BOL #, then
-- Lot #, ...) and again on every hourly reconciliation pass, for every
-- Order-ID'd row -- many successful sheet_to_db syncs per order over its
-- lifetime BY DESIGN, not a replay of the same operation. The unscoped
-- index made the second-ever successful sheet_to_db sync for any order
-- throw a unique constraint violation (verified empirically while building
-- the webhook: `Unique constraint failed on the constraint:
-- sync_log_order_id_direction_success_idx`) -- i.e. it broke on the very
-- first onEdit or reconcile pass after an order's first ops edit had
-- already synced back successfully once.
DROP INDEX "sync_log_order_id_direction_success_idx";

CREATE UNIQUE INDEX "sync_log_db_to_sheet_success_idx" ON "sync_log" ("order_id") WHERE "status" = 'success' AND "direction" = 'db_to_sheet';
