/** Serializable routing values shared by the builder and routing service. */
export type PlannedStop = { id: string; name: string; address: string; orderId: string | null; accountId: string | null; status: string };
export type RoutePreview = { signature: string; stopIds: string[]; legSeconds: number[]; durationSeconds: number; distanceMeters: number; calculatedAt: string };
export const MAX_ROUTE_STOPS = 21;
export function routeSignature(origin: string, stops: Pick<PlannedStop, "id" | "address">[]): string {
  return JSON.stringify([origin, ...stops.map(s => [s.id, s.address])]);
}
export function readPreview(value: unknown): RoutePreview | null {
  if (!value || typeof value !== "object") return null;
  const p = value as RoutePreview;
  return typeof p.signature === "string" && Array.isArray(p.stopIds) && p.stopIds.every(id => typeof id === "string") &&
    Array.isArray(p.legSeconds) && p.legSeconds.every(n => Number.isFinite(n) && n >= 0) &&
    p.legSeconds.length === p.stopIds.length && Number.isFinite(p.durationSeconds) && Number.isFinite(p.distanceMeters) ? p : null;
}
export function validateStopOrder(known: string[], ordered: string[]): void {
  if (known.length !== ordered.length || new Set(ordered).size !== known.length || ordered.some(id => !known.includes(id))) {
    throw new Error("The stops changed. Reload the route and try again.");
  }
}
export function mapsEmbedUrl(key: string, origin: string, stops: Pick<PlannedStop, "address">[]): string {
  const params = new URLSearchParams({ key, origin, destination: stops.at(-1)?.address ?? origin, mode: "driving" });
  if (stops.length > 1) params.set("waypoints", stops.slice(0, -1).map(s => s.address).join("|"));
  return `https://www.google.com/maps/embed/v1/directions?${params}`;
}
