// One-time Phase 1 import: seeds Postgres from the data already bundled into
// the static rep app (public/rep-app/assets/js/customers.js) plus the
// product/price maps that today live only in apps-script/Code.gs.
//
// This is NOT the live Sheet sync (that's Phase 2) — it's a one-shot load so
// Foundation has real data to build against. Accounts imported here get
// `sheetRowRef = null`; Phase 2's reconciliation pass is what pins each
// account to its actual "Customer Accounts" row once the sync job can read
// the live Sheet. Re-running this script is a no-op if accounts already
// exist (see the guard below) — it's meant to run once per environment, not
// as a repeatable sync.
//
// Usage: DATABASE_URL=... npx tsx scripts/import-foundation-data.ts
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "../app/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

// Mirrors Code.gs's PRICE_MAP/UPC_MAP/PRODUCT_UNIT_MAP + assets/js/products.js
// formats[] — the canonical SKU catalog as of this import. Server is the
// source of truth for prices going forward (see plan's data-model notes);
// this is just the one-time seed of that source.
const PRODUCTS = [
  {
    skuCode: "CNT1AKHB01",
    productName: "Cantinesca",
    formatLabel: "1/2 Barrel Keg",
    formatDetail: "15.5 gal",
    unit: "keg",
    listPrice: 192.0,
  },
  {
    skuCode: "CNT1AKSB01",
    productName: "Cantinesca",
    formatLabel: "1/6 Barrel Keg",
    formatDetail: "5.16 gal",
    unit: "keg",
    listPrice: 96.0,
  },
  {
    skuCode: "CNT1AC1224",
    productName: "Cantinesca",
    formatLabel: "4/6/12 Case",
    formatDetail: "4 six-packs of 12oz cans",
    unit: "case",
    listPrice: 31.7,
  },
  {
    skuCode: "SGB1AKHB01",
    productName: "Sunlight Groove — Bay Area",
    formatLabel: "1/2 Barrel Keg",
    formatDetail: "15.5 gal",
    unit: "keg",
    listPrice: 205.0,
  },
  {
    skuCode: "SGB1AKSB01",
    productName: "Sunlight Groove — Bay Area",
    formatLabel: "1/6 Barrel Keg",
    formatDetail: "5.16 gal",
    unit: "keg",
    listPrice: 99.5,
  },
  {
    skuCode: "SGB1AC1224",
    productName: "Sunlight Groove — Bay Area",
    formatLabel: "4/6/12 Case",
    formatDetail: "4 six-packs of 12oz cans",
    unit: "case",
    listPrice: 36.25,
  },
];

// The 4 distinct rep names that actually appear as `salesRep` across all 107
// bundled accounts (verified by scanning customers.js), plus the account
// owner/admin. Written exactly as they appear in the source data — no
// attempt to reconcile "T. Gilbert" against a longer canonical name, since
// there's no reliable ground truth for that without the live Reps tab. PINs
// are intentionally left unset: every imported rep goes through the same
// "choose your PIN" first-login flow a brand new rep would.
const REPS: { name: string; role: "rep" | "admin" }[] = [
  { name: "Jack Begley", role: "admin" },
  { name: "T. Gilbert", role: "rep" },
  { name: "J. Williams", role: "rep" },
  { name: "D. Krause", role: "rep" },
  { name: "S. Sprague", role: "rep" },
];

interface BundledCustomer {
  establishmentName: string;
  salesRep?: string;
  region?: string;
  licenseNumber?: string;
  legalEntity?: string;
  orderingContact?: string;
  phone?: string;
  email?: string;
  address?: string;
  deliveryInstructions?: string;
  paymentMethod?: string;
  terms?: string;
  priority?: string;
  deliveryAddress?: string;
  importedToEkos?: boolean;
  lat?: number | null;
  lng?: number | null;
}

