import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

// The lookup is the only thing that touches the database, so stub it and test
// the policy: exactly one match signs in, everything else does not.
const findMany = vi.fn();
vi.mock("@/lib/db", () => ({ db: { rep: { findMany: (...a: unknown[]) => findMany(...a) } } }));

import { verifyDeliveryPin } from "@/lib/deliveryPin";

const hash = (pin: string | null) => (pin === null ? null : bcrypt.hashSync(pin, 4));
const row = (id: string, name: string, role: string, pin: string | null, deliveryPin: string | null = null) => ({
  id,
  name,
  role,
  pinHash: hash(pin),
  deliveryPinHash: hash(deliveryPin),
});

beforeEach(() => findMany.mockReset());

describe("delivery PIN sign-in", () => {
  it("signs in the one person who has that PIN", async () => {
    findMany.mockResolvedValue([row("1", "Jack Begley", "admin", "0000"), row("2", "Jose Arreola", "driver", "4821")]);
    expect(await verifyDeliveryPin("4821")).toEqual({ id: "2", name: "Jose Arreola", role: "driver" });
    expect(await verifyDeliveryPin("0000")).toEqual({ id: "1", name: "Jack Begley", role: "admin" });
  });

  it("uses a person's delivery PIN instead of their ordinary one when they have both", async () => {
    // Jack's real PIN protects /admin/login; 0000 opens delivery only.
    findMany.mockResolvedValue([row("1", "Jack Begley", "admin", "5839", "0000")]);
    expect(await verifyDeliveryPin("0000")).toEqual({ id: "1", name: "Jack Begley", role: "admin" });
    expect(await verifyDeliveryPin("5839")).toBeNull();
  });

  it("refuses a PIN nobody has", async () => {
    findMany.mockResolvedValue([row("1", "Jack Begley", "admin", "0000")]);
    expect(await verifyDeliveryPin("1234")).toBeNull();
  });

  it("refuses a PIN two people share rather than picking one", async () => {
    findMany.mockResolvedValue([row("1", "Jack Begley", "admin", "7777"), row("2", "Jose Arreola", "driver", "7777")]);
    expect(await verifyDeliveryPin("7777")).toBeNull();
  });

  it("refuses anything that is not exactly four digits, without touching the database", async () => {
    for (const bad of ["", "123", "12345", "abcd", "12 4", "١٢٣٤"]) expect(await verifyDeliveryPin(bad)).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("only considers active delivery roles with a PIN set, and never the shared hub account", async () => {
    findMany.mockResolvedValue([]);
    await verifyDeliveryPin("0000");
    const where = findMany.mock.calls[0][0].where;
    expect(where.active).toBe(true);
    expect(where.role.in).toEqual(["admin", "ops", "warehouse", "driver"]);
    expect(where.OR).toEqual([{ deliveryPinHash: { not: null } }, { pinHash: { not: null } }]);
    expect(where.NOT).toEqual({ name: "Ops Hub" });
  });
});
