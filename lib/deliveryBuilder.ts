import { db } from "@/lib/db";
import type { RouteWithStops } from "@/lib/routes";
import type { PlannedStop } from "@/lib/routePlanning";

export async function deliveryDefaults() {
  const [warehouse, drivers] = await Promise.all([
    db.location.findUnique({ where: { id: "WH-WIL" } }),
    db.rep.findMany({ where: { role: "driver", active: true } }),
  ]);
  const matches = drivers.filter(d => /^jose(?:\s|$)/i.test(d.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")));
  if (!warehouse?.active) throw new Error("Activate Wilmington Warehouse (WH-WIL) in Settings first.");
  if (matches.length !== 1) throw new Error("Settings must have exactly one active driver named Jose (or Jose followed by his surname).");
  return { warehouse, driver: matches[0] };
}
export function plannedStops(route: RouteWithStops): PlannedStop[] {
  return route.stops.map(s => ({ id: s.id, name: s.order?.account.businessName ?? s.stopName ?? "Stop", address: (s.order?.account.deliveryAddress || s.order?.account.address || s.stopAddress || "").trim(),
    orderId: s.orderId, accountId: s.order?.account.id ?? s.accountRef, status: s.status }));
}
