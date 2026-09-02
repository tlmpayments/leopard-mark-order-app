/**
 * The hub's read layer.
 *
 * Everything here reads from Postgres and derives; nothing writes. The
 * attention queue in particular is *computed* rather than stored, so it can
 * never drift out of sync with the facts it summarises — there is no "alerts"
 * table to go stale, which is the failure mode the prototype's empty ALERTS
 * array was heading for.
 */

import { db } from "@/lib/db";
import {
  PIPELINE_STAGES,
  STAGE_LABELS,
  BLOCKED_REASON_LABELS,
  isBlockedReason,
  pipelineStage,
  stageIndex,
  type PipelineStage,
  type PipelineStageResult,
} from "@/lib/pipeline";
import { accountChecklist } from "./checklist";
import { availableForDelivery, kegCustodyBalances } from "@/lib/inventory";
import { toNumber } from "./format";

/** The order shape every hub screen needs. One include, reused. */
const ORDER_INCLUDE = {
  account: {
    select: {
      id: true,
      businessName: true,
      region: true,
      billingContactEmail: true,
      licenseStatus: true,
      licenseExpiry: true,
      creditHold: true,
      terms: true,
      stripeDefaultPaymentMethod: true,
    },
  },
  salesRep: { select: { id: true, name: true } },
  contact: { select: { id: true, name: true, email: true } },
  lines: {
    orderBy: { lineIndex: "asc" },
    include: {
      product: {
        select: {
          id: true,
          skuCode: true,
          productName: true,
          formatLabel: true,
          isKeg: true,
          depositAmount: true,
          weightPerUnit: true,
          upc: true,
        },
      },
    },
  },
  invoice: true,
  shipment: true,
  // The latest slot proposal. Stage ③ (needs_scheduling) is defined by a
  // proposal existing and awaiting a human, and a proposal is an event rather
  // than a column -- it is a thing the system SAID, and the event log is where
  // those live. Without this include, pipelineStage() never sees a proposal
  // from a list query, so stage ③ would silently always render empty on the
  // board and the pipeline strip while the order detail page (which loads the
  // proposal separately) showed ③ correctly.
  events: {
    where: { eventType: "order.slot_proposed" },
    orderBy: { createdAt: "desc" },
    take: 1,
  },
} as const;

export type OpsOrder = Awaited<ReturnType<typeof loadOrders>>[number];

export async function loadOrders(where: Record<string, unknown> = {}) {
  return db.order.findMany({
    where,
    include: ORDER_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 500,
  });
}

export type StagedOrder = OpsOrder & { pipeline: PipelineStageResult; total: number; kegs: number };

/**
 * Attach the derived stage and money to each order. Done once, here, so no
 * screen recomputes it and no two screens can disagree.
 */
