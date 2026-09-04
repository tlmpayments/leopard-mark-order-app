/**
 * Stage ⑤: marking a delivery complete.
 *
 * This is the most consequential write in the system, and the reason stage ⑤
 * exists at all. In one atomic step it:
 *   - mints the real sequential BOL number,
 *   - writes one DELIVERY inventory event per line (stock leaves the warehouse),
 *   - writes RETURN events and negative custody entries for empties picked up,
 *   - moves keg custody onto the account,
 *   - stamps deliveredAt, which is what the invoice's Net-30 due date counts
 *     from (Cal. B&P § 25509 — "Net 30 from delivery"),
 *   - and enqueues the invoice.
 *
 * All of it in one transaction. A partial version of this is the worst possible
 * state: stock gone with no BOL, or a BOL issued against stock still on the
 * books, or an invoice with a due date counted from nothing.
 */

import { Prisma } from "@/app/generated/prisma/client";
import { db } from "@/lib/db";
import { mintBolNumber } from "@/lib/bol/sequence";
import { appendOrderEvent } from "@/lib/orderEvents";
import { enqueue } from "@/lib/jobs/queue";
import { isAutomationEnabled } from "@/lib/automations";
import type { OrderEventActor } from "@/app/generated/prisma/enums";

export interface DeliveredLineInput {
  orderLineId: string;
  /** Actual quantity delivered, if it differs from what was ordered. */
  actualQty?: number;
  lotNumber?: string | null;
}

export interface MarkDeliveredInput {
  orderId: string;
  deliveredAt?: Date;
  /** Who physically delivered it. */
  deliveredByUserId: string;
  actor: OrderEventActor;
  lines?: DeliveredLineInput[];
  /** Empty kegs collected at the door, by product. */
  emptiesByProductId?: Record<string, number>;
  carrierName?: string | null;
  notes?: string | null;
}

export interface MarkDeliveredResult {
  bolNumber: string;
  shipmentId: string;
  inventoryEventCount: number;
  custodyDelta: number;
  invoiceEnqueued: boolean;
}

