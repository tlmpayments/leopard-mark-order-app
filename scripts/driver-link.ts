/**
 * Issue, list and revoke a driver's personal sign-in link.
 *
 *   npx tsx scripts/driver-link.ts new    "Jose Arreola" [--label "iPhone"] [--base https://delivery.tlmbg.co]
 *   npx tsx scripts/driver-link.ts list   "Jose Arreola"
 *   npx tsx scripts/driver-link.ts revoke <tokenId>
 *   npx tsx scripts/driver-link.ts revoke-all "Jose Arreola"
 *
 * The link is printed ONCE, on issue. Only its hash is stored, so it cannot be
 * recovered afterwards -- if it is lost, issue a new one and revoke the old.
 *
 * Treat the printed URL like a password: anyone holding it is that driver until
 * it is revoked. Send it to him directly, not into a group chat.
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): string | null {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] ?? null : null;
}
const positional = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));

async function main(): Promise<void> {
  const { db } = await import("../lib/db");
  const { mintDriverLink, linksForDriver, revokeDriverLink, revokeAllForDriver } = await import(
    "../lib/driverLink"
  );

  const findDriver = async (name: string) => {
    const rep = await db.rep.findFirst({ where: { name } });
    if (!rep) throw new Error(`No rep named "${name}".`);
    return rep;
  };

  if (cmd === "new") {
    const rep = await findDriver(positional[0] ?? "");
    const link = await mintDriverLink(rep.id, {
      label: flag("label"),
      baseUrl: flag("base") ?? undefined,
    });
    console.log(`\nLink for ${rep.name}${link.id ? "" : ""}:\n`);
    console.log(`  ${link.url}\n`);
    console.log("Shown once — it is not recoverable. Send it to him directly.");
    console.log("Tell him to open it and add the page to his home screen; every");
    console.log("cold open re-signs him in, so he never sees a login again.");
    console.log(`\nRevoke with:  npx tsx scripts/driver-link.ts revoke ${link.id}`);
  } else if (cmd === "list") {
    const rep = await findDriver(positional[0] ?? "");
    const links = await linksForDriver(rep.id);
    if (links.length === 0) console.log(`${rep.name} has no links.`);
    for (const l of links) {
      const state = l.revokedAt ? `revoked ${l.revokedAt.toISOString().slice(0, 10)}` : "active";
      const used = l.lastUsedAt ? `last used ${l.lastUsedAt.toISOString().slice(0, 16).replace("T", " ")}` : "never used";
      console.log(`  ${l.id}  ${state.padEnd(22)} ${used.padEnd(28)} ${l.label ?? ""}`);
    }
  } else if (cmd === "revoke") {
    await revokeDriverLink(positional[0] ?? "");
    console.log("Revoked. That link no longer signs anyone in.");
  } else if (cmd === "revoke-all") {
    const rep = await findDriver(positional[0] ?? "");
    const n = await revokeAllForDriver(rep.id);
    console.log(`Revoked ${n} live link${n === 1 ? "" : "s"} for ${rep.name}.`);
  } else {
    console.error('Usage: new "Name" | list "Name" | revoke <id> | revoke-all "Name"');
    process.exitCode = 1;
    return;
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
