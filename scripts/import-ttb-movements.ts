// Inventory dashboard import (Phase 11 of
// /Users/jackbegley/.claude/plans/greedy-snuggling-clarke.md). Reads the
// "Master Movement Ledger" tab of the TTB excise-tax workbook and mirrors it
// into BreweryMovementEvent, verbatim -- this ledger only ever contains
// non-sale movements (Produced / Transfer in bond / Destroyed) per its own
// header instructions ("log every movement EXCEPT sales"). Actual
// sales/removals are never imported here; the dashboard computes those live
// from Order/OrderLine for cross-checking, never merges them into this
// table. Read-only mirror, run manually whenever the workbook is updated.
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/import-ttb-movements.ts \
//     "/path/to/TTB_Reporting_System.xlsx"
import "dotenv/config";
import * as XLSX from "xlsx";
import { PrismaClient } from "../app/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

function toDecimalOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toDateOrNull(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "number") {
    // Excel serial date -- XLSX.SSF handles the 1900 leap-year quirk.
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return new Date(Date.UTC(d.y, d.m - 1, d.d));
  }
  return null;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: npx tsx scripts/import-ttb-movements.ts <ttb-workbook.xlsx>");
    process.exit(1);
  }

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets["Master Movement Ledger"];
  if (!ws) throw new Error(`"Master Movement Ledger" sheet not found in ${filePath}`);

  // Row 3 is the real header ("Date | Month | Quarter | Event | Location |
  // To (transfers only) | Package / unit | Qty | Barrels | ..."); rows 1-2
  // are a title and a blue-cells-mean-you-type instruction banner.
  const rows: Record<string, unknown>[] = XLSX.utils.sheet_to_json(ws, {
    range: 2, // 0-indexed -- skips rows 1-2, uses row 3 as the header
    defval: null,
  });

  let imported = 0;
  for (const row of rows) {
    const eventDate = toDateOrNull(row["Date"]);
    const event = row["Event"] as string | null;
    const location = row["Location"] as string | null;
    if (!eventDate || !event || !location) continue; // blank trailing rows

    await db.breweryMovementEvent.create({
      data: {
        eventDate,
        event,
        location,
        destination: (row["To (transfers only)"] as string) ?? null,
        packageUnit: (row["Package / unit"] as string) ?? null,
        qty: toDecimalOrNull(row["Qty"]),
        barrels: toDecimalOrNull(row["Barrels"]),
        reportsUnder: (row["Reports under (auto)"] as string) ?? null,
        stateCode: (row["State (auto)"] as string) ?? null,
      },
    });
    imported++;
  }
  console.log(`TTB Master Movement Ledger: ${imported} events imported.`);
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
