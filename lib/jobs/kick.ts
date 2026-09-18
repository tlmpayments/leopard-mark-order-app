import { after } from "next/server";

/**
 * Drain the queue immediately after the current response, without making the
 * user wait for it.
 *
 * This is the "on-demand after()/waitUntil for immediate follow-ups" half of
 * §2 rule 5, and on this account it is now the PRIMARY drain rather than a
 * nicety. Vercel Hobby limits cron to once per day, so a minute-by-minute
 * runner is not available: `vercel --prod` rejects the deployment outright with
 * "Hobby accounts are limited to daily cron jobs".
 *
 * That matters most for the headline behaviour — an invoice going out when the
 * warehouse marks a delivery. Waiting for a daily cron would make that useless.
 * So every action that enqueues work also kicks the drain, and the invoice is
 * sent seconds after the delivery is marked, in the same request's `after`
 * callback.
 *
 * What the daily cron still covers: the wall-clock jobs (digest, reconcile,
 * overdue summary) and sweeping up retries whose backoff elapsed while nobody
 * was using the hub. A job that fails at 09:00 and is due to retry at 09:05
 * therefore waits for either the next kick (any ops action) or the next daily
 * run. Upgrading to Pro and restoring `* * * * *` in vercel.json removes that
 * gap; nothing else needs to change.
 */
export function kickJobs(limit = 5): void {
  after(async () => {
    try {
      // Imported inside the callback so the handler module -- which reaches
      // Stripe, Slack and the Sheet -- is never pulled into a page's import
      // graph just because the page can enqueue work.
      const { drainJobs } = await import("./runner");
      await drainJobs(limit);
    } catch (err) {
      // A failed drain must never surface as a failed user action: the work is
      // already durably queued, and the next kick or the daily cron picks it up.
      console.error("[jobs] post-response drain failed:", err);
    }
  });
}
