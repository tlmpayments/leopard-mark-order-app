/**
 * Import the product catalog from the Inventory app's "SKU Master" tab.
 *
 *   npx tsx scripts/import-sku-catalog.ts [--dry-run]
 *
 * Read-only against the spreadsheet, via the Inventory Apps Script's `skus`
 * action (no shared secret required).
 *
 * Why this exists rather than another hardcoded list: `Product` in Postgres had
 * only the six SKUs that `scripts/import-foundation-data.ts` seeded from the
 * rep app's bundled products.js, while the SKU Master tab is the real catalog
 * and carries twenty-one — including every Giro Splendido and Sunlight Groove
 * SoCal SKU, the tap handles, and the experimental XHZ/XVN batches. That gap is
 * why importing the order history dropped 180 orders: their lines referenced
 * SKUs the database had never heard of.
 *
 * `scripts/seed-ops-platform.ts` deliberately refuses to create a missing
 * Product ("price and naming belong to the catalog import"). This is that
 * import, and it takes price, packaging, keg flag and weight from the tab that
 * owns them instead of inventing any of it.
 */

import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";

config({ path: ".env.local", quiet: true });

const DRY_RUN = process.argv.includes("--dry-run");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

/**
 * The Inventory app's Apps Script URL, read from its own config.js. Not a
 * secret — it ships to every browser that loads inventory.tlmbg.co.
 */
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
      // try the next location
    }
  }
  throw new Error(
    "Could not find the Inventory Apps Script URL. Set INVENTORY_APPS_SCRIPT_URL, or keep " +
      "TheLeopardMark-Inventory checked out alongside this repo.",
  );
}

interface SkuRow {
  SKU: string;
  Brand: string;
  Product: string;
  PackageType: string;
  IsKeg: boolean | string;
  Deposit: number | string;
  ReorderThreshold: number | string;
  Active: boolean | string;
  Price: number | string;
  WeightPerUnit: number | string;
}

const num = (v: unknown): number | null => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean => v === true || String(v).toUpperCase() === "TRUE";

/**
 * `formatLabel` / `formatDetail` mirror what the existing six rows use, because
 * the invoice renderer and the Slack copy interpolate them and reps recognise
 * the wording. "1/2 bbl Keg" from the tab becomes the label; the gallonage that
 * appears on the real invoice becomes the detail.
 */
function formatFields(packageType: string): { formatLabel: string; formatDetail: string; unit: string } {
  const p = packageType.trim();
  if (/1\/2/.test(p)) return { formatLabel: "1/2 Barrel Keg", formatDetail: "(15.5 gal)", unit: "keg" };
  if (/1\/6/.test(p)) return { formatLabel: "1/6 Barrel Keg", formatDetail: "(5.16 gal)", unit: "keg" };
  if (/case/i.test(p)) return { formatLabel: "Case", formatDetail: "(12oz x24)", unit: "case" };
  if (/tap ?handle/i.test(p)) return { formatLabel: "Tap Handle", formatDetail: "", unit: "each" };
  return { formatLabel: p || "Each", formatDetail: "", unit: "each" };
}

async function main(): Promise<void> {
  const base = inventoryAppsScriptUrl();
  console.log(DRY_RUN ? "DRY RUN — nothing will be written\n" : "Importing the SKU catalog\n");
  console.log(`Inventory Apps Script: ${base.slice(0, 58)}…`);

  const res = await fetch(`${base}?action=skus`, { redirect: "follow" });
  const text = await res.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error("Apps Script returned HTML, not JSON — the web app is not publicly readable");
  }
  const payload = JSON.parse(text) as { ok: boolean; skus?: SkuRow[] };
  const rows = payload.skus ?? [];
  if (!payload.ok || rows.length === 0) throw new Error("skus returned no rows");
  console.log(`SKU Master reports ${rows.length} SKUs\n`);

  const existing = await db.product.findMany({
    select: { id: true, skuCode: true, listPrice: true },
  });
  const bySku = new Map(existing.map((p) => [p.skuCode.trim().toUpperCase(), p]));

  let created = 0;
  let enriched = 0;
  const noPrice: string[] = [];

  for (const row of rows) {
    const sku = (row.SKU ?? "").trim();
    if (!sku) continue;

    const price = num(row.Price);
    const fields = formatFields(row.PackageType ?? "");
    const data = {
      productName: (row.Product ?? sku).trim(),
      formatLabel: fields.formatLabel,
      formatDetail: fields.formatDetail,
      unit: fields.unit,
      brandCode: (row.Brand ?? "").trim() || null,
      packageType: (row.PackageType ?? "").trim() || null,
      isKeg: bool(row.IsKeg),
      depositAmount: num(row.Deposit),
      reorderThreshold: num(row.ReorderThreshold),
      weightPerUnit: num(row.WeightPerUnit),
      active: bool(row.Active),
    };

    const found = bySku.get(sku.toUpperCase());
    if (found) {
      // Never overwrite an existing listPrice from this tab: the six original
      // rows were seeded from the rep app's own product list, which is what
      // reps have been quoting, and a silent price change is the last thing
      // that should fall out of a catalog sync.
      if (!DRY_RUN) await db.product.update({ where: { id: found.id }, data });
      enriched += 1;
      continue;
    }

    if (price == null) {
      // A SKU with no price cannot be ordered, and guessing one would put wrong
      // money on a real invoice. Create it inactive so it exists for inventory
      // movements (tap handles, unpriced experimentals) without being sellable.
      noPrice.push(sku);
      if (!DRY_RUN) {
        await db.product.create({
          data: { ...data, skuCode: sku, listPrice: 0, active: false },
        });
      }
      created += 1;
      continue;
    }

    if (!DRY_RUN) {
      await db.product.create({ data: { ...data, skuCode: sku, listPrice: price } });
    }
    created += 1;
  }

  console.log(`Created:  ${created}`);
  console.log(`Enriched: ${enriched} (existing listPrice left untouched)`);
  if (noPrice.length) {
    console.log(`\nCreated inactive because the tab has no price (usable for stock, not for sale):`);
    for (const s of noPrice) console.log(`  ${s}`);
  }
  console.log(DRY_RUN ? "\nDRY RUN complete — nothing written." : "\nDone.");
}

main()
  .catch((err) => {
    console.error("\n", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await pool.end();
  });
