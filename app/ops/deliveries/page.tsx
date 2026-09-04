import Link from "next/link";
import { db } from "@/lib/db";
import { loadOrders, stageOrders, type StagedOrder } from "@/lib/ops/queries";
import { linesSummary, money0, shortDate } from "@/lib/ops/format";
import { pacificParts } from "@/lib/scheduling";

export const dynamic = "force-dynamic";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Deliveries (§8.5) — the week, by route day.
 *
 * Columns are the region's actual route days from RouteSchedule, not a generic
 * Mon–Fri grid: a day the trucks do not run is drawn as an off day so nobody
 * schedules into it. Unscheduled orders sit in the left tray.
 */
export default async function DeliveriesPage({ searchParams }: PageProps<"/ops/deliveries">) {
  const params = await searchParams;
  const region = (Array.isArray(params.region) ? params.region[0] : params.region) ?? null;

  const [orders, routes] = await Promise.all([
    loadOrders({ status: { notIn: ["cancelled", "rejected", "expired"] } }).then(stageOrders),
    db.routeSchedule.findMany({ where: { active: true } }),
  ]);

  const regions = [...new Set(routes.map((r) => r.region))];
  const scoped = region ? orders.filter((o) => o.account.region === region) : orders;
  const routeWeekdays = new Set(
    (region ? routes.filter((r) => r.region === region) : routes).map((r) => r.weekday),
  );

  // The five weekdays of the current week, Monday first.
  const now = new Date();
  const todayWeekday = pacificParts(now).weekday;
  const monday = new Date(now.getTime() - ((todayWeekday + 6) % 7) * 86_400_000);
  const days = [1, 2, 3, 4, 5].map((wd, i) => {
    const date = new Date(monday.getTime() + i * 86_400_000);
    return {
      weekday: wd,
      date,
      isRouteDay: routeWeekdays.has(wd),
      orders: scoped.filter(
        (o) => o.scheduledFor && shortDate(o.scheduledFor) === shortDate(date) && !o.deliveredAt,
      ),
    };
  });

  const tray = scoped.filter((o) => !o.scheduledFor && !o.deliveredAt && o.pipeline.stage !== "account_setup");

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Deliveries · week of {shortDate(monday)}</div>
          <h1>Deliveries</h1>
          <p>
            Route days come from <span className="mono">RouteSchedule</span>. A day with no route is drawn as an off
            day, so nothing gets booked onto a truck that does not run.
          </p>
        </div>
        <div className="actions">
          {regions.length > 1 ? (
            <div className="seg">
              <Link className={!region ? "on" : ""} href="/ops/deliveries">
                All regions
              </Link>
              {regions.map((r) => (
                <Link key={r} className={region === r ? "on" : ""} href={`/ops/deliveries?region=${r}`}>
                  {r}
                </Link>
              ))}
            </div>
          ) : null}
          <Link className="btn primary" href="/ops/documents">
            Print batch
          </Link>
        </div>
      </div>

      {routes.length === 0 ? (
        <div className="state" style={{ marginBottom: 16 }}>
          <b>No route schedule yet.</b>
          <span>
            Add region → warehouse → weekday rows in Settings. Until then the system cannot propose a delivery day,
            and every order waits for a human at stage ②.
          </span>
        </div>
      ) : null}

      <div className="week">
        <div className="day tray">
          <div className="dh">
            <b>Unscheduled</b>
            <span className="num">{tray.length}</span>
          </div>
          {tray.length === 0 ? (
            <p className="small muted">Nothing waiting.</p>
          ) : (
            tray.map((o) => <ShipCard key={o.id} order={o} />)
          )}
        </div>

        {days.map((d) => (
          <div className={`day${d.isRouteDay ? "" : " off"}`} key={d.weekday}>
            <div className="dh">
              <b>
                {DAY_NAMES[d.weekday]}{" "}
                <span className="muted" style={{ fontSize: 13, fontFamily: "var(--font-body)" }}>
                  {shortDate(d.date)}
                </span>
              </b>
              <span className="num">
                {d.orders.length
                  ? `${d.orders.reduce((s, o) => s + o.lines.reduce((a, l) => a + l.qty, 0), 0)} HU`
                  : d.isRouteDay
                    ? "open"
                    : "no route"}
              </span>
            </div>
            {d.orders.map((o) => (
              <ShipCard key={o.id} order={o} />
            ))}
          </div>
        ))}
      </div>

      <div className="spec" style={{ marginTop: 16 }}>
        <b>Mark delivered</b> lives on the order, and in the rep app once Phase R ships. Submitting it mints the real
        BOL number, writes the ledger and keg custody, mirrors the delivery facts to the Sheet, and enqueues the
        invoice — which is what starts the Net 30 clock from delivery rather than from order date.
      </div>
    </>
  );
}

function ShipCard({ order }: { order: StagedOrder }) {
  return (
    <Link className="ship" href={`/ops/orders/${order.id}`}>
      <b>{order.account.businessName}</b>
      <div className="m">
        <span>{linesSummary(order.lines)}</span>
        <span className="num">{money0(order.total)}</span>
      </div>
      <div className="m">
        <span>
          {order.account.region ? <span className="region">{order.account.region}</span> : null}{" "}
          {order.inventorySource ?? ""}
        </span>
        <span className={order.pipeline.stage === "blocked" ? "" : "muted"}>
          {order.pipeline.stage === "blocked" ? (
            <span style={{ color: "var(--serious-ink)" }}>blocked</span>
          ) : (
            (order.shipment?.carrierName ?? "carrier tbd")
          )}
        </span>
      </div>
    </Link>
  );
}
