"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addBuilderStop, coordinateDelivery, pushDeliveryToDriver, removeBuilderStop, searchDeliveryAccounts } from "./builder-actions";
import { mapsEmbedUrl, routeSignature, type PlannedStop, type RoutePreview } from "@/lib/routePlanning";
import "./builder.css";

export type Candidate = { id: string; name: string; accountId: string; address: string; units: number };
type Props = { routeId: string; origin: string; driver: string; status: string; candidates: Candidate[]; stops: PlannedStop[]; preview: RoutePreview | null; mapKey: string; routingConfigured: boolean };
export default function DeliveryBuilder(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [stops, setStops] = useState(props.stops);
  const [preview, setPreview] = useState(props.preview);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [accounts, setAccounts] = useState<Awaited<ReturnType<typeof searchDeliveryAccounts>>>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  useEffect(() => {
    let active = true;
    if (query.trim().length < 2) return;
    const timer = setTimeout(() => {
      searchDeliveryAccounts(query).then(results => { if (active) setAccounts(results); })
        .catch(() => { if (active) { setAccounts([]); setSearchError("Account search failed. Please try again."); } })
        .finally(() => { if (active) setSearching(false); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [query]);
  const editable = props.status === "draft";
  const validPreview = preview && preview.signature === routeSignature(props.origin, stops) ? preview : null;
  const selectedOrders = new Set(stops.map(s => s.orderId));
  const candidates = props.candidates.filter(c => !selectedOrders.has(c.id));
  const visible = candidates.filter(c => `${c.name} ${c.address} ${c.id}`.toLowerCase().includes(query.toLowerCase()));
  function mutate(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError("");
    startTransition(async () => {
      try { const result = await action(); if (!result.ok) setError(result.error ?? "Please try again."); else { setPreview(null); router.refresh(); } }
      catch { setError("The change could not be saved. Please retry."); }
    });
  }
  function coordinate(ordered: PlannedStop[], optimize: boolean) {
    setError(""); setPreview(null); setStops(ordered);
    startTransition(async () => {
      try {
        const result = await coordinateDelivery(props.routeId, ordered.map(s => s.id), optimize);
        if (!result.ok) { setError(result.error); return; }
        setStops(result.preview.stopIds.map(id => ordered.find(s => s.id === id)!)); setPreview(result.preview);
        router.refresh();
      } catch { setError("Route calculation failed. Please retry."); }
    });
  }
  function move(index: number, delta: number) {
    const ordered = [...stops]; [ordered[index], ordered[index + delta]] = [ordered[index + delta], ordered[index]];
    if (validPreview) coordinate(ordered, false); else { setStops(ordered); setPreview(null); }
  }
  return <div className="delivery-builder" aria-busy={pending}>
    {editable && !props.routingConfigured && <div className="builder-notice" role="status"><b>Google Maps isn’t connected yet.</b><p>Maps setup is required to show the route and calculate drive times. You can keep adding stops while the connection is set up.</p></div>}
    {editable && props.routingConfigured && !props.origin.trim() && <div className="builder-notice" role="status"><b>The warehouse needs a street address.</b><p>Add Wilmington Warehouse’s exact address in Settings to calculate the route.</p></div>}
    {error && <div className="builder-error" role="alert">{error}</div>}
    {!editable && <div className="builder-notice" role="status">{props.status === "cancelled" ? "Delivery cancelled" : `Pushed to ${props.driver}. The route is available in the driver app.`}</div>}
    <div className="builder-columns">
      {editable && <section className="panel">
        <div className="panel-head"><h2>Orders awaiting delivery</h2><span className="pill neutral">{candidates.length}</span></div>
        <label className="builder-label">Search orders or any account<input className="fld" type="search" value={query} onChange={e => { setQuery(e.target.value); setAccounts([]); setSearchError(""); setSearching(e.target.value.trim().length >= 2); }} placeholder="Account name, address, or order number" /></label>
        <div className="builder-list">
          {visible.map(c => <div className="builder-row" key={c.id}><div><b>{c.name}</b><p>{c.address || "Delivery address needed"}</p><small>{c.units} units · {c.id}</small></div>
            <button className="btn sm" disabled={pending} onClick={() => mutate(() => addBuilderStop(props.routeId, { orderId: c.id }))}>Add Stop</button></div>)}
          {!visible.length && <p className="muted">{query ? "No awaiting orders match your search." : "No orders awaiting delivery for this day."}</p>}
        </div>
        {query.trim().length >= 2 && <section className="builder-account-search"><h3>All accounts</h3><p className="small muted">Add an account visit without an order.</p>
          {searching && <p role="status">Searching accounts…</p>}{searchError && <p role="alert">{searchError}</p>}
          {!searching && !searchError && accounts.length === 0 && <p className="muted">No accounts found.</p>}
          {accounts.map(a => { const added = stops.some(s => s.accountId === a.id); return <div className="builder-row" key={a.id}><div><b>{a.businessName}</b><p>{a.deliveryAddress || a.address || "Delivery address needed"}</p></div><button className="btn sm" disabled={pending || added} onClick={() => mutate(() => addBuilderStop(props.routeId, { accountId: a.id }))}>{added ? "Added" : "Add Stop"}</button></div>; })}
          {accounts.length === 30 && <p className="small muted">Showing 30 matches. Refine your search to find more accounts.</p>}
        </section>}
        <details className="builder-custom"><summary>Add a custom stop</summary><form onSubmit={e => { e.preventDefault(); mutate(async () => { const result = await addBuilderStop(props.routeId, { name, address }); if (result.ok) { setName(""); setAddress(""); } return result; }); }}>
          <label className="builder-label">Stop name<input className="fld" value={name} onChange={e => setName(e.target.value)} required maxLength={200} placeholder="Pickup, supply run, or other stop"/></label>
          <label className="builder-label">Full street address<input className="fld" value={address} onChange={e => setAddress(e.target.value)} required maxLength={500} placeholder="Street, city, state, ZIP"/></label>
          <button className="btn" disabled={pending}>Add Stop</button>
        </form></details>
      </section>}
      <section className="panel builder-selected">
        <div className="panel-head"><h2>{editable ? "Delivery being built" : "Delivery stops"}</h2><span className="pill neutral">{stops.length} stops</span></div>
        <div className="builder-origin"><span className="builder-seq">0</span><div><b>Wilmington Warehouse</b><p>{props.origin || "Street address needed in Settings"}</p><small>Driver: {props.driver}</small></div></div>
        {!stops.length && <div className="builder-empty"><h3>Where is Jose headed?</h3><p>Add orders, search an account, or enter a custom stop to build this delivery.</p></div>}
        <ol className="builder-stops">{stops.map((s, i) => {
          const elapsed = validPreview?.legSeconds.slice(0, i + 1).reduce((sum, n) => sum + n, 0) ?? 0;
          return <li className="builder-row" key={s.id}><span className="builder-seq">{i + 1}</span><div className="builder-stop-copy"><b>{s.name}</b><p>{s.address || "Delivery address needed"}</p>
            <small>{s.orderId ? `Order ${s.orderId}` : "Account visit / custom stop"}{i === stops.length - 1 ? " · Final stop" : ""}</small>
            {validPreview && <p className="builder-timing">{Math.ceil(validPreview.legSeconds[i] / 60)} min drive · arrive {Math.ceil(elapsed / 60)} min after departure</p>}
            {!editable && <p>{s.status === "delivered" ? "Completed" : s.status}</p>}
          </div>{editable && <div className="builder-controls"><div><button className="btn sm" disabled={pending || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${s.name} up`}>↑</button><button className="btn sm" disabled={pending || i === stops.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${s.name} down`}>↓</button></div><button className="btn sm ghost" disabled={pending} onClick={() => mutate(() => removeBuilderStop(props.routeId, s.id))}>Remove</button></div>}</li>;
        })}</ol>
        {editable && <><button className="btn primary builder-optimize" disabled={pending || !stops.length || !props.routingConfigured || !props.origin.trim()} onClick={() => coordinate(stops, true)}>{pending ? "Saving and calculating…" : "Optimize and Coordinate Path"}</button><p className="small muted">Starts at Wilmington. Your final stop stays the destination; the stops in between are optimized. Move a different stop to the bottom to change the destination.</p></>}
      </section>
    </div>
    {validPreview && <section className="panel builder-map-review">
      <div className="panel-head"><div><h2>Review the path</h2><p>{Math.ceil(validPreview.durationSeconds / 60)} min driving · {(validPreview.distanceMeters / 1609.344).toFixed(1)} miles · {stops.length} stops</p></div></div>
      <p className="small muted">Use the arrows above to rearrange stops. The map and drive times update after each change. Estimates use current traffic and exclude unloading time.</p>
      {props.mapKey && <iframe title="Delivery route from Wilmington Warehouse" src={mapsEmbedUrl(props.mapKey, props.origin, stops)} allowFullScreen referrerPolicy="no-referrer-when-downgrade" />}
      <p className="small muted">The map follows the selected stop order. Google’s map preview may show different traffic estimates.</p>
      {editable && <div className="builder-push"><p>Send this delivery to <b>{props.driver}</b> in the driver app.</p><button className="btn primary" disabled={pending} onClick={() => { setError(""); startTransition(async () => { try { const result = await pushDeliveryToDriver(props.routeId, validPreview.signature); if (!result.ok) setError(result.error); else router.refresh(); } catch { setError("Could not push the delivery. Reload to check its status before retrying."); } }); }}>Push to Driver</button></div>}
    </section>}
  </div>;
}
