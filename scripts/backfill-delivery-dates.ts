/**
 * Copy the Sales sheet's "Delivery (Invoice) Date" into orders.delivery_date.
 *
 *   npx tsx scripts/backfill-delivery-dates.ts            # PREVIEW: writes nothing
 *   npx tsx scripts/backfill-delivery-dates.ts --apply    # writes the dates
 *   npx tsx scripts/backfill-delivery-dates.ts --limit 10 # only the first 10 invoices
 *
 * Why this exists. "Awaiting delivery" means "has no delivery date"
 * (lib/awaitingScheduling.ts), and the sheet is where delivery dates live. The
 * September order-history import never copied that column, so every imported
 * order looks undated here -- including the ones the sheet has long since
 * dated -- and they all read as waiting. This fills the column in, from the
 * sheet, for the orders already in the database.
 *
 * What it will and will not do:
 *  - It sets `deliveryDate` only where the database has none and the sheet has
 *    one. It never overwrites a date the database already holds, never clears
 *    one, and never touches scheduledFor, deliveredAt, BOLs or the ledger --
 *    deliveryDate is the field the schema calls Sheet-owned.
 *  - It does NOT create orders. Sheet invoices that are missing from the
 *    database are listed; bringing them in is scripts/import-sheet-orders.ts's
 *    job (run that with --dry-run first).
 *
 * It reads the sheet through the same public Apps Script endpoint the importer
 * uses (`allOrders`, then `invoiceDetail` per invoice). The URL defaults to the
 * one the rep app ships with.
 */

import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { AWAITING_SCHEDULING_WHERE } from "../lib/awaitingScheduling";

config({ path: ".env.local", quiet: true });

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) || 0 : 0;

function appsScriptUrl(): string {
  if (process.env.APPS_SCRIPT_URL) return process.env.APPS_SCRIPT_URL;
  try {
    const cfg = readFileSync("public/rep-app/assets/js/config.js", "utf8");
    const m = /APPS_SCRIPT_URL:\s*'([^']+)'/.exec(cfg);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  throw new Error("Set APPS_SCRIPT_URL (or run from the repo root so config.js can be read).");
}
const BASE = appsScriptUrl();

async function getJson<T>(params: Record<string, string>): Promise<T> {
  const res = await fetch(`${BASE}?${new URLSearchParams(params)}`, { redirect: "follow" });
  const text = await res.text();
  if (text.trimStart().startsWith("<")) throw new Error("Apps Script returned HTML, not JSON (not publicly readable)");
  return JSON.parse(text) as T;
}

type SheetInvoice = { invoiceNumber: string; customer: string; poDate: string | null; status: string };
// invoiceDetail names the sheet's "Delivery (Invoice) Date" `invoiceDate` (it is
// the date the invoice and its due date are counted from); there is no
// `deliveryDate` field in the response.
type Detail = { ok: boolean; invoiceDate?: string | null };

/** The sheet's cell as a date, or null when it is blank or not a date. */
function asDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}
// The sheet stores Pacific midnight (07:00Z), so "the same day" has to be read in
// Pacific time, not UTC.
const PT_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
const ymd = (d: Date) => PT_DAY.format(d);

