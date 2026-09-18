import Link from "next/link";
import { shortDate } from "@/lib/ops/format";
import { candidateOrdersForDay, routesForDay, routeTotals, todayYmd } from "@/lib/routes";
import { pacificDayRange } from "@/lib/scheduling";
import { createRouteAction } from "./actions";
import { requireOpsUser } from "@/lib/ops/session";
import "./builder.css";
export const dynamic = "force-dynamic";
export default async function DispatchBoardPage({ searchParams }: PageProps<"/ops/deliveries">) {
  await requireOpsUser();
  const params = await searchParams;
  const day = Array.isArray(params.day) ? params.day[0] : params.day;
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(day ?? "") && !Number.isNaN(Date.parse(`${day}T12:00:00Z`)) ? day! : todayYmd();
  const [allRoutes, candidates] = await Promise.all([routesForDay(ymd), candidateOrdersForDay(ymd, "LA")]);
  const routes = allRoutes.filter(r => r.warehouseId === "WH-WIL");
  const shift = (offset:number) => new Date(new Date(`${ymd}T12:00:00Z`).getTime()+offset*86400000).toISOString().slice(0,10);
  return <>
    <div className="page-head"><div><h1>Deliveries</h1><p>Build Jose&rsquo;s route from Wilmington Warehouse.</p></div><div className="actions"><Link className="btn" href="/ops/deliveries/week">The week</Link><a className="btn" href={`/api/documents/print?day=${ymd}`} target="_blank" rel="noopener noreferrer">Print the day</a></div></div>
    <div className="delivery-summary"><div><strong>{candidates.length}</strong><span>orders awaiting delivery</span><p className="small muted">Los Angeles · {shortDate(pacificDayRange(ymd).start)} and unscheduled orders</p></div><form action={createRouteAction}><input type="hidden" name="day" value={ymd}/><button className="btn primary">Build Delivery</button></form></div>
    <div className="daybar"><div className="seg"><Link href={`/ops/deliveries?day=${shift(-1)}`}>‹ {shortDate(pacificDayRange(shift(-1)).start)}</Link><Link className="on" href={`/ops/deliveries?day=${ymd}`}>{shortDate(pacificDayRange(ymd).start)}</Link><Link href={`/ops/deliveries?day=${shift(1)}`}>{shortDate(pacificDayRange(shift(1)).start)} ›</Link></div>{ymd!==todayYmd()&&<Link className="btn sm" href="/ops/deliveries">Today</Link>}</div>
    <div className="routes">{!routes.length ? <div className="state"><b>No deliveries built for this day.</b><span>Choose Build Delivery to start adding stops for Jose.</span></div> : routes.map(route => {const totals=routeTotals(route); return <article className="rt" key={route.id}><div className="rt-head"><div><h3><Link href={`/ops/deliveries/routes/${route.id}`}>{route.name || "Jose’s delivery"}</Link></h3><div className="sub">{totals.stops} stops · {totals.units} units · {route.driver?.name ?? "Driver needed"}</div></div><div className="actions"><span className="pill neutral">{route.status.replaceAll("_"," ")}</span><Link className={`btn${route.status === "draft" ? " primary" : ""}`} href={`/ops/deliveries/routes/${route.id}`}>{route.status === "draft" ? "Continue Building" : "View Delivery"}</Link></div></div></article>;})}</div>
  </>;
}