/** The proposed delivery date from the order's latest slot_proposed event. */
function proposedSlotAt(o: OpsOrder): Date | null {
  const ev = o.events?.[0];
  if (!ev) return null;
  const payload = ev.payloadJson as { proposedFor?: string } | null;
  if (!payload?.proposedFor) return null;
  const at = new Date(payload.proposedFor);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function stageOrders(orders: OpsOrder[]): StagedOrder[] {
  return orders.map((o) => ({
    ...o,
    pipeline: pipelineStage({
      status: o.status,
      createdAt: o.createdAt,
      submittedAt: o.submittedAt,
      confirmedAt: o.confirmedAt,
      scheduledFor: o.scheduledFor,
      deliveredAt: o.deliveredAt,
      blockedReason: o.blockedReason,
      blockedAt: o.blockedAt,
      proposedSlotAt: proposedSlotAt(o),
      invoice: o.invoice
        ? {
            status: o.invoice.status,
            sentAt: o.invoice.sentAt,
            paidAt: o.invoice.paidAt,
            createdAt: o.invoice.createdAt,
          }
        : null,
    }),
    total: o.lines.reduce((s, l) => s + toNumber(l.lineTotal), 0),
    kegs: o.lines.filter((l) => l.product.isKeg).reduce((s, l) => s + l.qty, 0),
  }));
}

export interface StageColumn {
  key: PipelineStage;
  label: string;
  index: number;
  count: number;
  value: number;
  blocked: number;
}

/**
 * The seven-column pipeline strip. Blocked orders are counted in the column of
 * the stage they are blocked AT, not in a column of their own — blocked is an
 * overlay (§3), and moving the card would lose the fact that a truck is booked.
 */
export function pipelineColumns(orders: StagedOrder[], accountSetupCount: number): StageColumn[] {
  return PIPELINE_STAGES.map((key, index) => {
    const inStage = orders.filter(
      (o) => o.pipeline.stage !== "cancelled" && stageIndex(o.pipeline) === index,
    );
    return {
      key,
      label: STAGE_LABELS[key],
      index,
      // ① is a count of accounts awaiting a first order, not of orders: by
      // definition nothing has been ordered yet.
      count: index === 0 ? accountSetupCount : inStage.length,
      value: inStage.reduce((s, o) => s + o.total, 0),
      blocked: inStage.filter((o) => o.pipeline.stage === "blocked").length,
    };
  });
}

export type Severity = "critical" | "serious" | "warn" | "info";

export interface AttentionItem {
  severity: Severity;
  /** What is wrong, in a sentence an operator can act on without clicking. */
  title: string;
  /** Short facts: what raised it, how old. */
  meta: string[];
  /** Exactly one person or team accountable. */
  owner: string;
  /** Exactly one primary action. */
  action: string;
  href: string;
  since: Date;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, serious: 1, warn: 2, info: 3 };

/**
 * The attention queue: everything that needs a human, ranked by consequence.
 *
 * This is the hub's first screen and its whole thesis — ops opens the app to
 * find out what needs *them*, not to read KPIs. So the ranking is by
 * consequence (a compliance block outranks a stale Sheet row), every item names
 * one owner, and every item offers one action. An item nobody owns is a bug.
 */
export async function attentionQueue(orders: StagedOrder[]): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  const now = new Date();

  // 1. Blocked orders. Compliance blocks are critical -- selling against an
  //    expired licence is a regulatory problem, not an inconvenience.
  for (const o of orders) {
    if (o.pipeline.stage !== "blocked" || !o.pipeline.blockedReason) continue;
    const reason = o.pipeline.blockedReason;
    const compliance = reason === "license_expired" || reason === "credit_hold";
    items.push({
      severity: compliance ? "critical" : "serious",
      title: `${o.account.businessName} — ${BLOCKED_REASON_LABELS[reason].toLowerCase()}, ${
        o.invoiceNumber ?? o.id
      } is blocked at ${STAGE_LABELS[o.pipeline.underlyingStage ?? "new_order"].toLowerCase()}`,
      meta: [compliance ? "Compliance gate" : "Blocked", `since ${o.pipeline.since.toISOString().slice(0, 10)}`],
      owner: compliance ? (o.salesRep?.name ?? "Ops") : "Ops",
      action: reason === "missing_billing_email" ? "Add email & send" : "Review",
      href: `/ops/orders/${o.id}`,
      since: o.pipeline.since,
    });
  }

  // 2. Invoices that failed to send. The customer has been delivered to and is
  //    not being billed, which is the most expensive silent failure here.
  const failedInvoices = await db.invoice.findMany({
    where: { status: "local_error" },
    include: { account: { select: { businessName: true } }, order: { select: { id: true, invoiceNumber: true } } },
    take: 25,
  });
  for (const inv of failedInvoices) {
    items.push({
      severity: "serious",
      title: `${inv.account.businessName} — delivered, but the invoice could not be sent`,
      meta: ["Stripe · issue_invoice", `${inv.invoiceNumber ?? inv.order.invoiceNumber ?? ""}`.trim()],
      owner: "Ops",
      action: "Fix & send",
      href: `/ops/orders/${inv.orderId}`,
      since: inv.updatedAt,
    });
  }

  // 3. Dead-lettered jobs. An automation gave up; nothing else will retry it.
  const deadJobs = await db.jobRun.findMany({
    where: { status: "dead" },
    orderBy: { finishedAt: "desc" },
    take: 25,
  });
  for (const job of deadJobs) {
    items.push({
      severity: "serious",
      title: `Automation gave up: ${job.kind} after ${job.attempts} attempts`,
      meta: ["Dead letter", job.lastError?.slice(0, 80) ?? ""],
      owner: "Ops",
      action: "Retry",
      href: "/ops/automations",
      since: job.finishedAt ?? job.createdAt,
    });
  }

  // 4. Stock shorts against what is already promised.
  const availability = await availableForDelivery();
  for (const row of availability.filter((r) => r.available < 0 || r.belowThreshold)) {
    items.push({
      severity: row.available < 0 ? "serious" : "warn",
      title:
        row.available < 0
          ? `${row.locationName} is oversold on ${row.skuCode} — ${row.reserved} promised, ${row.onHand} on hand`
          : `${row.locationName} is at or below the reorder threshold for ${row.skuCode}`,
      meta: ["Stock check", `${row.available} available`],
      owner: "Warehouse",
      action: "Open inventory",
      href: "/ops/inventory",
      since: now,
    });
  }

  // 5. Sheet sync conflicts -- someone edited a DB-owned cell in the
  //    spreadsheet, so the Sheet and the database now disagree.
  const conflicts = await db.syncLog.findMany({
    where: { conflict: true },
    orderBy: { createdAt: "desc" },
    include: { order: { select: { id: true, invoiceNumber: true } } },
    take: 25,
  });
  for (const c of conflicts) {
    const fields = Array.isArray(c.fieldsChanged) ? c.fieldsChanged.join(", ") : String(c.fieldsChanged ?? "");
    items.push({
      severity: "info",
      title: `Sheet edit conflict on ${c.order.invoiceNumber ?? c.orderId}${fields ? ` — ${fields}` : ""} (DB-owned)`,
      meta: ["Sheet sync", c.rowRef ? `row ${c.rowRef}` : ""],
      owner: "Ops",
      action: "Resolve",
      href: `/ops/orders/${c.orderId}`,
      since: c.createdAt,
    });
  }

  // 6. Inbound messages from numbers we cannot match to an account. §1.2
  //    forbids auto-processing these, so a human has to look.
  const unknownSenders = await db.message.findMany({
    where: { direction: "inbound", accountId: null },
    orderBy: { createdAt: "desc" },
    take: 15,
  });
  for (const m of unknownSenders) {
    items.push({
      severity: "warn",
      title: `Unknown number (${maskPhone(m.fromNumber)}) texted "${m.bodyRaw.slice(0, 40)}" — no account match`,
      meta: ["SMS · not processed", "unverified sender"],
      owner: "Ops",
      action: "Match to account",
      href: "/ops/accounts",
      since: m.createdAt,
    });
  }

  // 7. Accounts stuck in setup: they cannot place a first order until the
  //    checklist closes, and nothing will close it on its own.
  const pendingAccounts = await db.account.findMany({
    where: { firstOrderAt: null, approvalStatus: { not: "rejected" } },
    include: { contacts: { select: { email: true }, take: 1 }, salesRep: { select: { name: true } } },
    take: 50,
  });
  const routeRegions = new Set((await db.routeSchedule.findMany({ select: { region: true } })).map((r) => r.region));
  for (const a of pendingAccounts) {
    const ck = accountChecklist({
      ...a,
      contactEmail: a.contacts[0]?.email ?? null,
      regionHasWarehouse: a.region ? routeRegions.has(a.region) : false,
    });
    if (ck.doneCount >= 8) continue; // only the first order is missing -- that is sales, not ops
    items.push({
      severity: a.approvalStatus === "pending" ? "warn" : "info",
      title: `${a.businessName} — setup ${ck.doneCount}/9; missing ${ck.missing.slice(0, 2).join(", ")}`,
      meta: ["Account setup", a.approvalStatus === "pending" ? "awaiting approval" : "incomplete"],
      owner: a.salesRep?.name ?? "Ops",
      action: ck.missing.includes("billing email") ? "Add billing email" : "Open account",
      href: `/ops/accounts/${a.id}`,
      since: a.createdAt,
    });
  }

  return items.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.since.getTime() - b.since.getTime(),
  );
}

