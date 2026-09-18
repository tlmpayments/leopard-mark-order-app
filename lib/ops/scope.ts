export type Market = "all" | "LA" | "BA" | "unknown";
// Billing markets are explicit: sharing a warehouse does not join an account to the LA pilot.
export function accountMarket(region: string | null | undefined): Market {
  const key = region?.trim().toLowerCase() ?? "";
  if (["los angeles", "la", "long beach", "arcadia"].includes(key)) return "LA";
  if (["ba", "sf", "sf/bay", "bay area", "san francisco", "north bay", "south san francisco", "san rafael", "burlingame", "oakland", "berkeley", "east bay"].includes(key)) return "BA";
  return "unknown";
}
export function marketParam(value: string | string[] | undefined): Market {
  const v = Array.isArray(value) ? value[0] : value;
  return v === "LA" || v === "BA" || v === "unknown" ? v : "all";
}
export function inMarket(region: string | null | undefined, market: Market): boolean {
  return market === "all" || accountMarket(region) === market;
}
export function isCoreProduct(sku: string, name = ""): boolean {
  return /^(?:TLM-)?(?:SGB|SBG|CNT|GLW)[-.0-9]/i.test(sku) ||
    /^(sunlight groove|cantinesca|leopard mark pint glass)/i.test(name);
}
export function stripeSetup(account: { stripeCustomerId: string | null; stripeDefaultPaymentMethod: string | null }) {
  if (!account.stripeCustomerId?.startsWith("cus_")) return { label: "Not connected", tone: "warn" };
  if (!account.stripeDefaultPaymentMethod) return { label: "Connected · payment needed", tone: "neutral" };
  return { label: "Connected · payment on file", tone: "good" };
}
export function isStripeInvoice(id: string): boolean { return id.startsWith("in_"); }
