import Stripe from "stripe";

// One shared client, same singleton-on-globalThis pattern as lib/db.ts (Next.js
// hot-reloads modules in dev; this avoids re-instantiating on every edit).
//
// Constructed LAZILY, on first property access, because `new Stripe("")` throws
// "Neither apiKey nor config.authenticator provided" — so eager construction
// meant that a deployment without STRIPE_SECRET_KEY failed at MODULE IMPORT.
// That took down every route whose import graph reached this file, including
// /api/cron/jobs: the entire job queue would stop draining because one
// integration was unconfigured, and the only symptom would be an opaque import
// error in the platform logs.
//
// Deferring it means a missing key fails exactly the call that needs Stripe.
// The issue_invoice job then retries, dead-letters, and shows up in
// /ops/automations with a readable reason — which is where an operator can
// actually see it.
const globalForStripe = globalThis as unknown as { stripe?: Stripe };

function createStripe(): Stripe {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set, so this Stripe call cannot be made. " +
        "Set it in the environment; billing jobs will retry on the normal backoff.",
    );
  }
  return new Stripe(apiKey, {
    // Pinned explicitly per Stripe's own recommendation -- an un-pinned
    // client silently follows Stripe's latest API version, which can
    // change response shapes out from under this code with no local signal.
    apiVersion: "2026-08-26.dahlia",
  });
}

function resolveStripe(): Stripe {
  const existing = globalForStripe.stripe;
  if (existing) return existing;
  const client = createStripe();
  if (process.env.NODE_ENV !== "production") {
    globalForStripe.stripe = client;
  }
  return client;
}

/**
 * A stand-in that behaves exactly like the Stripe client at every call site
 * (`stripe.invoices.create(...)`), but does not touch the constructor until a
 * property is actually read.
 */
export const stripe = new Proxy({} as Stripe, {
  get(_target, prop, receiver) {
    const client = resolveStripe();
    const value = Reflect.get(client as object, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
  has(_target, prop) {
    return Reflect.has(resolveStripe() as object, prop);
  },
}) as Stripe;
