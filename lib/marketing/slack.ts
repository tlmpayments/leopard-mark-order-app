/**
 * Slack for marketing requests.
 *
 * Deliberately a thin layer over lib/slack.ts rather than its own client: the
 * bot token, the postMessage/replyInThread pair and the "keep the ts so later
 * events reply in the same thread" contract are already solved there for beer
 * orders, and a second implementation would be a second thing to fix when the
 * token rotates.
 *
 * What differs is the channel. `channelForRegion` resolves BA/LA off the
 * account's region, which is right for an order — the people who deliver it
 * are regional — and wrong for a marketing request: the same two people field
 * every one of these whether the stickers are going to Oakland or Long Beach.
 * So marketing requests resolve to a single channel, via a RegionSlackChannel
 * row with purpose="marketing" (so ops can remap without a deploy) falling
 * back to SLACK_CHANNEL_MARKETING.
 */

import { db } from "@/lib/db";
import { postMessage, replyInThread, type SlackPostResult } from "@/lib/slack";

/** The sentinel region for the one non-regional channel. A real region name
 *  would collide with a city the order channels already map. */
const MARKETING_REGION = "*";
const MARKETING_PURPOSE = "marketing";

/**
 * Where marketing requests go. The table first so it can be remapped from the
 * ops hub, then the env var so this works before anyone seeds a row.
 *
 * Returns null when neither is set, which is not an error: a deployment
 * without Slack configured should still take requests. Every caller treats a
 * null channel as "skip the post" rather than "fail the request" — a rep
 * standing in a bar does not care that our bot token expired.
 */
export async function marketingChannel(): Promise<string | null> {
  const row = await db.regionSlackChannel.findFirst({
    where: { purpose: MARKETING_PURPOSE },
    orderBy: { region: "asc" },
  });
  if (row) return row.channelId;
  return process.env.SLACK_CHANNEL_MARKETING ?? null;
}

/** Point the marketing channel at a new Slack channel from the ops hub. */
export async function setMarketingChannel(channelId: string): Promise<void> {
  await db.regionSlackChannel.upsert({
    where: { region: MARKETING_REGION },
    create: { region: MARKETING_REGION, channelId, purpose: MARKETING_PURPOSE },
    update: { channelId, purpose: MARKETING_PURPOSE },
  });
}

export interface MarketingSlackInput {
  requestNumber: string;
  repName: string;
  purpose: string;
  neededBy: Date;
  shipTo: string | null;
  lines: Array<{ qty: number; name: string; brand: string; unit: string; size?: string | null }>;
  customRequest: string | null;
  otherDetails: string | null;
  attachmentCount: number;
}

const WHEN = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  month: "short",
  day: "numeric",
});

/** Days from now, floored to whole days in LA. Negative means already past. */
function daysOut(neededBy: Date): number {
  const day = 1000 * 60 * 60 * 24;
  return Math.floor((neededBy.getTime() - Date.now()) / day);
}

/**
 * The new-request message. Shaped like buildOrderMessage — emoji, bold lead,
 * bullet lines, a trailing nudge — because the same people read both in the
 * same client and a marketing request that looks nothing like an order reads
 * as a different system.
 *
 * The rush flag is the one piece of judgement here. The rep app already asks a
 * rep to explain anything under a week in "Any Other Details"; surfacing it in
 * the post means marketing sees the tight date in the notification rather than
 * after opening the request.
 */
export function buildMarketingMessage(r: MarketingSlackInput): string {
  const out = daysOut(r.neededBy);
  const rush = out < 7;
  const head = rush ? ":rotating_light: *RUSH MARKETING REQUEST* " : ":package: *MARKETING REQUEST* ";

  let text = `${head}${r.requestNumber} — ${r.repName}`;
  text += `\n*For:* ${r.purpose}`;
  text += `\n*Needed by:* ${WHEN.format(r.neededBy)}`;
  if (rush) {
    text += out < 0 ? " _(date has passed)_" : out === 0 ? " _(today)_" : ` _(${out} day${out === 1 ? "" : "s"} out)_`;
  }
  if (r.shipTo) text += `\n*Ship to:* ${r.shipTo}`;

  if (r.lines.length) {
    const lines = r.lines
      .map((l) => {
        const unit = l.unit && l.unit !== "each" ? ` (${l.unit})` : "";
        const size = l.size ? `, ${l.size}` : "";
        return `• ${l.qty}× ${l.name}${size} — ${l.brand}${unit}`;
      })
      .join("\n");
    text += `\n${lines}`;
  }

  if (r.customRequest) text += `\n:pencil: *Custom:* ${r.customRequest}`;
  if (r.otherDetails) text += `\n:speech_balloon: ${r.otherDetails}`;
  if (r.attachmentCount) {
    text += `\n:paperclip: ${r.attachmentCount} attachment${r.attachmentCount === 1 ? "" : "s"}`;
  }
  if (!r.lines.length && !r.customRequest) {
    // Should be unreachable — the API rejects it — but a post that silently
    // showed nothing would be worse than one that says so.
    text += `\n_No items on this request._`;
  }

  return text;
}

export const MARKETING_THREAD_PROMPT =
  ":clipboard: Approve, decline or fulfil this in the hub — ops.tlmbg.co/marketing. Replies here are notes, not decisions.";

/** Post a new request. Returns the thread handle to store on the row, or null
 *  when Slack is not configured. */
export async function postMarketingRequest(
  input: MarketingSlackInput,
): Promise<{ channel: string; ts: string } | null> {
  const channel = await marketingChannel();
  if (!channel) return null;

  const result: SlackPostResult = await postMessage(channel, buildMarketingMessage(input));
  if (!result.ok || !result.channel || !result.ts) return null;

  // Same two-message pattern as orders: the prompt is a thread reply so the
  // channel shows one line per request rather than two.
  void replyInThread(result.channel, result.ts, MARKETING_THREAD_PROMPT);
  return { channel: result.channel, ts: result.ts };
}

const STATUS_EMOJI: Record<string, string> = {
  approved: ":white_check_mark:",
  declined: ":x:",
  fulfilled: ":truck:",
  cancelled: ":wastebasket:",
  pending: ":hourglass_flowing_sand:",
};

const STATUS_VERB: Record<string, string> = {
  approved: "approved",
  declined: "declined",
  fulfilled: "fulfilled",
  cancelled: "cancelled",
  pending: "reopened",
};

/**
 * A status change, in the request's own thread. Falls silent when the request
 * never got a thread — Slack was down, or off — rather than starting a new
 * conversation that has lost all the context of what is being approved.
 */
export async function postMarketingStatus(
  request: { slackChannel: string | null; slackTs: string | null; requestNumber: string },
  status: string,
  actor: string,
  note?: string | null,
): Promise<void> {
  if (!request.slackChannel || !request.slackTs) return;
  const emoji = STATUS_EMOJI[status] ?? ":information_source:";
  const verb = STATUS_VERB[status] ?? status;
  let text = `${emoji} ${request.requestNumber} *${verb}* by ${actor}`;
  if (note) text += `\n> ${note}`;
  await replyInThread(request.slackChannel, request.slackTs, text);
}
