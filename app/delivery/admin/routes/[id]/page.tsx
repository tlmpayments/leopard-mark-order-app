import Link from "next/link";
import { notFound } from "next/navigation";
import { candidateOrdersForDay, loadRoute, ymdOfRoute } from "@/lib/routes";
import { plannedStops } from "@/lib/deliveryBuilder";
import { readPreview } from "@/lib/routePlanning";
import { requireDeliveryAdmin } from "../../access";
import { cancelAdminRouteAction } from "../../actions";
import AdminBuilder from "./AdminBuilder";

export const dynamic = "force-dynamic";

const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric" });

export default async function DeliveryAdminRoutePage({ params }: PageProps<"/delivery/admin/routes/[id]">) {
  await requireDeliveryAdmin();
  const { id } = await params;
  const route = await loadRoute(id);
  if (!route) notFound();

  const ymd = ymdOfRoute(route.date);
  const candidates = route.status === "draft" ? await candidateOrdersForDay(ymd, "LA") : [];

  return (
    <main className="dv-admin">
      <Link className="dv-back" href={`/delivery/admin?day=${ymd}`}>
        ‹ Routes
      </Link>
      <h1 className="dv-title">{route.name || "New route"}</h1>
      <p className="dv-sub">
        {DAY.format(new Date(`${ymd}T12:00:00Z`))} · {route.warehouse.name} · {route.driver?.name ?? "Driver needed"}
      </p>

      <AdminBuilder
        key={route.updatedAt.toISOString()}
        routeId={id}
        origin={route.warehouse.address ?? ""}
        originName={route.warehouse.name}
        driver={route.driver?.name ?? "Jose"}
        status={route.status}
        candidates={candidates.map((o) => ({
          id: o.id,
          accountId: o.accountId,
          name: o.account.businessName,
          address: o.account.deliveryAddress || o.account.address || "",
          units: o.lines.reduce((n, l) => n + l.qty, 0),
        }))}
        stops={plannedStops(route)}
        preview={readPreview(route.routingSnapshot)}
        routingConfigured={Boolean(process.env.OPENROUTESERVICE_API_KEY)}
      />

      {route.status !== "draft" && route.status !== "cancelled" ? (
        <p style={{ marginTop: 20 }}>
          <a className="dv-btn quiet" href={`/api/documents/print?routeId=${id}`} target="_blank" rel="noopener noreferrer">
            Print BOLs
          </a>
        </p>
      ) : null}

      {route.status === "draft" ? (
        <form action={cancelAdminRouteAction} style={{ marginTop: 28 }}>
          <input type="hidden" name="routeId" value={id} />
          <button className="dv-btn danger" type="submit">
            Cancel this route
          </button>
        </form>
      ) : null}
    </main>
  );
}
