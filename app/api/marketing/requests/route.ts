import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { db } from "@/lib/db";
import { currentOpsUser } from "@/lib/ops/session";
import { repTokenFromRequest, verifyRepToken } from "@/lib/prospects/repToken";
import { mintRequestNumber, repMayCancel } from "@/lib/marketing/requests";
import { postMarketingRequest, postMarketingStatus } from "@/lib/marketing/slack";
import type { MarketingRequestStatus } from "@/app/generated/prisma/enums";

/**
 * Marketing requests: submit, list, withdraw.
 *
 * Replaces the `action: 'marketingOrder'` POST to Apps Script. The request now
 * lands in Postgres, gets a number, and posts to Slack — so the thing a rep
 * submits has somewhere to be worked rather than a row on a spreadsheet tab
 * nobody had a queue for.
 *
 * Authentication mirrors /api/prospects/visits: a rep presents the token he
 * got for his PIN; anyone in the hub is already authenticated and can file one
 * on his behalf when he phones it in.
 */

export const dynamic = "force-dynamic";

/** Attachments: the same ceiling the rep app's own UI enforces, restated here
 *  because a client-side limit is a courtesy, not a control. */
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5_000_000;
const ACCEPTED_ATTACHMENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];
const MAX_LINES = 60;

type Caller = { name: string; isOps: boolean };

async function caller(request: Request): Promise<Caller | null> {
  const rep = verifyRepToken(repTokenFromRequest(request));
  if (rep) return { name: rep.rep, isOps: false };
  const opsUser = await currentOpsUser();
  if (opsUser) return { name: opsUser.name, isOps: true };
  return null;
}

type IncomingLine = { sku?: unknown; qty?: unknown; size?: unknown };
type IncomingAttachment = { name?: unknown; mimeType?: unknown; dataBase64?: unknown };

/**
 * What a rep sees of his own history, and what the hub reads for the log.
 *
 * A rep gets his own requests and nobody else's — not because another rep's
 * sticker order is a secret, but because the app's "My Requests" screen is
 * useless if it lists everyone's.
 */
export async function GET(request: Request): Promise<Response> {
  const who = await caller(request);
  if (!who) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  const url = new URL(request.url);
  const all = who.isOps && url.searchParams.get("scope") === "all";

  const requests = await db.marketingRequest.findMany({
    where: {
      deletedAt: null,
      ...(all ? {} : { repName: who.name }),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      lines: { select: { sku: true, name: true, brand: true, qty: true, unit: true, size: true } },
      attachments: { select: { filename: true, url: true } },
    },
  });

  return NextResponse.json({
    ok: true,
    requests: requests.map((r) => ({
      id: r.id,
      requestNumber: r.requestNumber,
      status: r.status,
      rep: r.repName,
      purpose: r.purpose,
      neededBy: r.neededBy.toISOString().slice(0, 10),
      account: r.accountName ?? "",
      eventName: r.eventName ?? "",
      shipAddress: r.shipAddress ?? "",
      customRequest: r.customRequest ?? "",
      otherDetails: r.otherDetails ?? "",
      decisionNote: r.decisionNote ?? "",
      archived: Boolean(r.archivedAt),
      createdAt: r.createdAt.toISOString(),
      lines: r.lines,
      attachments: r.attachments,
    })),
  });
}

/**
 * File a request.
 *
 * The validation here is the same shape the rep app's submit button already
 * enforces client-side — a purpose, a needed-by date, and either at least one
 * line or a described custom ask. Restated server-side because the client's
 * copy is a courtesy to the rep, not a guarantee to the database.
 */
