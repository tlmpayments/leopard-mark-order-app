/**
 * Invoice composition against the real INV26277 (§11). Pure — no Stripe, no
 * database. These are the facts the printed invoice has to carry, so they are
 * asserted as facts rather than as a snapshot.
 */
import { describe, expect, it } from "vitest";
import {
  INVOICE_DESCRIPTION,
  LEGAL_FOOTER_SENTENCES,
  TAX_EXEMPT_FOOTER,
  buildCustomFields,
  buildFooter,
  composeInvoice,
  dueDateFromDelivery,
  termsToDays,
  type ComposeLineInput,
} from "@/lib/billing/compose";

const half: ComposeLineInput = {
  orderLineId: "ol-1",
  skuCode: "CNT1AKHB01",
  productName: "Cantinesca",
  formatLabel: "1/2 Barrel Keg (15.5 gal)",
  qty: 2,
  lineTotal: 384,
  isKeg: true,
  depositAmount: 35,
};
const sixth: ComposeLineInput = {
  orderLineId: "ol-2",
  skuCode: "CNT1AKSB01",
  productName: "Cantinesca",
  formatLabel: "1/6 Barrel Keg (5.16 gal)",
  qty: 2,
  lineTotal: 192,
  isKeg: true,
  depositAmount: 35,
};
const cases: ComposeLineInput = {
  orderLineId: "ol-3",
  skuCode: "CNT1AC1224",
  productName: "Cantinesca",
  formatLabel: "Case 12oz x24",
  qty: 6,
  lineTotal: 190.2,
  isKeg: false,
};

describe("termsToDays — mirrors Code.gs", () => {
  it.each([
    ["Net 30", 30],
    ["net 15", 15],
    ["NET 45 days", 45],
    ["Due on receipt", 30],
    ["", 30],
    [null, 30],
  ])("%s -> %i", (terms, days) => {
    expect(termsToDays(terms as string | null)).toBe(days);
  });
});

describe("due date counts from DELIVERY, not from invoice creation", () => {
  it("adds the terms days to deliveredAt", () => {
    // The statutory language is "Net 30 from delivery" (Cal. B&P § 25509).
    const delivered = new Date("2026-09-02T17:00:00Z");
    expect(dueDateFromDelivery(delivered, "Net 30").toISOString().slice(0, 10)).toBe("2026-10-02");
  });

  it("respects non-30 terms", () => {
    const delivered = new Date("2026-09-02T17:00:00Z");
    expect(dueDateFromDelivery(delivered, "Net 15").toISOString().slice(0, 10)).toBe("2026-09-17");
  });

  it("crosses a month boundary correctly", () => {
    const delivered = new Date("2026-01-31T17:00:00Z");
    expect(dueDateFromDelivery(delivered, "Net 30").toISOString().slice(0, 10)).toBe("2026-03-02");
  });
});

