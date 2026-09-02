/**
 * Stock, netted from the event ledger on read.
 *
 * Postgres is now the system of record for Leopard Mark's own stock (§2 rule
 * 2), replacing the Inventory app's "Inventory Ledger" tab. The netting rules
 * below are a deliberate reimplementation of that app's `computeStock()`, sign
 * for sign, because the migration has to prove parity SKU by SKU before the old
 * dashboard is retired (§4 step 7). Change these rules and that proof breaks.
 *
 * `qty` on an InventoryEvent is always a positive integer; the direction is
 * implied by the event type and which location fields are set.
 */

import type { InventoryEventType } from "@/app/generated/prisma/enums";
import { db } from "@/lib/db";

/**
 * How each event type moves stock.
 *   - `credit_to`: stock appears at toLocation (it came from outside).
 *   - `debit_from`: stock leaves fromLocation and is gone (a sink).
 *   - `move`: leaves fromLocation and arrives at toLocation.
 *
 * ADJUSTMENT is `move` so one mechanism covers every correction: to reverse a
 * mistaken DELIVERY you write an ADJUSTMENT crediting the location it left,
 * and to reverse a mistaken TRANSFER you write one with the ends swapped. A
 * null location on either side simply means that end is untracked, exactly as
 * the legacy `add()` no-opped on a blank location.
 */
export const INVENTORY_DIRECTION: Record<InventoryEventType, "credit_to" | "debit_from" | "move"> = {
  BREW: "credit_to",
  INCOMING: "credit_to",
  DELIVERY: "debit_from",
  SAMPLE: "debit_from",
  DESTRUCTION: "debit_from",
  LOSS: "debit_from",
  TRANSFER: "move",
  RETURN: "move",
  ADJUSTMENT: "move",
};

/** The four types that consume stock without it arriving anywhere we track. */
export const SINK_TYPES: readonly InventoryEventType[] = ["DELIVERY", "SAMPLE", "DESTRUCTION", "LOSS"];
/** The two types that create stock from outside the network. */
export const SOURCE_TYPES: readonly InventoryEventType[] = ["BREW", "INCOMING"];
/** The types that mint a BOL when they produce a shipment. */
export const BOL_TYPES: readonly InventoryEventType[] = ["TRANSFER", "DELIVERY", "INCOMING", "RETURN"];

export interface NettableEvent {
  type: InventoryEventType;
  productId: string;
  qty: number;
  fromLocationId?: string | null;
  toLocationId?: string | null;
}

export type StockKey = string;
export const stockKey = (productId: string, locationId: string): StockKey =>
  `${productId}||${locationId}`;

/**
 * Net a batch of events into per-(product, location) quantities. Pure, so the
 * parity script can run it over the imported ledger and diff the result
 * against what the old dashboard reports today.
 */
export function netStock(events: readonly NettableEvent[]): Map<StockKey, number> {
  const out = new Map<StockKey, number>();
  const add = (productId: string, locationId: string | null | undefined, delta: number) => {
    if (!locationId) return; // untracked end -- same as the legacy no-op
    const k = stockKey(productId, locationId);
    out.set(k, (out.get(k) ?? 0) + delta);
  };

  for (const e of events) {
    switch (INVENTORY_DIRECTION[e.type]) {
      case "credit_to":
        add(e.productId, e.toLocationId, e.qty);
        break;
      case "debit_from":
        add(e.productId, e.fromLocationId, -e.qty);
        break;
      case "move":
        add(e.productId, e.fromLocationId, -e.qty);
        add(e.productId, e.toLocationId, e.qty);
        break;
    }
  }
  return out;
}

export interface StockRow {
  productId: string;
  skuCode: string;
  productName: string;
  formatLabel: string;
  locationId: string;
  locationName: string;
  locationType: "brewery" | "warehouse";
  onHand: number;
}

/**
 * On-hand stock per (product, location), read from the `stock_by_location`
 * view. The view exists so this is one indexed aggregate rather than streaming
 * the whole ledger into Node on every page load; §4 says to materialise it
 * only if it exceeds ~200ms at real volume, which at a few thousand events it
 * does not.
 */
export async function stockByLocation(): Promise<StockRow[]> {
  return db.$queryRaw<StockRow[]>`
    SELECT s."product_id"    AS "productId",
           p."sku_code"      AS "skuCode",
           p."product_name"  AS "productName",
           p."format_label"  AS "formatLabel",
           s."location_id"   AS "locationId",
           l."name"          AS "locationName",
           l."type"::text    AS "locationType",
           s."on_hand"::int  AS "onHand"
    FROM "stock_by_location" s
    JOIN "products" p ON p."id" = s."product_id"
    JOIN "locations" l ON l."id" = s."location_id"
    WHERE s."on_hand" <> 0
    ORDER BY p."sku_code", l."id"
  `;
}

