/**
 * The invoice maker (app/docs/invoice).
 *
 * The reason this surface is allowed to exist is that it does not do its own
 * arithmetic -- it runs `composeInvoice`, the same composer that bills a
 * delivered order through Stripe. So these tests assert exactly that: the
 * document carries the deposit lines, the returned-deposit credit, the
 * account's negotiated price and the Net-30-from-delivery due date, and it
 * carries them because the shared code produced them.
 *
 * Pure -- no database, no Stripe. `invoice-composition.test.ts` covers
 * `composeInvoice` itself against the real INV26277; this covers the maker's
 * own decisions on top of it.
 */
import { describe, expect, it } from "vitest";
import { buildPaperworkInvoice, type PaperworkInvoiceLine } from "@/lib/billing/paperworkInvoice";
import { renderInvoiceHtml } from "@/lib/billing/renderInvoice";
import { resolveUnitPrice, lineTotal } from "@/lib/billing/pricing";

const halfBarrel: PaperworkInvoiceLine = {
  skuCode: "CNT1AKHB01",
  productName: "Cantinesca",
  formatLabel: "1/2 Barrel Keg (15.5 gal)",
  isKeg: true,
  depositAmount: 35,
  qty: 2,
  unitPrice: 192,
};
const caseLine: PaperworkInvoiceLine = {
  skuCode: "CNT1AC1224",
  productName: "Cantinesca",
  formatLabel: "Case (12oz x24)",
  isKeg: false,
  depositAmount: null,
  qty: 3,
  unitPrice: 31.7,
};

const base = {
  invoiceNumber: "INV-260909-0001",
  deliveryDate: new Date("2026-09-09T12:00:00Z"),
  terms: "Net 30",
  taxExempt: true,
  salesRep: "T. Gilbert",
  shipTo: { name: "The Black Cat", address: "1 Main St", license: "412645" },
  billTo: { name: "Black Cat LLC", address: "1 Main St" },
};

describe("pricing", () => {
  it("prefers the account's negotiated price over list", () => {
    expect(resolveUnitPrice(192, 175)).toEqual({ unitPrice: 175, source: "account" });
    expect(resolveUnitPrice(192, null)).toEqual({ unitPrice: 192, source: "list" });
    expect(resolveUnitPrice(192, undefined)).toEqual({ unitPrice: 192, source: "list" });
  });

  it("treats a negotiated price of zero as a price, not as missing", () => {
    // A comp or a no-charge sample run. Falling through to list price here
    // would silently bill for something given away.
    expect(resolveUnitPrice(192, 0)).toEqual({ unitPrice: 0, source: "account" });
  });

  it("rounds line totals to the cent", () => {
    expect(lineTotal(3, 31.7)).toBe(95.1);
    expect(lineTotal(7, 0.1)).toBe(0.7);
  });
});

describe("building the document", () => {
  it("totals the lines and adds a keg deposit per keg line", () => {
    const doc = buildPaperworkInvoice({ ...base, lines: [halfBarrel, caseLine] });

    expect(doc.subtotal).toBe(2 * 192 + 3 * 31.7);
    expect(doc.depositTotal).toBe(70); // 2 kegs x $35
    expect(doc.total).toBe(doc.subtotal + 70);

    const deposit = doc.lines.filter((l) => l.kind === "keg_deposit");
    expect(deposit).toHaveLength(1);
    expect(deposit[0]).toMatchObject({ qty: 2, unitPrice: 35, lineTotal: 70 });
    // Cases carry no deposit, so there is no second deposit row.
    expect(doc.lines.filter((l) => l.kind === "product")).toHaveLength(2);
  });

  it("credits empty kegs picked up at the keg's own deposit rate", () => {
    const cheaperDeposit: PaperworkInvoiceLine = { ...halfBarrel, depositAmount: 30 };
    const doc = buildPaperworkInvoice({ ...base, lines: [cheaperDeposit], kegReturnQty: 2 });

    expect(doc.depositCreditTotal).toBe(60);
    const credit = doc.lines.find((l) => l.kind === "keg_deposit_returned");
    expect(credit).toMatchObject({ qty: 2, lineTotal: -60 });
    expect(doc.total).toBe(2 * 192 + 60 - 60);
  });

  it("never prints a negative total, and says where the rest went", () => {
    // A pickup-only visit: nothing delivered, four empties collected. The
    // billing system floors the invoice at zero and carries the balance as
    // account credit; the document has to say the same thing.
    const doc = buildPaperworkInvoice({ ...base, lines: [], kegReturnQty: 4 });

    expect(doc.total).toBe(0);
    expect(doc.creditCarriedForward).toBe(140);
  });

  it("dates the invoice Net 30 from delivery, not from when it was made", () => {
    const doc = buildPaperworkInvoice({ ...base, lines: [halfBarrel] });
    expect(doc.deliveryDate).toBe("September 9, 2026");
    expect(doc.dueDate).toBe("October 9, 2026");
  });

  it("honours the account's own terms", () => {
    const doc = buildPaperworkInvoice({ ...base, terms: "Net 14", lines: [halfBarrel] });
    expect(doc.dueDate).toBe("September 23, 2026");
  });

  it("drops lines with no quantity rather than printing empty rows", () => {
    const doc = buildPaperworkInvoice({ ...base, lines: [halfBarrel, { ...caseLine, qty: 0 }] });
    expect(doc.lines.filter((l) => l.kind === "product")).toHaveLength(1);
  });
});

describe("the printed page", () => {
  it("prints the lot column only when a line has a lot", () => {
    const withLot = buildPaperworkInvoice({ ...base, lines: [{ ...halfBarrel, lot: "L-2609A" }] });
    const withoutLot = buildPaperworkInvoice({ ...base, lines: [halfBarrel] });

    expect(renderInvoiceHtml(withLot)).toContain("Lot #");
    expect(renderInvoiceHtml(withLot)).toContain("L-2609A");
    // An invoice with no lots stays the document it has always been.
    expect(renderInvoiceHtml(withoutLot)).not.toContain("Lot #");
  });

  it("escapes what a customer's own name puts on the page", () => {
    const doc = buildPaperworkInvoice({
      ...base,
      shipTo: { name: 'Cat & Fiddle <script>alert(1)</script>', address: "1 Main St" },
      lines: [halfBarrel],
    });
    const html = renderInvoiceHtml(doc);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;");
  });

  it("carries the invoice number, the terms and the legal footer", () => {
    const html = renderInvoiceHtml(buildPaperworkInvoice({ ...base, lines: [halfBarrel] }));
    expect(html).toContain("INV-260909-0001");
    expect(html).toContain("Net 30");
    expect(html).toContain("25509");
    expect(html).toContain("Exempt (0.0000%)");
  });
});
