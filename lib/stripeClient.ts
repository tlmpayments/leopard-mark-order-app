import Stripe from "stripe";

// One shared client, same singleton-on-globalThis pattern as lib/db.ts (Next.js
// hot-reloads modules in dev; this avoids re-instantiating on every edit).
const globalForStripe = globalThis as unknown as { stripe?: Stripe };

export const stripe =
  globalForStripe.stripe ??
  new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
    // Pinned explicitly per Stripe's own recommendation -- an un-pinned
    // client silently follows Stripe's latest API version, which can
    // change response shapes out from under this code with no local signal.
    apiVersion: "2026-08-26.dahlia",
  });

if (process.env.NODE_ENV !== "production") {
  globalForStripe.stripe = stripe;
}
