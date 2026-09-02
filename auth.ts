import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter } from "next-auth/adapters";
import { verifyRepPin } from "@/lib/repAuth";
import { db } from "@/lib/db";
import type { UserRole } from "@/app/generated/prisma/enums";

// @auth/prisma-adapter hardcodes calls to prisma.user/.account/.session/
// .verificationToken. This schema's own `Account` model already means
// "wholesale customer business" (prisma/schema.prisma), which collides with
// Auth.js's own "linked provider account" meaning of the same name -- so
// its bookkeeping tables are named AuthUser/AuthOAuthAccount/AuthSession
// instead. This facade aliases them onto the shape the adapter expects
// without renaming anything already built against the real domain models.
const authAdapterDb = {
  user: db.authUser,
  account: db.authOAuthAccount,
  session: db.authSession,
  verificationToken: db.verificationToken,
} as unknown as Parameters<typeof PrismaAdapter>[0];

// Internal admin/ops auth (Credentials: name + PIN, same as the rep app)
// and the customer portal's magic-link login share this one NextAuth
// instance rather than being two separate auth systems -- see the plan's
// "this file is meant to be the single shared auth system" note. Each
// surface's own route protection (proxy.ts) decides which sign-in page an
// unauthenticated visitor lands on; NextAuth's own `pages.signIn` is only
// ever reached for /admin's flow, since the customer flow never calls the
// built-in redirect-on-unauthenticated path (proxy.ts handles that itself,
// same pattern as /admin).
export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: PrismaAdapter(authAdapterDb) as Adapter,
  session: { strategy: "jwt" },
  pages: { signIn: "/admin/login" },
  providers: [
    Credentials({
      credentials: {
        name: { label: "Name", type: "text" },
        pin: { label: "PIN", type: "password" },
      },
      async authorize(credentials) {
        // No required role here any more. Until now the only internal surface
        // was /admin, so gating every Credentials login on `admin` was the
        // same thing as gating /admin. The Ops Hub adds four more roles
        // (ops, warehouse, rep, docs_only) that all sign in with the same
        // name + PIN, so the role check moves to where the role actually
        // means something -- proxy.ts for route access, requireOpsUser for
        // server actions. Letting a warehouse user hold a session is not a
        // privilege; reaching a ledger write with it is, and that is checked
        // at the write.
        const result = await verifyRepPin(
          String(credentials?.name ?? ""),
          String(credentials?.pin ?? ""),
        );
        if (!result.ok || !result.rep) return null;
        return { id: result.rep.id, name: result.rep.name, role: result.rep.role };
      },
    }),
    Resend({
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.RESEND_FROM_EMAIL,
    }),
  ],
  callbacks: {
    // Only the "resend" (customer magic-link) provider ever needs this --
    // `account`/`user` are only present on the initial sign-in call, not on
    // later token refreshes, so whatever gets stashed here persists on the
    // token for the rest of its life without re-querying every request.
    // Deliberately looks up by exact email match on Contact, not fuzzy --
    // unlike the Sales-sheet legacy-naming problem customerMatches solves,
    // portal contacts are entered directly against this schema, not
    // imported from inconsistent historical rows.
    async jwt({ token, user, account }) {
      // The internal (Credentials) login stashes the role and the Rep id on
      // the token at sign-in. Read once here rather than on every request:
      // a role change takes effect on next sign-in, which is the same
      // trade-off the customer-portal fields below already make.
      if (account?.provider === "credentials" && user) {
        const u = user as { id?: string; role?: string };
        if (u.id) token.repId = u.id;
        if (u.role) token.role = u.role;
      }
      if (account?.provider === "resend" && user?.email) {
        const contact = await db.contact.findFirst({
          where: { email: user.email },
          include: { account: true },
        });
        if (contact) {
          token.contactId = contact.id;
          token.accountId = contact.accountId;
          token.businessName = contact.account.businessName;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token.repId) session.repId = token.repId as string;
      if (token.role) session.role = token.role as UserRole;
      if (token.contactId) {
        session.contactId = token.contactId as string;
        session.accountId = token.accountId as string;
        session.businessName = token.businessName as string;
      }
      return session;
    },
  },
});
