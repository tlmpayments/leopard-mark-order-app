/**
 * The job queue (§2 rule 5): a Postgres table drained by Vercel Cron every
 * minute, plus an `after()` nudge for immediate follow-ups.
 *
 * Deliberately not Inngest/Trigger.dev. The volume is a few hundred jobs a day,
 * and the hub has to render the run log either way (§8.9 wants last-20-runs, a
 * 7-day sparkline and a dead-letter queue per rule). Once the run history must
 * live in our own database to be queryable, a hosted queue would mean keeping
 * two copies of the same truth -- which §13 forbids. So the queue is the table.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, which is what makes it safe for two
 * cron invocations (or a cron and an after() nudge) to drain concurrently
 * without running the same job twice.
 */

import { Prisma } from "@/app/generated/prisma/client";
import { db } from "@/lib/db";
import type { JobStatus } from "@/app/generated/prisma/enums";
import { idempotencyKey, type JobKind } from "./kinds";
import { nextRunAfter } from "./backoff";

export interface EnqueueOptions {
  /** Delay the first attempt. Defaults to now (drained within the minute). */
  runAfter?: Date;
  maxAttempts?: number;
  orderId?: string | null;
  accountId?: string | null;
}

export interface EnqueueResult {
  id: string;
  /** False when an identical job already existed -- the dedupe fired. */
  created: boolean;
}

/**
 * Enqueue a job, deduped on its idempotency key.
 *
 * The dedupe is the whole point: `issue_invoice:<orderId>` enqueued three times
 * (delivery handler, a manual click, the retry sweep) must bill once. An
 * existing row is left exactly as it is -- including a `dead` one, because
 * silently reviving a job a human has not looked at would defeat the
 * dead-letter queue. Use `retryJob` for that, which logs who did it.
 */
export async function enqueue(
  kind: JobKind,
  subject: string,
  payload: Prisma.InputJsonValue,
  opts: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const key = idempotencyKey(kind, subject);
  const existing = await db.jobRun.findUnique({ where: { idempotencyKey: key }, select: { id: true } });
  if (existing) return { id: existing.id, created: false };

  try {
    const row = await db.jobRun.create({
      data: {
        kind,
        idempotencyKey: key,
        status: "queued",
        payloadJson: payload,
        runAfter: opts.runAfter ?? new Date(),
        maxAttempts: opts.maxAttempts ?? 5,
        orderId: opts.orderId ?? null,
        accountId: opts.accountId ?? null,
      },
      select: { id: true },
    });
    return { id: row.id, created: true };
  } catch (err) {
    // Lost the race against a concurrent enqueue of the same key. The unique
    // index did its job; report the winner rather than throwing.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const row = await db.jobRun.findUnique({
        where: { idempotencyKey: key },
        select: { id: true },
      });
      if (row) return { id: row.id, created: false };
    }
    throw err;
  }
}

export interface ClaimedJob {
  id: string;
  kind: string;
  payloadJson: unknown;
  attempts: number;
  maxAttempts: number;
  orderId: string | null;
  accountId: string | null;
}

/**
 * Atomically claim up to `limit` due jobs, marking them `running`.
 *
 * `SKIP LOCKED` means a second concurrent drainer takes the *next* rows rather
 * than blocking on these, so overlapping cron ticks make progress instead of
 * queueing behind each other.
 */
export async function claimDueJobs(limit = 10, now: Date = new Date()): Promise<ClaimedJob[]> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "job_runs"
      WHERE "status" IN ('queued', 'failed') AND "run_after" <= ${now}
      ORDER BY "run_after" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    await tx.jobRun.updateMany({
      where: { id: { in: ids } },
      data: { status: "running", startedAt: now, attempts: { increment: 1 } },
    });

    return tx.jobRun.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        kind: true,
        payloadJson: true,
        attempts: true,
        maxAttempts: true,
        orderId: true,
        accountId: true,
      },
      orderBy: { runAfter: "asc" },
    });
  });
}

export async function markSucceeded(id: string, startedAt?: Date | null): Promise<void> {
  const finishedAt = new Date();
  await db.jobRun.update({
    where: { id },
    data: {
      status: "succeeded",
      finishedAt,
      lastError: null,
      durationMs: startedAt ? finishedAt.getTime() - startedAt.getTime() : null,
    },
  });
}

/**
 * Record a failure and decide whether to retry or give up.
 *
 * Returns the status it settled on so the caller can raise the Slack
 * `:warning:` after the third failure (§6.5) without re-reading the row.
 */
export async function markFailed(
  job: Pick<ClaimedJob, "id" | "attempts" | "maxAttempts">,
  error: unknown,
  startedAt?: Date | null,
): Promise<JobStatus> {
  const finishedAt = new Date();
  const dead = job.attempts >= job.maxAttempts;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  await db.jobRun.update({
    where: { id: job.id },
    data: {
      status: dead ? "dead" : "failed",
      // A dead job keeps its runAfter so the hub can show when it gave up; a
      // failed one is pushed out by the backoff table.
      runAfter: dead ? undefined : nextRunAfter(job.attempts, finishedAt),
      lastError: message.slice(0, 2000),
      finishedAt,
      durationMs: startedAt ? finishedAt.getTime() - startedAt.getTime() : null,
    },
  });
  return dead ? "dead" : "failed";
}

/**
 * Re-queue a job from the hub's dead-letter queue. This is the only path that
 * revives a `dead` job, and it resets the attempt counter so the full backoff
 * ladder is available again -- a human has looked at it and believes the cause
 * is fixed.
 */
export async function retryJob(id: string, byUserId?: string): Promise<void> {
  await db.jobRun.update({
    where: { id },
    data: {
      status: "queued",
      attempts: 0,
      runAfter: new Date(),
      lastError: null,
      startedAt: null,
      finishedAt: null,
      payloadJson: undefined,
    },
  });
  if (byUserId) {
    // Intentionally not an OrderEvent: a re-queue is an operator action on the
    // queue, not a fact about the order. It shows in the job's own history.
    await db.jobRun.update({ where: { id }, data: { lastError: `re-queued by ${byUserId}` } });
  }
}

/** Discard a dead job without running it -- ops has handled it by hand. */
export async function discardJob(id: string): Promise<void> {
  await db.jobRun.update({
    where: { id },
    data: { status: "succeeded", finishedAt: new Date(), lastError: "discarded by ops" },
  });
}
