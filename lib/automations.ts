/**
 * The automation rule registry (§7).
 *
 * Every automation is a row in `AutomationRule` with a toggle, and code asks
 * this module whether it may run. Nothing hardcodes "on" -- §13: "if ops can't
 * see it, it doesn't run". The registry below is the catalogue the hub renders
 * at /ops/automations and the seed source for the table.
 */

import { db } from "@/lib/db";

export interface AutomationDefinition {
  key: string;
  /** The name ops sees. Never the key. */
  name: string;
  /** What fires it. */
  trigger: string;
  /** What it does, in one sentence, in ops's language. */
  does: string;
  defaultEnabled: boolean;
  /**
   * Some rules are load-bearing rather than optional: turning off the Sheet
   * mirror would silently desynchronise the spreadsheet the business still
   * runs on. Those render without a toggle.
   */
  toggleable: boolean;
  group: "account" | "order" | "delivery" | "billing" | "inventory" | "sheet";
}

export const AUTOMATION_RULES: readonly AutomationDefinition[] = [
  {
    key: "auto_stripe_customer_on_account",
    name: "Create Stripe customer on new account",
    trigger: "account.created / approved",
    does: "Creates the Stripe customer through the single ensureStripeCustomer choke-point.",
    defaultEnabled: true,
    toggleable: true,
    group: "account",
  },
  {
    key: "auto_send_setup_link",
    name: "Send ACH setup link",
    trigger: "Stripe customer without a payment method",
    does: "Emails a Stripe Checkout setup link to the billing email. Never twice within 7 days.",
    defaultEnabled: true,
    toggleable: true,
    group: "account",
  },
  {
    key: "sheet_sync_order",
    name: "Sheet sync — orders",
    trigger: "order.confirmed",
    does: "Writes the order to the Sales tab within seconds; Sheet edits flow back by ownership rule.",
    defaultEnabled: true,
    // Not toggleable: the Sheet is still the spreadsheet the business reads.
    // A toggle here is a foot-gun disguised as a feature.
    toggleable: false,
    group: "sheet",
  },
  {
    key: "slack_new_order",
    name: "Slack — new order / first order",
    trigger: "order.confirmed",
    does: "Posts to the region's channel and keeps the thread for later replies.",
    defaultEnabled: true,
    toggleable: true,
    group: "order",
  },
  {
    key: "stock_check_on_confirm",
    name: "Stock check on confirm",
    trigger: "order.confirmed",
    does: "Compares lines against available-for-delivery at the inventory source; blocks when short.",
    defaultEnabled: true,
    toggleable: true,
    group: "inventory",
  },
  {
    key: "auto_propose_slot",
    name: "Propose delivery slot",
    trigger: "order.confirmed and not blocked",
    does: "Picks the next route day for the region, honouring the cutoff and the account's window.",
    defaultEnabled: true,
    toggleable: true,
    group: "delivery",
  },
  {
    key: "auto_invoice_on_delivery",
    name: "Invoice on delivery",
    trigger: "shipment.delivered",
    does: "Issues and sends the Stripe invoice to the billing email. Net 30 from delivery.",
    defaultEnabled: true,
    toggleable: true,
    group: "billing",
  },
  {
    key: "delivery_digest",
    name: "Tomorrow's deliveries digest",
    trigger: "16:00 PT daily",
    does: "Posts each region's next-day deliveries to Slack with a print-batch link.",
    defaultEnabled: true,
    toggleable: true,
    group: "delivery",
  },
  {
    key: "invoice_reminder",
    name: "Overdue invoice summary",
    trigger: "Daily",
    does: "Posts a Slack summary of invoices more than 7 days overdue. Stripe handles the dunning email.",
    defaultEnabled: true,
    toggleable: true,
    group: "billing",
  },
  {
    key: "reorder_alert",
    name: "Reorder alerts",
    trigger: "After any inventory event",
    does: "Flags any SKU × warehouse below its reorder threshold.",
    defaultEnabled: true,
    toggleable: true,
    group: "inventory",
  },
  {
    key: "keg_custody_nudge",
    name: "Keg custody nudge",
    trigger: "Weekly",
    does: "DMs the rep about accounts holding kegs for more than 60 days.",
    defaultEnabled: false,
    toggleable: true,
    group: "inventory",
  },
  {
    key: "sheet_reconcile",
    name: "Nightly Sheet reconcile",
    trigger: "02:00 daily",
    does: "Full diff of every mirrored tab; conflicts land in the attention queue.",
    defaultEnabled: true,
    toggleable: true,
    group: "sheet",
  },
];

/**
 * Per-region auto-scheduling. Defaults OFF for every region: accepting a
 * delivery slot without a human is the one automation here that can put a
 * truck on the road, so it is opt-in per region once ops trusts the proposals.
 */
export function autoScheduleKey(region: string): string {
  return `auto_schedule_region:${region}`;
}

export function autoScheduleDefinition(region: string): AutomationDefinition {
  return {
    key: autoScheduleKey(region),
    name: `Auto-schedule · ${region}`,
    trigger: "Slot proposed",
    does: "Accepts the proposed slot without a human.",
    defaultEnabled: false,
    toggleable: true,
    group: "delivery",
  };
}

const DEFAULTS = new Map(AUTOMATION_RULES.map((r) => [r.key, r.defaultEnabled]));

/**
 * Is this automation allowed to run right now?
 *
 * A missing row falls back to the registry default rather than to `true`, so a
 * rule that has never been seeded cannot quietly run in a state ops has not
 * seen. Unknown keys are off: if it is not in the catalogue, it is not visible
 * in the hub, and per §13 that means it does not run.
 */
export async function isAutomationEnabled(key: string): Promise<boolean> {
  const row = await db.automationRule.findUnique({ where: { key }, select: { enabled: true } });
  if (row) return row.enabled;
  if (key.startsWith("auto_schedule_region:")) return false;
  return DEFAULTS.get(key) ?? false;
}

export async function automationConfig<T = Record<string, unknown>>(key: string): Promise<T | null> {
  const row = await db.automationRule.findUnique({ where: { key }, select: { configJson: true } });
  return (row?.configJson as T) ?? null;
}

/** Idempotent seed, safe to re-run. Existing toggles are never overwritten. */
export async function seedAutomationRules(regions: string[] = []): Promise<number> {
  const defs = [...AUTOMATION_RULES, ...regions.map(autoScheduleDefinition)];
  let created = 0;
  for (const def of defs) {
    const existing = await db.automationRule.findUnique({ where: { key: def.key } });
    if (existing) continue;
    await db.automationRule.create({ data: { key: def.key, enabled: def.defaultEnabled } });
    created += 1;
  }
  return created;
}
