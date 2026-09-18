import { db } from "@/lib/db";
import { requireOpsUser } from "@/lib/ops/session";

export const dynamic = "force-dynamic";

/**
 * Prospecting coverage.
 *
 * The door list itself lives with the rep app (a static file cut from the ABC
 * plan sheet), so this page deliberately shows what the database actually
 * knows: which doors have been worked, by whom, and what was found. It does
 * not try to restate the plan -- the plan is the spreadsheet, and a second
 * copy of it here would be a second copy to keep right.
 */

const STATUS_LABELS: Record<string, string> = {
  visited: "Visited",
  interested: "Interested",
  comeback: "Come back",
  signed: "Signed",
  nofit: "Not a fit",
};

/** The rep app's pin colours, so a door reads the same in both places. */
const STATUS_COLORS: Record<string, string> = {
  visited: "#f2a33c",
  interested: "#d6187e",
  comeback: "#ed633f",
  signed: "#7a2fb5",
  nofit: "#8b97a3",
};

const WHEN = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export default async function ProspectsPage() {
  await requireOpsUser();

  const visits = await db.prospectVisit.findMany({
    orderBy: { markedAt: "desc" },
    select: { prospectId: true, status: true, note: true, repName: true, markedAt: true },
  });

  const byStatus = new Map<string, number>();
  const byRep = new Map<string, { total: number; interested: number; signed: number; last: Date }>();
  for (const v of visits) {
    byStatus.set(v.status, (byStatus.get(v.status) ?? 0) + 1);
    const rep = byRep.get(v.repName) ?? { total: 0, interested: 0, signed: 0, last: v.markedAt };
    rep.total++;
    if (v.status === "interested") rep.interested++;
    if (v.status === "signed") rep.signed++;
    if (v.markedAt > rep.last) rep.last = v.markedAt;
    byRep.set(v.repName, rep);
  }

  return (
    <main>
      <div className="hd">
        <h1>Prospecting</h1>
        <p className="sub">
          What the reps have found at the door. Marks arrive from the ordering app as soon as a
          phone has signal; a door nobody has been to has no row here.
        </p>
      </div>

      {visits.length === 0 ? (
        <div className="card empty">
          <b>No doors worked yet.</b>
          <span>
            When James or Ricardo marks a prospect in the ordering app, it appears here within
            seconds.
          </span>
        </div>
      ) : (
        <>
          <div className="stat-row">
            {Object.keys(STATUS_LABELS).map((key) => (
              <div className="card stat" key={key}>
                <span className="dot" style={{ background: STATUS_COLORS[key] }} />
                <b>{byStatus.get(key) ?? 0}</b>
                <span className="lbl">{STATUS_LABELS[key]}</span>
              </div>
            ))}
          </div>

          <h2 className="sec">By rep</h2>
          <table className="tbl">
            <thead>
              <tr>
                <th>Rep</th>
                <th>Doors worked</th>
                <th>Interested</th>
                <th>Signed</th>
                <th>Last mark</th>
              </tr>
            </thead>
            <tbody>
              {[...byRep.entries()]
                .sort((a, b) => b[1].total - a[1].total)
                .map(([rep, row]) => (
                  <tr key={rep}>
                    <td>
                      <b>{rep}</b>
                    </td>
                    <td>{row.total}</td>
                    <td>{row.interested}</td>
                    <td>{row.signed}</td>
                    <td className="dim">{WHEN.format(row.last)}</td>
                  </tr>
                ))}
            </tbody>
          </table>

          <h2 className="sec">Every mark, newest first</h2>
          <table className="tbl">
            <thead>
              <tr>
                <th>Door</th>
                <th>Status</th>
                <th>Rep</th>
                <th>When</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {visits.map((v) => (
                <tr key={v.prospectId}>
                  <td className="mono">#{v.prospectId}</td>
                  <td>
                    <span className="pill" style={{ background: `${STATUS_COLORS[v.status]}22`, color: STATUS_COLORS[v.status] }}>
                      {STATUS_LABELS[v.status] ?? v.status}
                    </span>
                  </td>
                  <td>{v.repName}</td>
                  <td className="dim">{WHEN.format(v.markedAt)}</td>
                  <td className="dim">{v.note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </main>
  );
}
