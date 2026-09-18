# Wilmington delivery builder

The Deliveries board is scoped to LA orders and routes from WH-WIL. Its count includes orders scheduled for the selected day and unscheduled orders, excludes orders already on routes, and is no longer truncated at 200 before region filtering.

Build Delivery automatically assigns the active WH-WIL warehouse and the single active driver whose first name is Jose (accented José is supported). Existing draft routes with another warehouse/driver must be replaced with a new delivery to use Push to Driver.

The builder supports order stops, account visits found by server-side search, and custom stops with a name and full street address. Non-order stops never create shipments, invoices, or inventory movements. They share the same stop sequence and driver completion flow as order stops. BOL printing skips non-order stops.

## Configuration before deployment

- Apply the migration `20260914000000_delivery_builder` and regenerate Prisma before deploying the application. The migration adds nullable order IDs, custom destination fields, and a persisted routing review.
- Set the actual street address of WH-WIL in Settings. The city-centre seed coordinates are deliberately not used as a warehouse location.
- Ensure exactly one active driver named Jose or Jose followed by his surname has role `driver` and an existing driver sign-in.
- Configure `GOOGLE_ROUTES_API_KEY` on the server, restricted to the Google Routes API.
- Configure `NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY`, restricted to Maps Embed API and the application's authorized HTTP referrers. This is a browser-visible key. Enable billing and both APIs in the Google project. Set the public value before building.

Read-only configuration check found an active driver named Jose Arreola and an active WH-WIL warehouse with no street address saved.

No production migration or deployment is performed as part of local implementation. Do not use the isolated preview's demonstration warehouse address as the production address.

## Routing behavior

Optimize and Coordinate Path calls Google's Routes API from the server, fixes Wilmington as the origin, keeps the chosen final stop as the destination, and optimizes the intermediate stops. Moving a stop to the bottom changes the final destination. Arrows on a reviewed route preserve the operator's chosen sequence and recalculate drive times. A route supports 21 stops, matching the embedded map's 20 intermediate-waypoint limit.

The map is an interactive Google Maps directions embed reflecting the saved order. Reordering is done with the app's arrow controls; edits made in a separately opened Google Maps application do not sync back. The map and server estimates can differ due to traffic calculation timing. Times are driving minutes and arrival offsets from departure, excluding unloading/service times. No warehouse return leg is added.

Push to Driver validates the reviewed stop IDs, sequence, addresses, warehouse origin, and assigned driver, then invokes the existing transactional dispatch workflow. Custom stops need no BOL. Jose receives the route in delivery.tlmbg.co through the existing authenticated driver app; no SMS or email is sent. Drafts are hidden from drivers.

Official references: [waypoint optimization](https://developers.google.com/maps/documentation/routes/opt-way), [Maps Embed directions](https://developers.google.com/maps/documentation/embed/embedding-map).

## Validation

- TypeScript and targeted ESLint.
- 37 routing unit/integration tests, including Google response validation, missing configuration/addresses, custom-only and mixed routes, BOL handling, sequence changes, and stale-review dispatch rejection.
- Isolated local Postgres migration and browser review using demonstration data.
- Live Google calculation remains unverified until API keys are configured.
