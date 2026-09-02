import Link from "next/link";
import { db } from "@/lib/db";
import { loadOrders, stageOrders } from "@/lib/ops/queries";
import { linesSummary, shortDate, stamp } from "@/lib/ops/format";

export const dynamic = "force-dynamic";

/**
 * Documents (§8.7) — two clearly labelled modes.
 *
 * The two-numbering-schemes situation is the actual problem being removed here.
 * Today the BOL Maker mints `DR-<yymmdd>-####` with four random digits because
 * it has no write access to the ledger, while the Inventory app mints real
 * sequential per-origin BOL numbers. Both are kept, but the difference is now
 * explicit and it means something: a paperwork-only number says "this document
 * moved no stock", and a real BOL number says "this stock actually moved".
 */
export default async function DocumentsPage() {
  const [orders, logs] = await Promise.all([
    loadOrders({ status: { notIn: ["cancelled", "rejected", "expired"] } }).then(stageOrders),
    db.documentLog.findMany({ orderBy: { updatedAt: "desc" }, take: 40 }),
  ]);

  const attachable = orders.filter((o) => o.scheduledFor && !o.deliveredAt);
  const delivered = orders.filter((o) => o.deliveredAt && o.bolNumber).slice(0, 15);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Documents · bol.tlmbg.co</div>
          <h1>Bill of Lading Maker</h1>
          <p>
            One renderer for both paths. Paperwork-only never touches stock; attaching to a shipment uses the real BOL
            number and, on print, offers to mark the delivery complete.
          </p>
        </div>
        <div className="actions">
          <Link className="btn" href="/docs">
            Paperwork only ↗
          </Link>
          <a className="btn primary" href={`/api/documents/print?day=${today}`} target="_blank" rel="noopener">
            Print today&rsquo;s batch
          </a>
        </div>
      </div>

      <div className="grid g2" style={{ marginBottom: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <h3>Attach to shipment</h3>
            <span className="pill neutral">warehouse · ops</span>
          </div>
          <p className="small muted" style={{ margin: "0 0 10px" }}>
            Pick a planned shipment. The document carries the real{" "}
            <span className="mono">BOL-&lt;Location&gt;-&lt;yymmdd&gt;-&lt;seq&gt;</span> number, minted at the moment
            of delivery so the sequence has no gaps for shipments that get cancelled.
          </p>
          {attachable.length === 0 ? (
            <div className="empty">
              <b>No planned shipments.</b>
              Schedule an order and it appears here.
            </div>
          ) : (
            attachable.map((o) => (
              <div className="ship" key={o.id}>
                <b>
                  {o.account.businessName}{" "}
                  <span className="muted small mono">{o.invoiceNumber ?? ""}</span>
                </b>
                <div className="m">
                  <span>{linesSummary(o.lines)}</span>
                  <span className="num">{shortDate(o.scheduledFor)}</span>
                </div>
                <div className="m">
                  <span className="muted">{o.inventorySource ?? "warehouse tbd"}</span>
                  <span>
                    <a
                      className="btn sm"
                      href={`/api/documents/print?orderId=${o.id}`}
                      target="_blank"
                      rel="noopener"
                    >
                      Print receipt
                    </a>{" "}
                    <Link className="btn sm ghost" href={`/ops/orders/${o.id}`}>
                      Open
                    </Link>
                  </span>
                </div>
              </div>
            ))
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Issued BOLs</h3>
            <span className="small muted">real numbers, real stock movement</span>
          </div>
          {delivered.length === 0 ? (
            <div className="empty">
              <b>No BOLs issued yet.</b>
              A BOL number is minted when a delivery is marked complete.
            </div>
          ) : (
            <div className="tblwrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>BOL #</th>
                    <th>Account</th>
                    <th>Delivered</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {delivered.map((o) => (
                    <tr key={o.id}>
                      <td className="mono small">{o.bolNumber}</td>
                      <td>{o.account.businessName}</td>
                      <td className="small">{shortDate(o.deliveredAt)}</td>
                      <td className="r">
                        <a
                          className="btn sm ghost"
                          href={`/api/documents/print?orderId=${o.id}`}
                          target="_blank"
                          rel="noopener"
                        >
                          Reprint
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <section className="panel flush">
        <div className="panel-head">
          <h3>Previously generated</h3>
          <span className="small muted">paperwork-only · no ledger effect · {logs.length}</span>
        </div>
        {logs.length === 0 ? (
          <div className="empty">
            <b>Nothing generated yet.</b>
            Paperwork-only documents are saved here so they can be reopened, edited and reprinted.
          </div>
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Document #</th>
                  <th>Type</th>
                  <th>Date</th>
                  <th>Summary</th>
                  <th>Attached to</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.docNumber}>
                    <td className="mono small">{l.docNumber}</td>
                    <td className="small">{l.docType === "delivery_receipt" ? "Delivery receipt" : "Straight BOL"}</td>
                    <td className="small">{shortDate(l.date)}</td>
                    <td className="small">{l.summary}</td>
                    <td className="small">
                      {l.shipmentId ? <span className="pill good">shipment</span> : <span className="muted">—</span>}
                    </td>
                    <td className="small mono">{stamp(l.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="spec" style={{ marginTop: 16 }}>
        <b>One renderer.</b> <span className="mono">lib/bol/render.ts</span> is now the only implementation of these
        two documents. It replaces the copy in the Inventory app and the hand-synced copy in the BOL Maker, which had
        already drifted apart — the BOL Maker&rsquo;s version had gained SKU and lot columns and the print rules that
        make the navy bars actually print, so that is the version that was kept.
      </div>
    </>
  );
}
