import Link from "next/link";
import { db } from "@/lib/db";
import {
  attentionQueue,
  kpis,
  liveActivity,
  loadOrders,
  pipelineColumns,
  ruleHealth,
  stageOrders,
} from "@/lib/ops/queries";
import { AUTOMATION_RULES } from "@/lib/automations";
import type { JobKind } from "@/lib/jobs/kinds";
import { age, initials, linesSummary, longStamp, money0, shortDate, stamp } from "@/lib/ops/format";
import { Sparkline } from "./_components/Sparkline";

export const dynamic = "force-dynamic";

/**
 * Command Center (§8.1).
 *
 * Order on the page is the argument: the attention queue is first, the pipeline
 * strip second, KPIs below the fold. An ops console opens to answer "what needs
 * me", and a KPI row at the top answers a different question — one nobody asks
 * at 9am on a Wednesday.
 */
export default async function CommandCenter() {
  const [rawOrders, accountsAwaitingFirstOrder] = await Promise.all([
    loadOrders({ status: { notIn: ["cancelled", "rejected", "expired"] } }),
    db.account.count({ where: { firstOrderAt: null, approvalStatus: "approved" } }),
  ]);
  const orders = stageOrders(rawOrders);

  const [attention, columns, tiles, activity, health] = await Promise.all([
    attentionQueue(orders),
    Promise.resolve(pipelineColumns(orders, accountsAwaitingFirstOrder)),
    kpis(orders),
    liveActivity(12),
    ruleHealth(),
  ]);

  const movingOnTheirOwn = orders.filter((o) => o.pipeline.stage !== "blocked").length;
  const todayKey = shortDate(new Date());
  const scheduledToday = orders.filter(
    (o) => o.pipeline.stage === "scheduled" && o.scheduledFor && shortDate(o.scheduledFor) === todayKey,
  );

  const circled = ["①", "②", "③", "④", "⑤", "⑥", "⑦"];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{longStamp()}</div>
          <h1>Command Center</h1>
          <p>
            {attention.length === 0
              ? `Nothing needs you. ${movingOnTheirOwn} orders are moving on their own.`
              : `${attention.length} thing${attention.length === 1 ? "" : "s"} need a person. ${movingOnTheirOwn} orders are moving on their own.`}
          </p>
        </div>
        <div className="actions">
          <Link className="btn" href="/ops/deliveries">
            Print today&rsquo;s receipts
          </Link>
          <Link className="btn primary" href="/ops/orders">
            Open orders board
          </Link>
        </div>
      </div>

      {/* ---- Pipeline strip ---- */}
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Pipeline</h3>
          <span className="small muted">Click a stage to filter the board</span>
        </div>
        <div className="pipe">
          {columns.map((col, i) => (
            <Link
              className="col"
              key={col.key}
              href={col.index === 0 ? "/ops/accounts" : `/ops/orders?stage=${col.key}`}
            >
              <div className="k">
                <i style={{ background: `var(--st${i + 1})` }} />
                {circled[i]} {col.label}
              </div>
              <div className="n">{col.count}</div>
              <div className="v">{col.index === 0 ? "awaiting first order" : money0(col.value)}</div>
              {col.blocked > 0 ? (
                <span className="pill serious blk">{col.blocked} blocked</span>
              ) : (
                <span className="blk" style={{ height: 20 }} />
              )}
            </Link>
          ))}
        </div>
      </section>

      {/* ---- Attention queue + today ---- */}
      <div className="grid g-attn" style={{ marginBottom: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <h3>Needs attention</h3>
            <span className="small muted">ranked by consequence · each has one owner and one action</span>
          </div>
          {attention.length === 0 ? (
            <div className="state">
              <b>Nothing needs you.</b>
              <span>{movingOnTheirOwn} orders are moving on their own.</span>
            </div>
          ) : (
            <div className="attn">
              {attention.slice(0, 12).map((item, i) => (
                <div className={`item ${item.severity}`} key={`${item.href}-${i}`}>
                  <div className="bar" />
                  <div>
                    <div className="t">{item.title}</div>
                    <div className="m">
                      {item.meta.filter(Boolean).map((m) => (
                        <span key={m}>{m}</span>
                      ))}
                      <span>{age(item.since)}</span>
                      <span className="owner">
                        <span className="avatar">{initials(item.owner)}</span>
                        {item.owner}
                      </span>
                    </div>
                  </div>
                  <Link className="btn sm" href={item.href}>
                    {item.action}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="grid" style={{ alignContent: "start" }}>
          <section className="panel">
            <div className="panel-head">
              <h3>Today · {todayKey} deliveries</h3>
              <span className="small muted">{scheduledToday.length} scheduled</span>
            </div>
            {scheduledToday.length === 0 ? (
              <div className="empty">
                <b>No deliveries today.</b>
                Route days come from the schedule in Settings.
              </div>
            ) : (
              scheduledToday.map((o) => (
                <Link className="ship" key={o.id} href={`/ops/orders/${o.id}`}>
                  <b>
                    {o.account.businessName} <span className="muted small mono">{o.invoiceNumber ?? ""}</span>
                  </b>
                  <div className="m">
                    <span>{linesSummary(o.lines)}</span>
                    <span className="num">{money0(o.total)}</span>
                  </div>
                  <div className="m">
                    <span>{o.inventorySource ?? "warehouse tbd"}</span>
                    <span>
                      {o.kegs} kegs ·{" "}
                      {o.expectedEmptyKegs ? `${o.expectedEmptyKegs} empty pickup` : "no empties"}
                    </span>
                  </div>
                </Link>
              ))
            )}
            <div className="actions" style={{ marginTop: 8 }}>
              <Link className="btn sm" href="/ops/deliveries">
                Open week
              </Link>
              <Link className="btn sm ghost" href="/ops/documents">
                Print batch
              </Link>
            </div>
            <p className="small muted" style={{ margin: "10px 0 0" }}>
              Invoices send when a delivery is marked complete — Net 30 from delivery.
            </p>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h3>Automation health · 7d</h3>
              <Link className="small" href="/ops/automations">
                All rules
              </Link>
            </div>
            {AUTOMATION_RULES.slice(0, 6).map((rule) => {
              const kind = ruleToKind(rule.key);
              const h = kind ? health.get(kind) : undefined;
              const rate = h?.successRate7d;
              return (
                <div
                  key={rule.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "6px 0",
                    borderBottom: "1px solid var(--line)",
                    fontSize: 13,
                  }}
                >
                  <span style={{ flex: 1 }}>{rule.name}</span>
                  <span className="small muted mono">{h?.lastRunAt ? age(h.lastRunAt) : "never run"}</span>
                  <span className={`pill ${rate == null ? "neutral" : rate === 100 ? "good" : "warn"}`}>
                    {rate == null ? "no runs" : `${rate}%`}
                  </span>
                </div>
              );
            })}
          </section>
        </div>
      </div>

      {/* ---- KPIs, below the fold on purpose ---- */}
      <div className="grid g5" style={{ marginBottom: 16 }}>
        {tiles.map((t) => (
          <div className="kpi" key={t.label}>
            <div className="l">{t.label}</div>
            <div className="v">{t.value}</div>
            <div className="d">{t.detail}</div>
            <Sparkline values={t.series} />
          </div>
        ))}
      </div>

      {/* ---- Live activity, straight off the append-only event log ---- */}
      <section className="panel">
        <div className="panel-head">
          <h3>Live activity</h3>
          <span className="small muted">append-only order_events</span>
        </div>
        {activity.length === 0 ? (
          <div className="empty">
            <b>No activity yet.</b>
            Every stage change and automation run appends a row here.
          </div>
        ) : (
          <div className="feed">
            {activity.map((a, i) => (
              <div className="ev" key={`${a.orderId}-${i}`}>
                <span className={`who ${a.actor}`}>{a.actor.slice(0, 3).toUpperCase()}</span>
                <div>
                  <Link href={`/ops/orders/${a.orderId}`}>
                    <b>{a.invoiceNumber ?? a.orderId.slice(0, 8)}</b>
                  </Link>{" "}
                  {a.businessName} · <span className="mono small">{a.eventType}</span>
                </div>
                <span className="when">{stamp(a.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

/**
 * Rule key -> job kind. Most rules are one job; the ones that are not (the
 * Sheet mirror runs as part of order confirmation) report no runs rather than
 * borrowing another rule's numbers.
 */
function ruleToKind(key: string): JobKind | null {
  const map: Record<string, JobKind> = {
    auto_stripe_customer_on_account: "ensure_stripe_customer",
    auto_send_setup_link: "send_payment_setup_link",
    sheet_sync_order: "sync_order_to_sheet",
    slack_new_order: "slack_new_order",
    stock_check_on_confirm: "stock_check",
    auto_propose_slot: "propose_delivery_slot",
    auto_invoice_on_delivery: "issue_invoice",
    delivery_digest: "delivery_digest",
    invoice_reminder: "invoice_reminder",
    reorder_alert: "reorder_alert",
    keg_custody_nudge: "keg_custody_nudge",
    sheet_reconcile: "sheet_reconcile",
  };
  return map[key] ?? null;
}
