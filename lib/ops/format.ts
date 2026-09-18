/** Presentation helpers shared across the hub. Pure, no I/O. */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const USD0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** Decimal-safe: Prisma Decimals arrive as objects, not numbers. */
export function toNumber(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number.parseFloat(v) || 0;
  if (typeof v === "object" && "toString" in v) return Number.parseFloat(String(v)) || 0;
  return 0;
}

export const money = (n: unknown): string => USD.format(toNumber(n));
export const money0 = (n: unknown): string => USD0.format(toNumber(n));

/**
 * "2h", "3d", "40m" — the age-in-stage format the mockup uses. Compact on
 * purpose: this appears on every board card, and "about 3 hours ago" would
 * push the money off the row.
 */
export function age(since: Date | null | undefined, now: Date = new Date()): string {
  if (!since) return "—";
  const ms = now.getTime() - since.getTime();
  if (ms < 0) return "now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

const PT = "America/Los_Angeles";

/** "Sep 2" — everything in this business happens on Pacific time. */
export function shortDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", { timeZone: PT, month: "short", day: "numeric" }).format(d);
}

/** "Sep 2 · 09:41" */
export function stamp(d: Date | null | undefined): string {
  if (!d) return "—";
  const date = shortDate(d);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: PT,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${date} · ${time}`;
}

/** "Wednesday, Sep 2 · 09:58 PT" — the Command Center eyebrow. */
export function longStamp(d: Date = new Date()): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: PT, weekday: "long" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: PT,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${day}, ${shortDate(d)} · ${time} PT`;
}

/** Initials for an avatar chip. */
export function initials(name: string | null | undefined): string {
  if (!name) return "??";
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/**
 * "3× CNT ⅙bbl · 2× SGB case" — the compressed line summary on board cards.
 * Brand names collapse to their SKU prefix because the account name is already
 * the headline and the full product name would wrap.
 */
export function linesSummary(
  lines: Array<{ qty: number; product: { skuCode: string; productName: string; formatLabel: string } }>,
): string {
  if (lines.length === 0) return "no lines";
  return lines
    .map((l) => {
      const brand = l.product.skuCode.slice(0, 3);
      const fmt = l.product.formatLabel
        .replace(/1\/2 Barrel Keg/i, "½bbl")
        .replace(/1\/6 Barrel Keg/i, "⅙bbl")
        .replace(/Case.*/i, "case");
      return `${l.qty}× ${brand} ${fmt}`;
    })
    .join(" · ");
}

/** Inline SVG sparkline. Small enough to not warrant a charting dependency. */
export function sparklinePath(values: number[], w = 200, h = 36): { line: string; area: string; last: [number, number] } {
  if (values.length < 2) return { line: "", area: "", last: [0, 0] };
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map<[number, number]>((v, i) => [
    i * (w / (values.length - 1)),
    h - 4 - ((v - min) / span) * (h - 10),
  ]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  return { line, area: `${line} L${w} ${h} L0 ${h}Z`, last: pts[pts.length - 1] };
}
