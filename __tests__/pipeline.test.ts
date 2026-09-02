/**
 * Table-driven coverage of pipelineStage() (docs/OPS-PLATFORM-BUILD-PROMPT.md
 * §11). This runs with no database: pipelineStage is pure by design, and that
 * is the whole reason the stage is derived rather than stored.
 */
import { describe, expect, it } from "vitest";
import {
  BLOCKED_REASONS,
  PIPELINE_STAGES,
  isComplianceBlock,
  pipelineStage,
  stageIndex,
  stageToneClass,
  type OrderPipelineFacts,
  type PipelineStage,
} from "@/lib/pipeline";
import type { OrderStatus } from "@/app/generated/prisma/enums";

const CREATED = new Date("2026-08-01T10:00:00Z");
const SUBMITTED = new Date("2026-08-02T10:00:00Z");
const CONFIRMED = new Date("2026-08-03T10:00:00Z");
const PROPOSED = new Date("2026-08-04T10:00:00Z");
const SCHEDULED = new Date("2026-08-05T10:00:00Z");
const DELIVERED = new Date("2026-08-06T10:00:00Z");
const SENT = new Date("2026-08-07T10:00:00Z");
const PAID = new Date("2026-08-08T10:00:00Z");
const BLOCKED_AT = new Date("2026-08-09T10:00:00Z");

function order(over: Partial<OrderPipelineFacts> = {}): OrderPipelineFacts {
  return {
    status: "confirmed",
    createdAt: CREATED,
    submittedAt: SUBMITTED,
    confirmedAt: CONFIRMED,
    ...over,
  };
}

describe("pipelineStage — the seven positive stages", () => {
  const cases: Array<[string, OrderPipelineFacts, PipelineStage, Date]> = [
    [
      "① draft order sits at account_setup, not new_order",
      order({ status: "draft", confirmedAt: null }),
      "account_setup",
      SUBMITTED,
    ],
    [
      "① pending_confirmation is still ① — the contract gate has not passed",
      order({ status: "pending_confirmation", confirmedAt: null }),
      "account_setup",
      SUBMITTED,
    ],
    ["② confirmed with nothing else is new_order", order(), "new_order", CONFIRMED],
    [
      "③ a proposed slot moves it to needs_scheduling",
      order({ proposedSlotAt: PROPOSED }),
      "needs_scheduling",
      PROPOSED,
    ],
    [
      "④ scheduledFor outranks a proposal",
      order({ proposedSlotAt: PROPOSED, scheduledFor: SCHEDULED }),
      "scheduled",
      SCHEDULED,
    ],
    [
      "⑤ deliveredAt outranks scheduledFor",
      order({ scheduledFor: SCHEDULED, deliveredAt: DELIVERED }),
      "delivered",
      DELIVERED,
    ],
    [
      "⑥ an open invoice outranks delivered",
      order({
        scheduledFor: SCHEDULED,
        deliveredAt: DELIVERED,
        invoice: { status: "open", sentAt: SENT },
      }),
      "invoiced",
      SENT,
    ],
    [
      "⑦ a paid invoice is the last stage",
      order({
        scheduledFor: SCHEDULED,
        deliveredAt: DELIVERED,
        invoice: { status: "paid", sentAt: SENT, paidAt: PAID },
      }),
      "paid",
      PAID,
    ],
  ];

  it.each(cases)("%s", (_name, facts, expectedStage, expectedSince) => {
    const result = pipelineStage(facts);
    expect(result.stage).toBe(expectedStage);
    expect(result.since).toEqual(expectedSince);
    expect(result.blockedReason).toBeUndefined();
  });
});

describe("pipelineStage — invoice status semantics", () => {
  const delivered = { scheduledFor: SCHEDULED, deliveredAt: DELIVERED };

  it("treats uncollectible as invoiced, not paid — it is an AR problem, not a fulfillment one", () => {
    const r = pipelineStage(order({ ...delivered, invoice: { status: "uncollectible", sentAt: SENT } }));
    expect(r.stage).toBe("invoiced");
  });

  it("does NOT advance past delivered on a local_error invoice row", () => {
    // local_error means OUR Stripe call failed. The customer has not been
    // billed, so the order still owes an invoice and must stay visible at ⑤.
    const r = pipelineStage(order({ ...delivered, invoice: { status: "local_error" } }));
    expect(r.stage).toBe("delivered");
  });

  it("does not advance on a draft invoice", () => {
    const r = pipelineStage(order({ ...delivered, invoice: { status: "draft" } }));
    expect(r.stage).toBe("delivered");
  });

  it("does not advance on a voided invoice", () => {
    const r = pipelineStage(order({ ...delivered, invoice: { status: "void" } }));
    expect(r.stage).toBe("delivered");
  });
});

