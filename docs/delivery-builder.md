# Wilmington delivery builder

The Deliveries board is scoped to LA orders and routes from WH-WIL. Its count includes orders scheduled for the selected day and unscheduled orders, excludes orders already on routes, and is no longer truncated at 200 before region filtering.

Build Delivery automatically assigns the active WH-WIL warehouse and the single active driver whose first name is Jose (accented José is supported). Existing draft routes with another warehouse/driver must be replaced with a new delivery to use Push to Driver.

The builder supports order stops, account visits found by server-side search, and custom stops with a name and full street address. Non-order stops never create shipments, invoices, or inventory movements. They share the same stop sequence and driver completion flow as order stops. BOL printing skips non-order stops.

## Configuration before deployment

- Apply the migration `20260914000000_delivery_builder` and regenerate Prisma before deploying the application. The migration adds nullable order IDs, custom destination fields, and a persisted routing review.
- Set the actual street address of WH-WIL in Settings. The city-centre seed coordinates are deliberately not used as a warehouse location.
- Ensure exactly one active driver named Jose or Jose followed by his surname has role `driver` and an existing driver sign-in.
- Configure `OPENROUTESERVICE_API_KEY` on the server. It is server-side only and never reaches the browser; the map needs no key of its own.

WH-WIL's street address is set in Settings → Facilities. The seeded lat/lng is a city centroid and is deliberately not used as the routing origin.

No production migration or deployment is performed as part of local implementation. Do not use the isolated preview's demonstration warehouse address as the production address.

## Routing behavior

Routing runs on OpenRouteService, chosen over Google because it needs no billing account. Three endpoints do the work, all server-side:

- `/geocode/search` turns an address into coordinates (Pelias, over OSM and OpenAddresses), biased to the USA.
- `/optimization` orders the intermediate stops (VROOM). The vehicle's fixed `end` keeps the operator's chosen final stop last.
- `/v2/directions` returns the drive times, the distance, and the line drawn on the map.

Optimize and Coordinate Path fixes Wilmington as the origin, keeps the chosen final stop as the destination, and orders what lies between. Moving a stop to the bottom changes the final destination. Arrows on a reviewed route preserve the operator's chosen sequence, skip the optimizer, and recalculate drive times. A route supports 21 stops.

Optimization decides the order only. Every duration and distance shown comes from the directions call on the final order, so the numbers on screen describe the line actually drawn rather than VROOM's internal cost matrix.

The map is Leaflet over OpenStreetMap tiles, with no API key. Its purpose is verification, not decoration: each numbered pin sits at the coordinate the route actually uses, so a stop whose address geocoded to the wrong block is visible before the route reaches Jose. Reordering is done with the app's arrow controls.

Times are driving minutes and arrival offsets from departure, excluding unloading/service times, and -- unlike the Google integration this replaced -- excluding live traffic, which the free `driving-car` profile does not model. No warehouse return leg is added.

### Geocoding is the weak point

ORS geocoding is less precise than Google's on US street addresses. Three things contain that:

- An account that already has `lat`/`lng` is never re-geocoded; its stored coordinates are used directly.
- An account geocoded for a route has its coordinates written back, so it is looked up once ever.
- Any match ORS scores below 0.8 confidence raises a named warning above the map, listing the stop and what ORS thinks it matched.

Free-plan ceilings are surfaced distinctly: HTTP 429 reports the per-minute limit (wait and retry), 403 the daily quota (resumes tomorrow), 401 a rejected key.

Push to Driver validates the reviewed stop IDs, sequence, addresses, warehouse origin, and assigned driver, then invokes the existing transactional dispatch workflow. Custom stops need no BOL. Jose receives the route in delivery.tlmbg.co through the existing authenticated driver app; no SMS or email is sent. Drafts are hidden from drivers.

Official references: [ORS optimization](https://giscience.github.io/openrouteservice/api-reference/endpoints/optimization/), [ORS directions](https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/), [VROOM API](https://github.com/VROOM-Project/vroom/blob/master/docs/API.md).

## Validation

- TypeScript and targeted ESLint.
- Routing unit tests covering optimizer ordering, fixed destination, coordinate reuse, low-confidence warnings, per-ceiling error messages, malformed optimizer/directions responses, and previews saved before the map existed.
- Integration tests for custom-only and mixed routes, BOL handling, sequence changes, and stale-review dispatch rejection.
- Isolated local Postgres migration and browser review using demonstration data.
