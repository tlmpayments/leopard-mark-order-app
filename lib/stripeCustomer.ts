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

export async function ensureStripeCustomer(accountId: string): Promise<string> {
  const account = await db.account.findUniqueOrThrow({
    where: { id: accountId },
    include: { contacts: true },
  });
  if (account.stripeCustomerId) return account.stripeCustomerId;

  const primaryContact =
    account.contacts.find((c) => c.email) ?? account.contacts[0];

  const customer = await stripe.customers.create({
    name: account.businessName,
    email: primaryContact?.email ?? undefined,
    metadata: { accountId: account.id },
  });

  await db.account.update({
    where: { id: accountId },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}

// Creates a Stripe Checkout Session in `setup` mode (bank account or card,
// no charge) and emails the hosted link to the account's ordering contact.
// Best-effort: an account with no contact email can't receive this today
// (logged, not thrown) -- ops still has ensureStripeCustomer's Stripe
// Customer to attach a payment method to manually via the Stripe dashboard
// in that case.
export async function sendPaymentSetupLink(accountId: string): Promise<void> {
  const account = await db.account.findUniqueOrThrow({
    where: { id: accountId },
    include: { contacts: true },
  });
  const customerId = await ensureStripeCustomer(accountId);
  const contact = account.contacts.find((c) => c.email);
  if (!contact?.email) {
    console.warn(
      `sendPaymentSetupLink: account ${accountId} ("${account.businessName}") has no contact email on file -- skipping.`,
    );
    return;
  }

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
    to: contact.email,
    subject: "Set up payment for your Leopard Mark wholesale account",
    html: `
      <p>Hi${contact.name ? ` ${contact.name}` : ""},</p>
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
}
