// One-time Phase 2 backfill: the live "Sales" sheet has ~272 historical rows
// with no "Order ID" column value yet. Rows implicitly group by Invoice #
// today (the same invoiceMap/invoiceOrder pattern Code.gs's handleStats/
// handleCustomerOrders/handleAllOrders already use internally) -- this script
// makes that grouping literal: one Postgres `orders` row (+ `order_lines`)
// per Invoice # group, one ULID per group, written back into every row in
// that group's new "Order ID" cell.
//
// This is NOT the live bidirectional sync (that's the ongoing DB<->Sheet sync
// job) -- it's a single pass over historical data that predates the "Order
// ID" column existing at all. Run ONCE per environment. Per the design doc's
// ground rules: local test now (this file, against a local test Postgres +
// mocked Sheet rows), real production later ONLY after a human has reviewed
// this script and it has been proven against a DUPLICATE of the real
// spreadsheet -- never point this at production data directly.
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/backfill-sheet-orders.ts
//
// Wiring to the real Sheet: set APPS_SCRIPT_URL + SYNC_SHARED_SECRET in the
// environment. With those unset (e.g. in this script's own test run, since
// the `allSalesRows`/`writeOrderIds` Apps Script actions are being built by a
// parallel agent and won't be deployed yet), fetchAllSalesRows() falls back
// to MOCK_SHEET_ROWS below and writeOrderIdsBack() logs what it would have
// sent instead of calling out. Nothing about the grouping/backfill logic
// below needs to change when those env vars are eventually set for real.
import "dotenv/config";
import { PrismaClient, Prisma } from "../app/generated/prisma/client.js";
import type { Account, Rep, Product } from "../app/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { ulid } from "ulid";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

// ---------------------------------------------------------------------------
// Wire shape -- one row per Sales-sheet data row, field names matching the
// shared Phase 2 design's `action=allSalesRows` response shape exactly.
// `orderId` is '' for the ~272 historical rows this script targets; a
// non-empty value means some earlier run (or the live sync) already handled
// that row, and it must be left alone.
// ---------------------------------------------------------------------------
interface SheetRow {
  rowNumber: number;
  invoiceNumber: string;
  customer: string;
  licenseNumber: string;
  poDate: string;
  productName: string;
  packagingFormat: string;
  productCode: string;
  qty: number;
  price: number;
  lineTotal: number;
  salesRep: string;
  paymentMethod: string;
  inventorySource: string;
  invoiceStatus: string;
  notes: string;
  orderId: string;
}

// ---------------------------------------------------------------------------
// Step 1: fetch every Sales row. Swappable -- this is the ONLY function that
// needs to change to point at the real Apps Script web app instead of mock
// data; the grouping/backfill logic never touches network or mock concerns.
// ---------------------------------------------------------------------------
async function fetchAllSalesRows(): Promise<SheetRow[]> {
  const url = process.env.APPS_SCRIPT_URL;
  const secret = process.env.SYNC_SHARED_SECRET;
  if (!url || !secret) {
    console.log(
      "[fetchAllSalesRows] APPS_SCRIPT_URL/SYNC_SHARED_SECRET not set -- using mock Sheet data for this test run.",
    );
    return mockSalesRows();
  }
  // Real path: GET, same action/secret convention as every other doGet
  // action in Code.gs (login, reps, stats, customers, ...).
  const qs = new URLSearchParams({ action: "allSalesRows", secret });
  const res = await fetch(`${url}?${qs.toString()}`);
  const json = (await res.json()) as { ok: boolean; rows?: SheetRow[]; error?: string };
  if (!json.ok || !json.rows) {
    throw new Error(`allSalesRows failed: ${json.error || "unknown error"}`);
  }
  return json.rows;
}

// ---------------------------------------------------------------------------
// Step 5: write the resolved {rowNumber, orderId} pairs back to the Sheet.
// Swappable for the same reason as fetchAllSalesRows above.
// ---------------------------------------------------------------------------
interface OrderIdEntry {
  rowNumber: number;
  orderId: string;
}

