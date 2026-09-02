/**
 * Job handlers — the side-effecting half of the queue.
 *
 * Kept in its own module so that `lib/jobs/queue.ts` (which the hub imports to
 * render the run log) never pulls Stripe, Slack and the Sheet into a page
 * render. Each handler is idempotent: the queue guarantees at-least-once, not
 * exactly-once, so a handler that cannot tolerate a second run is a bug.
 */

import { db } from "@/lib/db";
import { syncOrderToSheet } from "@/lib/sheetSync";
import { ensureStripeCustomer, sendPaymentSetupLink } from "@/lib/stripeCustomer";
import { issueInvoiceForOrder } from "@/lib/billing/issue";
import { checkAvailability, availableForDelivery, kegCustodyBalances } from "@/lib/inventory";
import { proposeSlot } from "@/lib/scheduling";
import { blockOrder, appendOrderEvent } from "@/lib/orderEvents";
import { isAutomationEnabled } from "@/lib/automations";
import { buildOrderMessage, channelForRegion, postMessage, replyInThread, THREAD_PROMPT } from "@/lib/slack";
import type { JobKind } from "./kinds";

export interface JobContext {
  jobId: string;
  attempts: number;
}

type Payload = Record<string, unknown>;
export type JobHandler = (payload: Payload, ctx: JobContext) => Promise<string>;

const str = (p: Payload, k: string): string => {
  const v = p[k];
  if (typeof v !== "string" || !v) throw new Error(`Job payload is missing "${k}"`);
  return v;
};

