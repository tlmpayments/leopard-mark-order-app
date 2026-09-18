import Link from "next/link";
import { db } from "@/lib/db";
import { availableForDelivery, kegCustodyBalances, stockByLocation } from "@/lib/inventory";
import { money, stamp } from "@/lib/ops/format";

export const dynamic = "force-dynamic";

/**
 * Inventory (§8.6) — supersedes inventory.tlmbg.co.
 *
 * The matrix is netted from the append-only ledger on read, not from a stored
 * total. "Available for delivery" counts warehouses only and subtracts what
 * scheduled orders have already promised, because two kegs on the shelf that
 * are both on tomorrow's truck are not two kegs you can sell.
 */
export default async function InventoryPage() {
  const [stock, availability, custody, recent, locations] = await Promise.all([
    stockByLocation(),
    availableForDelivery(),
    kegCustodyBalances(),
    db.inventoryEvent.findMany({
      orderBy: { occurredAt: "desc" },
      take: 15,
      include: {
        product: { select: { skuCode: true } },
        account: { select: { businessName: true } },
      },
    }),
    db.location.findMany({ where: { active: true }, orderBy: [{ type: "asc" }, { id: "asc" }] }),
  ]);

  const warehouses = locations.filter((l) => l.type === "warehouse");
  const products = [...new Map(stock.map((s) => [s.productId, s])).values()].sort((a, b) =>
    a.skuCode.localeCompare(b.skuCode),
  );

  const onHandAt = new Map(stock.map((s) => [`${s.productId}|${s.locationId}`, s.onHand]));
  const availAt = new Map(availability.map((a) => [`${a.productId}|${a.locationId}`, a]));

  const kegsOut = custody.reduce((s, c) => s + c.balance, 0);
  const exposure = custody.reduce((s, c) => s + c.depositExposure, 0);
  const alerts = availability.filter((a) => a.belowThreshold || a.available < 0);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Inventory · event-sourced</div>
          <h1>Stock</h1>
          <p>
            Netted from the ledger on read. Corrections are new ADJUSTMENT rows — a ledger row is never edited, so the
            history always adds up to the present.
          </p>
        </div>
        <div className="actions">
          <Link className="btn" href="/ops/inventory/movement">
            Log movement
          </Link>
          <Link className="btn primary" href="/ops/inventory/transfer">
            New transfer
          </Link>
        </div>
      </div>

      {stock.length === 0 ? (
        <div className="state">
          <b>The ledger is empty.</b>
          <span>
            Stock lives in the spreadsheet&rsquo;s Inventory Ledger tab until{" "}
            <span className="mono">scripts/migrate-inventory-from-sheet.ts</span> imports it. That script proves parity
            against the old dashboard SKU by SKU before anything here is trusted.
          </span>
        </div>
      ) : (
        <div className="panel flush">
          <div className="tblwrap">
            <table className="tbl matrix">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Product</th>
                  <th>Format</th>
                  {warehouses.map((w) => (
                    <th className="r wh" key={w.id}>
                      {w.id}
                    </th>
                  ))}
                  <th className="r">Available</th>
                  <th className="r">Reserved</th>
                  <th>vs threshold</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const rows = warehouses.map((w) => availAt.get(`${p.productId}|${w.id}`));
                  const available = rows.reduce((s, r) => s + (r?.available ?? 0), 0);
                  const reserved = rows.reduce((s, r) => s + (r?.reserved ?? 0), 0);
                  const threshold = rows.find((r) => r?.reorderThreshold != null)?.reorderThreshold ?? null;
                  const pct = threshold ? Math.min(100, (available / (threshold * 3)) * 100) : 100;
                  return (
                    <tr className="row" key={p.productId}>
                      <td className="mono small">{p.skuCode}</td>
                      <td>
                        <b>{p.productName}</b>
                      </td>
                      <td>{p.formatLabel}</td>
                      {warehouses.map((w) => {
                        const q = onHandAt.get(`${p.productId}|${w.id}`);
                        const a = availAt.get(`${p.productId}|${w.id}`);
                        return (
                          <td
                            className={`q ${q === 0 || q == null ? "" : a?.available != null && a.available < 0 ? "out" : a?.belowThreshold ? "low" : ""}`}
                            key={w.id}
                          >
                            {q ?? "—"}
                          </td>
                        );
                      })}
                      <td className="r num" style={{ fontWeight: 600 }}>
                        {available}
                      </td>
                      <td className="r num muted">{reserved || "—"}</td>
                      <td style={{ minWidth: 140 }}>
                        {threshold ? (
                          <>
                            <div className="bar-h">
                              <i
                                style={{
                                  width: `${Math.max(0, pct)}%`,
                                  background: available <= threshold ? "var(--warn)" : undefined,
                                }}
                              />
                            </div>
                            <div className="small muted mono" style={{ marginTop: 2 }}>
                              threshold {threshold}
                            </div>
                          </>
                        ) : (
                          <span className="small muted">no threshold set</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid g3" style={{ marginTop: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <h3>Reorder alerts</h3>
            <span className={`pill ${alerts.length ? "warn" : "good"}`}>{alerts.length || "clear"}</span>
          </div>
          {alerts.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              Every SKU is above its reorder threshold at every warehouse.
            </p>
          ) : (
            alerts.slice(0, 6).map((a) => (
              <div className="ship" key={`${a.productId}-${a.locationId}`}>
                <b>
                  {a.skuCode} · {a.locationId}
                </b>
                <div className="m">
                  <span>
                    {a.onHand} on hand, {a.reserved} reserved
                  </span>
                  <span style={{ color: a.available < 0 ? "var(--serious-ink)" : "var(--warn-ink)" }}>
                    {a.available < 0 ? `oversold by ${-a.available}` : `${a.available} available`}
                  </span>
                </div>
              </div>
            ))
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Keg custody</h3>
            <span className="small muted">in trade</span>
          </div>
          <div className="kpi" style={{ border: 0, padding: 0 }}>
            <div className="v">
              {kegsOut}{" "}
              <span className="muted" style={{ fontSize: 16, fontFamily: "var(--font-body)" }}>
                kegs
              </span>
            </div>
            <div className="d">{money(exposure)} deposit exposure across {custody.length} account-SKUs</div>
          </div>
          <p className="small muted" style={{ margin: "8px 0 0" }}>
            Balance per account = Σ(delivered − returned). This is the gap the old Inventory README named outright.
          </p>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Ledger · latest</h3>
            <span className="small muted">append-only</span>
          </div>
          {recent.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              No events yet.
            </p>
          ) : (
            <div className="feed small">
              {recent.map((e) => (
                <div className="ev" key={e.id}>
                  <span className="who system" style={{ fontSize: 8 }}>
                    {e.type.slice(0, 3)}
                  </span>
                  <span className="mono">
                    {e.product.skuCode} ×{e.qty} ·{" "}
                    {e.fromLocationId ?? "—"} → {e.account?.businessName ?? e.toLocationId ?? "—"}
                  </span>
                  <span className="when">{stamp(e.occurredAt)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
