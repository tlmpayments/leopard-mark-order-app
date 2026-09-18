"use client";

import { useMemo, useState } from "react";
import { composeInvoice, dueDateFromDelivery, type ComposeLineInput } from "@/lib/billing/compose";
import { lineTotal, pricingKey, resolveUnitPrice } from "@/lib/billing/pricing";
import { generateInvoiceAction } from "../actions";

/**
 * The invoice maker's form.
 *
 * Every number on screen comes from `composeInvoice` -- the same function the
 * server action runs and the same one that builds a real Stripe invoice for a
 * delivered order. The totals here are therefore a preview of the document,
 * not a second opinion about it: there is no second implementation of the keg
 * deposit, the returned-deposit credit or the Net-30-from-delivery due date
 * that could drift from the printed page.
 *
 * The catalogue, the accounts and the per-account prices are handed in by the
 * server page on every load, so a price changed in the hub shows up here on
 * the next refresh rather than whenever a cache expires.
 */

export interface BuilderAccount {
  id: string;
  businessName: string;
  legalEntity: string | null;
  address: string | null;
  deliveryAddress: string | null;
  licenseNumber: string | null;
  terms: string | null;
  taxExempt: boolean;
  salesRep: string | null;
  phone: string | null;
}

export interface BuilderProduct {
  id: string;
  skuCode: string;
  productName: string;
  formatLabel: string;
  formatDetail: string;
  isKeg: boolean;
  depositAmount: number | null;
  listPrice: number;
  upc: string | null;
}

interface Line {
  key: number;
  productId: string;
  /**
   * Held as typed text rather than a number, and empty rather than 0 to start.
   * A numeric field showing a default 0 turns "type 4" into "04", which on an
   * invoice is a four-figure mistake waiting to happen.
   */
  qty: string;
  /** Empty means "use the catalogue price", which is what the row shows. */
  priceOverride: string;
  lot: string;
}

const qtyOf = (line: { qty: string }): number => {
  const n = Number.parseInt(line.qty, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const money = (n: number) => USD.format(Number(n) || 0);
const centsToDollars = (cents: number) => Math.round(cents) / 100;
const today = () => new Date().toISOString().slice(0, 10);

const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "long",
  day: "numeric",
});