/** Partially mask an unverified inbound number -- it is not a known contact. */
function maskPhone(p: string): string {
  const digits = p.replace(/\D/g, "");
  if (digits.length < 7) return p;
  return `+${digits.slice(0, digits.length - 7)} ${digits.slice(-7, -4)} ••• ${digits.slice(-4)}`;
}

export interface HealthChip {
  label: string;
  tone: "good" | "warn" | "bad";
  detail: string;
}

/**
 * The environment health chips in the top bar. Each answers "is this
 * integration working right now", with the last success time, because a green
 * light with no timestamp is indistinguishable from a light that is stuck on.
 */
export async function healthChips(): Promise<HealthChip[]> {
  const [lastSheet, lastStripe, jobs] = await Promise.all([
    db.syncLog.findFirst({ where: { status: "success" }, orderBy: { createdAt: "desc" } }),
    db.stripeEvent.findFirst({ orderBy: { processedAt: "desc" } }),
    db.jobRun.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const counts = new Map(jobs.map((j) => [j.status, j._count._all]));
  const dead = counts.get("dead") ?? 0;
  const failed = counts.get("failed") ?? 0;

  const staleness = (d: Date | null | undefined): HealthChip["tone"] => {
    if (!d) return "warn";
    const hours = (Date.now() - d.getTime()) / 3_600_000;
    return hours < 6 ? "good" : hours < 48 ? "warn" : "bad";
  };

  return [
    {
      label: "Sheet sync",
      tone: staleness(lastSheet?.createdAt),
      detail: lastSheet ? relative(lastSheet.createdAt) : "no writes yet",
    },
    {
      label: "Stripe",
      tone: staleness(lastStripe?.processedAt),
      detail: lastStripe ? relative(lastStripe.processedAt) : "no events yet",
    },
    {
      label: "Jobs",
      tone: dead > 0 ? "bad" : failed > 0 ? "warn" : "good",
      detail: dead > 0 ? `${dead} dead` : failed > 0 ? `${failed} retrying` : "clear",
    },
  ];
}

function relative(d: Date): string {
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

export interface ActivityRow {
  actor: string;
  eventType: string;
  orderId: string;
  invoiceNumber: string | null;
  businessName: string;
  createdAt: Date;
  payload: unknown;
}

/** The live activity feed, straight off the append-only event log. */
export async function liveActivity(limit = 25): Promise<ActivityRow[]> {
  const rows = await db.orderEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      order: { select: { id: true, invoiceNumber: true, account: { select: { businessName: true } } } },
    },
  });
  return rows.map((r) => ({
    actor: r.actor,
    eventType: r.eventType,
    orderId: r.order.id,
    invoiceNumber: r.order.invoiceNumber,
    businessName: r.order.account.businessName,
    createdAt: r.createdAt,
    payload: r.payloadJson,
  }));
}