export async function POST(request: Request): Promise<Response> {
  const who = await caller(request);
  if (!who) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Send a JSON body." }, { status: 400 });
  }

  const str = (key: string, max = 2000): string => String(body[key] ?? "").trim().slice(0, max);

  const purpose = str("purpose", 120);
  const neededByRaw = str("neededBy", 40);
  const customRequest = str("customRequest", 4000);
  const email = str("email", 200);

  if (!purpose) return NextResponse.json({ ok: false, error: "Choose what this request is for." }, { status: 400 });

  const neededBy = new Date(`${neededByRaw}T12:00:00-08:00`);
  if (Number.isNaN(neededBy.getTime())) {
    return NextResponse.json({ ok: false, error: "That needed-by date is not a date." }, { status: 400 });
  }
  if (email && !email.includes("@")) {
    return NextResponse.json({ ok: false, error: "That email address looks incomplete." }, { status: 400 });
  }

  // ---- Lines, resolved against the live catalogue ------------------------
  // The client sends skus and quantities; the name, brand and unit are read
  // from the catalogue here and copied onto the line. A client that sends its
  // own names would let a stale cached catalogue write a discontinued item's
  // old name into the permanent record of what was ordered.
  const rawLines = Array.isArray(body.lines) ? (body.lines as IncomingLine[]) : [];
  if (rawLines.length > MAX_LINES) {
    return NextResponse.json({ ok: false, error: `Send at most ${MAX_LINES} lines.` }, { status: 413 });
  }

  const wanted = new Map<string, { qty: number; size: string | null }>();
  for (const raw of rawLines) {
    const sku = String(raw?.sku ?? "").trim();
    const qty = Number(raw?.qty);
    const size = raw?.size ? String(raw.size).trim().slice(0, 40) : null;
    if (!sku || !Number.isInteger(qty) || qty < 1 || qty > 10000) continue;
    // Same sku twice (two sizes of a polo) is two lines; same sku and same
    // size is one, summed, so a double-tap cannot silently double an order.
    const key = `${sku}::${size ?? ""}`;
    const existing = wanted.get(key);
    wanted.set(key, { qty: Math.min((existing?.qty ?? 0) + qty, 10000), size });
  }

  const skus = [...new Set([...wanted.keys()].map((k) => k.split("::")[0]))];
  const items = skus.length
    ? await db.marketingItem.findMany({
        where: { sku: { in: skus }, active: true },
        select: { id: true, sku: true, name: true, brand: true, unit: true, type: true },
      })
    : [];
  const bySku = new Map(items.map((i) => [i.sku, i]));

  const lines = [...wanted.entries()].flatMap(([key, { qty, size }]) => {
    const sku = key.split("::")[0];
    const item = bySku.get(sku);
    if (!item) return [];
    return [{ itemId: item.id, sku: item.sku, name: item.name, brand: item.brand, unit: item.unit, qty, size }];
  });

  // A request with neither picked items nor a described ask is not a request.
  // Checked after resolution so that a client sending only skus we no longer
  // stock gets told, rather than filing an empty request.
  if (lines.length === 0 && !customRequest) {
    return NextResponse.json(
      {
        ok: false,
        error: rawLines.length
          ? "Nothing on that request is still in the catalogue. Describe what you need under Custom Request."
          : "Add at least one material, or describe what you need under Custom Request.",
      },
      { status: 400 },
    );
  }

  // ---- Attachments -------------------------------------------------------
  const rawAttachments = Array.isArray(body.attachments) ? (body.attachments as IncomingAttachment[]) : [];
  const attachments: Array<{ filename: string; mimeType: string; bytes: number; url: string }> = [];
  if (rawAttachments.length > MAX_ATTACHMENTS) {
    return NextResponse.json(
      { ok: false, error: `Attach at most ${MAX_ATTACHMENTS} files.` },
      { status: 413 },
    );
  }
  const blobConfigured = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  for (const raw of rawAttachments) {
    const filename = String(raw?.name ?? "file").slice(0, 200);
    const mimeType = String(raw?.mimeType ?? "");
    const dataBase64 = String(raw?.dataBase64 ?? "");
    if (!ACCEPTED_ATTACHMENT_TYPES.includes(mimeType) || !dataBase64) continue;
    const buffer = Buffer.from(dataBase64, "base64");
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_ATTACHMENT_BYTES) continue;
    // Blob being unconfigured must not lose the request — the artwork is
    // supporting material, the request is the thing that matters. The rep is
    // told below how many made it.
    if (!blobConfigured) continue;
    const blob = await put(`marketing/${Date.now()}-${filename}`, buffer, {
      access: "public",
      addRandomSuffix: true,
      contentType: mimeType,
    });
    attachments.push({ filename, mimeType, bytes: buffer.byteLength, url: blob.url });
  }

  // ---- Write -------------------------------------------------------------
  const accountName = str("account", 300);
  const created = await db.$transaction(async (tx) => {
    const requestNumber = await mintRequestNumber(tx);
    return tx.marketingRequest.create({
      data: {
        requestNumber,
        repName: who.name,
        email: email || null,
        purpose,
        neededBy,
        accountName: accountName || null,
        region: str("accountRegion", 80) || null,
        eventName: str("eventName", 300) || null,
        shipAddress: str("shipAddress", 1000) || null,
        customRequest: customRequest || null,
        size: str("size", 120) || null,
        otherDetails: str("otherDetails", 4000) || null,
        lines: { create: lines },
        attachments: { create: attachments },
        events: {
          create: {
            action: "submitted",
            status: "pending",
            actor: who.name,
            note: who.isOps ? "Filed in the hub on the rep's behalf." : null,
          },
        },
      },
      select: { id: true, requestNumber: true },
    });
  });

  // ---- Slack -------------------------------------------------------------
  // After the commit, deliberately: a Slack outage must not roll back a
  // request a rep has already been told is in. If the post fails the row keeps
  // null slack columns and the hub still shows it.
  const shipTo = accountName || str("eventName", 300) || null;
  let posted: { channel: string; ts: string } | null = null;
  try {
    posted = await postMarketingRequest({
      requestNumber: created.requestNumber,
      repName: who.name,
      purpose,
      neededBy,
      shipTo,
      lines,
      customRequest: customRequest || null,
      otherDetails: str("otherDetails", 4000) || null,
      attachmentCount: attachments.length,
    });
  } catch (error) {
    console.warn("[marketing] Slack post failed:", error);
  }
  if (posted) {
    await db.marketingRequest.update({
      where: { id: created.id },
      data: { slackChannel: posted.channel, slackTs: posted.ts },
    });
  }

  return NextResponse.json({
    ok: true,
    requestNumber: created.requestNumber,
    lines: lines.length,
    attachments: attachments.length,
    // So the rep app can say so rather than silently dropping them.
    attachmentsDropped: rawAttachments.length - attachments.length,
  });
}

