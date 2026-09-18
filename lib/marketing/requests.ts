/**
 * Marketing request numbering and the status machine.
 *
 * Kept apart from the API route and the ops actions so both go through one
 * definition of "can this move from here to there" — the rep app can cancel
 * and the hub can approve, and neither should be the only place that knows a
 * fulfilled request cannot be un-fulfilled by a rep on a phone.
 */

import type { Prisma } from "@/app/generated/prisma/client";
import type { MarketingRequestStatus } from "@/app/generated/prisma/enums";

/** The business's clock. Everything user-facing in this app is LA time. */
function pacificYymm(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "2-digit",
    month: "2-digit",
  }).formatToParts(at);
  const year = parts.find((p) => p.type === "year")?.value ?? "00";
  const month = parts.find((p) => p.type === "month")?.value ?? "00";
  return `${year}${month}`;
}

export function formatRequestNumber(yymm: string, seq: number): string {
  return `MR-${yymm}-${String(seq).padStart(4, "0")}`;
}

/**
 * Mint the next request number. Monthly rather than daily (BOLs are daily)
 * because marketing takes single digits of these a week — a daily series would
 * be MR-260918-01 and almost always end in 01, which reads like a placeholder.
 *
 * Must be called inside the transaction that writes the request, for the same
 * reason mintBolNumber must: a number handed out and then not used is a gap in
 * a sequence somebody will eventually audit.
 */
export async function mintRequestNumber(
  tx: Prisma.TransactionClient,
  at: Date = new Date(),
): Promise<string> {
  const yymm = pacificYymm(at);

  // Same single-statement upsert-and-lock as lib/bol/sequence.ts: concurrent
  // callers serialise on the row lock ON CONFLICT takes, and RETURNING hands
  // back this caller's value without a second read that could see someone
  // else's increment.
  const rows = await tx.$queryRaw<Array<{ last: number }>>`
    INSERT INTO "marketing_sequences" ("yymm", "last")
    VALUES (${yymm}, 1)
    ON CONFLICT ("yymm")
    DO UPDATE SET "last" = "marketing_sequences"."last" + 1
    RETURNING "last"
  `;

  const seq = rows[0]?.last;
  if (typeof seq !== "number") {
    throw new Error(`Marketing sequence mint failed for ${yymm}`);
  }
  return formatRequestNumber(yymm, seq);
}

/**
 * Where a request can go from where it is.
 *
 * `fulfilled` is terminal and `cancelled` is not: marketing genuinely does
 * reopen a request a rep withdrew by mistake, and making that a new request
 * would lose the thread it is already being discussed in. Declining is
 * reversible for the same reason — a decline is often "not this month".
 */
const TRANSITIONS: Record<MarketingRequestStatus, readonly MarketingRequestStatus[]> = {
  pending: ["approved", "declined", "cancelled"],
  approved: ["fulfilled", "declined", "cancelled", "pending"],
  declined: ["pending", "approved"],
  cancelled: ["pending"],
  fulfilled: [],
};

export function canTransition(from: MarketingRequestStatus, to: MarketingRequestStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionsFrom(from: MarketingRequestStatus): readonly MarketingRequestStatus[] {
  return TRANSITIONS[from] ?? [];
}

/**
 * What a rep may do to his own request from the app: withdraw it, and only
 * while nobody has acted on it. Everything else is the hub's.
 */
export function repMayCancel(status: MarketingRequestStatus): boolean {
  return status === "pending" || status === "approved";
}

export const STATUS_LABELS: Record<MarketingRequestStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  fulfilled: "Fulfilled",
  declined: "Declined",
  cancelled: "Cancelled",
};

/** The Field Supply Board's status colours, so a request reads the same in the
 *  hub as it does on the board and in the rep app. */
export const STATUS_COLORS: Record<MarketingRequestStatus, string> = {
  pending: "#c96a2c",
  approved: "#052a6c",
  fulfilled: "#2f7d5a",
  declined: "#c23b52",
  cancelled: "#8b97a3",
};
