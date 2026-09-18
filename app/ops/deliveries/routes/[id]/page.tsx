import Link from "next/link";
import { notFound } from "next/navigation";
import { candidateOrdersForDay, loadRoute, ymdOfRoute } from "@/lib/routes";
import { plannedStops } from "@/lib/deliveryBuilder";
import { readPreview } from "@/lib/routePlanning";
import { requireOpsUser } from "@/lib/ops/session";
import DeliveryBuilder from "../../DeliveryBuilder";
import { cancelRouteAction } from "../../actions";
export const dynamic = "force-dynamic";
export default async function RouteDetailPage({ params }: PageProps<"/ops/deliveries/routes/[id]">) {
  await requireOpsUser();
  const { id } = await params;
  const route = await loadRoute(id);
  if (!route) notFound();
  const ymd = ymdOfRoute(route.date);
  const candidates = route.status === "draft" ? await candidateOrdersForDay(ymd, "LA") : [];
  return <>
    <div className="page-head"><div><Link href={`/ops/deliveries?day=${ymd}`}>‹ Deliveries</Link><h1>{route.name || "Build Delivery"}</h1><p>{ymd} · {route.warehouse.name} · {route.driver?.name ?? "Driver needed"}</p></div>
      {route.status !== "draft" && <a className="btn" href={`/api/documents/print?routeId=${id}`} target="_blank" rel="noopener noreferrer">Print BOLs</a>}
    </div>
    <DeliveryBuilder key={route.updatedAt.toISOString()} routeId={id} origin={route.warehouse.address ?? ""} driver={route.driver?.name ?? "Jose"} status={route.status}
      candidates={candidates.map(o => ({ id:o.id, accountId:o.accountId, name:o.account.businessName, address:o.account.deliveryAddress || o.account.address || "", units:o.lines.reduce((n,l) => n+l.qty,0) }))}
      stops={plannedStops(route)} preview={readPreview(route.routingSnapshot)} mapKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY ?? ""} routingConfigured={Boolean(process.env.GOOGLE_ROUTES_API_KEY && process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY)}/>
    {route.status === "draft" && <form action={cancelRouteAction} style={{ marginTop:24 }}><input type="hidden" name="routeId" value={id}/><button className="btn danger sm">Cancel delivery</button></form>}
  </>;
}
