/**
 * Development-only: a clean Bay Area day to demonstrate dispatch with.
 *
 * Wipes the transactional tables (leaving the seeded config — locations, SKUs,
 * route schedule, automation rules — in place), then creates five real-shaped
 * SF accounts with delivery windows and door instructions, confirmed orders
 * against real SKUs, and one driver.
 *
 * Deliberately leaves the routes EMPTY: building one is the thing being shown.
 *
 * Never point this at production. It deletes orders.
 *
 *   DATABASE_URL=<local> npx tsx scripts/dev/seed-dispatch-demo.ts
 */

import { PrismaClient, Prisma } from "../../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { ulid } from "ulid";
import bcrypt from "bcryptjs";

const url = process.env.DATABASE_URL ?? "";
if (!/@localhost|@127\.0\.0\.1/.test(url) || /neon\.tech|amazonaws|supabase/.test(url)) {
  console.error("Refusing to run against anything but a local database. Got:", url.slice(0, 40));
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

const ACCOUNTS = [
  {
    businessName: "Zeitgeist",
    legalEntity: "Zeitgeist SF LLC",
    address: "199 Valencia St, San Francisco, CA 94103",
    window: "Mon–Fri, 8–11am",
    instructions: "Alley entrance on Duboce. Ring the bell — do not leave at the front.",
    contact: "Nina Alvarez",
    phone: "+14155550138",
    lines: [["CNT1AKHB01", 4], ["SGB1AKHB01", 2]] as const,
  },
  {
    businessName: "Toronado",
    legalEntity: "Toronado Pub Inc.",
    address: "547 Haight St, San Francisco, CA 94117",
    window: "Weekdays before noon",
    instructions: "Kegs go down the sidewalk hatch. Ask for whoever is behind the bar.",
    contact: "Dev Okonkwo",
    phone: "+14155550172",
    lines: [["CNT1AKSB01", 6]] as const,
  },
  {
    businessName: "The Alembic",
    legalEntity: "Alembic Bar LLC",
    address: "1725 Haight St, San Francisco, CA 94117",
    window: "Tue/Thu, 9am–1pm",
    instructions: "Park in the loading zone out front. 15 minutes max.",
    contact: "Priya Raghunathan",
    phone: "+14155550194",
    lines: [["CNT1AKHB01", 2], ["SGB1AKSB01", 3]] as const,
  },
  {
    businessName: "Hopwater Distribution",
    legalEntity: "Hopwater Distribution LLC",
    address: "850 Bush St, San Francisco, CA 94108",
    window: "Mornings, before 10am",
    instructions: "Steep hill — chock the truck. Cellar door is around the corner on Taylor.",
    contact: "Sam Whitfield",
    phone: "+14155550110",
    lines: [["SGB1AC1224", 8], ["CNT1AC1224", 4]] as const,
  },
  {
    businessName: "Bartlett Hall",
    legalEntity: "Bartlett Hall SF LLC",
    address: "242 O'Farrell St, San Francisco, CA 94102",
    window: "Mon–Wed, 7–10am",
    instructions: "Use the freight door on Cyril Magnin. Code is on file with the GM.",
    contact: "Marisol Vega",
    phone: "+14155550166",
    lines: [["CNT1AKHB01", 3], ["CNT1AKSB01", 2], ["SGB1AKHB01", 1]] as const,
  },
];

async function wipe(): Promise<void> {
  // Children first. Config tables (locations, products, route schedules,
  // automation rules, commodities) are deliberately kept.
  await db.inventoryEvent.deleteMany({});
  await db.kegCustodyEntry.deleteMany({});
  await db.routeStop.deleteMany({});
  await db.deliveryRoute.deleteMany({});
  await db.orderEvent.deleteMany({});
  await db.syncLog.deleteMany({});
  await db.aiInterpretation.deleteMany({});
  await db.message.deleteMany({});
  await db.invoice.deleteMany({});
  await db.orderLine.deleteMany({});
  await db.shipment.deleteMany({});
  await db.order.deleteMany({});
  await db.consent.deleteMany({});
  await db.contact.deleteMany({});
  await db.accountPricing.deleteMany({});
  await db.account.deleteMany({});
  await db.userLocation.deleteMany({});
  await db.jobRun.deleteMany({});
  await db.documentLog.deleteMany({});
  await db.rep.deleteMany({});
  await db.bolSequence.deleteMany({});
  // The per-test warehouses vitest leaves behind; the 11 real ones stay.
  await db.location.deleteMany({ where: { name: { startsWith: "Test Warehouse" } } });
  console.log("wiped transactional tables");
}

async function main(): Promise<void> {
  await wipe();

  const pinHash = await bcrypt.hash("1234", 10);
  const [admin, , , driver] = await Promise.all([
    db.rep.create({ data: { name: "Jack Begley", role: "admin", pinHash } }),
    db.rep.create({ data: { name: "Dany", role: "ops", pinHash } }),
    db.rep.create({ data: { name: "Warehouse — Benicia", role: "warehouse", pinHash } }),
    db.rep.create({ data: { name: "Marco Reyes", role: "driver", phone: "+14155550123", pinHash } }),
  ]);
  await db.userLocation.create({ data: { userId: (await db.rep.findFirstOrThrow({ where: { name: "Warehouse — Benicia" } })).id, locationId: "WH-BEN" } });
  console.log("reps: Jack Begley (admin), Dany (ops), Warehouse — Benicia, Marco Reyes (driver) — all PIN 1234");

  let n = 0;
  for (const a of ACCOUNTS) {
    const account = await db.account.create({
      data: {
        businessName: a.businessName,
        legalEntity: a.legalEntity,
        licenseNumber: `21-${600000 + n * 137}`,
        licenseStatus: "active",
        region: "San Francisco",
        address: a.address,
        deliveryAddress: a.address,
        deliveryWindow: a.window,
        deliveryInstructions: a.instructions,
        paymentMethod: "ACH",
        terms: "Net 30",
        approvalStatus: "approved",
        salesRepId: admin.id,
        firstOrderAt: new Date(),
      },
    });
    const contact = await db.contact.create({
      data: { accountId: account.id, name: a.contact, phoneE164: a.phone, role: "Ordering", isAuthorizedSender: true },
    });

    const orderId = ulid();
    await db.order.create({
      data: {
        id: orderId,
        accountId: account.id,
        contactId: contact.id,
        channel: "rep_app",
        status: "confirmed",
        submittedAt: new Date(Date.now() - 3_600_000),
        confirmedAt: new Date(Date.now() - 3_000_000),
        salesRepId: admin.id,
        invoiceNumber: `INV26${400 + n}`,
        invoiceStatus: "Pending",
        paymentMethod: "ACH",
        notes: n === 1 ? "Cellar is tight — small kegs only." : null,
      },
    });

    let i = 0;
    for (const [sku, qty] of a.lines) {
      const product = await db.product.findFirstOrThrow({ where: { skuCode: sku } });
      const unit = product.listPrice ?? new Prisma.Decimal(0);
      await db.orderLine.create({
        data: {
          orderId,
          productId: product.id,
          qty,
          unitPrice: unit,
          lineTotal: new Prisma.Decimal(qty).mul(unit),
          lineIndex: i,
        },
      });
      i += 1;
    }
    n += 1;
    console.log(`  ${a.businessName}: ${a.lines.length} line(s), INV26${399 + n}`);
  }

  console.log(`\n${ACCOUNTS.length} confirmed orders waiting, no routes built.`);
  console.log(`Driver: ${driver.name} (PIN 1234) — signs in at /delivery`);
  console.log("Build a route at /ops/deliveries.");
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
