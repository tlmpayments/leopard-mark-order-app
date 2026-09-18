import Link from "next/link";
import { db } from "@/lib/db";
import { requireOpsUser } from "@/lib/ops/session";
import { STATUS_COLORS, STATUS_LABELS, transitionsFrom } from "@/lib/marketing/requests";
import { marketingChannel } from "@/lib/marketing/slack";
import {
  archiveRequestAction,
  deleteRequestAction,
  setMarketingChannelAction,
  setRequestStatusAction,
} from "./actions";
import type { Prisma } from "@/app/generated/prisma/client";
import type { MarketingRequestStatus } from "@/app/generated/prisma/enums";

export const dynamic = "force-dynamic";

/**
 * The marketing request queue.
 *
 * This is the screen the rail's badge points at, so it opens on what is
 * waiting: pending first, oldest at the top, because a request that has been
 * sitting four days is the one about to become a problem. The tabs are a
 * filter over the same list rather than separate pages — someone working the
 * queue flips between "what's new" and "what did I approve" constantly.
 *
 * Archived and deleted are both here rather than hidden: the Field Supply
 * Board offers restore on each, and a restore button on a page you cannot
 * reach is not a feature.
 */

const WHEN = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  month: "short",
  day: "numeric",
});

type Tab = "pending" | "open" | "all" | "archived" | "deleted";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "pending", label: "Pending" },
  { key: "open", label: "Open" },
  { key: "all", label: "All" },
  { key: "archived", label: "Archived" },
  { key: "deleted", label: "Deleted" },
];

function whereFor(tab: Tab): Prisma.MarketingRequestWhereInput {
  if (tab === "deleted") return { deletedAt: { not: null } };
  if (tab === "archived") return { deletedAt: null, archivedAt: { not: null } };
  const base: Prisma.MarketingRequestWhereInput = { deletedAt: null, archivedAt: null };
  if (tab === "pending") return { ...base, status: "pending" };
  // A mutable array: Prisma's generated `in` filter does not accept a
  // readonly one, and `as const` here would make it one.
  if (tab === "open") return { ...base, status: { in: ["pending", "approved"] } };
  return base;
}

/** How overdue, in whole LA days. Only ever shown for requests still open —
 *  a fulfilled request's needed-by date is history, not a warning. */
function daysOut(neededBy: Date): number {
  return Math.floor((neededBy.getTime() - Date.now()) / 86_400_000);
}

