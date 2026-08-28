import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

// Internal admin/ops auth — reps log in the same way they already do in the
// rep app (name + PIN), but only role="admin" reps get past the /admin gate.
// Phase 4 (customer portal) adds an Email magic-link provider alongside this
// one; this file is meant to be the single shared auth system, not a
// throwaway Phase 1 stand-in that gets replaced.
export const { handlers, signIn, signOut, auth } = NextAuth({
  session: { strategy: "jwt" },
  pages: { signIn: "/admin/login" },
  providers: [
    Credentials({
      credentials: {
        name: { label: "Name", type: "text" },
        pin: { label: "PIN", type: "password" },
      },
      async authorize(credentials) {
        const name = String(credentials?.name ?? "").trim();
        const pin = String(credentials?.pin ?? "").trim();
        if (!name || !/^\d{4}$/.test(pin)) return null;

        const rep = await db.rep.findUnique({ where: { name } });
        if (!rep || !rep.active || rep.role !== "admin") return null;

        // First login: no PIN set yet, so this submission sets it — mirrors
        // Code.gs's handleSetPin exactly (only works while pinHash is null;
        // once set, this path never touches it again).
        if (!rep.pinHash) {
          const pinHash = await bcrypt.hash(pin, 10);
          await db.rep.update({ where: { id: rep.id }, data: { pinHash } });
          return { id: rep.id, name: rep.name };
        }

        const valid = await bcrypt.compare(pin, rep.pinHash);
        if (!valid) return null;
        return { id: rep.id, name: rep.name };
      },
    }),
  ],
});
