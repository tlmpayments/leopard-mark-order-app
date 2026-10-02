import { NextResponse } from "next/server";
import { currentOpsUser } from "@/lib/ops/session";
import { repTokenFromRequest, verifyRepToken } from "@/lib/prospects/repToken";
import { configured, readPlan } from "@/lib/prospects/sheet";

/**
 * The plan: where each door falls in its route, as the Prospects tab has it.
 *
 * This is how a Stop number typed into the sheet reaches a rep's phone. The
 * app ships a static door list as a fallback and overlays whatever this
 * returns on top of it, by id, so:
 *  - `source: "static"` means the sheet is not connected (or unreachable and
 *    nothing is cached) and the app keeps what it has;
 *  - `source: "sheet"` carries the plan fields the sheet has a value for.
 *
 * Same callers as the visits API: a rep with his token, or anyone signed into
 * the hub. The tab also holds reps' notes, which is why this goes through the
 * server and its secret rather than a public sheet link.
 */
export async function GET(request: Request): Promise<Response> {
  const rep = verifyRepToken(repTokenFromRequest(request));
  if (!rep && !(await currentOpsUser())) {
    return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  }

  if (!configured()) return NextResponse.json({ ok: true, source: "static", reason: "not-configured" });

  const plan = await readPlan();
  if (!plan) return NextResponse.json({ ok: true, source: "static", reason: "unreachable" });

  return NextResponse.json(
    { ok: true, source: "sheet", stale: plan.stale, doors: plan.doors },
    { headers: { "Cache-Control": "private, max-age=20" } },
  );
}
