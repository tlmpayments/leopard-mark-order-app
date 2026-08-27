// Phase 2 (Sheet <-> Postgres sync) DB -> Sheet direction. syncOrderToSheet
// itself was previously only verified via a throwaway scratch script (per
// the implementing agent's report) -- this is its first permanent test
// coverage, added specifically to cover the sheetRowNumber persistence fix
// from adversarial review (an earlier version had no way to know which
// Sheet row a given line landed on, which is what made the webhook's Lot #
// handling apply one row's value to every line of an order instead of just
// the one it belonged to).
//
// Mocks global.fetch rather than standing up a real Apps Script deployment
// -- this phase has none to test against yet; the wire-protocol shape
// itself is cross-checked byte-for-byte in sheet-sync-payload.test.ts.
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { syncOrderToSheet } from "../lib/sheetSync";
import { testDb, closeTestDb, createFixtureOrderWithTwoLines } from "./helpers";

const originalFetch = global.fetch;

describe("syncOrderToSheet", () => {
  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it("persists lineRows from a successful Apps Script response onto each OrderLine.sheetRowNumber, in request order", async () => {
    vi.stubEnv("APPS_SCRIPT_URL", "https://example.com/exec");
    vi.stubEnv("SYNC_SHARED_SECRET", "test-secret");

    // sheetRowNumber starts null here -- this call is what's supposed to set it.
    const { order, lineA, lineB } = await createFixtureOrderWithTwoLines([0, 0]);
    await testDb.orderLine.updateMany({ where: { orderId: order.id }, data: { sheetRowNumber: null } });

    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, alreadySynced: false, rowsAppended: 2, lineRows: [301, 302] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const result = await syncOrderToSheet(order.id);
    expect(result).toEqual({ ok: true, alreadySynced: false });

    // lineA/lineB were created with lineIndex 0/1 -- syncOrderToSheet queries
    // order.lines sorted by lineIndex ascending, so lineRows[0] belongs to
    // lineA and lineRows[1] to lineB, in that order.
    const updatedA = await testDb.orderLine.findUniqueOrThrow({ where: { id: lineA.id } });
    const updatedB = await testDb.orderLine.findUniqueOrThrow({ where: { id: lineB.id } });
    expect(updatedA.sheetRowNumber).toBe(301);
    expect(updatedB.sheetRowNumber).toBe(302);

    const updatedOrder = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(updatedOrder.sheetSyncedAt).not.toBeNull();

    const log = await testDb.syncLog.findFirst({
      where: { orderId: order.id, direction: "db_to_sheet", status: "success" },
    });
    expect(log).not.toBeNull();
  });

  it("an alreadySynced:true replay does not insert a second db_to_sheet success SyncLog row (would violate the partial unique index)", async () => {
    vi.stubEnv("APPS_SCRIPT_URL", "https://example.com/exec");
    vi.stubEnv("SYNC_SHARED_SECRET", "test-secret");
    const { order } = await createFixtureOrderWithTwoLines([301, 302]);

    await testDb.syncLog.create({
      data: { direction: "db_to_sheet", orderId: order.id, status: "success", conflict: false },
    });

    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, alreadySynced: true }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await syncOrderToSheet(order.id);
    expect(result).toEqual({ ok: true, alreadySynced: true });

    const count = await testDb.syncLog.count({
      where: { orderId: order.id, direction: "db_to_sheet", status: "success" },
    });
    expect(count).toBe(1); // still just the one seeded above -- no duplicate insert attempted
  });

  it("records an error SyncLog and returns ok:false when Apps Script reports failure", async () => {
    vi.stubEnv("APPS_SCRIPT_URL", "https://example.com/exec");
    vi.stubEnv("SYNC_SHARED_SECRET", "test-secret");
    const { order } = await createFixtureOrderWithTwoLines([301, 302]);

    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "Order ID column not found -- add it before syncing" }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const result = await syncOrderToSheet(order.id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Order ID column not found/);

    const log = await testDb.syncLog.findFirst({
      where: { orderId: order.id, direction: "db_to_sheet", status: "error" },
    });
    expect(log).not.toBeNull();
  });

  it("returns ok:false without a network call when APPS_SCRIPT_URL is not configured", async () => {
    vi.stubEnv("APPS_SCRIPT_URL", "");
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { order } = await createFixtureOrderWithTwoLines([301, 302]);
    const result = await syncOrderToSheet(order.id);
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
