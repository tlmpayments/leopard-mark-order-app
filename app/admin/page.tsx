import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { auth, signOut } from "@/auth";
import { db } from "@/lib/db";
import { ensureStripeCustomer, sendPaymentSetupLink } from "@/lib/stripeCustomer";

// Proxy already gates /admin/*, but per Next.js's own guidance, don't rely
// on Proxy alone for auth — verify again here.
export default async function AdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/admin/login");

  const pendingAccounts = await db.account.findMany({
    where: { approvalStatus: "pending" },
    include: { contacts: true },
    orderBy: { createdAt: "asc" },
  });

  async function setApproval(accountId: string, status: "approved" | "rejected") {
    "use server";
    await db.account.update({ where: { id: accountId }, data: { approvalStatus: status } });
    if (status === "approved") {
      // Best-effort, same non-blocking philosophy as syncOrderToSheet — a
      // Stripe/email hiccup must never undo the approval decision an admin
      // just made. ensureStripeCustomer/sendPaymentSetupLink each persist
      // their own state as they go, so a failure here just means no setup
      // link went out yet; nothing to roll back.
      try {
        await ensureStripeCustomer(accountId);
        await sendPaymentSetupLink(accountId);
      } catch (err) {
        console.error(`Stripe linking failed for approved account ${accountId}:`, err);
      }
    }
    revalidatePath("/admin");
  }

  return (
    <main className="app-shell">
      <div className="rep-block">
        <div className="name">{session.user.name}</div>
        <div className="rep-label">Admin</div>
      </div>

      <div style={{ display: "flex", gap: "10px", marginBottom: "20px" }}>
        <Link href="/admin/accounts" className="btn btn-ghost">
          Accounts &amp; Billing
        </Link>
        <Link href="/admin/inventory" className="btn btn-ghost">
          Inventory
        </Link>
      </div>

      <div className="section-title">Pending Portal Signups ({pendingAccounts.length})</div>
      {pendingAccounts.length === 0 ? (
        <p className="admin-note">No accounts waiting on approval.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "24px" }}>
          {pendingAccounts.map((account) => (
            <div key={account.id} className="login-card" style={{ gap: "10px" }}>
              <div style={{ fontWeight: 600, fontSize: "16px" }}>{account.businessName}</div>
              {account.contacts.map((contact) => (
                <div key={contact.id} className="admin-note" style={{ margin: 0 }}>
                  {contact.name ? `${contact.name} — ` : ""}
                  {contact.email}
                  {contact.phoneE164 ? ` — ${contact.phoneE164}` : ""}
                </div>
              ))}
              {account.address ? (
                <div className="admin-note" style={{ margin: 0 }}>{account.address}</div>
              ) : null}
              {account.licenseNumber ? (
                <div className="admin-note" style={{ margin: 0 }}>License: {account.licenseNumber}</div>
              ) : null}
              <div style={{ display: "flex", gap: "10px", marginTop: "4px" }}>
                <form action={setApproval.bind(null, account.id, "approved")} style={{ flex: 1 }}>
                  <button className="btn btn-primary btn-block" type="submit">
                    Approve
                  </button>
                </form>
                <form action={setApproval.bind(null, account.id, "rejected")} style={{ flex: 1 }}>
                  <button className="btn btn-ghost btn-block" type="submit">
                    Reject
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="admin-note">
        Foundation-phase placeholder — Sheet sync conflicts, order events, and
        rep/account management land here in later phases.
      </p>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/admin/login" });
        }}
      >
        <button className="btn btn-ghost" type="submit">
          Sign Out
        </button>
      </form>
    </main>
  );
}
