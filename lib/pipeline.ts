/**
 * The seven-stage order pipeline (docs/OPS-PLATFORM-BUILD-PROMPT.md §3).
 *
 * The single most important rule in this file: `OrderStatus` is NOT the
 * pipeline. `OrderStatus` is the *contract* lifecycle, and the compliance gate
 * `draft -> pending_confirmation -> confirmed` in it is legally load-bearing
 * (§1.1 of docs/CLAUDE-CODE-BUILD-PROMPT.md -- the customer's confirmation is
 * the moment of contract formation, and nothing downstream may fire before it).
 * Adding seven fulfillment values to that enum would tangle "did the customer
 * agree to buy this" together with "has the truck left yet", and the second
 * question would start being able to answer the first.
 *
 * So the stage ops sees is *derived* -- from fulfillment and billing facts that
 * live in their own columns -- by one pure function, `pipelineStage()`, with an
 * exhaustive test table. There is exactly one implementation of "what stage is
 * this order in", and it does no I/O.
 */

import type { OrderStatus } from "@/app/generated/prisma/enums";

/** ①..⑦ plus the two off-ramps. Ordered; index is the stage number - 1. */
export const PIPELINE_STAGES = [
  "account_setup", // ① account exists, first order not yet placed
  "new_order", // ② confirmed, no delivery scheduled, ops hasn't triaged
  "needs_scheduling", // ③ triaged / auto-proposed slot awaiting confirmation
  "scheduled", // ④ scheduledFor set, shipment planned
  "delivered", // ⑤ deliveredAt set, BOL issued, ledger DELIVERY events written
  "invoiced", // ⑥ Invoice.status in (open, uncollectible) -- sent to billing email
  "paid", // ⑦ Invoice.status = paid
] as const;

export type PipelineStage =
  | (typeof PIPELINE_STAGES)[number]
  | "blocked"
  | "cancelled";

/**
 * Why an order is blocked. Ordered by precedence, most serious first: an order
 * with an expired license AND a short warehouse is a `license_expired` problem,
 * because that is the one a human must clear before anything else matters.
 *
 * The first two are *compliance* blocks and are never auto-cleared -- see
 * `isComplianceBlock`.
 */
export const BLOCKED_REASONS = [
  "license_expired",
  "credit_hold",
  "approval_pending",
  "missing_billing_email",
  "stock_short",
  "payment_failed",
  "stripe_error",
  "sync_conflict",
] as const;

export type BlockedReason = (typeof BLOCKED_REASONS)[number];

const BLOCKED_REASON_SET: ReadonlySet<string> = new Set(BLOCKED_REASONS);

export function isBlockedReason(value: unknown): value is BlockedReason {
  return typeof value === "string" && BLOCKED_REASON_SET.has(value);
}

/**
 * License and credit blocks are decisions about whether we are *allowed* to
 * sell, and §1.3 requires the license gate to be able to stop an order the
 * credit check would allow. A machine may raise these; only a human may clear
 * them, and clearing is logged as an `order.unblocked` OrderEvent.
 */
export function isComplianceBlock(reason: BlockedReason): boolean {
  return reason === "license_expired" || reason === "credit_hold";
}

export const BLOCKED_REASON_LABELS: Record<BlockedReason, string> = {
  license_expired: "License expired",
  credit_hold: "Credit hold",
  approval_pending: "Account not approved",
  missing_billing_email: "No billing email on file",
  stock_short: "Not enough stock",
  payment_failed: "Payment failed",
  stripe_error: "Stripe error",
  sync_conflict: "Sheet sync conflict",
};

