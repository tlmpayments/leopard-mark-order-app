import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn } from "@/auth";

// The one public page under /customer -- proxy.ts redirects every other
// /customer/* path here when there's no session with a contactId. Uses a
// server action (not the client-side next-auth/react signIn the admin
// login page uses) because there's no synchronous credential to validate
// here -- the whole flow is "send an email, tell them to go check it,"
// which a plain form post handles with zero client JS.
export default async function CustomerLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const params = await searchParams;
  const sent = params.sent === "1";

  async function sendMagicLink(formData: FormData) {
    "use server";
    const email = String(formData.get("email") ?? "").trim();
    if (!email) return;
    try {
      await signIn("resend", { email, redirectTo: "/customer/login?sent=1" });
    } catch (error) {
      // signIn's own successful redirect throws too (Next.js's redirect
      // mechanism) -- only AuthError means the send itself actually failed;
      // anything else must be re-thrown or a successful send never lands.
      if (error instanceof AuthError) {
        redirect("/customer/login?error=1");
      }
      throw error;
    }
  }

  return (
    <main className="auth-screen">
      <img
        className="brand-logo"
        src="/rep-app/assets/icons/brand/logo-alt.svg"
        alt="The Leopard Mark Brewing Co."
      />
      <div className="brand-sub">Customer Ordering</div>

      {sent ? (
        <div className="login-card" style={{ textAlign: "center", gap: "6px" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Check your email</p>
          <p className="admin-note" style={{ margin: 0 }}>
            We sent a sign-in link to your inbox. It expires in 24 hours —
            didn&apos;t get it? Check spam, or send another below.
          </p>
        </div>
      ) : null}

      <form action={sendMagicLink} className="login-card">
        <div className="field">
          <label htmlFor="customer-email">Email</label>
          <input
            id="customer-email"
            name="email"
            type="email"
            placeholder="you@yourbusiness.com"
            autoComplete="email"
            required
          />
        </div>
        {params.error ? (
          <div className="error-text">
            Something went wrong sending that link — try again.
          </div>
        ) : null}
        <button className="btn btn-primary btn-block" type="submit">
          Send Sign-In Link
        </button>
      </form>

      <a className="login-alt-link" href="/customer/signup">
        New customer? Create an account
      </a>
    </main>
  );
}
