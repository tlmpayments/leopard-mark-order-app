/**
 * Copy the visits already in the database onto the Routes tab.
 *
 *   npx tsx scripts/backfill-routes-tab.ts            # PREVIEW: writes nothing
 *   npx tsx scripts/backfill-routes-tab.ts --apply    # writes
 *
 * Needs APPS_SCRIPT_URL and PROSPECTS_SHEET_SECRET in the environment (and the
 * database, from .env.local). Only visits made before the sheet connection was
 * switched on need this: from then on every visit mirrors itself.
 *
 * What lands where, per door:
 *  - every entry in its visit trail, oldest first, as a line in Visit Log (so
 *    the newest ends on top), formatted exactly as the live mirror formats it
 *    -- which is what makes a re-run, or the live mirror writing the same visit
 *    later, a no-op instead of a duplicate line;
 *  - its current status, who, when, count, notes and survey answers in the grey
 *    columns.
 * It writes grey (app-owned) columns only: the sheet's own Stop and Route are
 * refused by lib/prospects/sheet.ts's writeRow, so this cannot touch an order.
 */
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "dotenv";
import { configured, visitPayload, writeRow } from "../lib/prospects/sheet";

config({ path: ".env.local", quiet: true });
const APPLY = process.argv.includes("--apply");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main(): Promise<void> {
  console.log(APPLY ? "APPLY: writing to the Routes tab\n" : "PREVIEW: nothing will be written\n");
  if (!configured()) throw new Error("Set APPS_SCRIPT_URL and PROSPECTS_SHEET_SECRET first.");

  const visits = await db.prospectVisit.findMany({ orderBy: { prospectId: "asc" } });
  const events = await db.prospectVisitEvent.findMany({ orderBy: [{ prospectId: "asc" }, { markedAt: "asc" }] });
  const eventsBy = new Map<number, typeof events>();
  for (const e of events) (eventsBy.get(e.prospectId) ?? eventsBy.set(e.prospectId, []).get(e.prospectId)!).push(e);
  const visitBy = new Map(visits.map((v) => [v.prospectId, v]));
  const ids = [...new Set([...visits.map((v) => v.prospectId), ...events.map((e) => e.prospectId)])].sort((a, b) => a - b);

  let logLines = 0, valueWrites = 0, notes = 0;
  for (const id of ids) {
    const trail = eventsBy.get(id) ?? [];
    const visit = visitBy.get(id);
    const count = trail.filter((e) => e.status !== "new").length || (visit ? 1 : 0);

    // History first, oldest to newest.
    const lines = trail.map((e) =>
      visitPayload({ prospectId: id, status: e.status, note: e.note, survey: (e.survey as Record<string, unknown> | null) ?? null, repName: e.repName, markedAt: e.markedAt, visitCount: count }).logLine,
    );
    // A visit that predates the trail has no events: log it from the visit itself.
    if (visit && trail.length === 0) {
      lines.push(visitPayload({ prospectId: id, status: visit.status, note: visit.note, survey: (visit.survey as Record<string, unknown> | null) ?? null, repName: visit.repName, markedAt: visit.markedAt, visitCount: count }).logLine);
    }
    if (visit?.note) notes++;

    if (!APPLY) { logLines += lines.length; valueWrites += visit ? 1 : 0; continue; }

    for (const line of lines) {
      await writeRow(id, {}, line);
      logLines++;
    }
    if (visit) {
      const { values } = visitPayload({ prospectId: id, status: visit.status, note: visit.note, survey: (visit.survey as Record<string, unknown> | null) ?? null, repName: visit.repName, markedAt: visit.markedAt, visitCount: count });
      await writeRow(id, values);
      valueWrites++;
    }
    process.stdout.write(`  door ${id}: ${lines.length} log line(s)${visit ? " + current state" : ""}\n`);
  }

  console.log(`\n${APPLY ? "Wrote" : "Would write"}: ${valueWrites} doors' current state (${notes} with notes), ${logLines} visit-log lines, across ${ids.length} doors.`);
  if (!APPLY) console.log("Preview only. Re-run with --apply to write.");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); await pool.end(); });
