/**
 * The role policy: who may do what.
 *
 * Deliberately free of any framework import. `lib/ops/session.ts` pulls in
 * NextAuth and `next/navigation` to answer "who is this request", which makes
 * it unloadable outside a request context; the policy itself is a handful of
 * set memberships and must stay independently testable. §11 requires a test
 * that `docs_only` cannot reach a ledger write, and that test should not need a
 * web server to run.
 */

import type { UserRole } from "@/app/generated/prisma/enums";

/** Who may open the Ops Hub at all. */
export const HUB_ROLES: readonly UserRole[] = ["admin", "ops", "warehouse"];
/** Who may open the paperwork-only document maker. */
export const DOCS_ROLES: readonly UserRole[] = ["admin", "ops", "warehouse", "rep", "docs_only"];
/** Who may write to the inventory ledger or mark a delivery. */
export const LEDGER_ROLES: readonly UserRole[] = ["admin", "ops", "warehouse"];
/** Who may change automation toggles and settings. */
export const ADMIN_ROLES: readonly UserRole[] = ["admin"];

export interface ScopedUser {
  role: UserRole;
  /** Location ids this user may act on. Meaningful only for `warehouse`. */
  locationIds: string[];
}

/**
 * May this user act on this location?
 *
 * Closes the gap the Inventory app's README names outright: "any logged-in user
 * can move stock at any facility". admin and ops are unscoped because they are
 * accountable for the whole network; a warehouse user is scoped to the
 * locations joined to them; and a warehouse user with no locations assigned can
 * act nowhere — fail closed, so a half-finished setup never reads as "allow
 * everything".
 */
export function canActOnLocation(user: ScopedUser, locationId: string): boolean {
  if (user.role === "admin" || user.role === "ops") return true;
  if (user.role === "warehouse") return user.locationIds.includes(locationId);
  return false;
}
