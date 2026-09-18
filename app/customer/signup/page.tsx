import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { signIn } from "@/auth";
import { db } from "@/lib/db";

// The only place a brand-new Account+Contact pair gets created from outside
// the rep app/Sheet import. approvalStatus defaults to 'pending' (schema
// default) — every account that existed before this field shipped was
// backfilled to 'approved' in its own migration, so 'pending' is reserved
// for exactly this path. No license/credit checking happens here on
// purpose: those are separate, independent gates (see
// prisma/schema.prisma's Account.approvalStatus comment) that only start
// to matter once a human has approved the account exists at all.
export default async function CustomerSignupPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
}) {
  const params = await searchParams;
  const sent = params.sent === "1";

  async function createAccountAndSend(formData: FormData) {
    "use server";
    const businessName = String(formData.get("businessName") ?? "").trim();
    const contactName = String(formData.get("contactName") ?? "").trim();
    const email = String(formData.get("email") ?? "")
      .trim()
      .toLowerCase();
    const phone = String(formData.get("phone") ?? "").trim();
    const address = String(formData.get("address") ?? "").trim();
    const licenseNumber = String(formData.get("licenseNumber") ?? "").trim();

    if (!businessName || !email) return;

    try {
      // Someone re-submitting (double-click, or an already-registered
      // email trying to "sign up" again) should just get signed in to
      // whatever already exists for that email, not a second pending
      // Account for the same business.
      const existing = await db.contact.findFirst({ where: { email } });
      if (!existing) {
        await db.account.create({
          data: {
            businessName,
            address: address || null,
            licenseNumber: licenseNumber || null,
            contacts: {
              create: {
                name: contactName || null,
                email,
                phoneE164: phone || null,
              },
            },
          },
        });
      }
      await signIn("resend", { email, redirectTo: "/customer/signup?sent=1" });
    } catch (error) {
      if (error instanceof AuthError) {
        redirect("/customer/signup?error=1");
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
      <div className="brand-sub">Create an Account</div>

      {sent ? (
        <div className="login-card" style={{ textAlign: "center", gap: "6px" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>Check your email</p>
          <p className="admin-note" style={{ margin: 0 }}>
            We sent a sign-in link to confirm your address. Once you click
            it, your account will be reviewed before you can place orders —
            we&apos;ll be in touch.
          </p>
        </div>
      ) : (
        <form action={createAccountAndSend} className="login-card">
          <div className="field">
            <label htmlFor="su-business">Business Name *</label>
            <input id="su-business" name="businessName" required />
          </div>
          <div className="field">
            <label htmlFor="su-contact">Your Name</label>
            <input id="su-contact" name="contactName" autoComplete="name" />
          </div>
          <div className="field">
            <label htmlFor="su-email">Email *</label>
            <input id="su-email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="field">
            <label htmlFor="su-phone">Phone</label>
            <input id="su-phone" name="phone" type="tel" autoComplete="tel" />
          </div>
          <div className="field">
            <label htmlFor="su-address">Address</label>
            <input id="su-address" name="address" autoComplete="street-address" />
          </div>
          <div className="field">
            <label htmlFor="su-license">License Number (if known)</label>
            <input id="su-license" name="licenseNumber" />
          </div>
          {params.error ? (
            <div className="error-text">Something went wrong — try again.</div>
          ) : null}
          <button className="btn btn-primary btn-block" type="submit">
            Create Account
          </button>
        </form>
      )}

      <a className="login-alt-link" href="/customer/login">
        Already have an account? Sign in
      </a>
    </main>
  );
}
