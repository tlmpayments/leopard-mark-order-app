/**
 * The account setup checklist (§8.4).
 *
 * These nine facts are not an arbitrary onboarding score: they are exactly what
 * the first invoice needs in order to send. That is why the checklist is what
 * gates stage ① -> ②, and why a missing item is shown as a specific missing
 * thing with a specific fix rather than a percentage.
 *
 * Pure so it can be asserted directly and reused by the rep app's Add Account
 * response (§9 item 1).
 */

import type { LicenseStatus } from "@/app/generated/prisma/enums";

export const CHECKLIST_ITEMS = [
  "License #",
  "License verified",
  "Region → warehouse",
  "Billing email",
  "Terms",
  "Payment method",
  "Stripe customer",
  "ACH on file",
  "First order",
] as const;

export type ChecklistItem = (typeof CHECKLIST_ITEMS)[number];

export interface ChecklistFacts {
  licenseNumber?: string | null;
  licenseStatus?: LicenseStatus | null;
  region?: string | null;
  billingContactEmail?: string | null;
  /** Fallback billing email: the ordering contact (§6.2). */
  contactEmail?: string | null;
  terms?: string | null;
  paymentMethod?: string | null;
  stripeCustomerId?: string | null;
  stripeDefaultPaymentMethod?: string | null;
  firstOrderAt?: Date | null;
  /** Whether a RouteSchedule row exists for this account's region. */
  regionHasWarehouse?: boolean;
}

export interface ChecklistResult {
  /** One boolean per CHECKLIST_ITEMS entry, in order. */
  done: boolean[];
  doneCount: number;
  /** Item names still outstanding, lowercased for inline prose. */
  missing: string[];
  /**
   * The subset that blocks the FIRST INVOICE specifically. A missing payment
   * method does not block invoicing (Stripe just sends a payable link instead
   * of auto-charging); a missing billing email does, because there is nowhere
   * to send it.
   */
  blocksInvoice: string[];
}

export function accountChecklist(f: ChecklistFacts): ChecklistResult {
  const billingEmail = f.billingContactEmail ?? f.contactEmail ?? null;

  const done: Array<[ChecklistItem, boolean]> = [
    ["License #", Boolean(f.licenseNumber)],
    // `unknown` is not verified. §1.3 makes the licence gate independent of
    // payment standing, so an unverified licence stays an open item however
    // good the account's credit is.
    ["License verified", f.licenseStatus === "active"],
    ["Region → warehouse", Boolean(f.region) && f.regionHasWarehouse !== false],
    ["Billing email", Boolean(billingEmail)],
    ["Terms", Boolean(f.terms)],
    ["Payment method", Boolean(f.paymentMethod)],
    ["Stripe customer", Boolean(f.stripeCustomerId)],
    ["ACH on file", Boolean(f.stripeDefaultPaymentMethod)],
    ["First order", Boolean(f.firstOrderAt)],
  ];

  const missing = done.filter(([, ok]) => !ok).map(([name]) => name.toLowerCase());
  const blocksInvoice = done
    .filter(([name, ok]) => !ok && (name === "Billing email" || name === "Stripe customer"))
    .map(([name]) => name.toLowerCase());

  return {
    done: done.map(([, ok]) => ok),
    doneCount: done.filter(([, ok]) => ok).length,
    missing,
    blocksInvoice,
  };
}

/** Resolve the billing email, recording which source won (§6.2). */
export function resolveBillingEmail(f: {
  billingContactEmail?: string | null;
  contactEmail?: string | null;
}): { email: string | null; source: "account_billing_contact" | "ordering_contact" | "none" } {
  if (f.billingContactEmail) return { email: f.billingContactEmail, source: "account_billing_contact" };
  if (f.contactEmail) return { email: f.contactEmail, source: "ordering_contact" };
  return { email: null, source: "none" };
}
