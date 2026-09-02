import "../ops/ops.css";
import { requireOpsUser, DOCS_ROLES } from "@/lib/ops/session";
import { initials } from "@/lib/ops/format";

export const metadata = { title: "Leopard Mark — BOL Maker" };

/**
 * bol.tlmbg.co (§8.7).
 *
 * A deliberately minimal shell: no rail, no health chips, no navigation into
 * the hub. This is the surface a `docs_only` user reaches, and the point of
 * that role is that printing paperwork should not require access to orders,
 * stock or billing. Anything more here would be a privilege nobody asked for.
 */
export default async function DocsLayout({ children }: LayoutProps<"/docs">) {
  const user = await requireOpsUser(DOCS_ROLES);
  const canSeeHub = user.role !== "docs_only" && user.role !== "rep";

  return (
    <div className="ops">
      <div className="main" style={{ maxWidth: 1080, margin: "0 auto" }}>
        <div className="topbar">
          <div className="brand" style={{ border: 0, margin: 0, padding: 0 }}>
            <div className="crest" aria-hidden="true">
              LM
            </div>
            <div className="wm">
              Bill of Lading Maker
              <small>bol.tlmbg.co</small>
            </div>
          </div>
          <div className="health" style={{ alignItems: "center" }}>
            {canSeeHub ? (
              <a className="btn sm ghost" href="/ops/documents">
                Ops hub ↗
              </a>
            ) : null}
            <span className="chip">
              <span className="dot" />
              {user.name} <span className="t">{user.role}</span>
            </span>
          </div>
          <div className="avatar" title={user.name}>
            {initials(user.name)}
          </div>
        </div>
        <main className="page">{children}</main>
      </div>
    </div>
  );
}
