import { auth } from "@/auth";

// Next.js 16 renamed middleware.ts -> proxy.ts (same signature, same
// execution model — just the file/function name changed). NextAuth's
// `auth()` wrapper still works as a default export here since Proxy's
// function contract is unchanged from Middleware's.
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const isLoginPage = pathname === "/admin/login";
  if (pathname.startsWith("/admin") && !isLoginPage && !req.auth) {
    return Response.redirect(new URL("/admin/login", req.nextUrl));
  }
});

export const config = {
  matcher: ["/admin/:path*"],
};
