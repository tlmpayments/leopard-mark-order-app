import { PrismaClient } from "../../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });
  const a = await db.account.findMany({
    select: { businessName: true, legalEntity: true },
    orderBy: { businessName: "asc" }, take: 14,
  });
  for (const x of a) console.log(`  businessName=${JSON.stringify(x.businessName)}  legalEntity=${JSON.stringify(x.legalEntity)}`);
  await db.$disconnect(); await pool.end();
}
main();
