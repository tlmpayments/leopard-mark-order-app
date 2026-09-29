// Read-only data for the customer portal (/customer). Every query is scoped to
// ONE accountId taken from the signed-in customer's session -- never from a
// URL or form field -- so a customer can only ever see their own account.
// Nothing here writes.
import { db } from "@/lib/db";
import { toNumber } from "@/lib/ops/format";

// Orders that represent real commitments. Drafts and dead orders would inflate
// "total units / total dollars" with things the customer never received.
const COUNTED_STATUSES = ["confirmed", "scheduled", "fulfilled"] as const;

// Stripe invoice statuses a customer should see. `draft` is not yet issued and
// `local_error` is our own failure marker; `void` is cancelled.
const VISIBLE_INVOICE_STATUSES = ["open", "paid", "uncollectible"];

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const UNDATED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface PortalOrder {
  id: string;
  invoiceNumber: string | null;
  placedAt: Date | null;
  deliveredAt: Date | null;
  total: number;
  units: number;
  invoiceStatus: string | null;
  amountDue: number | null;
  amountPaid: number | null;
  dueDate: Date | null;
  hostedInvoiceUrl: string | null;
}

export interface UpcomingDelivery {
  orderId: string;
  invoiceNumber: string | null;
  date: Date | null;
  /** true when `date` is a bare route day (UTC midnight), not an instant */
  dateOnly: boolean;
  scheduled: boolean;
  items: { name: string; qty: number }[];
}

export interface PortalData {
  account: {
    businessName: string;
    terms: string | null;
    deliveryAddress: string | null;
    hasPaymentMethod: boolean;
    creditHold: boolean;
    salesRepName: string | null;
  };
  totals: { orders: number; units: number; dollars: number };
  billing: { outstanding: number; overdue: number; overdueCount: number };
  upcoming: UpcomingDelivery[];
  orders: PortalOrder[];
}

export async function getPortalData(accountId: string): Promise<PortalData | null> {
  const account = await db.account.findUnique({
    where: { id: accountId },
    select: {
      businessName: true,
      terms: true,
      deliveryAddress: true,
      creditHold: true,
      stripeDefaultPaymentMethod: true,
      salesRep: { select: { name: true } },
    },
  });
  if (!account) return null;

  const orders = await db.order.findMany({
    where: { accountId, status: { in: [...COUNTED_STATUSES] } },
    orderBy: [{ submittedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      invoiceNumber: true,
      submittedAt: true,
      createdAt: true,
      deliveredAt: true,
      deliveryDate: true,
      scheduledFor: true,
      lines: {
        orderBy: { lineIndex: "asc" },
        select: { qty: true, lineTotal: true, product: { select: { productName: true } } },
      },
      invoice: {
        select: {
          status: true,
          amountDue: true,
          amountPaid: true,
          dueDate: true,
          hostedInvoiceUrl: true,
        },
      },
      routeStop: {
        select: { status: true, route: { select: { date: true, status: true } } },
      },
    },
  });

  const now = new Date();
  const portalOrders: PortalOrder[] = [];
  const upcoming: UpcomingDelivery[] = [];
  let outstanding = 0;
  let overdue = 0;
  let overdueCount = 0;

  for (const o of orders) {
    const units = o.lines.reduce((s, l) => s + l.qty, 0);
    const total = o.lines.reduce((s, l) => s + toNumber(l.lineTotal), 0);
    const inv = o.invoice && VISIBLE_INVOICE_STATUSES.includes(o.invoice.status) ? o.invoice : null;

    portalOrders.push({
      id: o.id,
      invoiceNumber: o.invoiceNumber,
      placedAt: o.submittedAt ?? o.createdAt,
      deliveredAt: o.deliveredAt,
      total,
      units,
      invoiceStatus: inv?.status ?? null,
      amountDue: inv ? toNumber(inv.amountDue) : null,
      amountPaid: inv ? toNumber(inv.amountPaid) : null,
      dueDate: inv?.dueDate ?? null,
      hostedInvoiceUrl: inv?.hostedInvoiceUrl ?? null,
    });

    if (inv && inv.status !== "paid") {
      const balance = Math.max(toNumber(inv.amountDue) - toNumber(inv.amountPaid), 0);
      outstanding += balance;
      if (inv.dueDate && inv.dueDate < now) {
        overdue += balance;
        overdueCount += 1;
      }
    }

    // Not yet delivered. A stop on a draft route is Danny still planning, so it
    // shows as "being scheduled" rather than leaking a date that may change.
    if (!o.deliveredAt && o.routeStop?.status !== "delivered") {
      const route = o.routeStop?.route;
      const confirmedRoute = route && route.status !== "draft" && route.status !== "cancelled";
      const date = confirmedRoute ? route.date : (o.scheduledFor ?? o.deliveryDate ?? null);
      // Sheet-imported history often has no deliveredAt. Without a guard those
      // old orders would read as "upcoming" forever, so only surface an order
      // whose date is still ahead (allowing a day of slip), or that has no
      // date yet but was placed recently.
      const placed = o.submittedAt ?? o.createdAt;
      const fresh = date
        ? date.getTime() >= now.getTime() - STALE_AFTER_MS
        : now.getTime() - placed.getTime() <= UNDATED_WINDOW_MS;
      if (fresh) {
        upcoming.push({
          orderId: o.id,
          invoiceNumber: o.invoiceNumber,
          date,
          dateOnly: Boolean(confirmedRoute),
          scheduled: date !== null,
          items: o.lines.map((l) => ({ name: l.product.productName, qty: l.qty })),
        });
      }
    }
  }

  upcoming.sort((a, b) => (a.date?.getTime() ?? Infinity) - (b.date?.getTime() ?? Infinity));

  return {
    account: {
      businessName: account.businessName,
      terms: account.terms,
      deliveryAddress: account.deliveryAddress,
      hasPaymentMethod: Boolean(account.stripeDefaultPaymentMethod),
      creditHold: account.creditHold,
      salesRepName: account.salesRep?.name ?? null,
    },
    totals: {
      orders: portalOrders.length,
      units: portalOrders.reduce((s, o) => s + o.units, 0),
      dollars: portalOrders.reduce((s, o) => s + o.total, 0),
    },
    billing: { outstanding, overdue, overdueCount },
    upcoming,
    orders: portalOrders,
  };
}
