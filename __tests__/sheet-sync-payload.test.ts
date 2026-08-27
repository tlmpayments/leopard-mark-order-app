// Phase 2 (Sheet <-> Postgres sync). Pure unit test -- no DB, no network --
// for lib/sheetSync.ts's buildSyncOrderPayload: the single most likely place
// for the four independently-built Phase 2 pieces to silently disagree,
// since a naming mismatch here (e.g. `price` vs `unitPrice`) would break the
// real DB -> Sheet integration even though every piece's own tests pass in
// isolation. Cross-checked field-for-field against the shared design's
// `syncOrder` request body example.
import { describe, it, expect } from "vitest";
import { buildSyncOrderPayload } from "../lib/sheetSync";

describe("buildSyncOrderPayload matches the syncOrder wire protocol exactly", () => {
  it("produces the exact shape from the shared design's wire-protocol example", () => {
    const payload = buildSyncOrderPayload(
      {
        id: "01J8TESTORDERID00000000000",
        invoiceNumber: "INV26273",
        paymentMethod: "Fintech",
        inventorySource: "EWD",
        notes: "",
        invoiceStatus: "Pending",
        poDate: new Date("2026-08-27T00:00:00.000Z"),
      },
      [
        {
          productName: "Cantinesca",
          packagingFormat: "1/2 Barrel Keg (15.5 gal)",
          productCode: "CNT1AKHB01",
          qty: 2,
          price: 192.0,
          lineTotal: 384.0,
        },
      ],
      {
        businessName: "Business Name",
        licenseNumber: "123456",
        paymentMethod: null,
      },
      { name: "T. Gilbert" },
    );

    expect(payload).toEqual({
      action: "syncOrder",
      orderId: "01J8TESTORDERID00000000000",
      invoiceNumber: "INV26273",
      customer: "Business Name",
      licenseNumber: "123456",
      poDate: "2026-08-27",
      salesRep: "T. Gilbert",
      paymentMethod: "Fintech",
      inventorySource: "EWD",
      notes: "",
      invoiceStatus: "Pending",
      lines: [
        {
          productName: "Cantinesca",
          packagingFormat: "1/2 Barrel Keg (15.5 gal)",
          productCode: "CNT1AKHB01",
          qty: 2,
          price: 192.0,
          lineTotal: 384.0,
        },
      ],
    });
  });

  it("has exactly the top-level keys the wire protocol specifies -- no extra, none missing, none renamed", () => {
    const payload = buildSyncOrderPayload(
      {
        id: "id",
        invoiceNumber: null,
        paymentMethod: null,
        inventorySource: null,
        notes: null,
        invoiceStatus: null,
        poDate: null,
      },
      [],
      { businessName: "x", licenseNumber: null, paymentMethod: null },
      null,
    );

    // `secret` is deliberately NOT here -- it's injected by syncOrderToSheet
    // as an env var, never threaded through the pure payload builder (see
    // lib/sheetSync.ts's SyncOrderPayload type comment).
    expect(Object.keys(payload).sort()).toEqual(
      [
        "action",
        "customer",
        "invoiceNumber",
        "invoiceStatus",
        "inventorySource",
        "licenseNumber",
        "lines",
        "notes",
        "orderId",
        "paymentMethod",
        "poDate",
        "salesRep",
      ].sort(),
    );
  });

  it("has exactly the line-level keys the wire protocol specifies", () => {
    const payload = buildSyncOrderPayload(
      {
        id: "id",
        invoiceNumber: null,
        paymentMethod: null,
        inventorySource: null,
        notes: null,
        invoiceStatus: null,
        poDate: null,
      },
      [
        {
          productName: "P",
          packagingFormat: "F",
          productCode: "C",
          qty: 1,
          price: 1,
          lineTotal: 1,
        },
      ],
      { businessName: "x", licenseNumber: null, paymentMethod: null },
      null,
    );

    expect(Object.keys(payload.lines[0]).sort()).toEqual(
      ["lineTotal", "packagingFormat", "price", "productCode", "productName", "qty"].sort(),
    );
  });

  it("falls back to the account's on-file payment method only when the order hasn't computed its own yet", () => {
    const payload = buildSyncOrderPayload(
      {
        id: "id",
        invoiceNumber: null,
        paymentMethod: null,
        inventorySource: null,
        notes: null,
        invoiceStatus: null,
        poDate: null,
      },
      [],
      { businessName: "x", licenseNumber: null, paymentMethod: "ACH" },
      null,
    );
    expect(payload.paymentMethod).toBe("ACH");
  });

  it("formats poDate as YYYY-MM-DD regardless of time-of-day", () => {
    const payload = buildSyncOrderPayload(
      {
        id: "id",
        invoiceNumber: null,
        paymentMethod: null,
        inventorySource: null,
        notes: null,
        invoiceStatus: null,
        poDate: new Date("2026-01-05T23:59:59.000Z"),
      },
      [],
      { businessName: "x", licenseNumber: null, paymentMethod: null },
      null,
    );
    expect(payload.poDate).toBe("2026-01-05");
  });
});
