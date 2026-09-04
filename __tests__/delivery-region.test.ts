/**
 * City region -> delivery region mapping.
 *
 * Every case below is a region string that actually appears in the live
 * Customer Accounts tab, with its observed account count. Getting this wrong
 * has two silent failure modes, which is why it is tested rather than trusted:
 * an account passes the "region → warehouse" setup check when nobody can
 * deliver to it, or the slot proposer books it onto a truck that does not go
 * there.
 */
import { describe, expect, it } from "vitest";
import { citiesInDeliveryRegion, deliveryRegionFor, knownRegionKeys } from "@/lib/deliveryRegion";

describe("Bay Area", () => {
  it.each([
    ["San Francisco", 52],
    ["North Bay", 14],
    ["South San Francisco", 2],
    ["San Rafael", 1],
    ["Burlingame", 1],
  ])("%s (%i accounts) -> BA", (city) => {
    expect(deliveryRegionFor(city)).toBe("BA");
  });

  it("maps the rep app's legacy SF/Bay label", () => {
    // window.LM_REP_REGIONS in public/rep-app/assets/js/config.js.
    expect(deliveryRegionFor("SF/Bay")).toBe("BA");
  });
});

describe("Southern California", () => {
  it.each([
    ["Los Angeles", 18],
    ["Orange County", 11],
    ["Long Beach", 9],
    ["Arcadia", 1],
  ])("%s (%i accounts) -> LA", (city) => {
    expect(deliveryRegionFor(city)).toBe("LA");
  });

  it("routes San Diego onto the LA run, which is a judgement call", () => {
    // WH-WIL is the only warehouse serving SoCal today, so San Diego rides the
    // LA route despite being 120 miles out. Three accounts. Asserted so that
    // changing it is a deliberate act with a failing test, not a silent drift.
    expect(deliveryRegionFor("San Diego")).toBe("LA");
  });
});

describe("already-canonical values pass through", () => {
  it.each([
    ["BA", "BA"],
    ["LA", "LA"],
    ["ba", "BA"],
    ["la", "LA"],
  ])("%s -> %s", (input, want) => {
    expect(deliveryRegionFor(input)).toBe(want);
  });
});

describe("refuses to default", () => {
  it("returns null for a blank region", () => {
    // 8 accounts on the tab have no region at all.
    expect(deliveryRegionFor("")).toBeNull();
    expect(deliveryRegionFor("   ")).toBeNull();
    expect(deliveryRegionFor(null)).toBeNull();
    expect(deliveryRegionFor(undefined)).toBeNull();
  });

  it("returns null for a region nobody delivers to", () => {
    // The rep app's legacy map also carried Northeast and South, which have
    // breweries but no delivery route. Defaulting them to LA would put an
    // account on a truck that never goes there.
    expect(deliveryRegionFor("Northeast")).toBeNull();
    expect(deliveryRegionFor("South")).toBeNull();
    expect(deliveryRegionFor("Portland")).toBeNull();
  });

  it("does not guess from a substring", () => {
    // "San Diego" contains "San", and "Sandusky" starts with it. Neither may
    // fall through to a Bay Area route by accident.
    expect(deliveryRegionFor("Sandusky")).toBeNull();
    expect(deliveryRegionFor("San Jose del Cabo")).toBeNull();
  });
});

describe("normalisation", () => {
  it("ignores case and surrounding whitespace, as sheet cells carry both", () => {
    expect(deliveryRegionFor("  SAN FRANCISCO  ")).toBe("BA");
    expect(deliveryRegionFor("orange county")).toBe("LA");
  });
});

describe("the mapping is complete and consistent", () => {
  it("covers every region string the live tab contains", () => {
    const live = [
      "San Francisco",
      "Los Angeles",
      "North Bay",
      "Orange County",
      "Long Beach",
      "San Diego",
      "South San Francisco",
      "San Rafael",
      "Arcadia",
      "Burlingame",
    ];
    for (const region of live) {
      expect(deliveryRegionFor(region), `${region} is unmapped`).not.toBeNull();
    }
  });

  it("assigns every known key to exactly one delivery region", () => {
    const ba = new Set(citiesInDeliveryRegion("BA"));
    const la = new Set(citiesInDeliveryRegion("LA"));
    expect([...ba].filter((c) => la.has(c))).toEqual([]);
    expect(ba.size + la.size).toBe(knownRegionKeys().length);
  });

  it("keys are stored normalised, so lookups cannot miss on case", () => {
    for (const key of knownRegionKeys()) {
      expect(key).toBe(key.trim().toLowerCase());
    }
  });
});
