import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { DOCS_ROLES, requireOpsUser } from "@/lib/ops/session";
import { renderPrintablePage, type DocumentData } from "@/lib/bol/render";

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

  const log = await db.documentLog.findUnique({ where: { docNumber } });
  if (!log) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const doc = log.payloadJson as unknown as DocumentData;
  return new Response(renderPrintablePage([doc], log.docNumber), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