export async function markDelivered(input: MarkDeliveredInput): Promise<MarkDeliveredResult> {
  const deliveredAt = input.deliveredAt ?? new Date();

  const result = await db.$transaction(
    async (tx) => {
      const order = await tx.order.findUniqueOrThrow({
        where: { id: input.orderId },
        include: {
          lines: { include: { product: true }, orderBy: { lineIndex: "asc" } },
          shipment: true,
          account: { select: { id: true, businessName: true } },
        },
      });

      // Idempotent: a double-tap on a phone in a warehouse is not a
      // hypothetical, and the second tap must not mint a second BOL.
      if (order.deliveredAt && order.shipment?.bolNumber) {
        return {
          bolNumber: order.shipment.bolNumber,
          shipmentId: order.shipment.id,
          inventoryEventCount: 0,
          custodyDelta: 0,
          alreadyDelivered: true as const,
        };
      }

      const fromLocationId = order.shipment?.fromLocationId ?? order.inventorySource;
      if (!fromLocationId) {
        throw new Error(
          `Order ${order.id} has no inventory source, so there is no warehouse to take the stock out of.`,
        );
      }

      const bolNumber = await mintBolNumber(tx, fromLocationId, deliveredAt);

      const shipment = order.shipment
        ? await tx.shipment.update({
            where: { id: order.shipment.id },
            data: {
              status: "delivered",
              deliveredAt,
              deliveredByUserId: input.deliveredByUserId,
              bolNumber,
              carrierName: input.carrierName ?? order.shipment.carrierName,
              notes: input.notes ?? order.shipment.notes,
              emptiesPickedUp: sumValues(input.emptiesByProductId),
            },
          })
        : await tx.shipment.create({
            data: {
              status: "delivered",
              type: "DELIVERY",
              fromLocationId,
              accountId: order.accountId,
              orderId: order.id,
              scheduledFor: order.scheduledFor,
              deliveredAt,
              deliveredByUserId: input.deliveredByUserId,
              bolNumber,
              docType: "delivery_receipt",
              carrierName: input.carrierName ?? null,
              notes: input.notes ?? null,
              emptiesPickedUp: sumValues(input.emptiesByProductId),
              weightLbs: computeWeight(order.lines),
              handlingUnits: order.lines.reduce((s, l) => s + l.qty, 0),
            },
          });

      const overrides = new Map((input.lines ?? []).map((l) => [l.orderLineId, l]));

      // ---- DELIVERY events: stock leaves the warehouse ----
      const events: Prisma.InventoryEventCreateManyInput[] = [];
      const custody: Prisma.KegCustodyEntryCreateManyInput[] = [];

      for (const line of order.lines) {
        const o = overrides.get(line.id);
        const qty = o?.actualQty ?? line.qty;
        if (qty <= 0) continue;

        events.push({
          occurredAt: deliveredAt,
          type: "DELIVERY",
          productId: line.productId,
          qty,
          fromLocationId,
          accountId: order.accountId,
          orderLineId: line.id,
          shipmentId: shipment.id,
          lotNumber: o?.lotNumber ?? line.lotNumber ?? null,
          actorUserId: input.deliveredByUserId,
          refNote: bolNumber,
        });

        // A delivered keg is now in the customer's hands and we are exposed for
        // its deposit until it comes back.
        if (line.product.isKeg) {
          custody.push({
            accountId: order.accountId,
            productId: line.productId,
            delta: qty,
            shipmentId: shipment.id,
            occurredAt: deliveredAt,
          });
        }

        // Persist a corrected quantity or a lot number back onto the line so
        // the invoice bills what was actually delivered, not what was ordered.
        if (o && (o.actualQty != null || o.lotNumber != null)) {
          await tx.orderLine.update({
            where: { id: line.id },
            data: {
              qty: o.actualQty ?? line.qty,
              lineTotal:
                o.actualQty != null
                  ? new Prisma.Decimal(o.actualQty).mul(line.unitPrice)
                  : line.lineTotal,
              lotNumber: o.lotNumber ?? line.lotNumber,
            },
          });
        }
      }

      // ---- RETURN events: empties come back off the truck ----
      for (const [productId, qty] of Object.entries(input.emptiesByProductId ?? {})) {
        if (!qty || qty <= 0) continue;
        events.push({
          occurredAt: deliveredAt,
          type: "RETURN",
          productId,
          qty,
          // A returned empty travels from the account back into the warehouse.
          // accountId records whose it was; toLocation is where it landed.
          toLocationId: fromLocationId,
          accountId: order.accountId,
          shipmentId: shipment.id,
          actorUserId: input.deliveredByUserId,
          refNote: bolNumber,
        });
        custody.push({
          accountId: order.accountId,
          productId,
          delta: -qty,
          shipmentId: shipment.id,
          occurredAt: deliveredAt,
        });
      }

      if (events.length) await tx.inventoryEvent.createMany({ data: events });
      if (custody.length) await tx.kegCustodyEntry.createMany({ data: custody });

      await tx.order.update({
        where: { id: order.id },
        data: {
          deliveredAt,
          deliveryDate: deliveredAt,
          bolNumber,
          status: "fulfilled",
        },
      });

      await appendOrderEvent(
        {
          orderId: order.id,
          eventType: "shipment.delivered",
          actor: input.actor,
          payload: { bolNumber, deliveredAt: deliveredAt.toISOString(), byUserId: input.deliveredByUserId },
        },
        tx,
      );
      await appendOrderEvent(
        { orderId: order.id, eventType: "bol.issued", actor: "system", payload: { bolNumber, fromLocationId } },
        tx,
      );
      await appendOrderEvent(
        {
          orderId: order.id,
          eventType: "inventory.events_written",
          actor: "system",
          payload: {
            deliveryEvents: events.filter((e) => e.type === "DELIVERY").length,
            returnEvents: events.filter((e) => e.type === "RETURN").length,
            custodyDelta: custody.reduce((s, c) => s + c.delta, 0),
          },
        },
        tx,
      );

      return {
        bolNumber,
        shipmentId: shipment.id,
        inventoryEventCount: events.length,
        custodyDelta: custody.reduce((s, c) => s + c.delta, 0),
        alreadyDelivered: false as const,
      };
    },
    // The BOL mint takes a row lock; give the transaction room to wait for it
    // when several deliveries are marked at once.
    { timeout: 15_000 },
  );

  if (result.alreadyDelivered) {
    return { ...result, invoiceEnqueued: false };
  }

  // ---- Enqueued OUTSIDE the transaction ----
  // The ledger write must commit whether or not Stripe is reachable. Enqueuing
  // inside the transaction would mean a queue write failure rolls back a
  // delivery that physically happened.
  let invoiceEnqueued = false;
  if (await isAutomationEnabled("auto_invoice_on_delivery")) {
    const { created } = await enqueue("issue_invoice", input.orderId, { orderId: input.orderId }, {
      orderId: input.orderId,
    });
    invoiceEnqueued = created;
  }

  // Mirror the delivery facts to the Sheet: Delivery Date, BOL #, Lot #,
  // empties. Also a job, for the same reason — a Sheet outage must never fail
  // a warehouse action (§2 rule 3).
  await enqueue("write_delivery_to_sheet", input.orderId, { orderId: input.orderId }, { orderId: input.orderId });

  return { ...result, invoiceEnqueued };
}

function sumValues(rec: Record<string, number> | undefined): number | null {
  if (!rec) return null;
  const total = Object.values(rec).reduce((s, n) => s + (n || 0), 0);
  return total || null;
}

/** Total shipment weight from each SKU's weightPerUnit (§8.3). */
function computeWeight(
  lines: Array<{ qty: number; product: { weightPerUnit: Prisma.Decimal | null } }>,
): Prisma.Decimal | null {
  const known = lines.filter((l) => l.product.weightPerUnit != null);
  if (known.length === 0) return null;
  return known.reduce(
    (sum, l) => sum.add(new Prisma.Decimal(l.qty).mul(l.product.weightPerUnit!)),
    new Prisma.Decimal(0),
  );
}
