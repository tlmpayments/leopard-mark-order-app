/**
 * Netting rules per event type (§11). Pure — no database.
 *
 * These assertions are the parity contract with the Inventory app's
 * computeStock(): if any sign here changes, the migration's SKU-by-SKU parity
 * check against inventory.tlmbg.co breaks, which is the point.
 */
import { describe, expect, it } from "vitest";
import {
  BOL_TYPES,
  INVENTORY_DIRECTION,
  SINK_TYPES,
  SOURCE_TYPES,
  netStock,
  stockKey,
  type NettableEvent,
} from "@/lib/inventory";

const P = "prod-cnt-half";
const WH = "WH-BEN";
const WH2 = "WH-SF";
const BRW = "BRW-RICH";

const ev = (over: Partial<NettableEvent>): NettableEvent => ({
  type: "BREW",
  productId: P,
  qty: 1,
  ...over,
});

describe("netting per event type", () => {
  it("BREW credits the destination only", () => {
    const s = netStock([ev({ type: "BREW", qty: 12, toLocationId: BRW })]);
    expect(s.get(stockKey(P, BRW))).toBe(12);
    expect(s.size).toBe(1);
  });

  it("INCOMING credits the destination only", () => {
    const s = netStock([ev({ type: "INCOMING", qty: 5, toLocationId: WH })]);
    expect(s.get(stockKey(P, WH))).toBe(5);
  });

  it("TRANSFER debits the origin and credits the destination", () => {
    const s = netStock([ev({ type: "TRANSFER", qty: 20, fromLocationId: BRW, toLocationId: WH })]);
    expect(s.get(stockKey(P, BRW))).toBe(-20);
    expect(s.get(stockKey(P, WH))).toBe(20);
  });

  it.each(SINK_TYPES.map((t) => [t] as const))("%s debits the origin and credits nothing", (type) => {
    const s = netStock([ev({ type, qty: 3, fromLocationId: WH, toLocationId: null })]);
    expect(s.get(stockKey(P, WH))).toBe(-3);
    expect(s.size).toBe(1);
  });

  it("RETURN credits the warehouse the empty came back to", () => {
    const s = netStock([ev({ type: "RETURN", qty: 2, toLocationId: WH })]);
    expect(s.get(stockKey(P, WH))).toBe(2);
  });

  it("skips an untracked end rather than accruing against a phantom location", () => {
    // An INCOMING from a supplier we do not model has no from_location. The
    // legacy add() no-opped on a blank location; so does this.
    const s = netStock([ev({ type: "INCOMING", qty: 4, fromLocationId: null, toLocationId: WH })]);
    expect(s.size).toBe(1);
    expect(s.get(stockKey(P, WH))).toBe(4);
  });

  it("classifies every event type exactly once", () => {
    const all = Object.keys(INVENTORY_DIRECTION);
    expect(all).toHaveLength(9);
    expect(SOURCE_TYPES.every((t) => INVENTORY_DIRECTION[t] === "credit_to")).toBe(true);
    expect(SINK_TYPES.every((t) => INVENTORY_DIRECTION[t] === "debit_from")).toBe(true);
    expect(BOL_TYPES).toContain("DELIVERY");
  });
});

describe("ADJUSTMENT reverses without ever mutating a row", () => {
  it("an ADJUSTMENT crediting the origin cancels a mistaken DELIVERY", () => {
    const events: NettableEvent[] = [
      ev({ type: "INCOMING", qty: 10, toLocationId: WH }),
      ev({ type: "DELIVERY", qty: 4, fromLocationId: WH }),
      // The delivery never happened. Correct it forward, not by editing.
      ev({ type: "ADJUSTMENT", qty: 4, toLocationId: WH }),
    ];
    const s = netStock(events);
    expect(s.get(stockKey(P, WH))).toBe(10);
  });

  it("an ADJUSTMENT with the ends swapped cancels a mistaken TRANSFER", () => {
    const events: NettableEvent[] = [
      ev({ type: "INCOMING", qty: 8, toLocationId: WH }),
      ev({ type: "TRANSFER", qty: 8, fromLocationId: WH, toLocationId: WH2 }),
      ev({ type: "ADJUSTMENT", qty: 8, fromLocationId: WH2, toLocationId: WH }),
    ];
    const s = netStock(events);
    expect(s.get(stockKey(P, WH))).toBe(8);
    expect(s.get(stockKey(P, WH2))).toBe(0);
  });

  it("a single-sided ADJUSTMENT can write stock down", () => {
    const s = netStock([
      ev({ type: "INCOMING", qty: 10, toLocationId: WH }),
      ev({ type: "ADJUSTMENT", qty: 3, fromLocationId: WH }),
    ]);
    expect(s.get(stockKey(P, WH))).toBe(7);
  });
});

describe("a full delivery cycle nets to zero at the warehouse", () => {
  it("brew -> transfer -> deliver leaves the network empty and the customer holding kegs", () => {
    const s = netStock([
      ev({ type: "BREW", qty: 12, toLocationId: BRW }),
      ev({ type: "TRANSFER", qty: 12, fromLocationId: BRW, toLocationId: WH }),
      ev({ type: "DELIVERY", qty: 12, fromLocationId: WH }),
    ]);
    expect(s.get(stockKey(P, BRW))).toBe(0);
    expect(s.get(stockKey(P, WH))).toBe(0);
  });

  it("nets multiple products independently", () => {
    const s = netStock([
      ev({ productId: "a", type: "INCOMING", qty: 5, toLocationId: WH }),
      ev({ productId: "b", type: "INCOMING", qty: 7, toLocationId: WH }),
      ev({ productId: "a", type: "DELIVERY", qty: 2, fromLocationId: WH }),
    ]);
    expect(s.get(stockKey("a", WH))).toBe(3);
    expect(s.get(stockKey("b", WH))).toBe(7);
  });
});
