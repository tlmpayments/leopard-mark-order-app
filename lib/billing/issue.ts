/**
 * Issue a Stripe invoice for a delivered order (§6).
 *
 * Supersedes `issueOrderInvoice` in lib/stripeBilling.ts, which is kept intact
 * for the retry sweep it already backs. The differences that matter:
 *   - deposit and returned-deposit lines (composeInvoice),
 *   - due date computed from `deliveredAt` rather than from finalization,
 *   - custom fields, footer and description matching the real INV26277,
 *   - billing-email resolution with an explicit block when there is none,
 *   - our own invoice number recorded on the Invoice row and in Stripe metadata.
 *
 * Idempotent on the existing `Invoice` row, and the queue's idempotency key
 * (`issue_invoice:<orderId>`) means the manual button and the automatic path
 * cannot race into two invoices.
 */

import { Prisma } from "@/app/generated/prisma/client";
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripeClient";
import { ensureStripeCustomer } from "@/lib/stripeCustomer";
import { appendOrderEvent } from "@/lib/orderEvents";
import { blockOrder, unblockOrder } from "@/lib/orderEvents";
import { resolveBillingEmail } from "@/lib/ops/checklist";
import {
  INVOICE_DESCRIPTION,
  buildCustomFields,
  buildFooter,
  composeInvoice,
  dueDateFromDelivery,
  type ComposeLineInput,
} from "./compose";

export interface IssueInvoiceResult {
  status: "issued" | "already_issued" | "blocked_missing_billing_email" | "not_delivered";
  stripeInvoiceId?: string;
  hostedInvoiceUrl?: string | null;
}

