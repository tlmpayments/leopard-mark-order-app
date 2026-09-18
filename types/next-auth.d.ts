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
    contactId?: string;
    accountId?: string;
    businessName?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    repId?: string;
    role?: UserRole;
    contactId?: string;
    accountId?: string;
    businessName?: string;
  }
}
