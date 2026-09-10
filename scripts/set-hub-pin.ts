/**
 * Set (or change) the Ops Hub's shared PIN.
 *
 *   npx tsx scripts/set-hub-pin.ts 8888 [--dry-run]
 *
 * The PIN is the `pinHash` of one ordinary Rep row named "Ops Hub" -- see
 * lib/ops/hubPin.ts for why the hub is a shared credential and what that
 * costs. Creating the row here rather than in a migration keeps the PIN out
 * of the repository and out of the deployment: changing it is this command
 * and nothing else, with no redeploy.
 *
 * The row is created with the `admin` role deliberately. Every hub screen the
 * open-access flag used to serve -- Settings, the automation toggles, Issue
 * invoice -- was reachable while every visitor was treated as an admin, so
 * anything narrower would take away a screen someone is already using. What
 * the PIN does NOT open is /admin (its own name + PIN) or /delivery (the
 * driver's own).
 */

import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "dotenv";
import bcrypt from "bcryptjs";
import { HUB_PIN_REP_NAME } from "../lib/ops/hubPin";

// tsx does not read .env.local the way the Prisma CLI does, so without this
// every write would go to localhost.
config({ path: ".env.local", quiet: true });

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const pin = args.find((a) => !a.startsWith("--"))?.trim();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main(): Promise<void> {
  if (!pin || !/^\d{4}$/.test(pin)) {
    console.error("Usage: npx tsx scripts/set-hub-pin.ts <4-digit PIN> [--dry-run]");
    process.exitCode = 1;
    return;
  }

  const existing = await db.rep.findUnique({ where: { name: HUB_PIN_REP_NAME } });

  if (DRY_RUN) {
    console.log(
      existing
        ? `Would set the PIN on the existing "${HUB_PIN_REP_NAME}" row (role ${existing.role}, ${existing.active ? "active" : "inactive"}).`
        : `Would create "${HUB_PIN_REP_NAME}" (role admin) with this PIN.`,
    );
    return;
  }

  const pinHash = await bcrypt.hash(pin, 10);
  const rep = await db.rep.upsert({
    where: { name: HUB_PIN_REP_NAME },
    // Re-activate on purpose: the way to turn the hub off is to deactivate
    // this row, and the way to turn it back on is to run this command again.
    update: { pinHash, active: true },
    create: { name: HUB_PIN_REP_NAME, pinHash, active: true, role: "admin" },
  });

  console.log(`${existing ? "Updated" : "Created"} ${rep.name} (role ${rep.role}) — PIN set.`);
  console.log("Unlock at https://ops.tlmbg.co/unlock");
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
