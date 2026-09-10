import { db } from "@/lib/db";
import { shortDate, stamp } from "@/lib/ops/format";
import { pricingKey } from "@/lib/billing/pricing";
import { InvoiceBuilder, type BuilderAccount, type BuilderProduct } from "../_components/InvoiceBuilder";

export const dynamic = "force-dynamic";

/**
 * The invoice maker (bol.tlmbg.co).
 *
 * Paperwork only, exactly like the delivery receipt next door: it prints an
 * invoice and records it in `document_logs`. It does not create an `Invoice`
 * row, call Stripe or email anybody -- billing a delivered order for real is
 * the hub's job (lib/billing/issue.ts), where there is an order to reconcile
 * the payment against.
 *
 * What it does share is everything that could otherwise drift: the accounts,
 * the product catalogue, per-account pricing, the deposit rates, and the
 * arithmetic itself (`composeInvoice`). Read live on every request -- hence
 * `force-dynamic` -- so a price or an address corrected in the hub is correct
 * here on the next load rather than after a cache expiry.
 */
export default async function InvoiceMakerPage({ searchParams }: PageProps<"/docs/invoice">) {
  const params = await searchParams;
  const generated = Array.isArray(params.doc) ? params.doc[0] : params.doc;

  const [accountRows, productRows, pricingRows, ledgerLots, orderLots, logs] = await Promise.all([
    db.account.findMany({
      select: {
        id: true,
        businessName: true,
        legalEntity: true,
        address: true,
        deliveryAddress: true,
        licenseNumber: true,
        terms: true,
        taxExempt: true,
        salesRep: { select: { name: true } },
        contacts: { select: { phoneE164: true }, orderBy: { createdAt: "asc" }, take: 1 },
      },
      orderBy: { businessName: "asc" },
    }),
    db.product.findMany({ where: { active: true }, orderBy: [{ productName: "asc" }, { skuCode: "asc" }] }),
    db.accountPricing.findMany({ select: { accountId: true, productId: true, price: true } }),
    // Lot numbers the system has already recorded, offered as suggestions so a
    // lot is typed once rather than once per document. Both sources on purpose:
    // the ledger knows lots that moved, the order lines know lots that were
    // billed, and either is a lot somebody may need to invoice again.
    db.inventoryEvent.findMany({
      where: { lotNumber: { not: null } },
      select: { productId: true, lotNumber: true },
      distinct: ["productId", "lotNumber"],
      orderBy: { occurredAt: "desc" },
      take: 200,
    }),
    db.orderLine.findMany({
      where: { lotNumber: { not: null } },
      select: { productId: true, lotNumber: true },
      distinct: ["productId", "lotNumber"],
      orderBy: { id: "desc" },
      take: 200,
    }),
    db.documentLog.findMany({ where: { docType: "invoice" }, orderBy: { updatedAt: "desc" }, take: 25 }),
  ]);

  const accounts: BuilderAccount[] = accountRows.map((a) => ({
    id: a.id,
    businessName: a.businessName,
    legalEntity: a.legalEntity,
    address: a.address,
    deliveryAddress: a.deliveryAddress,
    licenseNumber: a.licenseNumber,
    terms: a.terms,
    taxExempt: a.taxExempt,
    salesRep: a.salesRep?.name ?? null,
    phone: a.contacts[0]?.phoneE164 ?? null,
  }));

  const products: BuilderProduct[] = productRows.map((p) => ({
    id: p.id,
    skuCode: p.skuCode,
    productName: p.productName,
    formatLabel: p.formatLabel,
    formatDetail: p.formatDetail,
    isKeg: p.isKeg,
    depositAmount: p.depositAmount ? Number(p.depositAmount) : null,
    listPrice: Number(p.listPrice),
    upc: p.upc,
  }));

  const pricing: Record<string, number> = {};
  for (const row of pricingRows) pricing[pricingKey(row.accountId, row.productId)] = Number(row.price);

  const lotSuggestions: Record<string, string[]> = {};
  for (const row of [...ledgerLots, ...orderLots]) {
    if (!row.lotNumber) continue;
    const list = (lotSuggestions[row.productId] ??= []);
    if (!list.includes(row.lotNumber)) list.push(row.lotNumber);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Paperwork only · does not bill the customer</div>
          <h1>New invoice</h1>
          <p>
            Same catalogue, same per-account pricing and the same keg-deposit and Net-30-from-delivery maths the
            billing system uses on a real order. Prints and saves the document; nothing is charged or emailed.
          </p>
        </div>
      </div>

      {generated ? (
        <div className="panel" style={{ marginBottom: 16, borderColor: "var(--good)" }}>
          <div className="panel-head">
            <h3>Generated</h3>
            <span className="pill good">saved · nothing billed</span>
          </div>
          <p style={{ margin: "0 0 10px" }}>
            Invoice <span className="mono">{generated}</span> is saved and ready to print.
          </p>
          <a
            className="btn primary"
            href={`/api/documents/paperwork/${encodeURIComponent(generated)}`}
            target="_blank"
            rel="noopener"
          >
            Open &amp; print
          </a>
        </div>
      ) : null}

      <InvoiceBuilder accounts={accounts} products={products} pricing={pricing} lotSuggestions={lotSuggestions} />

      <section className="panel flush">
        <div className="panel-head">
          <h3>Previously generated</h3>
          <span className="small muted">{logs.length}</span>
        </div>
        {logs.length === 0 ? (
          <div className="empty">
            <b>Nothing yet.</b>
            Invoices you generate are saved here so you can reprint them exactly as issued.
          </div>
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>Delivery date</th>
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
                        href={`/api/documents/paperwork/${encodeURIComponent(l.docNumber)}`}
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
