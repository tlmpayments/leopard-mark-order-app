/**
 * BOL numbering under concurrency (§11).
 *
 * The Inventory app derives the next BOL number by scanning the BOLs tab for
 * the highest matching prefix and adding one, with no lock — two warehouse
 * staff marking deliveries in the same second both read the same maximum and
 * mint the same number. This suite is the proof that the replacement does not.
 */
import { afterAll, describe, expect, it } from "vitest";
import { testDb, closeTestDb } from "./helpers";
import { formatBolNumber, mintBolNumber, mintDocumentNumber, pacificYymmdd } from "@/lib/bol/sequence";

afterAll(async () => {
  await closeTestDb();
});

describe("format", () => {
  it("matches the format already in the BOLs tab", () => {
    expect(formatBolNumber("WH-BEN", "260902", 1)).toBe("BOL-WH-BEN-260902-01");
  });

  it("keeps the legacy two-digit padding", () => {
    expect(formatBolNumber("WH-SF", "260902", 7)).toBe("BOL-WH-SF-260902-07");
  });

  it("grows past 99 rather than wrapping or truncating", () => {
    // The legacy padStart(2) silently breaks ordering at 100 documents from one
    // location in one day. Three digits is strictly better and byte-identical
    // below 100.
    expect(formatBolNumber("WH-SF", "260902", 100)).toBe("BOL-WH-SF-260902-100");
  });

  it("reads the date in Pacific time, not UTC", () => {
    // 2026-09-03T02:00Z is still Sep 2 in Pacific time, which is the calendar
    // day the warehouse and the Apps Script both use.
    expect(pacificYymmdd(new Date("2026-09-03T02:00:00Z"))).toBe("260902");
    expect(pacificYymmdd(new Date("2026-09-02T18:00:00Z"))).toBe("260902");
  });
});

describe("concurrency", () => {
  it("N parallel mints produce N distinct numbers", async () => {
    // The whole point of the counter row. Ten is above the realistic
    // simultaneous-delivery count and inside the local pool's ceiling.
    const location = `TEST-CONC-${Math.random().toString(36).slice(2, 8)}`;
    const N = 10;

    const minted = await Promise.all(
      Array.from({ length: N }, () => testDb.$transaction((tx) => mintBolNumber(tx, location))),
    );

    expect(new Set(minted).size).toBe(N);
    // And the sequence is contiguous: no gaps, no reuse.
    const seqs = minted.map((m) => Number.parseInt(m.split("-").pop()!, 10)).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });

  it("counts separately per location", async () => {
    const a = `TEST-LOC-A-${Math.random().toString(36).slice(2, 8)}`;
    const b = `TEST-LOC-B-${Math.random().toString(36).slice(2, 8)}`;
    const [first, second] = await Promise.all([
      testDb.$transaction((tx) => mintBolNumber(tx, a)),
      testDb.$transaction((tx) => mintBolNumber(tx, b)),
    ]);
    // Each location starts its own day-series at 01.
    expect(first.endsWith("-01")).toBe(true);
    expect(second.endsWith("-01")).toBe(true);
  });

  it("counts separately per day", async () => {
    const loc = `TEST-DAY-${Math.random().toString(36).slice(2, 8)}`;
    const d1 = new Date("2026-09-02T18:00:00Z");
    const d2 = new Date("2026-09-03T18:00:00Z");
    const one = await testDb.$transaction((tx) => mintBolNumber(tx, loc, d1));
    const two = await testDb.$transaction((tx) => mintBolNumber(tx, loc, d2));
    expect(one).toContain("-260902-01");
    expect(two).toContain("-260903-01");
  });

  it("resumes from the stored counter rather than rescanning", async () => {
    const loc = `TEST-RESUME-${Math.random().toString(36).slice(2, 8)}`;
    const first = await testDb.$transaction((tx) => mintBolNumber(tx, loc));
    const second = await testDb.$transaction((tx) => mintBolNumber(tx, loc));
    expect(first.endsWith("-01")).toBe(true);
    expect(second.endsWith("-02")).toBe(true);

    const row = await testDb.bolSequence.findFirst({ where: { locationId: loc } });
    expect(row?.last).toBe(2);
  });
});

describe("paperwork-only document numbers", () => {
  it("are sequential per day, not four random digits", async () => {
    // The BOL Maker currently mints DR-<yymmdd>-#### with Math.random and no
    // collision check. Two people printing at once can collide; these cannot.
    const results = await Promise.all(Array.from({ length: 5 }, () => mintDocumentNumber("DR", new Date(), testDb)));
    expect(new Set(results).size).toBe(5);
    for (const r of results) expect(r).toMatch(/^DR-\d{6}-\d{4}$/);
  });

  it("keeps DR and BOL paperwork series separate", async () => {
    const dr = await mintDocumentNumber("DR", new Date(), testDb);
    const bol = await mintDocumentNumber("BOL", new Date(), testDb);
    expect(dr.startsWith("DR-")).toBe(true);
    expect(bol.startsWith("BOL-")).toBe(true);
  });
});
