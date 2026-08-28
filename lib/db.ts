import { PrismaClient } from "@/app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

// Single connection pool + client per process. Next.js hot-reloads modules
// in dev, which would otherwise create a fresh pool (and exhaust Postgres
// connections) on every edit — cache the instance on `globalThis` so dev
// reuses it across reloads, same as the standard Next.js + Prisma pattern.
const globalForDb = globalThis as unknown as {
  pool?: Pool;
  prisma?: PrismaClient;
};

const pool =
  globalForDb.pool ?? new Pool({ connectionString: process.env.DATABASE_URL });

export const db =
  globalForDb.prisma ?? new PrismaClient({ adapter: new PrismaPg(pool) });

if (process.env.NODE_ENV !== "production") {
  globalForDb.pool = pool;
  globalForDb.prisma = db;
}
