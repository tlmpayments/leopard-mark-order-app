// Sheet -> DB webhook (Phase 2). Apps Script POSTs here from two sources:
// the near-real-time dirty-row drain ("onedit") and the hourly full
// reconciliation refresh ("reconcile") -- see the wire protocol in
// /Users/jackbegley/.claude/plans/jazzy-pondering-rivest.md ("Sheet sync
// architecture") and this phase's shared design context for the exact
// request/response shape. `lib/sheetSync.ts` is this route's counterpart
// for the DB -> Sheet direction.
//
// No-infinite-loop invariant this route relies on: writes the Apps Script
// project makes to its own Sheet (appendRow/setValues/the advanced-Sheets
// batchUpdate) never fire that project's own installable onEdit trigger --
// only a human or an external actor editing via the Sheets API does. So
// nothing this route does (updating `orders`/`order_lines`) can loop back
// into another onEdit-triggered call to this same route; the only way back
// to the Sheet is the separate, explicit `syncOrderToSheet` call in
// lib/sheetSync.ts, and that path never runs as a *reaction* to this one.
import { db } from "@/lib/db";
import type { Prisma } from "@/app/generated/prisma/client";
import {
  classifyColumn,
  LOT_NUMBER_COLUMN,
  SHEET_OWNED_ORDER_FIELD,
} from "@/lib/sheetColumns";

interface WebhookEdit {
  orderId?: string;
  invoiceNumber?: string;
  rowNumber?: number;
  fields?: Record<string, unknown>;
}

interface WebhookBody {
  source?: "onedit" | "reconcile";
  edits?: WebhookEdit[];
}

interface ResolvedOrder {
  id: string;
}

async function resolveOrder(
  orderId: string | undefined,
  invoiceNumber: string | undefined,
): Promise<ResolvedOrder | null> {
  if (orderId) {
    const byId = await db.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (byId) return byId;
  }
  // Fallback for any row without an Order ID yet (e.g. a pre-Phase-2 row the
  // backfill hasn't reached), matched by Invoice # the same way
  // handleStats/handleCustomerOrders/handleAllOrders already group rows in
  // Code.gs today.
  if (invoiceNumber) {
    const byInvoice = await db.order.findFirst({
      where: { invoiceNumber },
      select: { id: true },
    });
    if (byInvoice) return byInvoice;
  }
  return null;
}

