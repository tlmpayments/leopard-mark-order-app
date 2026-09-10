/**
 * Turn what someone typed into the invoice maker into a printable invoice.
 *
 * The whole point of this file is that it does no arithmetic of its own. Line
 * totals, keg deposits, returned-deposit credits, the floor at zero and the
 * carried-forward credit all come from `composeInvoice`, and the due date from
 * `dueDateFromDelivery` -- the same two functions that build the Stripe
 * invoice for a delivered order (lib/billing/issue.ts). A second
 * implementation here is exactly the drift this codebase keeps paying for
 * elsewhere (§13, "one renderer, no more manual copy").
 *
 * Pure: no database, no session. The server action resolves accounts and
 * products and hands the facts in.
 */

import {
  composeInvoice,
  dueDateFromDelivery,
  type ComposeLineInput,
} from "./compose";
import { lineTotal } from "./pricing";
import type { InvoiceDocData, InvoiceDocLine, InvoiceDocParty } from "./renderInvoice";

export interface PaperworkInvoiceLine {
  /** Product facts read from the catalogue, never from the browser. */
  skuCode: string;
  productName: string;
  formatLabel: string;
  upc?: string | null;
  isKeg: boolean;
  depositAmount?: number | null;
  qty: number;
  unitPrice: number;
  lot?: string | null;
}

export interface PaperworkInvoiceInput {
  invoiceNumber: string;
  poDate?: Date | null;
  deliveryDate: Date;
  terms?: string | null;
  taxExempt: boolean;
  salesRep?: string | null;
  shipTo: InvoiceDocParty;
  billTo: InvoiceDocParty;
  lines: PaperworkInvoiceLine[];
  /** Empty kegs collected on this delivery, credited at the deposit rate. */
  kegReturnQty?: number;
  notes?: string | null;
  preparedBy?: string | null;
}

const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "long",
  day: "numeric",
});

const centsToDollars = (cents: number): number => Math.round(cents) / 100;

export function buildPaperworkInvoice(input: PaperworkInvoiceInput): InvoiceDocData {
  const priced = input.lines.filter((l) => (Number(l.qty) || 0) > 0);

  const composeLines: ComposeLineInput[] = priced.map((l, i) => ({
    // There is no OrderLine behind a paperwork invoice, so the index stands in.
    // `composeInvoice` only ever carries this through to metadata.
    orderLineId: `paperwork-${i}`,
    skuCode: l.skuCode,
    productName: l.productName,
    formatLabel: l.formatLabel,
    qty: Number(l.qty) || 0,
    lineTotal: lineTotal(l.qty, l.unitPrice),
    lotNumber: l.lot ?? null,
    isKeg: l.isKeg,
    depositAmount: l.depositAmount ?? null,
  }));

  // `composeInvoice` credits returned deposits per SKU, because on a real order
  // the empties come back off the keg custody ledger and each keg knows its own
  // deposit rate. The invoice maker has one flat "empties collected" count, so
  // it is attributed to the first keg line on the document -- that line's rate
  // is the one that applies. With no keg line at all (a pickup-only visit) the
  // synthetic key falls through to composeInvoice's $35 default, which is the
  // standard rate and the only honest answer available.
  const returnQty = Math.max(0, Math.trunc(Number(input.kegReturnQty) || 0));
  const firstKegSku = priced.find((l) => l.isKeg)?.skuCode;
  const emptiesBySku = returnQty > 0 ? { [firstKegSku ?? "__empties__"]: returnQty } : {};

  const composed = composeInvoice({ lines: composeLines, emptiesBySku });

  // Rebuild the printed rows from the composed items, so what the customer
  // reads is item-for-item what the billing system would send.
  const productRows: InvoiceDocLine[] = priced.map((l) => ({
    skuCode: l.skuCode,
    description: `${l.productName} ${l.formatLabel}`.trim(),
    upc: l.upc ?? null,
    lot: l.lot ?? null,
    qty: Number(l.qty) || 0,
    unitPrice: Number(l.unitPrice) || 0,
    lineTotal: lineTotal(l.qty, l.unitPrice),
    kind: "product",
  }));

  const depositRows: InvoiceDocLine[] = composed.items
    .filter((i) => i.metadata.kind === "keg_deposit")
    .map((i) => ({
      skuCode: String(i.metadata.skuCode ?? ""),
      description: i.description,
      qty: i.quantity,
      unitPrice: centsToDollars(i.amount / (i.quantity || 1)),
      lineTotal: centsToDollars(i.amount),
      kind: "keg_deposit" as const,
    }));

  const creditRows: InvoiceDocLine[] = composed.items
    .filter((i) => i.metadata.kind === "keg_deposit_returned")
    .map((i) => ({
      skuCode: String(i.metadata.skuCode ?? ""),
      description: i.description,
      qty: i.quantity,
      unitPrice: centsToDollars(i.amount / (i.quantity || 1)),
      lineTotal: centsToDollars(i.amount),
      kind: "keg_deposit_returned" as const,
    }));

  const dueDate = dueDateFromDelivery(input.deliveryDate, input.terms);

  return {
    docType: "invoice",
    invoiceNumber: input.invoiceNumber,
    poDate: input.poDate ? DAY.format(input.poDate) : null,
    deliveryDate: DAY.format(input.deliveryDate),
    dueDate: DAY.format(dueDate),
    terms: input.terms ?? null,
    salesRep: input.salesRep ?? null,
    shipTo: input.shipTo,
    billTo: input.billTo,
    lines: [...productRows, ...depositRows, ...creditRows],
    subtotal: centsToDollars(composed.subtotal),
    depositTotal: centsToDollars(composed.depositTotal),
    depositCreditTotal: centsToDollars(composed.depositCreditTotal),
    total: centsToDollars(composed.total),
    creditCarriedForward: centsToDollars(composed.customerBalanceCredit),
    taxExempt: input.taxExempt,
    notes: input.notes ?? null,
    preparedBy: input.preparedBy ?? null,
  };
}