export default async function MarketingPage({
  searchParams,
}: PageProps<"/ops/marketing">) {
  await requireOpsUser();
  const params = await searchParams;
  const raw = typeof params.tab === "string" ? params.tab : "pending";
  const tab: Tab = (TABS.find((t) => t.key === raw)?.key ?? "pending") as Tab;

  const [requests, counts, channel] = await Promise.all([
    db.marketingRequest.findMany({
      where: whereFor(tab),
      // Pending oldest-first (work the queue), everything else newest-first
      // (read the history).
      orderBy: tab === "pending" ? { createdAt: "asc" } : { createdAt: "desc" },
      take: 200,
      include: {
        lines: { orderBy: { name: "asc" } },
        attachments: true,
        events: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    }),
    db.marketingRequest.groupBy({
      by: ["status"],
      where: { archivedAt: null, deletedAt: null },
      _count: true,
    }),
    marketingChannel(),
  ]);

  const byStatus = new Map(counts.map((c) => [c.status, c._count]));

  return (
    <main>
      <div className="hd">
        <h1>Marketing</h1>
        <p className="sub">
          What the field has asked for. Requests arrive from the ordering app and post to Slack;
          approving, declining and fulfilling here replies in that same thread.{" "}
          <Link href="/ops/marketing/catalog">Manage the catalogue →</Link>
        </p>
      </div>

      <div className="stat-row">
        {(Object.keys(STATUS_LABELS) as MarketingRequestStatus[]).map((key) => (
          <div className="card stat" key={key}>
            <span className="dot" style={{ background: STATUS_COLORS[key] }} />
            <b>{byStatus.get(key) ?? 0}</b>
            <span className="lbl">{STATUS_LABELS[key]}</span>
          </div>
        ))}
      </div>

      <div className="panel-head" style={{ marginTop: 20 }}>
        <div className="seg">
          {TABS.map((t) => (
            <Link key={t.key} href={`/ops/marketing?tab=${t.key}`} className={t.key === tab ? "on" : ""}>
              {t.label}
            </Link>
          ))}
        </div>
        {/* The channel is configurable from here rather than only by env var
            so ops can move the queue into a new Slack channel themselves. */}
        <form action={setMarketingChannelAction} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span className="dim small">Slack</span>
          <input
            className="fld"
            name="channelId"
            defaultValue={channel ?? ""}
            placeholder="C0123456789"
            size={14}
            aria-label="Slack channel for marketing requests"
          />
          <button className="btn sm" type="submit">
            Save
          </button>
        </form>
      </div>

      {requests.length === 0 ? (
        <div className="card empty">
          <b>Nothing here.</b>
          <span>
            {tab === "pending"
              ? "No requests waiting. When a rep submits one from the ordering app it appears here within seconds."
              : "No requests match this filter."}
          </span>
        </div>
      ) : (
        <div className="grid" style={{ marginTop: 16 }}>
          {requests.map((r) => {
            const open = r.status === "pending" || r.status === "approved";
            const out = daysOut(r.neededBy);
            const shipTo = r.accountName || r.eventName || "Ships to the rep";

            return (
              <div className="panel" key={r.id}>
                <div className="panel-head">
                  <div>
                    <span className="mono">{r.requestNumber}</span>{" "}
                    <span
                      className="pill"
                      style={{ background: `${STATUS_COLORS[r.status]}22`, color: STATUS_COLORS[r.status] }}
                    >
                      {STATUS_LABELS[r.status]}
                    </span>{" "}
                    {r.archivedAt ? <span className="pill">Archived</span> : null}
                    {r.deletedAt ? <span className="pill">Deleted</span> : null}
                    <div className="dim small" style={{ marginTop: 4 }}>
                      <b>{r.repName}</b> · {r.purpose} · needed {DAY.format(r.neededBy)}
                      {open && out < 7 ? (
                        <span style={{ color: STATUS_COLORS.declined }}>
                          {" "}
                          · {out < 0 ? `${Math.abs(out)}d overdue` : out === 0 ? "today" : `${out}d out`}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="dim small">{WHEN.format(r.createdAt)}</div>
                </div>

                <div className="kv">
                  <span>Ship to</span>
                  <b>{shipTo}</b>
                </div>
                {r.shipAddress ? (
                  <div className="kv">
                    <span>Address</span>
                    <span className="dim">{r.shipAddress}</span>
                  </div>
                ) : null}
                {r.email ? (
                  <div className="kv">
                    <span>Reply to</span>
                    <span className="dim">{r.email}</span>
                  </div>
                ) : null}

                {r.lines.length ? (
                  <table className="tbl" style={{ marginTop: 10 }}>
                    <thead>
                      <tr>
                        <th>Qty</th>
                        <th>Item</th>
                        <th>Brand</th>
                        <th>SKU</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.lines.map((l) => (
                        <tr key={l.id}>
                          <td>
                            <b>{l.qty}</b>
                            <span className="dim"> × {l.unit}</span>
                          </td>
                          <td>
                            {l.name}
                            {l.size ? <span className="dim"> · {l.size}</span> : null}
                          </td>
                          <td className="dim">{l.brand}</td>
                          <td className="mono dim">{l.sku}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}

                {r.customRequest ? (
                  <div className="kv" style={{ marginTop: 10 }}>
                    <span>Custom</span>
                    <span>
                      {r.customRequest}
                      {r.size ? <span className="dim"> · {r.size}</span> : null}
                    </span>
                  </div>
                ) : null}
                {r.otherDetails ? (
                  <div className="kv">
                    <span>Notes</span>
                    <span className="dim">{r.otherDetails}</span>
                  </div>
                ) : null}
                {r.attachments.length ? (
                  <div className="kv">
                    <span>Files</span>
                    <span>
                      {r.attachments.map((a) => (
                        <a key={a.id} href={a.url} target="_blank" rel="noreferrer" style={{ marginRight: 10 }}>
                          {a.filename}
                        </a>
                      ))}
                    </span>
                  </div>
                ) : null}
                {r.decisionNote ? (
                  <div className="kv">
                    <span>Decision</span>
                    <span className="dim">
                      {r.decisionNote}
                      {r.decidedBy ? ` — ${r.decidedBy}` : ""}
                    </span>
                  </div>
                ) : null}

                {/* One form per transition. A single form with a status select
                    would be fewer elements and more clicks, and this queue is
                    worked with one hand while holding a phone. */}
                <div className="actions" style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {transitionsFrom(r.status).map((next) => (
                    <form action={setRequestStatusAction} key={next} style={{ display: "flex", gap: 6 }}>
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="status" value={next} />
                      {next === "declined" ? (
                        <input
                          className="fld"
                          name="note"
                          placeholder="Why? (the rep sees this)"
                          size={22}
                          required
                          aria-label={`Reason for declining ${r.requestNumber}`}
                        />
                      ) : null}
                      <button className={`btn sm${next === "approved" ? " primary" : ""}`} type="submit">
                        {STATUS_LABELS[next]}
                      </button>
                    </form>
                  ))}

                  <form action={archiveRequestAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="restore" value={r.archivedAt ? "1" : "0"} />
                    <button className="btn sm ghost" type="submit">
                      {r.archivedAt ? "Unarchive" : "Archive"}
                    </button>
                  </form>

                  <form action={deleteRequestAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="restore" value={r.deletedAt ? "1" : "0"} />
                    <button className="btn sm ghost danger" type="submit">
                      {r.deletedAt ? "Restore" : "Delete"}
                    </button>
                  </form>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
