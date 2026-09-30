"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addBuilderStop,
  coordinateDelivery,
  pushDeliveryToDriver,
  removeBuilderStop,
} from "@/app/ops/deliveries/builder-actions";
import RouteMap from "@/app/ops/deliveries/RouteMap";
import { routeSignature, type PlannedStop, type RoutePreview } from "@/lib/routePlanning";
import { listDeliveryAccounts, type AccountRow } from "../../actions";

type Candidate = { id: string; name: string; accountId: string; address: string; units: number };

type Props = {
  routeId: string;
  origin: string;
  originName: string;
  driver: string;
  status: string;
  candidates: Candidate[];
  stops: PlannedStop[];
  preview: RoutePreview | null;
  routingConfigured: boolean;
};

/**
 * Build a route from scratch: pick stops from the account list (or from orders
 * already waiting), put them in order, calculate the drive, send it to the
 * driver.
 *
 * The heavy lifting -- what counts as a valid stop, the path calculation, the
 * push -- is the Ops Hub builder's own server actions. This is a different
 * front on the same machinery, made for a phone: a segmented control swaps
 * between "Stops" and "Add", and on a desk both sit side by side.
 */
export default function AdminBuilder(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const editable = props.status === "draft";

  const [stops, setStops] = useState(props.stops);
  const [preview, setPreview] = useState(props.preview);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"stops" | "add">(props.stops.length ? "stops" : "add");

  // The account list.
  const [query, setQuery] = useState("");
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");

  // A custom stop (a pickup, a supply run): no account behind it.
  const [customName, setCustomName] = useState("");
  const [customAddress, setCustomAddress] = useState("");

  const validPreview = preview && preview.signature === routeSignature(props.origin, stops) ? preview : null;
  const onRoute = new Set(stops.map((s) => s.accountId).filter(Boolean));
  const orderOnRoute = new Set(stops.map((s) => s.orderId).filter(Boolean));
  const waiting = props.candidates.filter((c) => !orderOnRoute.has(c.id));

  const loadAccounts = useCallback(async (q: string, offset: number) => {
    setLoading(true);
    setListError("");
    try {
      const page = await listDeliveryAccounts({ query: q, offset });
      setAccounts((prev) => (offset === 0 ? page.accounts : [...prev, ...page.accounts]));
      setHasMore(page.hasMore);
    } catch {
      setListError("Couldn’t load accounts. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  // First page on open, then again (debounced) whenever the search changes.
  useEffect(() => {
    if (!editable) return;
    const timer = setTimeout(() => void loadAccounts(query, 0), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, editable, loadAccounts]);

  function mutate(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError("");
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) setError(result.error ?? "Please try again.");
        else {
          setPreview(null);
          router.refresh();
        }
      } catch {
        setError("The change could not be saved. Please retry.");
      }
    });
  }

  function coordinate(ordered: PlannedStop[], optimize: boolean) {
    setError("");
    setPreview(null);
    setStops(ordered);
    startTransition(async () => {
      try {
        const result = await coordinateDelivery(props.routeId, ordered.map((s) => s.id), optimize);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setStops(result.preview.stopIds.map((id) => ordered.find((s) => s.id === id)!));
        setPreview(result.preview);
        router.refresh();
      } catch {
        setError("Route calculation failed. Please retry.");
      }
    });
  }

  function move(index: number, delta: number) {
    const ordered = [...stops];
    [ordered[index], ordered[index + delta]] = [ordered[index + delta], ordered[index]];
    if (validPreview) coordinate(ordered, false);
    else {
      setStops(ordered);
      setPreview(null);
    }
  }

  function push() {
    if (!validPreview) return;
    setError("");
    startTransition(async () => {
      try {
        const result = await pushDeliveryToDriver(props.routeId, validPreview.signature);
        if (!result.ok) setError(result.error);
        else router.refresh();
      } catch {
        setError("Could not push the route. Reload to check its status before retrying.");
      }
    });
  }

  const banners = (
    <>
      {editable && !props.routingConfigured ? (
        <div className="dv-banner" role="status">
          <b>Route planning isn’t connected yet.</b>
          An OpenRouteService key is needed to order the stops and work out drive times. You can keep adding stops meanwhile.
        </div>
      ) : null}
      {editable && props.routingConfigured && !props.origin.trim() ? (
        <div className="dv-banner" role="status">
          <b>The warehouse needs a street address.</b>
          Add it in Settings so the route can start from the right place.
        </div>
      ) : null}
      {error ? (
        <div className="dv-banner error" role="alert">
          {error}
        </div>
      ) : null}
      {!editable ? (
        <div className="dv-banner" role="status">
          {props.status === "cancelled" ? "This route was cancelled." : `Sent to ${props.driver}. It’s in the driver app now.`}
        </div>
      ) : null}
    </>
  );

  const stopsPanel = (
    <section className="dv-panel" hidden={editable && tab !== "stops"}>
      <div className="dv-section" style={{ marginTop: 0 }}>
        {stops.length} stop{stops.length === 1 ? "" : "s"}
      </div>
      <div className="dv-list">
        <div className="dv-cell">
          <span className="seq origin">0</span>
          <span className="grow">
            <span className="t">{props.originName}</span>
            <span className="s">{props.origin || "Street address needed in Settings"}</span>
          </span>
        </div>
        {stops.map((s, i) => {
          const elapsed = validPreview?.legSeconds.slice(0, i + 1).reduce((sum, n) => sum + n, 0) ?? 0;
          return (
            <div className="dv-cell" key={s.id}>
              <span className="seq">{i + 1}</span>
              <span className="grow">
                <span className="t">{s.name}</span>
                <span className="s">{s.address || "Delivery address needed"}</span>
                <span className="s">
                  {s.orderId ? `Order ${s.orderId}` : "Account visit"}
                  {i === stops.length - 1 ? " · Final stop" : ""}
                </span>
                {validPreview ? (
                  <span className="t-timing">
                    {Math.ceil(validPreview.legSeconds[i] / 60)} min drive · {Math.ceil(elapsed / 60)} min from departure
                  </span>
                ) : null}
                {!editable ? <span className="s">{s.status === "delivered" ? "Completed" : s.status}</span> : null}
              </span>
              {editable ? (
                <span className="tail">
                  <button className="dv-btn quiet tiny" disabled={pending || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${s.name} up`}>
                    ↑
                  </button>
                  <button className="dv-btn quiet tiny" disabled={pending || i === stops.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${s.name} down`}>
                    ↓
                  </button>
                  <button className="dv-btn danger tiny" disabled={pending} onClick={() => mutate(() => removeBuilderStop(props.routeId, s.id))} aria-label={`Remove ${s.name}`}>
                    Remove
                  </button>
                </span>
              ) : null}
            </div>
          );
        })}
        {!stops.length ? (
          <div className="dv-list-empty">
            <b>Where is {props.driver.split(" ")[0]} headed?</b>
            Add accounts from the list to start this route.
          </div>
        ) : null}
      </div>

      {editable ? (
        <>
          <div className="dv-actionbar">
            <button
              className="dv-btn primary"
              disabled={pending || !stops.length || !props.routingConfigured || !props.origin.trim()}
              onClick={() => coordinate(stops, true)}
            >
              {pending ? "Working…" : "Optimize and calculate path"}
            </button>
          </div>
          <p className="sm muted" style={{ margin: "8px 4px 0" }}>
            Starts at {props.originName}. The last stop stays the destination; the stops between are put in the fastest order.
          </p>
        </>
      ) : null}
    </section>
  );

  const addPanel = editable ? (
    <section className="dv-panel" hidden={tab !== "add"}>
      {waiting.length ? (
        <>
          <div className="dv-section" style={{ marginTop: 0 }}>
            Orders waiting · {waiting.length}
          </div>
          <div className="dv-list">
            {waiting.map((c) => (
              <div className="dv-cell" key={c.id}>
                <span className="grow">
                  <span className="t">{c.name}</span>
                  <span className="s">{c.address || "Delivery address needed"}</span>
                  <span className="s">
                    {c.units} unit{c.units === 1 ? "" : "s"} · {c.id}
                  </span>
                </span>
                <button className="dv-btn primary tiny" disabled={pending} onClick={() => mutate(() => addBuilderStop(props.routeId, { orderId: c.id }))}>
                  Add
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="dv-section" style={waiting.length ? undefined : { marginTop: 0 }}>
        All accounts
      </div>
      <input
        className="dv-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name or address"
        autoComplete="off"
        autoCorrect="off"
        aria-label="Search accounts"
      />
      <div className="dv-list" style={{ marginTop: 12 }}>
        {accounts.map((a) => {
          const added = onRoute.has(a.id);
          return (
            <div className="dv-cell" key={a.id}>
              <span className="grow">
                <span className="t">{a.name}</span>
                <span className="s">{a.hasAddress ? a.address : "No delivery address on file"}</span>
              </span>
              <button
                className={added ? "dv-btn quiet tiny" : "dv-btn primary tiny"}
                disabled={pending || added || !a.hasAddress}
                onClick={() => mutate(() => addBuilderStop(props.routeId, { accountId: a.id }))}
              >
                {added ? "Added" : a.hasAddress ? "Add" : "Needs address"}
              </button>
            </div>
          );
        })}
        {loading && !accounts.length ? <div className="dv-list-empty">Loading accounts…</div> : null}
        {!loading && !accounts.length && !listError ? (
          <div className="dv-list-empty">
            <b>No accounts found.</b>
            Try a different spelling.
          </div>
        ) : null}
        {listError ? <div className="dv-list-empty">{listError}</div> : null}
      </div>
      {hasMore ? (
        <button className="dv-btn quiet" style={{ marginTop: 12 }} disabled={loading} onClick={() => void loadAccounts(query, accounts.length)}>
          {loading ? "Loading…" : "Show more accounts"}
        </button>
      ) : null}

      <details style={{ marginTop: 22 }}>
        <summary className="dv-section" style={{ cursor: "pointer", margin: "0 4px 8px" }}>
          Add a custom stop
        </summary>
        <form
          className="dv-form"
          onSubmit={(e) => {
            e.preventDefault();
            mutate(async () => {
              const result = await addBuilderStop(props.routeId, { name: customName, address: customAddress });
              if (result.ok) {
                setCustomName("");
                setCustomAddress("");
              }
              return result;
            });
          }}
        >
          <div>
            <label className="dv-lab" htmlFor="cs-name">
              Stop name
            </label>
            <input id="cs-name" className="dv-in" value={customName} onChange={(e) => setCustomName(e.target.value)} required maxLength={200} placeholder="Pickup, supply run, other" />
          </div>
          <div>
            <label className="dv-lab" htmlFor="cs-addr">
              Full street address
            </label>
            <input id="cs-addr" className="dv-in" value={customAddress} onChange={(e) => setCustomAddress(e.target.value)} required maxLength={500} placeholder="Street, city, state, ZIP" />
          </div>
          <button className="dv-btn primary" disabled={pending}>
            Add stop
          </button>
        </form>
      </details>
    </section>
  ) : null;

  return (
    <div className="dv-builder" aria-busy={pending}>
      {banners}

      {editable ? (
        <div className="dv-seg dv-only-mobile" role="group" aria-label="Route sections">
          <button type="button" aria-pressed={tab === "stops"} onClick={() => setTab("stops")}>
            Stops ({stops.length})
          </button>
          <button type="button" aria-pressed={tab === "add"} onClick={() => setTab("add")}>
            Add stops
          </button>
        </div>
      ) : null}

      <div className="dv-cols">
        {stopsPanel}
        {addPanel}
      </div>

      {validPreview ? (
        <section className="dv-map-card">
          <h2>Review the path</h2>
          <p className="sm muted" style={{ margin: "4px 0 0" }}>
            {Math.ceil(validPreview.durationSeconds / 60)} min driving · {(validPreview.distanceMeters / 1609.344).toFixed(1)} miles · {stops.length} stops. Estimates exclude traffic and unloading.
          </p>
          {validPreview.warnings?.length ? (
            <div className="dv-banner error" role="alert" style={{ marginTop: 12 }}>
              <b>Check these pins before sending.</b>
              <ul>
                {validPreview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {validPreview.originCoord && validPreview.stopCoords?.length === stops.length ? (
            <RouteMap
              origin={validPreview.originCoord}
              geometry={validPreview.geometry ?? []}
              stops={stops.map((s, i) => ({ name: s.name, coord: validPreview.stopCoords![i] }))}
            />
          ) : null}
          <p className="sm muted" style={{ margin: "10px 0 0" }}>
            Each pin sits where the route really sends the driver, not where the address was typed. A pin on the wrong block means that stop’s address needs fixing.
          </p>
          {editable ? (
            <div className="dv-push">
              <p>
                Send this route to <b style={{ color: "var(--ink)" }}>{props.driver}</b> in the driver app.
              </p>
              <button className="dv-btn go" disabled={pending} onClick={push}>
                Send to driver
              </button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
