/**
 * TEMPORARY: run the Ops Hub with no login.
 *
 * Enabled by `OPS_PUBLIC_ACCESS=1`. While it is on, /ops and /docs are
 * reachable by anyone who knows the hostname, and every request is treated as
 * an admin — so the hub's reads (108 real customer accounts, their licence
 * numbers, billing emails and delivery addresses) and its writes (Mark
 * delivered, which mints BOL numbers and writes the inventory ledger; Issue
 * invoice, which calls Stripe; the automation toggles) are all public.
 *
 * This is deliberately a flag rather than deleted auth code, for two reasons:
 * turning it back off is `vercel env rm OPS_PUBLIC_ACCESS` plus a redeploy with
 * no code change, and the role gating stays intact underneath so nothing has to
 * be rebuilt to restore it.
 *
 * /admin is NOT covered. Approving an account there creates a Stripe customer
 * and emails a payment-setup link to a real retailer, so it keeps its own gate.
 */
export function isPublicAccess(): boolean {
  return process.env.OPS_PUBLIC_ACCESS === "1";
}

/**
 * The identity every request gets while the flag is on.
 *
 * Named so it is obvious in the UI — and in any OrderEvent it writes — that
 * this was not a real person. The audit trail (§1.4) is the evidence base if an
 * order is ever disputed, and "someone, via the open hub" is the honest answer
 * to who did it.
 */
export const PUBLIC_ACCESS_USER = {
  id: "public-access",
  name: "Public access",
  role: "admin" as const,
};
