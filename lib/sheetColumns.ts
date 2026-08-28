// Column ownership for the Sheet <-> Postgres sync (Phase 2). This is the
// single source of truth both `lib/sheetSync.ts` (DB -> Sheet) and
// `app/api/sheet-sync/webhook/route.ts` (Sheet -> DB) consult -- the only
// place either file should hardcode a Sheet column header string against an
// ownership decision. See
// /Users/jackbegley/.claude/plans/jazzy-pondering-rivest.md ("Sheet sync
// architecture" / corrected "Ownership split") for the design rationale,
// and prisma/schema.prisma's Order model comments for why Invoice Status и
// Notes behave like ordinary Sheet-owned columns from this classifier's
// point of view even though they start life as a one-time DB write.
//
// No field is writable from both directions at the same point in time.

// DB-owned: Postgres decides these. A Sheet edit to one of these is a
// CONFLICT -- never applied, always logged. (Re-syncing the correct DB value
// onto the Sheet to correct the conflicting cell is the DB -> Sheet path's
// job, triggered elsewhere -- this module only classifies.)
export const DB_OWNED_COLUMNS = [
  "Customer",
  "License Number",
  "PO Date",
  "Product Name",
  "Packaging Format",
  "Product Code",
  "Qty",
  "Price (ea)",
  "Line Total",
  "Sales Rep",
  "Invoice #",
  "Order ID",
  "Inventory Source",
  "Payment Method",
] as const;

// Sheet-owned: ops fills these in after order creation; a Sheet edit to one
// of these is always allowed to sync Sheet -> DB.
export const SHEET_OWNED_COLUMNS = [
  "Delivery (Invoice) Date",
  "Lot #",
  "BOL #",
  "ACH Invoice REF #",
  "Invoice Status",
  "TLM Tap Handle",
  "SGB Tap Handle",
  "CNT Tap Handle",
  "MicroStar 1/2 Empty",
  "MicroStar 1/6 Empty",
  "Notes",
] as const;

export type DbOwnedColumn = (typeof DB_OWNED_COLUMNS)[number];
export type SheetOwnedColumn = (typeof SHEET_OWNED_COLUMNS)[number];

const DB_OWNED_SET: ReadonlySet<string> = new Set(DB_OWNED_COLUMNS);
const SHEET_OWNED_SET: ReadonlySet<string> = new Set(SHEET_OWNED_COLUMNS);

export type ColumnOwnership = "sheet_owned" | "db_owned" | "unknown";

// Exact-match against the Sheet's literal header text -- the wire protocol
// guarantees a `fields` key IS that literal text, so no fuzzy matching
// belongs here (findColFuzzy-style header resolution is Code.gs's own
// concern when it turns a header into a column index on its side, not this
// classifier's). Callers must treat 'unknown' the same as 'db_owned' (never
// silently accept a column this design didn't account for) -- kept as a
// distinct return value here purely so callers can log which case actually
// happened.
export function classifyColumn(header: string): ColumnOwnership {
  const trimmed = String(header ?? "").trim();
  if (SHEET_OWNED_SET.has(trimmed)) return "sheet_owned";
  if (DB_OWNED_SET.has(trimmed)) return "db_owned";
  return "unknown";
}

// Of the 11 Sheet-owned columns, only these five have a backing scalar field
// on `orders` today (prisma/schema.prisma). The other six Sheet-owned
// columns are the tap-handle columns, the two MicroStar Empty columns, and
// `Lot #` (handled separately below, since it lives on OrderLine, not
// Order). TLM/SGB/CNT Tap Handle and the two MicroStar Empty columns are
// legitimately Sheet-owned (ops-editable, never a content conflict) but
// Phase 1's schema has no column for them yet -- there is nothing in
// `orders`/`order_lines` to write them into. The webhook logs these as
// accepted, non-conflicting syncs for audit (see route.ts's "unmapped"
// bucket) without attempting a write, rather than either inventing a schema
// change unilaterally (schema.prisma is shared with every other Phase 2+
// agent building against this same design) or misclassifying them as
// conflicts (they are not DB-owned, so that would be wrong too).
export type OrderScalarField =
  | "deliveryDate"
  | "bolNumber"
  | "achRef"
  | "invoiceStatus"
  | "notes";

export const SHEET_OWNED_ORDER_FIELD: Partial<
  Record<SheetOwnedColumn, OrderScalarField>
> = {
  "Delivery (Invoice) Date": "deliveryDate",
  "BOL #": "bolNumber",
  "ACH Invoice REF #": "achRef",
  "Invoice Status": "invoiceStatus",
  Notes: "notes",
};

// Lot # is the one Sheet-owned column that lives on OrderLine, not Order
// (prisma/schema.prisma). The Sheet -> DB payload here is order-level, not
// per-line, so a single "Lot #" edit can't say which of an order's lines it
// was meant for. Simplest correct policy for this phase: apply it to ALL of
// that order's lines -- a real order's lines usually share one BOL/lot in
// practice, per Code.gs's existing `nextBolNumber` design (one BOL per
// order, not per line). Flip this to a per-line design only if ops
// experience shows orders routinely need distinct lot numbers per line.
export const LOT_NUMBER_COLUMN: SheetOwnedColumn = "Lot #";
