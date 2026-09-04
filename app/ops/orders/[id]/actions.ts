"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { assertLocation, assertRole, ADMIN_ROLES, LEDGER_ROLES } from "@/lib/ops/session";
import { markDelivered } from "@/lib/delivery";
import { scheduleOrder } from "@/lib/scheduling";
import { blockOrder, unblockOrder, appendOrderEvent } from "@/lib/orderEvents";
import { enqueue } from "@/lib/jobs/queue";
import { isBlockedReason } from "@/lib/pipeline";
import { kickJobs } from "@/lib/jobs/kick";

/**
 * Order actions. Every one of these re-checks the role server-side — the proxy
 * gate is a convenience, this is the boundary — and every one appends an
 * OrderEvent, because §8.3 says so and because an action nobody can attribute
 * is indistinguishable from a bug.
 */

export async function scheduleOrderAction(formData: FormData): Promise<void> {
  const user = await assertRole(LEDGER_ROLES);
  const orderId = String(formData.get("orderId"));
  const dateRaw = String(formData.get("scheduledFor") ?? "");
  const warehouseId = String(formData.get("warehouseId") ?? "");
  const carrierName = String(formData.get("carrierName") ?? "") || null;
  const reschedule = formData.get("reschedule") === "1";

  if (!dateRaw) throw new Error("Pick a delivery date");
  if (!warehouseId) throw new Error("Pick a warehouse");
  await assertLocation(user, warehouseId);

  await scheduleOrder({
    orderId,
    scheduledFor: new Date(dateRaw),
    warehouseId,
    carrierName,
    actor: "ops",
    byUserId: user.id,
    reschedule,
  });
  // Drain now rather than waiting for the daily cron (see lib/jobs/kick.ts).
  kickJobs();

  revalidatePath(`/ops/orders/${orderId}`);
  revalidatePath("/ops");
}

export async function markDeliveredAction(formData: FormData): Promise<void> {
  const user = await assertRole(LEDGER_ROLES);
  const orderId = String(formData.get("orderId"));

  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { inventorySource: true, shipment: { select: { fromLocationId: true } } },
  });
  const from = order.shipment?.fromLocationId ?? order.inventorySource;
  if (from) await assertLocation(user, from);

  // Lot numbers and corrected quantities arrive as line[<id>][lot|qty].
  const lines: Array<{ orderLineId: string; lotNumber?: string | null; actualQty?: number }> = [];
  const empties: Record<string, number> = {};
  for (const [key, value] of formData.entries()) {
    const lot = /^lot\[(.+)\]$/.exec(key);
    if (lot && String(value).trim()) {
      lines.push({ orderLineId: lot[1], lotNumber: String(value).trim() });
    }
    const qty = /^qty\[(.+)\]$/.exec(key);
    if (qty && String(value).trim()) {
      const n = Number.parseInt(String(value), 10);
      if (Number.isFinite(n) && n >= 0) {
        const existing = lines.find((l) => l.orderLineId === qty[1]);
        if (existing) existing.actualQty = n;
        else lines.push({ orderLineId: qty[1], actualQty: n });
      }
    }
    const empty = /^empty\[(.+)\]$/.exec(key);
    if (empty && String(value).trim()) {
      const n = Number.parseInt(String(value), 10);
      if (Number.isFinite(n) && n > 0) empties[empty[1]] = n;
    }
  }

  await markDelivered({
    orderId,
    deliveredByUserId: user.id,
    actor: user.role === "warehouse" ? "ops" : "ops",
    lines,
    emptiesByProductId: empties,
    carrierName: String(formData.get("carrierName") ?? "") || null,
    notes: String(formData.get("notes") ?? "") || null,
  });

  // Drain now rather than waiting for the daily cron (see lib/jobs/kick.ts).
  kickJobs();

  revalidatePath(`/ops/orders/${orderId}`);
  revalidatePath("/ops");
  revalidatePath("/ops/inventory");
}

export async function issueInvoiceNowAction(formData: FormData): Promise<void> {
  const user = await assertRole(LEDGER_ROLES);
  const orderId = String(formData.get("orderId"));

  // Goes through the queue rather than calling Stripe inline, so a manual
  // "Issue invoice now" click shares the same idempotency key, the same retry
  // ladder and the same run log as the automatic path. Two code paths to
  // Stripe would be two chances to double-bill.
  await enqueue("issue_invoice", orderId, { orderId, manual: true, byUserId: user.id }, { orderId });
  await appendOrderEvent({
    orderId,
    eventType: "invoice.issued",
    actor: "ops",
    payload: { requestedBy: user.id, manual: true },
  });
  // Drain now rather than waiting for the daily cron (see lib/jobs/kick.ts).
  kickJobs();

  revalidatePath(`/ops/orders/${orderId}`);
}

export async function blockOrderAction(formData: FormData): Promise<void> {
  const user = await assertRole(LEDGER_ROLES);
  const orderId = String(formData.get("orderId"));
  const reason = String(formData.get("reason") ?? "");
  if (!isBlockedReason(reason)) throw new Error(`Unknown block reason: ${reason}`);

  await blockOrder(orderId, reason, "ops", user.id, { note: String(formData.get("note") ?? "") || null });
  revalidatePath(`/ops/orders/${orderId}`);
  revalidatePath("/ops");
}

export async function unblockOrderAction(formData: FormData): Promise<void> {
  // Clearing a compliance block is a decision with regulatory weight (§1.3),
  // so it is admin-only and always logged. Never automatic (§3).
  const orderId = String(formData.get("orderId"));
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { blockedReason: true },
  });
  const compliance = order.blockedReason === "license_expired" || order.blockedReason === "credit_hold";
  const user = await assertRole(compliance ? ADMIN_ROLES : LEDGER_ROLES);

  await unblockOrder(orderId, "ops", user.id, String(formData.get("note") ?? "") || undefined);
  revalidatePath(`/ops/orders/${orderId}`);
  revalidatePath("/ops");
}

export async function cancelOrderAction(formData: FormData): Promise<void> {
  const user = await assertRole(LEDGER_ROLES);
  const orderId = String(formData.get("orderId"));

  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { deliveredAt: true, invoice: { select: { id: true } } },
  });
  // §8.3: cancel before ⑤ only. After delivery the stock has moved and the
  // ledger says so; the remedy is a credit note, not a cancellation.
  if (order.deliveredAt || order.invoice) {
    throw new Error("This order has been delivered. Issue a credit rather than cancelling.");
  }

  await db.order.update({ where: { id: orderId }, data: { status: "cancelled" } });
  await appendOrderEvent({
    orderId,
    eventType: "order.cancelled",
    actor: "ops",
    payload: { byUserId: user.id, reason: String(formData.get("note") ?? "") || null },
  });
  revalidatePath(`/ops/orders/${orderId}`);
  revalidatePath("/ops");
}
