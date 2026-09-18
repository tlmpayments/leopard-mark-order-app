// The LA pilot must never send customer messages or touch live Stripe.
export function assertSandboxKey(key: string | undefined): void {
  if (!key || !/^(sk|rk)_test_/.test(key.trim())) throw new Error("Stripe pilot requires a sandbox test key. Live billing is disabled.");
}
export function assertInvoiceSendingEnabled(): void {
  throw new Error("Invoice sending is paused during the Stripe pilot. Prepare and review documents without sending.");
}

export function assertCustomerEmailsEnabled(): void {
  throw new Error("Customer emails are paused during the Stripe pilot.");
}

export function assertStripeMigrationEnabled(): void {
  throw new Error("Stripe customer migration is paused until a separate sandbox is configured.");
}
