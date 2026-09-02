import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "The Leopard Mark Brewing Co.",
  description: "Ordering for The Leopard Mark Brewing Co.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        {/* Defensive cleanup: /rep-app's service worker should only ever be
            scoped to /rep-app/. A trailing-slash routing bug (now fixed,
            see public/rep-app/index.html's <base> tag) could have let a
            rep's browser register it at scope "/" instead, which would
            silently intercept every fetch on this origin -- admin, the
            future customer portal, everything. Root-scoped is never
            legitimate for this app, so unregister on sight rather than
            trying to detect whether it actually happened anywhere. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if ('serviceWorker' in navigator) { navigator.serviceWorker.getRegistrations().then(function (regs) { regs.forEach(function (reg) { if (new URL(reg.scope).pathname === '/') reg.unregister(); }); }); }`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
