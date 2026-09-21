/**
 * Route planning on OpenRouteService.
 *
 * Replaces the Google Routes integration this file grew out of. The trade the
 * business made knowingly: ORS is free with no billing account, at the cost of
 * geocoding that is weaker than Google's on US street addresses. Everything
 * here is shaped by that one weakness -- coordinates are reused rather than
 * re-derived wherever the database already knows them, every geocode carries
 * its confidence forward, and the operator gets a map good enough to catch a
 * stop that landed on the wrong block before Jose drives to it.
 *
 * Three ORS endpoints do the work:
 *   /geocode/search   address -> coordinates (Pelias; OSM + OpenAddresses)
 *   /optimization     which order to visit the intermediates in (VROOM)
 *   /v2/directions    the drive times and the line drawn on the map
 *
 * Optimization decides the ORDER only. The durations and distance shown to the
 * operator always come from the directions call on the final order, so the
 * numbers on screen describe the line on the map rather than VROOM's internal
 * cost matrix, which is built for comparing candidate orders and can differ.
 */

import { MAX_ROUTE_STOPS, routeSignature, validateStopOrder, type PlannedStop, type RoutePreview } from "./routePlanning";

const BASE = "https://api.openrouteservice.org";
const PROFILE = "driving-car";
/** ORS speaks [longitude, latitude]; nearly every other tool speaks the reverse. */
export type Coord = [number, number];

/**
 * Below this, Pelias is telling us it guessed. A street address that resolves
 * only to its city centroid scores here, and that is precisely the failure
 * that sends a driver to the wrong place with a route that looks fine.
 */
const LOW_CONFIDENCE = 0.8;

export type ResolvedStop = {
  id: string;
  address: string;
  coord: Coord;
  /** What ORS believes it matched. Null when the coordinate came from the database. */
  label: string | null;
  confidence: number;
  /** True when this call spent a geocode request to find it. */
  geocoded: boolean;
};
export type PathResult = { preview: RoutePreview; resolved: ResolvedStop[] };

function apiKey(): string {
  const key = process.env.OPENROUTESERVICE_API_KEY;
  if (!key) throw new Error("Route planning needs OpenRouteService setup. Ask an administrator to add the routing key before pushing to Jose.");
  return key;
}

/**
 * ORS separates its two ceilings: 403 is the day's quota, 429 the minute's.
 * They need different advice -- one is "come back tomorrow", the other is
 * "wait a moment" -- and an operator mid-route deserves to be told which.
 */
async function orsFetch(path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(25000) });
  } catch {
    throw new Error("OpenRouteService did not respond. Check the connection and retry.");
  }
  if (response.status === 429) throw new Error("Routing is rate limited for the next minute. Wait a moment and calculate again.");
  if (response.status === 403) throw new Error("The day's routing quota is used up. Routing resumes tomorrow, or an administrator can raise the OpenRouteService plan.");
  if (response.status === 401) throw new Error("The OpenRouteService key was rejected. Check OPENROUTESERVICE_API_KEY.");
  if (!response.ok) throw new Error("OpenRouteService could not calculate this route. Check the addresses, then retry.");
  try {
    return await response.json();
  } catch {
    throw new Error("OpenRouteService returned a response that could not be read. Retry.");
  }
}

function isCoord(value: unknown): value is Coord {
  return Array.isArray(value) && value.length === 2 && value.every(n => typeof n === "number" && Number.isFinite(n))
    && Math.abs(value[0] as number) <= 180 && Math.abs(value[1] as number) <= 90;
}

/** One address to one coordinate. Biased to the US so "E St" cannot match Europe. */
export async function geocodeAddress(address: string): Promise<{ coord: Coord; label: string; confidence: number }> {
  const params = new URLSearchParams({ api_key: apiKey(), text: address, "boundary.country": "USA", size: "1" });
  const data = await orsFetch(`/geocode/search?${params}`, { method: "GET" }) as
    { features?: { geometry?: { coordinates?: unknown }; properties?: { label?: string; confidence?: number } }[] };
  const feature = data.features?.[0];
  if (!feature || !isCoord(feature.geometry?.coordinates)) throw new Error(`No map location was found for "${address}". Check the address.`);
  return {
    coord: feature.geometry.coordinates,
    label: typeof feature.properties?.label === "string" ? feature.properties.label : address,
    // A missing score is treated as a miss, not a pass: silence is not confidence.
    confidence: typeof feature.properties?.confidence === "number" ? feature.properties.confidence : 0,
  };
}

/**
 * Coordinates for every stop, spending a geocode only where the database has
 * none. Account stops usually arrive with lat/lng already on the account row,
 * which is both faster and better-placed than re-geocoding a street string.
 */
async function resolveStops(stops: PlannedStop[]): Promise<ResolvedStop[]> {
  const resolved: ResolvedStop[] = [];
  for (const stop of stops) {
    if (typeof stop.lat === "number" && typeof stop.lng === "number" && isCoord([stop.lng, stop.lat])) {
      resolved.push({ id: stop.id, address: stop.address, coord: [stop.lng, stop.lat], label: null, confidence: 1, geocoded: false });
      continue;
    }
    const hit = await geocodeAddress(stop.address);
    resolved.push({ id: stop.id, address: stop.address, coord: hit.coord, label: hit.label, confidence: hit.confidence, geocoded: true });
  }
  return resolved;
}