export interface KpiTile {
  label: string;
  value: string;
  detail: string;
  series: number[];
}

/**
 * The KPI row, deliberately BELOW the attention queue (§8.1). These are for
 * orientation, not for action; putting them first would make the hub a
 * dashboard, which is exactly what it is not.
 */
export async function kpis(orders: StagedOrder[]): Promise<KpiTile[]> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const weekStart = new Date(now.getTime() - 7 * 86_400_000);

  const [invoicedMtd, collectedMtd, custody] = await Promise.all([
    db.invoice.aggregate({
      _sum: { amountDue: true },
      _count: { _all: true },
      where: { createdAt: { gte: monthStart }, status: { notIn: ["local_error", "void", "draft"] } },
    }),
    db.invoice.aggregate({ _sum: { amountPaid: true }, where: { paidAt: { gte: monthStart } } }),
    kegCustodyBalances(),
  ]);

  const thisWeek = orders.filter((o) => (o.confirmedAt ?? o.createdAt) >= weekStart);
  const kegsOut = custody.reduce((s, c) => s + c.balance, 0);
  const exposure = custody.reduce((s, c) => s + c.depositExposure, 0);

  // Average confirm -> delivered, in days, over orders that actually got there.
  const delivered = orders.filter((o) => o.deliveredAt && o.confirmedAt);
  const avgDays = delivered.length
    ? delivered.reduce((s, o) => s + (o.deliveredAt!.getTime() - o.confirmedAt!.getTime()) / 86_400_000, 0) /
      delivered.length
    : null;

  return [
    {
      label: "Orders this week",
      value: String(thisWeek.length),
      detail: `${orders.length} open in the pipeline`,
      series: ordersPerDaySeries(orders, 30),
    },
    {
      label: "Invoiced MTD",
      value: currency(toNumber(invoicedMtd._sum.amountDue)),
      detail: `${invoicedMtd._count._all} invoices`,
      series: [],
    },
    {
      label: "Collected MTD",
      value: currency(toNumber(collectedMtd._sum.amountPaid)),
      detail: pctOf(toNumber(collectedMtd._sum.amountPaid), toNumber(invoicedMtd._sum.amountDue)),
      series: [],
    },
    {
      label: "Confirm → delivered",
      value: avgDays == null ? "—" : `${avgDays.toFixed(1)} d`,
      detail: delivered.length ? `over ${delivered.length} deliveries` : "no deliveries yet",
      series: [],
    },
    {
      label: "Kegs out in trade",
      value: String(kegsOut),
      detail: `${currency(exposure)} deposit exposure`,
      series: [],
    },
  ];
}

