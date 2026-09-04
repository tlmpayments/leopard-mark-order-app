import { db } from "@/lib/db";
import { currentOpsUser } from "@/lib/ops/session";
import { initials, money } from "@/lib/ops/format";

export const dynamic = "force-dynamic";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Settings (§8.10). Read-only in this pass, and honest about it.
 *
 * Everything shown here is real data the system already reads. What it does not
 * yet offer is editing — and rather than render inert inputs that look editable,
 * each panel says where the value comes from, so nobody clicks a save button
 * that does nothing.
 */
export default async function SettingsPage() {
  const user = await currentOpsUser();

  const [users, routes, channels, products, locations, ruleCount] = await Promise.all([
    db.rep.findMany({
      where: { active: true },
      include: { locations: { select: { locationId: true } } },
      orderBy: { name: "asc" },
    }),
    db.routeSchedule.findMany({ include: { warehouse: { select: { name: true } } }, orderBy: { weekday: "asc" } }),
    db.regionSlackChannel.findMany(),
    db.product.findMany({ orderBy: { skuCode: "asc" } }),
    db.location.findMany({ orderBy: [{ type: "asc" }, { id: "asc" }] }),
    db.automationRule.count(),
  ]);

  const byRegion = new Map<string, typeof routes>();
  for (const r of routes) byRegion.set(r.region, [...(byRegion.get(r.region) ?? []), r]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Settings</div>
          <h1>Settings</h1>
          <p>
            Users and roles, per-user location scoping, SKUs, the route schedule and the Slack channel map. These are
            the values the automations read — nothing in the code hardcodes them.
          </p>
        </div>
      </div>

      <div className="grid g3" style={{ marginBottom: 16 }}>
        <section className="panel">
          <div className="panel-head">
            <h3>Users &amp; roles</h3>
            <span className="small muted">{users.length} active</span>
          </div>
          {users.map((u) => (
            <div
              key={u.id}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "center",
                padding: "7px 0",
                borderBottom: "1px solid var(--line)",
                fontSize: 13,
              }}
            >
              <span className="avatar" style={{ width: 24, height: 24, fontSize: 10 }}>
                {initials(u.name)}
              </span>
              <span style={{ flex: 1 }}>
                {u.name}
                {u.id === user?.id ? <span className="small muted"> · you</span> : null}
              </span>
              <span className="pill neutral">{u.role}</span>
              <span className="small muted">
                {u.role === "admin" || u.role === "ops"
                  ? "all locations"
                  : u.locations.length
                    ? u.locations.map((l) => l.locationId).join(" · ")
                    : "none assigned"}
              </span>
            </div>
          ))}
          <p className="small muted" style={{ margin: "10px 0 0" }}>
            A <span className="mono">warehouse</span> user with no locations assigned can act nowhere — the scope
            fails closed, so a half-finished setup never quietly grants everything.
          </p>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Route schedule</h3>
            <span className="small muted">{routes.length} route days</span>
          </div>
          {routes.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              None yet. Until a region has route days, the system cannot propose a delivery slot and every order waits
              for a human at stage ②. Seed with{" "}
              <span className="mono">npx tsx scripts/seed-ops-platform.ts</span>.
            </p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Region</th>
                  <th>Warehouse</th>
                  <th>Days</th>
                  <th>Cutoff</th>
                </tr>
              </thead>
              <tbody>
                {[...byRegion.entries()].map(([region, rs]) => (
                  <tr key={region}>
                    <td>
                      <span className="region">{region}</span>
                    </td>
                    <td className="small">{[...new Set(rs.map((r) => r.warehouseId))].join(" · ")}</td>
                    <td className="small">{rs.map((r) => DAY_NAMES[r.weekday]).join(" · ")}</td>
                    <td className="num">{String(rs[0].cutoffHour).padStart(2, "0")}:00 prior day</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Slack channels</h3>
            <span className="small muted">{channels.length} mapped</span>
          </div>
          {channels.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              None mapped. Order notifications fall back to the{" "}
              <span className="mono">SLACK_CHANNEL_BA</span> / <span className="mono">_LA</span> environment
              variables the Apps Script already uses.
            </p>
          ) : (
            channels.map((c) => (
              <div
                key={c.region}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "7px 0",
                  borderBottom: "1px solid var(--line)",
                  fontSize: 13,
                }}
              >
                <span>
                  <span className="region">{c.region}</span> {c.purpose}
                </span>
                <span className="mono small muted">{c.channelId}</span>
              </div>
            ))
          )}
          <p className="small muted" style={{ margin: "10px 0 0" }}>
            {ruleCount} automation rules seeded.
          </p>
        </section>
      </div>

      <section className="panel flush" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>Products &amp; SKUs</h3>
          <span className="small muted">deposit, threshold, weight and price drive the invoice and the BOL</span>
        </div>
        {products.length === 0 ? (
          <div className="empty">
            <b>No products.</b>
            Run the foundation import.
          </div>
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Product</th>
                  <th>Format</th>
                  <th>Keg</th>
                  <th className="r">Deposit</th>
                  <th className="r">Threshold</th>
                  <th className="r">Weight / unit</th>
                  <th className="r">List price</th>
                  <th>Active</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.id}>
                    <td className="mono small">{p.skuCode}</td>
                    <td>{p.productName}</td>
                    <td className="small">{p.formatLabel}</td>
                    <td>{p.isKeg ? <span className="pill neutral">keg</span> : "—"}</td>
                    <td className="r num">{p.depositAmount ? money(p.depositAmount) : "—"}</td>
                    <td className="r num">{p.reorderThreshold ?? "—"}</td>
                    <td className="r num">{p.weightPerUnit ? `${Number(p.weightPerUnit)} lb` : "—"}</td>
                    <td className="r num">{money(p.listPrice)}</td>
                    <td>{p.active ? <span className="pill good">active</span> : <span className="pill neutral">off</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel flush">
        <div className="panel-head">
          <h3>Facilities</h3>
          <span className="small muted">{locations.length} locations · warehouses are the only ones that can deliver</span>
        </div>
        {locations.length === 0 ? (
          <div className="empty">
            <b>No locations.</b>
            Seed them from the Inventory app&rsquo;s Locations.csv.
          </div>
        ) : (
          <div className="tblwrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Type</th>
                  <th>City</th>
                  <th>Shipping hours</th>
                  <th>Dock</th>
                </tr>
              </thead>
              <tbody>
                {locations.map((l) => (
                  <tr key={l.id}>
                    <td className="mono small">{l.id}</td>
                    <td>{l.name}</td>
                    <td>
                      <span className={`pill ${l.type === "warehouse" ? "good" : "neutral"}`}>{l.type}</span>
                    </td>
                    <td className="small">
                      {l.city}, {l.state}
                    </td>
                    <td className="small muted">{l.shippingHours ?? "—"}</td>
                    <td className="small">{l.hasLoadingDock ? "yes" : l.liftgateRequired ? "liftgate" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
