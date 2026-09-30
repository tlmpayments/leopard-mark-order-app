import { notFound } from "next/navigation";
import { timingSafeEqual } from "node:crypto";
import { getPortalData } from "@/lib/customerPortal";
import { PortalView } from "../PortalView";

export const dynamic = "force-dynamic";

// Preview-only viewer for the customer portal, so it can be reviewed without
// a customer login. It shows REAL customer data, so it 404s everywhere except a
// Vercel Preview deployment, and even there needs PORTAL_PREVIEW_TOKEN to be
// set and passed in the URL. Production (VERCEL_ENV=production) never serves
// it. Read-only: it calls the same getPortalData the real portal uses.
function tokenMatches(given: string | undefined): boolean {
  const expected = process.env.PORTAL_PREVIEW_TOKEN;
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function PortalPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; account?: string }>;
}) {
  if (process.env.VERCEL_ENV !== "preview") notFound();
  const { token, account } = await searchParams;
  if (!tokenMatches(token)) notFound();

  if (!account) {
    return (
      <main className="app-shell">
        <p className="admin-note">Add &amp;account=&lt;account id&gt; to the URL.</p>
      </main>
    );
  }

  const data = await getPortalData(account);
  if (!data) notFound();

  return (
    <>
      <p className="admin-note" style={{ textAlign: "center", margin: "8px 0" }}>
        PREVIEW — viewing {data.account.businessName} as a customer would. Not visible in production.
      </p>
      <PortalView data={data} />
    </>
  );
}
