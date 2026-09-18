/**
 * Build document data from real order/shipment records.
 *
 * This is the seam that removes the two-numbering-schemes problem (§1.3): the
 * same renderer produces both the paperwork-only receipt and the real one, and
 * the only difference is where the number came from — a `DR-<yymmdd>-####`
 * document number for paperwork, or the shipment's real
 * `BOL-<Location>-<yymmdd>-<seq>` once it is attached to actual stock movement.
 */

import { db } from "@/lib/db";
import type { DeliveryReceiptData, DocLine } from "./render";
import { pacificDayRange } from "@/lib/scheduling";

const PT_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "long",
  day: "numeric",
});

export async function deliveryReceiptFromOrder(orderId: string): Promise<DeliveryReceiptData | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      account: true,
      shipment: true,
      salesRep: { select: { name: true } },
      contact: { select: { name: true, phoneE164: true } },
      lines: { orderBy: { lineIndex: "asc" }, include: { product: true } },
    },
  });
  if (!order) return null;

  const lines: DocLine[] = order.lines.map((l) => ({
    sku: l.product.skuCode,
    description: `${l.product.productName} ${l.product.formatDetail}`.trim(),
    package: l.product.packageType ?? l.product.formatLabel,
    qty: l.qty,
    lot: l.lotNumber,
    weightPerUnit: l.product.weightPerUnit ? Number(l.product.weightPerUnit) : null,
    isKeg: l.product.isKeg,
  }));

  return {
    docType: "delivery",
    // A scheduled order that has not been dispatched yet has no BOL number, and
    // saying so is better than printing a placeholder that looks like a real
    // number. Once the route is dispatched this is the real one, and it is the
    // same number the ledger will carry after delivery.
    bolNumber: order.shipment?.bolNumber ?? "(minted at dispatch)",
    invoiceNumber: order.invoiceNumber,
    date: PT_DATE.format(order.deliveredAt ?? order.scheduledFor ?? order.createdAt),
    toAccount: {
      BusinessName: order.account.businessName,
      LegalName: order.account.legalEntity,
      DeliveryAddress: order.account.deliveryAddress ?? order.account.address,
      Phone: order.contact?.phoneE164 ?? null,
      LicenseNumber: order.account.licenseNumber,
      PaymentMethod: order.account.paymentMethod,
      Terms: order.account.terms,
    },
    deliveryWindow: order.account.deliveryWindow,
    receivingInstructions: order.account.deliveryInstructions,
    actor: order.salesRep?.name ?? null,
    refNote: order.shipment?.referenceNote ?? null,
    notes: order.notes,
    lines,
  };
}

/** Every delivery receipt for one route day, for the print batch (§8.5). */
export async function deliveryReceiptsForDay(day: Date, region?: string): Promise<DeliveryReceiptData[]> {
  const { start, end } = pacificDayRange(day.toISOString().slice(0, 10));

  const orders = await db.order.findMany({
    where: {
      scheduledFor: { gte: start, lt: end },
      status: { notIn: ["cancelled", "rejected", "expired"] },
      ...(region ? { account: { region } } : {}),
    },
    select: { id: true },
    orderBy: { scheduledFor: "asc" },
  });

  const docs: DeliveryReceiptData[] = [];
  for (const o of orders) {
    const doc = await deliveryReceiptFromOrder(o.id);
    if (doc) docs.push(doc);
  }
  return docs;
}

/**
 * Every delivery receipt for one route, in the order the driver will drive it.
 *
 * Stop order matters more than it looks: the driver works from a stapled stack
 * front to back, and paperwork sorted by anything else means hunting for the
 * right sheet at every door.
 */
export async function deliveryReceiptsForRoute(routeId: string): Promise<DeliveryReceiptData[]> {
  const stops = await db.routeStop.findMany({
    where: { routeId },
    orderBy: { sequence: "asc" },
    select: { orderId: true },
  });

  const docs: DeliveryReceiptData[] = [];
  for (const stop of stops) {
    if (!stop.orderId) continue;
    const doc = await deliveryReceiptFromOrder(stop.orderId);
    if (doc) docs.push(doc);
  }
  return docs;
}
