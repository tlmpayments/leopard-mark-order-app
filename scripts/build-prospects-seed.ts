/**
 * Build public/rep-app/prospects-seed.json from the rep app's door list.
 *
 *   npx tsx scripts/build-prospects-seed.ts
 *
 * The seed is what the Apps Script's setupProspectsTab() fetches to create the
 * "Prospects" tab in the TLM Distribution Master File, so it has to be a
 * plain, public, versioned file the script can reach with UrlFetchApp. The
 * door list itself is public licence data (CA ABC) -- nothing private here.
 *
 * Column order and names are the tab's headers; lib/prospects/sheetColumns.ts
 * is the single definition and this script only reads it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { FIELD_COLUMNS, PLAN_COLUMNS, STATUS_LABEL, SURVEY } from "../lib/prospects/sheetColumns";

type Door = Record<string, unknown>;
const sandbox: { LM_PROSPECTS?: Door[]; LM_PROSPECT_SWEEPS?: string[] } = {};
new Function("window", readFileSync("public/rep-app/assets/js/prospects.js", "utf8"))(sandbox);
const doors = sandbox.LM_PROSPECTS ?? [];
const sweeps = sandbox.LM_PROSPECT_SWEEPS ?? [];

const rows = doors.map((d) => {
  const row: Record<string, string | number> = {};
  for (const col of PLAN_COLUMNS) {
    let value = col.read(d, sweeps);
    if (value === undefined || value === null) value = "";
    row[col.header] = value as string | number;
  }
  return row;
});

writeFileSync(
  "public/rep-app/prospects-seed.json",
  JSON.stringify({
    version: 1,
    headers: PLAN_COLUMNS.map((c) => c.header),
    widths: Object.fromEntries(PLAN_COLUMNS.map((c) => [c.header, c.width ?? 100])),
    fieldHeaders: FIELD_COLUMNS,
    // Dropdowns the script puts on the field columns, by header.
    choices: {
      "Visit Status": Object.values(STATUS_LABEL).filter(Boolean),
      ...Object.fromEntries(SURVEY.filter((q) => q.kind === "choice").map((q) => [q.label, q.choices])),
      ...Object.fromEntries(SURVEY.filter((q) => q.kind === "yesno").map((q) => [q.label, ["Yes", "No"]])),
    },
    rows,
  }) + "\n",
);
console.log(`Wrote ${rows.length} doors.`);
