/**
 * Import the real order history out of the Sheet into Postgres.
 *
 * This is what makes the Ops Hub show the actual business rather than an empty
 * pipeline. Without it the hub is correct and useless: 108 accounts at stage ①
 * and nothing else, because reps' orders have always landed in the "TLM
 * Distribution Master File" spreadsheet via Apps Script and no order has ever
 * been written to Postgres.
 *
 *   npx tsx scripts/import-sheet-orders.ts [--dry-run] [--limit N]
 *
 * READ-ONLY against the spreadsheet. It uses the legacy rep-app endpoints
 * (`allOrders`, `invoiceDetail`), which take no shared secret, and it never
 * writes a cell back. That matters: scripts/backfill-sheet-orders.ts does the
 * same job via `allSalesRows` but also stamps an Order ID into every row, which
 * the original prompt's ground rule says to do against a *copy* of the master
 * file. This script deliberately avoids that decision by not writing at all.
 *
 * Idempotent on `orders.invoice_number` (UNIQUE), so re-running only fills gaps.
 *
 * ---- Where each imported order lands in the pipeline ----
 *
 * The Sheet's "Invoice Status" column is the historical truth for orders that
 * pre-date Stripe, so it decides the stage:
 *
 *   Paid                        -> an Invoice row with status "paid"  -> stage 7
 *   Invoiced / Unpaid           -> an Invoice row with status "open"  -> stage 6
 *   Created / Not Created /
 *     Pending / (blank)         -> no Invoice row                    -> stage 2
 *   VOID / No Relationship      -> OrderStatus cancelled             -> off-pipeline
 *
 * Those Invoice rows carry `stripeInvoiceId = "sheet:INV#####"` rather than a
 * real Stripe id, because no Stripe invoice exists for them. Two reasons that
 * marker is the right call and not a fudge:
 *
 *   1. It is auditable. Anything starting "sheet:" was mirrored from the
 *      spreadsheet, never issued by this system.
 *   2. It stops re-billing. `issueOrderInvoice` short-circuits on an existing
 *      Invoice row, so importing history cannot cause a 2026 order to be
 *      invoiced a second time through Stripe.
 *
 * Without this mapping every historical order would import as "confirmed, not
 * scheduled" and the hub would show 284 orders apparently waiting to be
 * delivered -- which is worse than showing nothing, because it is wrong.
 */

import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "dotenv";
import { ulid } from "ulid";
import { aliasHistoricalSku } from "../lib/sheetSkuAlias";
import { buildAccountResolver } from "../lib/sheetAccountMatch";
import { readFileSync } from "node:fs";
import path from "node:path";

config({ path: ".env.local", quiet: true });

const DRY_RUN = process.argv.includes("--dry-run");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number.parseInt(process.argv[limitArg + 1] ?? "0", 10) : 0;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

/**
 * The Apps Script web app URL. Taken from the rep app's own config.js rather
 * than an env var: it is not a secret (it ships to every rep's browser) and
 * reading it from the file that already holds it means there is one copy.
 */
function appsScriptUrl(): string {
  const fromEnv = process.env.APPS_SCRIPT_URL;
  if (fromEnv) return fromEnv;
  const cfg = readFileSync(path.join(process.cwd(), "public/rep-app/assets/js/config.js"), "utf8");
  const m = /https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec/.exec(cfg);
  if (!m) throw new Error("Could not find APPS_SCRIPT_URL in public/rep-app/assets/js/config.js");
  return m[0];
}

const BASE = appsScriptUrl();

