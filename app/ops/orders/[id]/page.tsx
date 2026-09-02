import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireOpsUser, LEDGER_ROLES, ADMIN_ROLES } from "@/lib/ops/session";
import { stageOrders, loadOrders } from "@/lib/ops/queries";
import { currentProposal, routeDaysForRegion } from "@/lib/scheduling";
import { resolveBillingEmail } from "@/lib/ops/checklist";
import { BLOCKED_REASON_LABELS, stageIndex } from "@/lib/pipeline";
import { money, shortDate, stamp, toNumber } from "@/lib/ops/format";
import { StageChip } from "../../_components/StageChip";
import {
  blockOrderAction,
  cancelOrderAction,
  issueInvoiceNowAction,
  markDeliveredAction,
  scheduleOrderAction,
  unblockOrderAction,
} from "./actions";

export const dynamic = "force-dynamic";

const CHANNEL_LABELS: Record<string, string> = {
  rep_app: "Rep app",
  portal: "Customer portal",
  sms: "SMS",
};

/**
 * Order detail (§8.3).
 *
 * The centrepiece is the seven-node stage timeline. Past nodes show what
 * actually happened and the artifact it produced (BOL number, Sheet rows,
 * Stripe invoice). FUTURE nodes are rendered hollow with what *will* happen —
 * "the invoice will send automatically when this is marked delivered, Net 30
 * from delivery" — because the most common question about an order is not what
 * has happened to it but what happens next, and an ops tool that only shows
 * history makes everyone ask a human.
 */
