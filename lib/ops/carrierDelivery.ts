import { deliveryRegionFor } from "@/lib/deliveryRegion";

export interface CarrierOrder {
  account: { region: string | null };
  scheduledFor: Date | null;
  deliveredAt: Date | null;
  status: string;
  blockedReason: string | null;
  inventorySource: string | null;
  shipment: { fromLocationId: string | null } | null;
  lines: readonly { qty: number }[];
}

export function pacificDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(value);
}

// Older scheduling forms saved date-only inputs at midnight UTC. Preserve
// that calendar date; proposals with a time use their Pacific calendar day.
export function carrierDeliveryDay(value: Date): string {
  return value.toISOString().endsWith("T00:00:00.000Z")
    ? value.toISOString().slice(0, 10) : pacificDate(value);
}

export function carrierDeliveryProblem(order: CarrierOrder, now = new Date()): string | null {
  if (deliveryRegionFor(order.account.region) !== "BA") return "Carrier confirmation is for SF Bay orders.";
  if (order.deliveredAt) return "Already delivered.";
  if (!["confirmed", "scheduled"].includes(order.status)) return "This order cannot be marked delivered.";
  if (order.blockedReason) return "Resolve the order's hold first.";
  if (!order.scheduledFor) return "Schedule the Express Wine delivery first.";
  if (carrierDeliveryDay(order.scheduledFor) > pacificDate(now)) return "Available on the scheduled delivery day.";
  if (!order.shipment?.fromLocationId && !order.inventorySource) return "Choose the dispatch warehouse first.";
  if (!order.lines.length || !order.lines.some(line => line.qty > 0)) return "Add the delivery line items first.";
  return null;
}
