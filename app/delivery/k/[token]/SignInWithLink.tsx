"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

export function SignInWithLink({ token }: { token: string }) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await signIn("driver-link", { token, redirect: false });
      if (cancelled) return;
      if (res?.error) {
        setFailed(true);
        return;
      }
      // `replace`, not `push`: the token must not sit in the back stack where
      // the next person to pick up the phone can walk back into it.
      router.replace("/delivery");
      router.refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [token, router]);

  return (
    <main className="dv-login">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/rep-app/assets/icons/brand/logo-alt.svg" alt="The Leopard Mark Brewing Co." />
      <div className="kicker">Delivery</div>
      {failed ? (
        <>
          <p style={{ color: "var(--serious-ink)" }}>This link is no longer valid.</p>
          <p className="sm muted">Ask the office for a new one.</p>
          {/* An old link tapped from an old message does not mean he is locked
              out -- he may still have a good session on this phone. Offer the
              route first; the proxy sends him to sign-in if he really is out. */}
          <a className="dv-btn" href="/delivery" style={{ marginTop: 12 }}>
            Go to my route
          </a>
          <a className="dv-btn quiet" href="/delivery/login" style={{ marginTop: 8 }}>
            Sign in with name and PIN
          </a>
        </>
      ) : (
        <p className="muted">Signing you in…</p>
      )}
    </main>
  );
}
