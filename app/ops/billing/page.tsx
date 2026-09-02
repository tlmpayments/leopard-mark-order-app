import Link from "next/link";
import { money, shortDate } from "@/lib/ops/format";
import { invoicesWithAging, monthStart, type InvoiceWithAging } from "@/lib/ops/queries";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, string> = {
  paid: "good",
  open: "neutral",
  draft: "neutral",
  uncollectible: "warn",
  void: "neutral",
  local_error: "serious",
};

/**
 * Billing (§8.8) — Stripe is the ledger, this is the cockpit.
 *
 * Stripe holds the truth for payment state and we mirror it; nothing here
 * invents a payment status. Off-Stripe cheques and EFTs are recorded as Stripe
 * out-of-band payments rather than marked paid locally, so Stripe stays
 * honest and there is still exactly one answer to "has this been paid".
 */
export default async function BillingPage({ searchParams }: PageProps<"/ops/billing">) {
  const params = await searchParams;
  const filter = (Array.isArray(params.filter) ? params.filter[0] : params.filter) ?? "all";

  // Aging is computed in the query layer: it depends on the clock, and reading
  // the clock during render makes the same data produce different output.
  const withAging = await invoicesWithAging();

  const filtered = withAging.filter((i) => {
    switch (filter) {
      case "failed":
        return i.status === "local_error";
      case "open":
        return i.status === "open";
      case "overdue":
        return i.status === "open" && (i.daysOverdue ?? 0) > 0;
      case "paid":
        return i.status === "paid";
      default:
        return true;
    }
  });

  const open = withAging.filter((i) => i.status === "open");
  const overdue = open.filter((i) => (i.daysOverdue ?? 0) > 0);
  const failed = withAging.filter((i) => i.status === "local_error");
  const mtd = monthStart();
  const paidMtd = withAging.filter((i) => i.paidAt && i.paidAt >= mtd);

  const sum = (rows: InvoiceWithAging[]) => rows.reduce((s, i) => s + i.amountDue, 0);

  const tiles = [
    ["Open", money(sum(open)), `${open.length} invoices`],
    ["Overdue", money(sum(overdue)), overdue.length ? `${overdue.length} · oldest ${Math.max(...overdue.map((o) => o.daysOverdue ?? 0))}d` : "none"],
    ["Paid MTD", money(paidMtd.reduce((s, i) => s + i.amountPaid, 0)), `${paidMtd.length} invoices`],
    ["Failed to send", String(failed.length), failed.length ? "needs a person" : "clear"],
  ] as const;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Billing · Stripe is the ledger</div>
          <h1>Invoices</h1>
          <p>
            Every invoice is Net 30 <b>from delivery</b> (Cal. B&amp;P § 25509), which is why the due date is computed
            from the delivery date and not from when the invoice was created.
          </p>
        </div>
        <div className="actions">
          <div className="seg">
            {(["all", "failed", "open", "overdue", "paid"] as const).map((f) => (
              <Link key={f} className={filter === f ? "on" : ""} href={`/ops/billing?filter=${f}`}>
                {f[0].toUpperCase() + f.slice(1)}
              </Link>
            ))}
          </div>
          <Link className="btn" href="/ops/billing/setup-links">
            Payment setup links
          </Link>
        </div>
      </div>

      <div className="grid g5" style={{ marginBottom: 16 }}>
        {tiles.map(([l, v, d]) => (
          <div className="kpi" key={l}>
            <div className="l">{l}</div>
            <div className="v">{v}</div>
            <div className="d">{d}</div>
          </div>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="state">
          <b>{withAging.length === 0 ? "No invoices yet." : "Nothing matches this filter."}</b>
          <span>
            {withAging.length === 0
              ? "Invoices are issued when a delivery is marked complete, not when an order is placed."
              : "Try another filter."}
          </span>
        </div>
      ) : (
        <div className="panel flush">
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>Account</th>
                  <th>Status</th>
                  <th>Due</th>
                  <th className="r">Days</th>
                  <th>Collection</th>
                  <th className="r">Amount</th>
                  <th className="r">Paid</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((i) => (
                  <tr className="row" key={i.id}>
                    <td className="mono">
                      <Link href={`/ops/orders/${i.orderId}`}>
                        {i.invoiceNumber ?? i.orderInvoiceNumber ?? i.stripeInvoiceId.slice(0, 12)}
                      </Link>
                    </td>
                    <td>
                      <b>{i.businessName}</b>
                    </td>
                    <td>
                      <span className={`pill ${STATUS_TONE[i.status] ?? "neutral"}`}>{i.status}</span>
                    </td>
                    <td>{shortDate(i.dueDate)}</td>
                    <td
                      className="r num"
                      style={{ color: (i.daysOverdue ?? 0) > 0 ? "var(--serious-ink)" : undefined }}
                    >
                      {i.daysOverdue == null ? "—" : i.daysOverdue > 0 ? `+${i.daysOverdue}` : i.daysOverdue}
                    </td>
                    <td className="small mono">{i.collectionMethod}</td>
                    <td className="r num">{money(i.amountDue)}</td>
                    <td className="r num muted">{i.amountPaid ? money(i.amountPaid) : "—"}</td>
                    <td className="r">
                      {i.hostedInvoiceUrl ? (
                        <a className="btn sm ghost" href={i.hostedInvoiceUrl} target="_blank" rel="noopener">
                          Hosted ↗
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="spec" style={{ marginTop: 16 }}>
        <b>Invoice composition</b> matches INV26277: one line per order line, then <b>Keg Deposit</b> at +$35 per keg,
        then <b>Keg Deposit Returned</b> at −$35 per empty collected, then <span className="mono">TAX: Exempt
        (0.0000%)</span>, with the § 25509 / § 25509.1 sentences in the footer. Custom fields carry PO Date, Delivery
        Date, Sales Rep, License Number and our own INV #, because Stripe&rsquo;s invoice numbering is immutable per
        account and cannot be ours.
      </div>
    </>
  );
}
