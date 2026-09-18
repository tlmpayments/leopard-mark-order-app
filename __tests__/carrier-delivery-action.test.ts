import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ load: vi.fn(), mark: vi.fn(), role: vi.fn(), location: vi.fn(), kick: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { order: { findUniqueOrThrow: mock.load } } }));
vi.mock("@/lib/ops/session", () => ({ assertRole: mock.role, assertLocation: mock.location, LEDGER_ROLES: ["ops"] }));
vi.mock("@/lib/delivery", () => ({ markDelivered: mock.mark }));
vi.mock("@/lib/jobs/kick", () => ({ kickJobs: mock.kick }));
vi.mock("next/cache", () => ({ revalidatePath: mock.revalidate }));
import { markCarrierDeliveredAction } from "@/app/ops/orders/carrier-actions";
const order = { id: "o1", account: { region: "San Francisco" }, scheduledFor: new Date("2026-09-10T00:00:00Z"), deliveredAt: null, status: "scheduled", blockedReason: null, inventorySource: "WH-SF", shipment: null, lines: [{ qty: 2 }] };
beforeEach(() => { vi.clearAllMocks(); mock.load.mockResolvedValue(order); mock.role.mockResolvedValue({ id: "ops-1", role: "ops" }); });
const submit = () => { const data = new FormData(); data.set("orderId", "o1"); return markCarrierDeliveredAction({}, data); };
describe("carrier confirmation server action", () => {
  it("records the booked day and Express Wine through the shared delivery ledger", async () => {
    expect(await submit()).toEqual({ success: true });
    expect(mock.mark).toHaveBeenCalledWith(expect.objectContaining({ orderId: "o1", carrierName: "Express Wine", actor: "ops", deliveredByUserId: "ops-1", deliveredAt: new Date("2026-09-10T07:00:00Z") }));
    expect(mock.location).toHaveBeenCalledWith(expect.anything(), "WH-SF");
    expect(mock.revalidate).toHaveBeenCalledWith("/ops/orders");
  });
  it("rejects a forged LA order without writing delivery or starting jobs", async () => {
    mock.load.mockResolvedValue({ ...order, account: { region: "Orange County" } });
    expect((await submit()).error).toMatch(/SF Bay/);
    expect(mock.mark).not.toHaveBeenCalled(); expect(mock.kick).not.toHaveBeenCalled();
  });
  it("does not write a delivery again on a repeated click", async () => {
    mock.load.mockResolvedValue({ ...order, deliveredAt: new Date() });
    expect((await submit()).error).toMatch(/Already/); expect(mock.mark).not.toHaveBeenCalled();
  });
});
