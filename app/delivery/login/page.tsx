"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"] as const;

/**
 * The delivery sign-in: four digits, nothing else.
 *
 * No name. On a phone in a truck the PIN has to be enough, so it identifies
 * the person on its own (lib/deliveryPin.ts). It submits itself on the fourth
 * digit, and works from a keyboard as well as the pad, because the admin area
 * is used at a desk.
 *
 * Why this is a different provider from /admin/login's name + PIN: a session
 * minted here is stamped delivery-only, so this short, nameless credential
 * opens the route builder and the driver's route and nothing else. See
 * proxy.ts.
 */
export default function DeliveryLoginPage() {
  const router = useRouter();
  const [digits, setDigits] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  // The submit reads the latest digits without being re-created on every key.
  const submitting = useRef(false);

  const submit = useCallback(
    async (pin: string) => {
      if (submitting.current) return;
      submitting.current = true;
      setBusy(true);
      const res = await signIn("delivery-pin", { pin, redirect: false });
      if (!res || res.error) {
        submitting.current = false;
        setBusy(false);
        setError(true);
        // Clear after the dots have shown the miss, not before.
        window.setTimeout(() => {
          setDigits("");
          setError(false);
        }, 450);
        return;
      }
      router.push("/delivery");
      router.refresh();
    },
    [router],
  );

  const press = useCallback(
    (key: string) => {
      if (busy || error) return;
      if (key === "back") {
        setDigits((d) => d.slice(0, -1));
        return;
      }
      if (!/^\d$/.test(key)) return;
      setDigits((d) => {
        if (d.length >= 4) return d;
        const next = d + key;
        if (next.length === 4) void submit(next);
        return next;
      });
    },
    [busy, error, submit],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("back");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  return (
    <main className="dv-login">
      {/* The navy artwork, matching the rep app: this ground is light, and the
          light variant would disappear into it. */}
      <img src="/rep-app/assets/icons/brand/logo-alt.svg" alt="The Leopard Mark Brewing Co." />
      <div className="kicker">Delivery</div>

      <p className="dv-pin-prompt" id="pin-prompt">
        Enter your PIN
      </p>
      <div className={`dv-dots${error ? " error" : ""}`} role="img" aria-label={`${digits.length} of 4 digits entered`}>
        {[0, 1, 2, 3].map((i) => (
          <i key={i} className={i < digits.length ? "on" : undefined} />
        ))}
      </div>
      <div className="err" role="alert">
        {error ? "That PIN didn’t work." : ""}
      </div>

      <div className="dv-pad" role="group" aria-labelledby="pin-prompt">
        {KEYS.map((k, i) =>
          k === "" ? (
            <span key={i} />
          ) : (
            <button
              key={i}
              type="button"
              className={k === "back" ? "back" : undefined}
              aria-label={k === "back" ? "Delete" : k}
              disabled={busy}
              onClick={() => press(k)}
            >
              {k === "back" ? "⌫" : k}
            </button>
          ),
        )}
      </div>
    </main>
  );
}
