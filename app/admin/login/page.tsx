"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

export default function AdminLoginPage() {
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
      setError("Invalid name or PIN.");
      return;
    }
    router.push("/admin");
    router.refresh();
  }

  return (
    <main className="auth-screen">
      <img
        className="brand-logo"
        src="/rep-app/assets/icons/brand/logo-alt.svg"
        alt="The Leopard Mark Brewing Co."
      />
      <div className="brand-sub">Admin Sign In</div>
      <form onSubmit={onSubmit} className="login-card">
        <div className="field">
          <label htmlFor="admin-name">Name</label>
          <input
            id="admin-name"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="admin-pin">PIN</label>
          <input
            id="admin-pin"
            placeholder="4-digit PIN"
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
        <div className="error-text">{error}</div>
        <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
          {submitting ? "Checking…" : "Sign In"}
        </button>
      </form>
    </main>
  );
}
