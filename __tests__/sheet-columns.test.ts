// Phase 2 (Sheet <-> Postgres sync) column ownership classifier
// (lib/sheetColumns.ts) -- must classify every single column named in the
// shared design's two ownership lists correctly, and must never silently
// accept a column the design didn't account for.
import { describe, it, expect } from "vitest";
import { classifyColumn, DB_OWNED_COLUMNS, SHEET_OWNED_COLUMNS } from "../lib/sheetColumns";

// The exact two lists from the shared design context this phase was built
// against -- duplicated here (not imported) so this test also catches
// lib/sheetColumns.ts silently drifting from the design, not just internal
// self-consistency.
const EXPECTED_DB_OWNED = [
  "Customer",
  "License Number",
  "PO Date",
  "Product Name",
  "Packaging Format",
  "Product Code",
  "Qty",
  "Price (ea)",
  "Line Total",
  "Sales Rep",
  "Invoice #",
  "Order ID",
  "Inventory Source",
  "Payment Method",
];

const EXPECTED_SHEET_OWNED = [
  "Delivery (Invoice) Date",
  "Lot #",
  "BOL #",
  "ACH Invoice REF #",
  "Invoice Status",
  "TLM Tap Handle",
  "SGB Tap Handle",
  "CNT Tap Handle",
  "MicroStar 1/2 Empty",
  "MicroStar 1/6 Empty",
  "Notes",
];

describe("classifyColumn: DB-owned list from the shared design", () => {
  it("lib/sheetColumns.ts's DB_OWNED_COLUMNS matches the shared design exactly (same set, no extra/missing)", () => {
    expect([...DB_OWNED_COLUMNS].sort()).toEqual([...EXPECTED_DB_OWNED].sort());
  });

  it.each(EXPECTED_DB_OWNED)("classifies %s as db_owned", (col) => {
    expect(classifyColumn(col)).toBe("db_owned");
  });
});

describe("classifyColumn: Sheet-owned list from the shared design", () => {
  it("lib/sheetColumns.ts's SHEET_OWNED_COLUMNS matches the shared design exactly (same set, no extra/missing)", () => {
    expect([...SHEET_OWNED_COLUMNS].sort()).toEqual([...EXPECTED_SHEET_OWNED].sort());
  });

  it.each(EXPECTED_SHEET_OWNED)("classifies %s as sheet_owned", (col) => {
    expect(classifyColumn(col)).toBe("sheet_owned");
  });
});

describe("classifyColumn: unrecognized columns", () => {
  it("classifies a made-up column name as unknown, not silently sheet_owned", () => {
    expect(classifyColumn("Some Made Up Column Nobody Approved")).toBe("unknown");
  });

  it("never returns unknown for a column in either ownership list", () => {
    for (const col of [...EXPECTED_DB_OWNED, ...EXPECTED_SHEET_OWNED]) {
      expect(classifyColumn(col)).not.toBe("unknown");
    }
  });

  it("trims whitespace before classifying (defensive against a stray leading/trailing space in a Sheet header)", () => {
    expect(classifyColumn("  Notes  ")).toBe("sheet_owned");
    expect(classifyColumn("  Qty  ")).toBe("db_owned");
  });

  it("is case-sensitive / exact-match, not fuzzy -- a near-miss is unknown, not accidentally accepted", () => {
    expect(classifyColumn("notes")).toBe("unknown");
    expect(classifyColumn("BOL#")).toBe("unknown");
  });
});
