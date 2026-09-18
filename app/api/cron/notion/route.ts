import { NextResponse } from "next/server";
import { runSync } from "@/lib/notion/run";
import { closePool } from "@/lib/notion/extract";

/**
 * Refreshes the Notion mirror.
 *
 * Read-only with respect to Postgres (lib/notion/extract.ts enforces that both
 * by credential and by READ ONLY transaction), so unlike /api/cron/jobs this
 * endpoint cannot change business state. The auth check is still here because
 * an open endpoint that burns the Notion rate limit is a denial-of-service on
 * the dashboard, and because the response body describes production data.
 *
 * Defaults to a 25-hour window rather than the cron's 24-hour period: a run
 * that is late, retried, or lands either side of a DST shift must not leave a
 * gap, and re-mirroring an extra hour of rows is free at these volumes.
 *
 * `?full=1` forces a whole-table rebuild. Use it after changing a mapper in
 * lib/notion/sync.ts, since incremental runs only touch rows whose updated_at
 * has moved and old pages would otherwise keep the old shape.
 */
export const maxDuration = 300;

export async function GET(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization");

  if (expected) {
    if (provided !== `Bearer ${expected}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }

  const url = new URL(request.url);
  const full = url.searchParams.get("full") === "1";
  const since = full ? null : new Date(Date.now() - 25 * 60 * 60 * 1000);

  try {
    const result = await runSync({ since });
    const totals = result.reports.reduce(
      (acc, r) => ({
        created: acc.created + r.created,
        updated: acc.updated + r.updated,
        errors: acc.errors + r.errors.length,
      }),
      { created: 0, updated: 0, errors: 0 },
    );
    return NextResponse.json({ ok: totals.errors === 0, full, ...totals, durationMs: result.durationMs, reports: result.reports });
  } catch (error) {
    // A mirror failure is not an ops failure. Report it loudly, change nothing.
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 500 });
  } finally {
    await closePool();
  }
}
