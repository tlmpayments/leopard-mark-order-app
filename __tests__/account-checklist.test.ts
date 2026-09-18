/**
 * The nine facts the first invoice needs (§8.4), and the billing-email
 * precedence from §6.2. Pure — no database.
 */
import { describe, expect, it } from "vitest";
import { CHECKLIST_ITEMS, accountChecklist, resolveBillingEmail } from "@/lib/ops/checklist";

const complete = {
  licenseNumber: "5423xx",
  licenseStatus: "active" as const,
  region: "BA",
  regionHasWarehouse: true,
  billingContactEmail: "ap@example.test",
  terms: "Net 30",
  paymentMethod: "ACH",
  stripeCustomerId: "cus_123",
  stripeDefaultPaymentMethod: "pm_123",
  firstOrderAt: new Date(),
};

describe("accountChecklist", () => {
  it("has nine items, in the order the invoice needs them", () => {
    expect(CHECKLIST_ITEMS).toHaveLength(9);
    expect(CHECKLIST_ITEMS[0]).toBe("License #");
    expect(CHECKLIST_ITEMS[8]).toBe("First order");
  });

  it("scores a fully set-up account 9/9 with nothing missing", () => {
    const r = accountChecklist(complete);
    expect(r.doneCount).toBe(9);
    expect(r.missing).toEqual([]);
    expect(r.blocksInvoice).toEqual([]);
  });

  it("scores an empty account 0/9", () => {
    expect(accountChecklist({}).doneCount).toBe(0);
  });

  it("does not count an unverified licence as verified, however good the credit is", () => {
    // §1.3: the licence gate is independent of payment standing and must be
    // able to block an order the credit check would allow.
    for (const status of ["unknown", "expired", "suspended"] as const) {
      const r = accountChecklist({ ...complete, licenseStatus: status });
      expect(r.missing).toContain("license verified");
    }
  });

  it("falls back to the ordering contact for the billing email", () => {
    const r = accountChecklist({ ...complete, billingContactEmail: null, contactEmail: "orders@example.test" });
    expect(r.missing).not.toContain("billing email");
    expect(r.doneCount).toBe(9);
  });

  it("counts the billing email missing when neither source has one", () => {
    const r = accountChecklist({ ...complete, billingContactEmail: null, contactEmail: null });
    expect(r.missing).toContain("billing email");
    expect(r.blocksInvoice).toContain("billing email");
  });

  it("does not let a missing payment method block the invoice", () => {
    // Stripe simply sends a payable link instead of auto-charging, so this is
    // an open setup item but not an invoicing blocker.
    const r = accountChecklist({ ...complete, paymentMethod: null, stripeDefaultPaymentMethod: null });
    expect(r.missing).toContain("payment method");
    expect(r.blocksInvoice).toEqual([]);
  });

  it("treats a region with no route schedule as an incomplete mapping", () => {
    const r = accountChecklist({ ...complete, regionHasWarehouse: false });
    expect(r.missing).toContain("region → warehouse");
  });
});

describe("resolveBillingEmail", () => {
  it("prefers the account's billing contact and records the source", () => {
    expect(resolveBillingEmail({ billingContactEmail: "ap@x.test", contactEmail: "o@x.test" })).toEqual({
      email: "ap@x.test",
      source: "account_billing_contact",
    });
  });

  it("falls back to the ordering contact", () => {
    expect(resolveBillingEmail({ contactEmail: "o@x.test" })).toEqual({
      email: "o@x.test",
      source: "ordering_contact",
    });
  });

  it("reports none rather than guessing", () => {
    expect(resolveBillingEmail({})).toEqual({ email: null, source: "none" });
  });
});
