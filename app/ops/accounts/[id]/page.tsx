import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireOpsUser, LEDGER_ROLES } from "@/lib/ops/session";
import { CHECKLIST_ITEMS, accountChecklist, resolveBillingEmail } from "@/lib/ops/checklist";
import { kegCustodyBalances } from "@/lib/inventory";
import { stageOrders, loadOrders } from "@/lib/ops/queries";
import { money, shortDate, stamp } from "@/lib/ops/format";
import { StageChip } from "../../_components/StageChip";
import { sendSetupLinkAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Account detail (§8.4).
 *
 * This screen absorbs the whole of ach.tlmbg.co: the payment-setup link that
 * was a separate Vercel project is one button here, next to the checklist that
 * explains why it is needed.
 */
export default async function AccountDetail({ params }: PageProps<"/ops/accounts/[id]">) {
  const { id } = await params;
  const user = await requireOpsUser();

  const account = await db.account.findUnique({
    where: { id },
    include: {
      salesRep: { select: { name: true } },
      contacts: { orderBy: { createdAt: "asc" } },
      accountPricing: { include: { product: { select: { skuCode: true, productName: true, listPrice: true } } } },
      invoices: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!account) notFound();

  const [orders, custody, routeRegions] = await Promise.all([
    loadOrders({ accountId: id }).then(stageOrders),
    kegCustodyBalances().then((all) => all.filter((c) => c.accountId === id)),
    db.routeSchedule.findMany({ select: { region: true }, distinct: ["region"] }),
  ]);

  const checklist = accountChecklist({
    ...account,
    contactEmail: account.contacts.find((c) => c.email)?.email ?? null,
    regionHasWarehouse: account.region ? routeRegions.some((r) => r.region === account.region) : false,
  });
  const billing = resolveBillingEmail({
    billingContactEmail: account.billingContactEmail,
    contactEmail: account.contacts.find((c) => c.email)?.email ?? null,
  });

  const kegsOut = custody.reduce((s, c) => s + c.balance, 0);
  const exposure = custody.reduce((s, c) => s + c.depositExposure, 0);
  const lastReturn = custody.reduce<Date | null>(
    (latest, c) => (c.lastMovementAt && (!latest || c.lastMovementAt > latest) ? c.lastMovementAt : latest),
    null,
  );
  const canWrite = (LEDGER_ROLES as readonly string[]).includes(user.role);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">
            Account{account.region ? ` · ${account.region}` : ""} · {account.approvalStatus}
          </div>
          <h1>{account.businessName}</h1>
          <div className="actions" style={{ marginTop: 8 }}>
            {account.licenseStatus === "active" ? (
              <span className="pill good">license active</span>
            ) : (
              <span className="pill serious">license {account.licenseStatus}</span>
            )}
            {account.creditHold ? <span className="pill serious">credit hold</span> : null}
            <span className="small muted">
              {account.salesRep?.name ?? "no rep"} · {checklist.doneCount}/9 setup
            </span>
          </div>
        </div>
        <div className="actions">
          <Link className="btn ghost" href="/ops/accounts">
            ← Accounts
          </Link>
          {/* An account with no resolvable billing email cannot receive the
              link at all, so the button says why instead of enqueueing a job
              that skips. Previously it rendered enabled, the click looked
              like it worked, and the only trace was a console.warn on the
              server. */}
          {canWrite && !account.stripeDefaultPaymentMethod ? (
            billing.email ? (
              <form action={sendSetupLinkAction}>
                <input type="hidden" name="accountId" value={account.id} />
                <button className="btn primary" type="submit" title={`Sends to ${billing.email}`}>
                  Send payment setup link
                </button>
              </form>
            ) : (
              <button className="btn" type="button" disabled title="Add a billing email first">
                No billing email — cannot send
              </button>
            )
          ) : null}
        </div>
      </div>

      <div className="grid g2" style={{ marginBottom: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <h3>Setup checklist</h3>
            <span className={`pill ${checklist.doneCount === 9 ? "good" : "warn"}`}>{checklist.doneCount}/9</span>
          </div>
          <div className="ck" style={{ marginBottom: 12 }}>
            {checklist.done.map((ok, i) => (
              <i key={i} className={ok ? "y" : "n"} />
            ))}
          </div>
          <dl className="kv">
            {CHECKLIST_ITEMS.map((item, i) => (
              <div key={item} style={{ display: "contents" }}>
                <dt>{item}</dt>
                <dd>
                  {checklist.done[i] ? (
                    <span className="pill good">done</span>
                  ) : (
                    <span className="pill serious">missing</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          {checklist.blocksInvoice.length ? (
            <div className="blockbar" style={{ marginTop: 12 }}>
              <b>Blocks invoicing</b>
              <span>{checklist.blocksInvoice.join(", ")} — orders can still be placed and delivered.</span>
            </div>
          ) : null}
        </section>

        <div className="grid" style={{ alignContent: "start" }}>
          <section className="panel">
            <h3 style={{ marginBottom: 10 }}>Billing &amp; delivery</h3>
            <dl className="kv">
              <dt>Billing email</dt>
              <dd>
                {billing.email ? (
                  <>
                    {billing.email}{" "}
                    <span className="small muted">
                      ({billing.source === "account_billing_contact" ? "account" : "ordering contact"})
                    </span>
                  </>
                ) : (
                  <span style={{ color: "var(--serious-ink)" }}>none on file</span>
                )}
              </dd>
              <dt>Terms</dt>
              <dd>{account.terms ?? "—"}</dd>
              <dt>Payment method</dt>
              <dd>{account.paymentMethod ?? "—"}</dd>
              <dt>ACH on file</dt>
              <dd>
                {account.stripeDefaultPaymentMethod ? (
                  <span className="pill good">yes</span>
                ) : (
                  <span className="pill warn">not yet</span>
                )}
              </dd>
              <dt>Stripe customer</dt>
              <dd className="mono small">{account.stripeCustomerId ?? "—"}</dd>
              <dt>Setup link sent</dt>
              <dd>{account.stripeSetupLinkSentAt ? stamp(account.stripeSetupLinkSentAt) : "never"}</dd>
              <dt>License #</dt>
              <dd className="mono small">{account.licenseNumber ?? "—"}</dd>
              <dt>License expiry</dt>
              <dd>{shortDate(account.licenseExpiry)}</dd>
              <dt>Delivery window</dt>
              <dd>{account.deliveryWindow ?? "—"}</dd>
              <dt>Delivery address</dt>
              <dd className="small">{account.deliveryAddress ?? account.address ?? "—"}</dd>
              <dt>Tax</dt>
              <dd>{account.taxExempt ? "Exempt (0.0000%)" : "Taxable"}</dd>
            </dl>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h3>Keg custody</h3>
              <span className="small muted">{kegsOut} in trade</span>
            </div>
            {custody.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                No kegs in this account&rsquo;s custody.
              </p>
            ) : (
              <>
                <dl className="kv">
                  <dt>Deposit exposure</dt>
                  <dd className="num">{money(exposure)}</dd>
                  <dt>Last movement</dt>
                  <dd>{shortDate(lastReturn)}</dd>
                </dl>
                <table className="tbl" style={{ marginTop: 8 }}>
                  <thead>
                    <tr>
                      <th>SKU</th>
                      <th className="r">Balance</th>
                      <th className="r">Exposure</th>
                    </tr>
                  </thead>
                  <tbody>
                    {custody.map((c) => (
                      <tr key={c.productId}>
                        <td className="mono small">{c.skuCode}</td>
                        <td className="r num">{c.balance}</td>
                        <td className="r num">{money(c.depositExposure)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        </div>
      </div>

      <div className="grid g2" style={{ marginBottom: 16 }}>
        <section className="panel flush">
          <div className="panel-head">
            <h3>Contacts</h3>
            <span className="small muted">authorized SMS senders are flagged</span>
          </div>
          {account.contacts.length === 0 ? (
            <div className="empty">
              <b>No contacts.</b>
              An account with no contact has nowhere to send an invoice.
            </div>
          ) : (
            <div className="tblwrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>SMS</th>
                  </tr>
                </thead>
                <tbody>
                  {account.contacts.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name ?? "—"}</td>
                      <td className="small">{c.email ?? "—"}</td>
                      <td className="small mono">{c.phoneE164 ?? "—"}</td>
                      <td>
                        {c.isAuthorizedSender ? (
                          <span className="pill good">authorized</span>
                        ) : (
                          <span className="pill neutral">no</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel flush">
          <div className="panel-head">
            <h3>Pricing overrides</h3>
            <span className="small muted">{account.accountPricing.length}</span>
          </div>
          {account.accountPricing.length === 0 ? (
            <div className="empty">
              <b>List price throughout.</b>
              No per-account overrides.
            </div>
          ) : (
            <div className="tblwrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th className="r">List</th>
                    <th className="r">This account</th>
                  </tr>
                </thead>
                <tbody>
                  {account.accountPricing.map((p) => (
                    <tr key={p.id}>
                      <td className="mono small">{p.product.skuCode}</td>
                      <td className="r num muted">{money(p.product.listPrice)}</td>
                      <td className="r num">{money(p.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <section className="panel flush" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Orders</h3>
          <span className="small muted">{orders.length}</span>
        </div>
        {orders.length === 0 ? (
          <div className="empty">
            <b>No orders yet.</b>
            This account is at stage ① until its first order.
          </div>
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>Stage</th>
                  <th>Lines</th>
                  <th className="r">Total</th>
                  <th>Delivered</th>
                  <th>BOL #</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr className="row" key={o.id}>
                    <td className="mono">
                      <Link href={`/ops/orders/${o.id}`}>{o.invoiceNumber ?? o.id.slice(0, 10)}</Link>
                    </td>
                    <td>
                      <StageChip pipeline={o.pipeline} />
                    </td>
                    <td className="num">{o.lines.length}</td>
                    <td className="r num">{money(o.total)}</td>
                    <td className="small">{shortDate(o.deliveredAt)}</td>
                    <td className="mono small muted">{o.bolNumber ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel flush">
        <div className="panel-head">
          <h3>Invoices</h3>
          <span className="small muted">aging</span>
        </div>
        {account.invoices.length === 0 ? (
          <div className="empty">
            <b>Never invoiced.</b>
            Invoices are issued when a delivery is marked complete.
          </div>
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>Status</th>
                  <th>Due</th>
                  <th className="r">Amount</th>
                  <th className="r">Paid</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {account.invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="mono small">{i.invoiceNumber ?? i.stripeInvoiceId.slice(0, 14)}</td>
                    <td>
                      <span className={`pill ${i.status === "paid" ? "good" : i.status === "local_error" ? "serious" : "neutral"}`}>
                        {i.status}
                      </span>
                    </td>
                    <td className="small">{shortDate(i.dueDate)}</td>
                    <td className="r num">{money(i.amountDue)}</td>
                    <td className="r num muted">{Number(i.amountPaid) ? money(i.amountPaid) : "—"}</td>
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
        )}
      </section>
    </>
  );
}
