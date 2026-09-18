"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";

export function UnlockForm({ next }: { next: string }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(value: string) {
    if (submitting) return;
    setError("");
    setSubmitting(true);
    const res = await signIn("ops-pin", { pin: value, redirect: false });
    setSubmitting(false);
    if (res?.error) {
      setError("That PIN did not match.");
      setPin("");
      return;
    }
    // A full document load, not router.push(). Signing in changes what every
    // server component on the way to `next` returns, and the App Router still
    // holds the pre-login payload for that URL -- which was a redirect back to
    // this page. Replaying it inside a client transition threw React #441 and
    // left the destination blank; a real navigation refetches the whole tree
    // with the session cookie the sign-in just set.
    //
    // `replace`, not `assign`, so Back does not return to the unlock screen.
    window.location.replace(next);
  }

  return (
    <main className="auth-screen">
      {/* The navy artwork, same as every other internal sign-in. */}
      <img
        className="brand-logo"
        src="/rep-app/assets/icons/brand/logo-alt.svg"
        alt="The Leopard Mark Brewing Co."
      />
      <div className="brand-sub">Ops</div>
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(pin);
        }}
      >
        <div className="field">
          <label htmlFor="ops-pin">PIN</label>
          <input
            id="ops-pin"
            className="pin-input"
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={4}
            placeholder="••••"
            value={pin}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 4);
              setPin(digits);
              setError("");
              // Four digits is the whole credential, so there is nothing left
              // to wait for -- submit rather than ask for a second gesture.
              if (digits.length === 4) void submit(digits);
            }}
            autoComplete="current-password"
            autoFocus
            required
          />
        </div>
        <div className="error-text">{error}</div>
        <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
          {submitting ? "Checking…" : "Unlock"}
        </button>
      </form>
    </main>
  );
}
