/**
 * Add (or promote) a delivery driver.
 *
 *   npx tsx scripts/add-driver.ts "Marco Reyes" [--phone "+14155550123"] [--dry-run]
 *
 * A driver is just a Rep row with the `driver` role. No PIN is set here on
 * purpose: `verifyRepPin` sets the PIN from the first successful sign-in while
 * `pinHash` is null, exactly as it does for reps, so the driver chooses their
 * own four digits at delivery.tlmbg.co and nobody else ever knows it.
 *
 * Re-running against an existing name promotes that person to `driver` rather
 * than failing -- which is what you want when the warehouse hand who has been
 * covering deliveries starts doing it full time.
 */

import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "dotenv";

// tsx does not read .env.local the way the Prisma CLI does, so without this
// every write would go to localhost.
config({ path: ".env.local", quiet: true });

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const phoneIndex = args.indexOf("--phone");
const phone = phoneIndex >= 0 ? args[phoneIndex + 1] : null;
// -1 rather than phoneIndex + 1 when there is no --phone flag: index 0 is the
// name, and skipping it would silently read the wrong argument.
const phoneValueIndex = phoneIndex >= 0 ? phoneIndex + 1 : -1;
const name = args.find((a, i) => !a.startsWith("--") && i !== phoneValueIndex)?.trim();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main(): Promise<void> {
  if (!name) {
    console.error('Usage: npx tsx scripts/add-driver.ts "Full Name" [--phone "+1..."] [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const existing = await db.rep.findUnique({ where: { name } });

  if (existing) {
    console.log(`${name} already exists as ${existing.role}${existing.active ? "" : " (inactive)"}.`);
    if (existing.role === "driver" && existing.active && (!phone || existing.phone === phone)) {
      console.log("Nothing to change.");
      return;
    }
    if (!DRY_RUN) {
      await db.rep.update({
        where: { id: existing.id },
        data: { role: "driver", active: true, ...(phone ? { phone } : {}) },
      });
    }
    console.log(`→ ${DRY_RUN ? "would set" : "set"} role=driver, active=true${phone ? `, phone=${phone}` : ""}`);
  } else {
    if (!DRY_RUN) {
      await db.rep.create({ data: { name, role: "driver", active: true, phone: phone ?? null } });
    }
    console.log(`→ ${DRY_RUN ? "would create" : "created"} driver "${name}"${phone ? ` (${phone})` : ""}`);
  }

  console.log("");
  console.log(`${name} signs in at delivery.tlmbg.co with that exact name.`);
  console.log(
    existing?.pinHash
      ? "They already have a PIN — the one they use today."
      : "The first PIN they type becomes their PIN. Tell them to pick four digits and not share them.",
  );
  console.log(DRY_RUN ? "\nDRY RUN — nothing written." : "");
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
