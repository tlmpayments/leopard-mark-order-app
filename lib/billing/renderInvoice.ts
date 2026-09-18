/**
 * The printable invoice.
 *
 * A faithful port of `buildInvoiceHtml` in public/rep-app/assets/js/app.js --
 * the layout the reps already print and the retailers already receive, down to
 * the header blocks, the six-column item table, the two signature lines and
 * the two legal sentences. Same reasoning as lib/bol/render.ts: this is a
 * document people compare against paper they already hold, so it is a port,
 * not a redesign.
 *
 * Two deliberate differences from the rep app's version:
 *   - a LOT # column, printed only when at least one line carries a lot, so an
 *     invoice without lots is byte-for-byte the document it always was;
 *   - the numbers come from `composeInvoice` (lib/billing/compose.ts), the same
 *     function that builds the Stripe invoice for a delivered order, so the
 *     printed paperwork and the real invoice can never disagree on the maths.
 */

import { esc, PRINT_PAGE_STYLE, PRINT_TIP_HTML } from "@/lib/bol/render";

const LOGO_URL = "/rep-app/assets/icons/brand/logo-alt.svg";

export interface InvoiceDocParty {
  name?: string | null;
  address?: string | null;
  phone?: string | null;
  license?: string | null;
}

export interface InvoiceDocLine {
  /** Our SKU code. Printed under "Item Number" -- the retailer's own reference. */
  skuCode: string;
  description: string;
  upc?: string | null;
  lot?: string | null;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  /** Deposit and returned-deposit rows print without a unit reference. */
  kind?: "product" | "keg_deposit" | "keg_deposit_returned";
}

