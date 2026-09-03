/**
 * Refresh accounts from the live "Customer Accounts" tab.
 *
 *   npx tsx scripts/import-customer-accounts.ts [--dry-run]
 *
 * Read-only against the spreadsheet (the rep app's `customers` action, no
 * shared secret) and never writes a cell back.
 *
 * The 108 accounts in Postgres came from the rep app's *bundled*
 * `public/rep-app/assets/js/customers.js` — a snapshot committed to the repo,
 * not the live tab. It had drifted: 33 historical orders referenced customers
 * that snapshot had never heard of, including INV26277 ("La Sexy Michelada"),
 * which is the very invoice the build prompt uses as its worked example.
 *
 * ---- What this does and does not overwrite ----
 *
 * The Customer Accounts tab owns the commercial facts, so those are refreshed:
 * names, licence number, region, addresses, contact, terms, payment method,
 * priority, coordinates and the assigned rep.
 *
 * It does NOT own, and this never touches:
 *
 *   approvalStatus                  a decision made in this app
 *   licenseStatus / licenseExpiry   a verification state, not a sheet cell —
 *                                   §1.3 keeps the licence gate independent
 *   creditHold                      a human's commercial decision
 *   stripeCustomerId, stripeDefaultPaymentMethod, stripeSetupLinkSentAt
 *                                   Stripe's truth, mirrored by webhook
 *   firstOrderAt                    derived from real order history
 *   billingContactEmail             the tab's "Billing Contact Email" column is
 *                                   not exposed by the `customers` action, so
 *                                   overwriting it with the ordering contact
 *                                   would *lose* information (§6.2 keeps them
 *                                   as separate, ordered fallbacks)
 *   taxExempt
 *
 * Blank cells never clear a populated field: the tab is frequently sparse
 * (terms are filled on 47 of 119 rows), and treating "not entered" as "delete
 * what you have" would quietly erase good data.
 */

import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildAccountResolver } from "../lib/sheetAccountMatch";

config({ path: ".env.local", quiet: true });

const DRY_RUN = process.argv.includes("--dry-run");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

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
  const res = await fetch(`${BASE}?${new URLSearchParams(params)}`, { redirect: "follow" });
  const text = await res.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error("Apps Script returned HTML, not JSON — the web app is not publicly readable");
  }
  return JSON.parse(text) as T;
}

interface CustomerRow {
  establishmentName: string;
  salesRep?: string;
  region?: string;
  licenseNumber?: string;
  legalEntity?: string;
  orderingContact?: string;
  phone?: string;
  email?: string;
  address?: string;
  deliveryAddress?: string;
  deliveryInstructions?: string;
  paymentMethod?: string;
  terms?: string;
  priority?: string;
  tapHandleRequested?: string;
  importedToEkos?: boolean;
  lat?: number;
  lng?: number;
}

/** A trimmed value, or undefined when the cell is blank. Never an empty string. */
const val = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s ? s : undefined;
};

/** E.164-ish, matching what the foundation import produced. */
function normalizePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return undefined;
}

