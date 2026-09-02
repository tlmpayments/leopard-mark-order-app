import Link from "next/link";
import "./ops.css";
import { db } from "@/lib/db";
import { requireOpsUser } from "@/lib/ops/session";
import { isPublicAccess } from "@/lib/ops/publicAccess";
import { healthChips } from "@/lib/ops/queries";
import { initials } from "@/lib/ops/format";
import { NavIcon } from "./_components/icons";
import { GlobalSearch } from "./_components/GlobalSearch";
import { Shortcuts } from "./_components/Shortcuts";

export const metadata = { title: "Leopard Mark — Ops" };

/**
 * The hub shell: 232px rail, top bar with global search and environment health
 * chips, 1440px content column (§8).
 *
 * The counts in the rail are live. A nav badge that lies is worse than no
 * badge, and these are the numbers that decide where an operator clicks first.
 */
export default async function OpsLayout({ children }: LayoutProps<"/ops">) {
  const user = await requireOpsUser();
  const publicAccess = isPublicAccess();

  const [openOrders, needsSetup, deadJobs, failedInvoices, chips] = await Promise.all([
    db.order.count({
      where: { status: { notIn: ["cancelled", "rejected", "expired"] }, invoice: { is: null } },
    }),
    db.account.count({ where: { firstOrderAt: null, approvalStatus: { not: "rejected" } } }),
    db.jobRun.count({ where: { status: "dead" } }),
    db.invoice.count({ where: { status: "local_error" } }),
    healthChips(),
  ]);

  const nav: Array<{ href: string; key: string; label: string; count?: number; hot?: boolean }> = [
    { href: "/ops", key: "home", label: "Command Center" },
    { href: "/ops/orders", key: "orders", label: "Orders", count: openOrders },
    { href: "/ops/accounts", key: "accounts", label: "Accounts", count: needsSetup },
    { href: "/ops/deliveries", key: "deliveries", label: "Deliveries" },
    { href: "/ops/inventory", key: "inventory", label: "Inventory" },
    { href: "/ops/documents", key: "documents", label: "Documents" },
    { href: "/ops/billing", key: "billing", label: "Billing", count: failedInvoices, hot: failedInvoices > 0 },
    { href: "/ops/automations", key: "automations", label: "Automations", count: deadJobs, hot: deadJobs > 0 },
    { href: "/ops/settings", key: "settings", label: "Settings" },
  ];

  return (
    <div className="ops">
      <Shortcuts />
      <div className="shell">
        <aside className="rail">
          <div className="brand">
            <div className="crest" aria-hidden="true">
              LM
            </div>
            <div className="wm">
              Leopard Mark
              <small>Ops</small>
            </div>
          </div>
          <nav className="nav" aria-label="Sections">
            {nav.map((item) => (
              <Link key={item.href} href={item.href}>
                <NavIcon name={item.key} />
                {item.label}
                {item.count ? <span className={`cnt${item.hot ? " hot" : ""}`}>{item.count}</span> : null}
              </Link>
            ))}
          </nav>
          <div className="foot">
            Signed in as <b>{user.name}</b> · {user.role}
            <br />
            <span className="mono small">ops.tlmbg.co</span>
          </div>
        </aside>

        <div className="main">
          <div className="topbar">
            <GlobalSearch />
            <div className="health">
              {chips.map((c) => (
                <span
                  key={c.label}
                  className={`chip${c.tone === "warn" ? " warn" : c.tone === "bad" ? " bad" : ""}`}
                  title={`${c.label}: ${c.detail}`}
                >
                  <span className="dot" />
                  {c.label} <span className="t">{c.detail}</span>
                </span>
              ))}
            </div>
            <div className="avatar" title={`${user.name} · ${user.role}`}>
              {initials(user.name)}
            </div>
          </div>
          {publicAccess ? (
            <div className="openbar" role="status">
              <b>No login required.</b>
              <span>
                This hub is currently reachable by anyone with the link, and every visitor acts as an admin —
                including Mark delivered, Issue invoice and the automation toggles. Unset{" "}
                <span className="mono">OPS_PUBLIC_ACCESS</span> to restore sign-in.
              </span>
            </div>
          ) : null}
          <main className="page">{children}</main>
        </div>
      </div>
    </div>
  );
}
