/**
 * Retry schedule for failed jobs (§6.5): 1m, 5m, 30m, 2h, 12h.
 *
 * Pure and separate from the runner so the schedule can be asserted directly
 * without a database -- getting this wrong is the difference between a
 * transient Stripe blip healing itself and a hot loop hammering the API.
 */
export const BACKOFF_MINUTES = [1, 5, 30, 120, 720] as const;

/**
 * Delay before attempt number `attempts + 1`, where `attempts` is how many
 * have already failed. Past the end of the table the last interval repeats,
 * which only matters if maxAttempts is raised above the table length.
 */
export function backoffMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[i] * 60_000;
}

export function nextRunAfter(attempts: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + backoffMs(attempts));
}