export function InvoiceBuilder({
  accounts,
  products,
  pricing,
  lotSuggestions,
}: {
  accounts: BuilderAccount[];
  products: BuilderProduct[];
  /** `accountId:productId` -> negotiated price. */
  pricing: Record<string, number>;
  /** Lot numbers the ledger has already seen, per product id. */
  lotSuggestions: Record<string, string[]>;
}) {
  const [accountId, setAccountId] = useState("");
  const [deliveryDate, setDeliveryDate] = useState(today());
  const [poDate, setPoDate] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [kegReturnQty, setKegReturnQty] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([{ key: 1, productId: "", qty: "", priceOverride: "", lot: "" }]);

  const account = accounts.find((a) => a.id === accountId) ?? null;
  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  /** The catalogue price for this account, or the list price when it has none. */
  function priceFor(productId: string): { unitPrice: number; source: "account" | "list" } {
    const product = productById.get(productId);
    if (!product) return { unitPrice: 0, source: "list" };
    const negotiated = accountId ? pricing[pricingKey(accountId, productId)] : undefined;
    return resolveUnitPrice(product.listPrice, negotiated);
  }

  function effectivePrice(line: Line): number {
    if (line.priceOverride.trim() !== "") {
      const typed = Number(line.priceOverride);
      if (Number.isFinite(typed) && typed >= 0) return typed;
    }
    return priceFor(line.productId).unitPrice;
  }

  // ---- The preview, straight from the billing system's own composer --------
  const composed = useMemo(() => {
    const filled = lines.filter((l) => l.productId && qtyOf(l) > 0);
    const composeLines: ComposeLineInput[] = filled.map((l, i) => {
      const p = productById.get(l.productId)!;
      return {
        orderLineId: `preview-${i}`,
        skuCode: p.skuCode,
        productName: p.productName,
        formatLabel: p.formatDetail || p.formatLabel,
        qty: qtyOf(l),
        lineTotal: lineTotal(qtyOf(l), effectivePrice(l)),
        lotNumber: l.lot || null,
        isKeg: p.isKeg,
        depositAmount: p.depositAmount,
      };
    });
    const firstKeg = filled.find((l) => productById.get(l.productId)?.isKeg);
    const firstKegSku = firstKeg ? productById.get(firstKeg.productId)!.skuCode : undefined;
    const empties = Number.parseInt(kegReturnQty, 10) || 0;
    const emptiesBySku = empties > 0 ? { [firstKegSku ?? "__empties__"]: empties } : {};
    return composeInvoice({ lines: composeLines, emptiesBySku });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, kegReturnQty, accountId, productById, pricing]);

  const dueDate = useMemo(() => {
    if (!deliveryDate) return null;
    return dueDateFromDelivery(new Date(`${deliveryDate}T12:00:00Z`), account?.terms);
  }, [deliveryDate, account?.terms]);

  const canSubmit = Boolean(accountId) && lines.some((l) => l.productId && qtyOf(l) > 0);

  function updateLine(key: number, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  return (
    <form action={generateInvoiceAction}>
      <input type="hidden" name="accountId" value={accountId} />

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Bill to</h3>
          <span className="small muted">{accounts.length} accounts · live</span>
        </div>

        <div className="grid g2" style={{ marginBottom: 12 }}>
          <label className="small muted">
            Account
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} style={field} required>
              <option value="">Select an account…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.businessName}
                </option>
              ))}
            </select>
          </label>
          <label className="small muted">
            Invoice #
            <input
              name="invoiceNumber"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="auto — INV-yymmdd-nnnn"
              style={field}
            />
          </label>
        </div>

        {account ? (
          <div className="grid g2 small muted" style={{ gap: 12 }}>
            <div>
              <b className="mono">Ship to</b>
              <div>{account.businessName}</div>
              <div>{account.deliveryAddress ?? account.address ?? "— no address on file —"}</div>
              <div>{account.phone ?? ""}</div>
              <div>{account.licenseNumber ? `License ${account.licenseNumber}` : ""}</div>
            </div>
            <div>
              <b className="mono">Terms</b>
              <div>{account.terms ?? "Net 30 (default)"}</div>
              <div>{account.taxExempt ? "Tax exempt" : "Taxable"}</div>
              <div>Sales rep: {account.salesRep ?? "—"}</div>
              <div>Due: {dueDate ? DAY.format(dueDate) : "—"}</div>
            </div>
          </div>
        ) : null}

        <div className="grid g2" style={{ marginTop: 12 }}>
          <label className="small muted">
            Delivery date
            <input
              type="date"
              name="deliveryDate"
              value={deliveryDate}
              onChange={(e) => setDeliveryDate(e.target.value)}
              style={field}
              required
            />
          </label>
          <label className="small muted">
            PO date
            <input type="date" name="poDate" value={poDate} onChange={(e) => setPoDate(e.target.value)} style={field} />
          </label>
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Lines</h3>
          <span className="small muted">prices from this account&rsquo;s pricing, else the catalogue</span>
        </div>

        <div className="tblwrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Item</th>
                <th>SKU</th>
                <th>Lot #</th>
                <th className="r">Qty</th>
                <th className="r">Unit price</th>
                <th className="r">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, idx) => {
                const product = productById.get(line.productId);
                const price = priceFor(line.productId);
                const unit = effectivePrice(line);
                const suggestions = product ? (lotSuggestions[product.id] ?? []) : [];
                return (
                  <tr key={line.key}>
                    <td>
                      <select
                        value={line.productId}
                        onChange={(e) => updateLine(line.key, { productId: e.target.value })}
                        style={{ ...field, minWidth: 230 }}
                      >
                        <option value="">Select a product…</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.productName} — {p.formatDetail || p.formatLabel}
                          </option>
                        ))}
                      </select>
                      <input type="hidden" name={`line[${idx}][productId]`} value={line.productId} />
                    </td>
                    <td className="mono small">{product?.skuCode ?? "—"}</td>
                    <td>
                      <input
                        name={`line[${idx}][lot]`}
                        value={line.lot}
                        onChange={(e) => updateLine(line.key, { lot: e.target.value })}
                        list={suggestions.length ? `lots-${line.key}` : undefined}
                        placeholder="—"
                        style={{ ...field, width: 120 }}
                      />
                      {suggestions.length ? (
                        <datalist id={`lots-${line.key}`}>
                          {suggestions.map((l) => (
                            <option key={l} value={l} />
                          ))}
                        </datalist>
                      ) : null}
                    </td>
                    <td className="r">
                      <input
                        type="number"
                        min="0"
                        step="1"
                        name={`line[${idx}][qty]`}
                        value={line.qty}
                        placeholder="0"
                        onChange={(e) => updateLine(line.key, { qty: e.target.value.replace(/[^0-9]/g, "") })}
                        style={{ ...field, width: 74, textAlign: "right" }}
                      />
                    </td>
                    <td className="r">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        name={`line[${idx}][unitPrice]`}
                        value={line.priceOverride}
                        onChange={(e) => updateLine(line.key, { priceOverride: e.target.value })}
                        placeholder={product ? unit.toFixed(2) : "—"}
                        style={{ ...field, width: 96, textAlign: "right" }}
                      />
                      {product ? (
                        <div className="small muted" style={{ marginTop: 2 }}>
                          {price.source === "account" ? "account price" : "list price"} {money(price.unitPrice)}
                        </div>
                      ) : null}
                    </td>
                    <td className="r num">
                      {product && qtyOf(line) > 0 ? money(lineTotal(qtyOf(line), unit)) : "—"}
                    </td>
                    <td className="r">
                      {lines.length > 1 ? (
                        <button
                          type="button"
                          className="btn sm ghost"
                          onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                          aria-label="Remove line"
                        >
                          ×
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn sm"
            onClick={() =>
              setLines((prev) => [
                ...prev,
                { key: Math.max(0, ...prev.map((l) => l.key)) + 1, productId: "", qty: "", priceOverride: "", lot: "" },
              ])
            }
          >
            Add line
          </button>
          <label className="small muted" style={{ marginLeft: 16 }}>
            Empty kegs picked up
            <input
              type="number"
              min="0"
              step="1"
              name="kegReturnQty"
              value={kegReturnQty}
              placeholder="0"
              onChange={(e) => setKegReturnQty(e.target.value.replace(/[^0-9]/g, ""))}
              style={{ ...field, width: 74, display: "inline-block", marginLeft: 8 }}
            />
          </label>
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Totals</h3>
          <span className="small muted">composeInvoice · the billing system&rsquo;s own maths</span>
        </div>
        <div style={{ maxWidth: 360, marginLeft: "auto" }}>
          <Row label="Subtotal" value={money(centsToDollars(composed.subtotal))} />
          {composed.depositTotal > 0 ? (
            <Row label="Keg deposit" value={money(centsToDollars(composed.depositTotal))} />
          ) : null}
          {composed.depositCreditTotal > 0 ? (
            <Row label="Keg deposit returned" value={`-${money(centsToDollars(composed.depositCreditTotal))}`} />
          ) : null}
          <Row label={account?.taxExempt === false ? "Tax" : "Tax — exempt"} value={money(0)} />
          <Row label="Invoice total" value={money(centsToDollars(composed.total))} strong />
          {composed.customerBalanceCredit > 0 ? (
            <Row
              label="Credit carried forward"
              value={money(centsToDollars(composed.customerBalanceCredit))}
            />
          ) : null}
        </div>
        <label className="small muted" style={{ display: "block", marginTop: 12 }}>
          Notes
          <input name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} style={field} />
        </label>
        <div className="actions" style={{ marginTop: 12 }}>
          <button className="btn primary" type="submit" disabled={!canSubmit}>
            Generate &amp; save
          </button>
          <span className="small muted">
            Paperwork only — this prints an invoice and records it here. It does not bill the customer, charge a
            card or email anything.
          </span>
        </div>
      </section>
    </form>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        padding: "4px 0",
        borderTop: strong ? "1px solid var(--line-strong)" : undefined,
        marginTop: strong ? 6 : undefined,
        fontWeight: strong ? 600 : undefined,
      }}
    >
      <span className="small muted">{label}</span>
      <span className="num">{value}</span>
    </div>
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
