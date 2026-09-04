// Stripe webhook (Phase 9/10 of
// /Users/jackbegley/.claude/plans/greedy-snuggling-clarke.md). Verifies the
// Stripe-Signature header against STRIPE_WEBHOOK_SECRET (a webhook-specific
// secret Stripe issues when the endpoint is registered -- not the same as
// STRIPE_SECRET_KEY), then updates the matching Account/Invoice row.
//
// Needs the raw request body for signature verification -- Next.js's App
// Router route handlers don't parse the body until you call a method on
// `request`, so `request.text()` here (not `request.json()`) is what keeps
// the bytes exactly as Stripe signed them.
import { Prisma } from "@/app/generated/prisma/client";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripeClient";
import { appendOrderEvent, blockOrder } from "@/lib/orderEvents";
import { enqueue } from "@/lib/jobs/queue";
import { channelForRegion, postMessage } from "@/lib/slack";
import Stripe from "stripe";

export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !webhookSecret) {
    return Response.json(
      { ok: false, error: "Webhook not configured" },
      { status: 401 },
    );
  }

  const rawBody = await request.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("Stripe webhook signature verification failed:", err);
    return Response.json({ ok: false, error: "Invalid signature" }, { status: 400 });
  }

  // Idempotency (§6.6). Stripe redelivers events -- on its own retry schedule
  // and whenever an endpoint returns non-2xx -- so a handler that appends an
  // OrderEvent or posts to Slack must run once per event, not once per
  // delivery. Claim the event id first: the unique primary key is the lock, and
  // a duplicate insert means somebody already handled this.
  try {
    await db.stripeEvent.create({ data: { id: event.id, type: event.type } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Already processed. 200, not an error -- telling Stripe this failed
      // would make it redeliver the event we have just declined to repeat.
      return Response.json({ ok: true, duplicate: true });
    }
    throw err;
  }

  switch (event.type) {
    case "customer.updated": {
      const customer = event.data.object as Stripe.Customer;
      const defaultPm =
        typeof customer.invoice_settings?.default_payment_method === "string"
          ? customer.invoice_settings.default_payment_method
          : (customer.invoice_settings?.default_payment_method?.id ?? null);
      await db.account.updateMany({
        where: { stripeCustomerId: customer.id },
        data: { stripeDefaultPaymentMethod: defaultPm },
      });
      break;
    }

    case "setup_intent.succeeded": {
      const setupIntent = event.data.object as Stripe.SetupIntent;
      const pmId =
        typeof setupIntent.payment_method === "string"
          ? setupIntent.payment_method
          : (setupIntent.payment_method?.id ?? null);
      const customerId =
        typeof setupIntent.customer === "string"
          ? setupIntent.customer
          : (setupIntent.customer?.id ?? null);
      if (pmId && customerId) {
        // Make it the customer's default so issueOrderInvoice's
        // charge_automatically check (Account.stripeDefaultPaymentMethod)
        // actually has something to find -- attaching a payment method
        // alone doesn't set it as default on the Customer object.
        await stripe.customers.update(customerId, {
          invoice_settings: { default_payment_method: pmId },
        });
        await db.account.updateMany({
          where: { stripeCustomerId: customerId },
          data: { stripeDefaultPaymentMethod: pmId },
        });
      }
      break;
    }

    case "invoice.finalized":
    case "invoice.sent":
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.voided": {
      const invoice = event.data.object as Stripe.Invoice;
      const paid = invoice.status === "paid";

      // Stripe is the truth for payment state; this row mirrors it (§13).
      await db.invoice.updateMany({
        where: { stripeInvoiceId: invoice.id },
        data: {
          status: invoice.status ?? "open",
          amountPaid: (invoice.amount_paid ?? 0) / 100,
          hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
          pdfUrl: invoice.invoice_pdf ?? null,
          paidAt: paid ? new Date() : null,
        },
      });

      const row = await db.invoice.findFirst({
        where: { stripeInvoiceId: invoice.id },
        include: {
          order: { select: { id: true, invoiceNumber: true } },
          account: { select: { id: true, businessName: true, region: true, creditHold: true } },
        },
      });
      if (!row) break;

      if (paid) {
        // ⑦. The payment reference goes onto the order so the Sheet's
        // "ACH Invoice REF #" column has something real to mirror.
        //
        // Stripe SDK 22 removed the flat `invoice.payment_intent` / `charge`
        // fields: an invoice can now be settled by several payments (partial
        // payments, out-of-band records), so they live in `invoice.payments`.
        // Take the most recent one — for a normal ACH settlement there is
        // exactly one, and for a part-paid invoice the latest reference is the
        // one an operator would quote.
        const paymentRef = latestPaymentRef(invoice);

        await db.order.update({
          where: { id: row.orderId },
          data: { invoiceStatus: "Paid", achRef: paymentRef },
        });
        await appendOrderEvent({
          orderId: row.orderId,
          eventType: "invoice.paid",
          actor: "customer",
          payload: { stripeInvoiceId: invoice.id, paymentRef, amountPaid: (invoice.amount_paid ?? 0) / 100 },
        });
        // Mirror Invoice Status + ACH REF back to the Sheet, out of band.
        await enqueue("write_delivery_to_sheet", `paid:${row.orderId}`, { orderId: row.orderId }, {
          orderId: row.orderId,
        });

        // §3 ⑦: a credit hold caused by this invoice clears itself once it is
        // paid. Any OTHER reason for the hold is a human's decision and is
        // left alone -- which is why this only fires when nothing else is
        // outstanding for the account.
        if (row.account.creditHold) {
          const stillOwing = await db.invoice.count({
            where: { accountId: row.accountId, status: { in: ["open", "uncollectible"] } },
          });
          if (stillOwing === 0) {
            await db.account.update({ where: { id: row.accountId }, data: { creditHold: false } });
          }
        }

        const channel = await channelForRegion(row.account.region);
        if (channel) {
          await postMessage(
            channel,
            `:white_check_mark: *Paid* — ${row.account.businessName} · ${row.order.invoiceNumber ?? invoice.id} · $${((invoice.amount_paid ?? 0) / 100).toFixed(2)}`,
          );
        }
      }

      if (event.type === "invoice.payment_failed") {
        // Overlay the block, and deliberately do NOT set creditHold: a failed
        // ACH debit is often a bank-side timing problem, and putting an
        // account on credit hold is a commercial decision a person makes.
        await blockOrder(row.orderId, "payment_failed", "system", undefined, {
          stripeInvoiceId: invoice.id,
        });
        await appendOrderEvent({
          orderId: row.orderId,
          eventType: "invoice.payment_failed",
          actor: "system",
          payload: { stripeInvoiceId: invoice.id, attemptCount: invoice.attempt_count ?? null },
        });
      }

      if (event.type === "invoice.sent") {
        await appendOrderEvent({
          orderId: row.orderId,
          eventType: "invoice.sent",
          actor: "system",
          payload: { stripeInvoiceId: invoice.id, hostedInvoiceUrl: invoice.hosted_invoice_url ?? null },
        });
      }
      break;
    }

    default:
      // Unhandled event types are expected -- Stripe sends everything the
      // webhook endpoint is subscribed to; ignoring the rest is normal, not
      // an error.
      break;
  }

  return Response.json({ ok: true });
}

/**
 * The payment reference for a settled invoice, from `invoice.payments`.
 *
 * Prefers a PaymentIntent id, falling back to a charge or payment-record id,
 * and returns null rather than guessing when the list is absent — which it is
 * unless the webhook was configured to expand it.
 */
function latestPaymentRef(invoice: Stripe.Invoice): string | null {
  const payments = invoice.payments?.data;
  if (!payments || payments.length === 0) return null;

  const newest = payments[payments.length - 1];
  const payment = newest.payment;
  if (!payment) return null;

  const pi = payment.payment_intent;
  if (typeof pi === "string") return pi;
  if (pi && typeof pi === "object" && "id" in pi) return pi.id;

  const charge = payment.charge;
  if (typeof charge === "string") return charge;
  if (charge && typeof charge === "object" && "id" in charge) return charge.id;

  return null;
}