async function writeOrderIdsBack(entries: OrderIdEntry[]): Promise<void> {
  if (entries.length === 0) {
    console.log("[writeOrderIdsBack] nothing to write back.");
    return;
  }
  const url = process.env.APPS_SCRIPT_URL;
  const secret = process.env.SYNC_SHARED_SECRET;
  if (!url || !secret) {
    console.log(
      `[writeOrderIdsBack] APPS_SCRIPT_URL/SYNC_SHARED_SECRET not set -- would have POSTed ${entries.length} ` +
        "row/orderId pair(s) to action=writeOrderIds. Logging the payload instead of calling out:",
    );
    console.log(JSON.stringify({ action: "writeOrderIds", secret: "<redacted>", entries }, null, 2));
    return;
  }
  // Real path: POST, same doPost convention as order/addCustomer/updateCustomer/setPin.
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "writeOrderIds", secret, entries }),
  });
  const json = (await res.json()) as { ok: boolean; error?: string };
  if (!json.ok) {
    throw new Error(`writeOrderIds failed: ${json.error || "unknown error"}`);
  }
}

// ---------------------------------------------------------------------------
// customerMatches -- reused VERBATIM (same semantics) from Code.gs. Historical
// Sales/Ekos-imported rows store the customer as "Legal Entity / DBA Name"
// (e.g. "Sutro Syndicate LLC / 540 SF") while imported Accounts store just
// the plain DBA name ("540 SF"). Match either an exact hit or a "/ dba"
// suffix so account lookups find both old- and new-style rows.
// ---------------------------------------------------------------------------
function customerMatches(rowValue: string, targetLower: string): boolean {
  const row = String(rowValue || "").trim().toLowerCase();
  if (row === targetLower) return true;
  const slashIdx = row.lastIndexOf("/");
  if (slashIdx !== -1 && row.slice(slashIdx + 1).trim() === targetLower) return true;
  return false;
}

// For detecting "rows in the same Invoice # group disagree about who the
// customer is" (a data-entry error, not something to guess through) --
// normalize each row's customer string to the same identity key customerMatches
// would resolve it to, so a legit "Legal Entity / DBA" vs "DBA" spelling
// difference for the SAME account never looks like a disagreement.
function normalizeCustomerKey(raw: string): string {
  const trimmed = String(raw || "").trim().toLowerCase();
  const slashIdx = trimmed.lastIndexOf("/");
  return slashIdx !== -1 ? trimmed.slice(slashIdx + 1).trim() : trimmed;
}

