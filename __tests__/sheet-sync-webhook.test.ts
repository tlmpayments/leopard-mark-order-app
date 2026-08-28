// Phase 2 (Sheet <-> Postgres sync) Sheet -> DB direction. Exercises
// app/api/sheet-sync/webhook/route.ts's exported POST handler directly
// (construct a real Request, call POST(request)) against a live local test
// Postgres -- not a mock of the route, the actual route code.
import { describe, it, expect, afterAll } from "vitest";
import { POST } from "../app/api/sheet-sync/webhook/route";
import { testDb, closeTestDb, createFixtureOrder, createFixtureOrderWithTwoLines } from "./helpers";

const SECRET = process.env.SYNC_SHARED_SECRET!;

function webhookRequest(body: unknown, secret: string = SECRET): Request {
  return new Request("http://localhost/api/sheet-sync/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Sync-Secret": secret },
    body: JSON.stringify(body),
  });
}

describe("sheet-sync webhook: conflict resolution", () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it("rejects a request with the wrong (or missing) shared secret", async () => {
    const { order } = await createFixtureOrder();
    const res = await POST(
      webhookRequest(
        { source: "onedit", edits: [{ orderId: order.id, fields: { "BOL #": "x" } }] },
        "wrong-secret",
      ),
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("applies a Sheet-owned field and logs a conflict for a DB-owned field in the same edit, touching only the Sheet-owned one", async () => {
    const { order } = await createFixtureOrder();

    const res = await POST(
      webhookRequest({
        source: "onedit",
        edits: [
          {
            orderId: order.id,
            invoiceNumber: order.invoiceNumber,
            rowNumber: 296,
            fields: {
              "BOL #": "EWD-D-260828-05", // Sheet-owned
              Qty: 999, // DB-owned -- must never be applied
            },
          },
        ],
      }),
    );

    const json = await res.json();
    expect(json).toEqual({ ok: true, applied: 1, conflicts: 1 });

    const updated = await testDb.order.findUnique({ where: { id: order.id } });
    expect(updated?.bolNumber).toBe("EWD-D-260828-05");

    const logs = await testDb.syncLog.findMany({
      where: { orderId: order.id, direction: "sheet_to_db" },
      orderBy: { createdAt: "asc" },
    });

    const conflictLogs = logs.filter((l) => l.conflict);
    const appliedLogs = logs.filter((l) => !l.conflict && l.status === "success");

    expect(conflictLogs.length).toBe(1);
    expect(appliedLogs.length).toBe(1);

    // The conflict log carries the rejected field/value, never silently
    // dropped -- an ops/eng investigating later needs to see what was
    // attempted and refused.
    const conflictFields = conflictLogs[0].fieldsChanged as { fields?: Record<string, unknown> };
    expect(conflictFields.fields).toEqual({ Qty: 999 });

    const appliedFields = appliedLogs[0].fieldsChanged as { fields?: Record<string, unknown> };
    expect(appliedFields.fields).toEqual({ "BOL #": "EWD-D-260828-05" });
  });

  it("classifies a made-up/unrecognized column as a conflict, never silently accepting it", async () => {
    const { order } = await createFixtureOrder();

    const res = await POST(
      webhookRequest({
        source: "onedit",
        edits: [
          {
            orderId: order.id,
            fields: { "Some Made Up Column Nobody Approved": "sneaky value" },
          },
        ],
      }),
    );
    const json = await res.json();
    expect(json).toEqual({ ok: true, applied: 0, conflicts: 1 });

    const logs = await testDb.syncLog.findMany({
      where: { orderId: order.id, direction: "sheet_to_db", conflict: true },
    });
    expect(logs.length).toBe(1);
  });

  it("targets a Lot # edit at the ONE line whose sheetRowNumber matches this edit's row, leaving other lines untouched", async () => {
    // Adversarial review of an earlier version found Lot # applied via
    // updateMany({where:{orderId}}) -- one Sheet row's value silently and
    // permanently overwrote EVERY line's lot number, including lines whose
    // own distinct (and correct) value had just been set. Fixed by matching
    // on sheetRowNumber, which lib/sheetSync.ts now stamps onto each
    // OrderLine after every real syncOrder round trip.
    const { order, lineA, lineB } = await createFixtureOrderWithTwoLines([296, 297]);

    const res = await POST(
      webhookRequest({
        source: "onedit",
        edits: [{ orderId: order.id, rowNumber: 296, fields: { "Lot #": "LOT-A-ONLY" } }],
      }),
    );
    const json = await res.json();
    expect(json).toEqual({ ok: true, applied: 1, conflicts: 0 });

    const updatedA = await testDb.orderLine.findUniqueOrThrow({ where: { id: lineA.id } });
    const updatedB = await testDb.orderLine.findUniqueOrThrow({ where: { id: lineB.id } });
    expect(updatedA.lotNumber).toBe("LOT-A-ONLY");
    expect(updatedB.lotNumber).toBeNull(); // must NOT have been touched

    // A second edit for row 297 only updates line B, and doesn't disturb
    // line A's already-correct value.
    const res2 = await POST(
      webhookRequest({
        source: "onedit",
        edits: [{ orderId: order.id, rowNumber: 297, fields: { "Lot #": "LOT-B-ONLY" } }],
      }),
    );
    expect((await res2.json()).applied).toBe(1);
    const finalA = await testDb.orderLine.findUniqueOrThrow({ where: { id: lineA.id } });
    const finalB = await testDb.orderLine.findUniqueOrThrow({ where: { id: lineB.id } });
    expect(finalA.lotNumber).toBe("LOT-A-ONLY");
    expect(finalB.lotNumber).toBe("LOT-B-ONLY");
  });

  it("falls back to applying a Lot # edit to every line when no line has a matching sheetRowNumber yet (a pre-fix order, or one the backfill didn't stamp)", async () => {
    const { order } = await createFixtureOrder(); // single line, sheetRowNumber left null by this fixture

    const res = await POST(
      webhookRequest({
        source: "onedit",
        edits: [{ orderId: order.id, rowNumber: 999, fields: { "Lot #": "LOT-FALLBACK" } }],
      }),
    );
    const json = await res.json();
    expect(json).toEqual({ ok: true, applied: 1, conflicts: 0 });

    const lines = await testDb.orderLine.findMany({ where: { orderId: order.id } });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.lotNumber).toBe("LOT-FALLBACK");
    }
  });

  it("logs a Sheet-owned column with no backing schema field yet (e.g. a Tap Handle column) as accepted-but-unmapped, not a conflict", async () => {
    const { order } = await createFixtureOrder();

    const res = await POST(
      webhookRequest({
        source: "reconcile",
        edits: [{ orderId: order.id, fields: { "TLM Tap Handle": "Yes" } }],
      }),
    );
    const json = await res.json();
    // Not a conflict (it's Sheet-owned) and not counted as "applied" either
    // (nothing was actually written -- no schema column exists for it yet).
    expect(json).toEqual({ ok: true, applied: 0, conflicts: 0 });

    const logs = await testDb.syncLog.findMany({
      where: { orderId: order.id, direction: "sheet_to_db", status: "sheet_owned_unmapped" },
    });
    expect(logs.length).toBe(1);
    expect(logs[0].conflict).toBe(false);
  });

  it("falls back to matching by invoiceNumber when a row has no Order ID yet", async () => {
    const { order } = await createFixtureOrder();

    const res = await POST(
      webhookRequest({
        source: "onedit",
        edits: [{ invoiceNumber: order.invoiceNumber!, fields: { "Invoice Status": "Invoiced" } }],
      }),
    );
    const json = await res.json();
    expect(json).toEqual({ ok: true, applied: 1, conflicts: 0 });

    const updated = await testDb.order.findUnique({ where: { id: order.id } });
    expect(updated?.invoiceStatus).toBe("Invoiced");
  });

  it("drops (does not crash on) an edit that resolves to no order at all", async () => {
    const res = await POST(
      webhookRequest({
        source: "onedit",
        edits: [{ orderId: "does-not-exist", invoiceNumber: "INV-DOES-NOT-EXIST", fields: { "BOL #": "x" } }],
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, applied: 0, conflicts: 0 });
  });
});
