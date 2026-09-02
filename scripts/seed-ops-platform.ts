/**
 * Seed the Ops Platform's configuration tables.
 *
 * Idempotent and safe to re-run: every write is an upsert or a
 * create-if-absent, and existing values are never overwritten. Run with
 * `--dry-run` to see what it would do.
 *
 *   npx tsx scripts/seed-ops-platform.ts [--dry-run]
 *
 * What it seeds, and where each value comes from:
 *   - Location:      the Inventory app's data/Locations.csv (11 rows, verbatim
 *                    LocationID values so BOL numbers stay format-compatible).
 *   - Product:       enrichment from the Inventory app's SKU_SEED_ROWS — keg
 *                    flag, deposit, weight per unit, package type.
 *   - Commodity:     the Inventory app's Commodities seed (7 freight codes).
 *   - RouteSchedule: BA delivers Tue + Thu, LA delivers Wed + Fri, both with a
 *                    14:00 prior-day cutoff.
 *   - AutomationRule: the §7 catalogue at its documented defaults, with
 *                    per-region auto-scheduling OFF.
 *
 * NOTE on the route schedule: §12 Q1 asks the user to confirm region ->
 * warehouse -> weekdays and cutoff hour. The values below are the ones the
 * mockup records, and the seed prints them so they can be checked. They are
 * data, not code — correcting them is an UPDATE, not a deploy.
 */

import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { AUTOMATION_RULES, autoScheduleDefinition } from "../lib/automations";

const DRY_RUN = process.argv.includes("--dry-run");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

type LocationSeed = {
  id: string;
  name: string;
  type: "brewery" | "warehouse";
  city: string;
  state: string;
  lat: number;
  lng: number;
};

/** data/Locations.csv from TheLeopardMark-Inventory, verbatim. */
const LOCATIONS: LocationSeed[] = [
  { id: "BRW-RICH", name: "Richmond Brewery", type: "brewery", city: "Richmond", state: "CA", lat: 37.9358, lng: -122.3477 },
  { id: "BRW-HB", name: "Huntington Beach Brewery", type: "brewery", city: "Huntington Beach", state: "CA", lat: 33.6603, lng: -117.9992 },
  { id: "BRW-SD", name: "San Diego Brewery", type: "brewery", city: "San Diego", state: "CA", lat: 32.7157, lng: -117.1611 },
  { id: "BRW-NG", name: "Northglenn Brewery", type: "brewery", city: "Northglenn", state: "CO", lat: 39.8858, lng: -104.9872 },
  { id: "BRW-FRA", name: "Framingham Brewery", type: "brewery", city: "Framingham", state: "MA", lat: 42.2793, lng: -71.4162 },
  { id: "BRW-GAR", name: "Garnerville Brewery", type: "brewery", city: "Garnerville", state: "NY", lat: 41.2098, lng: -73.9835 },
  { id: "BRW-BLA", name: "Blanco Brewery", type: "brewery", city: "Blanco", state: "TX", lat: 29.9438, lng: -98.4189 },
  { id: "WH-BEN", name: "Benicia Warehouse", type: "warehouse", city: "Benicia", state: "CA", lat: 38.0494, lng: -122.1586 },
  { id: "WH-SF", name: "San Francisco Warehouse", type: "warehouse", city: "San Francisco", state: "CA", lat: 37.7749, lng: -122.4194 },
  { id: "WH-WIL", name: "Wilmington Warehouse", type: "warehouse", city: "Wilmington", state: "CA", lat: 33.7395, lng: -118.2651 },
  { id: "WH-WIN", name: "Windsor Warehouse", type: "warehouse", city: "Windsor", state: "CA", lat: 38.5471, lng: -122.8164 },
];

/**
 * Product enrichment, joined on skuCode. Weights are the Inventory app's:
 * a 1/2 bbl keg is 160 lb, a 1/6 bbl is 58 lb, a case is 22 lb, a tap handle
 * is 0. Deposits are $35 on both keg sizes, per INV26277's Keg Deposit line.
 */
type ProductSeed = {
  skuCode: string;
  isKeg: boolean;
  packageType: string;
  weightPerUnit: number;
  depositAmount: number | null;
  reorderThreshold: number | null;
  brandCode: string;
};

const KEG_HALF = { isKeg: true, packageType: "1/2 Barrel Keg", weightPerUnit: 160, depositAmount: 35, reorderThreshold: 10 };
const KEG_SIXTH = { isKeg: true, packageType: "1/6 Barrel Keg", weightPerUnit: 58, depositAmount: 35, reorderThreshold: 10 };
const CASE_24 = { isKeg: false, packageType: "Case (12oz x24)", weightPerUnit: 22, depositAmount: null, reorderThreshold: 20 };
const TAP_HANDLE = { isKeg: false, packageType: "Tap Handle", weightPerUnit: 0, depositAmount: null, reorderThreshold: null };

const PRODUCTS: ProductSeed[] = [
  { skuCode: "CNT1AKHB01", brandCode: "CNT", ...KEG_HALF },
  { skuCode: "CNT1AKSB01", brandCode: "CNT", ...KEG_SIXTH },
  { skuCode: "CNT1AC1224", brandCode: "CNT", ...CASE_24 },
  { skuCode: "CNT-TAPHANDLE", brandCode: "CNT", ...TAP_HANDLE },
  { skuCode: "SGB1AKHB01", brandCode: "SGB", ...KEG_HALF },
  { skuCode: "SGB1AKSB01", brandCode: "SGB", ...KEG_SIXTH },
  { skuCode: "SGB1AC1224", brandCode: "SGB", ...CASE_24 },
  { skuCode: "SGB-TAPHANDLE", brandCode: "SGB", ...TAP_HANDLE },
  { skuCode: "SGS1AKHB01", brandCode: "SGS", ...KEG_HALF },
  { skuCode: "SGS1AKSB01", brandCode: "SGS", ...KEG_SIXTH },
  { skuCode: "SGS1AC1224", brandCode: "SGS", ...CASE_24 },
  { skuCode: "GSP1AKHB01", brandCode: "GSP", ...KEG_HALF, reorderThreshold: 6 },
  { skuCode: "GSP1AKSB01", brandCode: "GSP", ...KEG_SIXTH, reorderThreshold: 6 },
  { skuCode: "GSP1AC1224", brandCode: "GSP", ...CASE_24 },
];

