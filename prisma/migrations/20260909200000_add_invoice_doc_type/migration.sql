-- The BOL Maker gains an invoice maker (app/docs/invoice), and its output is
-- stored in `document_logs` alongside the delivery receipts it already prints.
-- Additive only: no existing row changes, and nothing reads the new value until
-- the invoice maker writes one.
ALTER TYPE "DocType" ADD VALUE 'invoice';
