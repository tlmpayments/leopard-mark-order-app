/**
 * City region -> delivery region.
 *
 * The Customer Accounts tab records where an account *is* — "San Francisco",
 * "Orange County", "North Bay" — while deliveries run on two routes out of two
 * sets of warehouses, which `RouteSchedule` keys as `BA` and `LA`. Those two
 * vocabularies never matched, so every account failed the "region → warehouse"
 * setup check and `auto_propose_slot` had no route day to offer: nothing could
 * reach stage ③ on its own.
 *
 * The mapping lives here, in between, rather than by rewriting either side:
 *
 *   - Rewriting `Account.region` to "BA" would be undone by the next run of
 *     scripts/import-customer-accounts.ts, which reads the city back from the
 *     tab. Worse, §5 makes Region a bidirectional DB-owned column, so a DB→Sheet
 *     write would push "BA" into the spreadsheet and destroy the city data
 *     there — losing information the sales team actually uses.
 *   - Adding a RouteSchedule row per city would say the business runs nine
 *     routes. It runs two.
 *
 * So the account keeps its city, the schedule keeps its two regions, and this
 * function is the single place that relates them. Add a city here when the
 * business opens one; the alternative (guessing from the string) would quietly
 * mis-route a new city the first time someone typed it.
 */

/** The delivery regions `RouteSchedule` is keyed by. */
export type DeliveryRegion = "BA" | "LA";

/**
 * Every region string seen in the live Customer Accounts tab and the rep app's
 * legacy LM_REP_REGIONS map, with the count observed at time of writing.
 *
 * San Diego is the one judgement call: it is 120 miles from Wilmington and
 * arguably deserves its own route, but WH-WIL is the only warehouse that serves
 * Southern California today, so it rides the LA route. Three accounts. If that
 * is wrong it is a one-line change here, not a data migration.
 */
const CITY_TO_DELIVERY_REGION: Record<string, DeliveryRegion> = {
  // ---- Bay Area, served by WH-SF and WH-BEN ----
  "san francisco": "BA", // 52
  "north bay": "BA", // 14
  "south san francisco": "BA", // 2
  "san rafael": "BA", // 1
  burlingame: "BA", // 1
  oakland: "BA",
  berkeley: "BA",
  "east bay": "BA",
  "sf/bay": "BA", // legacy LM_REP_REGIONS
  sf: "BA",
  "bay area": "BA",

  // ---- Southern California, served by WH-WIL ----
  "los angeles": "LA", // 18
  "orange county": "LA", // 11
  "long beach": "LA", // 9
  arcadia: "LA", // 1
  "san diego": "LA", // 3 — see the note above
  la: "LA",
  socal: "LA",
};

/**
 * Resolve a region string to the delivery region whose route days apply.
 *
 * Returns null rather than a default when the region is blank or unrecognised.
 * A default would make the setup checklist pass for an account nobody can
 * actually deliver to, and would have the slot proposer book it onto a truck
 * that does not go there — both silent, both worse than an unmet check.
 */
export function deliveryRegionFor(region: string | null | undefined): DeliveryRegion | null {
  const key = (region ?? "").trim().toLowerCase();
  if (!key) return null;
  // Already canonical.
  if (key === "ba" || key === "la") return key.toUpperCase() as DeliveryRegion;
  return CITY_TO_DELIVERY_REGION[key] ?? null;
}

/** The city regions that map to a given delivery region. For settings display. */
export function citiesInDeliveryRegion(target: DeliveryRegion): string[] {
  return Object.entries(CITY_TO_DELIVERY_REGION)
    .filter(([, r]) => r === target)
    .map(([city]) => city);
}

/** Every region string this mapping knows, for reporting what is unmapped. */
export function knownRegionKeys(): string[] {
  return Object.keys(CITY_TO_DELIVERY_REGION);
}
