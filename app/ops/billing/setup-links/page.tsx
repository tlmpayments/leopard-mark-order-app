import Link from "next/link";
import { db } from "@/lib/db";
import { stamp } from "@/lib/ops/format";

export const dynamic = "force-dynamic";

/**
 * Payment setup links — where ach.tlmbg.co lands (§2 rule 1).
 *
 * ach.tlmbg.co was a whole Vercel project for one job: get a retailer onto ACH.
 * It is one screen here, and the reason it belongs next to Billing is that
 * "who has no payment method on file" is a billing question, not an onboarding
 * one — it decides whether an invoice charges automatically or has to be chased.
 */
export default async function SetupLinksPage() {
  const accounts = await db.account.findMany({
    where: { approvalStatus: { not: "rejected" } },
    select: {
      id: true,
      businessName: true,
      region: true,
      billingContactEmail: true,
      stripeCustomerId: true,
      stripeDefaultPaymentMethod: true,
      stripeSetupLinkSentAt: true,
      contacts: { select: { email: true }, take: 1 },
    },
    orderBy: { businessName: "asc" },
  });

  const onAch = accounts.filter((a) => a.stripeDefaultPaymentMethod);
  const awaiting = accounts.filter((a) => !a.stripeDefaultPaymentMethod && a.stripeSetupLinkSentAt);
  const notSent = accounts.filter((a) => !a.stripeDefaultPaymentMethod && !a.stripeSetupLinkSentAt);
  const pct = accounts.length ? Math.round((onAch.length / accounts.length) * 100) : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Billing · ach.tlmbg.co</div>
          <h1>Payment setup links</h1>
          <p>
            An account with ACH on file gets charged automatically; one without gets a payable invoice and has to be
            chased. That is the whole reason this list matters.
          </p>
        </div>
        <div className="actions">
          <Link className="btn ghost" href="/ops/billing">
            ← Invoices
          </Link>
        </div>
      </div>

      <div className="grid g3" style={{ marginBottom: 16 }}>
        <div className="kpi">
          <div className="l">ACH on file</div>
          <div className="v">{pct}%</div>
          <div className="d">
            {onAch.length} of {accounts.length} active accounts
          </div>
        </div>
        <div className="kpi">
          <div className="l">Link sent, not completed</div>
          <div className="v">{awaiting.length}</div>
          <div className="d">a reminder is capped at one per 7 days</div>
        </div>
        <div className="kpi">
          <div className="l">Never sent</div>
          <div className="v">{notSent.length}</div>
          <div className="d">send from the account page</div>
        </div>
      </div>

      <section className="panel flush">
        <div className="panel-head">
          <h3>Accounts without a payment method</h3>
          <span className="small muted">{awaiting.length + notSent.length}</span>
        </div>
        {awaiting.length + notSent.length === 0 ? (
          <div className="empty">
            <b>Every account is on ACH.</b>
            Nothing to chase.
          </div>
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Region</th>
                  <th>Billing email</th>
                  <th>Stripe customer</th>
                  <th>Link sent</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...awaiting, ...notSent].map((a) => {
                  const email = a.billingContactEmail ?? a.contacts[0]?.email ?? null;
                  return (
                    <tr className="row" key={a.id}>
                      <td>
                        <Link href={`/ops/accounts/${a.id}`}>
                          <b>{a.businessName}</b>
                        </Link>
                      </td>
                      <td>{a.region ? <span className="region">{a.region}</span> : "—"}</td>
                      <td className="small">
                        {email ?? <span style={{ color: "var(--serious-ink)" }}>none — cannot send</span>}
                      </td>
                      <td>
                        {a.stripeCustomerId ? (
                          <span className="pill good">created</span>
                        ) : (
                          <span className="pill warn">not yet</span>
                        )}
                      </td>
                      <td className="small mono muted">
                        {a.stripeSetupLinkSentAt ? stamp(a.stripeSetupLinkSentAt) : "never"}
                      </td>
                      <td className="r">
                        <Link className="btn sm" href={`/ops/accounts/${a.id}`}>
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
