import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentOpsUser } from "@/lib/ops/session";
import { repTokenFromRequest, verifyRepToken } from "@/lib/prospects/repToken";
import type { ProspectVisitStatus } from "@/app/generated/prisma/enums";

const STATUSES: readonly ProspectVisitStatus[] = ["visited", "interested", "comeback", "signed", "nofit"];
/** One flush of a rep's offline queue. Generous, but not unbounded. */
const MAX_BATCH = 200;

type IncomingVisit = {
  prospectId?: unknown;
  status?: unknown;
  note?: unknown;
  markedAt?: unknown;
};

/**
 * Who is asking. A rep presents the token he got for his PIN; anyone signed
 * into the hub is already authenticated and can read (and, for ops, write on
 * a rep's behalf when he phones one in).
 */
async function caller(request: Request): Promise<{ name: string; canWrite: boolean } | null> {
  const rep = verifyRepToken(repTokenFromRequest(request));
  if (rep) return { name: rep.rep, canWrite: true };

  const opsUser = await currentOpsUser();
  if (opsUser) return { name: opsUser.name, canWrite: true };

  return null;
}

/** Every door anyone has marked. 551 doors is a small enough universe that
 *  paging it would be ceremony -- the whole set is a few kilobytes. */
export async function GET(request: Request): Promise<Response> {
  const who = await caller(request);
  if (!who) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  const visits = await db.prospectVisit.findMany({
    orderBy: { prospectId: "asc" },
    select: { prospectId: true, status: true, note: true, repName: true, markedAt: true, updatedAt: true },
  });

  return NextResponse.json({
    ok: true,
    visits: visits.map((v) => ({
      prospectId: v.prospectId,
      status: v.status,
      note: v.note ?? "",
      rep: v.repName,
      markedAt: v.markedAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    })),
  });
}

/**
 * Record what a rep found. Takes a batch because the rep app queues marks made
 * without signal and flushes them together when it comes back.
 *
 * Last write wins, resolved on `markedAt` rather than arrival: a mark made in
 * a basement at 10am and synced at 3pm should not overwrite one made at 2pm
 * from a phone that had bars.
 */
export async function POST(request: Request): Promise<Response> {
  const who = await caller(request);
  if (!who || !who.canWrite) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  let incoming: IncomingVisit[] = [];
  try {
    const body = (await request.json()) as { visits?: unknown };
    incoming = Array.isArray(body?.visits) ? (body.visits as IncomingVisit[]) : [];
  } catch {
    return NextResponse.json({ ok: false, error: "Send a JSON body with a visits array." }, { status: 400 });
  }

  if (incoming.length === 0) return NextResponse.json({ ok: true, written: 0 });
  if (incoming.length > MAX_BATCH) {
    return NextResponse.json({ ok: false, error: `Send at most ${MAX_BATCH} visits at a time.` }, { status: 413 });
  }

  const clean: Array<{ prospectId: number; status: ProspectVisitStatus; note: string; markedAt: Date }> = [];
  for (const raw of incoming) {
    const prospectId = Number(raw?.prospectId);
    const status = String(raw?.status ?? "") as ProspectVisitStatus;
    if (!Number.isInteger(prospectId) || prospectId < 1 || prospectId > 100000) continue;
    if (!STATUSES.includes(status)) continue;
    const markedAt = new Date(String(raw?.markedAt ?? ""));
    clean.push({
      prospectId,
      status,
      note: String(raw?.note ?? "").slice(0, 2000),
      // A device clock can be wrong or absent; now is a defensible fallback,
      // and a clock running ahead of the server is clamped so a broken phone
      // cannot win every conflict forever.
      markedAt: Number.isNaN(markedAt.getTime()) || markedAt.getTime() > Date.now() ? new Date() : markedAt,
    });
  }

  if (clean.length === 0) {
    return NextResponse.json({ ok: false, error: "Nothing in that batch was a valid visit." }, { status: 400 });
  }

  let written = 0;
  let skipped = 0;
  for (const visit of clean) {
    const existing = await db.prospectVisit.findUnique({
      where: { prospectId: visit.prospectId },
      select: { markedAt: true },
    });
    if (existing && existing.markedAt > visit.markedAt) {
      skipped++;
      continue;
    }
    await db.prospectVisit.upsert({
      where: { prospectId: visit.prospectId },
      create: { ...visit, repName: who.name },
      update: { status: visit.status, note: visit.note, markedAt: visit.markedAt, repName: who.name },
    });
    written++;
  }

  return NextResponse.json({ ok: true, written, skipped });
}

/** Clearing a door, or a rep's whole record. The reset button in the app is
 *  the only caller: statuses a rep made while testing have to be removable,
 *  and now that they are shared, removable by someone other than the phone
 *  that made them. */
export async function DELETE(request: Request): Promise<Response> {
  const who = await caller(request);
  if (!who || !who.canWrite) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  const url = new URL(request.url);
  const rep = url.searchParams.get("rep");
  const prospectId = Number(url.searchParams.get("prospectId"));

  if (Number.isInteger(prospectId) && prospectId > 0) {
    await db.prospectVisit.deleteMany({ where: { prospectId } });
    return NextResponse.json({ ok: true, deleted: 1 });
  }
  if (rep) {
    const result = await db.prospectVisit.deleteMany({ where: { repName: rep } });
    return NextResponse.json({ ok: true, deleted: result.count });
  }
  return NextResponse.json({ ok: false, error: "Name a rep or a prospectId." }, { status: 400 });
}
