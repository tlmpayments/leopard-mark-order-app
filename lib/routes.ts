/**
 * Dispatch: building a day's route and putting it on the road.
 *
 * Scheduling (lib/scheduling.ts) answers "what day does this order go out".
 * That is not the question the driver has at 6am, which is "which stops, in
 * what order, out of which warehouse, and where is the paperwork". A
 * DeliveryRoute answers that one.
 *
 * Two rules shape everything here:
 *
 *   1. A route is a PLAN, and plans get rebuilt. Adding, removing and
 *      re-sequencing stops must never touch the inventory ledger. Only
 *      dispatch and delivery do that.
 *
 *   2. Dispatch is the moment the paperwork becomes real. The BOL number is
 *      minted here rather than at delivery, so the document the driver hands
 *      the retailer carries the same number the ledger will. The cost is a gap
 *      in the sequence when a stop fails -- accepted deliberately, because the
 *      alternative is the customer's copy and our copy disagreeing about what
 *      the delivery was called.
 */

import { Prisma } from "@/app/generated/prisma/client";
import { db } from "@/lib/db";
import { mintBolNumber } from "@/lib/bol/sequence";
import { appendOrderEvent } from "@/lib/orderEvents";
import { enqueue } from "@/lib/jobs/queue";
import { atPacificHour, pacificDayRange, pacificParts, scheduleOrder } from "@/lib/scheduling";
import { deliveryRegionFor } from "@/lib/deliveryRegion";
import type { OrderEventActor, RouteStatus } from "@/app/generated/prisma/enums";

/** Today in Pacific time, as YYYY-MM-DD. The route day is a PT calendar day. */
export function todayYmd(now: Date = new Date()): string {
  return pacificParts(now).ymd;
}

/**
 * `DeliveryRoute.date` is a bare DATE column, which Prisma reads back as UTC
 * midnight. Both directions go through these two so nothing ever compares a
 * DATE against a timestamp and loses a day at the boundary.
 */
