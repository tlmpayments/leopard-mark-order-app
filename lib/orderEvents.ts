/**
 * Append-only order event log.
 *
 * §1.4 requires a complete, never-overwritten audit trail per order, and §2
 * rule 4 requires the hub to render "what happened and who did it" from this
 * table rather than reconstructing it from logs. Both mean the same thing in
 * practice: every stage transition and every automation side effect appends a
 * row here, and nothing ever updates one.
 */

import { Prisma } from "@/app/generated/prisma/client";
import type { OrderEventActor } from "@/app/generated/prisma/enums";
import { db } from "@/lib/db";
import type { OrderEventType } from "@/lib/pipeline";

export interface AppendOrderEventInput {
  orderId: string;
  eventType: OrderEventType;
  actor: OrderEventActor;
  /**
   * Before/after facts for the transition. Kept deliberately loose because it
   * is evidence, not an interface: the hub renders it as a detail blob and the
   * value of writing more is always higher than the cost.
   */
  payload?: Record<string, unknown>;
}

export async function appendOrderEvent(
  input: AppendOrderEventInput,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const client = tx ?? db;
  await client.orderEvent.create({
    data: {
      orderId: input.orderId,
      eventType: input.eventType,
      actor: input.actor,
      payloadJson: (input.payload ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/**
 * Block an order with a reason, appending the event that records it.
 *
 * Blocking and unblocking always travel with an event because §3 says a
 * compliance block is cleared by a human "and it's logged" -- if the clearing
 * were not logged there would be no way to answer who decided to sell to an
 * account with an expired license.
 */
export async function blockOrder(
  orderId: string,
  reason: string,
  actor: OrderEventActor,
  byUserId?: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const before = await tx.order.findUnique({
      where: { id: orderId },
      select: { blockedReason: true },
    });
    // Re-blocking for the same reason is a no-op, so a retrying stock check
    // doesn't fill the timeline with identical rows.
    if (before?.blockedReason === reason) return;

    await tx.order.update({
      where: { id: orderId },
      data: { blockedReason: reason, blockedAt: new Date(), blockedByUserId: byUserId ?? null },
    });
    await appendOrderEvent(
      {
        orderId,
        eventType: "order.blocked",
        actor,
        payload: { reason, previousReason: before?.blockedReason ?? null, ...detail },
      },
      tx,
    );
  });
}

export async function unblockOrder(
  orderId: string,
  actor: OrderEventActor,
  byUserId?: string,
  note?: string,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const before = await tx.order.findUnique({
      where: { id: orderId },
      select: { blockedReason: true },
    });
    if (!before?.blockedReason) return;

    await tx.order.update({
      where: { id: orderId },
      data: { blockedReason: null, blockedAt: null, blockedByUserId: null },
    });
    await appendOrderEvent(
      {
        orderId,
        eventType: "order.unblocked",
        actor,
        payload: { clearedReason: before.blockedReason, byUserId: byUserId ?? null, note: note ?? null },
      },
      tx,
    );
  });
}
