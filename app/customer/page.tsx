import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { db } from "@/lib/db";

// Proxy already gates /customer/* (same pattern as /admin), but per
// Next.js's own guidance, don't rely on Proxy alone for auth — verify again
// here. contactId (not just a session) is the real gate: an admin/rep
// logged in via Credentials has a session but no contactId, since that's
// only ever set by the "resend" provider's jwt callback in auth.ts.
export default async function CustomerHomePage() {
  const session = await auth();
  if (!session?.contactId || !session.accountId) redirect("/customer/login");

  // approvalStatus is deliberately NOT cached on the JWT (unlike
  // contactId/accountId/businessName, which never change once set) --
  // it's exactly the field an admin approving this account needs to take
  // effect immediately, not whenever this customer's session happens to
  // refresh. A live lookup on every page load is the only way an approval
  // shows up right away instead of after a re-login.
  const account = await db.account.findUnique({
    where: { id: session.accountId },
    select: { approvalStatus: true },
  });

  if (account?.approvalStatus !== "approved") {
    return (
      <main className="app-shell">
        <div className="rep-block">
          <div className="name">{session.businessName}</div>
          <div className="rep-label">Account Pending Approval</div>
        </div>
        <p className="admin-note">
          {account?.approvalStatus === "rejected"
            ? "We weren't able to approve this account. Reach out to your sales rep for details."
            : "Thanks for signing up — your account is being reviewed. We'll email you once you're approved to start ordering."}
        </p>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/customer/login" });
          }}
        >
          <button className="btn btn-ghost" type="submit">
            Sign Out
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="rep-block">
        <div className="name">{session.businessName}</div>
        <div className="rep-label">Customer Ordering</div>
      </div>
      <p className="admin-note">
        You&apos;re signed in — ordering, order history, and account details
        land here next.
      </p>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/customer/login" });
        }}
      >
        <button className="btn btn-ghost" type="submit">
          Sign Out
        </button>
      </form>
    </main>
  );
}
