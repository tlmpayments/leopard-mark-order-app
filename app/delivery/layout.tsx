import Link from "next/link";
import "./delivery.css";
import { currentDeliveryUser } from "@/lib/ops/session";
import { todayYmd } from "@/lib/routes";
import { RegisterSW } from "./_components/RegisterSW";

export const metadata = {
  title: "Leopard Mark — Delivery",
  applicationName: "LM Delivery",
  manifest: "/delivery/manifest.webmanifest",
  icons: {
    // 180px, which is what iOS wants; without it the home-screen icon is a
    // screenshot of the page.
    apple: "/rep-app/assets/icons/apple-touch-icon.png",
    icon: "/rep-app/assets/icons/icon-192.png",
  },
  appleWebApp: {
    capable: true,
    title: "LM Delivery",
    // The ground is light now, so the clock and battery need to be dark.
    statusBarStyle: "default" as const,
  },
  // Both spellings on purpose. `mobile-web-app-capable` is the standard one
  // that Android and iOS 16.4+ read; `apple-mobile-web-app-capable` is the
  // older Apple-only name, and it is what decides whether an iPhone launches
  // this full-screen or with the Safari bars still showing. Next's
  // appleWebApp.capable does not currently emit the latter, and we do not know
  // which iOS the driver's phone is on, so state it directly.
  // Only the Apple-prefixed one here: Next already emits the standard
  // `mobile-web-app-capable` from appleWebApp.capable above, and listing it
  // again just renders the tag twice.
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#d7d8d4",
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
  const user = await currentDeliveryUser();

  return (
    <div className="dv">
      <RegisterSW />
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
