import { NextResponse } from "next/server";
import { requireOpsUser, DOCS_ROLES } from "@/lib/ops/session";
import { deliveryReceiptFromOrder, deliveryReceiptsForDay } from "@/lib/bol/fromOrder";
import { renderPrintablePage } from "@/lib/bol/render";

/**
 * Printable delivery receipts.
 *
 * `?orderId=` renders one; `?day=YYYY-MM-DD[&region=]` renders that day's whole
 * print batch as one paginated document, which is what the warehouse actually
 * wants at 07:00 — one print job, one receipt per page.
 *
 * Returns HTML rather than a PDF: the browser's own print dialog produces the
 * PDF, the @page rules in the renderer control the pagination, and adding a
 * headless-Chrome PDF pipeline to a Vercel function to achieve the same output
 * would be a large dependency for no gain.
 */
export async function GET(request: Request): Promise<Response> {
  // Printing paperwork is exactly what docs_only exists for.
  await requireOpsUser(DOCS_ROLES);

  const url = new URL(request.url);
  const orderId = url.searchParams.get("orderId");
  const day = url.searchParams.get("day");
  const region = url.searchParams.get("region") ?? undefined;

  if (orderId) {
    const doc = await deliveryReceiptFromOrder(orderId);
    if (!doc) return NextResponse.json({ error: "Order not found" }, { status: 404 });
    return html(renderPrintablePage([doc], doc.bolNumber));
  }

  if (day) {
    const parsed = new Date(`${day}T12:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "Bad day; expected YYYY-MM-DD" }, { status: 400 });
    }
    const docs = await deliveryReceiptsForDay(parsed, region);
    if (docs.length === 0) {
      return html(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Nothing to print</title></head><body style="font-family:Arial,sans-serif;padding:40px"><h1>Nothing scheduled for ${day}${region ? ` in ${region}` : ""}.</h1><p>Delivery receipts are generated from scheduled orders.</p></body></html>`,
      );
    }
    return html(renderPrintablePage(docs, `Delivery receipts ${day}`));
  }

  return NextResponse.json({ error: "Pass ?orderId= or ?day=YYYY-MM-DD" }, { status: 400 });
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Never cached: a receipt reflects the order as it is right now, and a
      // stale one printed at the dock is worse than a slow one.
      "cache-control": "no-store",
    },
  });
}
