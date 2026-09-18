"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { assertLocation, assertRole, LEDGER_ROLES } from "@/lib/ops/session";
import { markDelivered } from "@/lib/delivery";
import { carrierDeliveryDay, carrierDeliveryProblem } from "@/lib/ops/carrierDelivery";
import { pacificDayRange } from "@/lib/scheduling";
import { kickJobs } from "@/lib/jobs/kick";

export async function markCarrierDeliveredAction(
  _previous: { error?: string; success?: boolean }, formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  try {
    const user = await assertRole(LEDGER_ROLES);
    const orderId = String(formData.get("orderId") ?? "");
    const order = await db.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { account: { select: { region: true } }, shipment: true, lines: true },
    });
    const from = order.shipment?.fromLocationId ?? order.inventorySource;
    if (from) await assertLocation(user, from);
    const problem = carrierDeliveryProblem(order);
    if (problem) return { error: problem };
    await markDelivered({
      orderId,
      deliveredAt: pacificDayRange(carrierDeliveryDay(order.scheduledFor!)).start,
      deliveredByUserId: user.id,
      actor: "ops",
      carrierName: order.shipment?.carrierName || "Express Wine",
      notes: "Carrier delivery confirmed in Ops for the scheduled delivery day.",
    });
    kickJobs();
    for (const path of ["/ops/orders", `/ops/orders/${orderId}`, "/ops", "/ops/inventory"]) revalidatePath(path);
    return { success: true };
  } catch (error) {
    console.error("Carrier delivery confirmation failed", error);
    return { error: "Could not finish confirmation. Refresh the order to check its status before trying again." };
  }
}
