import { afterEach, describe, expect, it, vi } from "vitest";
import { computeDeliveryPath } from "@/lib/googleRoutes";
import { mapsEmbedUrl, readPreview, routeSignature, validateStopOrder, type PlannedStop } from "@/lib/routePlanning";
const stops: PlannedStop[] = ["A", "B", "C"].map(id => ({ id, name: id, address: `${id} Street, Los Angeles`, orderId: null, accountId: null, status: "pending" }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
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
  it("uses Google's optimized indices and leg durations while preserving the final destination", async () => {
    vi.stubEnv("GOOGLE_ROUTES_API_KEY","test-key");
    const fetcher = vi.fn().mockResolvedValue({ok:true,json:async()=>({routes:[{optimizedIntermediateWaypointIndex:[1,0],legs:[{duration:"60s"},{duration:"120s"},{duration:"180s"}],duration:"360s",distanceMeters:6000}]})});
    vi.stubGlobal("fetch",fetcher);
    const preview = await computeDeliveryPath("Warehouse",stops,true);
    expect(preview.stopIds).toEqual(["B","A","C"]); expect(preview.legSeconds).toEqual([60,120,180]);
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.origin).toEqual({address:"Warehouse"}); expect(body.destination.address).toBe(stops[2].address);
    expect(body.optimizeWaypointOrder).toBe(true); expect(body.routingPreference).toBe("TRAFFIC_AWARE");
    expect(preview.signature).toBe(routeSignature("Warehouse",[stops[1],stops[0],stops[2]]));
  });
  it("preserves the operator's order when recalculating", async () => {
    vi.stubEnv("GOOGLE_ROUTES_API_KEY","test-key");
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,json:async()=>({routes:[{legs:[{duration:"1s"},{duration:"2s"},{duration:"3s"}],duration:"6s",distanceMeters:10}]})}));
    expect((await computeDeliveryPath("Warehouse",[...stops].reverse(),false)).stopIds).toEqual(["C","B","A"]);
  });
  it("fails closed on absent configuration, missing addresses, oversized routes, and upstream errors", async () => {
    vi.stubEnv("GOOGLE_ROUTES_API_KEY",""); await expect(computeDeliveryPath("Warehouse",stops,true)).rejects.toThrow("setup");
    vi.stubEnv("GOOGLE_ROUTES_API_KEY","test-key");
    await expect(computeDeliveryPath("",stops,true)).rejects.toThrow("street address");
    await expect(computeDeliveryPath("Warehouse",[{...stops[0],address:""}],true)).rejects.toThrow("address");
    await expect(computeDeliveryPath("Warehouse",Array(22).fill(stops[0]),true)).rejects.toThrow("21");
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:false})); await expect(computeDeliveryPath("Warehouse",stops,true)).rejects.toThrow("could not calculate");
  });
  it("rejects malformed routing responses and stored previews", async () => {
    vi.stubEnv("GOOGLE_ROUTES_API_KEY","test-key");
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,json:async()=>({routes:[{optimizedIntermediateWaypointIndex:[0,0],legs:[{duration:"1s"},{duration:"2s"},{duration:"3s"}],duration:"6s",distanceMeters:10}]})}));
    await expect(computeDeliveryPath("Warehouse",stops,true)).rejects.toThrow("stops changed");
    expect(readPreview({signature:"x",stopIds:["A"],legSeconds:[NaN]})).toBeNull();
  });
  it("encodes all selected stops in the map preview in driving order", () => {
    const url = new URL(mapsEmbedUrl("key","Wilmington & Warehouse",stops));
    expect(url.searchParams.get("origin")).toBe("Wilmington & Warehouse");
    expect(url.searchParams.get("waypoints")).toBe(`${stops[0].address}|${stops[1].address}`);
    expect(url.searchParams.get("destination")).toBe(stops[2].address);
  });
});
