import { NextResponse } from "next/server";
import { requireOpsUser, DOCS_ROLES } from "@/lib/ops/session";
import { deliveryReceiptFromOrder, deliveryReceiptsForDay, deliveryReceiptsForRoute } from "@/lib/bol/fromOrder";
import { renderPrintablePage } from "@/lib/bol/render";
import { db } from "@/lib/db";
import { ymdOfRoute } from "@/lib/routes";
import { archiveDocument } from "@/lib/documents/archive";
import type { DeliveryReceiptData } from "@/lib/bol/render";

/**
 * Printable delivery receipts.
 *
 * `?orderId=` renders one; `?routeId=` renders one route's stack in driving
 * order, which is the one the driver actually carries; `?day=YYYY-MM-DD[&region=]`
 * renders that day's whole print batch as one paginated document, which is what
 * the warehouse wants at 07:00 — one print job, one receipt per page.
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
  const routeId = url.searchParams.get("routeId");
  const day = url.searchParams.get("day");
  const region = url.searchParams.get("region") ?? undefined;

  if (orderId) {
    const doc = await deliveryReceiptFromOrder(orderId);
    if (!doc) return NextResponse.json({ error: "Order not found" }, { status: 404 });
    await saveReceipt(doc, orderId);
    return html(renderPrintablePage([doc], doc.bolNumber));
  }

  if (routeId) {
    const docs = await deliveryReceiptsForRoute(routeId);
    if (docs.length === 0) {
      return html(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Nothing to print</title></head><body style="font-family:Arial,sans-serif;padding:40px"><h1>That route has no stops.</h1><p>Add stops to the route and print again.</p></body></html>`,
      );
    }
    const route = await db.deliveryRoute.findUnique({
      where: { id: routeId },
      select: { region: true, name: true, date: true },
    });
    const title = route
      ? `${route.region}${route.name ? ` ${route.name}` : ""} route — ${ymdOfRoute(route.date)}`
      : `Route ${routeId}`;
    await Promise.all(docs.map(doc => saveReceipt(doc)));
    const body = renderPrintablePage(docs, title);
    await archiveDocument({ docNumber: `Route ${routeId}`, docType: "print_batch", html: body, payload: JSON.parse(JSON.stringify(docs)), summary: title });
    return html(body);
  }

  if (day) {
    const parsed = new Date(`${day}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
      return NextResponse.json({ error: "Bad day; expected YYYY-MM-DD" }, { status: 400 });
    }
    const docs = await deliveryReceiptsForDay(parsed, region);
    if (docs.length === 0) {
      return html(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Nothing to print</title></head><body style="font-family:Arial,sans-serif;padding:40px"><h1>Nothing scheduled for ${day}${region ? ` in ${escapeHtml(region)}` : ""}.</h1><p>Delivery receipts are generated from scheduled orders.</p></body></html>`,
      );
    }
    await Promise.all(docs.map(doc => saveReceipt(doc)));
    const body = renderPrintablePage(docs, `Delivery receipts ${day}`);
    await archiveDocument({ docNumber: `Day ${day}${region ? ` ${region}` : ""}`, docType: "print_batch", html: body, payload: JSON.parse(JSON.stringify(docs)), summary: `Delivery paperwork for ${day}${region ? ` · ${region}` : ""}` });
    return html(body);
  }

  return NextResponse.json({ error: "Pass ?orderId=, ?routeId= or ?day=YYYY-MM-DD" }, { status: 400 });
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

async function saveReceipt(doc: DeliveryReceiptData, orderId?: string) {
  const order = orderId ? await db.order.findUnique({ where: { id: orderId }, select: { id: true, accountId: true } }) :
    doc.invoiceNumber ? await db.order.findFirst({ where: { invoiceNumber: doc.invoiceNumber }, select: { id: true, accountId: true } }) : null;
  const number = doc.bolNumber.startsWith("(") ? `Draft BOL ${doc.invoiceNumber ?? order?.id ?? "unassigned"}` : doc.bolNumber;
  await archiveDocument({ docNumber: number, docType: "delivery_receipt", html: renderPrintablePage([doc], doc.bolNumber), payload: JSON.parse(JSON.stringify(doc)), summary: doc.toAccount.BusinessName ?? number, accountId: order?.accountId, orderId: order?.id });
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[c]!)); }
