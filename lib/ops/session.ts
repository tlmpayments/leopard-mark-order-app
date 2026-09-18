/**
 * Role gating for the internal surfaces.
 *
 * Signing in with a name and PIN now yields a session for ANY active rep
 * (auth.ts), because five roles share one login. That makes authorisation a
 * per-surface question, answered here and in proxy.ts, rather than something
 * the login itself decided by refusing everyone but admins.
 *
 * Two layers, on purpose:
 *   - proxy.ts keeps the wrong role from *reaching* a page (cheap, and gives a
 *     sensible redirect).
 *   - `requireOpsUser` re-checks inside every server action and page that
 *     mutates anything. The proxy is a convenience; this is the boundary. §11
 *     requires a test that `docs_only` cannot reach a ledger write, and it is
 *     this function that makes that true.
 */

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import type { UserRole } from "@/app/generated/prisma/enums";
import { ADMIN_ROLES, DELIVERY_ROLES, DOCS_ROLES, HUB_ROLES, LEDGER_ROLES, canActOnLocation } from "./roles";

// Re-exported so call sites import the policy and the "who is this" helpers
// from one place, while the policy itself stays loadable without NextAuth.
export { ADMIN_ROLES, DELIVERY_ROLES, DOCS_ROLES, HUB_ROLES, LEDGER_ROLES, canActOnLocation };

export interface OpsUser {
  id: string;
  name: string;
  role: UserRole;
  /** Location ids this user may act on. Empty means "all" for admin/ops. */
  locationIds: string[];
}


export async function currentOpsUser(): Promise<OpsUser | null> {
  return sessionUser();
}

/**
 * The signed-in user: whoever the session's Rep row says they are.
 *
 * Re-read from the database on every request rather than trusted from the JWT,
 * which is what makes deactivating a Rep row -- including the shared "Ops Hub"
 * row that the hub PIN signs in as -- take effect immediately instead of when
 * the token expires.
 */
async function sessionUser(): Promise<OpsUser | null> {
  const session = await auth();
  const repId = session?.repId;
  if (!repId) return null;

  // Re-read the role from the database rather than trusting the JWT copy for
  // authorisation decisions: a role that has been revoked must stop working
  // now, not when the token expires.
  const rep = await db.rep.findUnique({
    where: { id: repId },
    select: { id: true, name: true, role: true, active: true, locations: { select: { locationId: true } } },
  });
  if (!rep || !rep.active) return null;

  return {
    id: rep.id,
    name: rep.name,
    role: rep.role,
    locationIds: rep.locations.map((l) => l.locationId),
  };
}

/**
 * Require one of `allowed`, or redirect. Use in pages.
 *
 * `docs_only` is redirected to /docs rather than to the login page: it is not
 * an authentication failure, it is a user who is exactly where they are
 * allowed to be, just not here.
 */
export async function requireOpsUser(allowed: readonly UserRole[] = HUB_ROLES): Promise<OpsUser> {
  const user = await currentOpsUser();
  // The shared-PIN unlock screen, not /admin/login: the hub and the document
  // maker are what the four digits open (lib/ops/hubPin.ts), and /admin's
  // name + PIN is a different, narrower credential. `next` names the surface
  // being protected, not always "ops" -- /docs uses this same helper, and
  // telling the unlock page the wrong destination is the kind of small lie
  // that becomes a real bug the moment anything reads it.
  if (!user) redirect(`/unlock?next=${allowed === DOCS_ROLES ? "/docs" : "/ops"}`);
  if (!allowed.includes(user.role)) {
    redirect(landingForRole(user.role));
  }
  return user;
}

/**
 * The signed-in driver-surface user, or null. The nullable form of
 * `requireDeliveryUser`, for the shell that has to render the sign-in page too.
 */
export async function currentDeliveryUser(): Promise<OpsUser | null> {
  return sessionUser();
}

/**
 * The driver surface's own gate.
 *
 * Same check as `requireOpsUser(DELIVERY_ROLES)` but it sends an unauthenticated
 * visitor to /delivery/login rather than the hub's admin sign-in, which a driver
 * cannot get past and should never see. Reads the real session, so the open-hub
 * flag never applies here -- see `sessionUser`.
 */
export async function requireDeliveryUser(): Promise<OpsUser> {
  const user = await sessionUser();
  if (!user) redirect("/delivery/login");
  if (!DELIVERY_ROLES.includes(user.role)) redirect(landingForRole(user.role));
  return user;
}

/**
 * Require a role in a server action, throwing rather than redirecting.
 *
 * Actions must throw: a redirect from a mutation would look to the caller like
 * the mutation succeeded and simply navigated.
 */
export async function assertRole(allowed: readonly UserRole[]): Promise<OpsUser> {
  const user = await currentOpsUser();
  if (!user) throw new Error("Not signed in");
  if (!allowed.includes(user.role)) {
    throw new Error(`Role ${user.role} may not perform this action`);
  }
  return user;
}

export async function assertLocation(user: OpsUser, locationId: string): Promise<void> {
  if (!canActOnLocation(user, locationId)) {
    throw new Error(`Role ${user.role} may not act on ${locationId}`);
  }
}

/**
 * The surface a role belongs on. Mirrors proxy.ts's `landingFor` -- kept in
 * both places because the proxy must answer this without a database round
 * trip, and this must answer it after one. A driver who lands on /ops is not
 * an authentication failure; they are a user in the wrong building.
 */
export function landingForRole(role: UserRole | undefined): string {
  if (role === "driver") return "/delivery";
  if (role && HUB_ROLES.includes(role)) return "/ops?denied=1";
  return "/docs";
}
