import { NextResponse } from "next/server";
import { auth } from "@/auth";
import type { UserRole } from "@/app/generated/prisma/enums";

// Next.js 16 renamed middleware.ts -> proxy.ts (same signature, same
// execution model — just the file/function name changed). NextAuth's
// `auth()` wrapper still works as a default export here since Proxy's
// function contract is unchanged from Middleware's.
//
// This file does two jobs:
//   1. Host routing (§2 rule 1) — five hostnames, one Next.js app.
//   2. Role gating for the internal surfaces.

/**
 * Hostname -> path prefix. One deployment serves all five domains; the old
 * Vercel projects stay deployed and only their DNS moves, last, after
 * acceptance (§2 rule 1), so a rewrite that goes wrong is a DNS revert rather
 * than a redeploy.
 *
 * `orders.tlmbg.co` is deliberately absent: it keeps serving the rep-app PWA
 * from /rep-app exactly as it does today, via next.config.ts's redirect, until
 * the Phase R cutover. Never break the rep app (§13).
 */
const HOST_REWRITES: ReadonlyArray<[hostname: string, prefix: string]> = [
  ["ops.tlmbg.co", "/ops"],
  ["inventory.tlmbg.co", "/ops/inventory"],
  ["bol.tlmbg.co", "/docs"],
  ["ach.tlmbg.co", "/ops/billing/setup-links"],
];

/** Paths that must never be host-rewritten, whatever the hostname. */
const PASSTHROUGH = ["/api", "/_next", "/rep-app", "/admin", "/customer", "/docs", "/ops", "/favicon"];

const HUB_ROLES: readonly UserRole[] = ["admin", "ops", "warehouse"];

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const host = req.headers.get("host")?.split(":")[0]?.toLowerCase() ?? "";
  const role = req.auth?.role as UserRole | undefined;

  // ---- 1. Host routing ----------------------------------------------------
  const rewrite = HOST_REWRITES.find(([h]) => h === host);
  if (rewrite && !PASSTHROUGH.some((p) => pathname.startsWith(p))) {
    const url = req.nextUrl.clone();
    // The bare host lands on the surface's root; deeper paths are appended, so
    // ops.tlmbg.co/orders/123 reaches /ops/orders/123 and links inside the app
    // keep working whichever hostname the operator arrived on.
    url.pathname = pathname === "/" ? rewrite[1] : `${rewrite[1]}${pathname}`;
    // A rewrite, not a redirect: the operator stays on ops.tlmbg.co instead of
    // watching the address bar jump to ops.tlmbg.co/ops. It also means the old
    // bookmarks keep the hostname they were saved with, which is what makes the
    // DNS cutover reversible without breaking anyone's saved links.
    return NextResponse.rewrite(url);
  }

  // ---- 2. Role gating -----------------------------------------------------
  // /admin used to be gated on "has any session at all", which was equivalent
  // to admin-only because the Credentials provider refused everyone else. It
  // no longer does (five roles share one PIN login), so the role is checked
  // here explicitly. Without this line, widening the login would have widened
  // /admin with it.
  const isAdminLoginPage = pathname === "/admin/login";
  if (pathname.startsWith("/admin") && !isAdminLoginPage) {
    if (!req.auth) return Response.redirect(new URL("/admin/login", req.nextUrl));
    if (role !== "admin") {
      // Send them where they can actually go, in one hop. Bouncing everyone to
      // /ops and letting the next rule bounce docs_only onward to /docs worked,
      // but a user watching two redirects go by reasonably concludes something
      // is broken.
      return Response.redirect(new URL(landingFor(role), req.nextUrl));
    }
  }

  // The Ops Hub: admin, ops and warehouse. A `docs_only` user (the "Daniel"
  // case in §2 rule 6) exists precisely so someone can print paperwork with a
  // PIN and reach nothing else, so they are sent to /docs rather than bounced
  // to a login they have already passed.
  if (pathname.startsWith("/ops")) {
    if (!req.auth) return Response.redirect(new URL("/admin/login?next=ops", req.nextUrl));
    if (!role || !HUB_ROLES.includes(role)) {
      return Response.redirect(new URL(landingFor(role), req.nextUrl));
    }
  }

  // /docs needs a session but no particular role -- that is the whole point of
  // docs_only. Server-side, lib/ops/session.ts still refuses it any ledger
  // write, which is the check that actually matters.
  if (pathname.startsWith("/docs") && !req.auth) {
    return Response.redirect(new URL("/admin/login?next=docs", req.nextUrl));
  }

  // Same pattern as /admin above -- /customer/login and /customer/signup
  // are the two public pages (a prospective customer has no session at all
  // yet), everything else under /customer needs one. A session alone isn't
  // enough, though: an admin/rep logged in via Credentials has no
  // contactId (that's only ever set by auth.ts's jwt callback for the
  // "resend" provider), so a rep's own session must not be treated as a
  // valid customer login here.
  const isPublicCustomerPage = pathname === "/customer/login" || pathname === "/customer/signup";
  if (pathname.startsWith("/customer") && !isPublicCustomerPage && !req.auth?.contactId) {
    return Response.redirect(new URL("/customer/login", req.nextUrl));
  }
});

/**
 * The surface a role belongs on. `docs_only` and `rep` get the paperwork maker;
 * everyone who can open the hub gets the hub.
 */
function landingFor(role: UserRole | undefined): string {
  if (role && HUB_ROLES.includes(role)) return "/ops";
  return "/docs";
}

export const config = {
  // Broadened from /admin + /customer: the proxy now also does host routing,
  // so it has to see the root path and the new surfaces. Static assets and
  // /rep-app are excluded so the live PWA's request path is untouched.
  matcher: [
    "/",
    "/admin/:path*",
    "/customer/:path*",
    "/ops/:path*",
    "/docs/:path*",
  ],
};
