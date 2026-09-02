// DB -> Sheet sync caller (Phase 2). Reusable by future phases (the portal
// and SMS order confirmation flows will call `syncOrderToSheet` once they
// exist) -- for this phase only this file's own verification script calls
// it. See the wire protocol in
// /Users/jackbegley/.claude/plans/jazzy-pondering-rivest.md ("Sheet sync
// architecture") and the shared design context this phase was built against
// for the exact request/response shape; `app/api/sheet-sync/webhook/route.ts`
// is this file's counterpart for the Sheet -> DB direction.
import { db } from "@/lib/db";
import { SHEET_MIRRORABLE_STATUSES, mayMirrorToSheet } from "@/lib/sheetColumns";
import type { Prisma } from "@/app/generated/prisma/client";

// ---------- Pure payload builder ----------
//
// No I/O, no Prisma import in the type surface below beyond plain
// scalars/Decimal-as-number -- callers hand this already-resolved,
// plain-JS-shaped data so it can be unit tested with handwritten fixtures,
// no live network call or database required.

export interface SyncOrderLineInput {
  productName: string;
  packagingFormat: string;
  productCode: string;
  qty: number;
  price: number;
  lineTotal: number;
}

export interface SyncOrderAccountInput {
  businessName: string;
  licenseNumber: string | null;
  // Fallback only -- `order.paymentMethod` (computed at order-creation time,
  // same as Code.gs's handleOrder does today) wins when present. See
  // buildSyncOrderPayload.
  paymentMethod: string | null;
}

export interface SyncOrderRepInput {
  name: string;
}

export interface SyncOrderOrderInput {
  id: string;
  invoiceNumber: string | null;
  paymentMethod: string | null;
  inventorySource: string | null;
  notes: string | null;
  invoiceStatus: string | null;
  // The timestamp the caller has decided counts as "PO Date" for this order.
  // `orders` has no dedicated `po_date` column (see syncOrderToSheet for
  // which timestamp it resolves this to and why) -- this module just
  // formats whatever Date it's handed as YYYY-MM-DD.
  poDate: Date | string | null;
}

// The wire-protocol body, minus `secret` -- the secret is an env var, not
// order content, so it's injected by `syncOrderToSheet` after calling this
// pure helper rather than threaded through it.
export interface SyncOrderBody {
  action: "syncOrder";
  orderId: string;
  invoiceNumber: string;
  customer: string;
  licenseNumber: string;
  poDate: string;
  salesRep: string;
  paymentMethod: string;
  inventorySource: string;
  notes: string;
  invoiceStatus: string;
  lines: SyncOrderLineInput[];
  // Whether this is the account's first order ever -- computed here, not on
  // the Apps Script side, since Postgres (not the Sheet) is what has the
  // account's order history now. Apps Script uses this to decide between
  // the ":tada: FIRST ORDER" and ":beer: NEW ORDER" Slack message variants,
  // matching what handleOrder's rep-app path has always done.
  isFirstOrder: boolean;
}

export type SyncOrderPayload = SyncOrderBody & { secret: string };

function formatDateOnly(value: Date | string | null): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export function buildSyncOrderPayload(
  order: SyncOrderOrderInput,
  lines: SyncOrderLineInput[],
  account: SyncOrderAccountInput,
  rep: SyncOrderRepInput | null,
  isFirstOrder: boolean,
): SyncOrderBody {
  return {
    action: "syncOrder",
    orderId: order.id,
    invoiceNumber: order.invoiceNumber ?? "",
    customer: account.businessName,
    licenseNumber: account.licenseNumber ?? "",
    poDate: formatDateOnly(order.poDate),
    salesRep: rep?.name ?? "",
    paymentMethod: order.paymentMethod ?? account.paymentMethod ?? "",
    inventorySource: order.inventorySource ?? "",
    notes: order.notes ?? "",
    invoiceStatus: order.invoiceStatus ?? "",
    lines: lines.map((line) => ({
      productName: line.productName,
      packagingFormat: line.packagingFormat,
      productCode: line.productCode,
      qty: line.qty,
      price: line.price,
      lineTotal: line.lineTotal,
    })),
    isFirstOrder,
  };
}

