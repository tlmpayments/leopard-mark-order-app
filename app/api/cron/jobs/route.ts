import { NextResponse } from "next/server";
import { drainJobs, enqueuePeriodicJobs } from "@/lib/jobs/runner";

/**
 * The job runner's cron entry point (§2 rule 5).
 *
 * Runs ONCE DAILY, not every minute: Vercel Hobby rejects a `* * * * *`
 * schedule at deploy time ("Hobby accounts are limited to daily cron jobs").
 * §2 rule 5 says to state the reason when a limit forces a change, so: this is
 * that reason, and the response is to make `after()` the primary drain
 * (lib/jobs/kick.ts) with this cron as the safety net rather than adding
 * Inngest/Trigger.dev for a few hundred jobs a day.
 *
 * It enqueues the day's wall-clock jobs with their proper runAfter times, then
 * drains whatever is due. On Pro, restore `* * * * *` in vercel.json and
 * nothing else needs to change -- enqueuePeriodicJobs is idempotent per day.
 *
 * Auth: Vercel signs cron requests with CRON_SECRET as a bearer token. The
 * check is not optional decoration — without it this URL is an unauthenticated
 * way for anyone to make the system send invoices.
 */
export async function GET(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization");

  if (expected) {
    if (provided !== `Bearer ${expected}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    // Fail closed in production. An unset secret in prod is a misconfiguration,
    // and treating it as "no auth needed" is how a queue runner becomes an open
    // endpoint.
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }

  const enqueued = await enqueuePeriodicJobs();
  const drained = await drainJobs(20);

  return NextResponse.json({ ok: true, enqueued, ...drained });
}