async function main(): Promise<void> {
  console.log(DRY_RUN ? "DRY RUN — nothing will be written\n" : "Refreshing accounts from Customer Accounts\n");

  const payload = await getJson<{ ok: boolean; customers: CustomerRow[] }>({ action: "customers" });
  const rows = (payload.customers ?? []).filter((r) => val(r.establishmentName));
  console.log(`Customer Accounts tab reports ${rows.length} accounts\n`);

  const [accounts, reps] = await Promise.all([
    db.account.findMany({
      select: { id: true, businessName: true, legalEntity: true, terms: true, region: true },
    }),
    db.rep.findMany({ select: { id: true, name: true } }),
  ]);
  const resolve = buildAccountResolver(accounts);
  const repByName = new Map(reps.map((r) => [r.name.trim().toLowerCase(), r]));

  let created = 0;
  let updated = 0;
  const unknownReps = new Map<string, number>();
  const regions = new Map<string, number>();

  for (const row of rows) {
    const name = val(row.establishmentName)!;
    regions.set(val(row.region) ?? "(blank)", (regions.get(val(row.region) ?? "(blank)") ?? 0) + 1);

    const repName = val(row.salesRep);
    const rep = repName ? repByName.get(repName.toLowerCase()) : undefined;
    if (repName && !rep && repName !== "N/A") {
      unknownReps.set(repName, (unknownReps.get(repName) ?? 0) + 1);
    }

    // Blank cells are omitted entirely, so they cannot clear a populated field.
    const fields = {
      businessName: name,
      legalEntity: val(row.legalEntity),
      licenseNumber: val(row.licenseNumber),
      region: val(row.region),
      address: val(row.address),
      deliveryAddress: val(row.deliveryAddress),
      deliveryInstructions: val(row.deliveryInstructions),
      paymentMethod: val(row.paymentMethod),
      terms: val(row.terms),
      priority: val(row.priority),
      importedToEkos: row.importedToEkos === true,
      lat: typeof row.lat === "number" ? row.lat : undefined,
      lng: typeof row.lng === "number" ? row.lng : undefined,
      salesRepId: rep?.id,
    };
    const data = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

    const existing = resolve(
      // Try the combined shape too, so an account stored under its legal entity
      // still matches a tab row that leads with the establishment name.
      val(row.legalEntity) ? `${row.legalEntity} / ${name}` : name,
    );

    if (DRY_RUN) {
      if (existing) updated += 1;
      else created += 1;
      continue;
    }

    let accountId: string;
    if (existing) {
      await db.account.update({ where: { id: existing.id }, data });
      accountId = existing.id;
      updated += 1;
    } else {
      const row2 = await db.account.create({
        data: {
          ...data,
          businessName: name,
          // A row that is already on the Customer Accounts tab is an account
          // the business has vetted; `pending` is for self-service portal
          // signups, which this is not.
          approvalStatus: "approved",
        },
        select: { id: true },
      });
      accountId = row2.id;
      created += 1;
    }

    // ---- Ordering contact ----
    const email = val(row.email);
    const contactName = val(row.orderingContact);
    const phone = normalizePhone(val(row.phone));
    if (email || contactName || phone) {
      const existingContact = await db.contact.findFirst({
        where: {
          accountId,
          OR: [
            ...(email ? [{ email }] : []),
            ...(contactName ? [{ name: contactName }] : []),
          ],
        },
        select: { id: true },
      });
      const contactData = {
        name: contactName,
        email,
        phoneE164: phone,
        role: "ordering",
        // isAuthorizedSender stays false: authorising a number to place orders
        // by SMS is a consent decision (§1.2), not a spreadsheet cell.
      };
      if (existingContact) {
        await db.contact.update({ where: { id: existingContact.id }, data: contactData });
      } else {
        await db.contact.create({ data: { ...contactData, accountId } });
      }
    }
  }

  console.log(`Created:   ${created}`);
  console.log(`Updated:   ${updated}`);

  if (unknownReps.size) {
    console.log(`\nSales reps on the tab with no Rep row (salesRepId left unset):`);
    for (const [n, c] of unknownReps) console.log(`  ${n} — ${c} account(s)`);
  }

  console.log(`\nRegions as written on the tab:`);
  for (const [r, c] of [...regions].sort((a, b) => b[1] - a[1])) console.log(`  ${r.padEnd(22)} ${c}`);

  const routeRegions = await db.routeSchedule.findMany({ select: { region: true }, distinct: ["region"] });
  const known = new Set(routeRegions.map((r) => r.region));
  const unmatched = [...regions.keys()].filter((r) => r !== "(blank)" && !known.has(r));
  if (unmatched.length) {
    console.log(
      `\n!! RouteSchedule covers [${[...known].join(", ")}], which matches NONE of the above.`,
    );
    console.log(
      `   Every account therefore fails the "region -> warehouse" setup check, and the`,
    );
    console.log(
      `   slot proposer has no route day to offer. These are city-level names and the`,
    );
    console.log(
      `   schedule is keyed to delivery regions — mapping them is §12 Q1, so it is left`,
    );
    console.log(`   for a human rather than guessed here.`);
  }

  console.log(DRY_RUN ? "\nDRY RUN complete — nothing written." : "\nDone.");
}

const invokedDirectly = path.resolve(process.argv[1] ?? "").endsWith("import-customer-accounts.ts");

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
