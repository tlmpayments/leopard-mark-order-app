import { db } from "@/lib/db";
import { AUTOMATION_RULES, autoScheduleDefinition } from "@/lib/automations";
import { ruleHealth } from "@/lib/ops/queries";
import { currentOpsUser, ADMIN_ROLES } from "@/lib/ops/session";
import { age, stamp } from "@/lib/ops/format";
import { discardJobAction, retryJobAction, toggleRuleAction } from "./actions";

export const dynamic = "force-dynamic";

/** Rule key -> the job kind whose runs it produces. */
const RULE_JOB_KIND: Record<string, string> = {
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

/**
 * Automations (§8.9).
 *
 * The screen exists to make §13 true: "every automation is a rule row with a
 * toggle, a run log, and a human-readable name in the hub. If ops can't see it,
 * it doesn't run." Every rule shows its last run and its 7-day success rate,
 * because a toggle that is on tells you what was intended and a run log tells
 * you what actually happened.
 */
export default async function AutomationsPage() {
  const user = await currentOpsUser();
  const isAdmin = user ? (ADMIN_ROLES as readonly string[]).includes(user.role) : false;

  const [rows, health, regions, deadJobs, queueCounts, lastStripe, sheetPending] = await Promise.all([
    db.automationRule.findMany(),
    ruleHealth(),
    db.routeSchedule.findMany({ select: { region: true }, distinct: ["region"] }),
    db.jobRun.findMany({ where: { status: "dead" }, orderBy: { finishedAt: "desc" }, take: 20 }),
    db.jobRun.groupBy({ by: ["status"], _count: { _all: true } }),
    db.stripeEvent.findFirst({ orderBy: { processedAt: "desc" } }),
    db.order.count({ where: { status: "confirmed", sheetSyncedAt: null } }),
  ]);

  const stored = new Map(rows.map((r) => [r.key, r]));
  const definitions = [...AUTOMATION_RULES, ...regions.map((r) => autoScheduleDefinition(r.region))];
  const counts = new Map(queueCounts.map((q) => [q.status, q._count._all]));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Automations</div>
          <h1>Rules &amp; jobs</h1>
          <p>
            If ops can&rsquo;t see it here, it doesn&rsquo;t run. Every run is a row; failures retry on a 1m / 5m / 30m
            / 2h / 12h ladder and then land in the dead-letter queue rather than disappearing.
          </p>
        </div>
      </div>

      <div className="grid g2" style={{ marginBottom: 16 }}>
        {definitions.map((def) => {
          const row = stored.get(def.key);
          const enabled = row?.enabled ?? def.defaultEnabled;
          const kind = RULE_JOB_KIND[def.key];
          const h = kind ? health.get(kind) : undefined;
          return (
            <div className="rule" key={def.key}>
              <div>
                <h4>{def.name}</h4>
                <div className="m">
                  <span className="mono small">{def.trigger}</span> — {def.does}
                </div>
              </div>
              {def.toggleable && isAdmin ? (
                <form action={toggleRuleAction}>
                  <input type="hidden" name="key" value={def.key} />
                  <input type="hidden" name="enabled" value={enabled ? "0" : "1"} />
                  <button
                    className={`tog${enabled ? " on" : ""}`}
                    type="submit"
                    aria-label={`${enabled ? "Disable" : "Enable"} ${def.name}`}
                  />
                </form>
              ) : (
                <span
                  className={`tog${enabled ? " on" : ""}`}
                  title={def.toggleable ? "Admins only" : "Load-bearing — cannot be switched off"}
                  aria-label={enabled ? "Enabled" : "Disabled"}
                />
              )}
              <div className="runs">
                {h && h.runs7d.length ? (
                  <>
                    <span className="spark">
                      {h.runs7d.map((r, i) => (
                        <i key={i} className={r.ok ? "" : "f"} style={{ height: r.ok ? 14 : 8 }} />
                      ))}
                    </span>
                    <span>7d · {h.successRate7d}% ok</span>
                    <span className="muted">last {h.lastRunAt ? age(h.lastRunAt) : "—"}</span>
                  </>
                ) : (
                  <span className="muted">{enabled ? "no runs in the last 7 days" : "off"}</span>
                )}
                {!def.toggleable ? <span style={{ marginLeft: "auto" }}>always on</span> : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid g3" style={{ marginBottom: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <h3>Sheet sync monitor</h3>
            <span className={`pill ${sheetPending > 0 ? "warn" : "good"}`}>
              {sheetPending > 0 ? `${sheetPending} pending` : "healthy"}
            </span>
          </div>
          <dl className="kv">
            <dt>Pending DB→Sheet</dt>
            <dd className="num">{sheetPending}</dd>
            <dt>Ownership</dt>
            <dd className="small">
              Adding a synced column is a five-place coordinated change: the schema, lib/sheetColumns.ts, Code.gs, the
              ownership test, and the Sheet itself.
            </dd>
          </dl>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Stripe webhooks</h3>
            <span className={`pill ${lastStripe ? "good" : "neutral"}`}>{lastStripe ? "healthy" : "no events"}</span>
          </div>
          <dl className="kv">
            <dt>Last event</dt>
            <dd className="mono small">{lastStripe ? `${lastStripe.type}` : "—"}</dd>
            <dt>Received</dt>
            <dd>{lastStripe ? stamp(lastStripe.processedAt) : "—"}</dd>
            <dt>Duplicates</dt>
            <dd className="small muted">Ignored by event id, so a Stripe redelivery cannot double-post.</dd>
          </dl>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Job runner</h3>
            <span className={`pill ${(counts.get("dead") ?? 0) > 0 ? "serious" : (counts.get("failed") ?? 0) > 0 ? "warn" : "good"}`}>
              {(counts.get("dead") ?? 0) > 0
                ? `${counts.get("dead")} dead`
                : (counts.get("failed") ?? 0) > 0
                  ? `${counts.get("failed")} retrying`
                  : "clear"}
            </span>
          </div>
          <dl className="kv">
            <dt>Queued</dt>
            <dd className="num">{counts.get("queued") ?? 0}</dd>
            <dt>Running</dt>
            <dd className="num">{counts.get("running") ?? 0}</dd>
            <dt>Retrying</dt>
            <dd className="num">{counts.get("failed") ?? 0}</dd>
            <dt>Succeeded</dt>
            <dd className="num">{counts.get("succeeded") ?? 0}</dd>
          </dl>
        </section>
      </div>

      <section className="panel flush">
        <div className="panel-head">
          <h3>Dead-letter queue</h3>
          <span className={`pill ${deadJobs.length ? "serious" : "good"}`}>{deadJobs.length || "empty"}</span>
        </div>
        {deadJobs.length === 0 ? (
          <div className="empty">
            <b>Nothing has given up.</b>
            A job that exhausts its retries lands here instead of vanishing.
          </div>
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Attempts</th>
                  <th>Last error</th>
                  <th>Gave up</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {deadJobs.map((j) => (
                  <tr key={j.id}>
                    <td className="mono small">{j.idempotencyKey}</td>
                    <td className="num">
                      {j.attempts}/{j.maxAttempts}
                    </td>
                    <td className="small" style={{ color: "var(--serious-ink)", maxWidth: 380 }}>
                      {j.lastError ?? "—"}
                    </td>
                    <td className="small mono">{j.finishedAt ? stamp(j.finishedAt) : "—"}</td>
                    <td className="r">
                      <div className="actions" style={{ justifyContent: "flex-end" }}>
                        <form action={retryJobAction}>
                          <input type="hidden" name="jobId" value={j.id} />
                          <button className="btn sm" type="submit">
                            Retry
                          </button>
                        </form>
                        {isAdmin ? (
                          <form action={discardJobAction}>
                            <input type="hidden" name="jobId" value={j.id} />
                            <button className="btn sm ghost" type="submit">
                              Discard
                            </button>
                          </form>
                        ) : null}
                      </div>
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