async function pool_map<T, R>(items: T[], size: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
        if ((i + 1) % 20 === 0) process.stderr.write(`  …${i + 1}/${items.length}\r`);
      }
    }),
  );
  return out;
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main(): Promise<void> {
  console.log(APPLY ? "APPLY — will write delivery dates\n" : "PREVIEW — nothing will be written\n");

  const all = await getJson<{ ok: boolean; orders: SheetInvoice[] }>({ action: "allOrders" });
  if (!all.ok) throw new Error("allOrders returned ok:false");
  const invoices = all.orders.filter((o) => o.invoiceNumber).slice(0, LIMIT || undefined);
  console.log(`Sheet: ${all.orders.length} invoices (${invoices.length} checked)`);

  const dbOrders = await db.order.findMany({
    where: { invoiceNumber: { not: null } },
    select: {
      id: true, invoiceNumber: true, deliveryDate: true, scheduledFor: true, deliveredAt: true, status: true,
      account: { select: { businessName: true } },
    },
  });
  const byInvoice = new Map(dbOrders.map((o) => [o.invoiceNumber!, o]));
  console.log(`Database: ${dbOrders.length} orders with an invoice number\n`);

  const details = await pool_map(invoices, 4, async (inv) => {
    try {
      const d = await getJson<Detail>({ action: "invoiceDetail", invoiceNumber: inv.invoiceNumber });
      return d.ok ? asDate(d.invoiceDate) : undefined; // undefined = could not read
    } catch {
      return undefined;
    }
  });
  process.stderr.write("\n");

  const toSet: { id: string; invoice: string; customer: string; date: Date }[] = [];
  const matches: string[] = [];
  const differs: string[] = [];
  const stillAwaiting: string[] = [];
  const sheetBlankDbDated: string[] = [];
  const missingInDb: string[] = [];
  const unreadable: string[] = [];

  invoices.forEach((inv, i) => {
    const sheetDate = details[i];
    const order = byInvoice.get(inv.invoiceNumber);
    const label = `${inv.invoiceNumber}  ${inv.customer}  (PO ${inv.poDate ? ymd(new Date(inv.poDate)) : "?"}, ${inv.status || "no status"})`;
    if (sheetDate === undefined) return void unreadable.push(label);
    if (!order) return void missingInDb.push(`${label}  sheet delivery date: ${sheetDate ? ymd(sheetDate) : "NONE"}`);
    if (sheetDate && !order.deliveryDate) return void toSet.push({ id: order.id, invoice: inv.invoiceNumber, customer: inv.customer, date: sheetDate });
    if (sheetDate && order.deliveryDate) return void (ymd(sheetDate) === ymd(order.deliveryDate) ? matches : differs).push(`${label}  sheet ${ymd(sheetDate)} / db ${ymd(order.deliveryDate)}`);
    if (!sheetDate && order.deliveryDate) return void sheetBlankDbDated.push(`${label}  db ${ymd(order.deliveryDate)}`);
    if (!order.scheduledFor && !order.deliveredAt) stillAwaiting.push(label);
  });

  console.log("RESULT");
  console.log(`  would SET a delivery date on ........ ${toSet.length} orders (sheet has a date, database has none)`);
  console.log(`  already correct ...................... ${matches.length}`);
  console.log(`  differ (left alone, never overwritten) ${differs.length}`);
  console.log(`  sheet blank but database has a date .. ${sheetBlankDbDated.length}`);
  console.log(`  no date in the sheet -> stay AWAITING  ${stillAwaiting.length}`);
  console.log(`  in the sheet, NOT in the database .... ${missingInDb.length}`);
  console.log(`  could not be read from the sheet ..... ${unreadable.length}`);
  console.log(`  in the database, not in the sheet .... ${dbOrders.filter((o) => !invoices.some((i) => i.invoiceNumber === o.invoiceNumber)).length}${LIMIT ? " (meaningless with --limit)" : ""}`);

  const show = (title: string, rows: string[], n = 40) => {
    if (!rows.length) return;
    console.log(`\n${title} (${rows.length})`);
    rows.slice(0, n).forEach((r) => console.log("  " + r));
    if (rows.length > n) console.log(`  …and ${rows.length - n} more`);
  };
  show("STAY AWAITING — sheet has no delivery date, so these need scheduling", stillAwaiting);
  show("IN THE SHEET BUT NOT IN THE DATABASE — import these with scripts/import-sheet-orders.ts", missingInDb);
  show("DIFFER — sheet and database disagree; not changed", differs);
  show("SHEET BLANK, DATABASE DATED", sheetBlankDbDated, 15);
  show("COULD NOT READ", unreadable, 15);
  show("SAMPLE of dates that would be set", toSet.slice(0, 8).map((t) => `${t.invoice}  ${t.customer}  -> ${ymd(t.date)}`), 8);

  // What the route builder's "awaiting" list would be right now vs. after.
  const awaitingNow = await db.order.count({ where: { ...AWAITING_SCHEDULING_WHERE, routeStop: { is: null } } });
  const leaving = toSet.length ? await db.order.count({ where: { ...AWAITING_SCHEDULING_WHERE, routeStop: { is: null }, id: { in: toSet.map((t) => t.id) } } }) : 0;
  console.log(`\nAwaiting-delivery list today: ${awaitingNow}. Of those, ${leaving} would drop off once dated, leaving ${awaitingNow - leaving}.`);

  if (!APPLY) {
    console.log("\nPreview only. Re-run with --apply to write the dates.");
    return;
  }
  let written = 0;
  for (const t of toSet) {
    // Re-check in the WHERE so a date someone set a moment ago is never overwritten.
    const r = await db.order.updateMany({ where: { id: t.id, deliveryDate: null }, data: { deliveryDate: t.date } });
    written += r.count;
  }
  console.log(`\nWrote ${written} delivery dates.`);
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
