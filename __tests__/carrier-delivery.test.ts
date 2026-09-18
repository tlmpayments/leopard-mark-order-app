import { describe, expect, it } from "vitest";
import { carrierDeliveryDay, carrierDeliveryProblem, type CarrierOrder } from "@/lib/ops/carrierDelivery";
const now = new Date("2026-09-10T18:00:00Z");
const order: CarrierOrder = { account: { region: "San Francisco" }, scheduledFor: new Date("2026-09-10T00:00:00Z"), deliveredAt: null, status: "scheduled", blockedReason: null, inventorySource: "WH-SF", shipment: null, lines: [{ qty: 2 }] };
describe("SF Bay carrier delivery", () => {
  it("allows delivery on the scheduled Pacific day", () => expect(carrierDeliveryProblem(order, now)).toBeNull());
  it("uses the booked day even when confirmed later", () => expect(carrierDeliveryDay(order.scheduledFor!)).toBe("2026-09-10"));
  it("handles timed schedules and midnight UTC legacy dates", () => {
    expect(carrierDeliveryDay(new Date("2026-09-11T01:00:00Z"))).toBe("2026-09-10");
    expect(carrierDeliveryDay(new Date("2026-11-01T17:00:00Z"))).toBe("2026-11-01");
  });
  it.each(["Los Angeles", "Orange County", null])("excludes driver region %s", region => expect(carrierDeliveryProblem({ ...order, account: { region } }, now)).toMatch(/SF Bay/));
  it("refuses future and unscheduled deliveries", () => {
    expect(carrierDeliveryProblem({ ...order, scheduledFor: new Date("2026-09-11T00:00:00Z") }, now)).toMatch(/scheduled delivery day/);
    expect(carrierDeliveryProblem({ ...order, scheduledFor: null }, now)).toMatch(/Schedule/);
  });
  it("refuses duplicate, cancelled, held and incomplete orders", () => {
    expect(carrierDeliveryProblem({ ...order, deliveredAt: now }, now)).toMatch(/Already/);
    expect(carrierDeliveryProblem({ ...order, status: "cancelled" }, now)).toBeTruthy();
    expect(carrierDeliveryProblem({ ...order, blockedReason: "credit_hold" }, now)).toBeTruthy();
    expect(carrierDeliveryProblem({ ...order, inventorySource: null }, now)).toBeTruthy();
    expect(carrierDeliveryProblem({ ...order, lines: [] }, now)).toBeTruthy();
  });
});