/** VROOM orders the intermediates; the vehicle's fixed end keeps the operator's chosen final stop last. */
async function optimizeOrder(origin: Coord, intermediates: ResolvedStop[], destination: Coord): Promise<ResolvedStop[]> {
  const data = await orsFetch("/optimization", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey() },
    body: JSON.stringify({
      jobs: intermediates.map((stop, i) => ({ id: i + 1, location: stop.coord })),
      vehicles: [{ id: 1, profile: PROFILE, start: origin, end: destination }],
    }),
  }) as { code?: number; routes?: { steps?: { type?: string; id?: number }[] }[]; unassigned?: unknown[] };

  if (data.code !== 0) throw new Error("No drivable order was found for these stops. Check the addresses.");
  if (data.unassigned?.length) throw new Error("Some stops could not be reached by road. Check their addresses.");
  const ids = (data.routes?.[0]?.steps ?? []).filter(s => s.type === "job").map(s => s.id);
  // VROOM must place every job exactly once; anything else and we would silently
  // drop a delivery from the route.
  if (ids.length !== intermediates.length || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== "number" || id < 1 || id > intermediates.length)) {
    throw new Error("OpenRouteService returned an incomplete stop order. Retry routing.");
  }
  return ids.map(id => intermediates[id! - 1]);
}

/** Drive times, total distance, and the line to draw, for one fixed order. */
async function directions(coords: Coord[]): Promise<{ legSeconds: number[]; durationSeconds: number; distanceMeters: number; geometry: Coord[] }> {
  const data = await orsFetch(`/v2/directions/${PROFILE}/geojson`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey() },
    body: JSON.stringify({ coordinates: coords }),
  }) as { features?: { geometry?: { coordinates?: unknown }; properties?: { summary?: { duration?: number; distance?: number }; segments?: { duration?: number }[] } }[] };

  const feature = data.features?.[0];
  const segments = feature?.properties?.segments;
  if (!segments || segments.length !== coords.length - 1) throw new Error("No drivable route was found for all stops. Check the addresses.");
  const legSeconds = segments.map(s => {
    if (typeof s.duration !== "number" || !Number.isFinite(s.duration) || s.duration < 0) throw new Error("OpenRouteService returned incomplete drive times. Retry routing.");
    return s.duration;
  });
  const summary = feature.properties?.summary;
  // A single-leg route can legitimately summarise to nothing when both ends
  // geocode to the same spot, so fall back to the legs rather than failing.
  const durationSeconds = typeof summary?.duration === "number" && Number.isFinite(summary.duration)
    ? summary.duration : legSeconds.reduce((sum, n) => sum + n, 0);
  if (typeof summary?.distance !== "number" || !Number.isFinite(summary.distance)) throw new Error("OpenRouteService returned an incomplete route distance.");
  const line = feature.geometry?.coordinates;
  const geometry = Array.isArray(line) ? line.filter(isCoord) : [];
  return { legSeconds, durationSeconds, distanceMeters: summary.distance, geometry };
}

/**
 * The whole calculation. Same contract the builder has always called: fix the
 * warehouse as the origin, keep the last stop as the destination, and order
 * what lies between when asked to.
 */
export async function computeDeliveryPath(origin: string, stops: PlannedStop[], optimize: boolean): Promise<PathResult> {
  apiKey();
  if (!origin.trim()) throw new Error("Add the Wilmington Warehouse street address in Settings before routing.");
  if (!stops.length || stops.length > MAX_ROUTE_STOPS) throw new Error(`Choose between 1 and ${MAX_ROUTE_STOPS} stops per delivery.`);
  const missing = stops.find(s => !s.address.trim());
  if (missing) throw new Error(`Add a delivery address for ${missing.name} before routing.`);

  const start = await geocodeAddress(origin);
  const resolved = await resolveStops(stops);

  // Two stops or fewer leaves nothing between origin and destination to order.
  const ordered = optimize && stops.length > 2
    ? [...await optimizeOrder(start.coord, resolved.slice(0, -1), resolved[resolved.length - 1].coord), resolved[resolved.length - 1]]
    : resolved;
  validateStopOrder(stops.map(s => s.id), ordered.map(s => s.id));

  const path = await directions([start.coord, ...ordered.map(s => s.coord)]);
  const byId = new Map(stops.map(s => [s.id, s]));
  const warnings = [
    ...(start.confidence < LOW_CONFIDENCE ? [`The warehouse address matched "${start.label}" imprecisely. Check the map before pushing.`] : []),
    ...ordered.filter(s => s.geocoded && s.confidence < LOW_CONFIDENCE)
      .map(s => `${byId.get(s.id)?.name ?? "A stop"} matched "${s.label}" imprecisely. Check its pin on the map.`),
  ];

  return {
    preview: {
      signature: routeSignature(origin, ordered.map(s => ({ id: s.id, address: s.address }))),
      stopIds: ordered.map(s => s.id),
      legSeconds: path.legSeconds,
      durationSeconds: path.durationSeconds,
      distanceMeters: path.distanceMeters,
      calculatedAt: new Date().toISOString(),
      geometry: path.geometry,
      stopCoords: ordered.map(s => s.coord),
      originCoord: start.coord,
      warnings,
    },
    resolved: ordered,
  };
}
