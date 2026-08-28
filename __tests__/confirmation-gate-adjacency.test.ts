// Phase 2 (Sheet <-> Postgres sync) is not this phase's job to build the
// full confirmation gate (no channel creates real orders automatically yet
// -- that's Phase 4/5's job per the plan). What IS this phase's job: make
// sure nothing accidentally wired `syncOrderToSheet` (the DB -> Sheet call)
// into anything automatic/user-facing before that gate exists. This test
// greps the actual source tree (not a mock of it) for every call site of
// `syncOrderToSheet(` and asserts each one is either the function's own
// definition or explicit test/script code.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".next",
  ".git",
  ".vercel",
  ".agents",
  ".claude",
  ".windsurf",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full);
    if (rel === "app/generated" || rel.startsWith("app/generated" + path.sep)) continue;
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Paths allowed to actually CALL syncOrderToSheet(...) at this phase: its
// own definition file, this test suite, and one-off scripts (which run only
// when a human invokes them directly, e.g. `npx tsx scripts/...`).
const ALLOWED_CALL_SITE_PREFIXES = ["lib/sheetSync.ts", "__tests__/", "scripts/"];

describe("confirmation-gate adjacency: syncOrderToSheet has no automatic caller yet", () => {
  it("every reference to syncOrderToSheet( in the source tree is a definition, a comment, or explicit test/script code", () => {
    const files = walk(ROOT);
    const referenceSites: { rel: string; line: number; text: string }[] = [];

    for (const file of files) {
      const rel = path.relative(ROOT, file);
      const content = fs.readFileSync(file, "utf8");
      content.split("\n").forEach((line, i) => {
        if (line.includes("syncOrderToSheet(")) {
          referenceSites.push({ rel, line: i + 1, text: line.trim() });
        }
      });
    }

    // Sanity check on the test itself: syncOrderToSheet must actually exist
    // somewhere in the tree, or this whole test would trivially (and
    // uselessly) pass by finding nothing at all.
    expect(referenceSites.length).toBeGreaterThan(0);

    const disallowed = referenceSites.filter(
      (site) => !ALLOWED_CALL_SITE_PREFIXES.some((prefix) => site.rel.startsWith(prefix)),
    );

    expect(disallowed).toEqual([]);
  });

  it("no app/ route, page, or component calls syncOrderToSheet — that wiring is Phase 4/5's job", () => {
    const appDir = path.join(ROOT, "app");
    const files = fs.existsSync(appDir) ? walk(appDir) : [];
    const callSites: string[] = [];

    for (const file of files) {
      const rel = path.relative(ROOT, file);
      if (rel.startsWith(path.join("app", "generated"))) continue;
      const content = fs.readFileSync(file, "utf8");
      content.split("\n").forEach((line, i) => {
        // A real call has the form `syncOrderToSheet(<args>)` invoked, not
        // merely mentioned in a comment -- but for this phase's purpose
        // (nothing should even *mention* wiring it in yet outside the
        // documented exception below), flag any non-comment occurrence.
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (line.includes("syncOrderToSheet(")) callSites.push(`${rel}:${i + 1}`);
      });
    }

    expect(callSites).toEqual([]);
  });
});
