import Link from "next/link";
import { db } from "@/lib/db";
import { CHECKLIST_ITEMS, accountChecklist } from "@/lib/ops/checklist";
import { kegCustodyBalances } from "@/lib/inventory";
import { money } from "@/lib/ops/format";
import { licenceExpiryCutoff } from "@/lib/ops/queries";
import { deliveryRegionFor } from "@/lib/deliveryRegion";

export const dynamic = "force-dynamic";

const FILTERS = [
  ["needs-setup", "Needs setup"],
  ["pending", "Pending approval"],
  ["license", "License ≤60d"],
  ["kegs", "Holding kegs"],
  ["hold", "Credit hold"],
  ["all", "All"],
] as const;

/**
 * Accounts (§8.4).
 *
 * The nine-segment setup bar is the point of this screen: it is what gates
 * stage ① → ②, and it says *which* fact is missing rather than a completion
 * percentage, because "5/9" tells an operator nothing they can act on and
 * "no billing email" tells them exactly what to do.
 */
export default async function AccountsPage({ searchParams }: PageProps<"/ops/accounts">) {
  const params = await searchParams;
  const filter = (Array.isArray(params.filter) ? params.filter[0] : params.filter) ?? "needs-setup";

  const [accounts, routeRegions, custody] = await Promise.all([
    db.account.findMany({
      include: {
        contacts: { select: { email: true }, take: 1 },
        salesRep: { select: { name: true } },
        _count: { select: { orders: true } },
      },
      orderBy: { businessName: "asc" },
      take: 400,
    }),
    db.routeSchedule.findMany({ select: { region: true } }),
    kegCustodyBalances(),
  ]);

  const routeRegionSet = new Set(routeRegions.map((r) => r.region));
  // The account stores a city; the schedule is keyed by delivery region.
  const hasRoute = (region: string | null): boolean => {
    const dr = deliveryRegionFor(region);
    return dr != null && routeRegionSet.has(dr);
  };
  const custodyByAccount = new Map<string, { kegs: number; exposure: number; last: Date | null }>();
  for (const c of custody) {
    const cur = custodyByAccount.get(c.accountId) ?? { kegs: 0, exposure: 0, last: null };
    cur.kegs += c.balance;
    cur.exposure += c.depositExposure;
    if (c.lastMovementAt && (!cur.last || c.lastMovementAt > cur.last)) cur.last = c.lastMovementAt;
    custodyByAccount.set(c.accountId, cur);
  }

  const rows = accounts.map((a) => ({
    account: a,
    checklist: accountChecklist({
      ...a,
      contactEmail: a.contacts[0]?.email ?? null,
      regionHasWarehouse: hasRoute(a.region),
    }),
    custody: custodyByAccount.get(a.id) ?? { kegs: 0, exposure: 0, last: null },
  }));

  const soon = licenceExpiryCutoff(60);
  const filtered = rows.filter(({ account: a, checklist, custody: c }) => {
    switch (filter) {
      case "pending":
        return a.approvalStatus === "pending";
      case "license":
        return a.licenseExpiry != null && a.licenseExpiry <= soon;
      case "kegs":
        return c.kegs > 0;
      case "hold":
        return a.creditHold;
      case "all":
        return true;
      default:
        return checklist.doneCount < 9;
    }
  });

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Accounts · {accounts.length}</div>
          <h1>Accounts</h1>
          <p>
            The setup checklist is what gates stage ① → ②. Green segments are done; red ones need someone. These nine
            facts are exactly what the first invoice needs.
          </p>
        </div>
        <div className="actions">
          <div className="seg">
            {FILTERS.map(([key, label]) => (
              <Link key={key} className={filter === key ? "on" : ""} href={`/ops/accounts?filter=${key}`}>
                {label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="state">
          <b>Nothing matches this filter.</b>
          <span>
            {filter === "needs-setup"
              ? "Every account has all nine setup facts on file."
              : "Try another filter."}
          </span>
        </div>
      ) : (
        <div className="panel flush">
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Region</th>
                  <th>Rep</th>
                  <th>Setup</th>
                  <th>Missing</th>
                  <th className="r">Kegs out</th>
                  <th className="r">Deposit exposure</th>
                  <th className="r">Orders</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(({ account: a, checklist: ck, custody: c }) => (
                  <tr className="row" key={a.id}>
                    <td>
                      <Link href={`/ops/accounts/${a.id}`}>
                        <b>{a.businessName}</b>
                      </Link>
                      {a.licenseStatus === "expired" ? <span className="pill serious">license expired</span> : null}
                      {a.creditHold ? <span className="pill serious">credit hold</span> : null}
                      {a.approvalStatus === "pending" ? <span className="pill warn">pending</span> : null}
                    </td>
                    <td>{a.region ? <span className="region">{a.region}</span> : "—"}</td>
                    <td>{a.salesRep?.name ?? "—"}</td>
                    <td>
                      <div
                        className="ck"
                        title={CHECKLIST_ITEMS.map((c2, k) => `${c2}: ${ck.done[k] ? "done" : "missing"}`).join("\n")}
                      >
                        {ck.done.map((ok, k) => (
                          <i key={k} className={ok ? "y" : "n"} />
                        ))}
                      </div>
                      <div className="small muted mono" style={{ marginTop: 3 }}>
                        {ck.doneCount}/9
                      </div>
                    </td>
                    <td className="small" style={{ color: ck.missing.length ? "var(--warn-ink)" : "var(--ink-3)" }}>
                      {ck.missing.length ? ck.missing.slice(0, 3).join(", ") : "—"}
                    </td>
                    <td className="r num">{c.kegs || "—"}</td>
                    <td className="r num">{c.exposure ? money(c.exposure) : "—"}</td>
                    <td className="r num">{a._count.orders}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid g2" style={{ marginTop: 16 }}>
        <div className="spec">
          <b>Why these nine.</b> They are the facts the first Stripe invoice needs in order to send. A missing billing
          email never blocks the order — it blocks the <i>invoice</i>, visibly, at stage ⑤, which is where an operator
          can still do something about it.
        </div>
        <div className="spec">
          <b>License standing is independent of credit standing.</b> An account can be fully paid up and still be
          unable to order. Both gates must pass, and only a person can clear either.
        </div>
      </div>
    </>
  );
}

