import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // orders.tlmbg.co (root) is the reps' link, permanently — reps already
  // know and have bookmarked/installed it, so the customer portal lives at
  // /customer instead of root rather than the other way around. This also
  // retires the old lm_rep-localStorage-detection redirect app/page.tsx used
  // to need: since every visit to "/" now goes to the rep app unconditionally,
  // there's no longer a "which app does this visitor want" decision to make.
  async redirects() {
    return [{ source: "/", destination: "/rep-app", permanent: true }];
  },
  // Next.js's /public static serving has no directory-index fallback (unlike
  // a traditional static host), so /rep-app and /rep-app/ need an explicit
  // rewrite to the file the rep PWA's manifest/sw.js expect to be served
  // from — everything inside public/rep-app/ uses paths relative to that
  // index.html.
  async rewrites() {
    return [
      { source: "/rep-app", destination: "/rep-app/index.html" },
      { source: "/rep-app/", destination: "/rep-app/index.html" },
    ];
  },
};

export default nextConfig;
