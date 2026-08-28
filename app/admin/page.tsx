import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";

// Proxy already gates /admin/*, but per Next.js's own guidance, don't rely
// on Proxy alone for auth — verify again here.
export default async function AdminPage() {
  const session = await auth();
  if (!session?.user) redirect("/admin/login");

  return (
    <main className="admin-shell">
      <div className="rep-block">
        <div className="name">{session.user.name}</div>
        <div className="rep-label">Admin</div>
      </div>
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
