"use client";

import { useEffect, useState } from "react";

// Reps who already installed the old static rep PWA have a home-screen icon
// whose start_url is frozen to this origin's root. Once this Next.js app
// takes over "/", their icon would otherwise 404 or land on the customer
// portal instead of the rep app. `lm_rep` is the exact localStorage key the
// legacy app.js has always used for session persistence — if it's set, this
// browser has used the rep app before, so send it straight to the app's new
// home instead of showing the portal. See plan: "Repo layout & the rep
// app's installed-PWA risk."
export default function RootPage() {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (window.localStorage.getItem("lm_rep")) {
        window.location.replace("/rep-app/");
        return;
      }
    } catch {
      // localStorage unavailable (private mode, etc.) — fall through to portal.
    }
    setChecked(true);
  }, []);

  if (!checked) return null;

  return (
    <main className="auth-screen">
      <img
        className="brand-logo"
        src="/rep-app/assets/icons/brand/logo-alt.svg"
        alt="The Leopard Mark Brewing Co."
      />
      <div className="brand-sub">Customer Ordering</div>
      <p className="admin-note">Coming soon.</p>
    </main>
  );
}
