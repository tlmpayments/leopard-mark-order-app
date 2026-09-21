"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { ADMIN_ROLES, assertRole } from "@/lib/ops/session";

/**
 * Save a facility's street address.
 *
 * The delivery builder routes from the warehouse's `address`, not from its
 * seed lat/lng -- a city centroid is not a loading dock, and Google will
 * happily return a plausible route from the wrong place. When the address is
 * missing the builder says "add it in Settings", so Settings has to actually
 * have the field. This is that field.
 *
 * ADMIN_ROLES rather than LEDGER_ROLES: everything else on this screen is a
 * configuration value the automations read, and the warehouse origin is the
 * one that silently reshapes every future route.
 */
export async function saveFacilityAddressAction(formData: FormData): Promise<void> {
  await assertRole(ADMIN_ROLES);
  const id = String(formData.get("locationId") ?? "").trim();
  const address = String(formData.get("address") ?? "").trim();
  if (!id) throw new Error("Pick a facility.");
  if (address.length > 500) throw new Error("Addresses are at most 500 characters.");

  await db.location.update({ where: { id }, data: { address: address || null } });

  revalidatePath("/ops/settings");
  // The builder reads the origin on render; without these the operator would
  // save the address and still see "Street address needed in Settings".
  revalidatePath("/ops/deliveries");
  revalidatePath("/ops/deliveries/week");
  revalidatePath("/ops/deliveries", "layout");
}
