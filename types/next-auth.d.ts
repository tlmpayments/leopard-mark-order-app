import type { DefaultSession } from "next-auth";
import type { UserRole } from "@/app/generated/prisma/enums";

// Extends the session/JWT shape with the customer-portal fields auth.ts's
// jwt/session callbacks add for the "resend" (magic-link) provider only --
// undefined for the admin/rep Credentials login, which never sets them.
declare module "next-auth" {
  interface Session extends DefaultSession {
    /** Set by the internal name + PIN login only. */
    repId?: string;
    role?: UserRole;
    /**
     * "delivery" for a session minted by the PIN-only delivery sign-in. It is
     * deliberately narrower than the role it carries: proxy.ts keeps such a
     * session out of the Ops Hub, /admin, /docs and the customer portal.
     */
    scope?: "delivery";
    contactId?: string;
    accountId?: string;
    businessName?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    repId?: string;
    role?: UserRole;
    scope?: "delivery";
    contactId?: string;
    accountId?: string;
    businessName?: string;
  }
}
