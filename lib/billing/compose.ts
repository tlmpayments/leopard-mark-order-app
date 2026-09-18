/**
 * Invoice composition (§6.3) — pure, so it can be asserted line by line
 * against the real INV26277 without touching Stripe.
 *
 * The existing `lib/stripeBilling.ts` creates a serviceable invoice: one item
 * per order line, finalize, send. What it does not yet do is match the real
 * invoice, and the differences are not cosmetic:
 *   - Keg Deposit (+$35/keg) and Keg Deposit Returned (−$35/empty) are separate
 *     lines the customer expects to see and reconcile against.
 *   - The due date must count from `deliveredAt`, not from invoice creation.
 *     "Net 30 from delivery" is the statutory language (Cal. B&P § 25509), so
 *     counting from creation would put a legally wrong date on the document.
 *   - The footer carries two specific legal sentences, verbatim.
 *   - Our own INV##### travels in custom_fields and metadata, because Stripe's
 *     invoice numbering is immutable per account and cannot be ours.
 */

export const TAX_EXEMPT_FOOTER = "TAX: Exempt (0.0000%)";

/**
 * The two legal sentences from the real invoice's footer, verbatim (§1.5).
 * These are compliance text, not marketing copy — do not reword them.
 */
export const LEGAL_FOOTER_SENTENCES = [
  "Terms: Net 30 from delivery (Cal. B&P Code § 25509).",
  "Payment is made by seller-initiated EFT per § 25509.1.",
] as const;

export const INVOICE_DESCRIPTION = "For new purchase orders, please email orders@theleopardmark.com";

/** `termsToDays` mirrors Code.gs exactly: first integer in the string, else 30. */
export function termsToDays(terms: string | null | undefined): number {
  const m = /(\d+)/.exec(terms ?? "");
  return m ? Number.parseInt(m[1], 10) : 30;
}

/**
 * Due date = deliveredAt + terms. Explicit rather than Stripe's
 * `days_until_due`, which counts from finalization: an invoice issued three
 * days after delivery would otherwise be due three days late.
 */
export function dueDateFromDelivery(deliveredAt: Date, terms: string | null | undefined): Date {
  const days = termsToDays(terms);
  const due = new Date(deliveredAt);
  due.setUTCDate(due.getUTCDate() + days);
  return due;
}

export interface ComposeLineInput {
  orderLineId: string;
  skuCode: string;
  productName: string;
  formatLabel: string;
  qty: number;
  /** Line total in dollars, already rounded by the order. */
  lineTotal: number;
  lotNumber?: string | null;
  isKeg: boolean;
  depositAmount?: number | null;
}

export interface ComposeInput {
  lines: ComposeLineInput[];
  /** Empties collected at delivery, by product id or sku. */
  emptiesBySku?: Record<string, number>;
  defaultDepositAmount?: number;
}

export interface ComposedItem {
  description: string;
  quantity: number;
  /** Cents. Negative for the returned-deposit credit. */
  amount: number;
  metadata: Record<string, string>;
}

export interface ComposedInvoice {
  items: ComposedItem[];
  /** Cents. */
  subtotal: number;
  depositTotal: number;
  depositCreditTotal: number;
  /** Cents. Never below zero — see `customerBalanceCredit`. */
  total: number;
  /**
   * Cents to apply as a Stripe customer balance credit. Non-zero only when the
   * returned deposits exceed everything else on the invoice, which happens on
   * a pickup-only visit. Stripe allows negative line items but will not
   * finalize an invoice with a negative total, so the remainder becomes account
   * credit rather than silently vanishing.
   */
  customerBalanceCredit: number;
}

const toCents = (dollars: number): number => Math.round(dollars * 100);

export function composeInvoice(input: ComposeInput): ComposedInvoice {
  const defaultDeposit = input.defaultDepositAmount ?? 35;
  const items: ComposedItem[] = [];

  // ---- One item per order line ----
  let subtotal = 0;
  for (const l of input.lines) {
    const amount = toCents(l.lineTotal);
    subtotal += amount;
    items.push({
      // Matches the real invoice's description format, e.g.
      // "Cantinesca 1/6 Barrel Keg (5.16 gal)".
      description: `${l.productName} ${l.formatLabel}`.trim(),
      quantity: l.qty,
      amount,
      metadata: {
        skuCode: l.skuCode,
        orderLineId: l.orderLineId,
        ...(l.lotNumber ? { lotNumber: l.lotNumber } : {}),
      },
    });
  }

  // ---- One Keg Deposit item per keg line ----
  let depositTotal = 0;
  for (const l of input.lines) {
    if (!l.isKeg || l.qty <= 0) continue;
    const unit = toCents(l.depositAmount ?? defaultDeposit);
    const amount = unit * l.qty;
    depositTotal += amount;
    items.push({
      description: "Keg Deposit",
      quantity: l.qty,
      amount,
      metadata: { skuCode: l.skuCode, kind: "keg_deposit" },
    });
  }

  // ---- One Keg Deposit Returned credit per empty collected ----
  let depositCreditTotal = 0;
  for (const [sku, qty] of Object.entries(input.emptiesBySku ?? {})) {
    if (!qty || qty <= 0) continue;
    const line = input.lines.find((l) => l.skuCode === sku);
    const unit = toCents(line?.depositAmount ?? defaultDeposit);
    const amount = unit * qty;
    depositCreditTotal += amount;
    items.push({
      description: "Keg Deposit Returned",
      quantity: qty,
      amount: -amount,
      metadata: { skuCode: sku, kind: "keg_deposit_returned" },
    });
  }

  const raw = subtotal + depositTotal - depositCreditTotal;
  const total = Math.max(0, raw);
  const customerBalanceCredit = raw < 0 ? -raw : 0;

  return { items, subtotal, depositTotal, depositCreditTotal, total, customerBalanceCredit };
}

export interface CustomFieldsInput {
  poDate?: Date | null;
  deliveryDate?: Date | null;
  salesRep?: string | null;
  licenseNumber?: string | null;
  invoiceNumber?: string | null;
}

const PT_SHORT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Stripe's `custom_fields`, which is where the facts the real invoice prints in
 * its header have to live. Stripe caps this at four fields, so the invoice
 * number — the one an operator quotes on the phone — is always included and
 * the rest fill the remaining slots in priority order.
 */
export function buildCustomFields(input: CustomFieldsInput): Array<{ name: string; value: string }> {
  const candidates: Array<{ name: string; value: string | null }> = [
    { name: "Invoice #", value: input.invoiceNumber ?? null },
    { name: "Delivery Date", value: input.deliveryDate ? PT_SHORT.format(input.deliveryDate) : null },
    { name: "PO Date", value: input.poDate ? PT_SHORT.format(input.poDate) : null },
    { name: "Sales Rep", value: input.salesRep ?? null },
    { name: "License Number", value: input.licenseNumber ?? null },
  ];
  return candidates
    .filter((c): c is { name: string; value: string } => Boolean(c.value))
    .slice(0, 4)
    .map((c) => ({ name: c.name, value: c.value.slice(0, 140) }));
}

/** The footer, assembled in the order the real invoice prints it. */
export function buildFooter(taxExempt: boolean): string {
  const parts = [taxExempt ? TAX_EXEMPT_FOOTER : null, ...LEGAL_FOOTER_SENTENCES].filter(Boolean);
  return parts.join("\n");
}
