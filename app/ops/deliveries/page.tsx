import Link from "next/link";
import { db } from "@/lib/db";
import { shortDate } from "@/lib/ops/format";
import { candidateOrdersForDay, routesForDay, routeTotals, todayYmd } from "@/lib/routes";
import { pacificDayRange } from "@/lib/scheduling";
import { deliveryRegionFor } from "@/lib/deliveryRegion";
import { createRouteAction, dispatchRouteAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * The dispatch board — one day, every route, everything not on one yet.
 *
 * This is the screen the day actually runs on: orders land here from the rep
 * app, get dragged onto a truck, and leave with paperwork. The week grid still
 * exists at /ops/deliveries/week for the "what does Thursday look like"
 * question, but it is the wrong shape for the daily job, which is about one
 * day and the sequence within it.
 */
export default async function DispatchBoardPage({ searchParams }: PageProps<"/ops/deliveries">) {
  const params = await searchParams;
  const dayParam = Array.isArray(params.day) ? params.day[0] : params.day;
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(dayParam ?? "") ? dayParam! : todayYmd();

  const [routes, candidates, warehouses, drivers, schedules] = await Promise.all([
    routesForDay(ymd),
    candidateOrdersForDay(ymd),
    db.location.findMany({ where: { type: "warehouse", active: true }, orderBy: { id: "asc" } }),
    db.rep.findMany({ where: { role: "driver", active: true }, orderBy: { name: "asc" } }),
    db.routeSchedule.findMany({ where: { active: true } }),
  ]);

  const regions = [...new Set(schedules.map((r) => r.region))].sort();
  const { start } = pacificDayRange(ymd);
  const prev = shiftYmd(ymd, -1);
  const next = shiftYmd(ymd, 1);
  const isToday = ymd === todayYmd();

  // Orders already scheduled for this day are the ones that should be on a
  // truck; the unscheduled ones are shown separately so squeezing one in is a
  // deliberate act rather than an accident of sorting.
  const scheduledToday = candidates.filter((o) => o.scheduledFor != null);
  const unscheduled = candidates.filter((o) => o.scheduledFor == null);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Dispatch · {isToday ? "today" : shortDate(start)}</div>
          <h1>Dispatch board</h1>
          <p>
            Build the day&rsquo;s routes, sequence the stops, then dispatch — which mints every stop&rsquo;s BOL
            number and puts the route on the driver&rsquo;s phone at{" "}
            <span className="mono">delivery.tlmbg.co</span>.
          </p>
        </div>
        <div className="actions">
          <Link className="btn" href="/ops/deliveries/week">
            The week
          </Link>
          <a className="btn" href={`/api/documents/print?day=${ymd}`} target="_blank" rel="noopener">
            Print the day
          </a>
        </div>
      </div>

      <div className="daybar">
        <div className="seg">
          <Link href={`/ops/deliveries?day=${prev}`}>‹ {shortDate(pacificDayRange(prev).start)}</Link>
          <Link className="on" href={`/ops/deliveries?day=${ymd}`}>
            {shortDate(start)}
          </Link>
          <Link href={`/ops/deliveries?day=${next}`}>{shortDate(pacificDayRange(next).start)} ›</Link>
        </div>
        {!isToday ? (
          <Link className="btn sm" href="/ops/deliveries">
            Today
          </Link>
        ) : null}
        <span className="small muted">
          {routes.length} route{routes.length === 1 ? "" : "s"} · {scheduledToday.length} order
          {scheduledToday.length === 1 ? "" : "s"} scheduled · {unscheduled.length} unscheduled
        </span>
      </div>

      <div className="dispatch">
        <section className="panel">
          <div className="panel-head">
            <h3>Not on a route</h3>
            <span className="pill neutral">{scheduledToday.length + unscheduled.length}</span>
          </div>

          {scheduledToday.length === 0 && unscheduled.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              Every order for this day is on a truck.
            </p>
          ) : null}

          {scheduledToday.length ? (
            <>
              <div className="small muted" style={{ margin: "0 0 6px" }}>
                Scheduled for this day
              </div>
              <div className="pick" style={{ marginBottom: 14 }}>
                {scheduledToday.map((o) => (
                  <CandidateRow key={o.id} order={o} />
                ))}
              </div>
            </>
          ) : null}

          {unscheduled.length ? (
            <>
              <div className="small muted" style={{ margin: "0 0 6px" }}>
                Confirmed, no day booked
              </div>
              <div className="pick">
                {unscheduled.map((o) => (
                  <CandidateRow key={o.id} order={o} />
                ))}
              </div>
            </>
          ) : null}

          <p className="small muted" style={{ marginBottom: 0, marginTop: 14 }}>
            Add an order to a route from the route itself — the route knows its warehouse and day, and adding a stop
            books the order onto both.
          </p>
        </section>

        <div className="routes">
          {routes.length === 0 ? (
            <div className="state">
              <b>No routes built for this day.</b>
              <span>A route is one truck, one driver, one day. Build the first one below.</span>
            </div>
          ) : (
            routes.map((route) => {
              const totals = routeTotals(route);
              const done = route.stops.filter((s) => s.status !== "pending").length;
              return (
                <article className={`rt${route.status === "draft" ? "" : " dispatched"}`} key={route.id}>
                  <div className="rt-head">
                    <div>
                      <h3>
                        <Link href={`/ops/deliveries/routes/${route.id}`}>
                          {route.name ? `${route.region} · ${route.name}` : `${route.region} route`}
                        </Link>
                      </h3>
                      <div className="sub">
                        {route.driver?.name ?? "no driver assigned"} · out of {route.warehouse.name} ·{" "}
                        {totals.stops} stop{totals.stops === 1 ? "" : "s"} · {totals.units} units
                        {totals.kegs ? ` · ${totals.kegs} kegs` : ""}
                      </div>
                    </div>
                    <div className="actions">
                      <RouteStatusPill status={route.status} done={done} total={route.stops.length} />
                      {route.status === "draft" ? (
                        <form action={dispatchRouteAction}>
                          <input type="hidden" name="routeId" value={route.id} />
                          <button
                            className="btn primary sm"
                            type="submit"
                            disabled={!route.driverId || route.stops.length === 0}
                          >
                            Dispatch
                          </button>
                        </form>
                      ) : (
                        <a
                          className="btn sm"
                          href={`/api/documents/print?routeId=${route.id}`}
                          target="_blank"
                          rel="noopener"
                        >
                          Print BOLs
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="rt-body">
                    {route.stops.length === 0 ? (
                      <p className="small muted" style={{ margin: "4px 2px" }}>
                        No stops yet.{" "}
                        <Link href={`/ops/deliveries/routes/${route.id}`}>Add the first one →</Link>
                      </p>
                    ) : (
                      <div className="stops">
                        {route.stops.map((stop) => (
                          <div
                            className={`stop${stop.status === "delivered" ? " done" : stop.status === "failed" ? " failed" : ""}`}
                            key={stop.id}
                          >
                            <span className="seq">{stop.sequence}</span>
                            <div>
                              <div className="who">{stop.order.account.businessName}</div>
                              <div className="det">
                                {stop.order.account.deliveryAddress ?? stop.order.account.address ?? "no address"}
                              </div>
                            </div>
                            <span className="mono small muted">
                              {stop.order.shipment?.bolNumber ?? "—"}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              );
            })
          )}

          <section className="panel">
            <div className="panel-head">
              <h3>Build a route</h3>
              <span className="pill neutral">{shortDate(start)}</span>
            </div>
            {drivers.length === 0 ? (
              <div className="spec" style={{ marginBottom: 12 }}>
                <b>No drivers yet.</b> A driver is a rep row with the <span className="mono">driver</span> role and a
                PIN. Add one in Settings, and they sign in at{" "}
                <span className="mono">delivery.tlmbg.co</span> with the same name and PIN the reps use.
              </div>
            ) : null}
            <form action={createRouteAction} className="actions">
              <input type="hidden" name="day" value={ymd} />
              <label className="small muted">
                Region{" "}
                <select className="fld" name="region" defaultValue={regions[0] ?? ""} required>
                  {regions.length === 0 ? <option value="">no route schedule set up</option> : null}
                  {regions.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small muted">
                Warehouse{" "}
                <select className="fld" name="warehouseId" defaultValue={warehouses[0]?.id ?? ""} required>
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.id} — {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small muted">
                Driver{" "}
                <select className="fld" name="driverId" defaultValue="">
                  <option value="">assign later</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small muted">
                Name <input className="fld" name="name" placeholder="optional — “Truck 2”" style={{ width: 150 }} />
              </label>
              <button className="btn primary" type="submit">
                Create route
              </button>
            </form>
          </section>
        </div>
      </div>
    </>
  );
}

function CandidateRow({
  order,
}: {
  order: Awaited<ReturnType<typeof candidateOrdersForDay>>[number];
}) {
  const units = order.lines.reduce((n, l) => n + l.qty, 0);
  const region = deliveryRegionFor(order.account.region);
  return (
    <div className="row">
      <div style={{ minWidth: 0 }}>
        <b>
          <Link href={`/ops/orders/${order.id}`}>{order.account.businessName}</Link>
        </b>
        <div className="muted" style={{ marginTop: 2 }}>
          {units} unit{units === 1 ? "" : "s"} · {order.lines.length} line{order.lines.length === 1 ? "" : "s"}
        </div>
      </div>
      {region ? <span className="region">{region}</span> : <span className="pill warn">no region</span>}
    </div>
  );
}

function RouteStatusPill({ status, done, total }: { status: string; done: number; total: number }) {
  if (status === "draft") return <span className="pill neutral">draft</span>;
  if (status === "cancelled") return <span className="pill serious">cancelled</span>;
  if (status === "completed") return <span className="pill good">complete</span>;
  return (
    <span className="pill warn">
      {status === "in_progress" ? `${done}/${total} done` : "dispatched"}
    </span>
  );
}

/** Shift a YYYY-MM-DD by whole days without leaving the Pacific calendar. */
function shiftYmd(ymd: string, days: number): string {
  const noon = new Date(`${ymd}T12:00:00Z`);
  return new Date(noon.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}