/**
 * Units already promised to scheduled-but-undelivered orders, per
 * (product, warehouse). This is what turns "on hand" into "actually sellable":
 * two kegs on the shelf that are both on tomorrow's truck are not available.
 *
 * Deliberately a soft, informational reservation (§3 ④) -- it does not lock
 * rows or block anything by itself; the stock check reads it and blocks.
 */
export async function reservedByScheduledOrders(): Promise<Map<StockKey, number>> {
  const rows = await db.$queryRaw<Array<{ productId: string; locationId: string; qty: number }>>`
    SELECT ol."product_id"        AS "productId",
           o."inventory_source"   AS "locationId",
           SUM(ol."qty")::int     AS "qty"
    FROM "orders" o
    JOIN "order_lines" ol ON ol."order_id" = o."id"
    WHERE o."scheduled_for" IS NOT NULL
      AND o."delivered_at" IS NULL
      AND o."status" NOT IN ('cancelled', 'rejected', 'expired')
      AND o."inventory_source" IS NOT NULL
    GROUP BY ol."product_id", o."inventory_source"
  `;
  return new Map(rows.map((r) => [stockKey(r.productId, r.locationId), r.qty]));
}

export interface AvailabilityRow extends StockRow {
  reserved: number;
  available: number;
  reorderThreshold: number | null;
  belowThreshold: boolean;
}

/**
 * "Available for delivery" -- warehouses only, minus scheduled reservations.
 *
 * Warehouse-only is not a UI nicety: stock sitting at a contract brewery has
 * not been received into our custody yet, and promising it to an account is how
 * you end up with a truck at a dock and nothing to load.
 */
export async function availableForDelivery(): Promise<AvailabilityRow[]> {
  const [stock, reserved, products] = await Promise.all([
    stockByLocation(),
    reservedByScheduledOrders(),
    db.product.findMany({ select: { id: true, reorderThreshold: true } }),
  ]);
  const thresholds = new Map(products.map((p) => [p.id, p.reorderThreshold]));

  return stock
    .filter((r) => r.locationType === "warehouse")
    .map((r) => {
      const res = reserved.get(stockKey(r.productId, r.locationId)) ?? 0;
      const available = r.onHand - res;
      const threshold = thresholds.get(r.productId) ?? null;
      return {
        ...r,
        reserved: res,
        available,
        reorderThreshold: threshold,
        belowThreshold: threshold != null && threshold > 0 && available <= threshold,
      };
    });
}

/**
 * Can this warehouse fill these lines right now? Used by the stock check on
 * order confirmation, which blocks with `stock_short` rather than silently
 * accepting an order nobody can fulfil.
 */
export interface ShortLine {
  productId: string;
  skuCode: string;
  wanted: number;
  available: number;
}

export async function checkAvailability(
  locationId: string,
  lines: Array<{ productId: string; qty: number }>,
): Promise<ShortLine[]> {
  const rows = await availableForDelivery();
  const byKey = new Map(rows.map((r) => [stockKey(r.productId, r.locationId), r]));
  const shorts: ShortLine[] = [];

  for (const line of lines) {
    const row = byKey.get(stockKey(line.productId, locationId));
    const available = row?.available ?? 0;
    if (available < line.qty) {
      shorts.push({
        productId: line.productId,
        skuCode: row?.skuCode ?? line.productId,
        wanted: line.qty,
        available,
      });
    }
  }
  return shorts;
}

export interface KegCustodyBalance {
  accountId: string;
  businessName: string;
  productId: string;
  skuCode: string;
  balance: number;
  depositExposure: number;
  lastMovementAt: Date | null;
}

/**
 * Kegs currently in a customer's hands, and what we are exposed for.
 *
 * This is the gap the Inventory app's README names outright ("keg
 * deposit/custody balances by customer account are not tracked yet"). Balance
 * is SUM(delta) over the append-only custody ledger; exposure multiplies by the
 * SKU's deposit amount, which is $35 on 1/2 and 1/6 bbl per INV26277.
 */
export async function kegCustodyBalances(): Promise<KegCustodyBalance[]> {
  return db.$queryRaw<KegCustodyBalance[]>`
    SELECT k."account_id"                                        AS "accountId",
           a."business_name"                                     AS "businessName",
           k."product_id"                                        AS "productId",
           p."sku_code"                                          AS "skuCode",
           SUM(k."delta")::int                                   AS "balance",
           (SUM(k."delta") * COALESCE(p."deposit_amount", 0))::float8 AS "depositExposure",
           MAX(k."occurred_at")                                  AS "lastMovementAt"
    FROM "keg_custody_entries" k
    JOIN "accounts" a ON a."id" = k."account_id"
    JOIN "products" p ON p."id" = k."product_id"
    GROUP BY k."account_id", a."business_name", k."product_id", p."sku_code", p."deposit_amount"
    HAVING SUM(k."delta") <> 0
    ORDER BY SUM(k."delta") DESC
  `;
}
