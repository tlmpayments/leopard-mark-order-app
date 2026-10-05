import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Runs the real Apps Script (apps-script/Code.gs) against a fake spreadsheet,
 * so the Prospects handlers are exercised without a Google account: finding a
 * row by ID, writing only the columns named, the secret check, and the visit
 * log (newest first, replay-safe, trimmed).
 */
type Cell = string | number | boolean | Date;

function fakeSheet(grid: Cell[][]) {
  const range = (row: number, col: number, nRows = 1, nCols = 1) => ({
    getValues: () => Array.from({ length: nRows }, (_, r) => Array.from({ length: nCols }, (_, c) => grid[row - 1 + r]?.[col - 1 + c] ?? "")),
    getValue: () => grid[row - 1]?.[col - 1] ?? "",
    setValue: (v: Cell) => { (grid[row - 1] ??= [])[col - 1] = v; },
  });
  return {
    getLastRow: () => grid.length,
    getLastColumn: () => Math.max(...grid.map((r) => r.length)),
    getRange: range,
  };
}

function load(grid: Cell[][], secret: string | null = "s3cret") {
  const sheet = fakeSheet(grid);
  const env = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n: string) => (n === "Routes" ? sheet : null), getSpreadsheetTimeZone: () => "America/Los_Angeles" }), flush: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k: string) => (k === "PROSPECTS_SECRET" ? secret : null) }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  };
  const code = readFileSync("apps-script/Code.gs", "utf8");
  const factory = new Function(...Object.keys(env), `${code}\n;return { handleProspectVisit, handleProspectsList };`);
  return factory(...Object.values(env)) as { handleProspectVisit: (b: unknown) => any; handleProspectsList: (b: unknown) => any };
}

const HEADERS = ["ID", "Business Name", "Route", "Stop", "Visit Status", "Last Visited By", "Rep Notes", "Decision Maker", "Visit Count", "Visit Log"];
const grid = (): Cell[][] => [HEADERS, [1, "A", "R1", 1, "", "", "", "", "", ""], [2, "B", "R1", 2, "", "", "", "", "", ""], [3, "C", "R1", 3, "", "", "", "", "", ""]];

describe("Routes tab: reading", () => {
  it("returns the rows as {header: value}", () => {
    const { handleProspectsList } = load(grid());
    const res = handleProspectsList({ secret: "s3cret" });
    expect(res.ok).toBe(true);
    expect(res.rows).toHaveLength(3);
    expect(res.rows[1]).toMatchObject({ ID: 2, "Business Name": "B", Route: "R1", Stop: 2 });
  });
  it("refuses a wrong or missing secret, and refuses everyone when none is configured", () => {
    expect(load(grid()).handleProspectsList({ secret: "nope" }).ok).toBe(false);
    expect(load(grid()).handleProspectsList({}).ok).toBe(false);
    expect(load(grid(), null).handleProspectsList({ secret: undefined }).ok).toBe(false);
  });
});

describe("Routes tab: writing a visit", () => {
  it("finds the row by ID and writes only the named columns", () => {
    const g = grid();
    const { handleProspectVisit } = load(g);
    const res = handleProspectVisit({ secret: "s3cret", prospectId: 2, values: { "Visit Status": "Visited", "Rep Notes": "hi", "Decision Maker": "Marta" } });
    expect(res).toMatchObject({ ok: true, row: 3 });
    expect(g[2].slice(4, 8)).toEqual(["Visited", "", "hi", "Marta"]);
    // Neighbours and plan columns untouched.
    expect(g[1][4]).toBe("");
    expect(g[2].slice(0, 4)).toEqual([2, "B", "R1", 2]);
  });

  it("ignores a header that is not on the tab instead of failing the visit", () => {
    const g = grid();
    const res = load(g).handleProspectVisit({ secret: "s3cret", prospectId: 1, values: { "No Such Column": "x", "Visit Status": "Signed" } });
    expect(res.ok).toBe(true);
    expect(res.written).toEqual(["Visit Status"]);
  });

  it("says so when the door is not on the tab", () => {
    const res = load(grid()).handleProspectVisit({ secret: "s3cret", prospectId: 999, values: {} });
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toContain("999");
  });

  it("refuses without the secret", () => {
    const g = grid();
    expect(load(g).handleProspectVisit({ prospectId: 1, values: { "Visit Status": "Visited" } }).ok).toBe(false);
    expect(g[1][4]).toBe("");
  });

  it("keeps the visit log newest first, and a replay does not log twice", () => {
    const g = grid();
    const { handleProspectVisit } = load(g);
    handleProspectVisit({ secret: "s3cret", prospectId: 1, values: {}, logLine: "10:00 · James · Visited" });
    handleProspectVisit({ secret: "s3cret", prospectId: 1, values: {}, logLine: "11:00 · Zack · Come back" });
    handleProspectVisit({ secret: "s3cret", prospectId: 1, values: {}, logLine: "11:00 · Zack · Come back" }); // replay
    expect(g[1][9]).toBe("11:00 · Zack · Come back\n10:00 · James · Visited");
  });

  it("trims the log from the old end instead of overflowing the cell", () => {
    const g = grid();
    const { handleProspectVisit } = load(g);
    for (let i = 0; i < 700; i++) handleProspectVisit({ secret: "s3cret", prospectId: 1, values: {}, logLine: `line ${i} ${"x".repeat(60)}` });
    const log = String(g[1][9]);
    expect(log.length).toBeLessThanOrEqual(30000);
    expect(log.startsWith("line 699")).toBe(true);
  });
});
