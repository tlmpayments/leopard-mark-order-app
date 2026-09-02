import { NextResponse } from "next/server";
import { drainJobs, enqueuePeriodicJobs } from "@/lib/jobs/runner";

/**
 * The job runner's cron entry point (§2 rule 5).
 *
 * Vercel Cron calls this every minute. It first enqueues any wall-clock jobs
 * whose window has arrived, then drains what is due.
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
