"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

/**
 * The driver's sign-in.
 *
 * Same name + PIN as every other internal surface -- one credential per person,
 * not one per app. It exists separately from /admin/login only because that page
 * is headed "Admin Sign In" and pushes to /admin on success, which for a driver
 * is a locked door.
 */
export default function DeliveryLoginPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    const res = await signIn("credentials", { name, pin, redirect: false });
    setSubmitting(false);
    if (res?.error) {
      setError("That name and PIN did not match.");
      return;
    }
    router.push("/delivery");
    router.refresh();
  }

  return (
    <main className="dv-login">
      {/* The navy artwork, matching the rep app: this ground is light now, and
          the light variant would disappear into it. */}
      <img src="/rep-app/assets/icons/brand/logo-alt.svg" alt="The Leopard Mark Brewing Co." />
      <div className="kicker">Delivery</div>
      <form onSubmit={onSubmit}>
        <div>
          <label className="dv-lab" htmlFor="dv-name">
            Your name
          </label>
          <input
            id="dv-name"
            className="dv-in"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="username"
            autoCapitalize="words"
            required
          />
        </div>
        <div>
          <label className="dv-lab" htmlFor="dv-pin">
            PIN
          </label>
          <input
            id="dv-pin"
            className="dv-in num"
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <div className="err">{error}</div>
        <button className="dv-btn primary" type="submit" disabled={submitting}>
          {submitting ? "Checking…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
