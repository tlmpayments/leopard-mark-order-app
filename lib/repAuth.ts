// Shared by auth.ts's NextAuth Credentials provider (session-based, for
// /admin) and app/api/rep-app/route.ts's stateless login (for the rep app
// itself) -- both authenticate against the same Rep.pinHash field and must
// never silently diverge on what counts as a valid PIN or how first-login
// PIN-setting works. Neither caller enforces a role restriction here --
// that's each caller's own concern (auth.ts additionally requires
// role === "admin"; the rep-app route allows any active rep).
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

export interface RepAuthResult {
  ok: boolean;
  rep?: { id: string; name: string; role: string };
  error?: string;
}

export async function verifyRepPin(
  name: string,
  pin: string,
  requiredRole?: string,
): Promise<RepAuthResult> {
  const cleanName = String(name ?? "").trim();
  const cleanPin = String(pin ?? "").trim();
  if (!cleanName || !/^\d{4}$/.test(cleanPin)) {
    return { ok: false, error: "Invalid name or PIN" };
  }

  const rep = await db.rep.findUnique({ where: { name: cleanName } });
  if (!rep || !rep.active) return { ok: false, error: "Invalid name or PIN" };

  // Role check happens BEFORE any PIN-setting side effect, on purpose: a
  // non-admin rep mistakenly (or curiously) trying the /admin login must
  // never have their PIN set as a side effect of that attempt -- they
  // should only ever set it through their own real login flow (the rep
  // app). Checking role first, not after, is what preserves that.
  if (requiredRole && rep.role !== requiredRole) {
    return { ok: false, error: "Invalid name or PIN" };
  }

  // First login: no PIN set yet, so this submission sets it -- mirrors
  // Code.gs's handleSetPin exactly (only works while pinHash is null; once
  // set, this path never touches it again).
  if (!rep.pinHash) {
    const pinHash = await bcrypt.hash(cleanPin, 10);
    await db.rep.update({ where: { id: rep.id }, data: { pinHash } });
    return { ok: true, rep: { id: rep.id, name: rep.name, role: rep.role } };
  }

  const valid = await bcrypt.compare(cleanPin, rep.pinHash);
  if (!valid) return { ok: false, error: "Invalid name or PIN" };
  return { ok: true, rep: { id: rep.id, name: rep.name, role: rep.role } };
}
