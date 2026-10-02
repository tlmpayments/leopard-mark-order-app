import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { planDoorFromRow, sheetStamp, surveyColumns, visitPayload } from "@/lib/prospects/sheet";
import { cleanSurvey } from "@/lib/prospects/survey";
import { ALL_HEADERS, FIELD_COLUMNS, PLAN_COLUMNS, SURVEY } from "@/lib/prospects/sheetColumns";

describe("reading the plan from the Prospects tab", () => {
  it("turns a sheet row into the plan fields, with numbers as numbers", () => {
    const door = planDoorFromRow({ ID: 7, "Business Name": "KALUAS NIGHT CLUB", Route: "R1 Huntington Park", Stop: "3", "Route Priority": 1, Tier: "A", Latitude: "33.97", Longitude: -118.2 });
    expect(door).toMatchObject({ id: 7, name: "KALUAS NIGHT CLUB", route: "R1 Huntington Park", stop: 3, routePriority: 1, tier: "A", lat: 33.97, lng: -118.2 });
  });

  it("leaves a field out when the sheet cell is blank, so the app keeps its own value", () => {
    const door = planDoorFromRow({ ID: 9, Route: "", Stop: "", "Business Name": "X" })!;
    expect("route" in door).toBe(false);
    expect("stop" in door).toBe(false);
    expect(door.name).toBe("X");
  });

  it("drops rows without a usable ID", () => {
    expect(planDoorFromRow({ Route: "R1", Stop: 1 })).toBeNull();
    expect(planDoorFromRow({ ID: "abc" })).toBeNull();
    expect(planDoorFromRow({ ID: 0 })).toBeNull();
  });
});

describe("writing a visit to the Prospects tab", () => {
  const base = { prospectId: 12, status: "interested", note: "owner out until 4", survey: null, repName: "Zack Bone", markedAt: new Date("2026-10-02T21:31:00Z"), visitCount: 2 };

  it("formats the time the way a person reads a sheet, in Pacific", () => {
    expect(sheetStamp(new Date("2026-10-02T21:31:00Z"))).toBe("2026-10-02 14:31");
  });

  it("writes the status, who, when, count and note", () => {
    const { values, logLine } = visitPayload(base);
    expect(values).toMatchObject({ "Visit Status": "Interested", "Last Visited By": "Zack Bone", "Last Visited At": "2026-10-02 14:31", "Visit Count": 2, "Rep Notes": "owner out until 4" });
    expect(logLine).toBe("2026-10-02 14:31 · Zack Bone · Interested · owner out until 4");
  });

  it("writes every survey column, blank when unanswered, so clearing an answer clears the cell", () => {
    const { values } = visitPayload({ ...base, survey: { decisionMaker: "Marta, GM", interest: "Hot" } });
    expect(values["Decision Maker"]).toBe("Marta, GM");
    expect(values["Interest Level"]).toBe("Hot");
    expect(values["Currently Pouring"]).toBe("");
    for (const q of SURVEY) expect(q.label in values).toBe(true);
  });

  it("puts the survey answers on the log line too", () => {
    const { logLine } = visitPayload({ ...base, note: null, survey: { decisionMaker: "Marta, GM" } });
    expect(logLine).toContain("survey: Decision Maker Marta, GM");
  });

  it("never writes a header the tab does not own (plan columns are the sheet's)", () => {
    const { values } = visitPayload({ ...base, survey: { decisionMaker: "x" } });
    for (const header of Object.keys(values)) {
      expect(FIELD_COLUMNS).toContain(header);
      expect(PLAN_COLUMNS.map((c) => c.header)).not.toContain(header);
    }
  });

  it("a cleared door shows no status but is still logged", () => {
    const { values, logLine } = visitPayload({ ...base, status: "new", note: null });
    expect(values["Visit Status"]).toBe("");
    expect(logLine).toContain("Cleared");
  });

  it("lists only answered questions", () => {
    expect(surveyColumns({ decisionMaker: "A", interest: "" })).toEqual({ "Decision Maker": "A" });
    expect(surveyColumns(null)).toEqual({});
  });
});

describe("survey validation", () => {
  it("keeps valid answers and drops everything else", () => {
    const out = cleanSurvey({
      decisionMaker: "  Marta  ", interest: "Hot", tapHandles: "not-a-choice", samples: "Yes", followUp: "2026-10-09",
      bestTime: "", madeUp: "x", currentlyPouring: 12,
    });
    expect(out).toEqual({ decisionMaker: "Marta", interest: "Hot", samples: "Yes", followUp: "2026-10-09" });
  });
  it("rejects a malformed date and a yes/no that is neither", () => {
    expect(cleanSurvey({ followUp: "next tuesday", samples: "maybe" })).toBeNull();
  });
  it("caps free text", () => {
    expect(cleanSurvey({ decisionMaker: "x".repeat(900) })!.decisionMaker).toHaveLength(500);
  });
  it("is null for no survey at all", () => {
    expect(cleanSurvey(undefined)).toBeNull();
    expect(cleanSurvey([])).toBeNull();
    expect(cleanSurvey({})).toBeNull();
  });
});

describe("the seed file that builds the tab", () => {
  const seed = JSON.parse(readFileSync("public/rep-app/prospects-seed.json", "utf8"));

  it("carries every door with the tab's headers", () => {
    expect(seed.headers).toEqual(PLAN_COLUMNS.map((c) => c.header));
    expect(seed.fieldHeaders).toEqual(FIELD_COLUMNS);
    expect(seed.rows).toHaveLength(551);
    expect([...seed.headers, ...seed.fieldHeaders]).toEqual(ALL_HEADERS);
  });

  it("has no two doors on the same stop of the same route", () => {
    const seen = new Set<string>();
    for (const r of seed.rows as Array<Record<string, unknown>>) {
      if (!r["Route"] || r["Stop"] === "") continue;
      const key = `${r["Route"]}#${r["Stop"]}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it("is in step with the door list the app ships", () => {
    const sandbox: { LM_PROSPECTS?: Array<{ id: number; route: string; stop: number | null }> } = {};
    new Function("window", readFileSync("public/rep-app/assets/js/prospects.js", "utf8"))(sandbox);
    const doors = sandbox.LM_PROSPECTS!;
    expect(seed.rows.map((r: Record<string, unknown>) => r["ID"])).toEqual(doors.map((d) => d.id));
    const route = new Map(doors.map((d) => [d.id, `${d.route}#${d.stop ?? ""}`]));
    for (const r of seed.rows as Array<Record<string, unknown>>) expect(`${r["Route"]}#${r["Stop"]}`).toBe(route.get(r["ID"] as number));
  });
});
