import Link from "next/link";
import { CarrierDeliveryButton } from "./CarrierDeliveryButton";
import { carrierDeliveryDay, carrierDeliveryProblem } from "@/lib/ops/carrierDelivery";
import { deliveryRegionFor } from "@/lib/deliveryRegion";
import { todayYmd } from "@/lib/routes";
import { pacificDayRange } from "@/lib/scheduling";
import { loadOrders, type OpsOrder } from "@/lib/ops/queries";
import { availableForDelivery, type AvailabilityRow } from "@/lib/inventory";
import { inMarket, marketParam } from "@/lib/ops/scope";
import { sheetLink } from "@/lib/ops/sourceLinks";
import { money, shortDate } from "@/lib/ops/format";
import { MarketFilter } from "../_components/MarketFilter";
export const dynamic = "force-dynamic";
export default async function OrdersPage({ searchParams }: PageProps<"/ops/orders">) {
  const params = await searchParams;
  const market = marketParam(params.market);
  const [all, availability] = await Promise.all([loadOrders({ status: { notIn: ["cancelled", "rejected", "expired", "draft"] } }), availableForDelivery()]);
  const orders = all.filter(o => inMarket(o.account.region, market));
  const historical = orders.filter(o => o.invoice?.stripeInvoiceId.startsWith("sheet:") && !o.scheduledFor && !o.deliveredAt && !o.deliveryDate);
  const historyIds = new Set(historical.map(o => o.id));
  const needsAction = orders.filter(o => !o.scheduledFor && !o.deliveredAt && !o.deliveryDate && !historyIds.has(o.id));
  const handled = orders.filter(o => o.scheduledFor || o.deliveredAt || o.deliveryDate);
  return <>
    <div className="page-head"><div><h1>Order inbox</h1><p>Review incoming orders, choose stock and schedule delivery.</p></div><a className="btn" href={sheetLink("Sales")} target="_blank" rel="noopener noreferrer">Open sales sheet</a></div>
    <MarketFilter path="/ops/orders" market={market} />
    {market === "BA" && <p className="small muted">Express Wine deliveries: schedule the order, then mark it delivered here on its delivery day. No driver app or photo is required. Invoice sending is paused.</p>}
    <p className="small muted">Past delivery dates from the sheet count as delivered here, per your reporting convention. This does not trigger stock deductions or invoice sending.</p>
    <section className="inbox-group"><div className="inbox-heading"><h2>Needs review</h2><span className="pill neutral">{needsAction.length}</span></div><OrderRows orders={needsAction} availability={availability} incoming /></section>
    {!!historical.length && <details className="panel" style={{ marginBottom: 24 }}><summary>Historical records · delivery dates need reconciliation ({historical.length})</summary><p>These imported invoice records have no delivery dates in the app. Check the source sheet before scheduling again or changing inventory.</p><OrderRows orders={historical} availability={availability} /></details>}
    <section className="inbox-group"><div className="inbox-heading"><h2>Scheduled &amp; handled</h2><span className="pill good">{handled.length}</span></div><OrderRows orders={handled} availability={availability} /></section>
  </>;
}
function inferredDelivered(order: OpsOrder): boolean {
  return !!order.deliveryDate && order.deliveryDate < pacificDayRange(todayYmd()).start;
}
function stockStatus(order: OpsOrder, availability: AvailabilityRow[]) {
  if (order.deliveredAt || inferredDelivered(order)) return { label: "Delivered", tone: "good" };
  if (!order.inventorySource) return { label: "Choose warehouse", tone: "neutral" };
  const wanted = new Map<string, number>();
  for (const line of order.lines) wanted.set(line.productId, (wanted.get(line.productId) ?? 0) + line.qty);
  if (!wanted.size) return { label: "Missing line items", tone: "warn" };
  for (const [productId, qty] of wanted) {
    const stock = availability.find(a => a.productId === productId && a.locationId === order.inventorySource);
    if (!stock) return { label: "Verify stock", tone: "warn" };
    // A scheduled order is already included in reserved stock.
    const freeForThisOrder = stock.available + (order.scheduledFor ? qty : 0);
    if (freeForThisOrder < qty) return { label: "Stock short", tone: "serious" };
  }
  return { label: order.lines.every(l => l.lotNumber || !l.product.isKeg) ? "Stock available" : "Stock available · choose lots", tone: "good" };
}
function OrderRows({ orders, availability, incoming = false }: { orders: OpsOrder[]; availability: AvailabilityRow[]; incoming?: boolean }) {
  return <div className="panel flush"><div className="tblwrap"><table className="tbl inbox-table"><thead><tr><th>Account / order</th><th>Line items</th><th>Warehouse / stock</th><th>Delivery</th><th className="r">Total</th><th>Action</th></tr></thead><tbody>
    {orders.map(o => { const stock = stockStatus(o, availability); return <tr key={o.id} className={incoming ? "incoming-order" : ""}>
      <td><Link href={`/ops/orders/${o.id}`}><b>{o.account.businessName}</b></Link><div className="small muted">{o.invoiceNumber ?? "Number pending"} · {o.account.region ?? "Unassigned"}</div><div className="small muted">{o.salesRep?.name ?? "Rep unassigned"}</div></td>
      <td>{o.lines.map(l => <div className="order-line" key={l.id}><strong>{l.qty} ×</strong> {l.product.productName} <span className="muted">{l.product.formatLabel}</span>{l.lotNumber && <div className="small muted">Lot {l.lotNumber}</div>}</div>)}</td>
      <td><Link href={`/ops/inventory${o.inventorySource ? "?warehouse=" + encodeURIComponent(o.inventorySource) : ""}`}><span className={`pill ${stock.tone}`}>{stock.label}</span></Link><div className="small muted">{o.inventorySource ?? "Not selected"}</div></td>
      <td>{o.deliveredAt ? <>Delivered<div className="small muted">{shortDate(o.deliveredAt)}</div></> : inferredDelivered(o) ? <>Delivered · sheet date<div className="small muted">{shortDate(o.deliveryDate)}</div></> : (o.scheduledFor || o.deliveryDate) ? shortDate(o.scheduledFor || o.deliveryDate) : "Not scheduled"}</td><td className="r num">{money(o.lines.reduce((total, line) => total + Number(line.lineTotal), 0))}</td>
      <td><Link className={`btn ${incoming ? "primary" : ""}`} href={`/ops/orders/${o.id}${incoming ? "#schedule" : ""}`}>{incoming ? "Schedule delivery" : "Open order"}</Link>
        {deliveryRegionFor(o.account.region) === "BA" && !o.deliveredAt && <CarrierDeliveryButton orderId={o.id} day={o.scheduledFor ? carrierDeliveryDay(o.scheduledFor) : null} problem={carrierDeliveryProblem(o)} />}
      </td>
    </tr>; })}
  </tbody></table>{!orders.length && <div className="empty">{incoming ? "No orders waiting to be scheduled." : "Scheduled and delivered orders will appear here."}</div>}</div></div>;
}
