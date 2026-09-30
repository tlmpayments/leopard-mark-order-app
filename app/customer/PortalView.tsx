import type { ReactNode } from "react";
import type { PortalData, PortalOrder } from "@/lib/customerPortal";
import { money } from "@/lib/ops/format";
import styles from "./portal.module.css";

const dayFmt = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "America/Los_Angeles",
});
// Route days are stored as bare dates (UTC midnight); converting those to
// Pacific would show the previous day.
const dayOnlyFmt = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const shortFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "America/Los_Angeles",
});

function invoiceLabel(o: PortalOrder): { text: string; tone: "good" | "warn" | "muted" } {
  if (o.invoiceStatus === "paid") return { text: "Paid", tone: "good" };
  if (o.invoiceStatus === "open") {
    const late = o.dueDate && o.dueDate < new Date();
    return { text: late ? "Overdue" : "Due", tone: "warn" };
  }
  if (o.invoiceStatus === "uncollectible") return { text: "Past due", tone: "warn" };
  return { text: "Invoice pending", tone: "muted" };
}

export function PortalView({ data, footer }: { data: PortalData; footer?: ReactNode }) {
  const { totals, billing, upcoming, orders } = data;
  const onHold = data.account.creditHold;
  const pastDue = billing.overdue > 0;
  const standing = onHold
    ? { text: "On hold", tone: styles.warn }
    : pastDue
      ? { text: "Past due", tone: styles.warn }
      : { text: "In good standing", tone: styles.good };

  return (
    <main className="app-shell">
      <div className="rep-block">
        <div className="name">{data.account.businessName}</div>
        <div className="rep-label">Customer Portal</div>
      </div>

      <div className={styles.wrap}>
        <section className={styles.section}>
          <h2>Account</h2>
          <div className={`${styles.card} ${styles.standing}`}>
            <div>
              <div style={{ fontWeight: 600 }}>{money(billing.outstanding)} outstanding</div>
              <div className={styles.muted}>
                {pastDue
                  ? `${money(billing.overdue)} past due on ${billing.overdueCount} invoice${billing.overdueCount === 1 ? "" : "s"}`
                  : "Nothing past due"}
                {data.account.terms ? ` · Terms: ${data.account.terms}` : ""}
              </div>
              {onHold ? (
                <div className={styles.muted}>
                  Your account is on hold
                  {data.account.salesRepName ? ` — contact ${data.account.salesRepName}` : " — contact your sales rep"}.
                </div>
              ) : null}
            </div>
            <span className={`${styles.badge} ${standing.tone}`}>{standing.text}</span>
          </div>
        </section>

        <section className={styles.section}>
          <h2>Lifetime totals</h2>
          <div className={styles.stats}>
            <div className={styles.stat}>
              <div className={styles.num}>{totals.orders.toLocaleString("en-US")}</div>
              <div className={styles.label}>Orders</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.num}>{totals.units.toLocaleString("en-US")}</div>
              <div className={styles.label}>Units purchased</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.num}>{money(totals.dollars)}</div>
              <div className={styles.label}>Total purchased</div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <h2>Upcoming deliveries</h2>
          {upcoming.length === 0 ? (
            <p className={styles.muted}>No deliveries scheduled right now.</p>
          ) : (
            <div className={styles.list}>
              {upcoming.map((u) => (
                <div className={styles.card} key={u.orderId}>
                  <div className={styles.row}>
                    <span className={styles.title}>
                      {u.date
                        ? (u.dateOnly ? dayOnlyFmt : dayFmt).format(u.date)
                        : "Being scheduled"}
                    </span>
                    <span className={styles.muted}>{u.invoiceNumber ?? ""}</span>
                  </div>
                  <div className={styles.items}>
                    {u.items.map((i) => `${i.qty} × ${i.name}`).join(" · ")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className={styles.section}>
          <h2>Order &amp; invoice history</h2>
          {orders.length === 0 ? (
            <p className={styles.muted}>No orders yet.</p>
          ) : (
            <div className={styles.list}>
              {orders.map((o) => {
                const label = invoiceLabel(o);
                return (
                  <div className={styles.card} key={o.id}>
                    <div className={styles.row}>
                      <span className={styles.title}>{o.invoiceNumber ?? "Order"}</span>
                      <span className={styles.title}>{money(o.total)}</span>
                    </div>
                    <div className={styles.row}>
                      <span className={styles.muted}>
                        {o.placedAt ? shortFmt.format(o.placedAt) : ""} · {o.units} unit
                        {o.units === 1 ? "" : "s"}
                      </span>
                      <span className={styles[label.tone]}>{label.text}</span>
                    </div>
                    {o.hostedInvoiceUrl ? (
                      <a className={styles.link} href={o.hostedInvoiceUrl} target="_blank" rel="noopener noreferrer">
                        View / pay invoice
                      </a>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {footer}
      </div>
    </main>
  );
}
