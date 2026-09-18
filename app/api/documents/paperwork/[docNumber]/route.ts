import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { DOCS_ROLES, requireOpsUser } from "@/lib/ops/session";
import { renderPrintablePage, type DocumentData } from "@/lib/bol/render";
import { renderInvoicePage, type InvoiceDocData } from "@/lib/billing/renderInvoice";
import { archiveDocument } from "@/lib/documents/archive";

/**
 * Print a saved paperwork-only document.
 *
 * Renders from the stored payload, not from current account data: the document
 * is evidence of what was handed over on the day, so reprinting it must not
 * silently pick up an address change made since.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ docNumber: string }> },
): Promise<Response> {
  await requireOpsUser(DOCS_ROLES);
  const { docNumber } = await params;
  const saved = await db.archivedDocument.findFirst({ where: { docNumber }, orderBy: { createdAt: "desc" } });
  if (saved) return new Response(saved.renderedHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } });

  const log = await db.documentLog.findUnique({ where: { docNumber } });
  if (!log) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  // Invoices are the same kind of record -- a saved payload, reprinted as it
  // was issued -- but a different document, so they get their own renderer.
  if (log.docType === "invoice") {
    const invoice = log.payloadJson as unknown as InvoiceDocData;
    await archiveDocument({ docNumber, docType: log.docType, html: renderInvoicePage([invoice], docNumber), payload: log.payloadJson as never, summary: log.summary });
    return new Response(renderInvoicePage([invoice], log.docNumber), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const doc = log.payloadJson as unknown as DocumentData;
  await archiveDocument({ docNumber, docType: log.docType, html: renderPrintablePage([doc], docNumber), payload: log.payloadJson as never, summary: log.summary });
  return new Response(renderPrintablePage([doc], log.docNumber), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