async function getJson<T>(params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}?${qs}`, { redirect: "follow" });
  const text = await res.text();
  if (text.trimStart().startsWith("<")) {
    // Apps Script answers with an HTML sign-in page when the deployment is not
    // world-readable. Say so plainly instead of failing on a JSON parse error.
    throw new Error("Apps Script returned HTML, not JSON — the web app is not publicly readable");
  }
  return JSON.parse(text) as T;
}

interface AllOrdersRow {
  invoiceNumber: string;
  customer: string;
  rep: string;
  poDate: string | null;
  status: string;
}

interface InvoiceDetail {
  ok: boolean;
  invoiceNumber: string;
  invoiceDate: string | null;
  poDate: string | null;
  dueDate: string | null;
  paymentTerms: string | null;
  salesRep: string | null;
  paymentMethod: string | null;
  expectedEmptyKegs: number | null;
  shipTo?: { name?: string; license?: string };
  lines: Array<{
    productName: string;
    packagingFormat: string;
    productCode: string;
    upc?: string;
    qty: number;
    unitPrice: number;
    total: number;
    unit?: string;
  }>;
  subtotal?: number;
  kegDepositQty?: number;
  kegDepositTotal?: number;
  invoiceTotal?: number;
}

/** Sheet status -> where the order sits. See the header comment. */
function classify(status: string): { cancelled: boolean; invoice: "paid" | "open" | null } {
  const s = status.trim().toLowerCase();
  if (s === "void" || s === "no relationship") return { cancelled: true, invoice: null };
  if (s === "paid") return { cancelled: false, invoice: "paid" };
  if (s === "invoiced" || s === "unpaid") return { cancelled: false, invoice: "open" };
  return { cancelled: false, invoice: null };
}

async function main(): Promise<void> {
  console.log(DRY_RUN ? "DRY RUN — nothing will be written\n" : "Importing order history from the Sheet\n");
  console.log(`Apps Script: ${BASE.slice(0, 58)}…`);

  const all = await getJson<{ ok: boolean; totalOrders: number; orders: AllOrdersRow[] }>({
    action: "allOrders",
  });
  if (!all.ok) throw new Error("allOrders returned ok:false");
  console.log(`Sheet reports ${all.totalOrders} orders\n`);

  // ---- Match tables, loaded once ----
  const [accounts, reps, products, existing] = await Promise.all([
    db.account.findMany({
      select: { id: true, businessName: true, legalEntity: true, terms: true, licenseNumber: true },
    }),
    db.rep.findMany({ select: { id: true, name: true } }),
    db.product.findMany({ select: { id: true, skuCode: true, listPrice: true } }),
    db.order.findMany({ where: { invoiceNumber: { not: null } }, select: { invoiceNumber: true } }),
  ]);

  const resolveAccount = buildAccountResolver(accounts);

  const repByName = new Map(reps.map((r) => [r.name.trim().toLowerCase(), r]));
  const productBySku = new Map(products.map((p) => [p.skuCode.trim().toUpperCase(), p]));
  const alreadyImported = new Set(existing.map((o) => o.invoiceNumber));

  const todo = all.orders
    .filter((o) => o.invoiceNumber && !alreadyImported.has(o.invoiceNumber))
    .slice(0, LIMIT || undefined);

  console.log(`${alreadyImported.size} already in Postgres; ${todo.length} to import\n`);
  if (todo.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const stats = {
    created: 0,
    cancelled: 0,
    invoicedRows: 0,
    skippedNoAccount: [] as string[],
    skippedNoLines: [] as string[],
    unknownSkus: new Map<string, number>(),
  };

  for (const [i, row] of todo.entries()) {
    if (i % 25 === 0) process.stdout.write(`  …${i}/${todo.length}\r`);

    const account = resolveAccount(row.customer);
    if (!account) {
      stats.skippedNoAccount.push(`${row.invoiceNumber} (${row.customer})`);
      continue;
    }

    let detail: InvoiceDetail;
    try {
      detail = await getJson<InvoiceDetail>({
        action: "invoiceDetail",
        invoiceNumber: row.invoiceNumber,
      });
    } catch (err) {
      stats.skippedNoLines.push(`${row.invoiceNumber} (fetch failed: ${(err as Error).message})`);
      continue;
    }
    if (!detail.ok || !Array.isArray(detail.lines)) {
      stats.skippedNoLines.push(`${row.invoiceNumber} (no detail)`);
      continue;
    }

    // Only lines whose SKU is already in the catalog. A missing SKU is reported
    // rather than invented: creating a Product here would guess at naming and
    // packaging that the catalog import owns.
    const lines = detail.lines
      .map((l) => {
        const alias = aliasHistoricalSku(l.productCode ?? "");
        return { line: l, product: alias ? productBySku.get(alias) : undefined };
      })
      .filter((x): x is { line: (typeof detail.lines)[number]; product: NonNullable<typeof x.product> } => {
        if (!x.product) {
          const raw = (x.line.productCode ?? "").trim() || "(blank)";
          const alias = aliasHistoricalSku(raw);
          const label = alias && alias !== raw ? `${raw} -> ${alias}` : raw;
          stats.unknownSkus.set(label, (stats.unknownSkus.get(label) ?? 0) + 1);
          return false;
        }
        return (Number(x.line.qty) || 0) > 0;
      });

    if (lines.length === 0) {
      stats.skippedNoLines.push(row.invoiceNumber);
      continue;
    }

    const { cancelled, invoice } = classify(row.status);
    const poDate = detail.poDate ?? row.poDate;
    const placedAt = poDate ? new Date(poDate) : new Date();
    const rep = repByName.get((detail.salesRep ?? row.rep ?? "").trim().toLowerCase());

    if (DRY_RUN) {
      stats.created += 1;
      if (cancelled) stats.cancelled += 1;
      if (invoice) stats.invoicedRows += 1;
      continue;
    }

    const orderId = ulid();
    try {
      await db.$transaction(async (tx) => {
        await tx.order.create({
          data: {
            id: orderId,
            accountId: account.id,
            channel: "rep_app",
            // Historical orders were real, binding orders: they were invoiced
            // and in most cases paid. `confirmed` is the honest status; VOID
            // rows become `cancelled`.
            status: cancelled ? "cancelled" : "confirmed",
            submittedAt: placedAt,
            confirmedAt: cancelled ? null : placedAt,
            salesRepId: rep?.id ?? null,
            invoiceNumber: row.invoiceNumber,
            invoiceStatus: row.status || null,
            paymentMethod: detail.paymentMethod || null,
            expectedEmptyKegs: detail.expectedEmptyKegs || null,
            // Deliberately NOT set: sheetSyncedAt (this row did not come from a
            // DB->Sheet write), deliveredAt and bolNumber (the Sheet's history
            // has no reliable delivery record, and inventing one would put
            // phantom movements in the ledger).
            lines: {
              create: lines.map(({ line, product }, idx) => ({
                productId: product.id,
                qty: Math.round(Number(line.qty)),
                unitPrice: Number(line.unitPrice) || Number(product.listPrice),
                lineTotal:
                  Number(line.total) ||
                  Math.round(Number(line.qty) * (Number(line.unitPrice) || Number(product.listPrice)) * 100) / 100,
                lineIndex: idx,
              })),
            },
          },
        });

        if (invoice) {
          const total =
            Number(detail.invoiceTotal) ||
            lines.reduce((s, { line }) => s + (Number(line.total) || 0), 0);
          await tx.invoice.create({
            data: {
              orderId,
              accountId: account.id,
              // "sheet:" marks this as mirrored history, never issued here.
              stripeInvoiceId: `sheet:${row.invoiceNumber}`,
              invoiceNumber: row.invoiceNumber,
              status: invoice,
              collectionMethod: "send_invoice",
              amountDue: total,
              amountPaid: invoice === "paid" ? total : 0,
              depositAmount: Number(detail.kegDepositTotal) || null,
              dueDate: detail.dueDate ? new Date(detail.dueDate) : null,
              sentAt: detail.invoiceDate ? new Date(detail.invoiceDate) : placedAt,
              paidAt: invoice === "paid" ? (detail.dueDate ? new Date(detail.dueDate) : placedAt) : null,
            },
          });
          stats.invoicedRows += 1;
        }

        // One event, so the order's audit trail is not empty and the hub can
        // say where the row came from.
        await tx.orderEvent.create({
          data: {
            orderId,
            eventType: "order.confirmed",
            actor: "system",
            payloadJson: {
              importedFrom: "sheet:allOrders+invoiceDetail",
              sheetInvoiceStatus: row.status,
              customerAsWritten: row.customer,
            },
          },
        });

        // Backfill the account's terms and licence from the invoice if the
        // account is missing them -- these are exactly two of the nine setup
        // checklist facts, and the Sheet already knows them.
        const patch: Record<string, string> = {};
        if (!account.terms && detail.paymentTerms) patch.terms = detail.paymentTerms;
        if (!account.licenseNumber && detail.shipTo?.license) patch.licenseNumber = detail.shipTo.license;
        if (Object.keys(patch).length > 0) {
          await tx.account.update({ where: { id: account.id }, data: patch });
        }

        // First order stamp: the earliest imported order is this account's
        // first, which is what keeps the Slack ":tada: FIRST ORDER" copy from
        // firing again for an account that has been buying for months.
        await tx.account.update({
          where: { id: account.id },
          data: { firstOrderAt: { set: placedAt } },
        });
      });

      stats.created += 1;
      if (cancelled) stats.cancelled += 1;
    } catch (err) {
      stats.skippedNoLines.push(`${row.invoiceNumber} (write failed: ${(err as Error).message.slice(0, 90)})`);
    }
  }

  console.log(`\n\nCreated:            ${stats.created} orders`);
  console.log(`  of which cancelled (VOID / no relationship): ${stats.cancelled}`);
  console.log(`  with a mirrored Invoice row:                 ${stats.invoicedRows}`);
  if (stats.skippedNoAccount.length) {
    console.log(`\nSkipped — no matching account (${stats.skippedNoAccount.length}):`);
    for (const s of stats.skippedNoAccount.slice(0, 12)) console.log(`  ${s}`);
    if (stats.skippedNoAccount.length > 12) console.log(`  … and ${stats.skippedNoAccount.length - 12} more`);
  }
  if (stats.skippedNoLines.length) {
    console.log(`\nSkipped — no usable lines (${stats.skippedNoLines.length}):`);
    for (const s of stats.skippedNoLines.slice(0, 12)) console.log(`  ${s}`);
  }
  if (stats.unknownSkus.size) {
    console.log(`\nSKUs not in the catalog (lines dropped, not invented):`);
    for (const [sku, n] of [...stats.unknownSkus].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${sku.padEnd(18)} ${n} line(s)`);
    }
  }
  console.log(DRY_RUN ? "\nDRY RUN complete — nothing written." : "\nDone.");
}

/**
 * Only run when invoked directly.
 *
 * Without this guard, `import`ing anything from this file executes the import:
 * a unit test of the SKU aliasing pulled the module in and wrote 95 real orders
 * into the development database as a side effect of running the test suite.
 * The alias table now lives in lib/sheetSkuAlias.ts so nothing needs to import
 * this script at all, and this is the second line of defence.
 */
const invokedDirectly = path.resolve(process.argv[1] ?? "").endsWith("import-sheet-orders.ts");

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
