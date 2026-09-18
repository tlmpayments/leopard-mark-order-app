import { MAX_ROUTE_STOPS, routeSignature, validateStopOrder, type PlannedStop, type RoutePreview } from "./routePlanning";

/** Google keeps the chosen destination fixed while optimizing intermediate stops. */
export async function computeDeliveryPath(origin: string, stops: PlannedStop[], optimize: boolean): Promise<RoutePreview> {
  const key = process.env.GOOGLE_ROUTES_API_KEY;
  if (!key) throw new Error("Route optimization needs Google Maps setup. Ask an administrator to enable routing before pushing to Jose.");
  if (!origin.trim()) throw new Error("Add the Wilmington Warehouse street address in Settings before routing.");
  if (!stops.length || stops.length > MAX_ROUTE_STOPS) throw new Error(`Choose between 1 and ${MAX_ROUTE_STOPS} stops per delivery.`);
  const missing = stops.find(s => !s.address.trim());
  if (missing) throw new Error(`Add a delivery address for ${missing.name} before routing.`);
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST", cache: "no-store", signal: AbortSignal.timeout(25000),
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.optimizedIntermediateWaypointIndex,routes.legs.duration,routes.duration,routes.distanceMeters" },
    body: JSON.stringify({ origin: { address: origin }, destination: { address: stops[stops.length - 1].address },
      intermediates: stops.slice(0, -1).map(s => ({ address: s.address })), travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE", optimizeWaypointOrder: optimize && stops.length > 2 }),
  });
  if (!response.ok) throw new Error("Google Maps could not calculate this route. Check the addresses and Maps configuration, then retry.");
  const data = await response.json() as { routes?: { optimizedIntermediateWaypointIndex?: number[]; legs?: { duration?: string }[]; duration?: string; distanceMeters?: number }[] };
  const route = data.routes?.[0];
  if (!route?.legs || route.legs.length !== stops.length) throw new Error("No drivable route was found for all stops. Check the addresses.");
  const indices = optimize && stops.length > 2 ? route.optimizedIntermediateWaypointIndex : stops.slice(0, -1).map((_, i) => i);
  if (!indices || indices.some(i => !Number.isInteger(i) || i < 0 || i >= stops.length - 1)) throw new Error("Google returned an incomplete stop order. Retry routing.");
  const ordered = [...indices.map(i => stops[i]), stops[stops.length - 1]];
  validateStopOrder(stops.map(s => s.id), ordered.map(s => s.id));
  const seconds = (duration: string | undefined) => {
    if (!duration || !/^\d+(\.\d+)?s$/.test(duration)) throw new Error("Google returned incomplete drive times. Retry routing.");
    return Number(duration.slice(0, -1));
  };
  if (!Number.isFinite(route.distanceMeters)) throw new Error("Google returned an incomplete route distance.");
  return { signature: routeSignature(origin, ordered), stopIds: ordered.map(s => s.id), legSeconds: route.legs.map(l => seconds(l.duration)),
    durationSeconds: seconds(route.duration), distanceMeters: route.distanceMeters!, calculatedAt: new Date().toISOString() };
}
