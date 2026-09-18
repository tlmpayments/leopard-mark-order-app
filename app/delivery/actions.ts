"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireDeliveryUser } from "@/lib/ops/session";
import { markDelivered, parseDeliveredLines } from "@/lib/delivery";
import { failStop, settleRouteStatus, startRoute } from "@/lib/routes";
import { kickJobs } from "@/lib/jobs/kick";
import type { OpsUser } from "@/lib/ops/session";

/**
 * What the driver can do.
 *
 * The gate here is ownership, not role. A driver session is authority over the
 * stops on routes assigned to that driver and nothing else -- which is a
 * narrower and more useful claim than "may write the ledger", and is why
 * `driver` is deliberately absent from LEDGER_ROLES. Ops and admin pass the
 * same check by being unscoped, so they can complete a stop on the driver's
 * behalf when he calls it in from the road.
 */
async function stopForUser(stopId: string) {
  const user = await requireDeliveryUser();
  const stop = await db.routeStop.findUnique({
    where: { id: stopId },
    include: { route: { select: { id: true, driverId: true, status: true } } },
  });
  if (!stop) throw new Error("That stop no longer exists.");
  assertOwnsRoute(user, stop.route.driverId);
  if (stop.route.status === "draft") {
    throw new Error("That route has not been dispatched yet.");
  }
  if (stop.route.status === "cancelled") throw new Error("That route was cancelled.");
  return { user, stop };
}

function assertOwnsRoute(user: OpsUser, driverId: string | null): void {
  if (user.role !== "driver") return; // ops/warehouse/admin cover for the driver
  if (driverId !== user.id) throw new Error("That route is not assigned to you.");
}

export async function startRouteAction(formData: FormData): Promise<void> {
  const user = await requireDeliveryUser();
  const routeId = String(formData.get("routeId"));
  const route = await db.deliveryRoute.findUniqueOrThrow({
    where: { id: routeId },
    select: { driverId: true },
  });
  assertOwnsRoute(user, route.driverId);
  await startRoute(routeId);
  revalidatePath("/delivery");
}

/**
 * Proof of delivery.
 *
 * Calls the same `markDelivered` the hub does -- one transaction that writes
 * the inventory events, moves keg custody, stamps deliveredAt (which is what
 * the Net-30 due date counts from) and enqueues the invoice. The stop row is
 * updated AFTER it returns, deliberately: if that second write fails, the
 * delivery still happened and the ledger says so, which is recoverable. The
 * reverse order would give us a stop marked delivered with no ledger behind it.
 */
export async function completeStopAction(formData: FormData): Promise<void> {
  const { user, stop } = await stopForUser(String(formData.get("stopId")));

  const { lines, emptiesByProductId } = parseDeliveredLines(formData);
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (stop.orderId) await markDelivered({
    orderId: stop.orderId,
    deliveredByUserId: user.id,
    actor: "ops",
    lines,
    emptiesByProductId,
    notes,
  });

  await db.routeStop.update({
    where: { id: stop.id },
    data: { status: "delivered", completedAt: new Date(), notes },
  });
  await settleRouteStatus(stop.routeId);

  // Drain now rather than waiting for the daily cron: the invoice this just
  // enqueued is the point of marking it delivered.
  kickJobs();

  revalidatePath("/delivery");
  revalidatePath(`/delivery/stops/${stop.id}`);
  revalidatePath(`/ops/deliveries/routes/${stop.routeId}`);
  revalidatePath(`/ops/orders/${stop.orderId}`);
  redirect("/delivery");
}

export async function failStopAction(formData: FormData): Promise<void> {
  const { user, stop } = await stopForUser(String(formData.get("stopId")));
  const reason = String(formData.get("reason") ?? "").trim() || "not delivered";
  const notes = String(formData.get("notes") ?? "").trim() || null;

  await failStop(stop.id, reason, { byUserId: user.id, actor: "ops", notes });

  revalidatePath("/delivery");
  revalidatePath(`/delivery/stops/${stop.id}`);
  revalidatePath(`/ops/deliveries/routes/${stop.routeId}`);
  redirect("/delivery");
}
