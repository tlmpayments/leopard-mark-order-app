// Inventory dashboard import (Phase 11 of
// /Users/jackbegley/.claude/plans/greedy-snuggling-clarke.md). Reads the two
// spreadsheet exports that currently carry stock levels -- Leopard Mark's
// warehouse "Lot Balances" export and Familiar Ventures' keg-consignment
// workbook -- and upserts InventorySnapshot rows. Postgres is a read-only
// mirror here, never the source of truth: run this manually whenever a
// fresh export lands, there is no live feed for either source.
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/import-inventory-snapshot.ts \
//     --leopard-mark "/path/to/Leopard Mark Inventory_MMDDYYYY.xlsx" \
//     --familiar-ventures "/path/to/FAMILIAR VENTURES.xlsx"
// Either flag can be omitted to import just one source.
import "dotenv/config";
import * as XLSX from "xlsx";
import { PrismaClient } from "../app/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

// Mirrors scripts/import-foundation-data.ts's PRODUCTS list -- the only
// skuCodes that can exist in Postgres today. Anything that doesn't
// normalize to one of these stays skuCode: null, never a guessed match.
const KNOWN_SKUS = [
  "CNT1AKHB01",
  "CNT1AKSB01",
  "CNT1AC1224",
  "SGB1AKHB01",
  "SGB1AKSB01",
  "SGB1AC1224",
];

// Leopard Mark's "Product" column is "TLM-<code>-<suffix>", e.g.
// "TLM-CNT1AC1224-6PK" or "TLM-CNT1AKHB01-M". Strip the prefix/suffix to
// recover the bare sku code, then apply the one known data-quality issue
// found this morning during the DATASTAGE integration: the source
// inconsistently writes Sunlight Groove — Bay Area codes as "SBG" instead
// of "SGB" (verified against the same file: row 8 is "TLM-SBG1AKSB01-M"
// while rows 9-10 for the same product line are "TLM-SGB...") -- correct
// that one specific transposition, nothing else.
function normalizeLeopardMarkCode(raw: string): {
  skuCode: string | null;
  rawProductCode: string;
} {
  const rawProductCode = raw.trim();
  const stripped = rawProductCode
    .replace(/^TLM-/, "")
    .replace(/-(6PK|M)$/, "");
  const corrected = stripped.startsWith("SBG")
    ? "SGB" + stripped.slice(3)
    : stripped;
  return {
    skuCode: KNOWN_SKUS.includes(corrected) ? corrected : null,
    rawProductCode,
  };
}

async function importLeopardMark(filePath: string, snapshotDate: Date) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets["Lot Balances"];
  if (!ws) throw new Error(`"Lot Balances" sheet not found in ${filePath}`);
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws, {
    defval: null,
  });

  let imported = 0;
  let unmapped = 0;
  for (const row of rows) {
    const product = String(row["Product"] ?? "").trim();
    if (!product) continue;
    const { skuCode, rawProductCode } = normalizeLeopardMarkCode(product);
    if (!skuCode) unmapped++;

    await db.inventorySnapshot.create({
      data: {
        source: "leopard_mark_warehouse",
        snapshotDate,
        skuCode,
        rawProductCode,
        // The sheet's own "Whse" column is blank for every row in the
        // current export -- left null rather than guessed.
        location: (row["Whse"] as string) || null,
        lotRef: (row["P.O. No."] as string) ?? null,
        onHand: toDecimalOrNull(row["On Hand"]),
        onOrder: toDecimalOrNull(row["On Order"]),
        onHold: toDecimalOrNull(row["On Hold"]),
        available: toDecimalOrNull(row["Available"]),
        inTransit: toDecimalOrNull(row["In-Transit"]),
      },
    });
    imported++;
  }
  console.log(
    `Leopard Mark warehouse: ${imported} lot rows imported (${unmapped} with an unmapped sku_code).`,
  );
}