export const HANDLERS: Record<JobKind, JobHandler> = {
  // ---- ① Account setup ----
  ensure_stripe_customer: async (p) => {
    const accountId = str(p, "accountId");
    if (!(await isAutomationEnabled("auto_stripe_customer_on_account"))) return "skipped: rule off";
    const customerId = await ensureStripeCustomer(accountId);
    return `stripe customer ${customerId}`;
  },

  send_payment_setup_link: async (p) => {
    const accountId = str(p, "accountId");
    if (!(await isAutomationEnabled("auto_send_setup_link"))) return "skipped: rule off";

    const account = await db.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { stripeSetupLinkSentAt: true, stripeDefaultPaymentMethod: true },
    });
    if (account.stripeDefaultPaymentMethod) return "skipped: payment method already on file";
    // §6.4: never two setup links within 7 days. A customer receiving the same
    // link three times reads as a broken system, not a helpful one.
    if (
      account.stripeSetupLinkSentAt &&
      Date.now() - account.stripeSetupLinkSentAt.getTime() < 7 * 86_400_000
    ) {
      return "skipped: a link was sent within the last 7 days";
    }
    await sendPaymentSetupLink(accountId);
    return "setup link emailed";
  },

  // ---- ② New order ----
  sync_order_to_sheet: async (p) => {
    const orderId = str(p, "orderId");
    const result = await syncOrderToSheet(orderId);
    if (!result.ok) throw new Error(result.error ?? "Sheet sync failed");
    if (result.alreadySynced) return "already synced";
    await appendOrderEvent({
      orderId,
      eventType: "order.sheet_synced",
      actor: "system",
      payload: { slackChannel: result.slackChannel ?? null, slackTs: result.slackTs ?? null },
    });
    return "synced to Sales tab";
  },

  slack_new_order: async (p) => {
    const orderId = str(p, "orderId");
    if (!(await isAutomationEnabled("slack_new_order"))) return "skipped: rule off";

    const order = await db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        account: { select: { businessName: true, region: true, firstOrderAt: true } },
        salesRep: { select: { name: true } },
        lines: { include: { product: true }, orderBy: { lineIndex: "asc" } },
        events: { where: { eventType: "order.slack_posted" }, take: 1 },
      },
    });
    // Idempotent: the event log is the record of whether this already posted.
    if (order.events.length > 0) return "already posted";

    const channel = await channelForRegion(order.account.region);
    if (!channel) return "skipped: no channel mapped for this region";

    const text = buildOrderMessage({
      // §6.4 / first-order.test: exactly one FIRST ORDER per account. The flag
      // is the account's own firstOrderAt, so it cannot fire twice across
      // channels or across retries.
      isFirstOrder: order.account.firstOrderAt == null,
      repName: order.salesRep?.name ?? "Ops",
      businessName: order.account.businessName,
      lines: order.lines.map((l) => ({
        qty: l.qty,
        description: `${l.product.productName} ${l.product.formatLabel}`,
        lineTotal: Number(l.lineTotal),
      })),
      total: order.lines.reduce((s, l) => s + Number(l.lineTotal), 0),
      expectedEmptyKegs: order.expectedEmptyKegs,
      tapHandleRequested: order.tapHandleRequested,
    });

    const posted = await postMessage(channel, text);
    if (!posted.ok) throw new Error(`Slack post failed: ${posted.error}`);

    if (posted.channel && posted.ts) {
      await replyInThread(posted.channel, posted.ts, THREAD_PROMPT);
    }
    await appendOrderEvent({
      orderId,
      eventType: "order.slack_posted",
      actor: "system",
      payload: { channel: posted.channel ?? channel, ts: posted.ts ?? null },
    });
    // Stamp the account's first order exactly once, after a successful post.
    if (order.account.firstOrderAt == null) {
      await db.account.update({ where: { id: order.accountId }, data: { firstOrderAt: new Date() } });
    }
    return `posted to ${posted.channel ?? channel}`;
  },

  stock_check: async (p) => {
    const orderId = str(p, "orderId");
    if (!(await isAutomationEnabled("stock_check_on_confirm"))) return "skipped: rule off";

    const order = await db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { lines: { include: { product: { select: { skuCode: true } } } } },
    });
    if (!order.inventorySource) return "skipped: no inventory source set";

    const shorts = await checkAvailability(
      order.inventorySource,
      order.lines.map((l) => ({ productId: l.productId, qty: l.qty })),
    );

    await appendOrderEvent({
      orderId,
      eventType: "order.stock_checked",
      actor: "system",
      payload: { warehouse: order.inventorySource, shorts },
    });

    if (shorts.length > 0) {
      await blockOrder(orderId, "stock_short", "system", undefined, { shorts });
      return `blocked: short on ${shorts.map((s) => s.skuCode).join(", ")}`;
    }
    return "stock ok";
  },

  propose_delivery_slot: async (p) => {
    const orderId = str(p, "orderId");
    if (!(await isAutomationEnabled("auto_propose_slot"))) return "skipped: rule off";

    const order = await db.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { blockedReason: true, scheduledFor: true },
    });
    // Do not propose a slot for a blocked order: booking a truck for something
    // that cannot legally ship is worse than leaving it visible at ②.
    if (order.blockedReason) return "skipped: order is blocked";
    if (order.scheduledFor) return "skipped: already scheduled";

    const proposal = await proposeSlot(orderId);
    if (!proposal) return "no route day available for this region";
    return `proposed ${proposal.at.toISOString().slice(0, 10)} from ${proposal.warehouseId}`;
  },

  // ---- ⑤ / ⑥ ----
  issue_invoice: async (p) => {
    const orderId = str(p, "orderId");
    if (!p.manual && !(await isAutomationEnabled("auto_invoice_on_delivery"))) {
      return "skipped: rule off (issue manually from the hub)";
    }
    const result = await issueInvoiceForOrder(orderId);
    if (result.status === "blocked_missing_billing_email") {
      // Not an error: it is a correctly-identified missing fact, now visible in
      // the attention queue. Retrying on a backoff would not find an email.
      return "blocked: no billing email on file";
    }
    return `${result.status}${result.stripeInvoiceId ? ` ${result.stripeInvoiceId}` : ""}`;
  },

  write_delivery_to_sheet: async (p) => {
    const orderId = str(p, "orderId");
    // Delivery facts (Delivery Date, BOL #, Lot #, empties) become DB-owned
    // once this ships, so they are mirrored to the Sheet by re-running the same
    // sync the order used. A Sheet outage must never fail a warehouse action,
    // which is exactly why this is a job and not an inline write.
    const result = await syncOrderToSheet(orderId);
    if (!result.ok) throw new Error(result.error ?? "Sheet sync failed");
    return result.alreadySynced ? "row already present; delivery fields refreshed" : "mirrored to Sheet";
  },

  // ---- Periodic ----
  delivery_digest: async () => {
    if (!(await isAutomationEnabled("delivery_digest"))) return "skipped: rule off";
    const tomorrow = new Date(Date.now() + 86_400_000);
    const start = new Date(tomorrow);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86_400_000);

    const orders = await db.order.findMany({
      where: { scheduledFor: { gte: start, lt: end }, deliveredAt: null },
      include: {
        account: { select: { businessName: true, region: true } },
        lines: { include: { product: { select: { productName: true, formatLabel: true } } } },
      },
    });
    if (orders.length === 0) return "nothing scheduled for tomorrow";

    const byRegion = new Map<string, typeof orders>();
    for (const o of orders) {
      const r = o.account.region ?? "unassigned";
      byRegion.set(r, [...(byRegion.get(r) ?? []), o]);
    }

    let posted = 0;
    for (const [region, rows] of byRegion) {
      const channel = await channelForRegion(region);
      if (!channel) continue;
      const day = start.toISOString().slice(0, 10);
      const body = rows
        .map(
          (o) =>
            `• *${o.account.businessName}* — ${o.lines.reduce((s, l) => s + l.qty, 0)} units from ${o.inventorySource ?? "tbd"}`,
        )
        .join("\n");
      const link = `${process.env.APP_BASE_URL ?? "https://ops.tlmbg.co"}/api/documents/print?day=${day}&region=${region}`;
      const result = await postMessage(
        channel,
        `:truck: *Tomorrow's deliveries — ${region}* (${rows.length})\n${body}\n<${link}|Print the batch>`,
      );
      if (result.ok) posted += 1;
    }
    return `posted ${posted} region digest(s)`;
  },

  invoice_reminder: async () => {
    if (!(await isAutomationEnabled("invoice_reminder"))) return "skipped: rule off";
    const cutoff = new Date(Date.now() - 7 * 86_400_000);
    const overdue = await db.invoice.findMany({
      where: { status: "open", dueDate: { lt: cutoff } },
      include: { account: { select: { businessName: true, region: true } } },
      orderBy: { dueDate: "asc" },
    });
    if (overdue.length === 0) return "nothing more than 7 days overdue";

    // Stripe already handles the dunning email to the customer; this is the
    // internal summary so nobody has to go looking for it.
    const channel = await channelForRegion(overdue[0].account.region, "billing");
    if (!channel) return "skipped: no billing channel mapped";
    const body = overdue
      .map(
        (i) =>
          `• ${i.account.businessName} — ${i.invoiceNumber ?? i.stripeInvoiceId} · $${Number(i.amountDue).toFixed(2)} · due ${i.dueDate?.toISOString().slice(0, 10)}`,
      )
      .join("\n");
    await postMessage(channel, `:warning: *${overdue.length} invoice(s) more than 7 days overdue*\n${body}`);
    return `reported ${overdue.length} overdue`;
  },

  reorder_alert: async () => {
    if (!(await isAutomationEnabled("reorder_alert"))) return "skipped: rule off";
    const rows = (await availableForDelivery()).filter((r) => r.belowThreshold || r.available < 0);
    if (rows.length === 0) return "everything above threshold";

    const channel = process.env.SLACK_CHANNEL_INVENTORY ?? (await channelForRegion(null, "inventory"));
    if (!channel) return `${rows.length} below threshold, but no inventory channel mapped`;
    const body = rows
      .map((r) => `• ${r.skuCode} at ${r.locationId} — ${r.available} available (threshold ${r.reorderThreshold})`)
      .join("\n");
    await postMessage(channel, `:package: *Reorder alerts* (${rows.length})\n${body}`);
    return `alerted on ${rows.length}`;
  },

  keg_custody_nudge: async () => {
    if (!(await isAutomationEnabled("keg_custody_nudge"))) return "skipped: rule off";
    const cutoff = new Date(Date.now() - 60 * 86_400_000);
    const stale = (await kegCustodyBalances()).filter(
      (c) => c.balance > 0 && c.lastMovementAt && c.lastMovementAt < cutoff,
    );
    if (stale.length === 0) return "no account holding kegs more than 60 days";
    return `${stale.length} account-SKU balances older than 60 days`;
  },

  sheet_reconcile: async () => {
    if (!(await isAutomationEnabled("sheet_reconcile"))) return "skipped: rule off";
    // The Sheet -> DB direction is driven by Code.gs's own installable onEdit
    // trigger and its hourly reconcile, which POST to
    // app/api/sheet-sync/webhook. This job covers the other direction: orders
    // the database believes are confirmed but has never successfully mirrored.
    const unsynced = await db.order.findMany({
      where: { status: { in: ["confirmed", "scheduled", "fulfilled"] }, sheetSyncedAt: null },
      select: { id: true },
      take: 50,
    });
    let fixed = 0;
    for (const o of unsynced) {
      const r = await syncOrderToSheet(o.id);
      if (r.ok) fixed += 1;
    }
    return `re-mirrored ${fixed}/${unsynced.length} unsynced orders`;
  },
};
