import Link from "next/link";
import { pacificDayRange } from "@/lib/scheduling";
import { db } from "@/lib/db";
import { shortDate, stamp } from "@/lib/ops/format";
import { todayYmd } from "@/lib/routes";
export const dynamic = "force-dynamic";
const labels: Record<string, string> = { invoice: "Invoice", delivery_receipt: "Delivery receipt / BOL", straight_bol: "Straight BOL", print_batch: "Print batch", inventory_report: "Warehouse report" };
export default async function DocumentsPage({ searchParams }: PageProps<"/ops/documents">) {
  const params = await searchParams;
  const q = String(params.q ?? "").trim();
  const type = String(params.type ?? "all");
  const orderId = typeof params.orderId === "string" ? params.orderId : undefined;
  const accountId = typeof params.accountId === "string" ? params.accountId : undefined;
  const [archive, legacy, scheduled] = await Promise.all([
    db.archivedDocument.findMany({ where: {
      ...(q ? { OR: [{ docNumber: { contains: q, mode: "insensitive" } }, { summary: { contains: q, mode: "insensitive" } }] } : {}),
      ...(type !== "all" && labels[type] ? { docType: type } : {}), ...(orderId ? { orderId } : {}), ...(accountId ? { accountId } : {}),
    }, orderBy: { createdAt: "desc" }, select: {id:true,docNumber:true,docType:true,summary:true,createdAt:true,orderId:true,accountId:true} }),
    db.documentLog.findMany({ orderBy: { date: "desc" }, select: { docNumber: true, docType: true, summary: true, date: true } }),
    db.order.findMany({ where: { scheduledFor: { gte: pacificDayRange(todayYmd()).start }, deliveredAt: null, status: { notIn: ["cancelled", "rejected", "expired"] } }, include: { account: { select: { businessName: true } } }, orderBy: { scheduledFor: "asc" } }),
  ]);
  const archivedNumbers = new Set(archive.map(d => d.docNumber));
  const older = orderId || accountId ? [] : legacy.filter(d => !archivedNumbers.has(d.docNumber) && (type === "all" || d.docType === type) && (!q || (d.docNumber + " " + d.summary).toLowerCase().includes(q.toLowerCase())));
  return <>
    <div className="page-head"><div><h1>Documents</h1><p>The company filing cabinet. Saved online and available to signed-in teammates.</p></div><div className="actions"><Link className="btn" href="/docs">Prepare BOL</Link><Link className="btn primary" href="/docs/invoice">Prepare invoice</Link></div></div>
    <form action="/api/documents/print" target="_blank" className="list-tools"><label>Print the day <input type="date" name="day" defaultValue={todayYmd()} required /></label><button className="btn" type="submit">Open day’s paperwork</button></form>
    <form className="list-tools"><input name="q" aria-label="Search documents" placeholder="Find document number or customer" defaultValue={q} />
      {orderId && <input name="orderId" type="hidden" value={orderId} />}{accountId && <input name="accountId" type="hidden" value={accountId} />}
      <select name="type" aria-label="Document type" defaultValue={type}><option value="all">All documents</option>{Object.entries(labels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><button className="btn">Search</button><span className="muted">{archive.length} saved versions</span></form>
    <div className="panel flush"><div className="tblwrap"><table className="tbl"><thead><tr><th>Document #</th><th>Type</th><th>Customer / summary</th><th>Saved</th><th>Links</th></tr></thead><tbody>
    {archive.map(d => <tr key={d.id}><td><a href={`/api/documents/archive/${d.id}`} target="_blank" rel="noopener noreferrer"><b>{d.docNumber}</b></a></td><td>{labels[d.docType] ?? d.docType}</td><td>{d.summary}</td><td className="small">{stamp(d.createdAt)}</td><td><div className="actions"><a href={`/api/documents/archive/${d.id}?download=1`}>Download</a>{d.orderId && <Link href={`/ops/orders/${d.orderId}`}>Order</Link>}{d.accountId && <Link href={`/ops/accounts/${d.accountId}`}>Account</Link>}</div></td></tr>)}
    {older.map(d => <tr key={d.docNumber}><td><a href={`/api/documents/paperwork/${encodeURIComponent(d.docNumber)}`} target="_blank" rel="noopener noreferrer">{d.docNumber}</a></td><td>{labels[d.docType] ?? d.docType}</td><td>{d.summary}</td><td>{shortDate(d.date)}</td><td><span className="pill neutral">Saved data · render on open</span></td></tr>)}
    </tbody></table>{!archive.length && !older.length && <div className="empty">No saved documents match. Prepare an invoice or BOL to start the archive.</div>}</div></div>
    <p className="small muted">Each saved version retains its original content and document number. Download the printable file or open it and choose Save as PDF. Documents are stored in the app’s online database; Google Drive copies are not connected yet.</p>
    {!!scheduled.length && <details className="panel" style={{ marginTop: 24 }}><summary>Upcoming delivery paperwork ({scheduled.length})</summary><div className="tblwrap"><table className="tbl"><thead><tr><th>Order</th><th>Account</th><th>Scheduled</th><th>Paperwork</th></tr></thead><tbody>{scheduled.map(o => <tr key={o.id}><td><Link href={`/ops/orders/${o.id}`}>{o.invoiceNumber ?? "Open order"}</Link></td><td>{o.account.businessName}</td><td>{shortDate(o.scheduledFor)}</td><td><a href={`/api/documents/print?orderId=${o.id}`} target="_blank" rel="noopener noreferrer">Open / save BOL</a></td></tr>)}</tbody></table></div></details>}
  </>;
}
