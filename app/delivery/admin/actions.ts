"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { assertLocation, assertRole, LEDGER_ROLES } from "@/lib/ops/session";
import { cancelRoute, createRoute } from "@/lib/routes";
import { deliveryDefaults } from "@/lib/deliveryBuilder";

/**
 * Route-building actions for the delivery site's admin area.
 *
 * The building itself -- adding and removing stops, calculating the path,
 * pushing to the driver -- is the Ops Hub's own set of actions
 * (app/ops/deliveries/builder-actions.ts), shared rather than copied so there
 * is one place that decides what a valid route is. What lives here is only
 * what is specific to this entrance: creating a route from scratch, cancelling
 * one, and browsing the whole account list.
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function validDay(value: string): boolean {
  return YMD.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

export async function createAdminRouteAction(formData: FormData): Promise<void> {
  const user = await assertRole(LEDGER_ROLES);
  const ymd = String(formData.get("day") ?? "");
  if (!validDay(ymd)) throw new Error("Pick a day for the route.");
  const name = String(formData.get("name") ?? "").trim().slice(0, 120);
  const { warehouse, driver } = await deliveryDefaults();
  await assertLocation(user, warehouse.id);
  const route = await createRoute({
    ymd,
    region: "LA",
    warehouseId: warehouse.id,
    driverId: driver.id,
    name: name || `${driver.name.split(" ")[0]}’s delivery`,
  });
  revalidatePath("/delivery/admin");
  revalidatePath("/ops/deliveries");
  redirect(`/delivery/admin/routes/${route.id}`);
}

export async function cancelAdminRouteAction(formData: FormData): Promise<void> {
  await assertRole(LEDGER_ROLES);
  const routeId = String(formData.get("routeId"));
  await cancelRoute(routeId);
  revalidatePath("/delivery/admin");
  revalidatePath("/ops/deliveries");
  revalidatePath("/delivery");
  redirect("/delivery/admin");
}

const PAGE = 40;

export type AccountRow = {
  id: string;
  name: string;
  address: string;
  city: string;
  hasAddress: boolean;
};

/**
 * The account list, A to Z, a page at a time, optionally narrowed by a search.
 *
 * Building a route "from scratch" means starting from the whole list, not from
 * a search box that stays empty until you already know who you want -- so the
 * first page comes back with no query at all. One extra row is fetched to know
 * whether there is another page without a second count query.
 */
export async function listDeliveryAccounts(input: { query: string; offset: number }): Promise<{ accounts: AccountRow[]; hasMore: boolean }> {
  await assertRole(LEDGER_ROLES);
  const q = input.query.trim().slice(0, 100);
  const offset = Number.isInteger(input.offset) && input.offset > 0 ? input.offset : 0;

  const rows = await db.account.findMany({
    where: q
      ? {
          OR: [
            { businessName: { contains: q, mode: "insensitive" } },
            { address: { contains: q, mode: "insensitive" } },
            { deliveryAddress: { contains: q, mode: "insensitive" } },
          ],
        }
      : undefined,
    select: { id: true, businessName: true, address: true, deliveryAddress: true },
    orderBy: [{ businessName: "asc" }, { id: "asc" }],
    skip: offset,
    take: PAGE + 1,
  });

  const accounts = rows.slice(0, PAGE).map((a) => {
    const address = (a.deliveryAddress || a.address || "").trim();
    return {
      id: a.id,
      name: a.businessName,
      address,
      // "1234 Main St, Los Angeles, CA 90001" -> "Los Angeles" for a quick read.
      city: address.split(",")[1]?.trim() ?? "",
      hasAddress: address.length > 0,
    };
  });
  return { accounts, hasMore: rows.length > PAGE };
}
