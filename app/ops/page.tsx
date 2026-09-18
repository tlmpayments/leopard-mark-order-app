import Link from "next/link";
import { db } from "@/lib/db";
import { todayYmd } from "@/lib/routes";
import { pacificDayRange } from "@/lib/scheduling";
import { money, shortDate } from "@/lib/ops/format";
import { sheetLink } from "@/lib/ops/sourceLinks";
export const dynamic = "force-dynamic";
export default async function Home() {
  const day = todayYmd();
  const { start, end } = pacificDayRange(day);
  const [incoming, scheduled, accounts, documents] = await Promise.all([
    db.order.findMany({ where: { scheduledFor: null, deliveredAt: null, deliveryDate: null, NOT: { invoice: { is: { stripeInvoiceId: { startsWith: "sheet:" } } } }, status: { notIn: ["cancelled", "rejected", "expired", "draft"] } }, include: { account: { select: { businessName: true, region: true } }, lines: { include: { product: { select: { productName: true, formatLabel: true } } } } }, orderBy: { createdAt: "desc" } }),
    db.order.findMany({ where: { scheduledFor: { gte: start, lt: end }, status: { notIn: ["cancelled", "rejected", "expired"] } }, include: { account: { select: { businessName: true } } }, orderBy: { scheduledFor: "asc" } }),
    db.account.count(), db.archivedDocument.count(),
  ]);
  return <>
    <div className="page-head"><div><h1>Today at Leopard Mark</h1><p>{shortDate(start)} · Orders, warehouse stock and delivery paperwork.</p></div><a className="btn primary" href={`/api/documents/print?day=${day}`} target="_blank" rel="noopener noreferrer">Print the day</a></div>
    <div className="home-shortcuts"><Link href="/ops/orders"><strong>{incoming.length}</strong><span>Orders to review</span></Link><Link href="/ops/deliveries"><strong>{scheduled.length}</strong><span>Deliveries today</span></Link><Link href="/ops/accounts"><strong>{accounts}</strong><span>Customer accounts</span></Link><Link href="/ops/documents"><strong>{documents}</strong><span>Saved document versions</span></Link></div>
    <section className="panel flush"><div className="panel-head"><h2>Needs review</h2><Link href="/ops/orders">Open order inbox</Link></div><div className="tblwrap"><table className="tbl"><thead><tr><th>Account</th><th>Order</th><th>Beer / glassware</th><th className="r">Total</th><th>Next step</th></tr></thead><tbody>{incoming.slice(0, 12).map(o => <tr key={o.id}><td><b>{o.account.businessName}</b><div className="small muted">{o.account.region || "Unassigned"}</div></td><td><Link href={`/ops/orders/${o.id}`}>{o.invoiceNumber ?? "Open order"}</Link></td><td>{o.lines.map(l => <div key={l.id}>{l.qty} × {l.product.productName} <span className="small muted">{l.product.formatLabel}</span></div>)}</td><td className="r num">{money(o.lines.reduce((total, line) => total + Number(line.lineTotal), 0))}</td><td><Link className="btn primary" href={`/ops/orders/${o.id}#schedule`}>Schedule</Link></td></tr>)}</tbody></table>{!incoming.length && <div className="empty">No current orders awaiting review. Check the inbox for historical records.</div>}</div></section>
    <div className="grid g2" style={{ marginTop: 24 }}><section className="panel"><div className="panel-head"><h2>Warehouse stock</h2><Link href="/ops/inventory">View inventory</Link></div><p>Sunlight Groove, Cantinesca and glassware by warehouse. Review dated reports and follow each recorded lot movement.</p><a href={sheetLink("Inventory Ledger")} target="_blank" rel="noopener noreferrer">Open source ledger</a></section><section className="panel"><div className="panel-head"><h2>Los Angeles billing pilot</h2><Link href="/ops/billing?market=LA">Review billing</Link></div><p>Check customer details and Stripe setup. Prepare invoices and save them online. Sending remains paused.</p><Link href="/ops/accounts?market=LA">Review LA accounts</Link></section></div>
  </>;
}
