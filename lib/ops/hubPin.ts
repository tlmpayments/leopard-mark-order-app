/**
 * The Ops Hub's shared PIN.
 *
 * The hub used to be reachable with no login at all (the OPS_PUBLIC_ACCESS
 * flag, now gone). What replaced it is deliberately not a fifth per-person
 * credential: the people who open ops.tlmbg.co, inventory.tlmbg.co and
 * bol.tlmbg.co share one four-digit PIN and type nothing else, because a hub
 * that asks a warehouse hand for his name at 6am is a hub he stops using.
 *
 * The PIN is not in code or in an env var. It is the `pinHash` of one ordinary
 * Rep row -- the same bcrypt field, the same verifier, as every other PIN in
 * the system -- so changing it is `npx tsx scripts/set-hub-pin.ts <pin>` and
 * nothing has to be redeployed. That the session belongs to a real Rep row
 * also matters downstream: `lib/ops/session.ts` re-reads the row on every
 * request, and anything the hub writes has a valid actor to point at.
 *
 * The trade is attribution, and it is a real one: every action taken through
 * this PIN is recorded as "Ops Hub", not as a person. Surfaces where that
 * answer is not good enough keep their own per-person login -- /admin, and the
 * driver's /delivery.
 */

import { verifyRepPin } from "@/lib/repAuth";

/** The Rep row the shared PIN signs in as. Created by scripts/set-hub-pin.ts. */
export const HUB_PIN_REP_NAME = "Ops Hub";

export interface HubPinRep {
  id: string;
  name: string;
  role: string;
}

/**
 * Check a typed PIN against the shared hub account.
 *
 * `allowFirstLoginSet: false` is the important argument. `verifyRepPin`'s
 * first-login branch exists so a person can set their own PIN by typing it
 * once; on a shared account with no PIN set that would hand the hub to whoever
 * knocked first, so an unset PIN here fails closed instead.
 */
export async function verifyHubPin(pin: string): Promise<HubPinRep | null> {
  const result = await verifyRepPin(HUB_PIN_REP_NAME, pin, undefined, {
    allowFirstLoginSet: false,
  });
  return result.ok && result.rep ? result.rep : null;
}
