import Link from "next/link";
import { money, shortDate } from "@/lib/ops/format";
import { invoicesWithAging } from "@/lib/ops/queries";
import { inMarket, isStripeInvoice, marketParam } from "@/lib/ops/scope";
import { MarketFilter } from "../_components/MarketFilter";
export const dynamic = "force-dynamic";
export default async function BillingPage({ searchParams }: PageProps<"/ops/billing">) {
  const params = await searchParams;
  const market = marketParam(params.market);
  const filter = String(params.filter ?? "all");
  const rows = (await invoicesWithAging()).filter(i => inMarket(i.region, market));
  const verified = rows.filter(i => isStripeInvoice(i.stripeInvoiceId));
  const historical = rows.filter(i => i.stripeInvoiceId.startsWith("sheet:"));
  const open = verified.filter(i => i.status === "open");
  const filtered = rows.filter(i => filter === "all" || (filter === "review" ? i.stripeInvoiceId.startsWith("sheet:") : isStripeInvoice(i.stripeInvoiceId) && i.status === filter));
  return <>
    <div className="page-head"><div><h1>Billing</h1><p>Invoices, account setup and payment records in one place.</p></div><div className="actions">
      <Link className="btn" href={`/ops/accounts?market=${market}`}>Account setup</Link>
      <Link className="btn primary" href="/docs/invoice">Prepare invoice</Link>
    </div></div>
    <div className="notice">Stripe pilot: customer emails and invoice sending are paused. Historical sheet labels do not establish whether an invoice was paid.</div>
    <MarketFilter path="/ops/billing" market={market} params={{ filter }} />
    <div className="billing-summary">
      <Link href={`/ops/billing?market=${market}&filter=open`}><span>Stripe open balance</span><strong>{money(open.reduce((sum, i) => sum + Math.max(0, i.amountDue - i.amountPaid), 0))}</strong><small>{open.length} linked invoices</small></Link>
      <Link href={`/ops/billing?market=${market}&filter=review`}><span>Payment review</span><strong>{historical.length}</strong><small>Historical sheet records</small></Link>
      <Link href={`/ops/accounts?market=${market}&filter=needs-setup`}><span>Stripe migration</span><strong>Account setup</strong><small>Review connections and billing contacts</small></Link>
    </div>
    <nav className="seg" aria-label="Invoice status" style={{ marginBottom: 16 }}>{[["all", "All invoices"], ["review", "Needs reconciliation"], ["draft", "Stripe drafts"], ["open", "Stripe open"], ["paid", "Stripe paid"]].map(([key, label]) => <Link key={key} className={filter === key ? "on" : ""} href={`/ops/billing?market=${market}&filter=${key}`}>{label}</Link>)}</nav>
    <div className="panel flush"><div className="tblwrap"><table className="tbl"><thead><tr><th>Invoice #</th><th>Account</th><th>Region</th><th>Payment status</th><th>Due</th><th className="r">Amount</th><th>Source</th></tr></thead><tbody>
      {filtered.map(i => { const linked = isStripeInvoice(i.stripeInvoiceId); const historical = i.stripeInvoiceId.startsWith("sheet:"); return <tr key={i.id} className="row">
        <td><Link href={`/ops/orders/${i.orderId}`}><b>{i.invoiceNumber ?? i.orderInvoiceNumber ?? "View order"}</b></Link></td>
        <td><Link href={i.accountHref}>{i.businessName}</Link></td><td>{i.region || "Unassigned"}</td>
        <td><span className={`pill ${linked && i.status === "paid" ? "good" : "warn"}`}>{historical ? "Needs reconciliation" : linked ? i.status : "Preparation failed"}</span>{historical && <div className="small muted">Imported label: {i.status}</div>}</td>
        <td>{linked ? shortDate(i.dueDate) : "—"}</td><td className="r num">{money(i.amountDue)}</td>
        <td>{linked && i.hostedInvoiceUrl ? <a href={i.hostedInvoiceUrl} target="_blank" rel="noopener noreferrer">Stripe invoice</a> : <Link href={`/ops/orders/${i.orderId}`}>Order record</Link>}</td>
      </tr>; })}
    </tbody></table>{filtered.length === 0 && <div className="empty">No invoices match these filters.</div>}</div></div>
  </>;
}
