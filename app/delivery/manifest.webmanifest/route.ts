import { NextResponse } from "next/server";

/**
 * The driver app's web manifest.
 *
 * A route handler rather than Next's `app/manifest.ts` file convention,
 * because that convention only ever emits `/manifest.webmanifest` at the root
 * and this app is scoped to `/delivery`. The rep app already owns the root of
 * orders.tlmbg.co; two apps on one deployment need two manifests, each scoped
 * to its own subtree, or installing one would claim the other's URLs.
 *
 * `scope` and `start_url` are deliberately `/delivery` and not `/`. On
 * delivery.tlmbg.co the proxy rewrites the bare host to /delivery, but every
 * in-app link is an absolute /delivery/... path that passes through untouched,
 * so /delivery IS the app's real URL space on both hostnames.
 */
export function GET(): Response {
  return NextResponse.json(
    {
      name: "Leopard Mark — Delivery",
      short_name: "LM Delivery",
      description: "Today's delivery route, proof of delivery, and bills of lading.",
      start_url: "/delivery",
      scope: "/delivery",
      display: "standalone",
      orientation: "portrait",
      background_color: "#050b18",
      theme_color: "#050b18",
      icons: [
        { src: "/rep-app/assets/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/rep-app/assets/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/rep-app/assets/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    {
      headers: {
        "content-type": "application/manifest+json",
        "cache-control": "public, max-age=3600",
      },
    },
  );
}