export async function issueInvoiceForOrder(orderId: string): Promise<IssueInvoiceResult> {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      account: true,
      contact: true,
      invoice: true,
      shipment: true,
      salesRep: { select: { name: true } },
      lines: { orderBy: { lineIndex: "asc" }, include: { product: true } },
    },
  });

  // Already billed. The queue dedupes, but a retry after a partial failure can
  // still arrive here with the row already written.
  if (order.invoice && order.invoice.status !== "local_error") {
    return {
      status: "already_issued",
      stripeInvoiceId: order.invoice.stripeInvoiceId,
      hostedInvoiceUrl: order.invoice.hostedInvoiceUrl,
    };
  }

  // §6.1: invoicing happens at ⑤, not on confirmation. Without a delivery date
  // there is nothing to count Net 30 from.
  if (!order.deliveredAt) return { status: "not_delivered" };

  // §6.2: resolve the billing email, and block rather than guess.
  const billing = resolveBillingEmail({
    billingContactEmail: order.account.billingContactEmail,
    contactEmail: order.contact?.email ?? null,
  });
  if (!billing.email) {
    await blockOrder(orderId, "missing_billing_email", "system", undefined, {
      checked: ["Account.billingContactEmail", "Contact.email"],
    });
    return { status: "blocked_missing_billing_email" };
  }

  const customerId = await ensureStripeCustomer(order.accountId);
  // Keep the Stripe customer's email in step with the billing email we
  // actually resolved, so the invoice lands where the hub says it will.
  await stripe.customers.update(customerId, { email: billing.email });

  const emptiesBySku = await emptiesForShipment(order.shipment?.id);

  const composeLines: ComposeLineInput[] = order.lines.map((l) => ({
    orderLineId: l.id,
    skuCode: l.product.skuCode,
    productName: l.product.productName,
    formatLabel: l.product.formatDetail || l.product.formatLabel,
    qty: l.qty,
    lineTotal: Number(l.lineTotal),
    lotNumber: l.lotNumber,
    isKeg: l.product.isKeg,
    depositAmount: l.product.depositAmount ? Number(l.product.depositAmount) : null,
  }));

  const composed = composeInvoice({ lines: composeLines, emptiesBySku });
  const dueDate = dueDateFromDelivery(order.deliveredAt, order.account.terms);
  const collectionMethod = order.account.stripeDefaultPaymentMethod
    ? "charge_automatically"
    : "send_invoice";

  try {
    const invoice = await stripe.invoices.create({
      customer: customerId,
      collection_method: collectionMethod,
      // Explicit due_date, in epoch seconds, so it is Net 30 from DELIVERY.
      // `days_until_due` would count from finalization instead.
      ...(collectionMethod === "send_invoice"
        ? { due_date: Math.floor(dueDate.getTime() / 1000) }
        : {}),
      auto_advance: false,
      // Wholesale alcohol to licensed retailers is exempt; the exemption is a
      // per-account fact, not a hardcoded constant.
      automatic_tax: { enabled: false },
      description: INVOICE_DESCRIPTION,
      footer: buildFooter(order.account.taxExempt),
      custom_fields: buildCustomFields({
        invoiceNumber: order.invoiceNumber,
        deliveryDate: order.deliveredAt,
        poDate: order.confirmedAt ?? order.submittedAt,
        salesRep: order.salesRep?.name,
        licenseNumber: order.account.licenseNumber,
      }),
      payment_settings: {
        // ACH first: it matches the § 25509.1 seller-initiated EFT language and
        // what ach.tlmbg.co onboards customers onto.
        payment_method_types: ["us_bank_account", "card"],
      },
      metadata: {
        orderId: order.id,
        invoiceNumber: order.invoiceNumber ?? "",
        bolNumber: order.bolNumber ?? "",
        region: order.account.region ?? "",
        salesRep: order.salesRep?.name ?? "",
        billingEmailSource: billing.source,
      },
      ...(order.account.deliveryAddress
        ? {
            shipping_details: {
              name: order.account.businessName,
              address: { line1: order.account.deliveryAddress.slice(0, 200), country: "US" },
            },
          }
        : {}),
    });

    for (const item of composed.items) {
      await stripe.invoiceItems.create({
        customer: customerId,
        invoice: invoice.id,
        currency: "usd",
        amount: item.amount,
        quantity: item.quantity,
        description: item.description,
        metadata: item.metadata,
      });
    }

    // A pickup-only visit can net negative. Stripe will not finalize that, so
    // the excess becomes account credit and the customer is told why.
    if (composed.customerBalanceCredit > 0) {
      await stripe.customers.createBalanceTransaction(customerId, {
        amount: -composed.customerBalanceCredit,
        currency: "usd",
        description: `Keg deposit credit carried forward from ${order.invoiceNumber ?? order.id}`,
      });
    }

    const finalized = await stripe.invoices.finalizeInvoice(invoice.id!);
    const sent =
      collectionMethod === "send_invoice" ? await stripe.invoices.sendInvoice(finalized.id!) : finalized;

    const row = await db.invoice.upsert({
      where: { orderId: order.id },
      create: {
        orderId: order.id,
        accountId: order.accountId,
        stripeInvoiceId: sent.id!,
        invoiceNumber: order.invoiceNumber,
        status: sent.status ?? "open",
        collectionMethod,
        amountDue: new Prisma.Decimal(composed.total).div(100),
        depositAmount: new Prisma.Decimal(composed.depositTotal).div(100),
        depositCreditAmount: new Prisma.Decimal(composed.depositCreditTotal).div(100),
        dueDate,
        hostedInvoiceUrl: sent.hosted_invoice_url ?? null,
        pdfUrl: sent.invoice_pdf ?? null,
        sentAt: collectionMethod === "send_invoice" ? new Date() : null,
      },
      update: {
        stripeInvoiceId: sent.id!,
        invoiceNumber: order.invoiceNumber,
        status: sent.status ?? "open",
        collectionMethod,
        amountDue: new Prisma.Decimal(composed.total).div(100),
        depositAmount: new Prisma.Decimal(composed.depositTotal).div(100),
        depositCreditAmount: new Prisma.Decimal(composed.depositCreditTotal).div(100),
        dueDate,
        hostedInvoiceUrl: sent.hosted_invoice_url ?? null,
        pdfUrl: sent.invoice_pdf ?? null,
        sentAt: collectionMethod === "send_invoice" ? new Date() : null,
      },
    });

    // A previously-missing billing email has now been supplied, so clear that
    // block. Deliberately narrow: only this reason, never a compliance one.
    if (order.blockedReason === "missing_billing_email") {
      await unblockOrder(orderId, "system", undefined, "billing email resolved");
    }

    await appendOrderEvent({
      orderId: order.id,
      eventType: collectionMethod === "send_invoice" ? "invoice.sent" : "invoice.issued",
      actor: "system",
      payload: {
        stripeInvoiceId: sent.id,
        invoiceNumber: order.invoiceNumber,
        billingEmail: billing.email,
        billingEmailSource: billing.source,
        collectionMethod,
        dueDate: dueDate.toISOString(),
        totalCents: composed.total,
        depositCents: composed.depositTotal,
        depositCreditCents: composed.depositCreditTotal,
        customerBalanceCreditCents: composed.customerBalanceCredit,
      },
    });

    return { status: "issued", stripeInvoiceId: row.stripeInvoiceId, hostedInvoiceUrl: row.hostedInvoiceUrl };
  } catch (err) {
    // Record the failure locally so the hub can show it, then rethrow: the job
    // runner owns the retry ladder, and swallowing the error here would make a
    // failing invoice look like a succeeded one.
    await db.invoice.upsert({
      where: { orderId: order.id },
      create: {
        orderId: order.id,
        accountId: order.accountId,
        stripeInvoiceId: `local_error_${order.id}`,
        status: "local_error",
        collectionMethod,
        amountDue: new Prisma.Decimal(composed.total).div(100),
        dueDate,
      },
      update: { status: "local_error" },
    });
    throw err;
  }
}

/**
 * Empties collected on this shipment, keyed by SKU, from the append-only keg
 * custody ledger. Read from custody rather than from a field on the shipment so
 * the invoice credit and the custody balance can never disagree.
 */
async function emptiesForShipment(shipmentId: string | undefined): Promise<Record<string, number>> {
  if (!shipmentId) return {};
  const rows = await db.kegCustodyEntry.findMany({
    where: { shipmentId, delta: { lt: 0 } },
    include: { product: { select: { skuCode: true } } },
  });
  const out: Record<string, number> = {};
  for (const r of rows) out[r.product.skuCode] = (out[r.product.skuCode] ?? 0) + Math.abs(r.delta);
  return out;
}
