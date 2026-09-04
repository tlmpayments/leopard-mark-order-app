// Stripe invoice issuance (Phase 10 of
// /Users/jackbegley/.claude/plans/greedy-snuggling-clarke.md). Called from
// Phase 3 Stage 2's `order` action right after an Order+OrderLines are
// created -- same non-blocking-on-failure philosophy as
// lib/sheetSync.ts's syncOrderToSheet: a Stripe failure here must never
// fail the rep's order-creation request. On any error this still writes an
// Invoice row (status "local_error") instead of throwing, so the order
// isn't silently unbilled -- the Vercel Cron fallback (see plan) retries
// rows in that state.
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripeClient";
import { ensureStripeCustomer } from "@/lib/stripeCustomer";

// Mirrors apps-script/Code.gs's termsToDays exactly (same regex, same
// default) -- this is the DB-side invoice due date now, but it must agree
// with the Sheet-side due-date convention ops already knows, not invent a
// second one.
function termsToDays(terms: string | null): number {
  const m = /(\d+)/.exec(terms ?? "");
  return m ? parseInt(m[1], 10) : 30;
}

export async function issueOrderInvoice(orderId: string): Promise<void> {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      lines: { include: { product: true } },
      account: true,
      invoice: true,
    },
  });

  if (order.invoice) return; // already issued -- idempotent re-entry

  try {
    const customerId = await ensureStripeCustomer(order.accountId);
    const collectionMethod = order.account.stripeDefaultPaymentMethod
      ? "charge_automatically"
      : "send_invoice";

    const stripeInvoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: collectionMethod,
      ...(collectionMethod === "send_invoice"
        ? { days_until_due: termsToDays(order.account.terms) }
        : {}),
      metadata: { orderId: order.id },
    });

    for (const line of order.lines) {
      // `amount` (the line's total in cents) is passed directly rather than
      // unit_amount + quantity -- lineTotal is already the snapshotted,
      // authoritative total for this line (see OrderLine's own comment on
      // why it's resolved once at confirmation time), so this avoids any
      // rounding mismatch between Stripe re-deriving unit*qty and the value
      // already on the row. `quantity` is passed too, but purely for
      // display on the invoice line -- it doesn't affect the amount billed.
      await stripe.invoiceItems.create({
        customer: customerId,
        invoice: stripeInvoice.id,
        description: `${line.product.productName} — ${line.product.formatLabel}`,
        quantity: line.qty,
        amount: line.lineTotal.mul(100).round().toNumber(),
        currency: "usd",
      });
    }

    const finalized = await stripe.invoices.finalizeInvoice(stripeInvoice.id!);
    const sent =
      collectionMethod === "send_invoice"
        ? await stripe.invoices.sendInvoice(stripeInvoice.id!)
        : finalized;

    await db.invoice.create({
      data: {
        orderId: order.id,
        accountId: order.accountId,
        stripeInvoiceId: sent.id!,
        status: sent.status ?? "open",
        collectionMethod,
        amountDue: (sent.amount_due ?? 0) / 100,
        amountPaid: (sent.amount_paid ?? 0) / 100,
        dueDate: sent.due_date ? new Date(sent.due_date * 1000) : null,
        hostedInvoiceUrl: sent.hosted_invoice_url ?? null,
        sentAt: collectionMethod === "send_invoice" ? new Date() : null,
      },
    });
  } catch (err) {
    console.error(`issueOrderInvoice(${orderId}) failed:`, err);
    // Deliberately still writes a row rather than throwing -- see file
    // header. stripeInvoiceId has a placeholder since it's unique/required
    // and no real Stripe invoice exists yet to reference; the retry cron
    // looks for status = "local_error", not a real stripeInvoiceId.
    await db.invoice.create({
      data: {
        orderId: order.id,
        accountId: order.accountId,
        stripeInvoiceId: `local_error_${order.id}`,
        status: "local_error",
        collectionMethod: order.account.stripeDefaultPaymentMethod
          ? "charge_automatically"
          : "send_invoice",
        amountDue: order.lines.reduce(
          (sum, l) => sum + l.lineTotal.toNumber(),
          0,
        ),
      },
    });
  }
}

// Vercel Cron fallback (hourly, mirrors the already-planned
// hourlyReconcileSyncRows retry pattern) -- finds orders with no
// successfully-issued invoice and retries. Once Phase 2's Sheet->DB sync
// makes deliveryDate reliable, change the `where` below to key off
// deliveryDate instead of order age -- no other code changes needed to
// promote this to true delivery-triggered billing.
export async function retryFailedInvoices(): Promise<number> {
  const pending = await db.order.findMany({
    where: {
      status: { in: ["confirmed", "fulfilled"] },
      OR: [{ invoice: null }, { invoice: { status: "local_error" } }],
    },
    select: { id: true },
  });

  for (const { id } of pending) {
    // A prior local_error row must be cleared before re-issuing, since
    // orderId is unique on Invoice -- issueOrderInvoice's own idempotency
    // check (order.invoice already set) would otherwise treat the failed
    // row as "already issued" and skip it forever.
    await db.invoice.deleteMany({ where: { orderId: id, status: "local_error" } });
    await issueOrderInvoice(id);
  }
  return pending.length;
}