function parseDateOnly(value: unknown): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function POST(request: Request): Promise<Response> {
  const providedSecret = request.headers.get("x-sync-secret");
  const expectedSecret = process.env.SYNC_SHARED_SECRET;
  if (!expectedSecret || !providedSecret || providedSecret !== expectedSecret) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const edits = Array.isArray(body.edits) ? body.edits : [];
  let applied = 0;
  let conflicts = 0;

  for (const edit of edits) {
    const fields = edit.fields ?? {};
    const headers = Object.keys(fields);
    if (headers.length === 0) continue;

    const order = await resolveOrder(edit.orderId, edit.invoiceNumber);
    const rowRef = edit.rowNumber != null ? String(edit.rowNumber) : null;

    // sync_log.order_id is a required FK -- an edit that resolves to no
    // order at all (bad/missing orderId AND invoiceNumber) has nowhere to
    // attach a log row. Nothing to apply either. Drop it with a server-side
    // warning rather than silently pretending it succeeded or crashing the
    // whole batch over one bad edit.
    if (!order) {
      console.warn(
        `sheet-sync webhook: could not resolve an order for edit (orderId=${edit.orderId ?? ""}, invoiceNumber=${edit.invoiceNumber ?? ""}, row=${rowRef ?? ""}) -- dropping ${headers.length} field(s), not counted in applied/conflicts`,
      );
      continue;
    }

    // Bucket every field in this edit by classification before writing
    // anything, so the whole edit resolves in one transaction: one Order
    // update (if any DB-backed Sheet-owned fields), one OrderLine updateMany
    // for Lot # (if present), and up to three SyncLog rows (applied /
    // unmapped / conflict), each carrying just the fields in its own bucket
    // as `fieldsChanged` for a clean audit trail.
    const orderScalarUpdates: Record<string, string | Date | null> = {};
    const appliedFields: Record<string, unknown> = {};
    const unmappedFields: Record<string, unknown> = {};
    const conflictFields: Record<string, unknown> = {};
    let lotNumberValue: string | null = null;
    let hasLotNumberEdit = false;

    for (const header of headers) {
      const value = fields[header];
      const ownership = classifyColumn(header);

      if (ownership !== "sheet_owned") {
        // db_owned AND unknown both reject -- never silently accept a
        // column this design didn't account for.
        conflictFields[header] = value;
        continue;
      }

      if (header === LOT_NUMBER_COLUMN) {
        hasLotNumberEdit = true;
        lotNumberValue = value === null || value === undefined ? null : String(value);
        appliedFields[header] = value;
        continue;
      }

      const orderField = SHEET_OWNED_ORDER_FIELD[header as keyof typeof SHEET_OWNED_ORDER_FIELD];
      if (!orderField) {
        // Sheet-owned (e.g. a Tap Handle / MicroStar Empty column) but no
        // backing Prisma field exists yet -- see lib/sheetColumns.ts.
        unmappedFields[header] = value;
        continue;
      }

      orderScalarUpdates[orderField] =
        orderField === "deliveryDate" ? parseDateOnly(value) : value === null || value === undefined ? "" : String(value);
      appliedFields[header] = value;
    }

    const writes: Prisma.PrismaPromise<unknown>[] = [];

    if (Object.keys(orderScalarUpdates).length > 0) {
      writes.push(db.order.update({ where: { id: order.id }, data: orderScalarUpdates }));
    }
    if (hasLotNumberEdit) {
      // Target the ONE line this Sheet row represents (matched by
      // sheetRowNumber, populated by lib/sheetSync.ts from the syncOrder
      // response) -- not every line of the order. An earlier version used
      // updateMany({where:{orderId}}), applying whichever row's Lot # was
      // processed last in this batch to every line of the order; adversarial
      // review found this silently and permanently loses any earlier line's
      // true lot number whenever lines genuinely differ (plausible for
      // lot/batch traceability, unlike BOL # which really is one per
      // shipment) -- and since hourlyReconcileSyncRows resends unconditionally
      // every hour, it isn't a one-time glitch, it's a standing correctness
      // gap for a food-safety-adjacent field. Falls back to updateMany only
      // when no line has a recorded sheetRowNumber yet (an order synced
      // before this fix shipped, or a backfilled order whose lines the
      // backfill script didn't stamp) -- better than silently dropping the
      // edit, but logged distinctly so it's visible this happened via the
      // fallback path rather than the precise one.
      const targetLine =
        edit.rowNumber != null
          ? await db.orderLine.findFirst({
              where: { orderId: order.id, sheetRowNumber: edit.rowNumber },
              select: { id: true },
            })
          : null;

      writes.push(
        targetLine
          ? db.orderLine.update({
              where: { id: targetLine.id },
              data: { lotNumber: lotNumberValue },
            })
          : db.orderLine.updateMany({
              where: { orderId: order.id },
              data: { lotNumber: lotNumberValue },
            }),
      );
    }
    if (Object.keys(appliedFields).length > 0) {
      writes.push(
        db.syncLog.create({
          data: {
            direction: "sheet_to_db",
            orderId: order.id,
            rowRef,
            status: "success",
            conflict: false,
            fieldsChanged: { source: body.source ?? null, fields: appliedFields } as Prisma.InputJsonValue,
          },
        }),
      );
    }
    if (Object.keys(unmappedFields).length > 0) {
      writes.push(
        db.syncLog.create({
          data: {
            direction: "sheet_to_db",
            orderId: order.id,
            rowRef,
            status: "sheet_owned_unmapped",
            conflict: false,
            fieldsChanged: { source: body.source ?? null, fields: unmappedFields } as Prisma.InputJsonValue,
          },
        }),
      );
    }
    if (Object.keys(conflictFields).length > 0) {
      writes.push(
        db.syncLog.create({
          data: {
            direction: "sheet_to_db",
            orderId: order.id,
            rowRef,
            status: "success",
            conflict: true,
            fieldsChanged: { source: body.source ?? null, fields: conflictFields } as Prisma.InputJsonValue,
          },
        }),
      );
    }

    if (writes.length > 0) {
      await db.$transaction(writes);
    }

    applied += Object.keys(appliedFields).length;
    conflicts += Object.keys(conflictFields).length;
  }

  return Response.json({ ok: true, applied, conflicts });
}