// ---------- syncOrderToSheet (the I/O-doing export) ----------

export interface SyncOrderResult {
  ok: boolean;
  alreadySynced?: boolean;
  error?: string;
  // Present only on a fresh (non-replayed) successful sync -- Apps Script
  // posts the order notification via Slack's chat.postMessage (not an
  // Incoming Webhook, which can't return this) and echoes back where it
  // landed. Lets the rep app's confirmation screen deep-link straight to
  // that message's thread.
  slackChannel?: string;
  slackTs?: string;
}

async function recordSyncLog(
  orderId: string,
  status: "success" | "error",
  fieldsChanged: Prisma.InputJsonValue,
): Promise<void> {
  try {
    await db.syncLog.create({
      data: {
        direction: "db_to_sheet",
        orderId,
        status,
        conflict: false,
        fieldsChanged,
      },
    });
  } catch (err) {
    // A SyncLog write failing is itself a bug worth knowing about, but must
    // never mask the actual sync result the caller is waiting on.
    console.error(`sheetSync: failed to write SyncLog for order ${orderId}`, err);
  }
}

// Loads an order + its lines/account/rep, POSTs the syncOrder request to the
// Apps Script web app, and records the outcome. Idempotent by construction
// on the receiving end (see the wire protocol) -- calling this twice for the
// same order is safe and expected (e.g. a retry after a transient network
// error), not something this function needs to guard against itself.
export async function syncOrderToSheet(orderId: string): Promise<SyncOrderResult> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      account: { include: { salesRep: true } },
      salesRep: true,
      lines: { include: { product: true }, orderBy: { lineIndex: "asc" } },
    },
  });

  if (!order) {
    // No order row to attach a SyncLog to (order_id is a required FK) --
    // return the error directly rather than trying to log it.
    return { ok: false, error: `Order not found: ${orderId}` };
  }

  // The compliance gate, enforced here rather than at each call site. A draft
  // or pending_confirmation order is not yet a binding order (§1.1 -- the
  // customer's confirmation is the moment of contract formation), and writing
  // it into the Sales tab would put a non-order onto the sheet the business
  // invoices from. Refuse rather than mirror, whoever asked.
  if (!mayMirrorToSheet(order.status)) {
    return {
      ok: false,
      error: `Order ${orderId} is ${order.status}; only ${SHEET_MIRRORABLE_STATUSES.join("/")} orders mirror to the Sheet`,
    };
  }

  const lines: SyncOrderLineInput[] = order.lines.map((line) => ({
    productName: line.product.productName,
    packagingFormat: `${line.product.formatLabel} (${line.product.formatDetail})`,
    productCode: line.product.skuCode,
    qty: line.qty,
    price: line.unitPrice.toNumber(),
    lineTotal: line.lineTotal.toNumber(),
  }));

  // "PO Date" has no dedicated column on `orders` -- it's the date the order
  // was placed/became a real PO, which this order-content model represents
  // as confirmedAt (compliance's two-step-confirmation gate -- see the
  // plan's "non-negotiable compliance gates" -- is what actually makes an
  // order binding) falling back to submittedAt, then createdAt for any order
  // that predates/bypasses that flow (e.g. a rep-app order created directly
  // as `confirmed`).
  const poDateSource = order.confirmedAt ?? order.submittedAt ?? order.createdAt;

  const rep = order.salesRep ?? order.account.salesRep ?? null;

  // "First order for this account" for the Slack message's :tada: variant --
  // computed here because Postgres (not the Sheet) is the account's order
  // history now. Any other order for this account, in any status, counts;
  // this only needs to answer "has this account ordered before," not "how
  // many confirmed orders."
  const priorOrderCount = await db.order.count({
    where: { accountId: order.accountId, id: { not: order.id } },
  });

  const body = buildSyncOrderPayload(
    {
      id: order.id,
      invoiceNumber: order.invoiceNumber,
      paymentMethod: order.paymentMethod,
      inventorySource: order.inventorySource,
      notes: order.notes,
      invoiceStatus: order.invoiceStatus,
      poDate: poDateSource,
    },
    lines,
    {
      businessName: order.account.businessName,
      licenseNumber: order.account.licenseNumber,
      paymentMethod: order.account.paymentMethod,
    },
    rep ? { name: rep.name } : null,
    priorOrderCount === 0,
  );

  const url = process.env.APPS_SCRIPT_URL;
  if (!url) {
    const error = "APPS_SCRIPT_URL is not configured";
    await recordSyncLog(orderId, "error", { error } as Prisma.InputJsonValue);
    return { ok: false, error };
  }

  const payload: SyncOrderPayload = {
    ...body,
    secret: process.env.SYNC_SHARED_SECRET ?? "",
  };

  let parsed: {
    ok: boolean;
    alreadySynced?: boolean;
    rowsAppended?: number;
    lineRows?: number[];
    slackChannel?: string;
    slackTs?: string;
    error?: string;
  };
  try {
    // Server-to-server call (Next.js -> Apps Script), not a browser fetch --
    // unlike the rep app's client-side apiPost (assets/js/app.js), there's no
    // CORS preflight to dodge here, so a normal application/json body is
    // fine (no need for its 'text/plain' CORS-avoidance trick).
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    parsed = await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSyncLog(orderId, "error", { error: message } as Prisma.InputJsonValue);
    return { ok: false, error: message };
  }

  if (!parsed.ok) {
    const error = parsed.error ?? "Apps Script reported failure";
    await recordSyncLog(orderId, "error", { error, request: body } as unknown as Prisma.InputJsonValue);
    return { ok: false, error };
  }

  if (parsed.alreadySynced) {
    // An idempotent no-op replay -- Apps Script found this orderId already
    // present in the Order ID column and didn't append anything new. The
    // original successful append already has its own db_to_sheet SyncLog
    // row, and sync_log's partial unique index (order_id WHERE status =
    // 'success' AND direction = 'db_to_sheet') deliberately allows only ONE
    // such row per order ever -- inserting another here would violate that
    // constraint for no reason, since nothing new actually happened. Still
    // safe (and useful) to refresh sheetSyncedAt.
    await db.order.update({ where: { id: orderId }, data: { sheetSyncedAt: new Date() } });
    return { ok: true, alreadySynced: true };
  }

  // lineRows echoes back the exact Sheet row each line landed on, in the
  // same order the request's `lines` array was sent (order.lines, sorted by
  // lineIndex ascending -- see the query above). Persisting it onto each
  // OrderLine.sheetRowNumber is what lets the Sheet -> DB webhook later
  // target a Lot # edit at the ONE line a given Sheet row represents,
  // instead of applying one row's value to every line of the order (a real
  // correctness gap found in adversarial review for lot/batch traceability).
  const lineUpdates = (parsed.lineRows ?? []).map((sheetRowNumber, i) => {
    const line = order.lines[i];
    if (!line) return null;
    return db.orderLine.update({
      where: { id: line.id },
      data: { sheetRowNumber },
    });
  });

  await db.$transaction([
    db.syncLog.create({
      data: {
        direction: "db_to_sheet",
        orderId,
        status: "success",
        conflict: false,
        fieldsChanged: body as unknown as Prisma.InputJsonValue,
      },
    }),
    db.order.update({ where: { id: orderId }, data: { sheetSyncedAt: new Date() } }),
    ...lineUpdates.filter((u): u is NonNullable<typeof u> => u !== null),
  ]);

  return { ok: true, alreadySynced: false, slackChannel: parsed.slackChannel, slackTs: parsed.slackTs };
}
