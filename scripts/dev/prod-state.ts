import { PrismaClient } from "../../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "dotenv";

// tsx does not read .env.local the way the Prisma CLI does (prisma.config.ts
// loads it explicitly), so load it here or every query goes to localhost.
config({ path: ".env.local", quiet: true });
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });
  const orders = await db.order.count();
  const byStatus = await db.order.groupBy({ by: ["status"], _count: { _all: true } });
  const unsynced = await db.order.count({ where: { status: "confirmed", sheetSyncedAt: null } });
  console.log("orders:", orders);
  console.log("by status:", byStatus.map((s) => `${s.status}=${s._count._all}`).join(" ") || "(none)");
  console.log("confirmed with sheetSyncedAt NULL:", unsynced);
  console.log("accounts:", await db.account.count());
  console.log("products:", await db.product.count());
  console.log("reps:", await db.rep.count());
  const reps = await db.rep.findMany({ select: { name: true, role: true, pinHash: true } });
  console.log("rep roles:", reps.map((r) => `${r.name}=${r.role}${r.pinHash ? "" : " (no PIN)"}`).join(" | "));
  await db.$disconnect(); await pool.end();
}
main().catch((e) => { console.error("CODE:", e.code); console.error("MSG:", JSON.stringify(e.message)); console.error("META:", JSON.stringify(e.meta)); process.exit(1); });