function resolveAccount(customerRaw: string, accounts: Account[]): Account | "ambiguous" | null {
  const matches = accounts.filter((a) =>
    customerMatches(customerRaw, a.businessName.trim().toLowerCase()),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return "ambiguous";
  return null;
}

function resolveRep(nameRaw: string, reps: Rep[]): Rep | null {
  const target = String(nameRaw || "").trim().toLowerCase();
  if (!target) return null;
  return reps.find((r) => r.name.trim().toLowerCase() === target) ?? null;
}

function parsePoDate(raw: string): Date {
  const d = new Date(raw);
  if (isNaN(d.getTime())) {
    console.warn(`  could not parse PO Date "${raw}" -- falling back to current time for this order's timestamps.`);
    return new Date();
  }
  return d;
}

// ---------------------------------------------------------------------------
// Step 2/3 groundwork: group unsynced rows by Invoice #, collecting
// blank/ambiguous ones into a manual-review list instead of guessing a
// grouping for them.
// ---------------------------------------------------------------------------
interface ManualReviewEntry {
  reason: string;
  invoiceNumber: string;
  customer: string;
  rowNumbers: number[];
}

interface InvoiceGroup {
  invoiceNumber: string;
  rows: SheetRow[];
}

function groupRows(rows: SheetRow[]): {
  groups: InvoiceGroup[];
  manualReview: ManualReviewEntry[];
  alreadySynced: SheetRow[];
} {
  const alreadySynced = rows.filter((r) => String(r.orderId || "").trim() !== "");
  const unsynced = rows.filter((r) => String(r.orderId || "").trim() === "");

  const manualReview: ManualReviewEntry[] = [];
  const byInvoice = new Map<string, SheetRow[]>();

  for (const row of unsynced) {
    const inv = String(row.invoiceNumber || "").trim();
    if (!inv) {
      manualReview.push({
        reason: "blank Invoice # -- never auto-grouped",
        invoiceNumber: inv,
        customer: row.customer,
        rowNumbers: [row.rowNumber],
      });
      continue;
    }
    if (!byInvoice.has(inv)) byInvoice.set(inv, []);
    byInvoice.get(inv)!.push(row);
  }

  const groups: InvoiceGroup[] = [];
  for (const [inv, groupedRows] of byInvoice) {
    const customerKeys = new Set(groupedRows.map((r) => normalizeCustomerKey(r.customer)));
    if (customerKeys.size > 1) {
      manualReview.push({
        reason: `ambiguous Invoice # ${inv} -- rows disagree on customer (${[...customerKeys].join(" vs ")})`,
        invoiceNumber: inv,
        customer: groupedRows.map((r) => r.customer).join(" | "),
        rowNumbers: groupedRows.map((r) => r.rowNumber),
      });
      continue;
    }
    groups.push({ invoiceNumber: inv, rows: groupedRows });
  }

  return { groups, manualReview, alreadySynced };
}

// ---------------------------------------------------------------------------
// Step 3/4: resolve account + products for a group and insert one order +
// its lines. Returns the orderId on success, or a manual-review reason on
// failure -- never creates an orphan order.
// ---------------------------------------------------------------------------
type BackfillResult =
  | { ok: true; orderId: string; lineCount: number }
  | { ok: false; reason: string };

async function backfillGroup(
  group: InvoiceGroup,
  accounts: Account[],
  reps: Rep[],
  productsBySkuCode: Map<string, Product>,
): Promise<BackfillResult> {
  const first = group.rows[0];

  const accountMatch = resolveAccount(first.customer, accounts);
  if (accountMatch === null) {
    return { ok: false, reason: `no matching Account found for customer "${first.customer}"` };
  }
  if (accountMatch === "ambiguous") {
    return { ok: false, reason: `multiple Accounts match customer "${first.customer}"` };
  }

  const unknownCodes = group.rows
    .map((r) => r.productCode)
    .filter((code) => !productsBySkuCode.has(code));
  if (unknownCodes.length > 0) {
    return {
      ok: false,
      reason: `unknown product code(s): ${[...new Set(unknownCodes)].join(", ")}`,
    };
  }

  const rep = resolveRep(first.salesRep, reps);
  if (first.salesRep && !rep) {
    console.warn(
      `  no Rep match for "${first.salesRep}" (invoice ${group.invoiceNumber}) -- leaving salesRepId unset.`,
    );
  }

  const poDate = parsePoDate(first.poDate);
  const orderId = ulid();

  await db.$transaction(async (tx) => {
    await tx.order.create({
      data: {
        id: orderId,
        accountId: accountMatch.id,
        channel: "rep_app",
        status: "confirmed",
        submittedAt: poDate,
        confirmedAt: poDate,
        createdAt: poDate,
        salesRepId: rep?.id,
        notes: first.notes || null,
        invoiceNumber: first.invoiceNumber || null,
        paymentMethod: first.paymentMethod || null,
        inventorySource: first.inventorySource || null,
        invoiceStatus: first.invoiceStatus || null,
      },
    });

    await tx.orderLine.createMany({
      data: group.rows.map((r, i) => ({
        orderId,
        productId: productsBySkuCode.get(r.productCode)!.id,
        qty: r.qty,
        // Historical data -- unit_price/line_total come directly from the
        // Sheet, never recomputed. This is not a new pricing decision.
        unitPrice: new Prisma.Decimal(r.price),
        lineTotal: new Prisma.Decimal(r.lineTotal),
        lineIndex: i,
        // Already known -- this row's real Sheet row number -- so there's
        // no reason to leave it null the way a line synced via the live
        // syncOrder path would start out. Lets the Sheet->DB webhook target
        // a Lot # edit at this exact line immediately, without waiting for
        // some later re-sync to backfill it.
        sheetRowNumber: r.rowNumber,
      })),
    });

    // No `source`/`channel` value exists for "backfilled historical order" in
    // the schema (channel is portal/sms/rep_app, none of which mean
    // "backfill"), and this script intentionally doesn't add one -- adding a
    // schema field is out of scope for a script other Phase 2 work is
    // proceeding in parallel against. Recorded here instead, in the
    // append-only order_events audit trail, which is exactly what it's for.
    await tx.orderEvent.create({
      data: {
        orderId,
        eventType: "backfill_import",
        actor: "system",
        payloadJson: {
          source: "backfill",
          invoiceNumber: group.invoiceNumber,
          sheetRowNumbers: group.rows.map((r) => r.rowNumber),
        },
      },
    });
  });

  return { ok: true, orderId, lineCount: group.rows.length };
}

// ---------------------------------------------------------------------------
// Mock Sheet data for local testing -- stands in for the real
// `action=allSalesRows` response until the parallel agent building it ships.
// Deliberately covers every case the design calls out:
//   - a multi-line order (INV26260, 2 lines, one customer)
//   - a single-line order (INV26261)
//   - a blank Invoice # row (never auto-grouped)
//   - an ambiguous Invoice # group (INV26262, two rows disagreeing on customer)
//   - a "Legal Entity / DBA Name" customer string resolving via the DBA
//     suffix match (INV26263 -> Account "540 SF", the exact example from
//     Code.gs's own customerMatches comment)
//   - a customer with no matching Account at all (INV26264 -> manual review)
//   - an unknown product code (INV26265 -> manual review)
//   - rows that already have an Order ID (INV26259 -> must be skipped, not
//     re-processed and not flagged)
// ---------------------------------------------------------------------------
function mockSalesRows(): SheetRow[] {
  const base = {
    licenseNumber: "",
    invoiceStatus: "Invoiced",
    notes: "",
    orderId: "",
  };
  return [
    // Already synced -- must be skipped entirely.
    {
      ...base,
      rowNumber: 10,
      invoiceNumber: "INV26259",
      customer: "The Grove Bar",
      poDate: "2026-08-10",
      productName: "Cantinesca",
      packagingFormat: "1/2 Barrel Keg (15.5 gal)",
      productCode: "CNT1AKHB01",
      qty: 1,
      price: 192.0,
      lineTotal: 192.0,
      salesRep: "T. Gilbert",
      paymentMethod: "Fintech",
      inventorySource: "EWD",
      orderId: "01J8ZZZZALREADYSYNCEDROW00",
    },
    // Multi-line order.
    {
      ...base,
      rowNumber: 20,
      invoiceNumber: "INV26260",
      customer: "The Grove Bar",
      poDate: "2026-08-15",
      productName: "Cantinesca",
      packagingFormat: "1/2 Barrel Keg (15.5 gal)",
      productCode: "CNT1AKHB01",
      qty: 2,
      price: 192.0,
      lineTotal: 384.0,
      salesRep: "T. Gilbert",
      paymentMethod: "Fintech",
      inventorySource: "EWD",
      notes: "Deliver before 10am",
    },
    {
      ...base,
      rowNumber: 21,
      invoiceNumber: "INV26260",
      customer: "The Grove Bar",
      poDate: "2026-08-15",
      productName: "Cantinesca",
      packagingFormat: "4/6/12 Case",
      productCode: "CNT1AC1224",
      qty: 10,
      price: 31.7,
      lineTotal: 317.0,
      salesRep: "T. Gilbert",
      paymentMethod: "Fintech",
      inventorySource: "EWD",
      notes: "Deliver before 10am",
    },
    // Single-line order.
    {
      ...base,
      rowNumber: 30,
      invoiceNumber: "INV26261",
      customer: "Downtown Liquor",
      poDate: "2026-08-16",
      productName: "Sunlight Groove — Bay Area",
      packagingFormat: "1/6 Barrel Keg (5.16 gal)",
      productCode: "SGB1AKSB01",
      qty: 3,
      price: 99.5,
      lineTotal: 298.5,
      salesRep: "J. Williams",
      paymentMethod: "ACH",
      inventorySource: "WLA Warehouse",
    },
    // Blank Invoice # -- manual review, never guessed into a group.
    {
      ...base,
      rowNumber: 40,
      invoiceNumber: "",
      customer: "Riverside Taproom",
      poDate: "2026-08-17",
      productName: "Cantinesca",
      packagingFormat: "1/6 Barrel Keg (5.16 gal)",
      productCode: "CNT1AKSB01",
      qty: 1,
      price: 96.0,
      lineTotal: 96.0,
      salesRep: "D. Krause",
      paymentMethod: "Check",
      inventorySource: "WLA Warehouse",
    },
    // Ambiguous Invoice # -- same invoice number, two different customers
    // (a data-entry error). Whole group goes to manual review.
    {
      ...base,
      rowNumber: 50,
      invoiceNumber: "INV26262",
      customer: "Riverside Taproom",
      poDate: "2026-08-18",
      productName: "Cantinesca",
      packagingFormat: "1/2 Barrel Keg (15.5 gal)",
      productCode: "CNT1AKHB01",
      qty: 1,
      price: 192.0,
      lineTotal: 192.0,
      salesRep: "D. Krause",
      paymentMethod: "Check",
      inventorySource: "WLA Warehouse",
    },
    {
      ...base,
      rowNumber: 51,
      invoiceNumber: "INV26262",
      customer: "Downtown Liquor",
      poDate: "2026-08-18",
      productName: "Sunlight Groove — Bay Area",
      packagingFormat: "1/6 Barrel Keg (5.16 gal)",
      productCode: "SGB1AKSB01",
      qty: 1,
      price: 99.5,
      lineTotal: 99.5,
      salesRep: "D. Krause",
      paymentMethod: "Check",
      inventorySource: "WLA Warehouse",
    },
    // "Legal Entity / DBA Name" customer string -- must resolve to Account
    // "540 SF" via the DBA-suffix match, same as customerMatches in Code.gs.
    {
      ...base,
      rowNumber: 60,
      invoiceNumber: "INV26263",
      customer: "Sutro Syndicate LLC / 540 SF",
      poDate: "2026-08-19",
      productName: "Sunlight Groove — Bay Area",
      packagingFormat: "1/2 Barrel Keg (15.5 gal)",
      productCode: "SGB1AKHB01",
      qty: 2,
      price: 205.0,
      lineTotal: 410.0,
      salesRep: "T. Gilbert",
      paymentMethod: "Fintech",
      inventorySource: "EWD",
    },
    // No matching Account at all -- manual review, never an orphan order.
    {
      ...base,
      rowNumber: 70,
      invoiceNumber: "INV26264",
      customer: "Unknown Bar Inc",
      poDate: "2026-08-20",
      productName: "Cantinesca",
      packagingFormat: "4/6/12 Case",
      productCode: "CNT1AC1224",
      qty: 5,
      price: 31.7,
      lineTotal: 158.5,
      salesRep: "S. Sprague",
      paymentMethod: "Check",
      inventorySource: "WLA Warehouse",
    },
    // Unknown product code -- manual review, never an orphan order.
    {
      ...base,
      rowNumber: 80,
      invoiceNumber: "INV26265",
      customer: "The Grove Bar",
      poDate: "2026-08-21",
      productName: "Discontinued Seasonal",
      packagingFormat: "1/2 Barrel Keg (15.5 gal)",
      productCode: "ZZZ-DISCONTINUED",
      qty: 1,
      price: 200.0,
      lineTotal: 200.0,
      salesRep: "T. Gilbert",
      paymentMethod: "Fintech",
      inventorySource: "EWD",
    },
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const rows = await fetchAllSalesRows();
  console.log(`Fetched ${rows.length} Sales row(s).`);

  const { groups, manualReview, alreadySynced } = groupRows(rows);
  console.log(
    `Grouped into ${groups.length} Invoice # group(s); ${alreadySynced.length} row(s) already synced (skipped); ` +
      `${manualReview.length} row-set(s) flagged for manual review before grouping.`,
  );

  const [accounts, reps, products] = await Promise.all([
    db.account.findMany(),
    db.rep.findMany(),
    db.product.findMany(),
  ]);
  const productsBySkuCode = new Map(products.map((p) => [p.skuCode, p]));

  const orderIdEntries: OrderIdEntry[] = [];
  let ordersCreated = 0;
  let linesCreated = 0;
  let accountMatchCount = 0;
  let accountNoMatchCount = 0;

  for (const group of groups) {
    const result = await backfillGroup(group, accounts, reps, productsBySkuCode);
    if (!result.ok) {
      accountNoMatchCount++;
      manualReview.push({
        reason: result.reason,
        invoiceNumber: group.invoiceNumber,
        customer: group.rows[0].customer,
        rowNumbers: group.rows.map((r) => r.rowNumber),
      });
      continue;
    }
    accountMatchCount++;
    ordersCreated++;
    linesCreated += result.lineCount;
    for (const r of group.rows) {
      orderIdEntries.push({ rowNumber: r.rowNumber, orderId: result.orderId });
    }
    console.log(
      `  created order ${result.orderId} for Invoice ${group.invoiceNumber} (${result.lineCount} line(s))`,
    );
  }

  await writeOrderIdsBack(orderIdEntries);

  console.log("\n========== Backfill summary ==========");
  console.log(`Invoice # groups processed: ${groups.length}`);
  console.log(`Orders created: ${ordersCreated}`);
  console.log(`Order lines created: ${linesCreated}`);
  console.log(`Rows already synced (skipped, untouched): ${alreadySynced.length}`);
  console.log(`Account resolution: ${accountMatchCount} matched / ${accountNoMatchCount} failed`);
  console.log(`Rows/groups flagged for manual review: ${manualReview.length}`);
  if (manualReview.length > 0) {
    console.log("\nManual review detail:");
    for (const entry of manualReview) {
      console.log(
        `  - Invoice "${entry.invoiceNumber || "(blank)"}" / customer "${entry.customer}" / ` +
          `rows [${entry.rowNumbers.join(", ")}]: ${entry.reason}`,
      );
    }
  }
  console.log("=======================================\n");
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
