import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireDeliveryUser } from "@/lib/ops/session";
import { completeStopAction, failStopAction } from "../../actions";
import { PhotoCapture } from "../../_components/PhotoCapture";
import { photosForStop } from "@/lib/deliveryPhotos";

export const dynamic = "force-dynamic";

/**
 * One stop: what to leave, what to pick up, and the one button that says it
 * happened.
 *
 * The delivered quantities are pre-filled with what was ordered, because that
 * is what is true almost every time and a driver should not have to type six
 * numbers to record a normal delivery. Changing one is what makes the invoice
 * bill what actually came off the truck.
 */
export default async function StopPage({ params }: PageProps<"/delivery/stops/[id]">) {
  const user = await requireDeliveryUser();
  const { id } = await params;

  const stop = await db.routeStop.findUnique({
    where: { id },
    include: {
      route: {
        select: {
          id: true,
          region: true,
          status: true,
          driverId: true,
          notes: true,
          warehouse: { select: { name: true } },
          stops: { select: { id: true }, orderBy: { sequence: "asc" } },
        },
      },
      order: {
        include: {
          account: true,
          contact: { select: { name: true, phoneE164: true } },
          shipment: { select: { bolNumber: true } },
          lines: {
            orderBy: { lineIndex: "asc" },
            include: {
              product: {
                select: {
                  id: true,
                  skuCode: true,
                  productName: true,
                  formatLabel: true,
                  formatDetail: true,
                  isKeg: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!stop) notFound();
  // A driver session is authority over that driver's own stops. Reading someone
  // else's is reading a customer's address and order, so it fails the same way
  // writing it would.
  if (user.role === "driver" && stop.route.driverId !== user.id) redirect("/delivery");
  if (stop.route.status === "draft") redirect("/delivery");

  if (!stop.order) return <main>
    <Link href="/delivery">‹ Back to the route</Link>
    <h1>{stop.stopName}</h1><p>Stop {stop.sequence} of {stop.route.stops.length}</p>
    <p>{stop.stopAddress}</p>
    <a className="dv-btn go" target="_blank" rel="noopener noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(stop.stopAddress ?? "")}`}>Navigate to stop</a>
    {stop.notes && <p>{stop.notes}</p>}
    {stop.status === "pending" && stop.route.status !== "cancelled" ? <>
      <form action={completeStopAction} style={{ marginTop: 20 }}>
        <input type="hidden" name="stopId" value={stop.id}/>
        <label>Notes<textarea name="notes" defaultValue={stop.notes ?? ""}/></label>
        <button className="dv-btn go">Complete stop</button>
      </form>
      <form action={failStopAction} style={{ marginTop: 20 }}>
        <input type="hidden" name="stopId" value={stop.id}/>
        <label>Reason<input name="reason" required /></label>
        <button className="dv-btn">Unable to complete</button>
      </form>
    </> : <p>{stop.status === "delivered" ? "Stop completed" : stop.status}</p>}
  </main>;

  const order = stop.order;
  const account = order.account;
  const address = account.deliveryAddress ?? account.address ?? null;
  const total = stop.route.stops.length;

  // Empties to collect: every keg product this account is currently holding,
  // plus the keg SKUs on today's order. The first is the honest set -- a driver
  // picks up last month's empties, not just this delivery's.
  const custody = await db.kegCustodyEntry.groupBy({
    by: ["productId"],
    where: { accountId: account.id },
    _sum: { delta: true },
  });
  const heldProductIds = custody.filter((c) => (c._sum.delta ?? 0) > 0).map((c) => c.productId);
  const emptyProductIds = [
    ...new Set([...heldProductIds, ...order.lines.filter((l) => l.product.isKeg).map((l) => l.productId)]),
  ];
  const emptyProducts = emptyProductIds.length
    ? await db.product.findMany({
        where: { id: { in: emptyProductIds } },
        select: { id: true, productName: true, formatLabel: true },
        orderBy: { productName: "asc" },
      })
    : [];
  const heldBy = new Map(custody.map((c) => [c.productId, c._sum.delta ?? 0]));

  const photos = await photosForStop(stop.id);
  const settled = stop.status !== "pending";

  return (
    <main>
      <div style={{ marginBottom: 14 }}>
        <Link className="sm muted" href="/delivery">
          ‹ Back to the route
        </Link>
        <h1 style={{ fontSize: 26, marginTop: 8 }}>{account.businessName}</h1>
        <div className="sm muted">
          Stop {stop.sequence} of {total} · {stop.route.region}
          {order.shipment?.bolNumber ? (
            <>
              {" · "}
              <span className="mono">{order.shipment.bolNumber}</span>
            </>
          ) : null}
        </div>
      </div>

      {settled ? (
        <div className={`dv-pill ${stop.status === "delivered" ? "good" : "bad"}`} style={{ marginBottom: 14 }}>
          {stop.status === "delivered"
            ? `Delivered${stop.completedAt ? ` · ${timeOf(stop.completedAt)}` : ""}`
            : `Not delivered — ${stop.failureReason ?? "no reason given"}`}
        </div>
      ) : null}

      <div className="dv-card">
        <h3>Deliver to</h3>
        <div className="dv-addr">{address ?? "No delivery address on file"}</div>
        {account.deliveryWindow ? <div className="sm muted" style={{ marginTop: 6 }}>{account.deliveryWindow}</div> : null}
        {account.deliveryInstructions ? <div className="dv-instr">{account.deliveryInstructions}</div> : null}
        {stop.route.notes ? <div className="dv-instr">Route note: {stop.route.notes}</div> : null}

        <div className="dv-row" style={{ marginTop: 14 }}>
          {address ? (
            <a
              className="dv-btn primary"
              href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`}
              target="_blank"
              rel="noopener"
            >
              Navigate
            </a>
          ) : null}
          {order.contact?.phoneE164 ? (
            <a className="dv-btn" href={`tel:${order.contact.phoneE164}`}>
              Call
            </a>
          ) : null}
        </div>
        <a
          className="dv-btn quiet"
          style={{ marginTop: 10 }}
          href={`/api/documents/print?orderId=${order.id}`}
          target="_blank"
          rel="noopener"
        >
          Open bill of lading
        </a>
      </div>

      {settled ? null : (
        <div className="dv-card">
          <h3>Proof of delivery</h3>
          <p className="sm muted" style={{ margin: "0 0 12px" }}>
            {photos.length === 0
              ? "Photograph the kegs where you left them. This is what settles it if the account says the delivery never arrived."
              : `${photos.length} photo${photos.length === 1 ? "" : "s"} on this stop.`}
          </p>
          <PhotoCapture stopId={stop.id} existing={photos.map((p) => ({ id: p.id, caption: p.caption }))} canDelete />
        </div>
      )}

      {settled ? (
        <div className="dv-card">
          {photos.length ? (
            <>
              <h3>Proof of delivery</h3>
              <PhotoCapture
                stopId={stop.id}
                existing={photos.map((p) => ({ id: p.id, caption: p.caption }))}
                canDelete={false}
              />
              <div style={{ height: 18 }} />
            </>
          ) : null}
          <h3>What was left here</h3>
          {order.lines.map((l) => (
            <div className="dv-line" key={l.id}>
              <div>
                <div className="what">{l.product.productName}</div>
                <div className="fmt">{l.product.formatDetail || l.product.formatLabel}</div>
              </div>
              <div className="mono" style={{ textAlign: "center", fontSize: 18 }}>
                {l.qty}
              </div>
            </div>
          ))}
          {stop.notes ? <div className="dv-instr">{stop.notes}</div> : null}
        </div>
      ) : (
        <form action={completeStopAction}>
          <input type="hidden" name="stopId" value={stop.id} />

          <div className="dv-card">
            <h3>Off the truck</h3>
            {order.lines.map((l) => (
              <div className="dv-line" key={l.id}>
                <div>
                  <div className="what">{l.product.productName}</div>
                  <div className="fmt">
                    {l.product.formatDetail || l.product.formatLabel} · <span className="mono">{l.product.skuCode}</span>
                  </div>
                  <div className="lot">
                    <input
                      className="dv-in"
                      name={`lot[${l.id}]`}
                      placeholder="Lot # (optional)"
                      defaultValue={l.lotNumber ?? ""}
                      autoComplete="off"
                    />
                  </div>
                </div>
                <div>
                  <label className="dv-lab" htmlFor={`qty-${l.id}`}>
                    Qty
                  </label>
                  <input
                    id={`qty-${l.id}`}
                    className="dv-in num"
                    name={`qty[${l.id}]`}
                    type="number"
                    inputMode="numeric"
                    min={0}
                    defaultValue={l.qty}
                  />
                </div>
              </div>
            ))}
          </div>

          {emptyProducts.length ? (
            <div className="dv-card">
              <h3>Empties picked up</h3>
              {emptyProducts.map((p) => (
                <div className="dv-line" key={p.id}>
                  <div>
                    <div className="what">{p.productName}</div>
                    <div className="fmt">
                      {p.formatLabel}
                      {heldBy.get(p.id) ? ` · they hold ${heldBy.get(p.id)}` : ""}
                    </div>
                  </div>
                  <div>
                    <label className="dv-lab" htmlFor={`empty-${p.id}`}>
                      Back
                    </label>
                    <input
                      id={`empty-${p.id}`}
                      className="dv-in num"
                      name={`empty[${p.id}]`}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      placeholder="0"
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="dv-card">
            <h3>Notes</h3>
            <textarea
              className="dv-in"
              name="notes"
              rows={3}
              placeholder="Anything ops needs to know about this stop"
              style={{ resize: "vertical" }}
            />
          </div>

          <div className="dv-sticky">
            <button className="dv-btn go" type="submit">
              Mark delivered
            </button>
          </div>
        </form>
      )}

      {settled ? null : (
        <details className="dv-card" style={{ marginTop: 4 }}>
          <summary className="sm muted" style={{ cursor: "pointer", minHeight: 32 }}>
            Couldn&rsquo;t deliver this one
          </summary>
          <form action={failStopAction} style={{ marginTop: 12 }}>
            <input type="hidden" name="stopId" value={stop.id} />
            <label className="dv-lab" htmlFor="fail-reason">
              What happened
            </label>
            <select id="fail-reason" className="dv-in" name="reason" defaultValue="closed">
              <option value="closed">Closed / nobody there</option>
              <option value="refused">Refused the delivery</option>
              <option value="no_access">Couldn&rsquo;t get access</option>
              <option value="wrong_stock">Wrong stock on the truck</option>
              <option value="other">Something else</option>
            </select>
            <textarea
              className="dv-in"
              name="notes"
              rows={2}
              placeholder="Details for ops"
              style={{ marginTop: 10, resize: "vertical" }}
            />
            <button className="dv-btn danger" type="submit" style={{ marginTop: 12 }}>
              Record as not delivered
            </button>
          </form>
        </details>
      )}
    </main>
  );
}

const TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "numeric",
  minute: "2-digit",
});

function timeOf(d: Date): string {
  return TIME.format(d);
}
