// Shared fixtures/db client for the Phase 2 (Sheet <-> Postgres sync) test
// suite. Deliberately its own PrismaClient/Pool (not `lib/db.ts`'s singleton)
// so test cleanup (`closeTestDb`) can tear down independently of whatever
// pool app code under test (e.g. the webhook route, which imports
// `@/lib/db`) opened against the same DATABASE_URL.
import { PrismaClient, Prisma } from "../app/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { ulid } from "ulid";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const testDb = new PrismaClient({ adapter: new PrismaPg(pool) });

export async function closeTestDb(): Promise<void> {
  await testDb.$disconnect();
  await pool.end();
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

export interface FixtureOrderOverrides {
  invoiceNumber?: string;
  notes?: string | null;
  invoiceStatus?: string | null;
  paymentMethod?: string | null;
  inventorySource?: string | null;
}

// One order with one line, one account, one rep, one product -- enough
// surface for both the webhook conflict-resolution tests and the SyncLog
// idempotency tests. Every name/code is suffixed with a random string so
// concurrent test cases (and repeated `npm test` runs against the same
// long-lived local test Postgres) never collide on a unique constraint
// (`reps.name`, `products.sku_code`).
export async function createFixtureOrder(overrides: FixtureOrderOverrides = {}) {
  const suffix = randomSuffix();

  const rep = await testDb.rep.create({
    data: { name: `Test Rep ${suffix}` },
  });

  const account = await testDb.account.create({
    data: {
      businessName: `Test Account ${suffix}`,
      licenseNumber: `LIC-${suffix}`,
      paymentMethod: "Fintech",
      salesRepId: rep.id,
    },
  });

  const product = await testDb.product.create({
    data: {
      skuCode: `SKU-${suffix}`,
      productName: "Cantinesca",
      formatLabel: "1/2 Barrel Keg",
      formatDetail: "15.5 gal",
      unit: "keg",
      listPrice: new Prisma.Decimal(192.0),
    },
  });

  const orderId = ulid();
  const order = await testDb.order.create({
    data: {
      id: orderId,
      accountId: account.id,
      channel: "rep_app",
      status: "confirmed",
      confirmedAt: new Date(),
      salesRepId: rep.id,
      notes: overrides.notes ?? "Deliver before 10am",
      invoiceNumber: overrides.invoiceNumber ?? `INVTEST-${suffix}`,
      paymentMethod: overrides.paymentMethod ?? "Fintech",
      inventorySource: overrides.inventorySource ?? "EWD",
      invoiceStatus: overrides.invoiceStatus ?? "Pending",
    },
  });

  await testDb.orderLine.create({
    data: {
      orderId: order.id,
      productId: product.id,
      qty: 2,
      unitPrice: new Prisma.Decimal(192.0),
      lineTotal: new Prisma.Decimal(384.0),
      lineIndex: 0,
    },
  });

  return { order, account, rep, product, suffix };
}

// Same shape as createFixtureOrder, but with TWO lines, each stamped with a
// distinct sheetRowNumber (as lib/sheetSync.ts would after a real syncOrder
// round trip) -- specifically for testing that a Lot # edit targets the ONE
// line a given Sheet row represents, not every line of the order.
export async function createFixtureOrderWithTwoLines(rowNumbers: [number, number]) {
  const suffix = randomSuffix();

  const rep = await testDb.rep.create({ data: { name: `Test Rep ${suffix}` } });
  const account = await testDb.account.create({
    data: {
      businessName: `Test Account ${suffix}`,
      licenseNumber: `LIC-${suffix}`,
      paymentMethod: "Fintech",
      salesRepId: rep.id,
    },
  });
  const productA = await testDb.product.create({
    data: {
      skuCode: `SKU-A-${suffix}`,
      productName: "Cantinesca",
      formatLabel: "1/2 Barrel Keg",
      formatDetail: "15.5 gal",
      unit: "keg",
      listPrice: new Prisma.Decimal(192.0),
    },
  });
  const productB = await testDb.product.create({
    data: {
      skuCode: `SKU-B-${suffix}`,
      productName: "Sunlight Groove — Bay Area",
      formatLabel: "1/6 Barrel Keg",
      formatDetail: "5.16 gal",
      unit: "keg",
      listPrice: new Prisma.Decimal(99.5),
    },
  });

  const orderId = ulid();
  const order = await testDb.order.create({
    data: {
      id: orderId,
      accountId: account.id,
      channel: "rep_app",
      status: "confirmed",
      confirmedAt: new Date(),
      salesRepId: rep.id,
      invoiceNumber: `INVTEST-${suffix}`,
      paymentMethod: "Fintech",
      inventorySource: "EWD",
      invoiceStatus: "Pending",
    },
  });

  const lineA = await testDb.orderLine.create({
    data: {
      orderId: order.id,
      productId: productA.id,
      qty: 1,
      unitPrice: new Prisma.Decimal(192.0),
      lineTotal: new Prisma.Decimal(192.0),
      lineIndex: 0,
      sheetRowNumber: rowNumbers[0],
    },
  });
  const lineB = await testDb.orderLine.create({
    data: {
      orderId: order.id,
      productId: productB.id,
      qty: 1,
      unitPrice: new Prisma.Decimal(99.5),
      lineTotal: new Prisma.Decimal(99.5),
      lineIndex: 1,
      sheetRowNumber: rowNumbers[1],
    },
  });

  return { order, account, rep, lineA, lineB, suffix };
}