/**
 * Withdraw a request. The only status change a rep may make, and only to his
 * own, and only while it is still pending or approved — once marketing has
 * fulfilled it the stickers are in the post.
 */
export async function PATCH(request: Request): Promise<Response> {
  const who = await caller(request);
  if (!who) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });

  let body: { id?: unknown; action?: unknown };
  try {
    body = (await request.json()) as { id?: unknown; action?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "Send a JSON body." }, { status: 400 });
  }

  const id = String(body?.id ?? "");
  if (String(body?.action ?? "") !== "cancel") {
    return NextResponse.json({ ok: false, error: "The only action here is cancel." }, { status: 400 });
  }

  const existing = await db.marketingRequest.findUnique({
    where: { id },
    select: { id: true, status: true, repName: true, requestNumber: true, slackChannel: true, slackTs: true },
  });
  if (!existing || (!who.isOps && existing.repName !== who.name)) {
    // Same answer for "does not exist" and "not yours": a rep probing ids
    // should not be able to tell the difference.
    return NextResponse.json({ ok: false, error: "No such request." }, { status: 404 });
  }
  if (!repMayCancel(existing.status as MarketingRequestStatus)) {
    return NextResponse.json(
      { ok: false, error: `A ${existing.status} request cannot be withdrawn. Ask marketing.` },
      { status: 409 },
    );
  }

  await db.marketingRequest.update({
    where: { id },
    data: {
      status: "cancelled",
      decidedBy: who.name,
      decidedAt: new Date(),
      events: { create: { action: "cancelled", status: "cancelled", actor: who.name } },
    },
  });

  await postMarketingStatus(existing, "cancelled", who.name);

  return NextResponse.json({ ok: true, requestNumber: existing.requestNumber });
}