export interface InvoiceDocData {
  docType: "invoice";
  invoiceNumber: string;
  /** Pre-formatted display strings, so a reprint shows the date it was issued. */
  poDate?: string | null;
  deliveryDate: string;
  dueDate?: string | null;
  terms?: string | null;
  salesRep?: string | null;
  shipTo: InvoiceDocParty;
  billTo: InvoiceDocParty;
  lines: InvoiceDocLine[];
  subtotal: number;
  depositTotal: number;
  depositCreditTotal: number;
  total: number;
  /** Non-zero only when returned deposits exceed the invoice -- see compose.ts. */
  creditCarriedForward?: number;
  taxExempt: boolean;
  notes?: string | null;
  /** Who made the document, for the "prepared by" line. Never a signature. */
  preparedBy?: string | null;
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const money = (n: number): string => USD.format(Number(n) || 0);
/** Credits print as -$35.00, not ($35.00): it is what the rep app prints. */
const moneySigned = (n: number): string => (n < 0 ? `-${USD.format(Math.abs(n))}` : USD.format(n));

export function renderInvoiceHtml(d: InvoiceDocData): string {
  const lines = d.lines ?? [];
  const showLots = lines.some((l) => Boolean(l.lot));

  const rows = lines
    .map((l) => {
      const isCredit = l.kind === "keg_deposit_returned";
      const fmt = isCredit ? moneySigned : money;
      return `<tr>
        <td>${esc(l.description)}</td>
        <td class="mono">${l.kind && l.kind !== "product" ? "&mdash;" : esc(l.skuCode)}</td>
        ${showLots ? `<td class="mono">${esc(l.lot || "—")}</td>` : ""}
        <td class="num">${(Number(l.qty) || 0).toFixed(2)}</td>
        <td class="num">${fmt(l.unitPrice)}</td>
        <td class="num">${fmt(l.lineTotal)}</td>
      </tr>`;
    })
    .join("");

  const totals = [
    `<div class="row"><span class="label">SUBTOTAL</span><span class="value">${money(d.subtotal)}</span></div>`,
    d.depositTotal > 0
      ? `<div class="row"><span class="label">KEG DEPOSIT</span><span class="value">${money(d.depositTotal)}</span></div>`
      : "",
    d.depositCreditTotal > 0
      ? `<div class="row"><span class="label">KEG DEPOSIT RETURNED</span><span class="value">${moneySigned(-d.depositCreditTotal)}</span></div>`
      : "",
    `<div class="row"><span class="label">TAX: ${d.taxExempt ? "Exempt (0.0000%)" : "See below"}</span><span class="value">${money(0)}</span></div>`,
    `<div class="row bold"><span class="label">INVOICE TOTAL</span><span class="value">${money(d.total)}</span></div>`,
    d.creditCarriedForward && d.creditCarriedForward > 0
      ? `<div class="row"><span class="label">CREDIT CARRIED FORWARD</span><span class="value">${money(d.creditCarriedForward)}</span></div>`
      : "",
  ]
    .filter(Boolean)
    .join("");

  return `<style>${INVOICE_STYLE}</style>
<div class="inv-doc">
  <div class="inv-header">
    <img class="inv-logo" src="${LOGO_URL}" alt="The Leopard Mark Brewing Co." />
    <div class="inv-doc-label">Invoice</div>
  </div>
  <div class="inv-info-row">
    <div class="inv-company-block">
      The Leopard Mark Brewing Company<br/>(707) 261-0200<br/>ar@theleopardmark.com<br/>
      ${d.salesRep ? `Sales Rep : ${esc(d.salesRep)}` : ""}
    </div>
    <div class="inv-meta-block">
      Invoice: ${esc(d.invoiceNumber)}<br/>
      ${d.poDate ? `PO Date: ${esc(d.poDate)}<br/>` : ""}
      Delivery Date: ${esc(d.deliveryDate)}<br/>
      ${d.terms ? `Payment Terms: ${esc(d.terms)}<br/>` : ""}
      ${d.dueDate ? `Due Date: ${esc(d.dueDate)}` : ""}
    </div>
  </div>
  <div class="inv-parties">
    <div class="inv-party">
      <div class="inv-heading">Ship To:</div>
      <div>${esc(d.shipTo.name || "")}</div>
      <div>${esc(d.shipTo.address || "")}</div>
      <div>${esc(d.shipTo.phone || "")}</div>
      <div>${d.shipTo.license ? `License Number: ${esc(d.shipTo.license)}` : ""}</div>
    </div>
    <div class="inv-party">
      <div class="inv-heading">Bill To:</div>
      <div>${esc(d.billTo.name || "")}</div>
      <div>${esc(d.billTo.address || "")}</div>
    </div>
  </div>
  <table class="inv-items">
    <thead>
      <tr>
        <th>Item</th>
        <th>Item Number</th>
        ${showLots ? "<th>Lot #</th>" : ""}
        <th class="num">Quantity</th>
        <th class="num">Unit Price</th>
        <th class="num">Total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="inv-totals-wrap"><div class="inv-totals">${totals}</div></div>
  ${d.notes ? `<div class="inv-notes"><b>Notes:</b> ${esc(d.notes)}</div>` : ""}
  <div class="inv-signatures">
    <div class="inv-sig"><div class="inv-sig-line"></div><div class="inv-sig-label">The Leopard Mark Brewing Company<br/>Representative</div></div>
    <div class="inv-sig"><div class="inv-sig-line"></div><div class="inv-sig-label">${esc(d.shipTo.name || "")} Representative</div></div>
  </div>
  <div class="inv-footer-note">For new purchase orders, please email orders@theleopardmark.com</div>
  <div class="inv-terms-note">
    <b>Keg Deposit:</b> A refundable deposit is assessed on each keg delivered and credited upon return of each empty keg.<br/>
    <b>Terms:</b> Net 30 from delivery (Cal. B&amp;P Code &sect; 25509) unless otherwise stated above, paid via seller-initiated EFT per &sect; 25509.1.
  </div>
  ${d.preparedBy ? `<div class="inv-prepared">Prepared by ${esc(d.preparedBy)} &middot; ${esc(d.invoiceNumber)}</div>` : ""}
</div>`;
}

/**
 * A complete printable page, one invoice per sheet. Shares the BOL renderer's
 * @page rules so an invoice and a delivery receipt printed from this app
 * paginate the same way.
 */
export function renderInvoicePage(docs: InvoiceDocData[], title: string): string {
  const pages = docs
    .map(
      (d, i) =>
        `<div class="print-page"${i < docs.length - 1 ? ' style="page-break-after: always; break-after: page;"' : ""}>${renderInvoiceHtml(d)}</div>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_PAGE_STYLE}</style></head><body>${PRINT_TIP_HTML}${pages}</body></html>`;
}

/**
 * Ported from the rep app's app.css (`.inv-*` rules), inlined here for the same
 * reason lib/bol/render.ts inlines its own: the document is served from a route
 * with no stylesheet of its own, and a printed invoice must not depend on one
 * loading.
 */
const INVOICE_STYLE = `
.inv-doc { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 12px; line-height: 1.45; }
.inv-doc .mono { font-family: "SFMono-Regular", Menlo, Consolas, monospace; }
.inv-header { display: flex; align-items: flex-start; justify-content: space-between; border-bottom: 2px solid #0b1f4b; padding-bottom: 10px; }
.inv-logo { height: 46px; }
.inv-doc-label { font-size: 26px; letter-spacing: .12em; text-transform: uppercase; color: #0b1f4b; font-weight: 700; }
.inv-info-row { display: flex; justify-content: space-between; gap: 24px; margin: 12px 0 14px; }
.inv-company-block { font-size: 11.5px; }
.inv-meta-block { font-size: 11.5px; text-align: right; }
.inv-parties { display: flex; gap: 16px; margin-bottom: 14px; }
.inv-party { flex: 1; border: 1px solid #c9cfdb; padding: 8px 10px; min-height: 74px; }
.inv-heading { font-weight: 700; text-transform: uppercase; font-size: 10.5px; letter-spacing: .06em; color: #0b1f4b; margin-bottom: 3px; }
.inv-items { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
.inv-items th { background: #0b1f4b; color: #fff; text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; padding: 6px 8px; }
.inv-items td { border-bottom: 1px solid #dfe3ea; padding: 6px 8px; vertical-align: top; }
.inv-items .num { text-align: right; white-space: nowrap; }
.inv-totals-wrap { display: flex; justify-content: flex-end; }
.inv-totals { width: 300px; }
.inv-totals .row { display: flex; justify-content: space-between; padding: 3px 0; }
.inv-totals .row.bold { font-weight: 700; border-top: 1px solid #0b1f4b; margin-top: 3px; padding-top: 6px; }
.inv-totals .label { text-transform: uppercase; font-size: 10.5px; letter-spacing: .05em; }
.inv-notes { margin: 12px 0; padding: 8px 10px; border-left: 3px solid #0b1f4b; background: #f4f6fa; font-size: 11.5px; }
.inv-signatures { display: flex; gap: 40px; margin: 28px 0 10px; }
.inv-sig { flex: 1; }
.inv-sig-line { border-bottom: 1px solid #111; height: 26px; }
.inv-sig-label { font-size: 10px; color: #444; padding-top: 4px; }
.inv-footer-note { font-size: 11px; text-align: center; margin-top: 8px; }
.inv-terms-note { font-size: 10px; color: #444; margin-top: 8px; border-top: 1px solid #dfe3ea; padding-top: 6px; }
.inv-prepared { font-size: 9.5px; color: #777; margin-top: 6px; text-align: right; }
`;
