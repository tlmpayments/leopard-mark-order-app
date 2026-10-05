/**
 * The "Routes" tab of the TLM Distribution Master File: one row per door.
 *
 * Two kinds of column, and the line between them is the whole design:
 *
 *  PLAN columns  -- owned by the SHEET. They describe the door and where it
 *    falls in a route. Edit them freely: change a Stop number and the route is
 *    reordered in the rep app, move a door to another Route, fix an address.
 *    The app reads them; it never writes them.
 *
 *  FIELD columns -- owned by the APP. What a rep found at the door: status,
 *    who went and when, notes, the survey answers, and a running visit log.
 *    The app overwrites these on every visit, one-way, the way the Notion
 *    mirror works; typing in them is lost on the next visit to that door
 *    (the database holds the record, the sheet is where the office reads it).
 *
 * The tab is a mirror of one thing and a control panel for another, and the
 * header colours say which is which (plan = white, field = grey).
 */

/** Read a plan value out of the rep app's static door record. */
export interface PlanColumn {
  header: string;
  /** The field on the door record the app overlays from the sheet, if any. */
  field?: string;
  read: (door: Record<string, unknown>, sweeps: string[]) => string | number | null | undefined;
  width?: number;
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export const PLAN_COLUMNS: PlanColumn[] = [
  { header: "ID", field: "id", read: (d) => d.id as number, width: 50 },
  { header: "Business Name", field: "name", read: (d) => str(d.name), width: 230 },
  { header: "Owner", field: "owner", read: (d) => str(d.owner), width: 200 },
  { header: "License Type", field: "licType", read: (d) => str(d.licType), width: 90 },
  { header: "ABC Status", field: "abcStatus", read: (d) => str(d.abcStatus), width: 90 },
  { header: "ZIP", field: "zip", read: (d) => str(d.zip), width: 65 },
  { header: "Address", field: "address", read: (d) => str(d.address), width: 280 },
  { header: "City", field: "city", read: (d) => str(d.city), width: 140 },
  { header: "Segment", field: "segment", read: (d) => str(d.segment), width: 150 },
  { header: "Tier", field: "tier", read: (d) => str(d.tier), width: 45 },
  { header: "Wave", field: "wave", read: (d) => str(d.wave), width: 190 },
  { header: "Route Priority", field: "routePriority", read: (d) => (d.routePriority as number | null) ?? "", width: 80 },
  { header: "Route", field: "route", read: (d) => str(d.route), width: 220 },
  { header: "Stop", field: "stop", read: (d) => (d.stop as number | null) ?? "", width: 55 },
  { header: "Corridor Sweep", field: "sweep", read: (d, sweeps) => (d.sweep === null || d.sweep === undefined ? "" : sweeps[d.sweep as number] ?? ""), width: 300 },
  { header: "Second Pass Group", field: "group", read: (d) => str(d.group), width: 220 },
  { header: "Latitude", field: "lat", read: (d) => (d.lat as number | null) ?? "", width: 85 },
  { header: "Longitude", field: "lng", read: (d) => (d.lng as number | null) ?? "", width: 85 },
];

/**
 * The questions a rep answers at the door. One list drives the rep app's form,
 * the survey columns in the sheet, and validation on the way in -- add a
 * question here and it appears in all three. `key` is stored; `label` is what
 * the sheet column is called.
 */
export interface SurveyQuestion {
  key: string;
  label: string;
  kind: "text" | "choice" | "yesno" | "date";
  choices?: string[];
  placeholder?: string;
}

export const SURVEY: SurveyQuestion[] = [
  { key: "decisionMaker", label: "Decision Maker", kind: "text", placeholder: "Name and role" },
  { key: "contact", label: "Contact (phone / email)", kind: "text", placeholder: "Best way to reach them" },
  { key: "currentlyPouring", label: "Currently Pouring", kind: "text", placeholder: "Brands on tap now" },
  { key: "tapHandles", label: "Tap Handles", kind: "choice", choices: ["1-4", "5-8", "9-16", "17+"] },
  { key: "interest", label: "Interest Level", kind: "choice", choices: ["Hot", "Warm", "Cold", "Not a fit"] },
  { key: "samples", label: "Samples Requested", kind: "yesno" },
  { key: "buysFrom", label: "Buys Beer From", kind: "text", placeholder: "Distributor / how they order" },
  { key: "bestTime", label: "Best Time to Return", kind: "text", placeholder: "Day and time" },
  { key: "followUp", label: "Follow-Up Date", kind: "date" },
];

/** Columns the app writes. Everything after the plan columns, in this order. */
export const FIELD_COLUMNS: string[] = [
  "Visit Status",
  "Last Visited By",
  "Last Visited At",
  "Visit Count",
  "Rep Notes",
  ...SURVEY.map((q) => q.label),
  "Visit Log",
];

export const ALL_HEADERS: string[] = [...PLAN_COLUMNS.map((c) => c.header), ...FIELD_COLUMNS];

/** Status as the sheet shows it. The app's keys are lower-case and short. */
export const STATUS_LABEL: Record<string, string> = {
  visited: "Visited",
  interested: "Interested",
  comeback: "Come back",
  signed: "Signed",
  nofit: "Not a fit",
  new: "",
};
