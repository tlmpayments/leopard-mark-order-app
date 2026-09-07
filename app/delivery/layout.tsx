import Link from "next/link";
import "./delivery.css";
import { currentOpsUser } from "@/lib/ops/session";
import { todayYmd } from "@/lib/routes";

export const metadata = {
  title: "Leopard Mark — Delivery",
  // A driver adds this to his home screen and opens it in the cab; the browser
  // chrome is wasted space there.
  other: { "mobile-web-app-capable": "yes" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#050b18",
  // The one screen where pinch-zoom genuinely helps: a delivery address read
  // at arm's length. Never disable it here.
  maximumScale: 5,
};

const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "long",
  month: "long",
  day: "numeric",
});

/**
 * The driver shell.
 *
 * Deliberately does NOT gate: /delivery/login is inside this layout, and a
 * layout that redirects the unauthenticated would bounce the login page to
 * itself forever. proxy.ts keeps strangers out of every other path, and each
 * page re-checks with requireDeliveryUser -- which is the check that counts.
 */
export default async function DeliveryLayout({ children }: LayoutProps<"/delivery">) {
  const user = await currentOpsUser();

  return (
    <div className="dv">
      <div className="dv-shell">
        {user ? (
          <header className="dv-top">
            <div className="id">
              {user.name.split(" ")[0]}
              <small>{DAY.format(new Date(`${todayYmd()}T12:00:00Z`))}</small>
            </div>
            <Link className="dv-btn quiet inline sm" href="/delivery">
              My route
            </Link>
          </header>
        ) : null}
        {children}
      </div>
    </div>
  );
}
