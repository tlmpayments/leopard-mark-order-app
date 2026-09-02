/**
 * Stages ③ and ④: proposing and booking a delivery slot.
 *
 * Replaces the hardcoded rep -> region map (the rep app's LM_REP_REGIONS and
 * Code.gs's warehouseForRegion) with `RouteSchedule` rows, so changing a route
 * day is a settings edit rather than a deploy.
 *
 * The slot logic is pure and separated from the database read, because "which
 * Thursday" is exactly the kind of calendar arithmetic that is easy to get
 * subtly wrong and hard to notice: an off-by-one here books a truck for the
 * wrong week.
 */

import { db } from "@/lib/db";
import { appendOrderEvent } from "@/lib/orderEvents";
import { enqueue } from "@/lib/jobs/queue";
import type { OrderEventActor } from "@/app/generated/prisma/enums";

export interface RouteDay {
  region: string;
  warehouseId: string;
  /** 0 = Sunday … 6 = Saturday, matching Date#getDay in Pacific time. */
  weekday: number;
  /** Local PT hour on the PRIOR day by which the order must be confirmed. */
  cutoffHour: number;
}

/** The Pacific-time weekday and hour of an instant. */
export function pacificParts(at: Date): { weekday: number; hour: number; ymd: string } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    weekday: weekdayMap[get("weekday")] ?? 0,
    hour: Number.parseInt(get("hour"), 10) || 0,
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

/**
 * The next route day for a region that this order can still make.
 *
 * A route day is only reachable if we are before its cutoff, which falls on the
 * PRIOR day at `cutoffHour`. So an order confirmed at 15:00 Wednesday, against
 * a Thursday route with a 14:00 prior-day cutoff, has missed Thursday and gets
 * the following route day instead. Pure — takes the route rows and a clock.
 */
export function nextRouteDay(
  routes: readonly RouteDay[],
  now: Date,
  opts: { horizonDays?: number } = {},
): { at: Date; route: RouteDay } | null {
  if (routes.length === 0) return null;
  const horizon = opts.horizonDays ?? 21;
  const nowParts = pacificParts(now);

  let best: { at: Date; route: RouteDay } | null = null;

  for (let offset = 0; offset <= horizon; offset += 1) {
    const candidate = new Date(now.getTime() + offset * 86_400_000);
    const { weekday } = pacificParts(candidate);
    const matches = routes.filter((r) => r.weekday === weekday);
    if (matches.length === 0) continue;

    for (const route of matches) {
      // Cutoff is the prior day at cutoffHour. offset 0 (today) and offset 1
      // (tomorrow, where the cutoff is today) are the only ones that can be
      // missed; anything further out is always still open.
      if (offset === 0) continue; // same-day delivery is never auto-proposed
      if (offset === 1 && nowParts.hour >= route.cutoffHour) continue;

      // Normalise to 09:00 PT on the delivery day -- a proposal is a day plus
      // a window, and the window is set when ops accepts it.
      const at = atPacificHour(candidate, 9);
      if (!best || at < best.at) best = { at, route };
    }
    if (best) break;
  }
  return best;
}

/** Same calendar day as `d` in Pacific time, at the given local hour. */
function atPacificHour(d: Date, hour: number): Date {
  const { ymd } = pacificParts(d);
  // Pacific is UTC-7 (PDT) or UTC-8 (PST). Resolve by probing the offset for
  // this instant rather than assuming, so proposals do not shift by an hour
  // across the DST boundary in March and November.
  const guess = new Date(`${ymd}T${String(hour).padStart(2, "0")}:00:00Z`);
  const offsetMinutes = pacificOffsetMinutes(guess);
  return new Date(guess.getTime() + offsetMinutes * 60_000);
}

function pacificOffsetMinutes(at: Date): number {
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    timeZoneName: "shortOffset",
  })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(local ?? "");
  if (!m) return 480; // fall back to PST
  const hours = Number.parseInt(m[1], 10);
  const mins = Number.parseInt(m[2] ?? "0", 10);
  return -(hours * 60 + Math.sign(hours) * mins);
}

