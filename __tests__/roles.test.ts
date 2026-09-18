/**
 * Role gating (§11): "docs_only cannot reach any ledger write; warehouse is
 * scoped to its locations."
 *
 * The signing-in half of this changed during the Ops Platform build. The
 * Credentials provider used to refuse everyone but admins, which made "can hold
 * a session" and "may do anything" the same question. Five roles now share one
 * PIN login, so the two questions came apart — and these are the assertions
 * that the second one is still answered strictly.
 */
import { describe, expect, it } from "vitest";
// Imported from lib/ops/roles, not lib/ops/session: the policy is pure, and a
// test of it must not need NextAuth's request context to load.
import {
  ADMIN_ROLES,
  DOCS_ROLES,
  HUB_ROLES,
  LEDGER_ROLES,
  canActOnLocation,
  type ScopedUser,
} from "@/lib/ops/roles";
import type { UserRole } from "@/app/generated/prisma/enums";

const ALL_ROLES: UserRole[] = ["admin", "ops", "warehouse", "rep", "docs_only"];

const user = (role: UserRole, locationIds: string[] = []): ScopedUser => ({ role, locationIds });

describe("who may reach which surface", () => {
  it("the hub is admin, ops and warehouse only", () => {
    expect([...HUB_ROLES]).toEqual(["admin", "ops", "warehouse"]);
    expect(HUB_ROLES).not.toContain("docs_only");
    expect(HUB_ROLES).not.toContain("rep");
  });

  it("the paperwork maker is open to every signed-in role", () => {
    // This is the entire purpose of docs_only: print a receipt with a PIN and
    // reach nothing else.
    for (const role of ALL_ROLES) expect(DOCS_ROLES).toContain(role);
  });

  it("ledger writes exclude docs_only and rep", () => {
    expect(LEDGER_ROLES).not.toContain("docs_only");
    expect(LEDGER_ROLES).not.toContain("rep");
    expect([...LEDGER_ROLES]).toEqual(["admin", "ops", "warehouse"]);
  });

  it("automation toggles and settings are admin only", () => {
    expect([...ADMIN_ROLES]).toEqual(["admin"]);
  });

  it("docs_only holds the narrowest possible grant: paperwork and nothing more", () => {
    const grants = {
      hub: HUB_ROLES.includes("docs_only"),
      ledger: LEDGER_ROLES.includes("docs_only"),
      admin: ADMIN_ROLES.includes("docs_only"),
      docs: DOCS_ROLES.includes("docs_only"),
    };
    expect(grants).toEqual({ hub: false, ledger: false, admin: false, docs: true });
  });
});

describe("location scoping", () => {
  it("admin and ops are unscoped — they are accountable for the whole network", () => {
    for (const role of ["admin", "ops"] as UserRole[]) {
      expect(canActOnLocation(user(role), "WH-BEN")).toBe(true);
      expect(canActOnLocation(user(role), "BRW-RICH")).toBe(true);
      expect(canActOnLocation(user(role), "anything-at-all")).toBe(true);
    }
  });

  it("a warehouse user may act only on its own locations", () => {
    const wh = user("warehouse", ["WH-BEN"]);
    expect(canActOnLocation(wh, "WH-BEN")).toBe(true);
    expect(canActOnLocation(wh, "WH-SF")).toBe(false);
    expect(canActOnLocation(wh, "BRW-RICH")).toBe(false);
  });

  it("a warehouse user with no locations assigned can act nowhere", () => {
    // Fail closed. A half-finished setup must not read as "allow everything",
    // which is precisely the gap the Inventory app's README named: "any
    // logged-in user can move stock at any facility".
    expect(canActOnLocation(user("warehouse", []), "WH-BEN")).toBe(false);
  });

  it("a warehouse user with several locations may act on each", () => {
    const wh = user("warehouse", ["WH-BEN", "WH-SF"]);
    expect(canActOnLocation(wh, "WH-BEN")).toBe(true);
    expect(canActOnLocation(wh, "WH-SF")).toBe(true);
    expect(canActOnLocation(wh, "WH-WIL")).toBe(false);
  });

  it("rep and docs_only can act on no location, however many are assigned", () => {
    // Assigning a location to a docs_only user must not become a back door
    // into stock movement.
    for (const role of ["rep", "docs_only"] as UserRole[]) {
      expect(canActOnLocation(user(role, ["WH-BEN", "WH-SF"]), "WH-BEN")).toBe(false);
    }
  });

  it("covers every role, so a new role cannot default to allowed", () => {
    for (const role of ALL_ROLES) {
      const allowed = canActOnLocation(user(role, ["WH-BEN"]), "WH-BEN");
      expect(typeof allowed).toBe("boolean");
      // Only the three ledger roles may ever act on a location.
      expect(allowed).toBe(LEDGER_ROLES.includes(role));
    }
  });
});