// Familiar Ventures' workbook is a hand-maintained shipment log, not a flat
// table: each product/format gets its own section starting with a header
// row ("<label>", <starting count>, "DATE", "SHIP TO", ..., "RECEIVED",
// "DATE"), followed by one row per shipment, ending in a "TOTAL AVAILABLE"
// footer row with the section's current balance. Header label text is
// inconsistent across sections (e.g. "KEGS QTY RCV - 1/2 KEG" vs
// "CANTINESCA KEG 1/2" vs "GIRO SPLENDIDO BEER CANS 24-PK") -- there is no
// clean sku code here at all, only free text, so this is necessarily a
// keyword match, not a lookup. Only the section-level "TOTAL AVAILABLE"
// balance is imported (one InventorySnapshot row per section) -- the
// individual shipment rows are a per-keg deployment ledger, a different
// shape than the point-in-time balances this table models; see the plan's
// Phase 11 scope note.
function matchFamiliarVenturesSku(label: string): string | null {
  const l = label.toUpperCase();
  const isHalf = /1\/2|HALF/.test(l);
  const isSixth = /1\/6|SIXTH/.test(l);
  const isCase = /CASE|CAN/.test(l);
  if (/CANTINESCA|CNT/.test(l)) {
    if (isHalf) return "CNT1AKHB01";
    if (isSixth) return "CNT1AKSB01";
    if (isCase) return "CNT1AC1224";
  }
  if (/SUNLIGHT|SGB|SBG/.test(l)) {
    if (isHalf) return "SGB1AKHB01";
    if (isSixth) return "SGB1AKSB01";
    if (isCase) return "SGB1AC1224";
  }
  // Giro Splendido has no seeded Product row today (see
  // scripts/import-foundation-data.ts's PRODUCTS list) -- always unmapped,
  // same as any other label that doesn't match above.
  return null;
}

function toDecimalOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function importFamiliarVentures(filePath: string, snapshotDate: Date) {
  const wb = XLSX.readFile(filePath);
  let imported = 0;
  let unmapped = 0;

  for (const sheetName of wb.SheetNames) {
    if (!sheetName.startsWith("INVENTORY")) continue;
    const ws = wb.Sheets[sheetName];
    const grid: unknown[][] = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      defval: null,
    });

    let currentLabel: string | null = null;
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r];
      const colA = row[0] != null ? String(row[0]).trim() : "";
      if (!colA) continue;

      if (colA.toUpperCase() === "TOTAL AVAILABLE") {
        const qty = toDecimalOrNull(row[1]);
        if (currentLabel && qty !== null) {
          const skuCode = matchFamiliarVenturesSku(currentLabel);
          if (!skuCode) unmapped++;
          await db.inventorySnapshot.create({
            data: {
              source: "familiar_ventures_consignment",
              snapshotDate,
              skuCode,
              rawProductCode: currentLabel,
              location: "EWD (Familiar Ventures consignment)",
              available: qty,
              onHand: qty,
            },
          });
          imported++;
        }
        currentLabel = null; // next section's header hasn't been seen yet
        continue;
      }

      // A real section header is followed by the literal sub-header text
      // "DATE"/"SHIP TO" in columns C/D (verified against every section in
      // this workbook: e.g. ['CANTINESCA KEG 1/2', 32, 'DATE', 'SHIP TO',
      // ...]). This is deliberately stricter than "any non-shipment-row
      // col-A text" -- the sheet also contains free-floating annotation
      // rows in column A ("NEW PRODUCT", "STOP SHIPPING OLD CANS", and a
      // lowercase "ewd-..." shipment ref that isn't actually a header) that
      // would otherwise be misread as a new section and silently corrupt
      // the balance for whatever section follows them.
      const colC = row[2] != null ? String(row[2]).trim().toUpperCase() : "";
      const colD = row[3] != null ? String(row[3]).trim().toUpperCase() : "";
      if (colC === "DATE" && colD === "SHIP TO") {
        currentLabel = colA;
      }
    }
  }
  console.log(
    `Familiar Ventures consignment: ${imported} section balances imported (${unmapped} with an unmapped sku_code).`,
  );
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshotDate = new Date();
  snapshotDate.setUTCHours(0, 0, 0, 0);

  if (!args["leopard-mark"] && !args["familiar-ventures"]) {
    console.error(
      "Usage: npx tsx scripts/import-inventory-snapshot.ts --leopard-mark <file> --familiar-ventures <file>",
    );
    process.exit(1);
  }

  if (args["leopard-mark"]) {
    await importLeopardMark(args["leopard-mark"], snapshotDate);
  }
  if (args["familiar-ventures"]) {
    await importFamiliarVentures(args["familiar-ventures"], snapshotDate);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
    await pool.end();
  });
