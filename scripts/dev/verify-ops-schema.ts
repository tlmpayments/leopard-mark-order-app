import { PrismaClient } from "../../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "dotenv";

// tsx does not read .env.local the way the Prisma CLI does.
config({ path: ".env.local", quiet: true });

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });

  const views = await db.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.views WHERE table_schema = 'public' ORDER BY table_name`;
  console.log("views:", views.map((v) => v.table_name).join(", "));

  const s = await db.$queryRaw`SELECT * FROM "stock_by_location" LIMIT 1`;
  const a = await db.$queryRaw`SELECT * FROM "available_for_delivery" LIMIT 1`;
  console.log("stock_by_location queryable:", Array.isArray(s), "| available_for_delivery queryable:", Array.isArray(a));

  const role = await db.$queryRaw<Array<{ enumlabel: string }>>`
    SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'UserRole' ORDER BY e.enumsortorder`;
  console.log("UserRole:", role.map((r) => r.enumlabel).join(" | "));

  const repRole = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*)::bigint AS n FROM pg_type WHERE typname = 'RepRole'`;
  console.log("RepRole dropped:", Number(repRole[0].n) === 0);

  const tables = await db.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
  console.log(`tables (${tables.length}):`, tables.map((t) => t.table_name).join(", "));

  await db.$disconnect();
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
