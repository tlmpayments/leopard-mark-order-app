/**
 * Set a person's PIN for the delivery site's PIN-only sign-in.
 *
 *   npx tsx scripts/set-delivery-pin.ts "Jack Begley" 0000 [--dry-run]
 *
 * The delivery site identifies a person by their PIN alone (lib/deliveryPin.ts),
 * which only works if no two people share one. So this refuses, before writing
 * anything, when another active delivery-site account already has the PIN you
 * are asking for, and says who.
 *
 * It writes `deliveryPinHash`, NOT `pinHash`. The ordinary PIN is also the
 * password for /admin/login (name + PIN, full access), so it stays as it was:
 * this PIN opens the delivery site and nothing else. The shared "Ops Hub"
 * account is left out of the comparison: its PIN is for a different door.
 *
 * Note what a short PIN costs. A PIN such as 0000 is the first one anybody
 * tries. Sessions minted through the PIN-only sign-in are stamped delivery-only
 * (proxy.ts), which limits what a guess can reach -- it does not make the PIN
 * secret.
 */

import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "dotenv";
import bcrypt from "bcryptjs";
import { DELIVERY_ROLES } from "../lib/ops/roles";
import { HUB_PIN_REP_NAME } from "../lib/ops/hubPin";

// tsx does not read .env.local the way the Prisma CLI does.
config({ path: ".env.local", quiet: true });

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const [name, pin] = args.filter((a) => !a.startsWith("--")).map((a) => a.trim());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main(): Promise<void> {
  if (!name || !pin || !/^\d{4}$/.test(pin)) {
    console.error('Usage: npx tsx scripts/set-delivery-pin.ts "<exact name>" <4-digit PIN> [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const rep = await db.rep.findUnique({ where: { name } });
  if (!rep) {
    console.error(`No account named "${name}".`);
    process.exitCode = 1;
    return;
  }
  if (!DELIVERY_ROLES.includes(rep.role)) {
    console.error(`${rep.name} has the ${rep.role} role, which cannot use the delivery site.`);
    process.exitCode = 1;
    return;
  }

  // Would this PIN make the sign-in ambiguous?
  const others = await db.rep.findMany({
    where: {
      active: true,
      role: { in: [...DELIVERY_ROLES] },
      OR: [{ deliveryPinHash: { not: null } }, { pinHash: { not: null } }],
      NOT: [{ id: rep.id }, { name: HUB_PIN_REP_NAME }],
    },
    select: { name: true, pinHash: true, deliveryPinHash: true },
  });
  for (const other of others) {
    const theirs = other.deliveryPinHash ?? other.pinHash;
    if (theirs && (await bcrypt.compare(pin, theirs))) {
      console.error(`Not changed: ${other.name} already has that PIN, so it could not tell the two of you apart. Pick another.`);
      process.exitCode = 1;
      return;
    }
  }

  if (DRY_RUN) {
    console.log(`Would set ${rep.name}'s delivery PIN (role ${rep.role}). No other delivery-site account has it. Their ordinary PIN is untouched.`);
    return;
  }

  await db.rep.update({ where: { id: rep.id }, data: { deliveryPinHash: await bcrypt.hash(pin, 10) } });
  console.log(`Set ${rep.name}'s delivery PIN (role ${rep.role}). Their ordinary PIN is untouched.`);
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
