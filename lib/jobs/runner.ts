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
 * Enqueue the periodic jobs whose schedule is a wall-clock time rather than a
 * reaction to an event. Idempotent per day/hour via the idempotency key, so
 * calling this every minute produces one run per window.
 */
export async function enqueuePeriodicJobs(now: Date = new Date()): Promise<string[]> {
  const { enqueue } = await import("./queue");
  const enqueued: string[] = [];

  const pt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => pt.find((p) => p.type === t)?.value ?? "";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  const hour = Number.parseInt(get("hour"), 10);

  // 16:00 PT — tomorrow's deliveries, in time to act on it before people leave.
  if (hour === 16) {
    const { created } = await enqueue("delivery_digest", day, { day });
    if (created) enqueued.push("delivery_digest");
  }
  // 02:00 PT — the nightly reconcile, when nobody is editing the Sheet.
  if (hour === 2) {
    const { created } = await enqueue("sheet_reconcile", day, { day });
    if (created) enqueued.push("sheet_reconcile");
  }
  // 09:00 PT — the overdue summary, at the start of the working day.
  if (hour === 9) {
    const { created } = await enqueue("invoice_reminder", day, { day });
    if (created) enqueued.push("invoice_reminder");
  }
  // Monday 09:00 PT — keg custody.
  if (hour === 9 && new Date(now).getUTCDay() === 1) {
    const { created } = await enqueue("keg_custody_nudge", day, { day });
    if (created) enqueued.push("keg_custody_nudge");
  }

  return enqueued;
}

/** Queue depth for the hub's health chip. */
export async function queueSnapshot(): Promise<Record<string, number>> {
  const rows = await db.jobRun.groupBy({ by: ["status"], _count: { _all: true } });
  return Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
}
