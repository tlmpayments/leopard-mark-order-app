import { beforeEach, describe, expect, it, vi } from "vitest";

// Two things to pin: the definition itself, and that the route builder's query
// is built from it -- the builder's copy once lacked `deliveryDate` and offered
// every imported order from weeks ago.
const findMany = vi.fn();
vi.mock("@/lib/db", () => ({ db: { order: { findMany: (...a: unknown[]) => findMany(...a) } } }));

import { AWAITING_SCHEDULING_WHERE } from "@/lib/awaitingScheduling";
import { candidateOrdersForDay } from "@/lib/routes";

beforeEach(() => findMany.mockReset());

describe("orders awaiting delivery", () => {
  it("means: no delivery date anywhere, not delivered, not dead, not sheet history", () => {
    expect(AWAITING_SCHEDULING_WHERE.scheduledFor).toBeNull();
    expect(AWAITING_SCHEDULING_WHERE.deliveredAt).toBeNull();
    expect(AWAITING_SCHEDULING_WHERE.deliveryDate).toBeNull();
    expect(AWAITING_SCHEDULING_WHERE.status).toEqual({ notIn: ["cancelled", "rejected", "expired", "draft"] });
    expect(AWAITING_SCHEDULING_WHERE.NOT).toEqual({ invoice: { is: { stripeInvoiceId: { startsWith: "sheet:" } } } });
  });

  it("is what the route builder offers, plus only what is dated for that one day", async () => {
    findMany.mockResolvedValue([]);
    await candidateOrdersForDay("2026-09-30", "LA");
    const where = findMany.mock.calls[0][0].where;
    expect(where.routeStop).toEqual({ is: null });
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toBe(AWAITING_SCHEDULING_WHERE);
    // The second group is bounded to the day and is never "delivered".
    expect(where.OR[1].deliveredAt).toBeNull();
    expect(where.OR[1].scheduledFor).toEqual({ gte: expect.any(Date), lt: expect.any(Date) });
  });

  it("no longer offers an order merely because it has no scheduled day", async () => {
    findMany.mockResolvedValue([]);
    await candidateOrdersForDay("2026-09-30", "LA");
    const where = findMany.mock.calls[0][0].where;
    // The old rule had a bare `{ scheduledFor: null }` branch. There must not be one.
    expect(where.OR).not.toContainEqual({ scheduledFor: null });
  });
});