function currency(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function pctOf(part: number, whole: number): string {
  if (whole <= 0) return "nothing invoiced yet";
  return `${Math.round((part / whole) * 100)}% of invoiced`;
}

function ordersPerDaySeries(orders: StagedOrder[], days: number): number[] {
  const buckets = new Array(days).fill(0);
  const now = Date.now();
  for (const o of orders) {
    const d = Math.floor((now - (o.confirmedAt ?? o.createdAt).getTime()) / 86_400_000);
    if (d >= 0 && d < days) buckets[days - 1 - d] += 1;
  }
  return buckets;
}

/** Per-rule run health for the Command Center and /ops/automations. */
export interface RuleHealth {
  kind: string;
  lastRunAt: Date | null;
  successRate7d: number | null;
  runs7d: Array<{ ok: boolean }>;
  queued: number;
  retrying: number;
  dead: number;
}

export async function ruleHealth(): Promise<Map<string, RuleHealth>> {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const runs = await db.jobRun.findMany({
    where: { createdAt: { gte: since } },
    select: { kind: true, status: true, createdAt: true, finishedAt: true },
    orderBy: { createdAt: "asc" },
  });

  const out = new Map<string, RuleHealth>();
  for (const r of runs) {
    const entry =
      out.get(r.kind) ??
      { kind: r.kind, lastRunAt: null, successRate7d: null, runs7d: [], queued: 0, retrying: 0, dead: 0 };
    if (r.status === "succeeded" || r.status === "dead" || r.status === "failed") {
      entry.runs7d.push({ ok: r.status === "succeeded" });
      entry.lastRunAt = r.finishedAt ?? r.createdAt;
    }
    if (r.status === "queued") entry.queued += 1;
    if (r.status === "failed") entry.retrying += 1;
    if (r.status === "dead") entry.dead += 1;
    out.set(r.kind, entry);
  }
  for (const entry of out.values()) {
    const total = entry.runs7d.length;
    entry.successRate7d = total ? Math.round((entry.runs7d.filter((r) => r.ok).length / total) * 100) : null;
    entry.runs7d = entry.runs7d.slice(-20);
  }
  return out;
}

export function isBlocked(o: StagedOrder): boolean {
  return o.pipeline.stage === "blocked" && isBlockedReason(o.pipeline.blockedReason ?? "");
}

/**
 * Clock-dependent derivations live here, not in a component.
 *
 * Reading the clock during render is impure — React's lint rule flags it, and
 * it is right to: a value that changes between renders of the same data is a
 * value the render should have been handed rather than gone looking for. It is
 * also simply the wrong layer. "How overdue is this invoice" is a fact about
 * the invoice, not a presentation detail.
 */

export interface InvoiceWithAging {
  id: string;
  orderId: string;
  accountId: string;
  stripeInvoiceId: string;
  invoiceNumber: string | null;
  status: string;
  collectionMethod: string;
  amountDue: number;
  amountPaid: number;
  dueDate: Date | null;
  paidAt: Date | null;
  hostedInvoiceUrl: string | null;
  businessName: string;
  accountHref: string;
  orderInvoiceNumber: string | null;
  /** Positive = overdue by this many days. Null unless open with a due date. */
  daysOverdue: number | null;
}

export async function invoicesWithAging(now: Date = new Date()): Promise<InvoiceWithAging[]> {
  const rows = await db.invoice.findMany({
    include: {
      account: { select: { id: true, businessName: true } },
      order: { select: { id: true, invoiceNumber: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  return rows.map((i) => ({
    id: i.id,
    orderId: i.orderId,
    accountId: i.accountId,
    stripeInvoiceId: i.stripeInvoiceId,
    invoiceNumber: i.invoiceNumber,
    status: i.status,
    collectionMethod: i.collectionMethod,
    amountDue: toNumber(i.amountDue),
    amountPaid: toNumber(i.amountPaid),
    dueDate: i.dueDate,
    paidAt: i.paidAt,
    hostedInvoiceUrl: i.hostedInvoiceUrl,
    businessName: i.account.businessName,
    accountHref: `/ops/accounts/${i.account.id}`,
    orderInvoiceNumber: i.order.invoiceNumber,
    daysOverdue:
      i.dueDate && i.status === "open"
        ? Math.floor((now.getTime() - i.dueDate.getTime()) / 86_400_000)
        : null,
  }));
}

/** The cutoff for "licence expiring soon" on the accounts filter. */
export function licenceExpiryCutoff(days = 60, now: Date = new Date()): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

/** Start of the current calendar month, for MTD aggregates. */
export function monthStart(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}
