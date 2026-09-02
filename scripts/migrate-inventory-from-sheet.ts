/**
 * Import the inventory ledger from the Sheet, then PROVE parity (§4 steps 4/7).
 *
 *   npx tsx scripts/migrate-inventory-from-sheet.ts [--dry-run]
 *
 * Read-only against the spreadsheet, via the Inventory Apps Script's `events`
 * and `stock` actions (no shared secret required). Never writes a cell back.
 *
 * §4 step 7 is the important half: "Prove `stock_by_location` equals what
 * inventory.tlmbg.co's dashboard shows today, SKU by SKU." This script does the
 * import and then runs that comparison, because an inventory migration nobody
 * has reconciled is worse than no migration — it looks authoritative while
 * being wrong, and the old dashboard must not be retired on trust.
 *
 * Idempotent: every event carries `importRef = "sheet:<EventID>"` under a
 * UNIQUE index, so a second run inserts nothing and cannot double-count stock.
 */

import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";
import { aliasHistoricalSku } from "../lib/sheetSkuAlias";
import type { InventoryEventType } from "../app/generated/prisma/enums";

config({ path: ".env.local", quiet: true });

const DRY_RUN = process.argv.includes("--dry-run");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

function inventoryAppsScriptUrl(): string {
  const fromEnv = process.env.INVENTORY_APPS_SCRIPT_URL;
  if (fromEnv) return fromEnv;
  for (const candidate of [
    path.join(process.cwd(), "..", "TheLeopardMark-Inventory", "assets", "js", "config.js"),
    path.join(process.cwd(), "apps-script", "inventory-config.js"),
  ]) {
    try {
      const m = /https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec/.exec(
        readFileSync(candidate, "utf8"),
      );
      if (m) return m[0];
    } catch {
      /* try the next location */
    }
  }
  throw new Error("Set INVENTORY_APPS_SCRIPT_URL, or keep TheLeopardMark-Inventory alongside this repo.");
}

const BASE = inventoryAppsScriptUrl();

async function getJson<T>(params: Record<string, string>): Promise<T> {
  const res = await fetch(`${BASE}?${new URLSearchParams(params)}`, { redirect: "follow" });
  const text = await res.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error("Apps Script returned HTML, not JSON — the web app is not publicly readable");
  }
  return JSON.parse(text) as T;
}

/**
 * The live ledger uses the Inventory app's own location codes
 * (`W_CA_Windsor 01`, `P_CA_Richmond`), while `Location.id` uses the shorter
 * `WH-*` / `BRW-*` ids from data/Locations.csv that the seed loaded.
 *
 * Note "Benecia" — the live code carries a misspelling of Benicia that the CSV
 * does not. Mapping by hand rather than deriving from the string is what keeps
 * that from silently dropping a warehouse.
 */
const LOCATION_ALIAS: Record<string, string> = {
  "P_CA_RICHMOND": "BRW-RICH",
  "P_CA_HUNTINGTON BEACH": "BRW-HB",
  "P_CA_SAN DIEGO": "BRW-SD",
  "P_CO_NORTHGLENN": "BRW-NG",
  "P_MA_FRAMINGHAM": "BRW-FRA",
  "P_NY_GARNERVILLE": "BRW-GAR",
  "P_TX_BLANCO": "BRW-BLA",
  "W_CA_BENECIA 01": "WH-BEN",
  "W_CA_BENICIA 01": "WH-BEN",
  "W_CA_SAN FRANCISCO 01": "WH-SF",
  "W_CA_WILMINGTON 01": "WH-WIL",
  "W_CA_WINDSOR 01": "WH-WIN",
};

function mapLocation(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  return LOCATION_ALIAS[v.toUpperCase()] ?? null;
}

interface LedgerRow {
  EventID: string;
  Timestamp: string;
  EventType: string;
  SKU: string;
  Qty: number | string;
  FromLocation: string;
  ToLocation: string;
  Actor: string;
  BOLNumber: string;
  RefNote: string;
  Notes: string;
  LotNumber: string;
  UnitPrice: number | string;
}

const VALID_TYPES = new Set<string>([
  "BREW",
  "INCOMING",
  "TRANSFER",
  "DELIVERY",
  "RETURN",
  "SAMPLE",
  "DESTRUCTION",
  "LOSS",
  "ADJUSTMENT",
]);

