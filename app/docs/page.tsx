import { db } from "@/lib/db";
import { currentOpsUser } from "@/lib/ops/session";
import { shortDate, stamp } from "@/lib/ops/format";
import { generatePaperworkAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Paperwork-only document maker.
 *
 * Exactly what bol.tlmbg.co does today: print a Delivery Receipt or a Straight
 * BOL for something that is not a tracked shipment, with no ledger effect. The
 * real need behind it is real — people have to print receipts without logging
 * stock — so it is kept rather than removed.
 *
 * What changes is the numbering. The current scheme is four random digits with
 * no collision check, because the old page had no write access to anything.
 * Numbers here are now sequential per day from the same counter table that
 * mints real BOL numbers, so two people printing at once cannot land on the
 * same document number.
 */
export default async function DocsPage({ searchParams }: PageProps<"/docs">) {
  const params = await searchParams;
  const generated = Array.isArray(params.doc) ? params.doc[0] : params.doc;

  const user = await currentOpsUser();
  const [accounts, products, logs] = await Promise.all([
    db.account.findMany({
      select: { id: true, businessName: true, deliveryAddress: true, licenseNumber: true },
      orderBy: { businessName: "asc" },
      take: 500,
    }),
    db.product.findMany({ where: { active: true }, orderBy: { skuCode: "asc" } }),
    db.documentLog.findMany({ orderBy: { updatedAt: "desc" }, take: 25 }),
  ]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Paperwork only · no stock effect</div>
          <h1>New document</h1>
          <p>
            Prints a Delivery Receipt without touching the inventory ledger. Document numbers are sequential per day,
            so two people printing at the same time cannot collide.
          </p>
        </div>
      </div>

      {generated ? (
        <div className="panel" style={{ marginBottom: 16, borderColor: "var(--good)" }}>
          <div className="panel-head">
            <h3>Generated</h3>
            <span className="pill good">saved · no stock change</span>
          </div>
          <p style={{ margin: "0 0 10px" }}>
            Document <span className="mono">{generated}</span> is saved and ready to print.
          </p>
          <a className="btn primary" href={`/api/documents/paperwork/${generated}`} target="_blank" rel="noopener">
            Open &amp; print
          </a>
        </div>
      ) : null}

      <form action={generatePaperworkAction} className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Delivery receipt</h3>
          <span className="small muted">signed by the driver and the account at the dock</span>
        </div>

        <div className="grid g2" style={{ marginBottom: 12 }}>
          <label className="small muted">
            Ship to account
            <select name="accountId" required style={field}>
              <option value="">Select an account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.businessName}
                </option>
              ))}
            </select>
          </label>
          <label className="small muted">
            Date
            <input type="date" name="date" defaultValue={new Date().toISOString().slice(0, 10)} style={field} />
          </label>
        </div>

        <div className="tblwrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Product</th>
                <th>SKU</th>
                <th className="r">Qty</th>
                <th>Lot #</th>
              </tr>
            </thead>
            <tbody>
              {products.slice(0, 12).map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.productName} <span className="small muted">{p.formatLabel}</span>
                  </td>
                  <td className="mono small">{p.skuCode}</td>
                  <td className="r">
                    <input
                      type="number"
                      min="0"
                      name={`qty[${p.id}]`}
                      defaultValue={0}
                      style={{ ...field, width: 72 }}
                    />
                  </td>
                  <td>
                    <input name={`lot[${p.id}]`} placeholder="—" style={{ ...field, width: 130 }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid g2" style={{ marginTop: 12 }}>
          <label className="small muted">
            Reference note
            <input name="refNote" style={field} />
          </label>
          <label className="small muted">
            Notes
            <input name="notes" style={field} />
          </label>
        </div>

        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn primary" type="submit">
            Generate &amp; save
          </button>
          <span className="small muted">
            Signed in as {user?.name}. This writes a document log entry and nothing else — no stock moves.
          </span>
        </div>
      </form>

      <section className="panel flush">
        <div className="panel-head">
          <h3>Previously generated</h3>
          <span className="small muted">{logs.length}</span>
        </div>
        {logs.length === 0 ? (
          <div className="empty">
            <b>Nothing yet.</b>
            Documents you generate are saved here so you can reprint them.
          </div>
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Document #</th>
                  <th>Date</th>
                  <th>Summary</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.docNumber}>
                    <td className="mono small">{l.docNumber}</td>
                    <td className="small">{shortDate(l.date)}</td>
                    <td className="small">{l.summary}</td>
                    <td className="small mono muted">{stamp(l.updatedAt)}</td>
                    <td className="r">
                      <a
                        className="btn sm ghost"
                        href={`/api/documents/paperwork/${l.docNumber}`}
                        target="_blank"
                        rel="noopener"
                      >
                        Print
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

const field: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  background: "var(--surface-2)",
  border: "1px solid var(--line-strong)",
  borderRadius: "var(--r-sm)",
  color: "var(--ink)",
  font: "inherit",
  padding: "6px 9px",
};
