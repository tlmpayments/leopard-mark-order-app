/** Serializable routing values shared by the builder and routing service. */
export type PlannedStop = {
  id: string; name: string; address: string; orderId: string | null; accountId: string | null; status: string;
  /** Known coordinates, when the account row already carries them. Saves a geocode. */
  lat?: number | null; lng?: number | null;
};
export type RoutePreview = {
  signature: string; stopIds: string[]; legSeconds: number[]; durationSeconds: number; distanceMeters: number; calculatedAt: string;
  /** The drawn line, [lng, lat] as the routing service returns it. Absent on reviews saved before the map existed. */
  geometry?: [number, number][];
  /** Where each stop and the warehouse actually landed, so the operator can check a pin. */
  stopCoords?: [number, number][];
  originCoord?: [number, number];
  /** Addresses the geocoder matched imprecisely. Shown above the map. */
  warnings?: string[];
};
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