describe("composeInvoice — line, deposit and returned-deposit items", () => {
  it("emits one item per order line, in cents", () => {
    const c = composeInvoice({ lines: [cases] });
    expect(c.items).toHaveLength(1);
    expect(c.items[0].description).toBe("Cantinesca Case 12oz x24");
    expect(c.items[0].amount).toBe(19020);
    expect(c.items[0].quantity).toBe(6);
    expect(c.items[0].metadata).toMatchObject({ skuCode: "CNT1AC1224", orderLineId: "ol-3" });
  });

  it("adds a Keg Deposit line per keg SKU at $35 a keg", () => {
    const c = composeInvoice({ lines: [half, sixth] });
    const deposits = c.items.filter((i) => i.description === "Keg Deposit");
    expect(deposits).toHaveLength(2);
    expect(deposits[0].amount).toBe(7000); // 2 × $35
    expect(deposits[1].amount).toBe(7000);
    expect(c.depositTotal).toBe(14000);
  });

  it("adds no deposit for case lines", () => {
    const c = composeInvoice({ lines: [cases] });
    expect(c.items.some((i) => i.description === "Keg Deposit")).toBe(false);
  });

  it("credits returned deposits as a negative item", () => {
    const c = composeInvoice({ lines: [half, sixth], emptiesBySku: { CNT1AKSB01: 1 } });
    const credit = c.items.find((i) => i.description === "Keg Deposit Returned");
    expect(credit).toBeDefined();
    expect(credit!.amount).toBe(-3500);
    expect(c.depositCreditTotal).toBe(3500);
  });

  it("totals lines + deposits − returned deposits", () => {
    const c = composeInvoice({ lines: [half, sixth, cases], emptiesBySku: { CNT1AKHB01: 2 } });
    // (38400 + 19200 + 19020) + (7000 + 7000) − 7000
    expect(c.subtotal).toBe(76620);
    expect(c.depositTotal).toBe(14000);
    expect(c.depositCreditTotal).toBe(7000);
    expect(c.total).toBe(83620);
    expect(c.customerBalanceCredit).toBe(0);
  });

  it("carries the remainder as customer balance credit rather than a negative invoice", () => {
    // A pickup-only visit: nothing delivered, four empties collected. Stripe
    // will not finalize a negative invoice, so the excess must become account
    // credit instead of being silently dropped.
    const c = composeInvoice({ lines: [], emptiesBySku: { CNT1AKHB01: 4 }, defaultDepositAmount: 35 });
    expect(c.total).toBe(0);
    expect(c.customerBalanceCredit).toBe(14000);
  });

  it("never produces a negative total", () => {
    const c = composeInvoice({ lines: [sixth], emptiesBySku: { CNT1AKSB01: 40 } });
    expect(c.total).toBeGreaterThanOrEqual(0);
  });

  it("uses the SKU's own deposit when it differs from the default", () => {
    const odd = { ...half, depositAmount: 20 };
    const c = composeInvoice({ lines: [odd] });
    expect(c.depositTotal).toBe(4000); // 2 × $20
  });

  it("keeps the lot number on the line's metadata for traceability", () => {
    const c = composeInvoice({ lines: [{ ...half, lotNumber: "L26CNT08" }] });
    expect(c.items[0].metadata.lotNumber).toBe("L26CNT08");
  });
});

describe("custom fields and footer", () => {
  it("always includes our own invoice number", () => {
    // Stripe's own numbering is immutable per account, so ours has to travel
    // here or it is not on the document at all.
    const f = buildCustomFields({
      invoiceNumber: "INV26277",
      deliveryDate: new Date("2026-08-31T17:00:00Z"),
      poDate: new Date("2026-08-28T17:00:00Z"),
      salesRep: "Jack Begley",
      licenseNumber: "5423xx",
    });
    expect(f.some((x) => x.name === "Invoice #" && x.value === "INV26277")).toBe(true);
  });

  it("respects Stripe's four-field cap without dropping the invoice number", () => {
    const f = buildCustomFields({
      invoiceNumber: "INV26277",
      deliveryDate: new Date(),
      poDate: new Date(),
      salesRep: "Jack Begley",
      licenseNumber: "5423xx",
    });
    expect(f).toHaveLength(4);
    expect(f[0].name).toBe("Invoice #");
  });

  it("omits fields with no value rather than printing a blank", () => {
    const f = buildCustomFields({ invoiceNumber: "INV26277" });
    expect(f).toHaveLength(1);
  });

  it("prints the tax-exempt line and both legal sentences verbatim", () => {
    const footer = buildFooter(true);
    expect(footer).toContain(TAX_EXEMPT_FOOTER);
    for (const sentence of LEGAL_FOOTER_SENTENCES) expect(footer).toContain(sentence);
    expect(footer).toContain("§ 25509");
    expect(footer).toContain("§ 25509.1");
  });

  it("drops only the tax line for a non-exempt account, keeping the legal text", () => {
    const footer = buildFooter(false);
    expect(footer).not.toContain(TAX_EXEMPT_FOOTER);
    for (const sentence of LEGAL_FOOTER_SENTENCES) expect(footer).toContain(sentence);
  });

  it("keeps the purchase-order email in the description", () => {
    expect(INVOICE_DESCRIPTION).toBe("For new purchase orders, please email orders@theleopardmark.com");
  });
});
