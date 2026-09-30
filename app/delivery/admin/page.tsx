import Link from "next/link";
import { routesForDay, routeTotals, todayYmd } from "@/lib/routes";
import { requireDeliveryAdmin } from "./access";
import { createAdminRouteAction } from "./actions";

export const dynamic = "force-dynamic";

const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric" });
const dayLabel = (ymd: string) => DAY.format(new Date(`${ymd}T12:00:00Z`));
const shift = (ymd: string, days: number) =>
  new Date(new Date(`${ymd}T12:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);

const STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: "Draft", tone: "warn" },
  dispatched: { label: "With driver", tone: "info" },
  in_progress: { label: "On the road", tone: "good" },
  completed: { label: "Done", tone: "good" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/**
 * Admin home: the routes for a day, and a way to start a new one.
 *
 * A route is made from scratch here -- a day and a name, then stops picked
 * from the account list on the next screen -- and sits as a draft until it is
 * pushed to the driver.
 */
export default async function DeliveryAdminPage({ searchParams }: PageProps<"/delivery/admin">) {
  await requireDeliveryAdmin();
  const params = await searchParams;
  const raw = Array.isArray(params.day) ? params.day[0] : params.day;
  const today = todayYmd();
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(raw ?? "") && !Number.isNaN(Date.parse(`${raw}T12:00:00Z`)) ? raw! : today;
  const routes = await routesForDay(ymd);

  return (
    <main className="dv-admin">
      <h1 className="dv-title">Routes</h1>
      <p className="dv-sub">Build a route from your account list and send it to the driver.</p>

      <div className="dv-day-bar">
        <div className="seg">
          <Link href={`/delivery/admin?day=${shift(ymd, -1)}`}>‹</Link>
          <Link className="on" href={`/delivery/admin?day=${ymd}`}>
            {ymd === today ? "Today" : dayLabel(ymd)}
          </Link>
          <Link href={`/delivery/admin?day=${shift(ymd, 1)}`}>›</Link>
        </div>
        {ymd !== today ? (
          <Link className="dv-btn quiet inline" href="/delivery/admin">
            Today
          </Link>
        ) : null}
      </div>

      {routes.length === 0 ? (
        <div className="dv-list">
          <div className="dv-list-empty">
            <b>No routes for {ymd === today ? "today" : dayLabel(ymd)}.</b>
            Start one below.
          </div>
        </div>
      ) : (
        <div className="dv-list">
          {routes.map((route) => {
            const totals = routeTotals(route);
            const status = STATUS[route.status] ?? { label: route.status.replaceAll("_", " "), tone: "neutral" };
            return (
              <Link className="dv-cell" key={route.id} href={`/delivery/admin/routes/${route.id}`}>
                <span className="grow">
                  <span className="t">{route.name || "Route"}</span>
                  <span className="s">
                    {totals.stops} stop{totals.stops === 1 ? "" : "s"} · {route.driver?.name ?? "No driver"}
                  </span>
                </span>
                <span className="tail">
                  <span className={`dv-pill ${status.tone}`}>{status.label}</span>
                </span>
              </Link>
            );
          })}
        </div>
      )}

      <div className="dv-section">New route</div>
      <form className="dv-form" action={createAdminRouteAction}>
        <div>
          <label className="dv-lab" htmlFor="rt-day">
            Day
          </label>
          <input id="rt-day" className="dv-in" type="date" name="day" defaultValue={ymd} required />
        </div>
        <div>
          <label className="dv-lab" htmlFor="rt-name">
            Name <span className="muted">(optional)</span>
          </label>
          <input id="rt-name" className="dv-in" name="name" maxLength={120} placeholder="Jose’s delivery" autoComplete="off" />
        </div>
        <button className="dv-btn primary" type="submit">
          Create route
        </button>
      </form>
    </main>
  );
}
