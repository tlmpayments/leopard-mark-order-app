import Link from "next/link";
import { requireDeliveryUser } from "@/lib/ops/session";
import { dispatchedRoutesForDay, routesForDriver, routeTotals, todayYmd, ymdOfRoute } from "@/lib/routes";
import { startRouteAction } from "./actions";
import type { RouteWithStops } from "@/lib/routes";

export const dynamic = "force-dynamic";

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

  return (
    <section className="dv-route">
      <div className="dv-route-head">
        <h2>{route.name ? `${route.region} · ${route.name}` : `${route.region} route`}</h2>
        <div className="meta">
          {totals.stops} stop{totals.stops === 1 ? "" : "s"} · {totals.units} units
          {totals.kegs ? ` · ${totals.kegs} kegs` : ""} · load at {route.warehouse.name}
          {showDriver ? ` · ${route.driver?.name ?? "unassigned"}` : ""}
          {isToday ? "" : ` · started ${ymdOfRoute(route.date)}`}
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

        {/* Only while there is something left to start. A route whose stops are
            all settled but whose status never advanced (ops completed them from
            the hub, say) must not offer to begin. */}
        {route.status === "dispatched" && next ? (
          <form action={startRouteAction} style={{ marginTop: 14 }}>
            <input type="hidden" name="routeId" value={route.id} />
            <button className="dv-btn primary" type="submit">
              Start route
            </button>
          </form>
        ) : null}

        {next ? (
          <Link className="dv-btn go" href={`/delivery/stops/${next.id}`} style={{ marginTop: 12 }}>
            Next stop → {next.order.account.businessName}
          </Link>
        ) : (
          <div className="dv-pill good" style={{ marginTop: 14 }}>
            Route complete
          </div>
        )}
      </div>

      <div className="dv-stops">
        {route.stops.map((stop) => {
          const units = stop.order.lines.reduce((n, l) => n + l.qty, 0);
          return (
            <Link
              className={`dv-stop${stop.status === "delivered" ? " done" : stop.status === "failed" ? " failed" : ""}`}
              href={`/delivery/stops/${stop.id}`}
              key={stop.id}
            >
              <span className="seq">{stop.status === "delivered" ? "✓" : stop.sequence}</span>
              <span>
                <span className="name">{stop.order.account.businessName}</span>
                <span className="sub">
                  {units} unit{units === 1 ? "" : "s"}
                  {stop.order.account.deliveryWindow ? ` · ${stop.order.account.deliveryWindow}` : ""}
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
