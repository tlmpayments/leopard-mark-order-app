"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { assertLocation, assertRole, LEDGER_ROLES } from "@/lib/ops/session";
import {
  addStopToRoute,
  assignDriver,
  cancelRoute,
  createRoute,
  dispatchRoute,
  moveStop,
  removeStopFromRoute,
  updateRouteMeta,
} from "@/lib/routes";
import { kickJobs } from "@/lib/jobs/kick";

/**
 * Route-building actions.
 *
 * Everything here is LEDGER_ROLES, including the ones that only move a card
 * around: a route IS the instruction to move stock, and someone who may not
 * mark a delivery may not decide which truck it rides on either. Dispatch
 * additionally re-checks the warehouse scope, because that is the one action
 * that mints numbers against a location's sequence.
 */

function revalidateDispatch(routeId?: string, ymd?: string): void {
  revalidatePath("/ops/deliveries");
  revalidatePath("/ops/deliveries/week");
  if (routeId) revalidatePath(`/ops/deliveries/routes/${routeId}`);
  if (ymd) revalidatePath(`/ops/deliveries?day=${ymd}`);
  revalidatePath("/ops");
}

export async function createRouteAction(formData: FormData): Promise<void> {
  const user = await assertRole(LEDGER_ROLES);
  const ymd = String(formData.get("day") ?? "");
  const region = String(formData.get("region") ?? "").trim();
  const warehouseId = String(formData.get("warehouseId") ?? "");
  const driverId = String(formData.get("driverId") ?? "") || null;
  const name = String(formData.get("name") ?? "");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error("Pick a route day");
  if (!region) throw new Error("Pick a region");
  if (!warehouseId) throw new Error("Pick a warehouse");
  await assertLocation(user, warehouseId);

  const route = await createRoute({ ymd, region, warehouseId, driverId, name });
  revalidateDispatch(route.id, ymd);
  redirect(`/ops/deliveries/routes/${route.id}`);
}

export async function addStopAction(formData: FormData): Promise<void> {
  const user = await assertRole(LEDGER_ROLES);
  const routeId = String(formData.get("routeId"));
  const orderId = String(formData.get("orderId"));
  await addStopToRoute(routeId, orderId, { byUserId: user.id });
  // scheduleOrder enqueues a Sheet mirror; drain now rather than at the daily
  // cron, same as the order screen's own scheduling action.
  kickJobs();
  revalidateDispatch(routeId);
  revalidatePath(`/ops/orders/${orderId}`);
}

export async function removeStopAction(formData: FormData): Promise<void> {
  const user = await assertRole(LEDGER_ROLES);
  const stopId = String(formData.get("stopId"));
  const stop = await db.routeStop.findUniqueOrThrow({ where: { id: stopId }, select: { routeId: true } });
  await removeStopFromRoute(stopId, { byUserId: user.id });
  revalidateDispatch(stop.routeId);
}

export async function moveStopAction(formData: FormData): Promise<void> {
  await assertRole(LEDGER_ROLES);
  const stopId = String(formData.get("stopId"));
  const direction = String(formData.get("direction")) === "up" ? "up" : "down";
  const stop = await db.routeStop.findUniqueOrThrow({ where: { id: stopId }, select: { routeId: true } });
  await moveStop(stopId, direction);
  revalidateDispatch(stop.routeId);
}

export async function updateRouteAction(formData: FormData): Promise<void> {
  const user = await assertRole(LEDGER_ROLES);
  const routeId = String(formData.get("routeId"));
  const driverId = String(formData.get("driverId") ?? "") || null;
  const warehouseId = String(formData.get("warehouseId") ?? "") || undefined;
  const name = String(formData.get("name") ?? "");
  const notes = String(formData.get("notes") ?? "");

  if (warehouseId) await assertLocation(user, warehouseId);
  await assignDriver(routeId, driverId);
  await updateRouteMeta(routeId, { name: name.trim() || null, notes: notes.trim() || null, warehouseId });
  revalidateDispatch(routeId);
}

/**
 * Put the route on the road: mint every stop's BOL and flip the route to
 * dispatched.
 *
 * Deliberately silent. This used to post the manifest to the region's Slack
 * channel; that came out in the 2026-09-06 reduction, because with
 * `region_slack_channels` unseeded it fell through to the rep ORDER channel and
 * put a wall of BOL numbers next to `:beer: NEW ORDER`. The manifest lives on
 * the route page and on the driver's own phone, which is where the people who
 * need it already are.
 */
export async function dispatchRouteAction(formData: FormData): Promise<void> {
  const user = await assertRole(LEDGER_ROLES);
  const routeId = String(formData.get("routeId"));

  const before = await db.deliveryRoute.findUniqueOrThrow({
    where: { id: routeId },
    select: { warehouseId: true },
  });
  await assertLocation(user, before.warehouseId);

  await dispatchRoute(routeId, user.id);
  kickJobs();
  revalidateDispatch(routeId);
}

export async function cancelRouteAction(formData: FormData): Promise<void> {
  await assertRole(LEDGER_ROLES);
  const routeId = String(formData.get("routeId"));
  await cancelRoute(routeId);
  revalidateDispatch(routeId);
  redirect("/ops/deliveries");
}
