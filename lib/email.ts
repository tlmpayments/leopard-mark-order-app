// Minimal Resend REST call for transactional emails outside the NextAuth
// magic-link flow (which already sends its own mail internally via
// next-auth/providers/resend -- see auth.ts). Not using the `resend` SDK
// package here since this is the only non-auth email the app sends today;
// a bare fetch avoids a dependency for one call, matching the project's
// existing preference for direct API calls over SDKs (e.g. Code.gs's
// notifySlackUrl uses UrlFetchApp directly, not a Slack SDK).
export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    console.warn(
      `sendEmail: RESEND_API_KEY/RESEND_FROM_EMAIL not configured, skipping send to ${to}: "${subject}"`,
    );
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend send failed (${res.status}): ${body}`);
  }
}

// No existing base-URL env var convention in this project (checked:
// auth.ts relies on Auth.js's own request-based URL detection, nothing
// else builds absolute links). APP_BASE_URL is the one to set in Vercel;
// VERCEL_URL (host only, no protocol, set automatically on every Vercel
// deployment) is the deploy-preview fallback so preview URLs still work
// without extra config; the production domain from the master plan doc is
// the last resort.
export function appBaseUrl(): string {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "https://orders.tlmbg.co";
}
