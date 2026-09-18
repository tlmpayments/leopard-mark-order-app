import Link from "next/link";
import { db } from "@/lib/db";
import { inMarket, marketParam, stripeSetup } from "@/lib/ops/scope";
import { sheetLink } from "@/lib/ops/sourceLinks";
import { MarketFilter } from "../_components/MarketFilter";
export const dynamic = "force-dynamic";
export default async function AccountsPage({ searchParams }: PageProps<"/ops/accounts">) {
  const params = await searchParams;
  const market = marketParam(params.market);
  const filter = String(params.filter ?? "all");
  const sort = params.sort === "region" ? "region" : "account";
  const query = String(params.q ?? "").trim();
  const all = await db.account.findMany({ include: { salesRep: { select: { name: true } } }, orderBy: { businessName: "asc" } });
  const accounts = all.filter(a => inMarket(a.region, market) &&
    (!query || `${a.businessName} ${a.region ?? ""} ${a.salesRep?.name ?? ""}`.toLowerCase().includes(query.toLowerCase())) &&
    (filter !== "needs-setup" || !a.stripeCustomerId || !a.stripeDefaultPaymentMethod));
  if (sort === "region") accounts.sort((a, b) => (a.region ?? "~").localeCompare(b.region ?? "~") || a.businessName.localeCompare(b.businessName));
  return <>
    <div className="page-head"><div><h1>Accounts</h1><p>Customer records and Stripe setup, with Los Angeles first.</p></div>
      <a className="btn" href={sheetLink("Customer Accounts")} target="_blank" rel="noopener noreferrer">Open master sheet</a>
    </div>
    <MarketFilter path="/ops/accounts" market={market} params={{ filter, sort, q: query }} />
    <form className="list-tools"><input type="hidden" name="market" value={market} />
      <input aria-label="Search accounts" name="q" placeholder="Search account, region or rep" defaultValue={query} />
      <select aria-label="Stripe setup filter" name="filter" defaultValue={filter}><option value="all">All accounts</option><option value="needs-setup">Needs Stripe setup</option></select>
      <select aria-label="Sort accounts" name="sort" defaultValue={sort}><option value="account">Sort by account</option><option value="region">Sort by region</option></select>
      <button className="btn" type="submit">Apply</button><span className="muted">{accounts.length} accounts</span>
    </form>
    <div className="panel flush"><div className="tblwrap"><table className="tbl account-table"><thead><tr><th>Account</th><th>Region</th><th>Rep</th><th>Stripe setup</th></tr></thead>
      <tbody>{accounts.map(a => { const setup = stripeSetup(a); return <tr key={a.id} className="row"><td><Link href={`/ops/accounts/${a.id}`}><b>{a.businessName}</b></Link></td><td>{a.region || "Unassigned"}</td><td>{a.salesRep?.name || "—"}</td><td><Link href={`/ops/accounts/${a.id}`}><span className={`pill ${setup.tone}`}>{setup.label}</span></Link></td></tr>; })}</tbody>
    </table>{accounts.length === 0 && <div className="empty">No accounts match these filters.</div>}</div></div>
    <p className="small muted">Stripe setup is separate from FinTech relationships and payment history. Open an account to review its billing details and orders.</p>
  </>;
}
