// The compliance gate: an order that has not reached `confirmed` must never
// reach the Sales tab (§1.1 -- the customer's confirmation is the moment of
// contract formation, and "nothing downstream (invoicing, Sheet write,
// fulfillment) may trigger before confirmed").
//
// This test originally guaranteed that by asserting `syncOrderToSheet` had NO
// automatic caller at all, which was true while orders still landed in the
// Sheet via Apps Script. The Ops Platform's job runner now does mirror orders
// (lib/jobs/handlers.ts), so a call-site allowlist alone would only prove that
// somebody remembered to update this file. The invariant therefore moved into
// syncOrderToSheet itself, which refuses any order outside
// SHEET_MIRRORABLE_STATUSES -- and that refusal is what the second block below
// asserts. The call-site grep is kept as a narrower guard: the Sheet write must
// stay out of request-path code under app/, so a page render can never block on
// Google.
import { describe, it, expect } from "vitest";
import { OrderStatus } from "@/app/generated/prisma/enums";
import { SHEET_MIRRORABLE_STATUSES, mayMirrorToSheet } from "@/lib/sheetColumns";
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

// Paths allowed to CALL syncOrderToSheet(...): its own definition, this test
// suite, one-off scripts a human invokes directly, and the job handlers. The
// job runner is the one legitimate automatic caller -- it runs off the queue,
// out of the request path, with a retry ladder and a dead-letter state, which
// is exactly the property that makes "never let a Sheet outage fail a user
// action" (§2 rule 3) true rather than aspirational.
const ALLOWED_CALL_SITE_PREFIXES = [
  "lib/sheetSync.ts",
  "lib/jobs/handlers.ts",
  "__tests__/",
  "scripts/",
];

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

describe("confirmation gate: the Sheet mirror refuses an unconfirmed order", () => {
  it("permits exactly the post-gate statuses", () => {
    expect([...SHEET_MIRRORABLE_STATUSES]).toEqual(["confirmed", "scheduled", "fulfilled"]);
  });

  it.each([["confirmed"], ["scheduled"], ["fulfilled"]])("%s may mirror", (status) => {
    expect(mayMirrorToSheet(status)).toBe(true);
  });

  it.each([["draft"], ["pending_confirmation"], ["cancelled"], ["rejected"], ["expired"]])(
    "%s may NOT mirror",
    (status) => {
      // draft and pending_confirmation have not formed a contract; the other
      // three have been withdrawn. None of them belongs on the sheet the
      // business invoices from.
      expect(mayMirrorToSheet(status)).toBe(false);
    },
  );

  it("covers every OrderStatus value, so a new status cannot default to mirrorable", () => {
    const all = Object.keys(OrderStatus);
    expect(all).toHaveLength(8);
    for (const status of all) {
      expect(typeof mayMirrorToSheet(status)).toBe("boolean");
    }
    expect(all.filter(mayMirrorToSheet).sort()).toEqual(["confirmed", "fulfilled", "scheduled"]);
  });
});
