import Link from "next/link";
import { requireDeliveryUser } from "@/lib/ops/session";
import {
  dispatchedRoutesForDay,
  routeManifest,
  routesForDriver,
  routeTotals,
  todayYmd,
  ymdOfRoute,
} from "@/lib/routes";
import { startRouteAction } from "./actions";
import type { RouteWithStops } from "@/lib/routes";

export const dynamic = "force-dynamic";

/** "Mon, Sep 7" — a driver reads a weekday, not an ISO date. */
const SHORT_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  month: "short",
  day: "numeric",
});

/**
 * The driver's day.
 *
 * One question answered per screen, and this screen's question is "where do I
 * go next". Everything that is not a stop, its position, and whether it is
 * done has been left off on purpose.
 */
export default async function DeliveryHomePage() {
  const user = await requireDeliveryUser();
  const ymd = todayYmd();

  // Ops and admin see the day's routes so they can follow along, or complete a
  // stop for a driver phoning it in from the road. A driver sees only theirs.
  const routes =
    user.role === "driver" ? await routesForDriver(user.id, ymd) : await dispatchedRoutesForDay(ymd);

  if (routes.length === 0) {
    return (
      <main>
        <div className="dv-empty">
          <b>Nothing to run yet.</b>
          {user.role === "driver"
            ? "When dispatch sends today's route it will appear here. Pull down to refresh."
            : "No routes have been dispatched for today."}
        </div>
      </main>
    );
  }

  return (
    <main>
      {routes.map((route) => (
        <RouteBlock key={route.id} route={route} showDriver={user.role !== "driver"} />
      ))}
    </main>
  );
}

function RouteBlock({ route, showDriver }: { route: RouteWithStops; showDriver: boolean }) {
  const totals = routeTotals(route);
  const done = route.stops.filter((s) => s.status !== "pending").length;
  const delivered = route.stops.filter((s) => s.status === "delivered").length;
  const next = route.stops.find((s) => s.status === "pending");
  const isToday = ymdOfRoute(route.date) === todayYmd();
  // Dispatched but not yet started means the truck is not loaded: ops has
  // released the route and he has not told us he has the stock.
  const loading = route.status === "dispatched" && next != null;
  const manifest = loading ? routeManifest(route) : [];

  return (
    <section className="dv-route">
      <div className="dv-route-head">
        <h2>{route.name ? `${route.region} · ${route.name}` : `${route.region} route`}</h2>
        <div className="meta">
          {totals.stops} stop{totals.stops === 1 ? "" : "s"} · {totals.units} units
          {totals.kegs ? ` · ${totals.kegs} kegs` : ""} · load at {route.warehouse.name}
          {showDriver ? ` · ${route.driver?.name ?? "unassigned"}` : ""}
          {isToday ? "" : ` · started ${SHORT_DAY.format(new Date(`${ymdOfRoute(route.date)}T12:00:00Z`))}`}
        </div>

        <div className="dv-prog">
          <div className="bar">
            <i style={{ width: `${route.stops.length ? (done / route.stops.length) * 100 : 0}%` }} />
          </div>
          <span className="n">
            {delivered}/{route.stops.length}
          </span>
        </div>

        {route.notes ? <div className="note">{route.notes}</div> : null}

        {/* Before he is loaded the next thing to do is the warehouse, not the
            first bar. Once he is rolling this becomes the next stop. A route
            whose stops are all settled offers neither. */}
        {next ? (
          loading ? null : (
            <Link className="dv-btn go" href={`/delivery/stops/${next.id}`} style={{ marginTop: 14 }}>
              Next stop → {next.order?.account.businessName ?? next.stopName}
            </Link>
          )
        ) : (
          <div className="dv-pill good" style={{ marginTop: 14 }}>
            Route complete
          </div>
        )}
      </div>

      <div className="dv-stops">
        {/* Stop zero. He starts at the warehouse every day, so the warehouse is
            a stop -- with the whole load on it, summed across the route, rather
            than a per-bar breakdown nobody picks against. */}
        <div className={`dv-stop pickup${loading ? " now" : " done"}`}>
          <span className="seq">{loading ? "0" : "✓"}</span>
          <span>
            <span className="name">Load at {route.warehouse.name}</span>
            <span className="sub">
              {loading
                ? `${totals.units} unit${totals.units === 1 ? "" : "s"} for ${totals.stops} stop${totals.stops === 1 ? "" : "s"}`
                : "Picked up"}
            </span>
          </span>
          <span />
        </div>

        {loading ? (
          <div className="dv-card" style={{ marginBottom: 0 }}>
            <h3>On the truck</h3>
            {manifest.map((m) => (
              <div className="dv-line" key={m.productId}>
                <div>
                  <div className="what">{m.productName}</div>
                  <div className="fmt">
                    {m.formatLabel} · <span className="mono">{m.skuCode}</span>
                  </div>
                </div>
                <div className="mono" style={{ textAlign: "center", fontSize: 22, fontWeight: 600 }}>
                  {m.qty}
                </div>
              </div>
            ))}
            <form action={startRouteAction} style={{ marginTop: 16 }}>
              <input type="hidden" name="routeId" value={route.id} />
              <button className="dv-btn go" type="submit">
                Picked up
              </button>
            </form>
          </div>
        ) : null}

        {route.stops.map((stop) => {
          const units = stop.order?.lines.reduce((n, l) => n + l.qty, 0) ?? 0;
          return (
            <Link
              className={`dv-stop${stop.status === "delivered" ? " done" : stop.status === "failed" ? " failed" : ""}`}
              href={`/delivery/stops/${stop.id}`}
              key={stop.id}
            >
              <span className="seq">{stop.status === "delivered" ? "✓" : stop.sequence}</span>
              <span>
                <span className="name">{stop.order?.account.businessName ?? stop.stopName}</span>
                <span className="sub">
                  {stop.order ? `${units} unit${units === 1 ? "" : "s"}` : stop.stopAddress}
                  {stop.order?.account.deliveryWindow ? ` · ${stop.order?.account.deliveryWindow}` : ""}
                  {stop.status === "failed" ? ` · ${stop.failureReason ?? "not delivered"}` : ""}
                </span>
              </span>
              <span className="chev" aria-hidden="true">
                ›
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
