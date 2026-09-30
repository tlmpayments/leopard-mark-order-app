import { redirect } from "next/navigation";
import { requireDeliveryUser } from "@/lib/ops/session";
import type { OpsUser } from "@/lib/ops/session";
import { LEDGER_ROLES } from "@/lib/ops/roles";

/**
 * The admin area's gate, for pages.
 *
 * Signing in is the ordinary delivery sign-in -- one name and PIN per person,
 * not a second credential. What makes someone an admin here is their role: the
 * same set that may build a route in the Ops Hub (LEDGER_ROLES), because it is
 * the same act. A driver who types the address is sent back to his own route;
 * the proxy does the same without a database round trip, and this is the check
 * that counts.
 */
export async function requireDeliveryAdmin(): Promise<OpsUser> {
  const user = await requireDeliveryUser();
  if (!LEDGER_ROLES.includes(user.role)) redirect("/delivery");
  return user;
}
