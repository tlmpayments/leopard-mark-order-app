import { FIELD_COLUMNS, STATUS_LABEL, SURVEY, PLAN_COLUMNS } from "@/lib/prospects/sheetColumns";

/**
 * The server's line to the "Prospects" tab, through the Apps Script web app.
 *
 * Both directions need SYNC_SHARED_SECRET (here as an env var, there as a
 * Script Property). Until it and APPS_SCRIPT_URL are both set, `configured()`
 * is false and every caller degrades quietly: the plan falls back to the
 * static door list and the mirror job skips instead of failing. A rep's visit
 * is saved in the database first and always, so a sheet that is not connected
 * costs the office a view, never a rep's work.
 */

export function configured(): boolean {
  return Boolean(process.env.APPS_SCRIPT_URL && process.env.SYNC_SHARED_SECRET);
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const url = process.env.APPS_SCRIPT_URL;
  const secret = process.env.SYNC_SHARED_SECRET;
  if (!url || !secret) throw new Error("not configured");
  // Apps Script answers a POST with a redirect to the real response; follow it.
  const response = await fetch(url, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids a CORS-style preflight Apps Script cannot answer
    body: JSON.stringify({ ...body, secret }),
    cache: "no-store",
  });
  const text = await response.text();
  if (text.trimStart().startsWith("<")) throw new Error("Apps Script returned HTML (is the web app deployed for everyone?)");
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------- reading --

export type PlanDoor = {
  id: number;
  /** Only the fields the sheet actually had a value for; the rest stay static. */
  [field: string]: string | number | undefined;
};

type ListResponse = { ok: boolean; error?: string; rows?: Array<Record<string, unknown>> };

const NUMERIC = new Set(["id", "routePriority", "stop", "lat", "lng"]);

/** One sheet row as the plan fields the app overlays onto its door record. */
export function planDoorFromRow(row: Record<string, unknown>): PlanDoor | null {
  const door: PlanDoor = { id: NaN };
  for (const col of PLAN_COLUMNS) {
    if (!col.field) continue;
    const raw = row[col.header];
    if (raw === "" || raw === null || raw === undefined) continue;
    if (NUMERIC.has(col.field)) {
      const n = Number(raw);
      if (Number.isFinite(n)) door[col.field] = n;
    } else {
      door[col.field] = String(raw).trim();
    }
  }
  if (!Number.isInteger(door.id) || door.id < 1) return null;
  return door;
}

let cache: { at: number; doors: PlanDoor[] } | null = null;
const TTL_MS = 45_000;

/**
 * The plan, read from the sheet and held for 45 seconds per server instance.
 * Apps Script takes a second or two to read the tab, and every rep's phone
 * asks, so the cache is what keeps this from being a slow call per rep per
 * minute. On a failed refresh the last good copy is served rather than an
 * error: a route should not reorder itself into nothing because Google hiccupped.
 */
export async function readPlan(): Promise<{ doors: PlanDoor[]; stale: boolean } | null> {
  if (!configured()) return null;
  if (cache && Date.now() - cache.at < TTL_MS) return { doors: cache.doors, stale: false };
  try {
    const res = await call<ListResponse>({ action: "prospectsList" });
    if (!res.ok || !res.rows) throw new Error(res.error ?? "prospectsList failed");
    const doors = res.rows.map(planDoorFromRow).filter((d): d is PlanDoor => d !== null);
    cache = { at: Date.now(), doors };
    return { doors, stale: false };
  } catch (error) {
    console.error("[prospects] could not read the Prospects tab", error);
    return cache ? { doors: cache.doors, stale: true } : null;
  }
}

// ---------------------------------------------------------------- writing --

const PT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
/** "2026-10-02 14:31", Pacific -- the way a person reads a sheet. */
export function sheetStamp(d: Date): string {
  return PT.format(d).replace(",", "");
}

export type VisitForSheet = {
  prospectId: number;
  status: string; // app key: visited | interested | ...; "new" when cleared
  note: string | null;
  survey: Record<string, unknown> | null;
  repName: string;
  markedAt: Date;
  visitCount: number;
};

/** The survey as {sheet column title: answer}, only for questions answered. */
export function surveyColumns(survey: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of SURVEY) {
    const v = survey?.[q.key];
    if (v === undefined || v === null || String(v).trim() === "") continue;
    out[q.label] = String(v);
  }
  return out;
}

/** What goes into the tab for one visit: the field columns, and one log line. */
export function visitPayload(v: VisitForSheet): { values: Record<string, string | number>; logLine: string } {
  const status = STATUS_LABEL[v.status] ?? v.status;
  const answers = surveyColumns(v.survey);
  const values: Record<string, string | number> = {
    "Visit Status": status,
    "Last Visited By": v.repName,
    "Last Visited At": sheetStamp(v.markedAt),
    "Visit Count": v.visitCount,
    "Rep Notes": v.note ?? "",
  };
  // Every survey column is written, blank when unanswered, so a question that
  // was cleared in the app is cleared in the sheet too.
  for (const q of SURVEY) values[q.label] = answers[q.label] ?? "";

  const answered = Object.keys(answers).length;
  const parts = [sheetStamp(v.markedAt), v.repName, status || "Cleared"];
  if (v.note) parts.push(v.note.replace(/\s+/g, " ").trim());
  if (answered) parts.push(`survey: ${Object.entries(answers).map(([k, a]) => `${k} ${a}`).join("; ")}`);
  return { values, logLine: parts.join(" · ") };
}

export async function writeVisit(v: VisitForSheet): Promise<{ row: number }> {
  const { values, logLine } = visitPayload(v);
  const res = await call<{ ok: boolean; error?: string; row?: number }>({
    action: "prospectVisit",
    prospectId: v.prospectId,
    values,
    logLine,
  });
  if (!res.ok) throw new Error(res.error ?? "prospectVisit failed");
  // The plan did not change, but the next read should not be a minute stale.
  cache = null;
  return { row: res.row ?? 0 };
}

/** Every header the app may write. Used by tests to keep the three lists aligned. */
export const WRITABLE_HEADERS: readonly string[] = FIELD_COLUMNS;
