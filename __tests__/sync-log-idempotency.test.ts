// Phase 2 (Sheet <-> Postgres sync) idempotency, exercised against a real
// local test Postgres (see README at top of the task / vitest.config.ts).
// syncOrderToSheet itself does network I/O (POSTs to the Apps Script web
// app) that this phase's test suite deliberately does not call -- instead
// this exercises the actual guard the idempotency design depends on: the
// partial unique index added in
// prisma/migrations/20260827204500_scope_sync_log_idempotency_to_db_to_sheet.
import { describe, it, expect, afterAll } from "vitest";
import { testDb, closeTestDb, createFixtureOrder } from "./helpers";

describe("Sheet sync idempotency (SyncLog partial unique index)", () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it("a successful db_to_sheet sync_log row makes a real 'already synced' query return true", async () => {
    const { order } = await createFixtureOrder();
    await testDb.syncLog.create({
      data: { direction: "db_to_sheet", orderId: order.id, status: "success", conflict: false },
    });

    const existing = await testDb.syncLog.findFirst({
      where: { orderId: order.id, direction: "db_to_sheet", status: "success" },
    });
    expect(existing).not.toBeNull();

    const forADifferentOrder = await testDb.syncLog.findFirst({
      where: { orderId: "not-a-real-order-id", direction: "db_to_sheet", status: "success" },
    });
    expect(forADifferentOrder).toBeNull();
  });

  it("the partial unique index rejects a second successful db_to_sheet sync_log row for the same order", async () => {
    const { order } = await createFixtureOrder();
    await testDb.syncLog.create({
      data: { direction: "db_to_sheet", orderId: order.id, status: "success", conflict: false },
    });

    await expect(
      testDb.syncLog.create({
        data: { direction: "db_to_sheet", orderId: order.id, status: "success", conflict: false },
      }),
    ).rejects.toThrow();

    const count = await testDb.syncLog.count({
      where: { orderId: order.id, direction: "db_to_sheet", status: "success" },
    });
    expect(count).toBe(1);
  });

  it("a prior 'error' status row never blocks a later successful retry (partial predicate, not a bare unique)", async () => {
    const { order } = await createFixtureOrder();
    await testDb.syncLog.create({
      data: { direction: "db_to_sheet", orderId: order.id, status: "error", conflict: false },
    });

    await expect(
      testDb.syncLog.create({
        data: { direction: "db_to_sheet", orderId: order.id, status: "success", conflict: false },
      }),
    ).resolves.toBeTruthy();
  });

  it("allows multiple successful sheet_to_db sync_log rows per order over its lifetime, unlike db_to_sheet", async () => {
    const { order } = await createFixtureOrder();
    await testDb.syncLog.create({
      data: { direction: "sheet_to_db", orderId: order.id, status: "success", conflict: false },
    });
    await expect(
      testDb.syncLog.create({
        data: { direction: "sheet_to_db", orderId: order.id, status: "success", conflict: false },
      }),
    ).resolves.toBeTruthy();

    const count = await testDb.syncLog.count({
      where: { orderId: order.id, direction: "sheet_to_db", status: "success" },
    });
    expect(count).toBe(2);
  });
});
