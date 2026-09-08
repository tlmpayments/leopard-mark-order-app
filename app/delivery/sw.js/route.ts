/**
 * The driver app's service worker.
 *
 * Deliberately network-only for anything with content in it. A cached route
 * list is a wrong route list: stale stops, stale addresses, a stop that was
 * moved to another truck an hour ago. For a delivery app that is worse than an
 * error, because it looks right.
 *
 * So this exists for exactly two reasons:
 *   1. Android will not offer to install an app that has no fetch handler.
 *   2. Opening the app with no signal should say so, rather than showing the
 *      browser's dinosaur.
 *
 * Real offline delivery — queueing a completed stop and its photos until signal
 * returns — is a genuinely different and much larger piece of work. This is not
 * that, and does not pretend to be.
 */
const SW = `
const OFFLINE = \`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>No signal</title><style>
body{margin:0;min-height:100dvh;display:grid;place-items:center;text-align:center;
padding:32px;background:#050b18;color:#f2f6fc;
font-family:system-ui,-apple-system,sans-serif}
h1{font-size:22px;margin:0 0 8px}p{color:#8ba2c0;font-size:16px;line-height:1.5;margin:0}
</style></head><body><div>
<h1>No signal</h1>
<p>Your route is still there. Move somewhere with reception and pull down to reload.</p>
</div></body></html>\`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Only page loads get the offline card. A failed image or API call should
  // surface as itself, so the page's own error handling still runs.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(
        () => new Response(OFFLINE, { headers: { "content-type": "text/html; charset=utf-8" } }),
      ),
    );
  }
});
`;

export function GET(): Response {
  return new Response(SW, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      // Never cache the worker itself; a stale SW is the one thing that is
      // genuinely hard to recover from on someone else's phone.
      "cache-control": "no-store",
      "service-worker-allowed": "/delivery",
    },
  });
}
