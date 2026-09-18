import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const load = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ db: { order: { findUnique: load } } }));
import { syncDeliveryToSheet } from "@/lib/sheetSync";
const send = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", send); vi.stubEnv("APPS_SCRIPT_URL", "https://example.invalid"); vi.stubEnv("SYNC_SHARED_SECRET", "test"); load.mockResolvedValue({ deliveredAt: new Date("2026-09-10T07:00:00Z"), invoiceNumber: "INV26305" }); send.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("delivery-only Sales update", () => {
  it("sends no quantities, prices or products and requires acknowledged updated rows", async () => {
    send.mockResolvedValue({ ok: true, json: async () => ({ ok: true, rowsUpdated: 2 }) });
    expect(await syncDeliveryToSheet("o1")).toEqual({ ok: true });
    expect(JSON.parse(send.mock.calls[0][1].body)).toEqual({ action: "syncDelivery", secret: "test", orderId: "o1", invoiceNumber: "INV26305", deliveredDate: "2026-09-10" });
  });
  it("keeps an undeployed receiver visible as a failure", async () => {
    send.mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: "Unknown action" }) });
    expect(await syncDeliveryToSheet("o1")).toEqual({ ok: false, error: expect.stringMatching(/pending deployment/) });
  });
  it("rejects the old append endpoint's no-op response", async () => {
    send.mockResolvedValue({ ok: true, json: async () => ({ ok: true, alreadySynced: true }) });
    expect((await syncDeliveryToSheet("o1")).ok).toBe(false);
  });
});
