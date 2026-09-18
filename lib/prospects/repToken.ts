import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The rep app's credential for the prospect API.
 *
 * The rep PWA does not hold a NextAuth session. It signs in against the Apps
 * Script Reps sheet with a four-digit PIN, and that is the only identity it
 * has -- so the API verifies the PIN once, against the same sheet, and hands
 * back a signed token the app can present on later writes. The PIN itself is
 * never stored client-side beyond the login screen and never travels again.
 *
 * Signed with a key derived from AUTH_SECRET rather than a new environment
 * variable: it is already set in production and already the secret this app
 * signs sessions with, and one more secret to rotate is one more secret to
 * forget. Derived rather than used directly so that a token from here can
 * never be confused with -- or substituted for -- a NextAuth one: the two
 * signing keys are different values even though they come from one secret.
 */

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // a month: a rep signs in rarely

export type RepIdentity = { rep: string; role: "Rep" | "Admin" };

function signingKey(): Buffer {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is not set; the prospect API cannot sign tokens.");
  return createHmac("sha256", value).update("prospect-rep-token/v1").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", signingKey()).update(payload).digest("base64url");
}

export function issueRepToken(identity: RepIdentity, now = Date.now()): string {
  // The rep's name is inside the signature, so a token cannot be edited into
  // somebody else's identity without the secret.
  const payload = `${encodeURIComponent(identity.rep)}.${identity.role}.${now + TOKEN_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyRepToken(token: string | null | undefined, now = Date.now()): RepIdentity | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [rep, role, expires, signature] = parts;
  const payload = `${rep}.${role}.${expires}`;

  let expected: Buffer;
  let given: Buffer;
  try {
    expected = Buffer.from(sign(payload));
    given = Buffer.from(signature);
  } catch {
    return null;
  }
  // Lengths must match before timingSafeEqual will look at them at all, and a
  // mismatched length is itself a failed signature.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (!Number.isFinite(Number(expires)) || Number(expires) < now) return null;
  if (role !== "Rep" && role !== "Admin") return null;

  return { rep: decodeURIComponent(rep), role };
}

/** The Authorization header the rep app sends, or null. */
export function repTokenFromRequest(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

/**
 * Ask Apps Script whether this PIN belongs to anyone. The Reps sheet stays the
 * single source of who a rep is -- duplicating the PINs into Postgres would
 * mean two places to add a rep and one of them silently wrong.
 */
export async function verifyPinWithAppsScript(pin: string): Promise<RepIdentity | null> {
  const base = process.env.APPS_SCRIPT_URL;
  if (!base) throw new Error("APPS_SCRIPT_URL is not set; the prospect API cannot verify PINs.");
  if (!/^\d{4}$/.test(pin)) return null;

  const url = `${base}?action=pinLogin&pin=${encodeURIComponent(pin)}`;
  const response = await fetch(url, { redirect: "follow", cache: "no-store" });
  if (!response.ok) throw new Error(`Apps Script refused the PIN check (${response.status}).`);

  const body = (await response.json()) as { ok?: boolean; rep?: string; role?: string };
  if (!body?.ok || !body.rep) return null;
  return { rep: body.rep, role: body.role === "Admin" ? "Admin" : "Rep" };
}