export function routeDateValue(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

export function ymdOfRoute(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const ROUTE_INCLUDE = {
  warehouse: { select: { id: true, name: true, city: true, state: true, address: true } },
  driver: { select: { id: true, name: true, phone: true } },
  stops: {
    orderBy: { sequence: "asc" },
    include: {
      order: {
        include: {
          account: {
            select: {
              id: true,
              businessName: true,
              legalEntity: true,
              region: true,
              address: true,
              deliveryAddress: true,
              deliveryInstructions: true,
              deliveryWindow: true,
              licenseNumber: true,
              paymentMethod: true,
              terms: true,
              lat: true,
              lng: true,
            },
          },
          contact: { select: { name: true, phoneE164: true } },
          shipment: true,
          lines: {
            orderBy: { lineIndex: "asc" },
            include: {
              product: {
                select: {
                  id: true,
                  skuCode: true,
                  productName: true,
                  formatLabel: true,
                  formatDetail: true,
                  packageType: true,
                  isKeg: true,
                  weightPerUnit: true,
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export type RouteWithStops = Prisma.DeliveryRouteGetPayload<{ include: typeof ROUTE_INCLUDE }>;
export type RouteStopDetail = RouteWithStops["stops"][number];

export async function loadRoute(routeId: string): Promise<RouteWithStops | null> {
  return db.deliveryRoute.findUnique({ where: { id: routeId }, include: ROUTE_INCLUDE });
}

export async function routesForDay(ymd: string): Promise<RouteWithStops[]> {
  return db.deliveryRoute.findMany({
    where: { date: routeDateValue(ymd) },
    include: ROUTE_INCLUDE,
    orderBy: [{ region: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * The routes a driver should see. Scoped to their own id -- a driver holding a
 * session is not a licence to read every account's delivery address.
 *
 * Today's routes, plus any route still in progress whatever day it started. A
 * run that goes past midnight, or one abandoned on Friday and finished on
 * Monday, must not vanish from the phone of the person holding the stock.
 * Draft routes are never included: an undispatched route is a plan someone is
 * still editing.
 */
export async function routesForDriver(driverId: string, ymd: string): Promise<RouteWithStops[]> {
  return db.deliveryRoute.findMany({
    where: {
      driverId,
      OR: [
        { date: routeDateValue(ymd), status: { in: ["dispatched", "in_progress", "completed"] } },
        { status: "in_progress" },
      ],
    },
    include: ROUTE_INCLUDE,
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * Every route on the road for a day, whoever is driving. What ops sees when
 * they open the driver surface to check on the day, or to complete a stop for a
 * driver who has called it in.
 */
export async function dispatchedRoutesForDay(ymd: string): Promise<RouteWithStops[]> {
  return db.deliveryRoute.findMany({
    where: {
      OR: [
        { date: routeDateValue(ymd), status: { in: ["dispatched", "in_progress", "completed"] } },
        { status: "in_progress" },
      ],
    },
    include: ROUTE_INCLUDE,
    orderBy: [{ date: "asc" }, { region: "asc" }, { createdAt: "asc" }],
  });
}

export async function createRoute(opts: {
  ymd: string;
  region: string;
  warehouseId: string;
  driverId?: string | null;
  name?: string | null;
}): Promise<RouteWithStops> {
  const route = await db.deliveryRoute.create({
    data: {
      date: routeDateValue(opts.ymd),
      region: opts.region,
      warehouseId: opts.warehouseId,
      driverId: opts.driverId ?? null,
      name: opts.name?.trim() || null,
    },
  });
  return (await loadRoute(route.id))!;
}

/**
 * Orders that could go on a route for this day but are not on one yet.
 *
 * Two groups on purpose: orders already scheduled for the day (the obvious
 * candidates) and orders that are confirmed but unscheduled (the ones an
 * operator is deciding to squeeze in). Anything delivered, cancelled or
 * already assigned to a route is excluded.
 */
export async function candidateOrdersForDay(ymd: string, region?: string | null) {
  const { start, end } = pacificDayRange(ymd);
  const deliveryRegion = region ? deliveryRegionFor(region) : null;

  const orders = await db.order.findMany({
    where: {
      deliveredAt: null,
      routeStop: { is: null },
      status: { notIn: ["cancelled", "rejected", "expired", "draft"] },
      OR: [{ scheduledFor: { gte: start, lt: end } }, { scheduledFor: null }],
    },
    include: {
      account: { select: { id: true, businessName: true, region: true, deliveryAddress: true, address: true } },
      lines: { include: { product: { select: { productName: true, formatLabel: true, isKeg: true } } } },
      shipment: { select: { fromLocationId: true } },
    },
    orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
    take: 200,
  });

  // Filter on the DELIVERY region ("BA"), not the account's city, so a route
  // built for the Bay Area offers San Rafael and Oakland too rather than only
  // the exact string the account happens to carry.
  if (!deliveryRegion) return orders;
  return orders.filter((o) => deliveryRegionFor(o.account.region) === deliveryRegion);
}

export async function addStopToRoute(
  routeId: string,
  orderId: string,
  opts: { byUserId?: string; actor?: OrderEventActor } = {},
): Promise<void> {
  const route = await db.deliveryRoute.findUniqueOrThrow({ where: { id: routeId } });
  assertRouteOpen(route.status);

  const existing = await db.routeStop.findUnique({
    where: { orderId },
    include: { route: { select: { id: true, date: true, name: true, region: true } } },
  });
  if (existing) {
    throw new Error(
      existing.routeId === routeId
        ? "That order is already a stop on this route."
        : `That order is already stop ${existing.sequence} on the ${existing.route.region} route for ${ymdOfRoute(existing.route.date)}.`,
    );
  }

  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, scheduledFor: true, inventorySource: true, deliveredAt: true },
  });
  if (order.deliveredAt) throw new Error("That order has already been delivered.");

  // Putting an order on Thursday's SF route IS scheduling it for Thursday out
  // of WH-SF. Doing it here rather than making the operator do it twice is what
  // keeps Order.scheduledFor -- which the whole seven-stage pipeline derives
  // from -- agreeing with the route the truck is actually running.
  const ymd = ymdOfRoute(route.date);
  const { start, end } = pacificDayRange(ymd);
  const alreadyOnDay = order.scheduledFor != null && order.scheduledFor >= start && order.scheduledFor < end;

  if (!alreadyOnDay || order.inventorySource !== route.warehouseId) {
    await scheduleOrder({
      orderId,
      scheduledFor: alreadyOnDay && order.scheduledFor ? order.scheduledFor : atPacificHour(start, 9),
      warehouseId: route.warehouseId,
      actor: opts.actor ?? "ops",
      byUserId: opts.byUserId,
      reschedule: order.scheduledFor != null,
    });
  }

  const stop = await db.$transaction(async (tx) => {
    const max = await tx.routeStop.aggregate({ where: { routeId }, _max: { sequence: true } });
    return tx.routeStop.create({
      data: { routeId, orderId, sequence: (max._max.sequence ?? 0) + 1 },
    });
  });

  await appendOrderEvent({
    orderId,
    eventType: "route.stop_added",
    actor: opts.actor ?? "ops",
    payload: { routeId, sequence: stop.sequence, routeDate: ymd, byUserId: opts.byUserId ?? null },
  });

  // A route already on the road can still take a stop, but that stop needs its
  // paperwork immediately -- dispatch has been and gone.
  if (route.status === "dispatched" || route.status === "in_progress") {
    await mintStopPaperwork(stop.id, opts.byUserId ?? null);
  }
}

export async function removeStopFromRoute(
  stopId: string,
  opts: { byUserId?: string; actor?: OrderEventActor } = {},
): Promise<void> {
  const stop = await db.routeStop.findUniqueOrThrow({
    where: { id: stopId },
    include: { route: { select: { id: true, status: true, date: true } } },
  });
  if (stop.status === "delivered") {
    throw new Error("That stop has been delivered. Remove it from the route and the ledger still says it happened.");
  }
  assertRouteOpen(stop.route.status);

  await db.$transaction(async (tx) => {
    await tx.routeStop.delete({ where: { id: stopId } });
    // Close the hole so the driver never sees "1, 2, 4".
    const rest = await tx.routeStop.findMany({
      where: { routeId: stop.routeId },
      orderBy: { sequence: "asc" },
      select: { id: true },
    });
    await resequence(tx, rest.map((s) => s.id));
  });

  await appendOrderEvent({
    orderId: stop.orderId,
    eventType: "route.stop_removed",
    actor: opts.actor ?? "ops",
    payload: { routeId: stop.routeId, byUserId: opts.byUserId ?? null },
  });
}

/**
 * Rewrite the whole run in the given order.
 *
 * Two passes through a negative holding range, because `@@unique([routeId,
 * sequence])` would reject a straight swap the moment two stops briefly share
 * a position. Negatives can never collide with the positives already there.
 */
export async function reorderRouteStops(routeId: string, orderedStopIds: string[]): Promise<void> {
  const stops = await db.routeStop.findMany({ where: { routeId }, select: { id: true } });
  const known = new Set(stops.map((s) => s.id));
  const ordered = orderedStopIds.filter((id) => known.has(id));
  if (ordered.length !== stops.length) {
    throw new Error("Reorder must list every stop on the route exactly once.");
  }
  await db.$transaction((tx) => resequence(tx, ordered));
}

/** Move one stop up or down by a position. The list view's arrows. */
export async function moveStop(stopId: string, direction: "up" | "down"): Promise<void> {
  const stop = await db.routeStop.findUniqueOrThrow({ where: { id: stopId } });
  const stops = await db.routeStop.findMany({
    where: { routeId: stop.routeId },
    orderBy: { sequence: "asc" },
    select: { id: true },
  });
  const i = stops.findIndex((s) => s.id === stopId);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= stops.length) return; // already at the end of the run

  const ids = stops.map((s) => s.id);
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await db.$transaction((tx) => resequence(tx, ids));
}

async function resequence(tx: Prisma.TransactionClient, orderedIds: string[]): Promise<void> {
  for (let i = 0; i < orderedIds.length; i += 1) {
    await tx.routeStop.update({ where: { id: orderedIds[i] }, data: { sequence: -(i + 1) } });
  }
  for (let i = 0; i < orderedIds.length; i += 1) {
    await tx.routeStop.update({ where: { id: orderedIds[i] }, data: { sequence: i + 1 } });
  }
}

export async function assignDriver(routeId: string, driverId: string | null): Promise<void> {
  await db.deliveryRoute.update({ where: { id: routeId }, data: { driverId } });
}

export async function updateRouteMeta(
  routeId: string,
  data: { name?: string | null; notes?: string | null; warehouseId?: string },
): Promise<void> {
  await db.deliveryRoute.update({ where: { id: routeId }, data });
}

export interface DispatchResult {
  routeId: string;
  stopCount: number;
  bolNumbers: string[];
  alreadyDispatched: boolean;
}

/**
 * Put the route on the road.
 *
 * One transaction: every stop gets a shipment if it lacks one, a real BOL
 * number if it lacks one, and `in_transit` status; the route flips to
 * dispatched. Idempotent -- dispatching twice does not mint a second set of
 * numbers, because the whole point of minting here is that the number on the
 * paper and the number in the ledger are the same one.
 */
export async function dispatchRoute(routeId: string, byUserId: string): Promise<DispatchResult> {
  const result = await db.$transaction(
    async (tx) => {
      const route = await tx.deliveryRoute.findUniqueOrThrow({
        where: { id: routeId },
        include: { stops: { orderBy: { sequence: "asc" } } },
      });

      if (route.status === "cancelled") throw new Error("That route was cancelled.");
      if (route.status !== "draft") {
        const shipments = await tx.shipment.findMany({
          where: { orderId: { in: route.stops.map((s) => s.orderId) } },
          select: { bolNumber: true },
        });
        return {
          routeId,
          stopCount: route.stops.length,
          bolNumbers: shipments.map((s) => s.bolNumber).filter((b): b is string => Boolean(b)),
          alreadyDispatched: true as const,
        };
      }
      if (!route.driverId) throw new Error("Assign a driver before dispatching.");
      if (route.stops.length === 0) throw new Error("A route with no stops has nothing to dispatch.");

      const dispatchedAt = new Date();
      const bolNumbers: string[] = [];

      for (const stop of route.stops) {
        const number = await mintForOrder(tx, stop.orderId, route.warehouseId, dispatchedAt, byUserId);
        bolNumbers.push(number);
      }

      await tx.deliveryRoute.update({
        where: { id: routeId },
        data: { status: "dispatched", dispatchedAt, dispatchedByUserId: byUserId },
      });

      return { routeId, stopCount: route.stops.length, bolNumbers, alreadyDispatched: false as const };
    },
    // Each stop takes the BOL sequence row lock in turn; a ten-stop route needs
    // room to wait for all ten.
    { timeout: 30_000 },
  );

  if (!result.alreadyDispatched) {
    // Outside the transaction, same reason markDelivered enqueues outside its
    // own: a Sheet outage must not roll back a dispatch that physically
    // happened. The Sheet's BOL # column now has a value to receive.
    const stops = await db.routeStop.findMany({ where: { routeId }, select: { orderId: true } });
    for (const s of stops) {
      await enqueue("write_delivery_to_sheet", s.orderId, { orderId: s.orderId }, { orderId: s.orderId });
    }
  }

  return result;
}

/**
 * Pin a BOL number that was issued outside this system.
 *
 * Paperwork sometimes exists before the order does -- a batch printed by hand
 * or by the old BOL Maker, already signed and already in a driver's stack. When
 * that happens the choice is between reprinting it and honouring it, and
 * honouring it is usually right: the number on the customer's copy is the one
 * they will quote back over the phone.
 *
 * `mintForOrder` already returns early when a shipment carries a number, so
 * setting one here is all that is needed for dispatch to leave it alone. This
 * exists so that setting it is a deliberate, validated, logged act rather than
 * a hand-written UPDATE.
 *
 * The cost, stated plainly: these numbers sit outside `BolSequence`, so the
 * per-location sequence has a hole where they should have been. That is the
 * price of not reprinting, and it is why the event records where the number
 * came from.
 */
export async function setExternalBolNumber(
  orderId: string,
  bolNumber: string,
  opts: { byUserId?: string; warehouseId?: string; note?: string } = {},
): Promise<void> {
  const number = bolNumber.trim();
  if (!number) throw new Error("A BOL number is required.");

  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { shipment: true, lines: { include: { product: true } } },
  });
  if (order.deliveredAt) {
    throw new Error("That order is already delivered; its BOL number is part of the record.");
  }
  if (order.shipment?.bolNumber && order.shipment.bolNumber !== number) {
    throw new Error(
      `That order already carries ${order.shipment.bolNumber}. Clear it deliberately before assigning another.`,
    );
  }

  const clash = await db.shipment.findFirst({
    where: { bolNumber: number, orderId: { not: orderId } },
    select: { orderId: true },
  });
  if (clash) throw new Error(`${number} is already on another shipment.`);

  const fromLocationId = opts.warehouseId ?? order.inventorySource;
  if (!fromLocationId) throw new Error("No warehouse for this order; schedule it first.");

  if (order.shipment) {
    await db.shipment.update({
      where: { id: order.shipment.id },
      data: { bolNumber: number, fromLocationId },
    });
  } else {
    await db.shipment.create({
      data: {
        status: "planned",
        type: "DELIVERY",
        fromLocationId,
        accountId: order.accountId,
        orderId: order.id,
        scheduledFor: order.scheduledFor,
        bolNumber: number,
        docType: "delivery_receipt",
        handlingUnits: order.lines.reduce((n, l) => n + l.qty, 0),
        weightLbs: computeWeight(order.lines),
      },
    });
  }
  await db.order.update({ where: { id: order.id }, data: { bolNumber: number } });

  await appendOrderEvent({
    orderId,
    eventType: "bol.issued",
    actor: "ops",
    payload: {
      bolNumber: number,
      fromLocationId,
      // The thing a later reader needs: this number did NOT come from our
      // counter, so do not go looking for it in BolSequence.
      at: "external",
      note: opts.note ?? null,
      byUserId: opts.byUserId ?? null,
    },
  });
}

/** Mint the paperwork for a single stop added to an already-dispatched route. */
export async function mintStopPaperwork(stopId: string, byUserId: string | null): Promise<string> {
  const stop = await db.routeStop.findUniqueOrThrow({
    where: { id: stopId },
    include: { route: { select: { warehouseId: true } } },
  });
  const number = await db.$transaction((tx) =>
    mintForOrder(tx, stop.orderId, stop.route.warehouseId, new Date(), byUserId ?? undefined),
  );
  await enqueue("write_delivery_to_sheet", stop.orderId, { orderId: stop.orderId }, { orderId: stop.orderId });
  return number;
}

/**
 * Ensure one order has a shipment carrying a real BOL number, and return it.
 *
 * Re-entrant by design: an order that already has a number keeps it. That is
 * what makes dispatch safe to retry and what stops a re-dispatch from putting a
 * second number on a delivery whose paperwork is already printed.
 */
async function mintForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  warehouseId: string,
  at: Date,
  byUserId?: string,
): Promise<string> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { shipment: true, lines: { include: { product: true } } },
  });

  // Already numbered -- either a re-dispatch, or a number pinned by
  // setExternalBolNumber. Keep the number, but still put the shipment on the
  // truck: dispatch's other job is saying the stock has left, and returning
  // early here used to leave such a stop `planned` forever while every other
  // stop on the same route went `in_transit`.
  if (order.shipment?.bolNumber) {
    if (order.shipment.status === "planned") {
      await tx.shipment.update({
        where: { id: order.shipment.id },
        data: { status: "in_transit" },
      });
    }
    return order.shipment.bolNumber;
  }

  const fromLocationId = order.shipment?.fromLocationId ?? order.inventorySource ?? warehouseId;
  const bolNumber = await mintBolNumber(tx, fromLocationId, at);

  if (order.shipment) {
    await tx.shipment.update({
      where: { id: order.shipment.id },
      data: { bolNumber, status: "in_transit", fromLocationId },
    });
  } else {
    await tx.shipment.create({
      data: {
        status: "in_transit",
        type: "DELIVERY",
        fromLocationId,
        accountId: order.accountId,
        orderId: order.id,
        scheduledFor: order.scheduledFor,
        bolNumber,
        docType: "delivery_receipt",
        handlingUnits: order.lines.reduce((s, l) => s + l.qty, 0),
        weightLbs: computeWeight(order.lines),
      },
    });
  }

  await tx.order.update({ where: { id: order.id }, data: { bolNumber } });

  await appendOrderEvent(
    {
      orderId,
      eventType: "bol.issued",
      actor: "ops",
      payload: { bolNumber, fromLocationId, at: "dispatch", byUserId: byUserId ?? null },
    },
    tx,
  );
  await appendOrderEvent(
    {
      orderId,
      eventType: "route.dispatched",
      actor: "ops",
      payload: { bolNumber, warehouseId: fromLocationId, byUserId: byUserId ?? null },
    },
    tx,
  );

  return bolNumber;
}

/** Total shipment weight from each SKU's weightPerUnit. Mirrors lib/delivery.ts. */
function computeWeight(
  lines: Array<{ qty: number; product: { weightPerUnit: Prisma.Decimal | null } }>,
): Prisma.Decimal | null {
  const known = lines.filter((l) => l.product.weightPerUnit != null);
  if (known.length === 0) return null;
  return known.reduce(
    (sum, l) => sum.add(new Prisma.Decimal(l.qty).mul(l.product.weightPerUnit!)),
    new Prisma.Decimal(0),
  );
}

/**
 * A stop the driver could not complete.
 *
 * Records the attempt and leaves the order scheduled, unblocked and un-invoiced
 * -- nothing about a failed attempt should look like a delivery. The BOL number
 * minted at dispatch stays on the shipment: it was printed, it exists, and
 * reusing it when the stop runs again tomorrow is more honest than voiding it.
 */
export async function failStop(
  stopId: string,
  reason: string,
  opts: { byUserId?: string; actor?: OrderEventActor; notes?: string | null } = {},
): Promise<void> {
  const stop = await db.routeStop.findUniqueOrThrow({ where: { id: stopId } });
  if (stop.status === "delivered") throw new Error("That stop is already delivered.");

  await db.routeStop.update({
    where: { id: stopId },
    data: {
      status: "failed",
      failureReason: reason,
      notes: opts.notes ?? stop.notes,
      completedAt: new Date(),
    },
  });
  await appendOrderEvent({
    orderId: stop.orderId,
    eventType: "route.stop_failed",
    actor: opts.actor ?? "ops",
    payload: { routeId: stop.routeId, reason, notes: opts.notes ?? null, byUserId: opts.byUserId ?? null },
  });
  await settleRouteStatus(stop.routeId);
}

/** The driver has started their day. */
export async function startRoute(routeId: string): Promise<void> {
  await db.deliveryRoute.updateMany({
    where: { id: routeId, status: "dispatched" },
    data: { status: "in_progress", startedAt: new Date() },
  });
}

/**
 * Flip the route to in_progress on the first completed stop and to completed
 * when none are left pending. Derived from the stops rather than asked of the
 * driver, because a status a human has to remember to set is a status that
 * is wrong by Thursday.
 */
export async function settleRouteStatus(routeId: string): Promise<void> {
  const stops = await db.routeStop.findMany({ where: { routeId }, select: { status: true } });
  if (stops.length === 0) return;
  const anyDone = stops.some((s) => s.status !== "pending");
  const allDone = stops.every((s) => s.status !== "pending");

  const next: RouteStatus | null = allDone ? "completed" : anyDone ? "in_progress" : null;
  if (!next) return;

  const now = new Date();

  // A driver who just starts delivering without tapping "Start route" has still
  // started; stamp it from the first completed stop. Scoped to `dispatched` so
  // it is written once and a later stop cannot push the start time forward.
  await db.deliveryRoute.updateMany({
    where: { id: routeId, status: "dispatched", startedAt: null },
    data: { startedAt: now },
  });

  await db.deliveryRoute.updateMany({
    where: { id: routeId, status: { in: ["dispatched", "in_progress"] } },
    data: { status: next, ...(next === "completed" ? { completedAt: now } : {}) },
  });
}

export async function cancelRoute(routeId: string): Promise<void> {
  const stops = await db.routeStop.findMany({ where: { routeId }, select: { status: true } });
  if (stops.some((s) => s.status === "delivered")) {
    throw new Error("Some stops on this route have been delivered; it cannot be cancelled.");
  }
  await db.deliveryRoute.update({ where: { id: routeId }, data: { status: "cancelled" } });
}

function assertRouteOpen(status: RouteStatus): void {
  if (status === "completed") throw new Error("That route is finished.");
  if (status === "cancelled") throw new Error("That route was cancelled.");
}

/** Handling units and keg count for a route, for the dispatch summary. */
export function routeTotals(route: RouteWithStops): { units: number; kegs: number; stops: number } {
  let units = 0;
  let kegs = 0;
  for (const stop of route.stops) {
    for (const line of stop.order.lines) {
      units += line.qty;
      if (line.product.isKeg) kegs += line.qty;
    }
  }
  return { units, kegs, stops: route.stops.length };
}