export default async function OrderDetail({ params }: PageProps<"/ops/orders/[id]">) {
  const { id } = await params;
  const user = await requireOpsUser();

  const [staged] = stageOrders(await loadOrders({ id }));
  if (!staged) notFound();

  const [events, proposal, routes, syncLogs] = await Promise.all([
    db.orderEvent.findMany({ where: { orderId: id }, orderBy: { createdAt: "asc" } }),
    currentProposal(id),
    staged.account.region ? routeDaysForRegion(staged.account.region) : Promise.resolve([]),
    db.syncLog.findMany({ where: { orderId: id }, orderBy: { createdAt: "desc" }, take: 5 }),
  ]);

  const contact = staged.contact;
  const billing = resolveBillingEmail({
    billingContactEmail: staged.account.billingContactEmail,
    contactEmail: contact?.email ?? null,
  });

  const idx = stageIndex(staged.pipeline);
  const kegs = staged.kegs;
  const depositPerKeg = staged.lines.find((l) => l.product.isKeg)?.product.depositAmount;
  const deposit = kegs * toNumber(depositPerKeg ?? 35);
  const empties = staged.shipment?.emptiesPickedUp ?? 0;
  const depositCredit = empties * toNumber(depositPerKeg ?? 35);

  const canWrite = (LEDGER_ROLES as readonly string[]).includes(user.role);
  const isCompliance =
    staged.blockedReason === "license_expired" || staged.blockedReason === "credit_hold";

  const warehouses = [...new Set(routes.map((r) => r.warehouseId))];
  const eventsByType = new Map<string, (typeof events)[number]>();
  for (const e of events) if (!eventsByType.has(e.eventType)) eventsByType.set(e.eventType, e);

  /** One timeline node. `state` drives whether it reads as history or a promise. */
  const node = (
    i: number,
    title: string,
    happened: string | null,
    future: string,
    when: Date | null,
    artifacts: React.ReactNode = null,
  ) => {
    const state = i < idx ? "done" : i === idx ? "now" : "future";
    return (
      <div className={`n ${state}`} key={title}>
        <div className="dot">{state === "done" ? "✓" : i + 1}</div>
        <div>
          <div className="t">
            {title}
            {state !== "future" && when ? <span className="when">{stamp(when)}</span> : null}
          </div>
          <div className="m">{state === "future" ? future : (happened ?? future)}</div>
          {state !== "future" && artifacts ? <div className="art">{artifacts}</div> : null}
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">
            Order · {CHANNEL_LABELS[staged.channel] ?? staged.channel} ·{" "}
            <span className="mono">{staged.id}</span>
          </div>
          <h1 style={{ marginTop: 4 }}>
            {staged.account.businessName}{" "}
            <span className="muted mono" style={{ fontSize: 18 }}>
              {staged.invoiceNumber ?? ""}
            </span>
          </h1>
          <div className="actions" style={{ marginTop: 8 }}>
            <StageChip pipeline={staged.pipeline} />
            {staged.account.region ? <span className="region">{staged.account.region}</span> : null}
            <span className="small muted">
              {staged.salesRep?.name ?? "no rep"} · {staged.inventorySource ?? "no warehouse"}
            </span>
            <span className="num">{money(staged.total)}</span>
          </div>
        </div>
        <div className="actions">
          <Link className="btn ghost" href="/ops/orders">
            ← Orders
          </Link>
        </div>
      </div>

      {/* ---- Blocked stripe: the reason, and the one action that clears it ---- */}
      {staged.blockedReason ? (
        <div className="blockbar" style={{ marginBottom: 16 }}>
          <b>Blocked</b>
          <span>
            {BLOCKED_REASON_LABELS[staged.blockedReason as keyof typeof BLOCKED_REASON_LABELS] ??
              staged.blockedReason}
            {isCompliance ? " · a person must clear this, and the clearing is logged" : ""}
          </span>
          {canWrite && (!isCompliance || (ADMIN_ROLES as readonly string[]).includes(user.role)) ? (
            <form action={unblockOrderAction}>
              <input type="hidden" name="orderId" value={staged.id} />
              <button className="btn sm" type="submit">
                Unblock
              </button>
            </form>
          ) : (
            <span className="small">Needs an admin</span>
          )}
        </div>
      ) : null}

      {/* ---- Actions, gated by role and by stage ---- */}
      {canWrite ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <h3>Actions</h3>
            <span className="small muted">every action writes an order event</span>
          </div>

          {idx <= 3 && !staged.deliveredAt ? (
            <form action={scheduleOrderAction} className="actions" style={{ marginBottom: 12 }}>
              <input type="hidden" name="orderId" value={staged.id} />
              {staged.scheduledFor ? <input type="hidden" name="reschedule" value="1" /> : null}
              <label className="small muted">
                Date{" "}
                <input
                  type="date"
                  name="scheduledFor"
                  required
                  defaultValue={(staged.scheduledFor ?? proposal?.at)?.toISOString().slice(0, 10) ?? ""}
                  style={inputStyle}
                />
              </label>
              <label className="small muted">
                Warehouse{" "}
                <select
                  name="warehouseId"
                  defaultValue={staged.inventorySource ?? proposal?.warehouseId ?? warehouses[0] ?? ""}
                  style={inputStyle}
                >
                  {warehouses.length === 0 ? <option value="">no route schedule for this region</option> : null}
                  {warehouses.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small muted">
                Carrier <input name="carrierName" placeholder="Self" style={inputStyle} />
              </label>
              <button className="btn primary" type="submit">
                {staged.scheduledFor ? "Reschedule" : "Schedule"}
              </button>
            </form>
          ) : null}

          {staged.scheduledFor && !staged.deliveredAt ? (
            <form action={markDeliveredAction}>
              <input type="hidden" name="orderId" value={staged.id} />
              <div className="tblwrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="r">Ordered</th>
                      <th className="r">Actual qty</th>
                      <th>Lot #</th>
                      <th className="r">Empties collected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staged.lines.map((l) => (
                      <tr key={l.id}>
                        <td>
                          {l.product.productName} <span className="small muted">{l.product.formatLabel}</span>
                        </td>
                        <td className="r num">{l.qty}</td>
                        <td className="r">
                          <input
                            name={`qty[${l.id}]`}
                            type="number"
                            min="0"
                            defaultValue={l.qty}
                            style={{ ...inputStyle, width: 70 }}
                          />
                        </td>
                        <td>
                          <input
                            name={`lot[${l.id}]`}
                            defaultValue={l.lotNumber ?? ""}
                            placeholder="L26CNT08"
                            style={{ ...inputStyle, width: 120 }}
                          />
                        </td>
                        <td className="r">
                          {l.product.isKeg ? (
                            <input
                              name={`empty[${l.productId}]`}
                              type="number"
                              min="0"
                              defaultValue={0}
                              style={{ ...inputStyle, width: 70 }}
                            />
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="actions" style={{ marginTop: 10 }}>
                <button className="btn primary" type="submit">
                  Mark delivered
                </button>
                <span className="small muted">
                  Mints the BOL number, writes the ledger and keg custody, and enqueues the invoice.
                </span>
              </div>
            </form>
          ) : null}

          <div className="actions" style={{ marginTop: 12 }}>
            {staged.deliveredAt && !staged.invoice ? (
              <form action={issueInvoiceNowAction}>
                <input type="hidden" name="orderId" value={staged.id} />
                <button className="btn primary" type="submit">
                  Issue invoice now
                </button>
              </form>
            ) : null}
            {!staged.blockedReason ? (
              <form action={blockOrderAction} className="actions">
                <input type="hidden" name="orderId" value={staged.id} />
                <select name="reason" style={inputStyle} defaultValue="stock_short">
                  <option value="license_expired">License expired</option>
                  <option value="credit_hold">Credit hold</option>
                  <option value="stock_short">Stock short</option>
                  <option value="missing_billing_email">Missing billing email</option>
                  <option value="sync_conflict">Sheet conflict</option>
                </select>
                <button className="btn" type="submit">
                  Block
                </button>
              </form>
            ) : null}
            {!staged.deliveredAt && !staged.invoice ? (
              <form action={cancelOrderAction}>
                <input type="hidden" name="orderId" value={staged.id} />
                <button className="btn danger" type="submit">
                  Cancel order
                </button>
              </form>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="state" style={{ marginBottom: 16 }}>
          <span className="pill neutral">{user.role} role</span>
          <span>You can view this order. Ask an admin for permission to change it.</span>
        </div>
      )}

      {/* ---- The seven-node stage timeline ---- */}
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Pipeline</h3>
          <span className="small muted">future stages show what will happen next</span>
        </div>
        <div className="tl">
          {node(
            0,
            "Account set up",
            `Account created${staged.account.stripeDefaultPaymentMethod ? "; ACH on file" : "; no payment method on file yet"}.`,
            "The account needs a licence, a billing email, terms and a Stripe customer before it can order.",
            eventsByType.get("account.created")?.createdAt ?? null,
            <Link className="tag link" href={`/ops/accounts/${staged.account.id}`}>
              Account
            </Link>,
          )}
          {node(
            1,
            "New order",
            `${staged.lines.length} line${staged.lines.length === 1 ? "" : "s"}, ${money(staged.total)} via ${
              CHANNEL_LABELS[staged.channel] ?? staged.channel
            }.`,
            "The customer confirms, and the order becomes binding at that moment.",
            staged.confirmedAt ?? staged.submittedAt,
            <>
              {staged.sheetSyncedAt ? <span className="tag">Sheet · Sales</span> : null}
              <span className="tag">{staged.id}</span>
            </>,
          )}
          {node(
            2,
            "Needs scheduling",
            proposal
              ? `Proposed ${shortDate(proposal.at)} from ${proposal.warehouseId}, awaiting ops.`
              : "Awaiting triage.",
            "The system proposes the next route day for the region that respects the cutoff and the account's window.",
            eventsByType.get("order.slot_proposed")?.createdAt ?? null,
            proposal ? <span className="tag">auto_propose_slot</span> : null,
          )}
          {node(
            3,
            "Delivery scheduled",
            staged.scheduledFor
              ? `${shortDate(staged.scheduledFor)} from ${staged.inventorySource ?? "—"}${
                  staged.shipment?.carrierName ? ` · ${staged.shipment.carrierName}` : ""
                }. Delivery Date written to the Sheet.`
              : null,
            "Ops accepts or edits the slot. The Delivery Date is mirrored to the Sheet and a receipt is pre-rendered.",
            staged.scheduledFor,
            staged.shipment ? <span className="tag">Shipment planned</span> : null,
          )}
          {node(
            4,
            "Delivered · BOL issued",
            staged.deliveredAt
              ? `Marked delivered. BOL ${staged.bolNumber ?? "—"} minted; ${staged.lines.length} DELIVERY event${
                  staged.lines.length === 1 ? "" : "s"
                } written; keg custody +${kegs}${empties ? `, −${empties} returned` : ""}.`
              : null,
            "The warehouse taps Mark delivered with lot numbers and empties. That mints the real BOL number, writes the ledger and keg custody, and starts the Net 30 clock.",
            staged.deliveredAt,
            staged.bolNumber ? <span className="tag link">{staged.bolNumber}</span> : null,
          )}
          {node(
            5,
            "Invoiced",
            staged.invoice && staged.invoice.status !== "local_error"
              ? `Stripe invoice sent to ${billing.email ?? "—"}. Net 30 from delivery → due ${shortDate(
                  staged.invoice.dueDate,
                )}.`
              : staged.invoice?.status === "local_error"
                ? "Stripe rejected the invoice; it is retrying and shows in the attention queue."
                : null,
            billing.email
              ? `Sends automatically when marked delivered — to ${billing.email}. Net 30 from delivery, tax exempt, our INV # in the custom fields.`
              : "Blocked until a billing email is on file: there is nowhere to send the invoice. The order is fine; the invoice is not.",
            staged.invoice?.sentAt ?? staged.invoice?.createdAt ?? null,
            staged.invoice?.hostedInvoiceUrl ? (
              <a className="tag link" href={staged.invoice.hostedInvoiceUrl} target="_blank" rel="noopener">
                Stripe invoice
              </a>
            ) : null,
          )}
          {node(
            6,
            "Paid",
            staged.invoice?.paidAt ? `Settled ${stamp(staged.invoice.paidAt)}.` : null,
            "Stripe's invoice.paid webhook flips this and writes Paid back to the Sheet. More than 7 days overdue posts to Slack.",
            staged.invoice?.paidAt ?? null,
            staged.achRef ? <span className="tag mono">{staged.achRef}</span> : null,
          )}
        </div>
      </section>

      {/* ---- Lines, with the deposit lines the invoice will carry ---- */}
      <section className="panel flush" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Lines</h3>
          <span className="small muted">prices snapshotted at confirmation</span>
        </div>
        <div className="tblwrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Item</th>
                <th>Item #</th>
                <th>UPC</th>
                <th>Lot #</th>
                <th className="r">Qty</th>
                <th className="r">Unit</th>
                <th className="r">Total</th>
              </tr>
            </thead>
            <tbody>
              {staged.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.product.productName} <span className="muted small">{l.product.formatLabel}</span>
                  </td>
                  <td className="mono small">{l.product.skuCode}</td>
                  <td className="mono small muted">{l.product.upc ?? "—"}</td>
                  <td className="mono small muted">{l.lotNumber ?? "—"}</td>
                  <td className="r num">{l.qty}</td>
                  <td className="r num">{money(l.unitPrice)}</td>
                  <td className="r num">{money(l.lineTotal)}</td>
                </tr>
              ))}
              {kegs > 0 ? (
                <tr>
                  <td className="muted">Keg Deposit</td>
                  <td className="muted">—</td>
                  <td />
                  <td />
                  <td className="r num">{kegs}</td>
                  <td className="r num">{money(depositPerKeg ?? 35)}</td>
                  <td className="r num">{money(deposit)}</td>
                </tr>
              ) : null}
              {empties > 0 ? (
                <tr>
                  <td className="muted">Keg Deposit Returned</td>
                  <td className="muted">—</td>
                  <td />
                  <td />
                  <td className="r num">{empties}</td>
                  <td className="r num">−{money(depositPerKeg ?? 35)}</td>
                  <td className="r num">−{money(depositCredit)}</td>
                </tr>
              ) : null}
              <tr>
                <td colSpan={6} className="r muted">
                  Tax: Exempt (0.0000%) · <b style={{ color: "var(--ink)" }}>Invoice total</b>
                </td>
                <td className="r num" style={{ fontWeight: 600 }}>
                  {money(staged.total + deposit - depositCredit)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid g2" style={{ marginBottom: 16 }}>
        <section className="panel">
          <h3 style={{ marginBottom: 10 }}>Shipment</h3>
          <dl className="kv">
            <dt>From</dt>
            <dd>{staged.shipment?.fromLocationId ?? staged.inventorySource ?? "—"}</dd>
            <dt>Scheduled</dt>
            <dd>{staged.scheduledFor ? stamp(staged.scheduledFor) : proposal ? `${shortDate(proposal.at)} (proposed)` : "—"}</dd>
            <dt>Carrier</dt>
            <dd>{staged.shipment?.carrierName ?? "—"}</dd>
            <dt>Weight</dt>
            <dd className="num">
              {staged.shipment?.weightLbs ? `${money(staged.shipment.weightLbs).replace("$", "")} lb` : "—"} ·{" "}
              {staged.lines.reduce((s, l) => s + l.qty, 0)} handling units
            </dd>
            <dt>BOL #</dt>
            <dd className="mono">{staged.bolNumber ?? "minted at delivery"}</dd>
            <dt>Empties</dt>
            <dd>
              {empties ? `${empties} collected` : staged.expectedEmptyKegs ? `${staged.expectedEmptyKegs} expected` : "none expected"}
            </dd>
          </dl>
        </section>

        <section className="panel">
          <h3 style={{ marginBottom: 10 }}>Billing</h3>
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
                <span style={{ color: "var(--serious-ink)" }}>missing</span>
              )}
            </dd>
            <dt>Terms</dt>
            <dd>{staged.account.terms ?? "Net 30"} from delivery</dd>
            <dt>Collection</dt>
            <dd>
              {staged.account.stripeDefaultPaymentMethod
                ? "charge_automatically (ACH on file)"
                : "send_invoice · ACH / card"}
            </dd>
            <dt>Due</dt>
            <dd>{shortDate(staged.invoice?.dueDate)}</dd>
            <dt>Stripe</dt>
            <dd className="mono small">{staged.invoice?.stripeInvoiceId ?? "—"}</dd>
            <dt>Paid</dt>
            <dd>{staged.invoice?.amountPaid ? money(staged.invoice.amountPaid) : "—"}</dd>
          </dl>
        </section>
      </div>

      <div className="grid g2">
        <section className="panel">
          <div className="panel-head">
            <h3>Sheet sync</h3>
            <span className={`pill ${syncLogs.some((s) => s.conflict) ? "warn" : "good"}`}>
              {syncLogs.some((s) => s.conflict) ? "conflict" : "in sync"}
            </span>
          </div>
          <dl className="kv">
            <dt>DB → Sheet</dt>
            <dd>{staged.sheetSyncedAt ? stamp(staged.sheetSyncedAt) : "not yet mirrored"}</dd>
            <dt>Sheet → DB</dt>
            <dd>
              {syncLogs.find((s) => s.direction === "sheet_to_db")
                ? stamp(syncLogs.find((s) => s.direction === "sheet_to_db")!.createdAt)
                : "no ops edits"}
            </dd>
            <dt>Ownership</dt>
            <dd className="small muted">
              The database owns the order content, delivery date, BOL #, lot # and invoice status. The Sheet owns Notes
              and the tap-handle columns.
            </dd>
          </dl>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Audit trail</h3>
            <span className="small muted">append-only · {events.length} events</span>
          </div>
          {events.length === 0 ? (
            <div className="empty">
              <b>No events yet.</b>
              This order predates the event log, or nothing has happened to it.
            </div>
          ) : (
            <div className="feed small">
              {events
                .slice()
                .reverse()
                .map((e) => (
                  <div className="ev" key={e.id}>
                    <span className={`who ${e.actor}`}>{e.actor.slice(0, 3).toUpperCase()}</span>
                    <span className="mono">{e.eventType}</span>
                    <span className="when">{stamp(e.createdAt)}</span>
                  </div>
                ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--surface-2)",
  border: "1px solid var(--line-strong)",
  borderRadius: "var(--r-sm)",
  color: "var(--ink)",
  font: "inherit",
  padding: "5px 8px",
};

