/**
 * Slack notifications.
 *
 * The message copy is ported verbatim from Code.gs's `handleOrder`, including
 * the `:tada: *FIRST ORDER*` vs `:beer: *NEW ORDER*` split and the thread
 * reply prompt. Reps read these every day; changing the wording during a
 * replatform would make a working notification look like a broken one.
 *
 * Uses `chat.postMessage` rather than an incoming webhook because it returns
 * `{channel, ts}`, and the rep app's confirmation screen deep-links into that
 * thread. Keeping the ts on the order is what lets stages ⑥ and ⑦ reply in the
 * same thread instead of starting a new conversation per event.
 */

import { db } from "@/lib/db";

const SLACK_API = "https://slack.com/api";

export interface SlackPostResult {
  ok: boolean;
  channel?: string;
  ts?: string;
  error?: string;
}

function token(): string | undefined {
  return process.env.SLACK_BOT_TOKEN;
}

/**
 * Which channel for a region. Prefers the `RegionSlackChannel` table so ops can
 * remap without a deploy, and falls back to the environment variables the Apps
 * Script already uses, so this works before the table is seeded.
 */
export async function channelForRegion(region: string | null | undefined, purpose = "orders"): Promise<string | null> {
  if (region) {
    const row = await db.regionSlackChannel.findFirst({ where: { region, purpose } });
    if (row) return row.channelId;
  }
  const isBayArea = /^(BA|SF|SF\/Bay|Bay Area|Northern)/i.test(region ?? "");
  return (isBayArea ? process.env.SLACK_CHANNEL_BA : process.env.SLACK_CHANNEL_LA) ?? null;
}

export async function postMessage(channel: string, text: string): Promise<SlackPostResult> {
  const bearer = token();
  if (!bearer) {
    console.warn("[slack] SLACK_BOT_TOKEN not set; skipping post");
    return { ok: false, error: "not_configured" };
  }
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ channel, text, unfurl_links: false }),
  });
  const json = (await res.json()) as SlackPostResult;
  if (!json.ok) console.warn("[slack] postMessage failed:", json.error);
  return json;
}

export async function replyInThread(channel: string, threadTs: string, text: string): Promise<SlackPostResult> {
  const bearer = token();
  if (!bearer) return { ok: false, error: "not_configured" };
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ channel, thread_ts: threadTs, text, unfurl_links: false }),
  });
  return (await res.json()) as SlackPostResult;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

export interface OrderSlackInput {
  isFirstOrder: boolean;
  repName: string;
  businessName: string;
  lines: Array<{ qty: number; description: string; lineTotal: number }>;
  total: number;
  expectedEmptyKegs?: number | null;
  tapHandleRequested?: boolean | null;
}

/**
 * The new-order message. Copy ported from Code.gs — the emoji, the bullet
 * character, the field order and the first-order nudge are all as they are
 * today on purpose.
 */
export function buildOrderMessage(o: OrderSlackInput): string {
  const head = o.isFirstOrder ? ":tada: *FIRST ORDER* " : ":beer: *NEW ORDER* ";
  const lines = o.lines
    .map((l) => `• ${l.qty}× ${l.description} — ${USD.format(l.lineTotal)}`)
    .join("\n");

  let text = `${head}${o.repName} → *${o.businessName}*\n${lines}\n*Total:* ${USD.format(o.total)}`;
  if (o.expectedEmptyKegs) text += `\n:package: Expected empties: ${o.expectedEmptyKegs}`;
  if (o.tapHandleRequested) text += `\n:beers: *Tap handle needed*`;
  if (o.isFirstOrder) {
    text += `\n:point_right: First order for this account — confirm billing setup before delivery.`;
  }
  return text;
}

export const THREAD_PROMPT =
  ":clipboard: Reply here with fulfillment notes, lot numbers, or delivery updates for this order.";
