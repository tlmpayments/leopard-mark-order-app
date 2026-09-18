/**
 * What one unit costs one account.
 *
 * The rule itself is one line, and it is written down in exactly one other
 * place: the comment on `OrderLine.unitPrice` ("account_pricing, falling back
 * to products.list_price"). Until now no code in this app applied it -- order
 * lines arrive from the Sheet already priced, so the resolution happened in
 * Code.gs. The invoice maker prices lines itself, which makes this the first
 * caller and the reason the rule now exists as a function rather than as prose.
 *
 * Pure and framework-free on purpose: the invoice maker's browser-side totals
 * and its server action must price a line identically, and the only way to
 * guarantee that is for both to call this.
 */

/** `accountId:productId`, the key both sides use for the pricing lookup. */
export function pricingKey(accountId: string, productId: string): string {
  return `${accountId}:${productId}`;
}

export type PriceSource = "account" | "list";

export interface ResolvedPrice {
  unitPrice: number;
  source: PriceSource;
}

/**
 * An account's negotiated price wins; the catalogue's list price is the
 * fallback. A negotiated price of 0 is a real answer (a comp, a sample run at
 * no charge) and must not fall through to list -- hence the null check rather
 * than a truthiness check.
 */
export function resolveUnitPrice(listPrice: number, accountPrice?: number | null): ResolvedPrice {
  if (accountPrice != null && Number.isFinite(accountPrice)) {
    return { unitPrice: accountPrice, source: "account" };
  }
  return { unitPrice: listPrice, source: "list" };
}

/** Money as the invoice prints it: two decimals, no floating-point dust. */
export function roundMoney(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function lineTotal(qty: number, unitPrice: number): number {
  return roundMoney((Number(qty) || 0) * (Number(unitPrice) || 0));
}
