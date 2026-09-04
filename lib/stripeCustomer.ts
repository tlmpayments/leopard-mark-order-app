// Stripe account linking (Phase 9 of
// /Users/jackbegley/.claude/plans/greedy-snuggling-clarke.md). One shared
// path for creating a Stripe Customer, called from both hook points --
// admin approval of a self-signed-up account (live today) and the rep-app
// addCustomer path (once Phase 3 Stage 2 ships) -- so the two call sites
// can never independently create duplicate Stripe Customers for the same
// account, the same principle the master plan already applies to
// addCustomer/updateCustomer field defaulting.
import { db } from "@/lib/db";
import { stripe } from "@/lib/stripeClient";
import { sendEmail, appBaseUrl } from "@/lib/email";
import { resolveBillingEmail } from "@/lib/ops/checklist";

export async function ensureStripeCustomer(accountId: string): Promise<string> {
  const account = await db.account.findUniqueOrThrow({
    where: { id: accountId },
    include: { contacts: { orderBy: { createdAt: "asc" } } },
  });
  if (account.stripeCustomerId) return account.stripeCustomerId;

  // resolveBillingEmail, not the first contact with an address: this has to
  // agree with lib/billing/issue.ts, which resolves the SAME way and then
  // corrects the Stripe customer's email to match at invoice time. Creating
  // the customer with the ordering contact and letting the first invoice
  // rewrite it meant the Stripe dashboard showed the wrong payer for the
  // whole gap between account creation and first delivery.
  const billing = resolveBillingEmail({
    billingContactEmail: account.billingContactEmail,
    contactEmail: account.contacts.find((c) => c.email)?.email ?? null,
  });

  const customer = await stripe.customers.create({
    name: account.businessName,
    email: billing.email ?? undefined,
    metadata: { accountId: account.id },
  });

  await db.account.update({
    where: { id: accountId },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}

// Creates a Stripe Checkout Session in `setup` mode (bank account or card,
// no charge) and emails the hosted link to the account's BILLING email.
//
// Billing email, not the ordering contact: whoever can authorise a bank
// debit is frequently not whoever places the beer order, which is the entire
// reason Account.billingContactEmail exists. This used to read
// `contacts.find(c => c.email)` directly, so an account with accounts-payable
// in billingContactEmail still had its ACH link mailed to the bar manager --
// and the invoice that followed went somewhere else again, since
// lib/billing/issue.ts has always resolved the billing email properly.
// resolveBillingEmail is now the single source of that precedence.
//
// Returns whether it actually sent, rather than returning void after a
// console.warn. An account with no address at all is a permanent data
// problem, not a transient failure: throwing would put it on the job
// runner's retry ladder and Slack-alert on the third attempt, and returning
// silently made the job log claim "setup link emailed" for an email that was
// never sent. The caller reports the skip instead (see lib/jobs/handlers.ts).
export async function sendPaymentSetupLink(
  accountId: string,
): Promise<{ sent: boolean; email: string | null; reason?: "no_billing_email" }> {
  // Oldest-first, matching /ops/accounts/[id] and ensureStripeCustomer: with
  // more than one emailed contact, "the ordering contact" has to resolve to
  // the same row in the screen that previews the recipient and the code that
  // mails it, and an unordered relation gives no such guarantee.
  const account = await db.account.findUniqueOrThrow({
    where: { id: accountId },
    include: { contacts: { orderBy: { createdAt: "asc" } } },
  });
  const customerId = await ensureStripeCustomer(accountId);
  const billing = resolveBillingEmail({
    billingContactEmail: account.billingContactEmail,
    contactEmail: account.contacts.find((c) => c.email)?.email ?? null,
  });
  if (!billing.email) {
    return { sent: false, email: null, reason: "no_billing_email" };
  }
  // Only used to personalise the greeting, and only when the address we
  // resolved is genuinely that contact's -- addressing an accounts-payable
  // inbox by the ordering contact's first name would be worse than no name.
  const contact = account.contacts.find((c) => c.email === billing.email);

  const base = appBaseUrl();
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: customerId,
    payment_method_types: ["us_bank_account", "card"],
    success_url: `${base}/customer?stripe=setup-complete`,
    cancel_url: `${base}/customer?stripe=setup-cancelled`,
  });
  if (!session.url) {
    throw new Error(`Stripe Checkout session ${session.id} has no url`);
  }

  await sendEmail({
    to: billing.email,
    subject: "Set up payment for your Leopard Mark wholesale account",
    html: `
      <p>Hi${contact?.name ? ` ${contact.name}` : ""},</p>
      <p>Add a payment method for <strong>${account.businessName}</strong>'s
      Leopard Mark wholesale account -- this lets us bill you automatically
      instead of mailing an invoice each time:</p>
      <p><a href="${session.url}">Add a payment method</a></p>
      <p>This link is one-time use. If it's expired, just ask your rep to
      resend it.</p>
    `,
  });

  await db.account.update({
    where: { id: accountId },
    data: { stripeSetupLinkSentAt: new Date() },
  });

  return { sent: true, email: billing.email };
}
