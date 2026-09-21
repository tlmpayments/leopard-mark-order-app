import { afterEach, describe, expect, it, vi } from "vitest";
import { computeDeliveryPath } from "@/lib/orsRoutes";
import { readPreview, routeSignature, validateStopOrder, type PlannedStop } from "@/lib/routePlanning";

const stops: PlannedStop[] = ["A", "B", "C"].map(id => ({ id, name: id, address: `${id} Street, Los Angeles`, orderId: null, accountId: null, status: "pending" }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/** ORS speaks [lng, lat]; a geocode hit is a one-feature FeatureCollection. */
const geocode = (lng: number, lat: number, confidence = 1) =>
  ({ ok: true, status: 200, json: async () => ({ features: [{ geometry: { coordinates: [lng, lat] }, properties: { label: "Matched place", confidence } }] }) });
const optimization = (jobIds: number[]) =>
  ({ ok: true, status: 200, json: async () => ({ code: 0, routes: [{ steps: [{ type: "start" }, ...jobIds.map(id => ({ type: "job", id })), { type: "end" }] }] }) });
const directions = (legs: number[], distance = 6000) =>
  ({ ok: true, status: 200, json: async () => ({ features: [{ geometry: { type: "LineString", coordinates: [[-118.1, 33.7], [-118.2, 33.8]] },
    properties: { summary: { duration: legs.reduce((a, b) => a + b, 0), distance }, segments: legs.map(d => ({ duration: d })) } }] }) });

/** Every call in order: origin geocode, one per stop without coordinates, then the service calls. */
function sequence(...responses: unknown[]) {
  const fetcher = vi.fn();
  for (const r of responses) fetcher.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("delivery route planning", () => {
  it("rejects missing, duplicate, and foreign stop IDs", () => {
    for (const ids of [["A","A","C"],["A","B"],["A","B","D"]]) expect(() => validateStopOrder(["A","B","C"],ids)).toThrow();
    expect(() => validateStopOrder(["A","B","C"],["C","B","A"])).not.toThrow();
  });

  it("invalidates a review when an address, origin, or stop order changes", () => {
    const original = routeSignature("Warehouse",stops);
    expect(routeSignature("Other warehouse",stops)).not.toBe(original);
    expect(routeSignature("Warehouse",[...stops].reverse())).not.toBe(original);
    expect(routeSignature("Warehouse",stops.map(s=>({...s,address:"new"})))).not.toBe(original);
  });

  it("applies the optimized order while keeping the operator's final stop as the destination", async () => {
    vi.stubEnv("OPENROUTESERVICE_API_KEY","test-key");
    const fetcher = sequence(
      geocode(-118.26, 33.73),                       // origin
      geocode(-118.1, 33.8), geocode(-118.2, 33.9), geocode(-118.3, 34.0), // A, B, C
      optimization([2, 1]),                          // VROOM puts B before A
      directions([60, 120, 180]),
    );
    const { preview } = await computeDeliveryPath("Warehouse", stops, true);

    expect(preview.stopIds).toEqual(["B","A","C"]);
    expect(preview.legSeconds).toEqual([60,120,180]);
    expect(preview.durationSeconds).toBe(360);
    expect(preview.distanceMeters).toBe(6000);
    expect(preview.signature).toBe(routeSignature("Warehouse",[stops[1],stops[0],stops[2]]));

    // C is the vehicle's fixed end, so it is never offered to VROOM as a job.
    const optimizeBody = JSON.parse(fetcher.mock.calls[4][1].body);
    expect(optimizeBody.jobs).toHaveLength(2);
    expect(optimizeBody.vehicles[0].end).toEqual([-118.3, 34.0]);
    expect(optimizeBody.vehicles[0].start).toEqual([-118.26, 33.73]);

    // Directions are asked for the final order, origin first.
    expect(JSON.parse(fetcher.mock.calls[5][1].body).coordinates).toEqual([[-118.26,33.73],[-118.2,33.9],[-118.1,33.8],[-118.3,34.0]]);
  });

  it("preserves the operator's order when recalculating, without calling the optimizer", async () => {
    vi.stubEnv("OPENROUTESERVICE_API_KEY","test-key");
    const fetcher = sequence(
      geocode(-118.26, 33.73), geocode(-118.3, 34.0), geocode(-118.2, 33.9), geocode(-118.1, 33.8),
      directions([1, 2, 3], 10),
    );
    const { preview } = await computeDeliveryPath("Warehouse",[...stops].reverse(),false);
    expect(preview.stopIds).toEqual(["C","B","A"]);
    expect(fetcher.mock.calls.some(c => String(c[0]).includes("/optimization"))).toBe(false);
  });

  it("spends no geocode on a stop whose coordinates the database already knows", async () => {
    vi.stubEnv("OPENROUTESERVICE_API_KEY","test-key");
    const coords = [[-118.2, 33.7], [-118.3, 33.8], [-118.4, 33.9]];
    const known = stops.map((s, i) => ({ ...s, lng: coords[i][0], lat: coords[i][1] }));
    const fetcher = sequence(geocode(-118.26, 33.73), directions([10, 20, 30]));
    const { preview, resolved } = await computeDeliveryPath("Warehouse", known, false);

    expect(fetcher.mock.calls.filter(c => String(c[0]).includes("/geocode")).length).toBe(1);
    expect(resolved.every(r => !r.geocoded)).toBe(true);
    expect(preview.stopCoords).toEqual(coords);
  });

  it("warns about an imprecise match rather than silently routing to it", async () => {
    vi.stubEnv("OPENROUTESERVICE_API_KEY","test-key");
    sequence(
      geocode(-118.26, 33.73),
      geocode(-118.1, 33.8, 0.3), geocode(-118.2, 33.9), geocode(-118.3, 34.0),
      directions([60, 120, 180]),
    );
    const { preview } = await computeDeliveryPath("Warehouse", stops, false);
    expect(preview.warnings).toHaveLength(1);
    expect(preview.warnings![0]).toContain("A");
  });

  it("carries the drawn line and the pins through for the map", async () => {
    vi.stubEnv("OPENROUTESERVICE_API_KEY","test-key");
    sequence(geocode(-118.26,33.73), geocode(-118.1,33.8), geocode(-118.2,33.9), geocode(-118.3,34.0), directions([1,2,3]));
    const { preview } = await computeDeliveryPath("Warehouse", stops, false);
    expect(preview.geometry).toEqual([[-118.1,33.7],[-118.2,33.8]]);
    expect(preview.originCoord).toEqual([-118.26,33.73]);
    expect(preview.stopCoords).toHaveLength(3);
  });

  it("fails closed on absent configuration, missing addresses, and oversized routes", async () => {
    vi.stubEnv("OPENROUTESERVICE_API_KEY","");
    await expect(computeDeliveryPath("Warehouse",stops,true)).rejects.toThrow("setup");
    vi.stubEnv("OPENROUTESERVICE_API_KEY","test-key");
    await expect(computeDeliveryPath("",stops,true)).rejects.toThrow("street address");
    await expect(computeDeliveryPath("Warehouse",[{...stops[0],address:""}],true)).rejects.toThrow("address");
    await expect(computeDeliveryPath("Warehouse",Array(22).fill(stops[0]),true)).rejects.toThrow("21");
  });

  it("tells the operator which ceiling it hit", async () => {
    vi.stubEnv("OPENROUTESERVICE_API_KEY","test-key");
    sequence({ ok:false, status:429 });
    await expect(computeDeliveryPath("Warehouse",stops,true)).rejects.toThrow("rate limited");
    sequence({ ok:false, status:403 });
    await expect(computeDeliveryPath("Warehouse",stops,true)).rejects.toThrow("quota");
    sequence({ ok:false, status:401 });
    await expect(computeDeliveryPath("Warehouse",stops,true)).rejects.toThrow("key was rejected");
  });

  it("rejects an unroutable address rather than dropping the stop", async () => {
    vi.stubEnv("OPENROUTESERVICE_API_KEY","test-key");
    sequence({ ok:true, status:200, json: async () => ({ features: [] }) });
    await expect(computeDeliveryPath("Warehouse",stops,true)).rejects.toThrow("No map location");
  });

  it("rejects malformed optimizer and directions responses, and stored previews", async () => {
    vi.stubEnv("OPENROUTESERVICE_API_KEY","test-key");
    // VROOM returning the same job twice would silently drop a delivery.
    sequence(geocode(-118.26,33.73), geocode(-118.1,33.8), geocode(-118.2,33.9), geocode(-118.3,34.0), optimization([1,1]));
    await expect(computeDeliveryPath("Warehouse",stops,true)).rejects.toThrow("incomplete stop order");

    sequence(geocode(-118.26,33.73), geocode(-118.1,33.8), geocode(-118.2,33.9), geocode(-118.3,34.0), optimization([2,1]), directions([60,120]));
    await expect(computeDeliveryPath("Warehouse",stops,true)).rejects.toThrow("No drivable route");

    sequence(geocode(-118.26,33.73), geocode(-118.1,33.8), geocode(-118.2,33.9), geocode(-118.3,34.0),
      { ok:true, status:200, json: async () => ({ code: 0, routes: [{ steps: [] }], unassigned: [{ id: 1 }] }) });
    await expect(computeDeliveryPath("Warehouse",stops,true)).rejects.toThrow("could not be reached");

    expect(readPreview({signature:"x",stopIds:["A"],legSeconds:[NaN]})).toBeNull();
  });

  it("still reads a review saved before the map existed", () => {
    const legacy = { signature:"x", stopIds:["A"], legSeconds:[60], durationSeconds:60, distanceMeters:100, calculatedAt:"2026-01-01T00:00:00.000Z" };
    expect(readPreview(legacy)).not.toBeNull();
    expect(readPreview(legacy)!.geometry).toBeUndefined();
  });
});
