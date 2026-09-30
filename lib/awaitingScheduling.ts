import type { Prisma } from "@/app/generated/prisma/client";

/**
 * Which orders are "awaiting delivery" -- the ones somebody still has to give
 * a delivery date.
 *
 * The rule, in the words it was given: an order needs scheduling if and only if
 * it has no delivery date. The Sales Distribution sheet carries that date in
 * its "Delivery (Invoice) Date" column, so a row with a date there is already
 * dealt with and a row without one is the queue.
 *
 * In the database that is four things together:
 *  - `scheduledFor` is empty (nobody has scheduled it here),
 *  - `deliveredAt` is empty (it has not been delivered),
 *  - `deliveryDate` is empty (the sheet has no delivery date for it either) --
 *    this is the one that keeps the imported order history out. Those rows
 *    were delivered long ago and have a date in the sheet; they just were
 *    never closed out here, and without this test they all read as "waiting",
 *  - and it is a live order, not a draft or a dead one.
 *
 * The invoice clause excludes rows that exist only because the sheet import
 * made a placeholder invoice for them ("sheet:..." ids), i.e. history.
 *
 * One definition, used by the Ops Hub's Incoming list and its sidebar count and
 * by the route builders, because these used to be written out separately and
 * the builder's copy quietly lacked `deliveryDate` -- which is why it offered
 * weeks-old orders.
 */
export const AWAITING_SCHEDULING_WHERE = {
  status: { notIn: ["cancelled", "rejected", "expired", "draft"] },
  scheduledFor: null,
  deliveredAt: null,
  deliveryDate: null,
  NOT: { invoice: { is: { stripeInvoiceId: { startsWith: "sheet:" } } } },
} satisfies Prisma.OrderWhereInput;
