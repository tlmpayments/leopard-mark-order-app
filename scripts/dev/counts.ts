import { PrismaClient } from "../../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });
  const rows = {
    reps: await db.rep.count(),
    accounts: await db.account.count(),
    products: await db.product.count(),
    locations: await db.location.count(),
    routeSchedules: await db.routeSchedule.count(),
    automationRules: await db.automationRule.count(),
    orders: await db.order.count(),
    inventoryEvents: await db.inventoryEvent.count(),
    shipments: await db.shipment.count(),
    kegCustody: await db.kegCustodyEntry.count(),
    jobRuns: await db.jobRun.count(),
  };
  for (const [k, v] of Object.entries(rows)) console.log(`  ${k.padEnd(18)} ${v}`);
  const reps = await db.rep.findMany({ where: { active: true }, select: { name: true, role: true }, orderBy: { role: "asc" } });
  console.log("\n  sign-in users (PIN 1234):");
  for (const r of reps) console.log(`    ${r.name.padEnd(24)} ${r.role}`);
  await db.$disconnect(); await pool.end();
}
main();
