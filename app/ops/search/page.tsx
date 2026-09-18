import Link from "next/link";
import { db } from "@/lib/db";
import { money, shortDate } from "@/lib/ops/format";

export const dynamic = "force-dynamic";

/**
 * Global search (§8): accounts, orders, invoice #, BOL # and lot #.
 *
 * One term, searched across the five things an operator actually has in hand
 * when someone phones up — a business name, an invoice number off a piece of
 * paper, a BOL number, or a lot code off a keg collar.
 */
export default async function SearchPage({ searchParams }: PageProps<"/ops/search">) {
  const params = await searchParams;
  const q = (Array.isArray(params.q) ? params.q[0] : params.q)?.trim() ?? "";

  if (!q) {
    return (
      <div className="state">
        <b>Search for anything you have in hand.</b>
        <span>A business name, an invoice number, a BOL number, or a lot code.</span>
      </div>
    );
  }

  const [accounts, orders, shipments, lots] = await Promise.all([
    db.account.findMany({
      where: {
        OR: [
          { businessName: { contains: q, mode: "insensitive" } },
          { legalEntity: { contains: q, mode: "insensitive" } },
          { licenseNumber: { contains: q, mode: "insensitive" } },
        ],
      },
      take: 15,
      orderBy: { businessName: "asc" },
    }),
    db.order.findMany({
      where: {
        OR: [
          { invoiceNumber: { contains: q, mode: "insensitive" } },
          { id: { contains: q, mode: "insensitive" } },
          { bolNumber: { contains: q, mode: "insensitive" } },
        ],
      },
      include: { account: { select: { businessName: true } }, lines: true },
      take: 15,
      orderBy: { createdAt: "desc" },
    }),
    db.shipment.findMany({
      where: { bolNumber: { contains: q, mode: "insensitive" } },
      include: { account: { select: { businessName: true } } },
      take: 15,
    }),
    db.inventoryEvent.findMany({
      where: { lotNumber: { contains: q, mode: "insensitive" } },
      include: {
        product: { select: { skuCode: true } },
        account: { select: { businessName: true } },
      },
      take: 15,
      orderBy: { occurredAt: "desc" },
    }),
  ]);

  const total = accounts.length + orders.length + shipments.length + lots.length;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Search</div>
          <h1>&ldquo;{q}&rdquo;</h1>
          <p>
            {total} match{total === 1 ? "" : "es"} across accounts, orders, BOL numbers and lot codes.
          </p>
        </div>
      </div>

      {total === 0 ? (
        <div className="state">
          <b>Nothing matches.</b>
          <span>Search covers business names, licence numbers, invoice numbers, order ids, BOL numbers and lot codes.</span>
        </div>
      ) : null}

      {accounts.length ? (
        <section className="panel flush" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <h3>Accounts</h3>
            <span className="small muted">{accounts.length}</span>
          </div>
          <div className="tblwrap">
            <table className="tbl">
              <tbody>
                {accounts.map((a) => (
                  <tr className="row" key={a.id}>
                    <td>
                      <Link href={`/ops/accounts/${a.id}`}>
                        <b>{a.businessName}</b>
                      </Link>
                    </td>
                    <td>{a.region ? <span className="region">{a.region}</span> : "—"}</td>
                    <td className="small mono muted">{a.licenseNumber ?? "no licence #"}</td>
                    <td className="small">{a.licenseStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {orders.length ? (
        <section className="panel flush" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <h3>Orders</h3>
            <span className="small muted">{orders.length}</span>
          </div>
          <div className="tblwrap">
            <table className="tbl">
              <tbody>
                {orders.map((o) => (
                  <tr className="row" key={o.id}>
                    <td className="mono">
                      <Link href={`/ops/orders/${o.id}`}>{o.invoiceNumber ?? o.id.slice(0, 10)}</Link>
                    </td>
                    <td>
                      <b>{o.account.businessName}</b>
                    </td>
                    <td className="small">{o.status}</td>
                    <td className="small mono muted">{o.bolNumber ?? "—"}</td>
                    <td className="r num">
                      {money(o.lines.reduce((s, l) => s + Number(l.lineTotal), 0))}
                    </td>
                    <td className="small">{shortDate(o.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {shipments.length ? (
        <section className="panel flush" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <h3>Shipments &amp; BOLs</h3>
            <span className="small muted">{shipments.length}</span>
          </div>
          <div className="tblwrap">
            <table className="tbl">
              <tbody>
                {shipments.map((s) => (
                  <tr className="row" key={s.id}>
                    <td className="mono">{s.bolNumber}</td>
                    <td>{s.account?.businessName ?? s.toLocationId ?? "—"}</td>
                    <td className="small">{s.status}</td>
                    <td className="small">{shortDate(s.deliveredAt ?? s.scheduledFor)}</td>
                    <td className="r">
                      {s.orderId ? (
                        <Link className="btn sm ghost" href={`/ops/orders/${s.orderId}`}>
                          Order ↗
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {lots.length ? (
        <section className="panel flush">
          <div className="panel-head">
            <h3>Lot codes</h3>
            <span className="small muted">{lots.length} ledger events</span>
          </div>
          <div className="tblwrap">
            <table className="tbl">
              <tbody>
                {lots.map((e) => (
                  <tr key={e.id}>
                    <td className="mono small">{e.lotNumber}</td>
                    <td className="mono small">{e.product.skuCode}</td>
                    <td className="small">{e.type}</td>
                    <td>{e.account?.businessName ?? e.toLocationId ?? e.fromLocationId ?? "—"}</td>
                    <td className="r num">{e.qty}</td>
                    <td className="small">{shortDate(e.occurredAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
