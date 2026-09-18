/**
 * Driver sign-in links.
 *
 * The trade this makes, stated plainly: the driver's credential stops being
 * something he knows and becomes something he holds. That is strictly weaker
 * against a stolen phone and strictly stronger against the realistic failure --
 * a PIN typed at a loading dock, forgotten, and then shared with whoever is
 * covering the route this week.
 *
 * What it is NOT is "no authentication". The link is 256 bits of CSPRNG output;
 * guessing one is not a thing that happens. It resolves to a normal session for
 * a specific Rep, so route ownership, `markDelivered`'s record of who delivered
 * it, and every other downstream check are completely unchanged.
 */

import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { appBaseUrl } from "@/lib/email";

/** 32 bytes, base64url — 43 characters, 256 bits. */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface MintedLink {
  token: string;
  url: string;
  id: string;
}

/**
 * Issue a link. Returns the plaintext token exactly once — it is not
 * recoverable afterwards, because only its hash is kept. Losing it means
 * issuing a new one, which is the correct cost.
 */
export async function mintDriverLink(
  repId: string,
  opts: { label?: string | null; createdByUserId?: string | null; baseUrl?: string } = {},
): Promise<MintedLink> {
  const rep = await db.rep.findUniqueOrThrow({ where: { id: repId }, select: { role: true, active: true } });
  if (rep.role !== "driver") throw new Error("Sign-in links are for drivers only.");
  if (!rep.active) throw new Error("That driver is not active.");

  const token = newToken();
  const row = await db.driverAccessToken.create({
    data: {
      repId,
      tokenHash: hashToken(token),
      label: opts.label?.trim() || null,
      createdByUserId: opts.createdByUserId ?? null,
    },
  });

  const base = (opts.baseUrl ?? appBaseUrl()).replace(/\/$/, "");
  return { token, url: `${base}/delivery/k/${token}`, id: row.id };
}

/**
 * Resolve a token to the driver it belongs to, or null.
 *
 * Stamps `lastUsedAt` so a link nobody has touched in months is visibly stale
 * before someone has to decide whether it is safe to leave active.
 */
export async function verifyDriverLink(
  token: string,
): Promise<{ id: string; name: string; role: string } | null> {
  const clean = token.trim();
  // Cheap shape check before touching the database, so a scanner hitting
  // /delivery/k/foo does not cost a query.
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(clean)) return null;

  const row = await db.driverAccessToken.findUnique({
    where: { tokenHash: hashToken(clean) },
    include: { rep: { select: { id: true, name: true, role: true, active: true } } },
  });
  if (!row || row.revokedAt) return null;
  if (!row.rep.active || row.rep.role !== "driver") return null;

  await db.driverAccessToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  return { id: row.rep.id, name: row.rep.name, role: row.rep.role };
}

/** Revoke one link. The row stays, so the audit trail keeps it. */
export async function revokeDriverLink(id: string): Promise<void> {
  await db.driverAccessToken.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Revoke every live link for a driver — the "he lost his phone" button. */
export async function revokeAllForDriver(repId: string): Promise<number> {
  const { count } = await db.driverAccessToken.updateMany({
    where: { repId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count;
}

export async function linksForDriver(repId: string) {
  return db.driverAccessToken.findMany({
    where: { repId },
    orderBy: { createdAt: "desc" },
    select: { id: true, label: true, createdAt: true, lastUsedAt: true, revokedAt: true },
  });
}
