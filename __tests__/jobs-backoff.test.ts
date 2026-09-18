/** The retry ladder from §6.5. Pure — no database. */
import { describe, expect, it } from "vitest";
import { BACKOFF_MINUTES, backoffMs, nextRunAfter } from "@/lib/jobs/backoff";
import { JOB_KINDS, JOB_KIND_LABELS, idempotencyKey } from "@/lib/jobs/kinds";

describe("backoff", () => {
  it("is the schedule §6.5 specifies: 1m, 5m, 30m, 2h, 12h", () => {
    expect(BACKOFF_MINUTES).toEqual([1, 5, 30, 120, 720]);
  });

  it("maps attempt n to the nth interval", () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(5 * 60_000);
    expect(backoffMs(3)).toBe(30 * 60_000);
    expect(backoffMs(4)).toBe(120 * 60_000);
    expect(backoffMs(5)).toBe(720 * 60_000);
  });

  it("clamps rather than returning NaN or zero at the edges", () => {
    expect(backoffMs(0)).toBe(60_000);
    expect(backoffMs(-3)).toBe(60_000);
    expect(backoffMs(99)).toBe(720 * 60_000);
  });

  it("increases monotonically, so a failing job backs off rather than hot-looping", () => {
    const delays = [1, 2, 3, 4, 5].map(backoffMs);
    for (let i = 1; i < delays.length; i += 1) expect(delays[i]).toBeGreaterThan(delays[i - 1]);
  });

  it("schedules from the given clock", () => {
    const now = new Date("2026-09-02T10:00:00Z");
    expect(nextRunAfter(2, now).toISOString()).toBe("2026-09-02T10:05:00.000Z");
  });
});

describe("idempotency keys", () => {
  it("are stable for the same kind and subject, so a double-click bills once", () => {
    expect(idempotencyKey("issue_invoice", "01J6Z")).toBe("issue_invoice:01J6Z");
    expect(idempotencyKey("issue_invoice", "01J6Z")).toBe(idempotencyKey("issue_invoice", "01J6Z"));
  });

  it("separate different subjects", () => {
    expect(idempotencyKey("issue_invoice", "a")).not.toBe(idempotencyKey("issue_invoice", "b"));
  });

  it("gives every job kind a human-readable name for the hub", () => {
    for (const kind of JOB_KINDS) {
      expect(JOB_KIND_LABELS[kind]).toBeTruthy();
      expect(JOB_KIND_LABELS[kind]).not.toContain("_");
    }
  });
});