describe("pipelineStage — blocked is an overlay, never a column", () => {
  it.each(BLOCKED_REASONS.map((r) => [r] as const))(
    "%s blocks but preserves the underlying stage",
    (reason) => {
      const r = pipelineStage(
        order({ scheduledFor: SCHEDULED, blockedReason: reason, blockedAt: BLOCKED_AT }),
      );
      expect(r.stage).toBe("blocked");
      expect(r.blockedReason).toBe(reason);
      expect(r.underlyingStage).toBe("scheduled");
      expect(r.since).toEqual(BLOCKED_AT);
    },
  );

  it("keeps a blocked card in its own board column via stageIndex", () => {
    const blocked = pipelineStage(order({ scheduledFor: SCHEDULED, blockedReason: "stock_short" }));
    const plain = pipelineStage(order({ scheduledFor: SCHEDULED }));
    expect(stageIndex(blocked)).toBe(stageIndex(plain));
  });

  it("normalises an unrecognised reason rather than failing open", () => {
    const r = pipelineStage(order({ blockedReason: "something_new_from_the_sheet" }));
    expect(r.stage).toBe("blocked");
    expect(r.blockedReason).toBe("stripe_error");
  });

  it("can block an order that is already invoiced (payment_failed)", () => {
    const r = pipelineStage(
      order({
        deliveredAt: DELIVERED,
        invoice: { status: "open", sentAt: SENT },
        blockedReason: "payment_failed",
      }),
    );
    expect(r.stage).toBe("blocked");
    expect(r.underlyingStage).toBe("invoiced");
  });

  it("falls back to the underlying stage's timestamp when blockedAt is unset", () => {
    const r = pipelineStage(order({ deliveredAt: DELIVERED, blockedReason: "stock_short" }));
    expect(r.since).toEqual(DELIVERED);
  });

  it("marks exactly license_expired and credit_hold as compliance blocks", () => {
    const compliance = BLOCKED_REASONS.filter(isComplianceBlock);
    expect(compliance).toEqual(["license_expired", "credit_hold"]);
  });
});

describe("pipelineStage — terminal states outrank everything", () => {
  it.each([["cancelled"], ["rejected"], ["expired"]] as Array<[OrderStatus]>)(
    "%s is cancelled even when delivered, invoiced and blocked",
    (status) => {
      const r = pipelineStage(
        order({
          status,
          scheduledFor: SCHEDULED,
          deliveredAt: DELIVERED,
          invoice: { status: "paid", paidAt: PAID },
          blockedReason: "license_expired",
        }),
      );
      expect(r.stage).toBe("cancelled");
      expect(r.blockedReason).toBeUndefined();
    },
  );
});

describe("pipelineStage — exhaustive combination sweep", () => {
  // Every (status x scheduledFor x deliveredAt x invoice.status x blocked)
  // combination, as §11 requires. The assertion is not a second copy of the
  // rules -- it is the invariants that must hold for ALL of them.
  const statuses: OrderStatus[] = [
    "draft",
    "pending_confirmation",
    "confirmed",
    "scheduled",
    "fulfilled",
    "cancelled",
    "rejected",
    "expired",
  ];
  const invoiceStatuses = [null, "draft", "open", "uncollectible", "paid", "void", "local_error"];
  const allStages = new Set<string>([...PIPELINE_STAGES, "blocked", "cancelled"]);

  const combos: OrderPipelineFacts[] = [];
  for (const status of statuses) {
    for (const sched of [null, SCHEDULED]) {
      for (const del of [null, DELIVERED]) {
        for (const invStatus of invoiceStatuses) {
          for (const blocked of [null, "stock_short"]) {
            combos.push(
              order({
                status,
                scheduledFor: sched,
                deliveredAt: del,
                blockedReason: blocked,
                invoice: invStatus ? { status: invStatus, sentAt: SENT, paidAt: PAID } : null,
              }),
            );
          }
        }
      }
    }
  }

  it("covers 448 combinations", () => {
    expect(combos).toHaveLength(8 * 2 * 2 * 7 * 2);
  });

  it("always returns a known stage, a real date, and a valid index", () => {
    for (const facts of combos) {
      const r = pipelineStage(facts);
      expect(allStages.has(r.stage)).toBe(true);
      expect(r.since).toBeInstanceOf(Date);
      expect(Number.isNaN(r.since.getTime())).toBe(false);
      expect(stageIndex(r)).toBeGreaterThanOrEqual(0);
      expect(stageIndex(r)).toBeLessThanOrEqual(PIPELINE_STAGES.length);
      expect(stageToneClass(r)).toMatch(/^(s[1-7]|blocked|cancelled)$/);
    }
  });

  it("reports a blockedReason exactly when the stage is blocked", () => {
    for (const facts of combos) {
      const r = pipelineStage(facts);
      expect(Boolean(r.blockedReason)).toBe(r.stage === "blocked");
    }
  });

  it("never reports blocked for a terminal order, even with a blockedReason set", () => {
    for (const facts of combos) {
      if (facts.status === "cancelled" || facts.status === "rejected" || facts.status === "expired") {
        expect(pipelineStage(facts).stage).toBe("cancelled");
      }
    }
  });

  it("never shows an unconfirmed order as progressing, whatever its other columns say", () => {
    // The compliance invariant from §1.1: passing the contract gate is a
    // precondition for appearing anywhere past ①. Corrupt data (a draft order
    // carrying a deliveredAt) must surface as stuck at ①, not laundered into ⑤.
    for (const facts of combos) {
      if (facts.status !== "draft" && facts.status !== "pending_confirmation") continue;
      const r = pipelineStage(facts);
      expect(r.stage === "account_setup" || r.stage === "blocked").toBe(true);
      if (r.stage === "blocked") expect(r.underlyingStage).toBe("account_setup");
    }
  });
});