// Best-effort E.164 normalization for US numbers. Handles the ordinary
// "(707)695-3035" formatting AND a corruption pattern actually present in
// the source data — Excel coercing a phone number to a float and appending
// ".0" (e.g. "4153455538.0" for the Argonaut Hotel) — by stripping that
// suffix before stripping non-digits, so it doesn't get read as an extra
// trailing digit. Returns null (never a guess) for anything that isn't
// unambiguously a 10-digit US number once cleaned.
function normalizePhoneE164(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/\.0$/, "");
  const digits = cleaned.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function loadBundledCustomers(): BundledCustomer[] {
  const filePath = path.join(
    __dirname,
    "../public/rep-app/assets/js/customers.js",
  );
  const raw = fs.readFileSync(filePath, "utf8");
  // The file is `window.LM_CUSTOMERS = [ ...valid JSON... ];` — strip the JS
  // wrapper rather than eval() it.
  const jsonText = raw
    .replace(/^window\.LM_CUSTOMERS\s*=\s*/, "")
    .replace(/;\s*$/, "");
  return JSON.parse(jsonText);
}

async function main() {
  const products = await Promise.all(
    PRODUCTS.map((p) =>
      db.product.upsert({
        where: { skuCode: p.skuCode },
        create: p,
        update: p,
      }),
    ),
  );
  console.log(`Products: ${products.length} upserted.`);

  const reps = await Promise.all(
    REPS.map((r) =>
      db.rep.upsert({
        where: { name: r.name },
        create: { name: r.name, role: r.role },
        update: { role: r.role },
      }),
    ),
  );
  const repByName = new Map(reps.map((r) => [r.name, r]));
  console.log(`Reps: ${reps.length} upserted.`);

  const existingAccountCount = await db.account.count();
  if (existingAccountCount > 0) {
    console.log(
      `Accounts: ${existingAccountCount} already present — skipping account import ` +
        `(this script is a one-time load, not a repeatable sync; see file header).`,
    );
    return;
  }

  const customers = loadBundledCustomers();
  let imported = 0;
  let unparseablePhones = 0;
  for (const c of customers) {
    const rep = c.salesRep ? repByName.get(c.salesRep.trim()) : undefined;
    const phoneE164 = normalizePhoneE164(c.phone);
    if (c.phone && !phoneE164) {
      unparseablePhones++;
      console.warn(`  could not normalize phone for "${c.establishmentName}": "${c.phone}"`);
    }
    const account = await db.account.create({
      data: {
        businessName: c.establishmentName,
        legalEntity: c.legalEntity || null,
        licenseNumber:
          c.licenseNumber && c.licenseNumber !== "N/A" ? c.licenseNumber : null,
        licenseState: "CA",
        // Not verified against the state's ABC system yet — Phase 1 just
        // imports what the Sheet has. The independent license gate (plan's
        // compliance section) starts enforcing this in a later phase.
        licenseStatus: "unknown",
        salesRepId: rep?.id,
        region: c.region || null,
        address: c.address || null,
        deliveryAddress: c.deliveryAddress || null,
        deliveryInstructions: c.deliveryInstructions || null,
        paymentMethod: c.paymentMethod || null,
        terms: c.terms || null,
        priority: c.priority || null,
        importedToEkos: !!c.importedToEkos,
        lat: c.lat ?? null,
        lng: c.lng ?? null,
        contacts: c.orderingContact
          ? {
              create: [
                {
                  name: c.orderingContact,
                  email: c.email || null,
                  phoneE164,
                  role: "ordering_contact",
                },
              ],
            }
          : undefined,
      },
    });
    imported++;
    if (imported % 25 === 0) console.log(`  ...${imported} accounts imported`);
  }

  console.log(`Accounts: ${imported} imported (of ${customers.length} in source).`);
  if (unparseablePhones > 0) {
    console.log(`  ${unparseablePhones} contact phone number(s) could not be normalized — review the warnings above.`);
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

