/**
 * The job kinds, one per automation in §7 that does real work.
 *
 * Kept as a separate module from the runner and the handlers so that both the
 * enqueue side and the hub's UI can name a kind without importing handler code
 * (handlers reach Stripe, Slack and the Sheet; the UI must not).
 */
export const JOB_KINDS = [
  "ensure_stripe_customer",
  "send_payment_setup_link",
  "sync_order_to_sheet",
  "slack_new_order",
  "stock_check",
  "propose_delivery_slot",
  "issue_invoice",
  "write_delivery_to_sheet",
  "delivery_digest",
  "invoice_reminder",
  "reorder_alert",
  "keg_custody_nudge",
  "sheet_reconcile",
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

/**
 * Human-readable names. The hub shows these, never the snake_case key -- §13's
 * "every automation has a human-readable name in the hub".
 */
export const JOB_KIND_LABELS: Record<JobKind, string> = {
  ensure_stripe_customer: "Create Stripe customer",
  send_payment_setup_link: "Send ACH setup link",
  sync_order_to_sheet: "Sync order to Sheet",
  slack_new_order: "Post order to Slack",
  stock_check: "Check stock on confirm",
  propose_delivery_slot: "Propose delivery slot",
  issue_invoice: "Issue Stripe invoice",
  write_delivery_to_sheet: "Write delivery facts to Sheet",
  delivery_digest: "Tomorrow's deliveries digest",
  invoice_reminder: "Overdue invoice summary",
  reorder_alert: "Reorder alert",
  keg_custody_nudge: "Keg custody nudge",
  sheet_reconcile: "Nightly Sheet reconcile",
};

/**
 * Idempotency keys. The key IS the dedupe contract, so it is built here rather
 * than at each call site: `issue_invoice` for one order must produce the same
 * key whether it was enqueued by the delivery handler, a manual "Issue invoice
 * now" click, or the retry sweep -- otherwise a double-click bills twice.
 */
export function idempotencyKey(kind: JobKind, subject: string): string {
  return `${kind}:${subject}`;
}
