/**
 * Who the ACH setup link is actually mailed to (lib/stripeCustomer.ts).
 *
 * This is asserted because it was wrong, and wrong in a way nothing surfaced.
 * sendPaymentSetupLink read `contacts.find(c => c.email)` directly while
 * lib/billing/issue.ts resolved the billing email properly, so an account
 * with accounts-payable in billingContactEmail got its bank-authorisation
 * link mailed to whoever places the beer orders -- and the invoice that
 * followed went somewhere else again. Money path, silent failure, no alert.
 *
 * Mocked rather than run against Postgres (unlike the rest of this suite):
 * the fact under test is a recipient-selection decision, and a live DB adds
 * nothing to it. That also means these run without a local database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUniqueOrThrow = vi.fn();
const update = vi.fn();
const sessionsCreate = vi.fn();
const customersCreate = vi.fn();
const sendEmail = vi.fn();

vi.mock("@/lib/db", () => ({
  db: { account: { findUniqueOrThrow, update } },
}));
vi.mock("@/lib/stripeClient", () => ({
  stripe: {
    checkout: { sessions: { create: sessionsCreate } },
    customers: { create: customersCreate },
  },
}));
vi.mock("@/lib/email", () => ({
  sendEmail,
  appBaseUrl: () => "https://example.test",
}));

const { sendPaymentSetupLink } = await import("@/lib/stripeCustomer");

/** An account that already has a Stripe customer, so only the email matters. */
function account(over: Record<string, unknown>) {
  return {
    id: "acct_1",
    businessName: "Frankie's Bar",
    stripeCustomerId: "cus_existing",
    billingContactEmail: null,
    contacts: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionsCreate.mockResolvedValue({ id: "cs_1", url: "https://stripe.test/setup" });
  update.mockResolvedValue({});
  sendEmail.mockResolvedValue(undefined);
});

describe("sendPaymentSetupLink recipient", () => {
  it("mails the account's billing contact, not the ordering contact", async () => {
    findUniqueOrThrow.mockResolvedValue(
      account({
        billingContactEmail: "ap@frankies.test",
        contacts: [{ name: "Marisol", email: "marisol@frankies.test" }],
      }),
    );

    const result = await sendPaymentSetupLink("acct_1");

    expect(result).toEqual({ sent: true, email: "ap@frankies.test" });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].to).toBe("ap@frankies.test");
  });

  it("does not greet the AP inbox by the ordering contact's name", async () => {
    // The old code always had a contact in hand, so it interpolated that
    // name. Addressing accounts payable as "Hi Marisol" is worse than no
    // greeting, so the name is only used when the address is that contact's.
    findUniqueOrThrow.mockResolvedValue(
      account({
        billingContactEmail: "ap@frankies.test",
        contacts: [{ name: "Marisol", email: "marisol@frankies.test" }],
      }),
    );

    await sendPaymentSetupLink("acct_1");

    expect(sendEmail.mock.calls[0][0].html).not.toContain("Marisol");
  });

  it("falls back to the ordering contact when there is no billing contact", async () => {
    findUniqueOrThrow.mockResolvedValue(
      account({ contacts: [{ name: "Marisol", email: "marisol@frankies.test" }] }),
    );

    const result = await sendPaymentSetupLink("acct_1");

    expect(result.email).toBe("marisol@frankies.test");
    expect(sendEmail.mock.calls[0][0].to).toBe("marisol@frankies.test");
    // Its own address, so the greeting is welcome here.
    expect(sendEmail.mock.calls[0][0].html).toContain("Marisol");
  });

  it("skips a contact row that has no address rather than reporting 'cannot send'", async () => {
    // /ops/billing/setup-links used to read one arbitrary contact; if that
    // row had no email the screen claimed the account was unsendable even
    // though another contact could receive it.
    findUniqueOrThrow.mockResolvedValue(
      account({
        contacts: [
          { name: "Front of house", email: null },
          { name: "Marisol", email: "marisol@frankies.test" },
        ],
      }),
    );

    const result = await sendPaymentSetupLink("acct_1");

    expect(result.email).toBe("marisol@frankies.test");
  });
});

describe("sendPaymentSetupLink with no address at all", () => {
  beforeEach(() => {
    findUniqueOrThrow.mockResolvedValue(account({}));
  });

  it("reports the skip instead of claiming it sent", async () => {
    const result = await sendPaymentSetupLink("acct_1");
    expect(result).toEqual({ sent: false, email: null, reason: "no_billing_email" });
  });

  it("sends nothing", async () => {
    await sendPaymentSetupLink("acct_1");
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not stamp stripeSetupLinkSentAt", async () => {
    // The 7-day resend guard keys off this timestamp. Stamping it for an
    // email that was never sent would lock the account out of a real
    // resend for a week.
    await sendPaymentSetupLink("acct_1");
    expect(update).not.toHaveBeenCalled();
  });

  it("burns no Stripe Checkout session", async () => {
    await sendPaymentSetupLink("acct_1");
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});