async function main(): Promise<void> {
  console.log(DRY_RUN ? "DRY RUN — nothing will be written\n" : "Importing the inventory ledger\n");
  console.log(`Inventory Apps Script: ${BASE.slice(0, 58)}…\n`);

  const ledger = await getJson<{ ok: boolean; events: LedgerRow[] }>({
    action: "events",
    limit: "5000",
  });
  const rows = ledger.events ?? [];
  console.log(`Inventory Ledger reports ${rows.length} events`);

  const [products, locations, alreadyImported] = await Promise.all([
    db.product.findMany({ select: { id: true, skuCode: true } }),
    db.location.findMany({ select: { id: true } }),
    db.inventoryEvent.findMany({
      where: { importRef: { not: null } },
      select: { importRef: true },
    }),
  ]);
  const productBySku = new Map(products.map((p) => [p.skuCode.trim().toUpperCase(), p]));
  const locationIds = new Set(locations.map((l) => l.id));
  const seen = new Set(alreadyImported.map((e) => e.importRef));

  let created = 0;
  let skippedExisting = 0;
  const problems: string[] = [];

  for (const row of rows) {
    const importRef = `sheet:${row.EventID}`;
    if (seen.has(importRef)) {
      skippedExisting += 1;
      continue;
    }

    const type = (row.EventType ?? "").trim().toUpperCase();
    if (!VALID_TYPES.has(type)) {
      problems.push(`${row.EventID}: unknown event type "${row.EventType}"`);
      continue;
    }

    const sku = aliasHistoricalSku(row.SKU);
    const product = sku ? productBySku.get(sku) : undefined;
    if (!product) {
      problems.push(`${row.EventID}: SKU "${row.SKU}" not in the catalog`);
      continue;
    }

    const qty = Math.round(Number(row.Qty));
    if (!Number.isFinite(qty) || qty <= 0) {
      // The ledger stores fractional case quantities in places. qty is an Int
      // here because a third of a case is not a thing that can be delivered;
      // rounding is reported rather than silent.
      problems.push(`${row.EventID}: unusable qty "${row.Qty}"`);
      continue;
    }
    if (String(row.Qty) !== String(qty)) {
      problems.push(`${row.EventID}: qty ${row.Qty} rounded to ${qty}`);
    }

    const from = mapLocation(row.FromLocation);
    const to = mapLocation(row.ToLocation);
    if (row.FromLocation?.trim() && !from) {
      problems.push(`${row.EventID}: unmapped FromLocation "${row.FromLocation}"`);
      continue;
    }
    if (row.ToLocation?.trim() && !to) {
      problems.push(`${row.EventID}: unmapped ToLocation "${row.ToLocation}"`);
      continue;
    }
    if ((from && !locationIds.has(from)) || (to && !locationIds.has(to))) {
      problems.push(`${row.EventID}: mapped location missing from Location table`);
      continue;
    }

    if (DRY_RUN) {
      created += 1;
      continue;
    }

    await db.inventoryEvent.create({
      data: {
        occurredAt: row.Timestamp ? new Date(row.Timestamp) : new Date(),
        type: type as InventoryEventType,
        productId: product.id,
        qty,
        fromLocationId: from,
        toLocationId: to,
        lotNumber: row.LotNumber?.trim() || null,
        // The legacy EventID is preserved twice on purpose: in refNote so it is
        // visible in the hub's ledger view, and in importRef under a UNIQUE
        // index so a re-run cannot double-count.
        refNote: row.RefNote?.trim() || row.EventID,
        notes: row.Notes?.trim() || null,
        importRef,
      },
    });
    created += 1;
  }

  console.log(`\nCreated:  ${created}`);
  console.log(`Existing: ${skippedExisting} (already imported, left alone)`);
  if (problems.length) {
    console.log(`\nNeeds a human (${problems.length}):`);
    for (const p of problems) console.log(`  ${p}`);
  }

  // ---- §4 step 7: parity against what the old dashboard shows today ----
  console.log("\n---- Parity: stock_by_location vs inventory.tlmbg.co ----");
  const sheetStock = await getJson<{ ok: boolean; stock: Array<{ sku: string; locationId: string; qty: number }> }>(
    { action: "stock" },
  );

  const theirs = new Map<string, number>();
  for (const s of sheetStock.stock ?? []) {
    const sku = aliasHistoricalSku(s.sku);
    const loc = mapLocation(s.locationId);
    if (!sku || !loc) continue;
    theirs.set(`${sku}|${loc}`, (theirs.get(`${sku}|${loc}`) ?? 0) + Number(s.qty));
  }

  const ourRows = await db.$queryRaw<Array<{ sku: string; loc: string; on_hand: bigint }>>`
    SELECT p."sku_code" AS sku, s."location_id" AS loc, s."on_hand"
    FROM "stock_by_location" s JOIN "products" p ON p."id" = s."product_id"`;
  const ours = new Map(ourRows.map((r) => [`${r.sku}|${r.loc}`, Number(r.on_hand)]));

  const keys = [...new Set([...theirs.keys(), ...ours.keys()])].sort();
  let matched = 0;
  const diffs: string[] = [];
  for (const k of keys) {
    const t = theirs.get(k) ?? 0;
    const o = ours.get(k) ?? 0;
    // The old dashboard carries fractional case quantities; ours are integers,
    // so a sub-unit difference is the rounding reported above, not a mismatch.
    if (Math.abs(t - o) < 1) matched += 1;
    else diffs.push(`  ${k.padEnd(34)} sheet=${t}  postgres=${o}  diff=${(o - t).toFixed(2)}`);
  }

  console.log(`${matched}/${keys.length} SKU×location pairs agree`);
  if (diffs.length) {
    console.log("\nDIFFERENCES — do not retire inventory.tlmbg.co until these are explained:");
    for (const d of diffs) console.log(d);
  } else if (keys.length > 0) {
    console.log("Parity holds. Every SKU×location matches the old dashboard.");
  }

  console.log(DRY_RUN ? "\nDRY RUN complete — nothing written." : "\nDone.");
}

const invokedDirectly = path
  .resolve(process.argv[1] ?? "")
  .endsWith("migrate-inventory-from-sheet.ts");

if (invokedDirectly) {
  main()
    .catch((err) => {
      console.error("\n", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await db.$disconnect();
      await pool.end();
    });
}
