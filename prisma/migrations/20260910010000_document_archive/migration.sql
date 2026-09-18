CREATE TABLE "archived_documents" (
  "id" TEXT NOT NULL,
  "doc_number" TEXT NOT NULL,
  "doc_type" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "rendered_html" TEXT NOT NULL,
  "payload_json" JSONB NOT NULL,
  "summary" TEXT NOT NULL,
  "account_id" TEXT,
  "order_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "archived_documents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "archived_documents_doc_number_sha256_key" ON "archived_documents"("doc_number", "sha256");
CREATE INDEX "archived_documents_order_id_idx" ON "archived_documents"("order_id");
CREATE INDEX "archived_documents_account_id_idx" ON "archived_documents"("account_id");
CREATE INDEX "archived_documents_created_at_idx" ON "archived_documents"("created_at");
