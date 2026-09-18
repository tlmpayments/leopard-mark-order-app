/**
 * The marketing catalogue's vocabulary.
 *
 * Categories, brands and purposes live here rather than in the database
 * because all three are the *app's* lists: the rep app's filter chips, the ops
 * catalogue editor's dropdowns and the request form's "what is this for" are
 * all rendered from these, and a value that exists in one place and not the
 * others is a filter that silently hides stock.
 *
 * `MarketingItem.category` and `.brand` are plain strings in the schema on
 * purpose (see the comments there): an enum would make adding a brand a
 * migration, and marketing signs brands faster than we ship migrations. The
 * cost is that these arrays are the only thing keeping the values tidy, so
 * both the API and the ops editor validate against them.
 */

/** The Field Supply Board's ten, in its own order — this is the order the rep
 *  app groups by, so changing it reorders his screen. */
export const MARKETING_CATEGORIES = [
  "Sell Sheets",
  "Apparel & Accessories",
  "Banners & Signage",
  "Table & Event Displays",
  "Draft & On-Premise",
  "Logos & Brand Marks",
  "Photography",
  "Sales Decks",
  "Templates",
  "Other",
] as const;

export type MarketingCategory = (typeof MARKETING_CATEGORIES)[number];

/**
 * The three the board ships with. Not an enum, and not closed: the ops
 * catalogue editor offers these and accepts a typed-in fourth, which is how a
 * newly signed brand gets orderable the same afternoon.
 */
export const MARKETING_BRANDS = ["Cantinesca", "Sunlight Groove", "The Leopard Mark"] as const;

/**
 * Carried over verbatim from the rep app's LM_MARKETING_PURPOSES, which
 * mirrors the Master Tracker's Activity Type dropdown plus the two reasons a
 * rep orders that aren't campaign activities. Kept identical so a request
 * placed today still reconciles against the marketing calendar's vocabulary
 * after the Apps Script cutover.
 */
export const MARKETING_PURPOSES = [
  "Account Visit",
  "Launch",
  "Sampling",
  "Festival",
  "Giveaway",
  "Promo",
  "Sponsorship",
  "Content Drop",
  "Photo/Video Shoot",
  "Rep Field Kit / Restock",
  "Other",
] as const;

/** Units the editor suggests. Free text underneath — "case of 24" and "pack of
 *  250" are both already in use and neither is worth an enum. */
export const MARKETING_UNITS = [
  "each",
  "pack of 25",
  "pack of 250",
  "case of 24",
  "digital download",
] as const;

export function isCategory(value: string): value is MarketingCategory {
  return (MARKETING_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Sort key for a catalogue listing: category in the order above, then the
 * item's own sortOrder, then name. Used by both surfaces so the rep and the
 * ops editor see one order.
 */
export function categoryRank(category: string): number {
  const i = (MARKETING_CATEGORIES as readonly string[]).indexOf(category);
  return i === -1 ? MARKETING_CATEGORIES.length : i;
}
