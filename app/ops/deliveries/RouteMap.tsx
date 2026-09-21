"use client";
import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";

type Props = {
  origin: [number, number];
  stops: { name: string; coord: [number, number] }[];
  geometry: [number, number][];
};

/**
 * The route, drawn.
 *
 * Its job is not decoration: it is the only place an operator can catch a stop
 * whose address geocoded to the wrong block before the route reaches Jose's
 * phone. So every stop gets a numbered pin at the coordinate actually routed
 * to -- not at the address as typed -- and the pins carry the same numbers as
 * the list above them.
 *
 * Leaflet is loaded inside the effect rather than imported at module scope
 * because it reaches for `window` on import, which would break the server
 * render. That also keeps it out of the bundle for every ops screen that never
 * opens a route.
 *
 * Markers are `divIcon`s rather than Leaflet's default marker: the default
 * pulls PNGs by relative URL and those paths do not survive bundling, which is
 * the classic broken-marker-image bug. Numbered HTML needs no assets at all.
 */
export default function RouteMap({ origin, stops, geometry }: Props) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let map: import("leaflet").Map | null = null;
    let cancelled = false;

    void (async () => {
      const L = await import("leaflet");
      if (cancelled || !host.current) return;

      map = L.map(host.current, { scrollWheelZoom: false });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);

      const pin = (label: string, className: string) =>
        L.divIcon({ className: "", html: `<span class="route-pin ${className}">${label}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });

      // Leaflet takes [lat, lng]; the routing service hands back [lng, lat].
      const flip = ([lng, lat]: [number, number]): [number, number] => [lat, lng];

      L.marker(flip(origin), { icon: pin("0", "origin"), title: "Wilmington Warehouse" }).addTo(map)
        .bindPopup("Wilmington Warehouse");
      stops.forEach((stop, i) => {
        L.marker(flip(stop.coord), { icon: pin(String(i + 1), "stop"), title: stop.name }).addTo(map!)
          .bindPopup(`${i + 1}. ${stop.name}`);
      });

      const line = geometry.length > 1 ? L.polyline(geometry.map(flip), { color: "#3b5bdb", weight: 4, opacity: 0.85 }).addTo(map) : null;
      // Without geometry (an older saved review) the pins alone still frame the day.
      const bounds = line ? line.getBounds() : L.latLngBounds([flip(origin), ...stops.map(s => flip(s.coord))]);
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [28, 28] });
    })();

    return () => { cancelled = true; map?.remove(); };
  }, [origin, stops, geometry]);

  return <div ref={host} className="route-map" role="img" aria-label={`Route map with ${stops.length} stops from Wilmington Warehouse`} />;
}
