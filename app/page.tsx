import { redirect } from "next/navigation";

// The root belongs to the rep app. proxy.ts already redirects "/" to
// /rep-app before routing reaches this file (see its step 1b), so this is
// the backstop: without it, a future change to the proxy's matcher would
// turn the root into a 404 rather than falling through to something safe.
//
// What used to be here: a client-side "Customer Ordering — coming soon."
// placeholder that only forwarded reps whose browser already carried the
// legacy `lm_rep` localStorage key. A rep arriving fresh, or on a new
// phone, got the placeholder and no way through -- which is exactly why
// it's gone.
export default function RootPage() {
  redirect("/rep-app");
}
