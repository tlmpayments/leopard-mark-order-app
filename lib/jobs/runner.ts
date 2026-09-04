/**
 * The drain loop.
 *
 * Called every minute by Vercel Cron and opportunistically by `after()` when
 * something has just been enqueued and there is no reason to wait a minute for
 * it. Both paths are safe to overlap: `claimDueJobs` uses FOR UPDATE SKIP
 * LOCKED, so a second drainer takes different rows rather than the same ones.
 */

import { db } from "@/lib/db";
import { claimDueJobs, markFailed, markSucceeded } from "./queue";
import { HANDLERS } from "./handlers";
import type { JobKind } from "./kinds";
import { channelForRegion, postMessage } from "@/lib/slack";

export interface DrainResult {
  claimed: number;
  succeeded: number;
  failed: number;
  dead: number;
  details: Array<{ kind: string; id: string; outcome: string }>;
}

/**
 * Drain up to `limit` due jobs.
 *
 * One job's failure never stops the batch: each is caught individually, because
 * a Stripe outage must not stop the Slack notifications from going out.
 */
export async function drainJobs(limit = 10): Promise<DrainResult> {
  const jobs = await claimDueJobs(limit);
  const result: DrainResult = { claimed: jobs.length, succeeded: 0, failed: 0, dead: 0, details: [] };

  for (const job of jobs) {
    const startedAt = new Date();
    const handler = HANDLERS[job.kind as JobKind];

    if (!handler) {
      // An unknown kind is a deploy/queue mismatch: a job enqueued by a newer
      // version than the one draining it. Fail it rather than dropping it, so
      // it retries after the next deploy instead of vanishing.
      await markFailed(job, new Error(`No handler registered for kind "${job.kind}"`), startedAt);
      result.failed += 1;
      result.details.push({ kind: job.kind, id: job.id, outcome: "no handler" });
      continue;
    }

    try {
      const outcome = await handler((job.payloadJson ?? {}) as Record<string, unknown>, {
        jobId: job.id,
        attempts: job.attempts,
      });
      await markSucceeded(job.id, startedAt);
      result.succeeded += 1;
      result.details.push({ kind: job.kind, id: job.id, outcome });
    } catch (err) {
      const status = await markFailed(job, err, startedAt);
      if (status === "dead") result.dead += 1;
      else result.failed += 1;
      result.details.push({
        kind: job.kind,
        id: job.id,
        outcome: `${status}: ${err instanceof Error ? err.message : String(err)}`,
      });

      // §6.5: Slack a warning after the third failure. Earlier than that is
      // noise -- the backoff ladder heals most transient failures by itself --
      // and later than that is a problem nobody heard about.
      if (job.attempts === 3 || status === "dead") {
        await notifyFailure(job.kind, job.id, err, status);
      }
    }
  }

  return result;
}

/** Slack the on-call channel about a job that is not healing itself. */
async function notifyFailure(kind: string, ref: string, err: unknown, status: string): Promise<void> {
  try {
    const channel = await channelForRegion(null, "billing");
    if (!channel) return;
    const message = err instanceof Error ? err.message : String(err);
    await postMessage(
      channel,
      `:warning: *${kind}* ${status === "dead" ? "gave up" : "is failing"} — \`${ref}\`\n> ${message.slice(0, 400)}`,
    );
  } catch {
    // A failure to report a failure must never itself fail the drain.
  }
}

/**
 * Enqueue the day's wall-clock jobs.
 *
 * Written for a ONCE-DAILY cron, because that is all Vercel Hobby allows -- a
 * `* * * * *` schedule is rejected at deploy time. So this cannot gate on "is
 * it 16:00 right now"; instead it queues each of the day's jobs once, with
 * `runAfter` set to the time it should actually run. Whatever is already due
 * gets drained by this same invocation, and the rest is picked up by the next
 * kick from an ops action (lib/jobs/kick.ts) or tomorrow's cron.
 *
 * Idempotent per calendar day via the idempotency key, so calling it more often
 * -- which is exactly what happens after an upgrade to Pro -- still produces
 * one run per job per day.
 */
export async function enqueuePeriodicJobs(now: Date = new Date()): Promise<string[]> {
  const { enqueue } = await import("./queue");
  const enqueued: string[] = [];

  const day = pacificDay(now);

  // [kind, local PT hour it should run at]
  const schedule: Array<[Parameters<typeof enqueue>[0], number]> = [
    // 02:00 -- the nightly reconcile, when nobody is editing the Sheet.
    ["sheet_reconcile", 2],
    // 09:00 -- the overdue summary, at the start of the working day.
    ["invoice_reminder", 9],
    // 16:00 -- tomorrow's deliveries, in time to act before people leave.
    ["delivery_digest", 16],
  ];

  for (const [kind, hour] of schedule) {
    const { created } = await enqueue(kind, day, { day }, { runAfter: atPacificHour(day, hour) });
    if (created) enqueued.push(kind);
  }

  // Weekly, on Mondays.
  if (pacificWeekday(now) === 1) {
    const { created } = await enqueue("keg_custody_nudge", day, { day }, {
      runAfter: atPacificHour(day, 9),
    });
    if (created) enqueued.push("keg_custody_nudge");
  }

  return enqueued;
}

/** "YYYY-MM-DD" in Pacific time -- the business's own calendar day. */
function pacificDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function pacificWeekday(at: Date): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
  }).format(at);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[name] ?? 0;
}

/**
 * A given local hour on a given Pacific calendar day, as a real instant.
 * Resolves the UTC offset for that day rather than assuming -08:00, so the
 * schedule does not slip by an hour across the DST boundaries in March and
 * November.
 */
function atPacificHour(day: string, hour: number): Date {
  const naive = new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "shortOffset",
  })
    .formatToParts(naive)
    .find((part) => part.type === "timeZoneName")?.value;
  const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(label ?? "");
  const offsetHours = m ? Number.parseInt(m[1], 10) : -8;
  const offsetMinutes = m?.[2] ? Number.parseInt(m[2], 10) : 0;
  return new Date(naive.getTime() - (offsetHours * 60 + Math.sign(offsetHours) * offsetMinutes) * 60_000);
}

/** Queue depth for the hub's health chip. */
export async function queueSnapshot(): Promise<Record<string, number>> {
  const rows = await db.jobRun.groupBy({ by: ["status"], _count: { _all: true } });
  return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
}
