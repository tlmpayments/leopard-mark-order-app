import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { money0, shortDate } from "@/lib/ops/format";
import { candidateOrdersForDay, loadRoute, routeTotals, ymdOfRoute } from "@/lib/routes";
import { photoCountsByOrder } from "@/lib/deliveryPhotos";
import { pacificDayRange } from "@/lib/scheduling";
import { toNumber } from "@/lib/ops/format";
import {
  addStopAction,
  cancelRouteAction,
  dispatchRouteAction,
  moveStopAction,
  removeStopAction,
  updateRouteAction,
} from "../../actions";

export const dynamic = "force-dynamic";

/**
 * One route: who drives it, what is on it, and in what order.
 *
 * Sequencing is up/down buttons rather than drag-and-drop on purpose. This is a
 * server-rendered surface with server actions all the way down, and adding a
 * client-side drag library to reorder four rows would trade the whole page's
 * simplicity for a gesture that is worse on a phone anyway.
 */
export default async function RouteDetailPage({ params }: PageProps<"/ops/deliveries/routes/[id]">) {
  const { id } = await params;
  const route = await loadRoute(id);
  if (!route) notFound();

  const ymd = ymdOfRoute(route.date);
  const { start } = pacificDayRange(ymd);
  const totals = routeTotals(route);
  const editable = route.status === "draft";
  const live = route.status === "dispatched" || route.status === "in_progress";

  const [candidates, warehouses, drivers, photoCounts] = await Promise.all([
    candidateOrdersForDay(ymd, route.region),
    db.location.findMany({ where: { type: "warehouse", active: true }, orderBy: { id: "asc" } }),
    db.rep.findMany({ where: { role: "driver", active: true }, orderBy: { name: "asc" } }),
    photoCountsByOrder(route.stops.map((s) => s.orderId)),
  ]);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">
            <Link href={`/ops/deliveries?day=${ymd}`}>Dispatch</Link> · {shortDate(start)}
          </div>
          <h1>{route.name ? `${route.region} · ${route.name}` : `${route.region} route`}</h1>
          <p>
            {totals.stops} stop{totals.stops === 1 ? "" : "s"} · {totals.units} handling units
            {totals.kegs ? ` · ${totals.kegs} kegs` : ""} · out of {route.warehouse.name}
            {route.driver ? (
              <>
                {" "}
                · driven by <b>{route.driver.name}</b>
                {route.driver.phone ? ` (${route.driver.phone})` : ""}
              </>
            ) : (
              " · no driver assigned"
            )}
          </p>
        </div>
        <div className="actions">
          <a className="btn" href={`/api/documents/print?routeId=${route.id}`} target="_blank" rel="noopener">
            Print BOLs
          </a>
          {editable ? (
            <form action={dispatchRouteAction}>
              <input type="hidden" name="routeId" value={route.id} />
              <button
                className="btn primary"
                type="submit"
                disabled={!route.driverId || route.stops.length === 0}
              >
                Dispatch route
              </button>
            </form>
          ) : (
            <span className={`pill ${route.status === "completed" ? "good" : route.status === "cancelled" ? "serious" : "warn"}`}>
              {route.status.replace("_", " ")}
              {route.dispatchedAt ? ` · ${shortDate(route.dispatchedAt)}` : ""}
            </span>
          )}
        </div>
      </div>

      {editable && !route.driverId ? (
        <div className="state" style={{ marginBottom: 16 }}>
          <b>Assign a driver before dispatching.</b>
          <span>
            The driver is who the route appears for at <span className="mono">delivery.tlmbg.co</span>. Without one
            there is nobody to send it to.
          </span>
        </div>
      ) : null}

      <div className="dispatch">
        <div>
          <section className="panel" style={{ marginBottom: 16 }}>
            <div className="panel-head">
              <h3>Route</h3>
              <span className="pill neutral">{editable ? "editable" : "dispatched"}</span>
            </div>
            <form action={updateRouteAction} style={{ display: "grid", gap: 10 }}>
              <input type="hidden" name="routeId" value={route.id} />
              <label className="small muted">
                Driver
                <select className="fld" name="driverId" defaultValue={route.driverId ?? ""} style={{ width: "100%" }}>
                  <option value="">unassigned</option>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small muted">
                Warehouse
                <select
                  className="fld"
                  name="warehouseId"
                  defaultValue={route.warehouseId}
                  disabled={!editable}
                  style={{ width: "100%" }}
                >
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.id} — {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small muted">
                Name
                <input className="fld" name="name" defaultValue={route.name ?? ""} style={{ width: "100%" }} />
              </label>
              <label className="small muted">
                Notes for the driver
                <textarea
                  className="fld"
                  name="notes"
                  rows={3}
                  defaultValue={route.notes ?? ""}
                  style={{ width: "100%", resize: "vertical" }}
                />
              </label>
              <button className="btn" type="submit">
                Save route
              </button>
            </form>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h3>Add a stop</h3>
              <span className="pill neutral">{candidates.length}</span>
            </div>
            {candidates.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                Nothing left for {route.region} on this day. Orders appear here once a rep submits them and they are
                not already on a route.
              </p>
            ) : (
              <div className="pick">
                {candidates.map((o) => {
                  const units = o.lines.reduce((n, l) => n + l.qty, 0);
                  return (
                    <div className="row" key={o.id}>
                      <div style={{ minWidth: 0 }}>
                        <b>
                          <Link href={`/ops/orders/${o.id}`}>{o.account.businessName}</Link>
                        </b>
                        <div className="muted" style={{ marginTop: 2 }}>
                          {units} unit{units === 1 ? "" : "s"}
                          {o.scheduledFor ? "" : " · not yet scheduled"}
                        </div>
                      </div>
                      <form action={addStopAction}>
                        <input type="hidden" name="routeId" value={route.id} />
                        <input type="hidden" name="orderId" value={o.id} />
                        <button className="btn sm" type="submit">
                          Add
                        </button>
                      </form>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="small muted" style={{ marginBottom: 0, marginTop: 12 }}>
              Adding a stop schedules the order for {shortDate(start)} out of {route.warehouseId} if it was not
              already.
            </p>
          </section>
        </div>

        <section className="panel flush">
          <div className="panel-head">
            <h3>Stops, in driving order</h3>
            <span className="pill neutral">{route.stops.length}</span>
          </div>
          <div style={{ padding: "0 14px 16px" }}>
            {route.stops.length === 0 ? (
              <div className="empty">
                <b>No stops yet</b>
                Add orders from the panel on the left. The order you add them in is the order he drives them, and you
                can move them after.
              </div>
            ) : (
              <div className="stops">
                {route.stops.map((stop, i) => {
                  const order = stop.order;
                  const units = order.lines.reduce((n, l) => n + l.qty, 0);
                  const total = order.lines.reduce((s, l) => s + toNumber(l.lineTotal), 0);
                  return (
                    <div
                      className={`stop${stop.status === "delivered" ? " done" : stop.status === "failed" ? " failed" : ""}`}
                      key={stop.id}
                    >
                      <span className="seq">{stop.sequence}</span>
                      <div style={{ minWidth: 0 }}>
                        <div className="who">
                          <Link href={`/ops/orders/${order.id}`}>{order.account.businessName}</Link>{" "}
                          {stop.status === "delivered" ? <span className="pill good">delivered</span> : null}
                          {stop.status === "failed" ? (
                            <span className="pill serious">{stop.failureReason ?? "not delivered"}</span>
                          ) : null}
                        </div>
                        <div className="det">
                          {order.account.deliveryAddress ?? order.account.address ?? "no delivery address on file"}
                        </div>
                        <div className="det">
                          {units} unit{units === 1 ? "" : "s"} · {money0(total)}
                          {photoCounts.get(order.id) ? (
                            <>
                              {" · "}
                              <Link href={`/ops/orders/${order.id}#photos`}>
                                📷 {photoCounts.get(order.id)}
                              </Link>
                            </>
                          ) : stop.status === "delivered" ? (
                            <span style={{ color: "var(--warn-ink)" }}> · no photo</span>
                          ) : null}
                          {order.account.deliveryWindow ? ` · ${order.account.deliveryWindow}` : ""}
                          {order.shipment?.bolNumber ? (
                            <>
                              {" · "}
                              <span className="mono">{order.shipment.bolNumber}</span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div className="ctl">
                        {editable ? (
                          <>
                            <form action={moveStopAction}>
                              <input type="hidden" name="stopId" value={stop.id} />
                              <input type="hidden" name="direction" value="up" />
                              <button className="btn sm ghost" type="submit" disabled={i === 0} aria-label="Move up">
                                ↑
                              </button>
                            </form>
                            <form action={moveStopAction}>
                              <input type="hidden" name="stopId" value={stop.id} />
                              <input type="hidden" name="direction" value="down" />
                              <button
                                className="btn sm ghost"
                                type="submit"
                                disabled={i === route.stops.length - 1}
                                aria-label="Move down"
                              >
                                ↓
                              </button>
                            </form>
                            <form action={removeStopAction}>
                              <input type="hidden" name="stopId" value={stop.id} />
                              <button className="btn sm danger" type="submit">
                                Remove
                              </button>
                            </form>
                          </>
                        ) : (
                          <a
                            className="btn sm"
                            href={`/api/documents/print?orderId=${order.id}`}
                            target="_blank"
                            rel="noopener"
                          >
                            BOL
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="spec" style={{ marginTop: 16 }}>
        <b>Dispatch does three things:</b> mints a real BOL number for every stop (so the paper the driver hands
        over and the ledger agree), marks each shipment in transit, and makes the route appear for{" "}
        {route.driver?.name ?? "the assigned driver"} at <span className="mono">delivery.tlmbg.co</span>. Stock does
        not leave the books until each stop is marked delivered.
      </div>

      {editable && route.stops.every((s) => s.status === "pending") ? (
        <form action={cancelRouteAction} style={{ marginTop: 16 }}>
          <input type="hidden" name="routeId" value={route.id} />
          <button className="btn danger sm" type="submit">
            Cancel this route
          </button>
        </form>
      ) : null}

      {live ? (
        <p className="small muted" style={{ marginTop: 16 }}>
          Dispatched {route.dispatchedAt ? shortDate(route.dispatchedAt) : ""} ·{" "}
          {route.stops.filter((s) => s.status === "delivered").length} of {route.stops.length} delivered
        </p>
      ) : null}
    </>
  );
}
