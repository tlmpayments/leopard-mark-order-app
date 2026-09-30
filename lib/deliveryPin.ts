import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { DELIVERY_ROLES } from "@/lib/ops/roles";
import { HUB_PIN_REP_NAME } from "@/lib/ops/hubPin";

export interface DeliveryPinRep {
  id: string;
  name: string;
  role: string;
}

/**
 * The delivery site's sign-in: four digits, no name.
 *
 * Asking a driver for his name on a phone in a truck is friction with no
 * payoff, so the PIN alone has to say who is at the door. That only works if
 * a PIN identifies exactly one person, so this refuses rather than guesses:
 *
 *  - no match            -> no sign-in;
 *  - two people, one PIN -> no sign-in (scripts/set-delivery-pin.ts refuses to
 *    create that situation, and this is the belt to its braces);
 *  - the shared Ops Hub account never matches here -- its PIN is a different
 *    credential for a different door.
 *
 * Which PIN counts for a person: their `deliveryPinHash` if they have one,
 * otherwise their ordinary `pinHash`. An admin's short, easy-to-type delivery
 * PIN therefore lives apart from the PIN that protects /admin/login.
 *
 * Every candidate is compared, with no early exit, so the response time does
 * not say how many people have a PIN or which one matched.
 *
 * A person who has not set a PIN yet cannot use this: the first-sign-in "type
 * any four digits and they become yours" step needs a name to attach to.
 */
export async function verifyDeliveryPin(pin: string): Promise<DeliveryPinRep | null> {
  const clean = String(pin ?? "").trim();
  if (!/^\d{4}$/.test(clean)) return null;

  const candidates = await db.rep.findMany({
    where: {
      active: true,
      role: { in: [...DELIVERY_ROLES] },
      OR: [{ deliveryPinHash: { not: null } }, { pinHash: { not: null } }],
      NOT: { name: HUB_PIN_REP_NAME },
    },
    select: { id: true, name: true, role: true, pinHash: true, deliveryPinHash: true },
  });

  const matches: DeliveryPinRep[] = [];
  for (const rep of candidates) {
    const hash = rep.deliveryPinHash ?? rep.pinHash;
    if (hash && (await bcrypt.compare(clean, hash))) {
      matches.push({ id: rep.id, name: rep.name, role: rep.role });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
