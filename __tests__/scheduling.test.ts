/**
 * Route-day arithmetic (§3 ③/④). Pure — no database.
 *
 * Calendar maths against a cutoff on the PRIOR day is easy to get subtly wrong
 * and hard to notice in production: an off-by-one books a truck for the wrong
 * week and nobody finds out until the dock is empty.
 */
import { describe, expect, it } from "vitest";
import { nextRouteDay, pacificParts, type RouteDay } from "@/lib/scheduling";

// The answers to §12 Q1 as the mockup records them: BA delivers Tue + Thu out
// of WH-SF and WH-BEN, LA delivers Wed + Fri out of WH-WIL, both with a 14:00
// prior-day cutoff.
const BA: RouteDay[] = [
  { region: "BA", warehouseId: "WH-SF", weekday: 2, cutoffHour: 14 },
  { region: "BA", warehouseId: "WH-BEN", weekday: 4, cutoffHour: 14 },
];
const LA: RouteDay[] = [
  { region: "LA", warehouseId: "WH-WIL", weekday: 3, cutoffHour: 14 },
  { region: "LA", warehouseId: "WH-WIL", weekday: 5, cutoffHour: 14 },
];

/** An instant at a given Pacific wall-clock time. 2026-09-02 is a Wednesday. */
const pt = (isoDay: string, hour: number) => new Date(`${isoDay}T${String(hour + 7).padStart(2, "0")}:00:00Z`);

describe("pacificParts", () => {
  it("reads the Pacific weekday and hour, not UTC's", () => {
    // 2026-09-03T02:00Z is still Wednesday 19:00 in Pacific time.
    const p = pacificParts(new Date("2026-09-03T02:00:00Z"));
    expect(p.weekday).toBe(3);
    expect(p.hour).toBe(19);
  });
});

describe("nextRouteDay", () => {
  it("returns null when the region has no routes", () => {
    expect(nextRouteDay([], pt("2026-09-02", 9))).toBeNull();
  });

  it("never proposes same-day delivery", () => {
    // Wednesday 08:00. LA delivers Wednesday, but not today.
    const r = nextRouteDay(LA, pt("2026-09-02", 8));
    expect(r).not.toBeNull();
    expect(pacificParts(r!.at).weekday).toBe(5); // Friday
  });

  it("takes tomorrow's route when the cutoff has not passed", () => {
    // Wednesday 09:00, BA delivers Thursday, cutoff 14:00 Wednesday: made it.
    const r = nextRouteDay(BA, pt("2026-09-02", 9));
    expect(pacificParts(r!.at).weekday).toBe(4);
    expect(r!.route.warehouseId).toBe("WH-BEN");
  });

  it("misses tomorrow's route once the cutoff has passed", () => {
    // Wednesday 15:00 is past the 14:00 cutoff for Thursday, so the next BA
    // route day is the following Tuesday.
    const r = nextRouteDay(BA, pt("2026-09-02", 15));
    expect(pacificParts(r!.at).weekday).toBe(2);
    expect(r!.route.warehouseId).toBe("WH-SF");
  });

  it("treats the cutoff hour itself as missed", () => {
    // Exactly 14:00 is not "before 14:00". Boundary chosen deliberately: the
    // warehouse pick list is built at the cutoff.
    const r = nextRouteDay(BA, pt("2026-09-02", 14));
    expect(pacificParts(r!.at).weekday).toBe(2);
  });

  it("picks the earliest of several route days", () => {
    const both = [...BA, ...LA.map((r) => ({ ...r, region: "BA" }))];
    // Wednesday 09:00 -> Thursday (BA) beats Friday (borrowed LA day).
    const r = nextRouteDay(both, pt("2026-09-02", 9));
    expect(pacificParts(r!.at).weekday).toBe(4);
  });

  it("proposes 09:00 Pacific on the delivery day", () => {
    const r = nextRouteDay(BA, pt("2026-09-02", 9));
    expect(pacificParts(r!.at).hour).toBe(9);
  });

  it("stays correct across the November DST boundary", () => {
    // 2026-11-01 is the PDT -> PST switch. A Monday-route region proposed from
    // the Friday before must still land at 09:00 local, not 08:00 or 10:00.
    const monday: RouteDay[] = [{ region: "X", warehouseId: "WH-SF", weekday: 1, cutoffHour: 14 }];
    const r = nextRouteDay(monday, new Date("2026-10-30T16:00:00Z"));
    expect(r).not.toBeNull();
    const p = pacificParts(r!.at);
    expect(p.weekday).toBe(1);
    expect(p.hour).toBe(9);
  });

  it("looks ahead far enough to find a weekly route", () => {
    const rare: RouteDay[] = [{ region: "NE", warehouseId: "WH-WIN", weekday: 1, cutoffHour: 12 }];
    const r = nextRouteDay(rare, pt("2026-09-02", 9));
    expect(r).not.toBeNull();
    expect(pacificParts(r!.at).weekday).toBe(1);
  });
});