/** Human-readable stage names, exactly as the mockup labels them. */
export const STAGE_LABELS: Record<PipelineStage, string> = {
  account_setup: "Account set up",
  new_order: "New order",
  needs_scheduling: "Needs scheduling",
  scheduled: "Delivery scheduled",
  delivered: "Delivered · BOL",
  invoiced: "Invoiced",
  paid: "Paid",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

/**
 * `OrderEvent.eventType` vocabulary. Every stage transition and every
 * automation side effect appends one of these, so the hub's timeline and audit
 * trail are read from the table rather than reconstructed from logs (§2 rule 4).
 * §1.4 requires this to be append-only and never overwritten.
 */
export const ORDER_EVENT_TYPES = [
  "account.created",
  "account.approved",
  "account.stripe_customer_created",
  "account.setup_link_sent",
  "account.payment_method_added",
  "order.confirmed",
  "order.sheet_synced",
  "order.slack_posted",
  "order.stock_checked",
  "order.slot_proposed",
  "order.scheduled",
  "order.rescheduled",
  "shipment.delivered",
  "bol.issued",
  "inventory.events_written",
  "invoice.issued",
  "invoice.sent",
  "invoice.payment_failed",
  "invoice.paid",
  "order.blocked",
  "order.unblocked",
  "order.cancelled",
  "sync.conflict",
] as const;

export type OrderEventType = (typeof ORDER_EVENT_TYPES)[number];

/**
 * The narrow shape `pipelineStage` needs. Deliberately a structural type, not
 * a Prisma payload type: it keeps the function pure and trivially testable, and
 * it means a partially-selected query can still be staged.
 */
export interface OrderPipelineFacts {
  status: OrderStatus;
  createdAt: Date;
  submittedAt?: Date | null;
  confirmedAt?: Date | null;
  /** Set when ops (or auto-schedule) books a delivery slot. */
  scheduledFor?: Date | null;
  /** Set when the warehouse marks the delivery complete. */
  deliveredAt?: Date | null;
  blockedReason?: string | null;
  blockedAt?: Date | null;
  /** The proposal from `auto_propose_slot`, awaiting a human's acceptance. */
  proposedSlotAt?: Date | null;
  invoice?: {
    status: string;
    sentAt?: Date | null;
    paidAt?: Date | null;
    createdAt?: Date | null;
  } | null;
}

export interface PipelineStageResult {
  stage: PipelineStage;
  /** When the order entered this stage -- drives "age in stage" in the hub. */
  since: Date;
  /** Present only when `stage === "blocked"` or an overlay applies. */
  blockedReason?: BlockedReason;
  /**
   * The stage the order would be in if it were not blocked. The hub renders the
   * stage chip AND a red blocked stripe, because "blocked" alone doesn't tell
   * ops whether a truck is booked.
   */
  underlyingStage?: PipelineStage;
}

/**
 * Stripe invoice statuses that mean "the customer has been billed and we are
 * waiting to be paid". `uncollectible` counts as invoiced, not paid: we sent it
 * and gave up on collection, which is an AR problem, not a fulfillment one.
 */
const INVOICED_STATUSES: ReadonlySet<string> = new Set(["open", "uncollectible"]);

/**
 * Derive the pipeline stage from an order's facts. Pure: no I/O, no clock read.
 *
 * Order of decision matters and is asserted in __tests__/pipeline.test.ts:
 *   1. `cancelled`/`rejected`/`expired` are terminal and outrank everything --
 *      a cancelled order is not "blocked", it's over.
 *   2. A `blockedReason` becomes a `blocked` stage, carrying the stage it would
 *      otherwise be in as `underlyingStage`.
 *   3. Otherwise walk backwards from ⑦, because the furthest fact that is true
 *      is the stage: paid -> invoiced -> delivered -> scheduled ->
 *      needs_scheduling -> new_order -> account_setup.
 */
export function pipelineStage(o: OrderPipelineFacts): PipelineStageResult {
  // 1. Terminal states.
  if (o.status === "cancelled" || o.status === "rejected" || o.status === "expired") {
    return { stage: "cancelled", since: o.blockedAt ?? o.createdAt };
  }

  const underlying = derivePositiveStage(o);

  // 2. Blocked overlay.
  if (o.blockedReason) {
    // An unrecognised reason string still blocks -- failing open here would
    // hide a real problem from ops -- but it is normalised to stripe_error so
    // the UI always has a label to render.
    const reason = isBlockedReason(o.blockedReason) ? o.blockedReason : "stripe_error";
    return {
      stage: "blocked",
      since: o.blockedAt ?? underlying.since,
      blockedReason: reason,
      underlyingStage: underlying.stage,
    };
  }

  return underlying;
}

function derivePositiveStage(o: OrderPipelineFacts): PipelineStageResult {
  // The contract gate outranks every fulfillment and billing fact. §1.1 makes
  // the customer's confirmation the moment of contract formation, so an order
  // that has not passed `confirmed` must never *appear* to be moving through
  // fulfillment, however its other columns look. In real data this costs
  // nothing -- even the 272 historical orders backfilled out of the Sheet are
  // written as `confirmed` (scripts/backfill-sheet-orders.ts) -- so an
  // unconfirmed order carrying a deliveredAt is corrupt data, and pinning it
  // at ① is what makes it visible as such instead of laundering it into ⑤.
  if (o.status === "draft" || o.status === "pending_confirmation") {
    return { stage: "account_setup", since: o.submittedAt ?? o.createdAt };
  }

  const inv = o.invoice;

  // ⑦ Paid. Stripe is the truth for payment state; `Invoice` mirrors it.
  if (inv && inv.status === "paid") {
    return { stage: "paid", since: inv.paidAt ?? inv.createdAt ?? o.createdAt };
  }

  // ⑥ Invoiced. A `local_error` invoice row means our own Stripe call failed,
  // so the order has NOT reached ⑥ -- it is still a delivered order that owes
  // an invoice, which is exactly what the attention queue needs to surface.
  if (inv && INVOICED_STATUSES.has(inv.status)) {
    return { stage: "invoiced", since: inv.sentAt ?? inv.createdAt ?? o.createdAt };
  }

  // ⑤ Delivered.
  if (o.deliveredAt) {
    return { stage: "delivered", since: o.deliveredAt };
  }

  // ④ Delivery scheduled.
  if (o.scheduledFor) {
    return { stage: "scheduled", since: o.scheduledFor };
  }

  // ③ Needs scheduling -- a slot has been proposed and awaits a human.
  if (o.proposedSlotAt) {
    return { stage: "needs_scheduling", since: o.proposedSlotAt };
  }

  // ② New order -- confirmed, untriaged.
  return { stage: "new_order", since: o.confirmedAt ?? o.submittedAt ?? o.createdAt };
}

/**
 * Stage index for sorting and for the sequential blue->white chip ramp in the
 * UI. Blocked reports the index of the stage it is blocking, so a blocked card
 * stays in its own column on the board rather than jumping to the end.
 */
export function stageIndex(result: PipelineStageResult): number {
  const key = result.stage === "blocked" ? (result.underlyingStage ?? "new_order") : result.stage;
  if (key === "cancelled") return PIPELINE_STAGES.length;
  const i = (PIPELINE_STAGES as readonly string[]).indexOf(key);
  return i === -1 ? 0 : i;
}

/** The `s1`..`s7` CSS class the stage chip uses (see app/ops/ops.css). */
export function stageToneClass(result: PipelineStageResult): string {
  if (result.stage === "blocked") return "blocked";
  if (result.stage === "cancelled") return "cancelled";
  return `s${stageIndex(result) + 1}`;
}
