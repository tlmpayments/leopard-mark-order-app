"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { Prisma } from "@/app/generated/prisma/client";
import { assertLocation, assertRole, LEDGER_ROLES } from "@/lib/ops/session";
import { addStopToRoute, dispatchRoute, loadRoute, removeStopFromRoute } from "@/lib/routes";
import { deliveryDefaults, plannedStops } from "@/lib/deliveryBuilder";
import { computeDeliveryPath } from "@/lib/googleRoutes";
import { MAX_ROUTE_STOPS, readPreview, routeSignature, validateStopOrder } from "@/lib/routePlanning";
import { kickJobs } from "@/lib/jobs/kick";

async function editableRoute(id: string) {
  const user = await assertRole(LEDGER_ROLES);
  const route = await loadRoute(id);
  if (!route) throw new Error("Route not found.");
  await assertLocation(user, route.warehouseId);
  if (route.status !== "draft") throw new Error("This route has already been pushed or closed. Reload to see its status.");
  return { route, user };
}
function refresh(id: string) {
  revalidatePath("/ops/deliveries"); revalidatePath(`/ops/deliveries/routes/${id}`); revalidatePath("/ops/deliveries/week"); revalidatePath("/delivery");
}
export async function searchDeliveryAccounts(query: string) {
  await assertRole(LEDGER_ROLES);
  const q = query.trim().slice(0, 100);
  if (q.length < 2) return [];
  return db.account.findMany({ where: { OR: [{ businessName: { contains: q, mode: "insensitive" } }, { address: { contains: q, mode: "insensitive" } }, { deliveryAddress: { contains: q, mode: "insensitive" } }] },
    select: { id: true, businessName: true, address: true, deliveryAddress: true }, orderBy: { businessName: "asc" }, take: 30 });
}
export async function addBuilderStop(routeId: string, input: { orderId?: string; accountId?: string; name?: string; address?: string }) {
  try {
    const { route, user } = await editableRoute(routeId);
    if (route.stops.length >= MAX_ROUTE_STOPS) throw new Error(`This delivery has ${MAX_ROUTE_STOPS} stops. Build another delivery for more stops.`);
    if (input.orderId) {
      const order = await db.order.findUniqueOrThrow({ where: { id: input.orderId }, select: { status: true, deliveredAt: true } });
      if (order.deliveredAt || ["draft", "cancelled", "rejected", "expired"].includes(order.status)) throw new Error("This order is no longer awaiting delivery.");
      await addStopToRoute(routeId, input.orderId, { byUserId: user.id }); kickJobs();
    } else {
      let name = input.name?.trim() ?? "", address = input.address?.trim() ?? "";
      if (input.accountId) {
        if (plannedStops(route).some(s => s.accountId === input.accountId)) throw new Error("This account is already a stop on the route.");
        const account = await db.account.findUniqueOrThrow({ where: { id: input.accountId } });
        name = account.businessName; address = (account.deliveryAddress || account.address || "").trim();
      }
      if (!name || !address || name.length > 200 || address.length > 500) throw new Error("Enter a stop name and full street address (up to 200 and 500 characters).");
      await db.$transaction(async tx => {
        const locked = await tx.deliveryRoute.updateMany({ where: { id: routeId, status: "draft" }, data: { routingSnapshot: Prisma.DbNull } });
        if (!locked.count) throw new Error("The route is no longer editable.");
        const count = await tx.routeStop.count({ where: { routeId } });
        if (count >= MAX_ROUTE_STOPS) throw new Error("The delivery is full. Reload the route.");
        if (input.accountId && await tx.routeStop.findFirst({ where: { routeId, accountRef: input.accountId } })) throw new Error("This account is already on the route.");
        const max = await tx.routeStop.aggregate({ where: { routeId }, _max: { sequence: true } });
        await tx.routeStop.create({ data: { routeId, sequence: (max._max.sequence ?? 0) + 1, stopName: name, stopAddress: address, accountRef: input.accountId ?? null } });
      });
    }
    await db.deliveryRoute.update({ where: { id: routeId }, data: { routingSnapshot: Prisma.DbNull } });
    refresh(routeId); return { ok: true as const };
  } catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : "Could not add stop." }; }
}
export async function removeBuilderStop(routeId: string, stopId: string) {
  try {
    const { route, user } = await editableRoute(routeId);
    if (!route.stops.some(s => s.id === stopId)) throw new Error("Stop not found on this route.");
    await removeStopFromRoute(stopId, { byUserId: user.id });
    await db.deliveryRoute.update({ where: { id: routeId }, data: { routingSnapshot: Prisma.DbNull } });
    refresh(routeId); return { ok: true as const };
  } catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : "Could not remove stop." }; }
}
export async function coordinateDelivery(routeId: string, orderedIds: string[], optimize: boolean) {
  try {
    const { route } = await editableRoute(routeId);
    if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY || !process.env.GOOGLE_ROUTES_API_KEY) throw new Error("Google Maps isn’t connected yet. Complete Maps setup before calculating this route.");
    const stops = plannedStops(route);
    validateStopOrder(stops.map(s => s.id), orderedIds);
    const ordered = orderedIds.map(id => stops.find(s => s.id === id)!);
    const preview = await computeDeliveryPath(route.warehouse.address ?? "", ordered, optimize);
    await db.$transaction(async tx => {
      const locked = await tx.deliveryRoute.updateMany({ where: { id: routeId, status: "draft", updatedAt: route.updatedAt }, data: { routingSnapshot: preview } });
      if (!locked.count) throw new Error("The route changed while calculating. Reload and try again.");
      const current = await tx.routeStop.findMany({ where: { routeId }, select: { id: true } });
      validateStopOrder(current.map(s => s.id), preview.stopIds);
      for (let i = 0; i < preview.stopIds.length; i++) await tx.routeStop.update({ where: { id: preview.stopIds[i] }, data: { sequence: -(i + 1) } });
      for (let i = 0; i < preview.stopIds.length; i++) await tx.routeStop.update({ where: { id: preview.stopIds[i] }, data: { sequence: i + 1 } });
    });
    refresh(routeId); return { ok: true as const, preview };
  } catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : "Could not coordinate the route." }; }
}
export async function pushDeliveryToDriver(routeId: string, signature: string) {
  try {
    const { route, user } = await editableRoute(routeId);
    const { warehouse, driver } = await deliveryDefaults();
    if (route.warehouseId !== warehouse.id || route.driverId !== driver.id) throw new Error("Build a new delivery from Wilmington Warehouse for Jose.");
    const preview = readPreview(route.routingSnapshot);
    if (!preview || preview.signature !== signature || signature !== routeSignature(route.warehouse.address ?? "", plannedStops(route))) throw new Error("The stops changed. Coordinate the path again before pushing to Jose.");
    await dispatchRoute(routeId, user.id, signature); kickJobs(); refresh(routeId);
    return { ok: true as const };
  } catch (e) { return { ok: false as const, error: e instanceof Error ? e.message : "Could not push to Jose." }; }
}
