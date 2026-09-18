/**
 * Historical SKU code aliasing.
 *
 * The Sales tab spans several generations of product coding, and only recent
 * rows use today's `Product.skuCode`. Importing the order history dropped 180
 * of 284 orders until these mappings existed, so each rule here is load-bearing
 * for whether the hub shows the real business or an empty pipeline.
 *
 * The cases below are the actual codes counted in the live sheet, with their
 * observed frequencies in the comments — not invented examples.
 */
import { describe, expect, it } from "vitest";
import { aliasHistoricalSku } from "@/lib/sheetSkuAlias";

describe("family 1: a current SKU wrapped in a prefix and suffix", () => {
  it.each([
    ["TLM-SGB1AKHB01-M", "SGB1AKHB01"], // 97 lines
    ["TLM-SGB1AKSB01-M", "SGB1AKSB01"], // 11 lines
    ["TLM-SGB1AC1224-6PK", "SGB1AC1224"], // 13 lines
  ])("%s -> %s", (raw, want) => {
    expect(aliasHistoricalSku(raw)).toBe(want);
  });

  it("maps a 6-pack row onto the case SKU", () => {
    // Coarser than the original code, and deliberately so: line quantities and
    // unit prices come from the invoice itself, so no money is distorted — only
    // the SKU attribution — and the alternative is dropping the order.
    expect(aliasHistoricalSku("TLM-SGB1AC1224-6PK")).toBe("SGB1AC1224");
  });
});

describe("family 2: facility . brand - package . size", () => {
  it.each([
    ["TLM.PRO.CNT-KEG.1/2", "CNT1AKHB01"], // 23 lines
    ["TLM.PRO.CNT-KEG.1/6", "CNT1AKSB01"], // 5 lines
    ["TLM.PRO.CNT-CAN.12oz", "CNT1AC1224"], // 7 lines
    ["TLM.EBB.SGB-KEG.1/2", "SGB1AKHB01"], // 17 lines
    ["TLM.EBB.SGB-CAN.12oz", "SGB1AC1224"], // 12 lines
    ["TLM.PRO.GSP-KEG.1/2", "GSP1AKHB01"], // 3 lines
    ["TLM.PRO.GSP-CAN.12oz", "GSP1AC1224"], // 2 lines
    ["TLM.BCH.SGS-CAN.12oz", "SGS1AC1224"], // 2 lines
  ])("%s -> %s", (raw, want) => {
    expect(aliasHistoricalSku(raw)).toBe(want);
  });

  it("drops the contract-brewing facility, which is not part of a SKU today", () => {
    // EBB = East Brother, PRO = Prost, BCH = Beachwood. The same beer brewed at
    // two facilities is one SKU now.
    expect(aliasHistoricalSku("TLM.EBB.SGB-KEG.1/2")).toBe(
      aliasHistoricalSku("TLM.PRO.SGB-KEG.1/2"),
    );
  });

  it("uses one format suffix scheme across every brand", () => {
    for (const brand of ["CNT", "SGB", "SGS", "GSP"]) {
      expect(aliasHistoricalSku(`TLM.PRO.${brand}-KEG.1/2`)).toBe(`${brand}1AKHB01`);
      expect(aliasHistoricalSku(`TLM.PRO.${brand}-KEG.1/6`)).toBe(`${brand}1AKSB01`);
      expect(aliasHistoricalSku(`TLM.PRO.${brand}-CAN.12oz`)).toBe(`${brand}1AC1224`);
    }
  });
});

describe("refuses to guess", () => {
  it("returns null for an ambiguous experimental batch", () => {
    // "Experimental Hazy I" could be XHZ variant B, C or D. Picking one would
    // be a guess presented as data, so the line is dropped and reported.
    expect(aliasHistoricalSku("TLM.BCH.Experimental Hazy I-KEG.1/2")).toBeNull();
  });

  it("returns null for an unrecognised size on a known brand", () => {
    expect(aliasHistoricalSku("TLM.PRO.CNT-KEG.1/4")).toBeNull();
    expect(aliasHistoricalSku("TLM.PRO.CNT-CAN.16oz")).toBeNull();
  });

  it("returns null for a blank or missing code", () => {
    expect(aliasHistoricalSku("")).toBeNull();
    expect(aliasHistoricalSku("   ")).toBeNull();
  });
});

describe("already-current codes pass through untouched", () => {
  it.each([["CNT1AKHB01"], ["SGB1AC1224"], ["GSP1AKSB01"], ["CNT-TAPHANDLE"]])("%s", (sku) => {
    expect(aliasHistoricalSku(sku)).toBe(sku);
  });

  it("upper-cases and trims, so sheet whitespace does not cause a miss", () => {
    expect(aliasHistoricalSku("  cnt1akhb01 ")).toBe("CNT1AKHB01");
  });
});
