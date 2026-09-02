import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js's /public static serving has no directory-index fallback (unlike
  // a traditional static host), so /rep-app and /rep-app/ need an explicit
  // rewrite to the file the rep PWA's manifest/sw.js expect to be served
  // from — everything inside public/rep-app/ uses paths relative to that
  // index.html (see the app-root redirect in app/page.tsx for why this
  // location matters for already-installed rep PWA icons).
  async rewrites() {
    return [
      { source: "/rep-app", destination: "/rep-app/index.html" },
      { source: "/rep-app/", destination: "/rep-app/index.html" },
    ];
  },
};

export default nextConfig;