export async function routeDaysForRegion(region: string): Promise<RouteDay[]> {
  const rows = await db.routeSchedule.findMany({
    where: { region, active: true },
    orderBy: { weekday: "asc" },
  });
  return rows.map((r) => ({
    region: r.region,
    warehouseId: r.warehouseId,
    weekday: r.weekday,
    cutoffHour: r.cutoffHour,
  }));
}

/**
 * Book a delivery slot. Creates the planned Shipment if there isn't one, so
 * every scheduled order has a shipment to mark delivered later.
 */
export async function scheduleOrder(opts: {
  orderId: string;
  scheduledFor: Date;
  warehouseId: string;
  carrierName?: string | null;
  actor: OrderEventActor;
  byUserId?: string;
  reschedule?: boolean;
}): Promise<void> {
  await db.$transaction(async (tx) => {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: opts.orderId },
      include: { shipment: true, lines: { include: { product: true } } },
    });

    await tx.order.update({
      where: { id: order.id },
      data: { scheduledFor: opts.scheduledFor, inventorySource: opts.warehouseId, status: "scheduled" },
    });

    if (order.shipment) {
      await tx.shipment.update({
        where: { id: order.shipment.id },
        data: {
          scheduledFor: opts.scheduledFor,
          fromLocationId: opts.warehouseId,
          carrierName: opts.carrierName ?? order.shipment.carrierName,
          status: "planned",
        },
      });
    } else {
      await tx.shipment.create({
        data: {
          status: "planned",
          type: "DELIVERY",
          fromLocationId: opts.warehouseId,
          accountId: order.accountId,
          orderId: order.id,
          scheduledFor: opts.scheduledFor,
          docType: "delivery_receipt",
          carrierName: opts.carrierName ?? null,
          handlingUnits: order.lines.reduce((s, l) => s + l.qty, 0),
        },
      });
    }

    await appendOrderEvent(
      {
        orderId: order.id,
        eventType: opts.reschedule ? "order.rescheduled" : "order.scheduled",
        actor: opts.actor,
        payload: {
          scheduledFor: opts.scheduledFor.toISOString(),
          warehouseId: opts.warehouseId,
          previous: order.scheduledFor?.toISOString() ?? null,
          byUserId: opts.byUserId ?? null,
        },
      },
      tx,
    );
  });

  // The Sheet's Delivery (Invoice) Date is now DB-owned, so mirror it.
  await enqueue("write_delivery_to_sheet", opts.orderId, { orderId: opts.orderId }, { orderId: opts.orderId });
}

/**
 * Propose (but do not book) the next slot. The proposal lives on the order as
 * `scheduledFor` only once a human accepts it; until then it is an
 * `order.slot_proposed` event, which is what puts the order at stage ③.
 */
export async function proposeSlot(orderId: string): Promise<{ at: Date; warehouseId: string } | null> {
  const order = await db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { account: { select: { region: true, deliveryWindow: true } } },
  });
  if (!order.account.region) return null;

  const routes = await routeDaysForRegion(order.account.region);
  const next = nextRouteDay(routes, new Date());
  if (!next) return null;

  await appendOrderEvent({
    orderId,
    eventType: "order.slot_proposed",
    actor: "system",
    payload: {
      proposedFor: next.at.toISOString(),
      warehouseId: next.route.warehouseId,
      region: next.route.region,
      accountWindow: order.account.deliveryWindow ?? null,
    },
  });

  return { at: next.at, warehouseId: next.route.warehouseId };
}

/**
 * The proposal an order is currently sitting on, if any. Read from the event
 * log rather than a column: a proposal is a thing the system said, and the
 * event log is where things the system said live.
 */
export async function currentProposal(orderId: string): Promise<{ at: Date; warehouseId: string } | null> {
  const ev = await db.orderEvent.findFirst({
    where: { orderId, eventType: "order.slot_proposed" },
    orderBy: { createdAt: "desc" },
  });
  if (!ev) return null;
  const p = ev.payloadJson as { proposedFor?: string; warehouseId?: string };
  if (!p?.proposedFor) return null;
  return { at: new Date(p.proposedFor), warehouseId: p.warehouseId ?? "" };
}
