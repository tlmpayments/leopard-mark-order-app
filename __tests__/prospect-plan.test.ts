import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

// The rep app ships plain browser scripts. prospects.js assigns onto window
// and prospect-plan.js is a CommonJS-compatible IIFE, so both load here the
// way a phone loads them -- against the real 551-door list.
const require = createRequire(import.meta.url);
const g = globalThis as unknown as { window?: Record<string, unknown> };
g.window = g.window ?? {};
require("../public/rep-app/assets/js/prospects.js");
const plan = require("../public/rep-app/assets/js/prospect-plan.js");

type Door = { id: number; route: string; group: string; wave: string; routePriority: number | null };
const doors = (g.window!.LM_PROSPECTS as Door[]);
const days = plan.buildSchedule(doors) as Array<{
  date: string;
  label: string;
  together: number[];
  legs: { james: number[]; zack: number[] };
}>;

describe("prospect schedule", () => {
  it("starts tomorrow and runs on consecutive calendar days, weekends included", () => {
    expect(days[0].date).toBe("2026-09-30");
    days.forEach((d, i) => {
      const expected = plan.parseIso("2026-09-30");
      expected.setDate(expected.getDate() + i);
      expect(d.date).toBe(plan.isoOf(expected));
    });
    expect(days.some((d) => [0, 6].includes(plan.parseIso(d.date).getDay()))).toBe(true);
  });

  it("puts every door of every route and second-pass group on exactly one day", () => {
    const scheduled = days.flatMap((d) => [...d.together, ...d.legs.james, ...d.legs.zack]);
    expect(new Set(scheduled).size).toBe(scheduled.length);
    const expected = doors
      .filter((p) => (p.route || p.group || p.wave.indexOf("Separate track") === 0) && p.wave.indexOf("Excluded") !== 0)
      .map((p) => p.id);
    expect([...scheduled].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
  });

  it("gives the two reps equal solo shares, within one door on a partial day", () => {
    const full = plan.DEFAULTS.together + plan.DEFAULTS.solo * 2;
    for (const d of days) {
      const size = d.together.length + d.legs.james.length + d.legs.zack.length;
      const gap = Math.abs(d.legs.james.length - d.legs.zack.length);
      if (size === full) expect(gap).toBe(0);
      else expect(gap).toBeLessThanOrEqual(1);
    }
  });

  it("keeps the overall load between the two within one door per day", () => {
    const total = (k: "james" | "zack") => days.reduce((n, d) => n + d.legs[k].length, 0);
    expect(Math.abs(total("james") - total("zack"))).toBeLessThanOrEqual(1);
  });

  it("starts each day together and then splits into contiguous stretches", () => {
    // Contiguous in working order, not in id order: the second-pass groups
    // follow the routes in the schedule but carry earlier ids.
    const queue: number[] = plan.doorQueue(doors, plan.DEFAULTS).map((p: Door) => p.id);
    const at = new Map(queue.map((id, i) => [id, i]));
    for (const d of days) {
      expect(d.together.length).toBeGreaterThan(0);
      for (const leg of [d.legs.james, d.legs.zack]) {
        const pos = leg.map((id) => at.get(id)!);
        expect(pos).toEqual([...pos].sort((a, b) => a - b));
        expect(pos[pos.length - 1] - pos[0]).toBe(pos.length - 1);
      }
      const shared = d.together.map((id) => at.get(id)!);
      expect(shared[shared.length - 1] - shared[0]).toBe(shared.length - 1);
    }
  });

  it("gives the Arts District a day of its own, in buyer order", () => {
    const arts = doors.filter((p) => p.wave.indexOf("Separate track") === 0).map((p) => p.id).sort((a, b) => a - b);
    expect(arts.length).toBe(17);
    const day = days.find((d) => d.label === "Arts District")!;
    expect(day).toBeTruthy();
    expect([...day.together, ...day.legs.james, ...day.legs.zack].sort((a, b) => a - b)).toEqual(arts);
    // Founder-level door first, and nothing else shares the day.
    expect(day.together[0]).toBe(arts[0]);
    expect(days.filter((d) => d.label.includes("Arts District")).length).toBe(1);
  });

  it("holds visited doors above unvisited ones within a route, whatever the Stop numbers say", () => {
    const visited = new Set<number>();
    const order = plan.visitedFirst((d: Door) => visited.has(d.id));
    const r2 = doors.filter((d) => d.route === "R2A Maywood + Bell");
    const byStop = [...r2].sort(plan.planOrder);
    // Visit three doors that are deep in the route.
    const deep = byStop.slice(-3).map((d) => d.id);
    deep.forEach((id) => visited.add(id));
    const sorted = [...r2].sort(order);
    expect(sorted.slice(0, 3).map((d) => d.id)).toEqual(deep);                 // on top, in Stop order
    expect(sorted.slice(3).map((d) => d.id)).toEqual(byStop.slice(0, -3).map((d) => d.id)); // the rest keep the plan's order
  });

  it("is stable when nothing is visited, and when everything is", () => {
    const none = plan.visitedFirst(() => false);
    const all = plan.visitedFirst(() => true);
    const sample = doors.filter((d) => d.route === "R5 Downey core");
    expect([...sample].sort(none).map((d) => d.id)).toEqual([...sample].sort(plan.planOrder).map((d) => d.id));
    expect([...sample].sort(all).map((d) => d.id)).toEqual([...sample].sort(plan.planOrder).map((d) => d.id));
  });

  it("never mixes routes: visiting a door in a later route does not lift it into an earlier one", () => {
    const first = doors.filter((d) => d.route === "R1 Huntington Park").sort(plan.planOrder)[0];
    const later = doors.filter((d) => d.route === "R6 Montebello + Pico Rivera Whittier")[0];
    const order = plan.visitedFirst((d: Door) => d.id === later.id);
    expect(order(first, later)).toBeLessThan(0); // R1 still ahead of R6
  });

  it("leaves doors with no route or group (the Arts District) in buyer order", () => {
    const arts = doors.filter((d) => d.wave.indexOf("Separate track") === 0);
    const visitedLast = arts[arts.length - 1].id;
    const order = plan.visitedFirst((d: Door) => d.id === visitedLast);
    expect([...arts].sort(order).map((d) => d.id)).toEqual([...arts].sort(plan.planOrder).map((d) => d.id));
  });

  it("matches the crew by first name", () => {
    expect(plan.crewKey("James Williams")).toBe("james");
    expect(plan.crewKey("J. Williams")).toBeNull();
    expect(plan.crewKey("Zack Bone")).toBe("zack");
    expect(plan.crewKey("Zach Other")).toBe("zack");
    expect(plan.crewKey("Ricardo Villanueva")).toBeNull();
    expect(plan.crewKey("")).toBeNull();
  });
});
