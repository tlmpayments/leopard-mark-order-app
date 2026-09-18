/**
 * Mirror CLI.
 *
 *   npx tsx scripts/notion-sync.ts --full            rebuild everything
 *   npx tsx scripts/notion-sync.ts --since 2h        only rows changed recently
 *   npx tsx scripts/notion-sync.ts --only accounts,orders
 *   npx tsx scripts/notion-sync.ts --dry-run         extract only, write nothing
 *
 * --dry-run is the one to reach for first: it exercises every Postgres query
 * and prints row counts without needing a Notion token, which is how you check
 * the read side is sound before anything leaves the building.
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import { runSync } from "../lib/notion/run";
import * as extract from "../lib/notion/extract";
import { loadProspects } from "../lib/notion/sync";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

/** "2h" / "30m" / "7d" / an ISO date. */
function parseSince(raw: string | undefined): Date | null {
  if (!raw) return null;
  const rel = /^(\d+)([mhd])$/.exec(raw.trim());
  if (rel) {
    const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "m" | "h" | "d"];
    return new Date(Date.now() - Number(rel[1]) * ms);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`Could not parse --since "${raw}"`);
  return d;
}

async function dryRun(since: Date | null): Promise<void> {
  console.log(`Dry run — reading Postgres, writing nothing.${since ? ` since ${since.toISOString()}` : ""}\n`);
  const counts: Array<[string, number]> = [
    ["accounts", (await extract.accounts({ since })).length],
    ["contacts", (await extract.contacts()).length],
    ["products", (await extract.products()).length],
    ["orders", (await extract.orders({ since })).length],
    ["orderLines", (await extract.orderLines()).length],
    ["invoices", (await extract.invoices({ since })).length],
    ["routes", (await extract.routes({ since })).length],
    ["stops", (await extract.routeStops()).length],
    ["documents", (await extract.documents()).length],
    ["inventory", (await extract.inventory()).length],
    ["jobs", (await extract.jobRuns()).length],
    ["prospects", (await loadProspects()).length],
    ["prospectVisits", (await extract.prospectVisits()).length],
  ];
  let total = 0;
  for (const [name, n] of counts) {
    total += n;
    console.log(`  ${String(n).padStart(6)}  ${name}`);
  }
  console.log(`\n  ${String(total).padStart(6)}  rows total → ~${Math.ceil(total / 3 / 60)} min at Notion's 3 req/s`);
}

async function main(): Promise<void> {
  const since = flag("full") ? null : parseSince(arg("since"));
  const only = arg("only")?.split(",").map((s) => s.trim()).filter(Boolean);

  if (flag("dry-run")) {
    await dryRun(since);
    return;
  }

  const result = await runSync({ since, only });
  let created = 0, updated = 0, errors = 0;
  for (const r of result.reports) {
    created += r.created; updated += r.updated; errors += r.errors.length;
    console.log(
      `  ${r.database.padEnd(12)} +${String(r.created).padStart(4)} ~${String(r.updated).padStart(4)}` +
        (r.skipped ? ` skip ${r.skipped}` : "") +
        (r.errors.length ? `  ERRORS ${r.errors.length}` : ""),
    );
    for (const e of r.errors.slice(0, 5)) console.log(`      ${e.externalId}: ${e.message}`);
  }
  console.log(`\n${created} created, ${updated} updated, ${errors} errors in ${(result.durationMs / 1000).toFixed(1)}s`);
  if (errors) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`\n${(error as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => extract.closePool());