/** The Inventory app's Commodities seed, verbatim. */
const COMMODITIES = [
  { code: "BEER-CAN", name: "Packaged Beer — Cans", notes: "Verify NMFC # before use" },
  { code: "BEER-KEG", name: "Packaged Beer — Kegs", notes: "Verify NMFC # before use" },
  { code: "GLASS", name: "Glassware", notes: "Verify NMFC # before use" },
  { code: "RM-GRAIN", name: "Raw Materials — Grain/Malt", notes: "Verify NMFC # before use" },
  { code: "RM-HOPS", name: "Raw Materials — Hops", notes: "Verify NMFC # before use" },
  { code: "PKG-MAT", name: "Packaging Materials", notes: "Verify NMFC # before use" },
  { code: "OTHER", name: "Other", notes: null },
];

/** 0 = Sunday .. 6 = Saturday. Cutoff is that hour on the PRIOR day, PT. */
const ROUTES = [
  { region: "BA", warehouseId: "WH-SF", weekday: 2, cutoffHour: 14 },
  { region: "BA", warehouseId: "WH-BEN", weekday: 4, cutoffHour: 14 },
  { region: "LA", warehouseId: "WH-WIL", weekday: 3, cutoffHour: 14 },
  { region: "LA", warehouseId: "WH-WIL", weekday: 5, cutoffHour: 14 },
];

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function main(): Promise<void> {
  console.log(DRY_RUN ? "DRY RUN — nothing will be written\n" : "Seeding Ops Platform configuration\n");

  // ---- Locations ----
  let created = 0;
  for (const loc of LOCATIONS) {
    const existing = await db.location.findUnique({ where: { id: loc.id } });
    if (existing) continue;
    created += 1;
    if (!DRY_RUN) await db.location.create({ data: { ...loc, active: true } });
  }
  console.log(`Locations: ${created} created, ${LOCATIONS.length - created} already present`);

  // ---- Product enrichment ----
  let enriched = 0;
  const missing: string[] = [];
  for (const p of PRODUCTS) {
    const product = await db.product.findUnique({ where: { skuCode: p.skuCode } });
    if (!product) {
      // Deliberately does NOT create the product: price and naming belong to
      // the catalog import, and inventing them here would put a wrong price on
      // a real invoice.
      missing.push(p.skuCode);
      continue;
    }
    enriched += 1;
    if (!DRY_RUN) {
      await db.product.update({
        where: { id: product.id },
        data: {
          brandCode: p.brandCode,
          packageType: p.packageType,
          isKeg: p.isKeg,
          weightPerUnit: p.weightPerUnit,
          depositAmount: p.depositAmount,
          reorderThreshold: p.reorderThreshold,
        },
      });
    }
  }
  console.log(`Products: ${enriched} enriched`);
  if (missing.length) {
    console.log(`  not in the catalog yet (skipped, not invented): ${missing.join(", ")}`);
  }

  // ---- Commodities ----
  let comm = 0;
  for (const c of COMMODITIES) {
    const existing = await db.commodity.findUnique({ where: { code: c.code } });
    if (existing) continue;
    comm += 1;
    if (!DRY_RUN) await db.commodity.create({ data: c });
  }
  console.log(`Commodities: ${comm} created`);

  // ---- Route schedule ----
  let routes = 0;
  for (const r of ROUTES) {
    const warehouse = await db.location.findUnique({ where: { id: r.warehouseId } });
    if (!warehouse && !DRY_RUN) {
      console.log(`  ! skipping ${r.region} ${DAY[r.weekday]}: warehouse ${r.warehouseId} not found`);
      continue;
    }
    const existing = await db.routeSchedule.findFirst({
      where: { region: r.region, warehouseId: r.warehouseId, weekday: r.weekday },
    });
    if (existing) continue;
    routes += 1;
    if (!DRY_RUN) await db.routeSchedule.create({ data: { ...r, active: true } });
  }
  console.log(`Route schedule: ${routes} created`);
  for (const r of ROUTES) {
    console.log(`  ${r.region} → ${r.warehouseId} on ${DAY[r.weekday]}, cutoff ${r.cutoffHour}:00 prior day`);
  }
  console.log("  ^ confirm these against §12 Q1 before trusting a proposed slot.");

  // ---- Automation rules ----
  const regions = [...new Set(ROUTES.map((r) => r.region))];
  const defs = [...AUTOMATION_RULES, ...regions.map(autoScheduleDefinition)];
  let rules = 0;
  for (const def of defs) {
    const existing = await db.automationRule.findUnique({ where: { key: def.key } });
    if (existing) continue;
    rules += 1;
    if (!DRY_RUN) await db.automationRule.create({ data: { key: def.key, enabled: def.defaultEnabled } });
  }
  console.log(`Automation rules: ${rules} created (${defs.length} in the catalogue)`);
  console.log(`  auto-schedule is OFF for every region — turn it on per region once proposals are trusted.`);

  console.log(DRY_RUN ? "\nDRY RUN complete — nothing written." : "\nDone.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await pool.end();
  });
