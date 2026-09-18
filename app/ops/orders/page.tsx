import Link from "next/link";
import { PIPELINE_STAGES, STAGE_LABELS, stageIndex, type PipelineStage } from "@/lib/pipeline";
import { loadOrders, stageOrders, type StagedOrder } from "@/lib/ops/queries";
import { age, linesSummary, money, money0 } from "@/lib/ops/format";
import { StageChip } from "../_components/StageChip";

export const dynamic = "force-dynamic";

const CHANNEL_LABELS: Record<string, string> = { rep_app: "rep app", portal: "portal", sms: "SMS" };

/**
 * Orders (§8.2) — board and table over the same data.
 *
 * Board and table are two views of one query, switched by a URL param rather
 * than client state, so a link to "the LA orders as a table" is a real link
 * someone can paste into Slack.
 */
export default async function OrdersPage({ searchParams }: PageProps<"/ops/orders">) {
  const params = await searchParams;
  const stageFilter = firstParam(params.stage) as PipelineStage | undefined;
  const view = firstParam(params.view) === "table" || stageFilter ? "table" : "board";
  const region = firstParam(params.region);

  const orders = stageOrders(await loadOrders({})).filter((o) => o.pipeline.stage !== "cancelled");
  const scoped = region ? orders.filter((o) => o.account.region === region) : orders;
  const listed = stageFilter ? scoped.filter((o) => o.pipeline.stage === stageFilter || stageKeyOf(o) === stageFilter) : scoped;

  const regions = [...new Set(orders.map((o) => o.account.region).filter(Boolean))] as string[];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Orders</div>
          <h1>{stageFilter ? STAGE_LABELS[stageFilter] : "All open orders"}</h1>
          <p>
            Every stage change writes an order event. Blocked orders keep their column — blocked is an overlay, not a
            stage.
          </p>
        </div>
        <div className="actions">
          <div className="seg">
            <Link className={view === "board" ? "on" : ""} href="/ops/orders">
              Board
            </Link>
            <Link className={view === "table" ? "on" : ""} href="/ops/orders?view=table">
              Table
            </Link>
          </div>
          {regions.length > 1 ? (
            <div className="seg">
              <Link className={!region ? "on" : ""} href={`/ops/orders?view=${view}`}>
                All
              </Link>
              {regions.map((r) => (
                <Link key={r} className={region === r ? "on" : ""} href={`/ops/orders?view=${view}&region=${r}`}>
                  {r}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {stageFilter ? (
        <p style={{ margin: "-6px 0 14px" }}>
          <Link href="/ops/orders">← all stages</Link>
        </p>
      ) : null}

      {orders.length === 0 ? (
        <div className="state">
          <b>No orders yet.</b>
          <span>
            Reps&rsquo; orders still land in the Sheet via Apps Script. They appear here once the rep app is pointed at
            this database, or after the historical backfill runs.
          </span>
        </div>
      ) : view === "board" ? (
        <Board orders={scoped} />
      ) : (
        <Table orders={listed} />
      )}
    </>
  );
}

function stageKeyOf(o: StagedOrder): PipelineStage {
  return PIPELINE_STAGES[stageIndex(o.pipeline)] ?? "new_order";
}

function Board({ orders }: { orders: StagedOrder[] }) {
  return (
    <div className="board">
      {PIPELINE_STAGES.map((key, i) => {
        // A blocked order sits in the column of the stage it is blocked AT, so
        // the board still shows where the work actually is.
        const inCol = orders.filter((o) => stageIndex(o.pipeline) === i);
        return (
          <div className="bcol" key={key}>
            <div className="bh">
              <span>
                <i style={{ background: `var(--st${i + 1})` }} />
                {STAGE_LABELS[key]}
              </span>
              <span className="num">{inCol.length}</span>
            </div>
            {inCol.length === 0 ? (
              <div className="small muted" style={{ padding: "10px 4px" }}>
                Nothing here
              </div>
            ) : (
              inCol.map((o) => (
                <Link
                  className={`card${o.pipeline.stage === "blocked" ? " blocked" : ""}`}
                  key={o.id}
                  href={`/ops/orders/${o.id}`}
                >
                  <div className="a">
                    <span>{o.account.businessName}</span>
                    {o.account.region ? <span className="region">{o.account.region}</span> : null}
                  </div>
                  <div className="li">{linesSummary(o.lines)}</div>
                  {o.pipeline.stage === "blocked" ? (
                    <div className="small" style={{ color: "var(--serious-ink)", marginTop: 4 }}>
                      {o.blockedReason?.replace(/_/g, " ")}
                    </div>
                  ) : null}
                  <div className="f">
                    <span>
                      {o.salesRep?.name ?? "—"} · {CHANNEL_LABELS[o.channel] ?? o.channel} · {age(o.pipeline.since)}
                    </span>
                    <span className="num">{money0(o.total)}</span>
                  </div>
                </Link>
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

function Table({ orders }: { orders: StagedOrder[] }) {
  if (orders.length === 0) {
    return (
      <div className="state">
        <b>Nothing in this stage.</b>
        <span>Try another stage, or clear the filter.</span>
      </div>
    );
  }
  return (
    <div className="panel flush">
      <div className="tblwrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Invoice #</th>
              <th>Account</th>
              <th>Region</th>
              <th>Lines</th>
              <th className="r">Total</th>
              <th>Stage</th>
              <th>Rep · channel</th>
              <th>In stage</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr className="row" key={o.id}>
                <td className="mono">
                  <Link href={`/ops/orders/${o.id}`}>{o.invoiceNumber ?? o.id.slice(0, 10)}</Link>
                </td>
                <td>
                  <b>{o.account.businessName}</b>
                </td>
                <td>{o.account.region ? <span className="region">{o.account.region}</span> : "—"}</td>
                <td className="small">{linesSummary(o.lines)}</td>
                <td className="r num">{money(o.total)}</td>
                <td>
                  <StageChip pipeline={o.pipeline} />
                </td>
                <td className="small">
                  {o.salesRep?.name ?? "—"} · {CHANNEL_LABELS[o.channel] ?? o.channel}
                </td>
                <td className="small mono">{age(o.pipeline.since)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
