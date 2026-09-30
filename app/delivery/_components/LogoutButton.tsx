"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";

/**
 * Sign out, top right.
 *
 * A driver's phone is sometimes the office's phone for a day, and an admin's
 * session is authority over every route, so signing out has to be one visible
 * tap rather than a thing you clear cookies to do. It lands on the delivery
 * sign-in rather than the admin one, for the same reason /delivery/login
 * exists at all.
 */
export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="dv-btn quiet inline sm"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void signOut({ redirectTo: "/delivery/login" }).catch(() => setBusy(false));
      }}
    >
      {busy ? "Signing out…" : "Log out"}
    </button>
  );
}
